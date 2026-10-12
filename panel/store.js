const DEFAULT_SETTINGS = {
  autostart: false,
  dock: true,
  atalho: { ativo: false, tecla: '' },
  icone: { ambiente: false },
  notificacoes: { filtro: true, offline: true, ligadoHoras: 0 },
  favoritos: [],
  timer: null,
  agendas: [],
  idioma: 'auto',
};

let view = null;
let settings = DEFAULT_SETTINGS;
let darkTaskbar = true;

// A missing group or field must never crash a render: fill it from the defaults.
function applySettings(next) {
  settings = {
    ...DEFAULT_SETTINGS,
    ...next,
    atalho: { ...DEFAULT_SETTINGS.atalho, ...next?.atalho },
    icone: { ...DEFAULT_SETTINGS.icone, ...next?.icone },
    notificacoes: { ...DEFAULT_SETTINGS.notificacoes, ...next?.notificacoes },
  };
}

function loginState() {
  return view?.login ?? 'ok';
}

function loggedOut() {
  return loginState() !== 'ok';
}

// Controls only make sense with a reachable unit: not signed out, not loading, not offline.
function usable() {
  return !loggedOut() && Boolean(view?.device) && view.device.online !== false;
}

function limitsOf(device) {
  const reported = device?.limites ?? {};
  const list = (key) => {
    const values = reported[key];
    return Array.isArray(values) && values.length > 0 ? values : FALLBACK_LIMITS[key];
  };
  const hours = list('filtroAlerta').filter(Number.isFinite);
  const number = (key) => (Number.isFinite(reported.temp?.[key]) ? reported.temp[key] : FALLBACK_LIMITS.temp[key]);
  const temp = { min: number('min'), max: number('max'), passo: number('passo') };
  if (temp.passo <= 0 || temp.max <= temp.min) Object.assign(temp, FALLBACK_LIMITS.temp);
  const filtroAlerta = hours.length > 0 ? hours : FALLBACK_LIMITS.filtroAlerta;
  return { temp, modo: list('modo'), vento: list('vento'), oscilar: list('oscilar'), extra: list('extra'), filtroAlerta };
}

// Timers and schedules say which unit they act on; a name is only worth showing when it is not the one on screen.
function otherUnitName(aparelho) {
  return aparelho?.nome && aparelho.id !== view?.device?.id ? aparelho.nome : null;
}
