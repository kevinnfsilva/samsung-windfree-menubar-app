const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { sanitizeChanges } = require('./commands');
const { readJson, writeJson } = require('./json-file');
const { normalizeSchedule, normalizeUnitRef } = require('./settings');

const TICK_MS = 15_000;
const STATUS_WAIT_MS = 2_000;
const RETRY_MS = 60_000;
const RETRY_WINDOW_MS = 10 * 60_000;
const LATE_TURN_ON_MS = 5 * 60_000;
const MAX_TIMER_MINUTES = 7 * 24 * 60;
// setTimeout wraps around beyond this and would fire at once.
const MAX_DELAY_MS = 2 ** 31 - 1;

function pad(value) {
  return String(value).padStart(2, '0');
}

function normalizePending(entry) {
  const valid = entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && ['liga', 'desliga'].includes(entry.acao);
  const aparelho = valid ? normalizeUnitRef(entry.aparelho) : null;
  const mudancas = valid ? sanitizeChanges(entry.mudancas) : {};
  const usable = aparelho && Number.isFinite(entry.desde) && Object.keys(mudancas).length > 0;
  return usable ? { id: entry.id, acao: entry.acao, aparelho, mudancas, desde: entry.desde } : null;
}

// The one-shot timer and the weekly schedules; both live in the settings, bound to the unit they were made for.
// Their commands go out through bridge.apply(), and one that fails is retried for a while before the user is told.
class Scheduler {
  #settings;
  #bridge;
  #favorites;
  #notify;
  #file;
  #timeout;
  #interval;
  #firedAt = new Map();
  // Commands that have not gone through yet, kept on disk so that a restart keeps trying.
  #pending = new Map();
  #inFlight = 0;
  #stopped = false;

  // `notify(aparelho, key)` tells the user something about a unit; `file` is where the unfinished commands are kept.
  constructor({ settings, bridge, favorites, notify, file }) {
    this.#settings = settings;
    this.#bridge = bridge;
    this.#favorites = favorites;
    this.#notify = notify;
    this.#file = file;
    const { pendentes } = readJson(file, {});
    for (const saved of Array.isArray(pendentes) ? pendentes : []) {
      const entry = normalizePending(saved);
      if (entry) this.#pending.set(entry.id, { entry, timeout: null });
    }
    settings.on('change', (next, previous) => {
      if (!isDeepStrictEqual(next.timer, previous.timer)) this.#armTimer();
    });
  }

  // True while a command of this scheduler is on its way to the unit.
  get busy() {
    return this.#inFlight > 0;
  }

  start() {
    this.#resume();
    this.#armTimer();
    this.#tick();
    this.#interval = setInterval(() => this.#tick(), TICK_MS);
  }

