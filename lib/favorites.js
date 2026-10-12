const { randomUUID } = require('node:crypto');

const NAME_MAX_LENGTH = 40;
// The mode goes first because the other keys are read in the context of the mode the unit is in.
const CLIMATE_KEYS = ['modo', 'temp', 'vento', 'extra', 'oscilar'];

class Favorites {
  #settings;
  #bridge;

  constructor({ settings, bridge }) {
    this.#settings = settings;
    this.#bridge = bridge;
  }

  // Captures what the panel is showing right now, optimistic values included.
  save(nome) {
    const { device } = this.#bridge.view();
    const name = typeof nome === 'string' ? nome.trim().slice(0, NAME_MAX_LENGTH) : '';
    if (!device || !name) return null;
    const favorito = { id: randomUUID(), nome: name };
    for (const key of CLIMATE_KEYS) favorito[key] = device[key] ?? null;
    this.#settings.update({ favoritos: [...this.#settings.get().favoritos, favorito] });
    return favorito;
  }

  // What the favourite sets on a unit, as one `{ key: value }` object; null when there is no such favourite.
  changes(id) {
    const favorito = this.#settings.get().favoritos.find((item) => item.id === id);
    if (!favorito) return null;
    return Object.fromEntries(CLIMATE_KEYS.filter((key) => favorito[key] != null).map((key) => [key, favorito[key]]));
  }

  apply(id) {
    const changes = this.changes(id);
    if (!changes) return false;
    for (const [key, value] of Object.entries(changes)) this.#bridge.set(key, value);
    this.#bridge.set('ligado', true);
    return true;
  }

  remove(id) {
    const { favoritos, agendas } = this.#settings.get();
    // A schedule pointing at a deleted favourite would silently fall back to a plain "turn on".
    this.#settings.update({
      favoritos: favoritos.filter((item) => item.id !== id),
      agendas: agendas.map((agenda) => (agenda.favorito === id ? { ...agenda, favorito: null } : agenda)),
    });
  }
}

module.exports = { Favorites };
