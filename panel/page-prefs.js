/* Settings > Preferências: app-level options kept in settings.json by the main process. */

const MAC_KEY_SYMBOLS = {
  alt: '⌥',
  option: '⌥',
  command: '⌘',
  cmd: '⌘',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  super: '⌘',
  meta: '⌘',
  control: '⌃',
  ctrl: '⌃',
  shift: '⇧',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  return: '↩',
  enter: '↩',
  space: '␣',
  tab: '⇥',
  escape: '⎋',
  esc: '⎋',
  backspace: '⌫',
  delete: '⌦',
};
const MAC_MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘'];
const WINDOWS_KEY_NAMES = { control: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', super: 'Win', meta: 'Win' };

// Electron accelerators read "Alt+Command+W"; the Mac shows them the way the menu bar does, modifiers first.
function formatShortcut(accelerator) {
  const parts = String(accelerator ?? '').split('+').filter(Boolean);
  if (!IS_MAC) return parts.map((part) => WINDOWS_KEY_NAMES[part.toLowerCase()] ?? part).join('+');
  const symbols = parts.map((part) => MAC_KEY_SYMBOLS[part.toLowerCase()] ?? part.toUpperCase());
  const modifiers = MAC_MODIFIER_ORDER.filter((symbol) => symbols.includes(symbol));
  return [...modifiers, ...symbols.filter((symbol) => !MAC_MODIFIER_ORDER.includes(symbol))].join('');
}

function prefValue(path) {
  const [group, key] = path.split('.');
  return key ? settings[group][key] : settings[group];
}

function prefPatch(path, value) {
  const [group, key] = path.split('.');
  return key ? { [group]: { [key]: value } } : { [group]: value };
}

// "Automatic" first, then every language the panel has a dictionary for, each named in its own language.
function languageOptions() {
  const languages = Object.entries(WindFreeLocales).map(([code, messages]) => ({ value: code, label: messages['meta.name'] }));
  return [{ value: 'auto', label: t('prefs.languageAuto') }, ...languages];
}

let shortcutFailed = false;

function renderPrefsPage() {
  if (settings.atalho.ativo) shortcutFailed = false;
  byId('shortcut-error').hidden = !shortcutFailed;
  for (const toggle of document.querySelectorAll('[data-pref]')) {
    toggle.setAttribute('aria-checked', String(Boolean(prefValue(toggle.dataset.pref))));
  }
  renderSegmented(byId('on-hours'), onHoursOptions(), settings.notificacoes.ligadoHoras, (value) => {
    window.ac.updateSettings({ notificacoes: { ligadoHoras: value } });
  });
  renderSegmented(byId('language'), languageOptions(), settings.idioma, (value) => {
    window.ac.updateSettings({ idioma: value });
  });
  const keys = byId('shortcut-keys');
  keys.textContent = formatShortcut(settings.atalho.tecla);
  keys.hidden = !keys.textContent;
}

async function togglePref(path) {
  const enabling = !prefValue(path);
  if (path === 'atalho.ativo') shortcutFailed = false;
  const result = await window.ac.updateSettings(prefPatch(path, enabling));
  // The answer holds what was really applied: a shortcut that is taken or invalid comes back inactive.
  if (path === 'atalho.ativo' && enabling && result?.atalho?.ativo === false) {
    shortcutFailed = true;
    renderPrefsPage();
  }
}

// Switches only follow onSettings, so a change the main process refuses never looks applied.
for (const toggle of document.querySelectorAll('[data-pref]')) {
  toggle.addEventListener('click', () => togglePref(toggle.dataset.pref));
}