  // Unfinished commands stay in the file, so the next launch picks them up again.
  stop() {
    this.#stopped = true;
    clearTimeout(this.#timeout);
    clearInterval(this.#interval);
    for (const slot of this.#pending.values()) clearTimeout(slot.timeout);
  }

  // Timers stand still while the computer sleeps, so waking up is the moment to look at the clock again.
  check() {
    this.#tick();
  }

  // What the user just did by hand on a unit wins over a scheduled command still being retried for it.
  cancelRetries(deviceId) {
    for (const { entry } of [...this.#pending.values()]) {
      if (entry.aparelho.id === deviceId) this.#finish(entry);
    }
  }

  setTimer(acao, minutos) {
    const aparelho = this.#activeUnit();
    const valid = (acao === 'liga' || acao === 'desliga') && Number.isFinite(minutos) && minutos > 0 && minutos <= MAX_TIMER_MINUTES;
    if (!valid || !aparelho) return null;
    const timer = { acao, quando: Date.now() + Math.round(minutos * 60_000), aparelho };
    this.#settings.update({ timer });
    return timer;
  }

  clearTimer() {
    this.#settings.update({ timer: null });
  }

  // A new schedule belongs to the unit that is active now; editing one keeps the unit it was made for.
  saveSchedule(agenda) {
    const { agendas, favoritos } = this.#settings.get();
    const id = agenda?.id || randomUUID();
    const aparelho = agendas.find((item) => item.id === id)?.aparelho ?? this.#activeUnit();
    const saved = normalizeSchedule({ ...agenda, id, aparelho });
    if (!saved?.aparelho) return null;
    if (!favoritos.some((favorito) => favorito.id === saved.favorito)) saved.favorito = null;
    const exists = agendas.some((item) => item.id === saved.id);
    this.#settings.update({ agendas: exists ? agendas.map((item) => (item.id === saved.id ? saved : item)) : [...agendas, saved] });
    return saved;
  }

  deleteSchedule(id) {
    this.#firedAt.delete(id);
    this.#settings.update({ agendas: this.#settings.get().agendas.filter((agenda) => agenda.id !== id) });
  }

  #activeUnit() {
    const { device } = this.#bridge.view();
    return device?.id ? { id: device.id, nome: device.nome ?? device.id } : null;
  }

  // Data saved before timers were tied to a unit has none; it takes the active one once that is known.
  #adopt() {
    const aparelho = this.#activeUnit();
    if (!aparelho) return false;
    const { timer, agendas } = this.#settings.get();
    const patch = {};
    if (timer && !timer.aparelho) patch.timer = { ...timer, aparelho };
    if (agendas.some((agenda) => !agenda.aparelho)) patch.agendas = agendas.map((agenda) => (agenda.aparelho ? agenda : { ...agenda, aparelho }));
    if (Object.keys(patch).length > 0) this.#settings.update(patch);
    return true;
  }

  #armTimer() {
    clearTimeout(this.#timeout);
    const { timer } = this.#settings.get();
    if (!timer) return;
    const late = Date.now() - timer.quando;
    if (late < 0) {
      this.#timeout = setTimeout(() => this.#armTimer(), Math.min(-late, MAX_DELAY_MS));
      return;
    }
    if (!timer.aparelho) {
      if (!this.#adopt()) this.#timeout = setTimeout(() => this.#armTimer(), STATUS_WAIT_MS);
      return;
    }
    // Due while the app was closed or the computer asleep. Switching off is safe however late; switching on hours
    // later would be a surprise, so that one is dropped and the user is told.
    if (timer.acao === 'liga' && late > LATE_TURN_ON_MS) {
      this.#settings.update({ timer: null });
      this.#notify(timer.aparelho, 'notify.timerDropped');
      return;
    }
    this.#dispatch(timer.acao, timer.aparelho, { ligado: timer.acao === 'liga' });
    this.#settings.update({ timer: null });
  }

  #tick() {
    this.#armTimer();
    this.#adopt();
    const now = new Date(Date.now());
    const hora = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const minute = `${now.toDateString()} ${hora}`;
    for (const agenda of this.#settings.get().agendas) {
      if (!agenda.ativo || !agenda.aparelho || agenda.hora !== hora || !agenda.dias.includes(now.getDay())) continue;
      // Ticks come more often than once a minute.
      if (this.#firedAt.get(agenda.id) === minute) continue;
      this.#firedAt.set(agenda.id, minute);
      const turnOn = agenda.acao === 'liga';
      // A favourite and the switch-on travel as one command, so the unit is not asked twice.
      const changes = turnOn ? { ...this.#favorites.changes(agenda.favorito), ligado: true } : { ligado: false };
      this.#dispatch(agenda.acao, agenda.aparelho, changes);
    }
  }

  #dispatch(acao, aparelho, mudancas) {
    // Only the newest command for a unit counts: an older one still being retried would undo it.
    this.cancelRetries(aparelho.id);
    const entry = { id: randomUUID(), acao, aparelho, mudancas, desde: Date.now() };
    this.#pending.set(entry.id, { entry, timeout: null });
    this.#save();
    this.#attempt(entry);
  }

  #resume() {
    for (const { entry } of [...this.#pending.values()]) {
      if (Date.now() - entry.desde > RETRY_WINDOW_MS) this.#giveUp(entry);
      else this.#attempt(entry);
    }
  }

  async #attempt(entry) {
    this.#inFlight++;
    let result;
    try {
      result = await this.#bridge.apply(entry.aparelho.id, entry.mudancas);
    } catch (error) {
      console.error(error);
      result = { ok: false };
    } finally {
      this.#inFlight--;
    }
    const slot = this.#pending.get(entry.id);
    // Cancelled while it was running: whatever came back no longer matters.
    if (slot?.entry !== entry) return;
    if (result?.ok) {
      this.#finish(entry);
    } else if (Date.now() - entry.desde + RETRY_MS > RETRY_WINDOW_MS) {
      this.#giveUp(entry);
    } else if (!this.#stopped) {
      slot.timeout = setTimeout(() => this.#attempt(entry), RETRY_MS);
    }
  }

  #giveUp(entry) {
    this.#finish(entry);
    this.#notify(entry.aparelho, entry.acao === 'liga' ? 'notify.failedOn' : 'notify.failedOff');
  }

  #finish(entry) {
    clearTimeout(this.#pending.get(entry.id)?.timeout);
    this.#pending.delete(entry.id);
    this.#save();
  }

  #save() {
    try {
      writeJson(this.#file, { versao: 1, pendentes: [...this.#pending.values()].map(({ entry }) => entry) });
    } catch (error) {
      console.error(error);
    }
  }
}

module.exports = { Scheduler };
