const tempInput = byId('temp');

// Target of the last step while its command is still in flight, so fast key repeats keep adding up.
let pendingTemp = null;
let lastLogin = 'ok';
let notice = null;
let noticeTimer = null;
const NOTICE_MS = 4000;

function send(key, value) {
  window.ac.set(key, value);
}

function withDevice(handler) {
  return (event) => {
    if (view?.device) handler(view.device, event);
  };
}

// A short message in the footer for something the main process refused; it clears itself. It is kept as a dictionary
// key so that a language change while it shows translates it too.
function showNotice(key) {
  notice = key;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    renderMain();
  }, NOTICE_MS);
  renderMain();
}

// The main process resolves null (false for applyFavorite) when it refused a request, undefined when it has no answer.
async function refused(call, noticeKey) {
  const result = await call;
  if (result === null || result === false) showNotice(noticeKey);
  return result;
}

function toggledExtra(device, flag) {
  const flags = { windFree: isWindFree(device.extra), sleep: isSleep(device.extra) };
  flags[flag] = !flags[flag];
  if (flags.windFree && flags.sleep && !limitsOf(device).extra.includes('windFreeSleep')) {
    // The unit has no combined mode, so the flag just switched on replaces the other one.
    flags[flag === 'windFree' ? 'sleep' : 'windFree'] = false;
  }
  return extraFor(flags.windFree, flags.sleep);
}

/* Temperature */

function showSetpoint(value) {
  const element = byId('setpoint');
  const previous = element.dataset.value ? Number(element.dataset.value) : Number.NaN;
  element.dataset.value = value ?? '';
  if (element.textContent === formatTemp(value)) return;
  element.textContent = formatTemp(value);
  if (value == null || Number.isNaN(previous)) return;
  element.classList.remove('roll-up', 'roll-down');
  void element.offsetWidth;
  element.classList.add(value > previous ? 'roll-up' : 'roll-down');
}

function setSliderPosition(value, { min, max }) {
  tempInput.value = value ?? min;
  tempInput.parentElement.style.setProperty('--pct', value == null ? 0 : clamp((value - min) / (max - min), 0, 1));
}

function stepTemperature(direction) {
  const device = view?.device;
  if (!usable() || device.temp == null) return;
  const range = limitsOf(device).temp;
  const base = pendingTemp ?? device.temp;
  const next = clamp(roundTo(base + direction * range.passo, 2), range.min, range.max);
  if (next === base) return;
  pendingTemp = next;
  showSetpoint(next);
  setSliderPosition(next, range);
  send('temp', next);
}

/* Rendering */

function setReading(id, text) {
  const reading = byId(id);
  reading.hidden = text == null;
  reading.querySelector('strong').textContent = text ?? '--';
}

function renderReadings(device) {
  setReading('reading-room', device?.ambiente == null ? null : `${formatTemp(device.ambiente)}°`);
  setReading('reading-humidity', device?.umidade == null ? null : `${Math.round(device.umidade)}%`);
}

function renderCells(device, limits) {
  for (const key of ['modo', 'vento', 'oscilar']) {
    const value = device[key] == null ? '--' : optionFor(key, device[key]).short;
    document.querySelector(`[data-value-for='${key}']`).textContent = value;
  }
  setIcon(document.querySelector("[data-icon-for='modo']"), optionFor('modo', device.modo).icon);
  setIcon(document.querySelector("[data-icon-for='oscilar']"), optionFor('oscilar', device.oscilar).icon);
  const sleeping = isSleep(device.extra);
  byId('sleep').setAttribute('aria-checked', String(sleeping));
  byId('sleep').hidden = !limits.extra.some(isSleep);
  document.querySelector("[data-value-for='sono']").textContent = t(sleeping ? 'main.sleepOn' : 'main.sleepOff');
}

function renderDevice(device) {
  const limits = limitsOf(device);
  const { min, max } = limits.temp;
  Object.assign(panel.dataset, {
    power: device.ligado ? 'on' : 'off',
    mode: device.modo,
    fan: device.vento,
    swing: device.oscilar,
    windfree: String(isWindFree(device.extra)),
    display: device.display,
  });
  renderReadings(device);
  byId('unit-display').textContent = formatTemp(device.temp);
  byId('power').setAttribute('aria-label', t(device.ligado ? 'main.powerOff' : 'main.powerOn'));
  byId('windfree').setAttribute('aria-checked', String(isWindFree(device.extra)));
  byId('windfree').hidden = !limits.extra.some(isWindFree);
  Object.assign(tempInput, { min, max, step: limits.temp.passo });
  byId('scale-min').textContent = `${formatTemp(min)}°`;
  byId('scale-max').textContent = `${formatTemp(max)}°`;
  byId('temp-down').disabled = device.temp == null || device.temp <= min;
  byId('temp-up').disabled = device.temp == null || device.temp >= max;
  if (!tempInput.parentElement.classList.contains('dragging')) {
    showSetpoint(device.temp);
    setSliderPosition(device.temp, limits.temp);
  }
  renderCells(device, limits);
}

