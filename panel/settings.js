/* Settings: a stack of pages under one header, with the root page's own rows. */

const PAGES = ['root', 'device', 'history', 'schedules', 'advanced', 'prefs'];
const PAGE_ENTER = { device: () => enterDevicePage(), history: () => enterHistoryPage() };

let pageStack = ['root'];
let pageOpeners = [];
let filterConfirming = false;

function settingsOpen() {
  return panel.classList.contains('settings-open');
}

function pageElement(name) {
  return byId(`page-${name}`);
}

function applyPageStack() {
  const top = pageStack.at(-1);
  for (const name of PAGES) {
    const page = pageElement(name);
    page.classList.toggle('active', name === top);
    page.classList.toggle('behind', name !== top && pageStack.includes(name));
    page.inert = name !== top;
  }
  byId('settings-title').textContent = t(pageElement(top).dataset.titleKey);
  byId('device-name').hidden = top !== 'root';
}

function pushPage(name, opener = null) {
  pageStack.push(name);
  pageOpeners.push(opener);
  applyPageStack();
  PAGE_ENTER[name]?.();
  byId('settings-title').focus();
}

function resetPages() {
  pageStack = ['root'];
  pageOpeners = [];
  applyPageStack();
  setFilterConfirm(false);
}

function openSettings(page) {
  closePopup();
  resetPages();
  panel.classList.add('settings-open');
  byId('settings').inert = false;
  document.querySelector('.view-main').inert = true;
  renderSettings();
  if (page) pushPage(page);
  else byId('close-settings').focus();
}

function closeSettings({ restoreFocus = false } = {}) {
  panel.classList.remove('settings-open');
  byId('settings').inert = true;
  document.querySelector('.view-main').inert = false;
  if (restoreFocus) byId('open-settings').focus();
}

// Back pops one page; from the root page it leaves settings.
function goBack() {
  if (pageStack.length < 2) {
    closeSettings({ restoreFocus: true });
    return;
  }
  pageStack.pop();
  const opener = pageOpeners.pop();
  applyPageStack();
  (opener ?? byId('settings-title')).focus();
}

/* Segmented control shared by every page */

function renderSegmented(container, options, selected, onPick) {
  const signature = options.map((option) => option.value).join('|');
  if (container.dataset.signature !== signature) {
    container.dataset.signature = signature;
    container.replaceChildren(
      ...options.map((option) => {
        const button = el('button', { type: 'button', 'data-value': String(option.value) }, option.label);
        button.addEventListener('click', () => onPick(option.value));
        return button;
      }),
    );
  }
  // The labels change with the language; rewriting them in place keeps the focus on the button the user is pressing.
  options.forEach((option, index) => {
    const button = container.children[index];
    if (button.textContent !== option.label) button.textContent = option.label;
    button.setAttribute('aria-pressed', String(button.dataset.value === String(selected)));
  });
}

function syncGroupVisibility(group) {
  group.hidden = [...group.children].every((row) => row.hidden);
}

/* Root page */

function filterNote(device) {
  if (device.filtroUso == null) return t('filter.noReading');
  if (FILTER_NOTE_STATUSES.includes(device.filtroStatus)) return t(`filter.${device.filtroStatus}`);
  if (device.filtroAlerta == null) return t('filter.cycle', { percent: Math.round(device.filtroUso) });
  const remainingHours = Math.max(0, Math.round(((100 - device.filtroUso) / 100) * device.filtroAlerta));
  return t('filter.remaining', { hours: remainingHours });
}

function setFilterConfirm(open) {
  filterConfirming = open;
  byId('filter-confirm').hidden = !open;
  byId('filter-reset').setAttribute('aria-expanded', String(open));
}

function renderFilter(device) {
  const meter = byId('filter-meter');
  meter.parentElement.hidden = device?.filtroUso == null;
  meter.style.width = `${clamp(device?.filtroUso ?? 0, 0, 100)}%`;
  meter.parentElement.dataset.alert = String(device != null && device.filtroStatus !== 'normal');
  byId('filter-note').textContent = device ? filterNote(device) : '--';
  // The unit lists the thresholds it accepts; the current one shows up, selected, even if it is not among them.
  const known = new Set([...limitsOf(device).filtroAlerta, device?.filtroAlerta].filter(Number.isFinite));
  const hours = [...known].sort((a, b) => a - b);
  const options = hours.map((value) => ({ value, label: t('fmt.hours', { n: value }) }));
  renderSegmented(byId('filter-alerts'), options, device?.filtroAlerta, (value) => send('filtroAlerta', value));
  byId('row-filter-alert').hidden = device != null && device.filtroAlerta == null;
}

function renderRoot() {
  const device = view?.device;
  const limits = limitsOf(device);
  byId('device-name').textContent = device?.nome ?? '';
  byId('device-row-name').textContent = device?.nome ?? '--';
  for (const element of document.querySelectorAll('.needs-device')) element.inert = !device || loggedOut();
  for (const toggle of document.querySelectorAll('[data-setting]')) {
    const value = device?.[toggle.dataset.setting];
    toggle.setAttribute('aria-checked', String(value === 'on'));
    toggle.closest('.row').hidden = device != null && value == null;
  }
  const modes = extraModes().filter((mode) => limits.extra.includes(mode.value));
  byId('row-extra').hidden = !modes.some((mode) => mode.value !== 'off');
  renderSegmented(byId('extra-modes'), modes, device?.extra, (value) => send('extra', value));
  syncGroupVisibility(byId('group-toggles'));
  renderFilter(device);
  byId('power-now').hidden = device?.potencia == null;
  byId('power-now').textContent = device?.potencia == null ? '' : t('fmt.watts', { value: formatNumber(device.potencia) });
  byId('energy-note').textContent =
    device?.energia == null ? t('settings.energyHistory') : t('settings.energyTotal', { kwh: formatNumber(Math.round(device.energia)) });
}

function renderSettings() {
  renderRoot();
  renderHistoryLabels();
  renderDevicePage();
  renderSchedulesPage();
  renderAdvancedPage();
  renderPrefsPage();
}

/* Wiring */

for (const button of document.querySelectorAll('[data-go]')) {
  button.addEventListener('click', () => pushPage(button.dataset.go, button));
}

for (const toggle of document.querySelectorAll('[data-setting]')) {
  toggle.addEventListener(
    'click',
    withDevice((device) => {
      const key = toggle.dataset.setting;
      send(key, device[key] === 'on' ? 'off' : 'on');
    }),
  );
}

byId('filter-reset').addEventListener('click', () => {
  setFilterConfirm(!filterConfirming);
  if (filterConfirming) byId('filter-cancel').focus();
});

byId('filter-cancel').addEventListener('click', () => {
  setFilterConfirm(false);
  byId('filter-reset').focus();
});

byId('filter-confirm-yes').addEventListener('click', () => {
  setFilterConfirm(false);
  window.ac.run('zera-filtro');
  byId('filter-reset').focus();
});

byId('open-settings').addEventListener('click', () => openSettings());
byId('close-settings').addEventListener('click', goBack);
