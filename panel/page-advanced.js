/* Settings > Funções avançadas: lightly tested features of the original app. */

const TROPICAL_MAX = 35;

function diagnosisErrorLabel(error) {
  if (error && typeof error === 'object') return String(error.codigo ?? error.code ?? JSON.stringify(error));
  return String(error);
}

function renderTropical(device) {
  const level = device?.tropical ?? 0;
  byId('row-tropical').hidden = device != null && device.tropical == null;
  byId('tropical-value').textContent = level;
  byId('tropical-note').textContent = level === 0 ? t('advanced.tropicalOff') : t('advanced.tropicalAt', { level });
  byId('tropical-down').disabled = level <= 0;
  byId('tropical-up').disabled = level >= TROPICAL_MAX;
}

function renderCleaning(device) {
  const running = device?.limpeza === 'on';
  const percent = device?.limpezaPct;
  const meter = byId('clean-meter');
  byId('row-clean').hidden = device != null && device.limpeza == null;
  byId('clean-toggle').textContent = t(running ? 'advanced.stop' : 'advanced.start');
  byId('clean-note').textContent = running
    ? (percent == null ? t('advanced.cleaning') : t('advanced.cleaningPct', { percent: Math.round(percent) }))
    : t('advanced.cleanNote');
  meter.hidden = !running || percent == null;
  meter.firstElementChild.style.width = `${clamp(percent ?? 0, 0, 100)}%`;
}

function renderDiagnosis(device) {
  const running = device?.diagnostico === 'on';
  const errors = device?.diagnosticoErros ?? [];
  byId('row-diagnosis').hidden = device != null && device.diagnostico == null;
  byId('diagnosis-toggle').textContent = t(running ? 'advanced.cancel' : 'advanced.start');
  let note = t('advanced.diagnosisNone');
  if (running) note = t('advanced.diagnosisRunning');
  else if (device?.diagnosticoResultado != null) note = t('advanced.diagnosisResult', { result: device.diagnosticoResultado });
  byId('diagnosis-note').textContent = note;
  const tags = byId('diagnosis-errors');
  tags.hidden = running || errors.length === 0;
  if (changed('diagnosis-errors', errors)) {
    tags.replaceChildren(...errors.map((error) => el('span', { class: 'tag' }, diagnosisErrorLabel(error))));
  }
}

function renderAdvancedPage() {
  const device = view?.device;
  renderTropical(device);
  renderCleaning(device);
  renderDiagnosis(device);
  syncGroupVisibility(byId('group-advanced'));
  byId('advanced-empty').hidden = !byId('group-advanced').hidden;
}

function stepTropical(direction) {
  const level = view?.device?.tropical ?? 0;
  send('tropical', clamp(level + direction, 0, TROPICAL_MAX));
}

byId('tropical-down').addEventListener('click', () => stepTropical(-1));
byId('tropical-up').addEventListener('click', () => stepTropical(1));

function flip(value) {
  return value === 'on' ? 'off' : 'on';
}

byId('clean-toggle').addEventListener('click', withDevice((device) => send('limpeza', flip(device.limpeza))));
byId('diagnosis-toggle').addEventListener('click', withDevice((device) => send('diagnostico', flip(device.diagnostico))));
