const { globalShortcut } = require('electron');

const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']);

// A global shortcut with no modifier would swallow a plain key in every app.
function hasModifier(accelerator) {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase());
  return parts.slice(0, -1).some((part) => MODIFIERS.has(part));
}

class Shortcut {
  #onTrigger;
  #registered = null;

  constructor(onTrigger) {
    this.#onTrigger = onTrigger;
  }

  // Makes the system match the setting. False means the key could not be taken: another app owns it, or it is no valid
  // accelerator, or it has no modifier.
  apply({ ativo, tecla }) {
    if (ativo && this.#registered === tecla) return true;
    this.dispose();
    if (!ativo) return true;
    if (!hasModifier(tecla)) return false;
    try {
      if (globalShortcut.register(tecla, this.#onTrigger)) {
        this.#registered = tecla;
        return true;
      }
    } catch {
      // An accelerator Electron cannot parse throws instead of returning false.
    }
    return false;
  }

  dispose() {
    if (this.#registered) globalShortcut.unregister(this.#registered);
    this.#registered = null;
  }
}

module.exports = { Shortcut };
