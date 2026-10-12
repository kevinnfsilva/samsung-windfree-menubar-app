const { Notification } = require('electron');

const CHECK_MS = 60_000;
const HOUR_MS = 3_600_000;
// A reading older than this says little about the unit now, e.g. after the computer slept.
const STALE_VIEW_MS = 3 * 60_000;
// The filter statuses that ask for something, and the text for each; any other status that is not "normal" gets the general one.
const FILTER_TEXT = { wash: 'notify.filterWash', replace: 'notify.filterReplace' };
const RECENT_KEPT = 5;

// Every warning fires on a change, not on a state, so it does not repeat while the condition lasts.
// The first reading of a unit only sets the baseline: a filter that was already dirty at launch stays quiet.
class Notifier {
  #settings;
  #bridge;
  #onClick;
  #i18n;
  #interval;
  #seen = null;
  #onSince = null;
  #warnedOn = false;
  // macOS drops the click handler of a notification that gets garbage collected.
  #recent = [];

  // `i18n` is a function so that a language chosen while the app runs applies to the next warning.
  constructor({ settings, bridge, onClick, i18n }) {
    this.#settings = settings;
    this.#bridge = bridge;
    this.#onClick = onClick;
    this.#i18n = i18n;
  }

  // Time passing is a change too: "on for N hours" needs a look at the clock even when nothing else happens.
  start() {
    this.#interval = setInterval(() => this.check(this.#bridge.view()), CHECK_MS);
  }

  stop() {
    clearInterval(this.#interval);
  }

  check({ device, login, updatedAt }) {
    // Without a session the last reading is old news.
    if (!device || login !== 'ok') return;
    try {
      this.#evaluate(device, updatedAt != null && Date.now() - updatedAt <= STALE_VIEW_MS);
    } catch (error) {
      console.error(error);
    }
  }

  // Something to tell the user about a unit that is not the one on screen, e.g. a scheduled command that failed.
  alert(name, key, params) {
    try {
      this.#show({ nome: name }, key, params);
    } catch (error) {
      console.error(error);
    }
  }

  #evaluate(device, fresh) {
    const { notificacoes } = this.#settings.get();
    if (this.#seen?.id !== device.id) {
      this.#seen = { id: device.id, filtroStatus: null, online: null };
      this.#onSince = null;
      this.#warnedOn = false;
    }
    const seen = this.#seen;

    // A unit that stops reporting the filter says nothing about it, so null leaves the baseline alone.
    const filtro = device.filtroStatus ?? null;
    if (notificacoes.filtro && seen.filtroStatus === 'normal' && filtro !== null && filtro !== 'normal') {
      this.#show(device, FILTER_TEXT[filtro] ?? 'notify.filter');
    }
    if (filtro !== null) seen.filtroStatus = filtro;

    if (notificacoes.offline && seen.online === true && device.online === false) {
      this.#show(device, 'notify.offline');
    }
    if (typeof device.online === 'boolean') seen.online = device.online;

    if (device.ligado === false) {
      this.#onSince = null;
      this.#warnedOn = false;
    } else if (device.ligado === true) {
      // How long it was on before the app saw it is unknown, so the count starts at the first reading.
      this.#onSince ??= Date.now();
    }
    const horas = notificacoes.ligadoHoras;
    const waited = Date.now() - (this.#onSince ?? Date.now());
    // The count keeps running while the reading is stale, but nothing is said until a fresh reading confirms the unit is still on.
    if (fresh && horas > 0 && device.ligado === true && device.online !== false && !this.#warnedOn && waited >= horas * HOUR_MS) {
      this.#warnedOn = true;
      this.#show(device, 'notify.onFor', { count: horas });
    }
  }

  #show(device, key, params) {
    if (!Notification.isSupported()) return;
    const { t } = this.#i18n();
    const notification = new Notification({ title: device.nome ?? t('device.defaultName'), body: t(key, params) });
    notification.on('click', this.#onClick);
    this.#recent.push(notification);
    if (this.#recent.length > RECENT_KEPT) this.#recent.shift();
    notification.show();
  }
}

module.exports = { Notifier };
