export const TEMP_RANGE = Object.freeze({ min: 16, max: 30, passo: 1 });

export const SETTINGS = {
  temp: {
    capability: 'thermostatCoolingSetpoint',
    attribute: 'coolingSetpoint',
    command: 'setCoolingSetpoint',
    values: Array.from({ length: TEMP_RANGE.max - TEMP_RANGE.min + 1 }, (_, i) => TEMP_RANGE.min + i),
  },
  modo: {
    capability: 'airConditionerMode',
    attribute: 'airConditionerMode',
    command: 'setAirConditionerMode',
    values: ['cool', 'dry', 'wind', 'auto'],
    supported: ['supportedAcModes', 'availableAcModes'],
  },
  vento: {
    capability: 'airConditionerFanMode',
    attribute: 'fanMode',
    command: 'setFanMode',
    values: ['auto', 'low', 'medium', 'high', 'turbo'],
    supported: ['supportedAcFanModes', 'availableAcFanModes'],
  },
  extra: {
    capability: 'custom.airConditionerOptionalMode',
    attribute: 'acOptionalMode',
    command: 'setAcOptionalMode',
    values: ['off', 'windFree', 'windFreeSleep', 'sleep', 'quiet', 'speed'],
    supported: ['supportedAcOptionalMode'],
  },
  oscilar: {
    capability: 'fanOscillationMode',
    attribute: 'fanOscillationMode',
    command: 'setFanOscillationMode',
    values: ['fixed', 'vertical', 'horizontal', 'all'],
    supported: ['supportedFanOscillationModes', 'availableFanOscillationModes'],
  },
  tropical: {
    capability: 'custom.airConditionerTropicalNightMode',
    attribute: 'acTropicalNightModeLevel',
    command: 'setAcTropicalNightModeLevel',
    values: Array.from({ length: 36 }, (_, i) => i),
  },
  display: {
    // The unit ignores this capability's commands (it lists it as disabled) but still reports the real state here.
    // Samsung's OCF option that works is inverted: Light_On turns the display off.
    capability: 'samsungce.airConditionerLighting',
    attribute: 'lighting',
    commands: {
      on: 'execute:execute("mode/vs/0",{"x.com.samsung.da.options":["Light_Off"]})',
      off: 'execute:execute("mode/vs/0",{"x.com.samsung.da.options":["Light_On"]})',
    },
  },
  bipe: {
    capability: 'audioVolume',
    attribute: 'volume',
    commands: { on: 'audioVolume:setVolume(100)', off: 'audioVolume:setVolume(0)' },
    fromValue: (volume) => (volume > 0 ? 'on' : 'off'),
  },
  autoclean: {
    capability: 'custom.autoCleaningMode',
    attribute: 'autoCleaningMode',
    command: 'setAutoCleaningMode',
    values: ['on', 'off'],
  },
  limpeza: {
    capability: 'custom.autoCleaningMode',
    attribute: 'operatingState',
    commands: { on: 'custom.autoCleaningMode:start("autoClean")', off: 'custom.autoCleaningMode:stop' },
    fromValue: (state) => (state === 'ready' ? 'off' : 'on'),
  },
  filtroAlerta: {
    capability: 'samsungce.dustFilterAlarm',
    attribute: 'alarmThreshold',
    command: 'setAlarmThreshold',
    values: [180, 300, 500, 700],
    supported: ['supportedAlarmThresholds'],
  },
  diagnostico: {
    capability: 'samsungce.selfCheck',
    attribute: 'status',
    commands: { on: 'samsungce.selfCheck:startSelfCheck', off: 'samsungce.selfCheck:cancelSelfCheck' },
    fromValue: (status) => (status === 'running' ? 'on' : 'off'),
  },
};

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function reported(main, capability, attribute) {
  const value = main[capability]?.[attribute]?.value;
  return Number.isNaN(value) ? null : (value ?? null);
}

// An attribute the unit does not report, or reports empty, falls back to the lists the app shipped with.
function supportedValues(main, { capability, supported, values }) {
  for (const attribute of supported) {
    const list = reported(main, capability, attribute);
    const usable = Array.isArray(list)
      ? list.filter((item) => typeof item === typeof values[0] && item !== '' && item !== 'notSupported')
      : [];
    if (usable.length > 0) return [...new Set(usable)];
  }
  return [...values];
}

function tempLimits(main) {
  const range = reported(main, 'thermostatCoolingSetpoint', 'coolingSetpointRange');
  const control = main['custom.thermostatSetpointControl'];
  const min = finite(range?.minimum) ?? finite(control?.minimumSetpoint?.value);
  const max = finite(range?.maximum) ?? finite(control?.maximumSetpoint?.value);
  if (min === null || max === null || min >= max) return { ...TEMP_RANGE };
  const passo = finite(range?.step);
  return { min, max, passo: passo > 0 ? passo : TEMP_RANGE.passo };
}

export function limitsFrom(main) {
  return {
    temp: tempLimits(main),
    modo: supportedValues(main, SETTINGS.modo),
    vento: supportedValues(main, SETTINGS.vento),
    oscilar: supportedValues(main, SETTINGS.oscilar),
    extra: supportedValues(main, SETTINGS.extra),
    filtroAlerta: supportedValues(main, SETTINGS.filtroAlerta),
  };
}

// Every field a unit does not report is null, so the panel can tell "unknown" apart from off or zero.
export function parseStatus(main, device, online) {
  const settings = Object.fromEntries(
    Object.entries(SETTINGS).map(([key, { capability, attribute, fromValue }]) => {
      const value = reported(main, capability, attribute);
      return [key, value !== null && fromValue ? fromValue(value) : value];
    }),
  );
  const power = main.powerConsumptionReport?.powerConsumption?.value;
  const energy = finite(power?.energy);
  const switchState = reported(main, 'switch', 'switch');
  const errors = reported(main, 'samsungce.selfCheck', 'errors');
  return {
    id: device.id,
    nome: device.nome ?? null,
    online,
    ligado: switchState === null ? null : switchState === 'on',
    ...settings,
    tropicalRestante: finite(reported(main, 'custom.airConditionerTropicalNightMode', 'remainingTime')),
    limpezaPct: finite(reported(main, 'custom.autoCleaningMode', 'progress')),
    diagnosticoResultado: reported(main, 'samsungce.selfCheck', 'result'),
    diagnosticoErros: Array.isArray(errors) ? errors.map((error) => error?.code).filter((code) => code != null) : [],
    filtroUso: finite(reported(main, 'custom.dustFilter', 'dustFilterUsage')),
    filtroStatus: reported(main, 'custom.dustFilter', 'dustFilterStatus'),
    potencia: finite(power?.power),
    energia: energy === null ? null : Number((energy / 1000).toFixed(1)),
    ambiente: finite(reported(main, 'temperatureMeasurement', 'temperature')),
    umidade: finite(reported(main, 'relativeHumidityMeasurement', 'humidity')),
    limites: limitsFrom(main),
  };
}
