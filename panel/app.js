// Entry point: renders from the two sources of truth (the bridge view and the settings) and subscribes to them.

let settingsReceived = false;

function render() {
  renderMain();
  renderSettings();
  renderTrayIcon();
  const device = view?.device;
  const popupInputs = [settings.favoritos, settings.timer, Boolean(device), device?.ligado, device?.modo, device?.vento];
  if (changed('popup', [...popupInputs, device?.oscilar])) refreshPopup();
}

panel.addEventListener('animationend', (event) => {
  if (event.target === panel) panel.classList.remove('entering');
});

window.ac.onShow(() => {
  markPanelShown();
  panel.classList.remove('asleep', 'entering');
  void panel.offsetWidth;
  panel.classList.add('entering');
});

window.ac.onHide(() => {
  closePopup();
  closeSettings();
  resetPages();
  panel.classList.add('asleep');
});

// Every text drawn so far is in the old language: the caches that skip redundant redraws are dropped, then all is drawn again.
window.ac.onLocale((code) => {
  setLocale(code);
  signatures.clear();
  applyPageStack();
  render();
  refreshHistory();
});

window.ac.onTheme((dark) => {
  darkTaskbar = dark;
  trayIconKey = '';
  renderTrayIcon();
});

window.ac.onState((next) => {
  view = next;
  pendingTemp = null;
  render();
});

// Registered before getState() below: settings also change outside the panel (tray menu, a timer firing).
window.ac.onSettings((next) => {
  settingsReceived = true;
  applySettings(next);
  render();
});

document.documentElement.dataset.platform = window.ac.platform;
if (IS_MAC) {
  byId('autostart-title').dataset.i18n = 'autostart.mac';
  byId('autostart').dataset.i18nAriaLabel = 'autostart.mac';
  byId('row-dock').hidden = false;
  // Only the macOS menu bar icon can show the room temperature; the Windows tray icon is too small for it.
  byId('row-room-icon').hidden = false;
  applyStaticTexts();
}

lucide.createIcons();
buildStreaks();
buildDrift();

window.ac.getState().then((initial) => {
  darkTaskbar = initial.darkTaskbar;
  view ??= initial.view;
  if (!settingsReceived) applySettings(initial.settings);
  if (initial.locale) setLocale(initial.locale);
  render();
});
