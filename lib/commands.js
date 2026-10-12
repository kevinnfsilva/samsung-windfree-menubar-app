// What may be asked of the bridge. Keys and values end up as tokens on the command line of the CLI, so anything that
// does not have one of these shapes is refused here, before it gets that far.
const FLAG_KEYS = new Set(['ligado']);
const NUMBER_KEYS = new Set(['temp', 'filtroAlerta', 'tropical']);
const TEXT_KEYS = new Set(['modo', 'vento', 'extra', 'oscilar', 'display', 'bipe', 'autoclean', 'limpeza', 'diagnostico']);
const TEXT_PATTERN = /^[A-Za-z][\w.-]{0,31}$/;
const RUN_ACTIONS = new Set(['zera-filtro']);

function isValidChange(key, value) {
  if (FLAG_KEYS.has(key)) return typeof value === 'boolean';
  if (NUMBER_KEYS.has(key)) return Number.isFinite(value);
  return TEXT_KEYS.has(key) && typeof value === 'string' && TEXT_PATTERN.test(value);
}

// Keeps the valid entries of a `{ key: value }` object and nothing else.
function sanitizeChanges(changes) {
  const entries = Object.entries(changes !== null && typeof changes === 'object' ? changes : {});
  return Object.fromEntries(entries.filter(([key, value]) => isValidChange(key, value)));
}

function isValidAction(action) {
  return RUN_ACTIONS.has(action);
}

module.exports = { isValidAction, isValidChange, sanitizeChanges };
