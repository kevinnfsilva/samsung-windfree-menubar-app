const { readJson, writeJson } = require('./json-file');

const SAMPLE_EVERY_MS = 5 * 60_000;
const SAMPLES_KEPT_MS = 48 * 3_600_000;
// The file is also written now and then when nothing else changed, so that a restart knows when the energy counter was last read.
const PERSIST_EVERY_MS = 5 * 60_000;
const DAYS_KEPT = 90;
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function dayOf(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function nextMidnight(time) {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

// What the counter gained between two readings, shared among the calendar days in between in proportion to the time
// each day covers: nobody knows when in that stretch the energy was used. Days before `notBefore` are not worth the loop.
function shareByDay(from, to, kwh, notBefore) {
  if (!(to > from)) return [{ dia: dayOf(to), kwh }];
  const shares = [];
  for (let cursor = Math.max(from, notBefore); cursor < to; ) {
    const end = Math.min(to, nextMidnight(cursor));
    shares.push({ dia: dayOf(cursor), kwh: (kwh * (end - cursor)) / (to - from) });
    cursor = end;
  }
  return shares;
}

function normalizeUnit(unit) {
  const saved = unit !== null && typeof unit === 'object' ? unit : {};
  const list = (value, valid) => (Array.isArray(value) ? value.filter((item) => item !== null && typeof item === 'object' && valid(item)) : []);
  return {
    energia: Number.isFinite(saved.energia) ? saved.energia : null,
    tEnergia: Number.isFinite(saved.tEnergia) ? saved.tEnergia : null,
    dias: list(saved.dias, ({ dia, kwh }) => DAY_PATTERN.test(dia) && Number.isFinite(kwh)),
    amostras: list(saved.amostras, ({ t, w }) => Number.isFinite(t) && Number.isFinite(w)),
  };
}

// Each unit keeps its own history: the energy counter of one is no baseline for another, and their watts don't belong on one curve.
class History {
  #file;
  #units = {};
  #lastUpdate = null;
  #savedAt = 0;
  #dirty = false;

  constructor(file) {
    this.#file = file;
    const { aparelhos } = readJson(file, {});
    for (const [id, unit] of Object.entries(aparelhos !== null && typeof aparelhos === 'object' ? aparelhos : {})) {
      this.#units[id] = normalizeUnit(unit);
    }
  }

  // Takes the bridge view; a new `updatedAt` is what marks a successful status.
  record({ device, updatedAt }) {
    if (updatedAt == null || updatedAt === this.#lastUpdate) return;
    this.#lastUpdate = updatedAt;
    try {
      this.#add(device, updatedAt);
    } catch (error) {
      // This runs inside the bridge's own event, so a failure here must not travel back into it.
      console.error(error);
    }
  }

  #add(device, updatedAt) {
    // An offline unit repeats its last readings, which would add flat samples and fake zero-consumption days.
    if (!device?.id || device.online === false) return;
    const unit = (this.#units[device.id] ??= normalizeUnit(null));
    let changed = false;

    if (Number.isFinite(device.potencia)) {
      const last = unit.amostras.at(-1);
      if (!last || Math.abs(updatedAt - last.t) >= SAMPLE_EVERY_MS) {
        unit.amostras.push({ t: updatedAt, w: device.potencia });
        changed = true;
      }
    }

    if (Number.isFinite(device.energia)) {
      const credit = (dia, kwh) => {
        let entry = unit.dias.find((item) => item.dia === dia);
        if (!entry) {
          entry = { dia, kwh: 0 };
          unit.dias.push(entry);
          unit.dias.sort((a, b) => a.dia.localeCompare(b.dia));
          changed = true;
        }
        if (kwh > 0) entry.kwh = Math.round((entry.kwh + kwh) * 1000) / 1000;
      };
      // The counter only goes up; a lower value means the unit reset it, and that drop is not consumption.
      const delta = unit.energia === null ? 0 : device.energia - unit.energia;
      credit(dayOf(updatedAt), 0);
      if (delta > 0) {
        // Without the time of the previous reading (an older file) it all goes to the day of this one.
        for (const { dia, kwh } of shareByDay(unit.tEnergia ?? updatedAt, updatedAt, delta, updatedAt - DAYS_KEPT * DAY_MS)) credit(dia, kwh);
        changed = true;
      }
      if (unit.energia !== device.energia) {
        unit.energia = device.energia;
        changed = true;
      }
      unit.tEnergia = updatedAt;
    }

    changed = this.#prune(unit, updatedAt) || changed;
    if (changed || updatedAt - this.#savedAt >= PERSIST_EVERY_MS) this.#save(updatedAt);
    else this.#dirty = true;
  }

  // Writes what is only in memory yet; called when the app quits.
  flush() {
    if (this.#dirty) this.#save(this.#savedAt);
  }

  get(id) {
    const unit = this.#units[id] ?? normalizeUnit(null);
    // The file may be older than the app run: whatever aged out while it was closed is left out too.
    const now = Date.now();
    const firstDay = this.#firstDay(now);
    return structuredClone({
      dias: unit.dias.filter(({ dia }) => dia >= firstDay),
      amostras: unit.amostras.filter(({ t }) => t >= now - SAMPLES_KEPT_MS),
    });
  }

  #firstDay(now) {
    return dayOf(now - (DAYS_KEPT - 1) * DAY_MS);
  }

  #prune(unit, now) {
    const firstDay = this.#firstDay(now);
    const days = unit.dias.length;
    const samples = unit.amostras.length;
    unit.dias = unit.dias.filter(({ dia }) => dia >= firstDay);
    unit.amostras = unit.amostras.filter(({ t }) => t >= now - SAMPLES_KEPT_MS);
    return unit.dias.length !== days || unit.amostras.length !== samples;
  }

  #save(at) {
    this.#savedAt = at;
    this.#dirty = false;
    try {
      writeJson(this.#file, { versao: 1, aparelhos: this.#units });
    } catch (error) {
      console.error(error);
    }
  }
}

module.exports = { History };
