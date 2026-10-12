const SVG_NS = 'http://www.w3.org/2000/svg';
const IS_MAC = window.ac.platform === 'darwin';
const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

const panel = document.getElementById('panel');

function byId(id) {
  return document.getElementById(id);
}

function random(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Keeps 23 + 0.5 steps free of float noise such as 23.500000000000004.
function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function iconElement(name) {
  const pascalName = name.replace(/(^|-)(\w)/g, (_match, _dash, letter) => letter.toUpperCase());
  return lucide.createElement(lucide.icons[pascalName], { class: 'lucide' });
}

function setIcon(container, name) {
  if (container.dataset.icon === name) return;
  container.dataset.icon = name;
  container.replaceChildren(iconElement(name));
}

// The CSP forbids inline style attributes, so attrs never carries `style`: use element.style instead.
function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.filter((child) => child != null && child !== false));
  return element;
}

function svgEl(tag, attrs = {}, ...children) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) => !node.closest('[hidden], [inert]'));
}

// Script-driven focus draws a ring, which looks odd with the mouse: only keyboard users get their focus moved.
let keyboardUser = false;
document.addEventListener(
  'keydown',
  () => {
    keyboardUser = true;
  },
  true,
);
document.addEventListener(
  'pointerdown',
  () => {
    keyboardUser = false;
  },
  true,
);

// Redrawing on every poll would reset hover, focus and scroll; callers skip work when nothing changed.
const signatures = new Map();

function changed(key, value) {
  const signature = JSON.stringify(value);
  if (signatures.get(key) === signature) return false;
  signatures.set(key, signature);
  return true;
}

function formatNumber(value, digits = 0) {
  return value.toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatTemp(value) {
  if (value == null) return '--';
  return Number.isInteger(value) ? String(value) : formatNumber(value, 1);
}

// 24 h or 12 h, as the language's locale writes it: "09:05" on a 24 h clock, "9:05 AM" on a 12 h one.
function formatClock(epochMs) {
  const twelveHour = new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric' }).resolvedOptions().hour12;
  return new Date(epochMs).toLocaleTimeString(intlLocale(), { hour: twelveHour ? 'numeric' : '2-digit', minute: '2-digit' });
}

// Schedules keep their time as "HH:MM"; this shows it the way formatClock would.
function formatTimeOfDay(hora) {
  const [hours, minutes] = hora.split(':').map(Number);
  return formatClock(new Date(2000, 0, 1, hours, minutes).getTime());
}

function formatList(items) {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type: 'conjunction' }).format(items);
}

function dayKey(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
