const ARROW_STEP = { ArrowUp: 1, ArrowDown: -1 };
const ARROW_CONTROLS = "input:not([type='checkbox']):not([type='button']), select, textarea, [contenteditable='true']";
const SPACE_CONTROLS =
  "button, input, select, textarea, a[href], summary, [role='switch'], [role='radio'], [role='menuitem'], [role='menuitemradio']";

const SHORTCUT_GUARD_MS = 700;

let shownAt = Number.NEGATIVE_INFINITY;

// With the global shortcut the panel takes keyboard focus while the user may still be typing elsewhere, and a stray Space
// once toggled the real air conditioner: keys are ignored for a moment after the panel appears. A button that kept focus
// from last time would take Space natively and get around that, so nothing is left focused.
function markPanelShown() {
  shownAt = performance.now();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function keysGuarded() {
  return loggedOut() || performance.now() - shownAt < SHORTCUT_GUARD_MS;
}

// Arrow keys step the temperature and Space flips the power, unless the focused control already owns the key.
function handleShortcutKey(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (keysGuarded() || popupOwner || settingsOpen() || !usable()) return;
  const target = event.target instanceof Element ? event.target : document.body;
  if (event.key in ARROW_STEP) {
    if (target.matches(ARROW_CONTROLS)) return;
    event.preventDefault();
    stepTemperature(ARROW_STEP[event.key]);
    return;
  }
  if (event.key !== ' ' || target.closest(SPACE_CONTROLS)) return;
  event.preventDefault();
  if (!event.repeat) send('ligado', !view.device.ligado);
}

// Escape peels one layer: popup, then sub-page, then settings, then the panel itself.
function handleEscape() {
  if (popupOwner) closePopup({ restoreFocus: true });
  else if (settingsOpen()) goBack();
  else window.ac.hide();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') handleEscape();
  else handleShortcutKey(event);
});
