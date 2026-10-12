const { EventEmitter } = require('node:events');
const { isDeepStrictEqual } = require('node:util');
const { sanitizeChanges } = require('./commands');
const { readJson, writeJson } = require('./json-file');

const IS_MAC = process.platform === 'darwin';
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACTIONS = ['liga', 'desliga'];
const DEFAULTS = {
  autostart: true,
  // Option+Command+W is "Close All" in the Finder.
  atalho: { ativo: false, tecla: IS_MAC ? 'Control+Alt+W' : 'Control+Alt+Shift+W' },
  icone: { ambiente: false },
  notificacoes: { filtro: true, offline: true, ligadoHoras: 0 },
  idioma: 'auto',
  dock: true,
  atualizacoes: true,
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function section(value, defaults) {
  return { ...defaults, ...(isObject(value) ? value : {}) };
}

// A favourite is applied to the unit field by field, so only these fields are kept, and only with usable values.
function normalizeFavorite(favorito) {
  const valid = isObject(favorito) && typeof favorito.id === 'string' && favorito.id && typeof favorito.nome === 'string';
  if (!valid) return null;
  const { temp, modo, vento, extra, oscilar } = favorito;
  const kept = sanitizeChanges({ temp, modo, vento, extra, oscilar });
  return {
    id: favorito.id,
    nome: favorito.nome,
    temp: kept.temp ?? null,
    modo: kept.modo ?? null,
    vento: kept.vento ?? null,
    extra: kept.extra ?? null,
    oscilar: kept.oscilar ?? null,
  };
}

// The unit a timer or schedule belongs to. It is null only in data saved before timers were tied to a unit.
function normalizeUnitRef(aparelho) {
  const valid = isObject(aparelho) && typeof aparelho.id === 'string' && aparelho.id;
  return valid ? { id: aparelho.id, nome: typeof aparelho.nome === 'string' ? aparelho.nome : aparelho.id } : null;
}

function normalizeSchedule(agenda) {
  if (!isObject(agenda) || typeof agenda.id !== 'string' || !agenda.id) return null;
  if (typeof agenda.hora !== 'string' || !TIME_PATTERN.test(agenda.hora)) return null;
  if (!ACTIONS.includes(agenda.acao) || !Array.isArray(agenda.dias)) return null;
  const dias = [...new Set(agenda.dias.filter((dia) => Number.isInteger(dia) && dia >= 0 && dia <= 6))].sort((a, b) => a - b);
  return {
    ...agenda,
    ativo: flag(agenda.ativo, true),
    dias,
    favorito: typeof agenda.favorito === 'string' ? agenda.favorito : null,
    aparelho: normalizeUnitRef(agenda.aparelho),
  };
}

function normalizeTimer(timer) {
  const valid = isObject(timer) && ACTIONS.includes(timer.acao) && Number.isFinite(timer.quando);
  return valid ? { acao: timer.acao, quando: timer.quando, aparelho: normalizeUnitRef(timer.aparelho) } : null;
}

function normalizeList(value, normalizeItem) {
  return Array.isArray(value) ? value.map(normalizeItem).filter(Boolean) : [];
}

// Keys this version does not know are carried along untouched, so a newer or older build can share the file.
function normalize(raw) {
  const data = isObject(raw) ? { ...raw } : {};
  data.autostart = flag(data.autostart, DEFAULTS.autostart);
  const atalho = section(data.atalho, DEFAULTS.atalho);
  const tecla = typeof atalho.tecla === 'string' ? atalho.tecla.trim() : '';
  data.atalho = { ...atalho, ativo: flag(atalho.ativo, false), tecla: tecla || DEFAULTS.atalho.tecla };
  const icone = section(data.icone, DEFAULTS.icone);
  data.icone = { ...icone, ambiente: flag(icone.ambiente, false) };
  const notificacoes = section(data.notificacoes, DEFAULTS.notificacoes);
  const horas = Number.isFinite(notificacoes.ligadoHoras) && notificacoes.ligadoHoras > 0 ? notificacoes.ligadoHoras : 0;
  data.notificacoes = {
    ...notificacoes,
    filtro: flag(notificacoes.filtro, true),
    offline: flag(notificacoes.offline, true),
    ligadoHoras: horas,
  };
  data.favoritos = normalizeList(data.favoritos, normalizeFavorite);
  data.timer = normalizeTimer(data.timer);
  data.agendas = normalizeList(data.agendas, normalizeSchedule);
  data.idioma = typeof data.idioma === 'string' ? data.idioma : DEFAULTS.idioma;
  data.dock = flag(data.dock, DEFAULTS.dock);
  data.atualizacoes = flag(data.atualizacoes, DEFAULTS.atualizacoes);
  return data;
}

// A top-level key replaces a scalar or a list and is shallow-merged into an object.
function merge(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(isObject(patch) ? patch : {})) {
    if (key === '__proto__') continue;
    next[key] = isObject(current[key]) && isObject(value) ? { ...current[key], ...value } : value;
  }
  return next;
}

class SettingsStore extends EventEmitter {
  #file;
  #adjust;
  #data;

  // `adjust` may change the candidate settings (it can veto part of a patch) before they are saved.
  constructor(file, { adjust } = {}) {
    super();
    this.#file = file;
    this.#adjust = adjust;
    this.#data = normalize(readJson(file, {}));
  }

  get() {
    return structuredClone(this.#data);
  }

  update(patch) {
    const next = normalize(merge(this.#data, patch));
    this.#adjust?.(next);
    if (isDeepStrictEqual(next, this.#data)) return this.get();
    const previous = this.#data;
    this.#data = next;
    try {
      writeJson(this.#file, next);
    } catch (error) {
      // Losing the write must not take the running app down; the in-memory settings still apply.
      console.error(error);
    }
    this.emit('change', this.get(), structuredClone(previous));
    return this.get();
  }
}

module.exports = { SettingsStore, normalizeSchedule, normalizeUnitRef };