// What a failed run looks like to the person, by reason: the footer and the sign-in card say the same thing.
function failedError(error) {
  const reason = Object.hasOwn(ERROR_STATUS, error.reason) ? error.reason : 'desconhecido';
  const known = ERROR_STATUS[reason];
  // The backend's own message is in Portuguese: it is only worth showing to someone reading Portuguese.
  const detail = activeLocale === 'pt-BR' ? error.message : undefined;
  return { icon: known.icon, text: t(`status.error.${reason}`), pick: Boolean(known.pick), detail };
}

function statusFor(current) {
  const error = current?.error;
  if (error?.kind === 'failed') return { tone: 'error', retry: true, ...failedError(error) };
  const device = current?.device;
  if (device?.online === false) return { tone: 'error', icon: 'unplug', text: t('status.offline'), retry: true };
  if (error?.kind === 'unconfirmed') {
    const names = formatList(error.keys.map(unconfirmedName));
    return { tone: 'error', icon: 'triangle-alert', text: t('status.unconfirmed', { names }) };
  }
  if (notice) return { tone: 'error', icon: 'triangle-alert', text: t(notice) };
  if (!device) return { tone: 'busy', icon: 'loader-circle', text: t('status.connecting') };
  if (current.syncing) return { tone: 'busy', icon: 'loader-circle', text: t('status.syncing') };
  if (current.held?.length > 0) return { tone: 'quiet', icon: 'clock', text: t('status.held') };
  if (settings.timer) {
    const text = timerText(settings.timer);
    // A timer of another unit has a longer line, which the footer may cut: the full text stays in the tooltip.
    return { tone: 'quiet', icon: 'clock', text, detail: otherUnitName(settings.timer.aparelho) ? text : undefined };
  }
  return { tone: 'ok', icon: 'shield-check', text: t('status.connected') };
}

function updatedAtText() {
  if (!view?.updatedAt) return '';
  return t('status.updatedAt', { time: formatClock(view.updatedAt) });
}

function renderStatus(status) {
  const element = byId('status');
  element.hidden = loggedOut();
  element.dataset.tone = status.tone;
  setIcon(byId('status-icon'), status.icon);
  byId('status-text').textContent = status.text;
  byId('retry').hidden = !status.retry;
  byId('pick-device').hidden = !status.pick;
  element.title = status.detail ?? updatedAtText();
}

// A failed run can leave an error behind while the user is still signed out (no internet, say): the card says so, since
// the footer is hidden then.
function renderLoginError() {
  const shown = view?.error?.kind === 'failed' ? failedError(view.error) : null;
  for (const box of document.querySelectorAll('.login-error')) {
    box.hidden = shown === null;
    if (!shown) continue;
    setIcon(box.querySelector('.login-error-icon'), shown.icon);
    box.querySelector('.login-error-text').textContent = shown.text;
    box.title = shown.detail ?? '';
  }
}

// A signed-out card swaps its content under the focused button, so focus follows the card's action.
function renderLogin(login) {
  const hadFocus = byId('login-card').contains(document.activeElement);
  byId('login-needed').hidden = login !== 'needed';
  byId('login-waiting').hidden = login !== 'waiting';
  renderLoginError();
  if (login === lastLogin) return;
  lastLogin = login;
  if (login === 'ok' || !hadFocus || !keyboardUser) return;
  (login === 'needed' ? byId('login') : byId('cancel-login')).focus();
}

// Favourites and timer need a reachable unit, and an error leaves their room to the message.
function renderFooterTools(status) {
  const available = usable() && status.tone !== 'error';
  for (const tool of document.querySelectorAll('.tool')) {
    tool.hidden = loggedOut() || status.tone === 'error';
    tool.disabled = !available;
  }
  byId('open-timer').dataset.active = String(Boolean(settings.timer));
  if (!available && popupOwner?.classList.contains('tool')) closePopup();
}

function renderMain() {
  const device = view?.device;
  const login = loginState();
  const status = statusFor(view);
  panel.dataset.loading = String(!device);
  panel.dataset.login = login;
  panel.dataset.online = String(device?.online !== false);
  if (device) renderDevice(device);
  else renderReadings(null);
  // Behind the sign-in card the unit stays idle, whatever the last reading said.
  if (login !== 'ok') panel.dataset.power = 'off';
  renderLogin(login);
  renderStatus(status);
  renderFooterTools(status);
}

/* Wiring */

byId('power').addEventListener('click', withDevice((device) => send('ligado', !device.ligado)));
byId('windfree').addEventListener('click', withDevice((device) => send('extra', toggledExtra(device, 'windFree'))));
byId('sleep').addEventListener('click', withDevice((device) => send('extra', toggledExtra(device, 'sleep'))));
byId('temp-down').addEventListener('click', () => stepTemperature(-1));
byId('temp-up').addEventListener('click', () => stepTemperature(1));

tempInput.addEventListener('input', () => {
  const value = Number(tempInput.value);
  tempInput.parentElement.classList.add('dragging');
  showSetpoint(value);
  setSliderPosition(value, limitsOf(view?.device).temp);
});

tempInput.addEventListener('change', () => {
  tempInput.parentElement.classList.remove('dragging');
  pendingTemp = Number(tempInput.value);
  send('temp', pendingTemp);
});

byId('retry').addEventListener('click', () => window.ac.refresh());
byId('pick-device').addEventListener('click', () => openSettings('device'));
byId('login').addEventListener('click', () => window.ac.login());
byId('cancel-login').addEventListener('click', () => window.ac.cancelLogin());
