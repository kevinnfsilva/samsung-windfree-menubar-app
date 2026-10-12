// Icons and value lists. Every text comes from the dictionary (../locales), so the functions below look it up when
// they are called and follow a language change.

const MENU_ICONS = {
  modo: { cool: 'snowflake', dry: 'droplets', wind: 'fan', auto: 'sparkles', heat: 'flame' },
  vento: { auto: 'sparkles', low: 'signal-low', medium: 'signal-medium', high: 'signal-high', turbo: 'signal' },
  oscilar: { fixed: 'minus', vertical: 'move-vertical', horizontal: 'move-horizontal', all: 'move' },
};

// Same lists ac.mjs falls back to when the unit reports nothing.
const FALLBACK_LIMITS = {
  temp: { min: 16, max: 30, passo: 1 },
  modo: ['cool', 'dry', 'wind', 'auto'],
  vento: ['auto', 'low', 'medium', 'high', 'turbo'],
  oscilar: ['fixed', 'vertical', 'horizontal', 'all'],
  extra: ['off', 'windFree', 'windFreeSleep', 'sleep', 'quiet', 'speed'],
  filtroAlerta: [180, 300, 500, 700],
};

const EXTRA_BY_FLAGS = {
  'false,false': 'off',
  'true,false': 'windFree',
  'false,true': 'sleep',
  'true,true': 'windFreeSleep',
};

const EXTRA_MODE_VALUES = ['off', 'quiet', 'speed'];

const ON_HOURS_VALUES = [0, 4, 8, 12];

const UNCONFIRMED_KEYS = [
  'ligado',
  'temp',
  'modo',
  'vento',
  'extra',
  'oscilar',
  'display',
  'bipe',
  'autoclean',
  'filtroAlerta',
  'tropical',
  'limpeza',
  'diagnostico',
];

const FILTER_NOTE_STATUSES = ['wash', 'replace'];

const ERROR_STATUS = {
  rede: { icon: 'wifi-off' },
  'sem-ar': { icon: 'air-vent' },
  aparelho: { icon: 'search-x', pick: true },
  tempo: { icon: 'hourglass' },
  desconhecido: { icon: 'cloud-off' },
};

const TIMER_MINUTES = [30, 60, 120, 240, 480];

const SCHEDULE_ACTION_VALUES = ['liga', 'desliga'];

function optionFor(key, value) {
  if (!Object.hasOwn(MENU_ICONS[key], value)) return { label: String(value), short: String(value), icon: 'circle' };
  return {
    label: t(`option.${key}.${value}.label`),
    short: t(`option.${key}.${value}.short`),
    icon: MENU_ICONS[key][value],
  };
}

function extraModes() {
  return EXTRA_MODE_VALUES.map((value) => ({ value, label: t(`extra.${value}`) }));
}

function onHoursOptions() {
  return ON_HOURS_VALUES.map((value) => ({ value, label: value === 0 ? t('prefs.never') : t('fmt.hours', { n: value }) }));
}

function scheduleActions() {
  return SCHEDULE_ACTION_VALUES.map((value) => ({ value, label: t(value === 'liga' ? 'schedules.actionOn' : 'schedules.actionOff') }));
}

function timerOptions(acao) {
  const key = acao === 'liga' ? 'timer.turnOnIn' : 'timer.turnOffIn';
  return TIMER_MINUTES.map((minutos) => {
    const duration = minutos < 60 ? t('fmt.minutes', { n: minutos }) : t('fmt.hours', { n: minutos / 60 });
    return { minutos, label: t(key, { duration }) };
  });
}

function weekdayName(day, form) {
  return t(`weekday.${day}.${form}`);
}

function unconfirmedName(key) {
  return UNCONFIRMED_KEYS.includes(key) ? t(`unconfirmed.${key}`) : key;
}

function isWindFree(extra) {
  return extra === 'windFree' || extra === 'windFreeSleep';
}

function isSleep(extra) {
  return extra === 'sleep' || extra === 'windFreeSleep';
}

function extraFor(windFree, sleep) {
  return EXTRA_BY_FLAGS[`${windFree},${sleep}`];
}
