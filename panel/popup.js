/* One floating popup shared by the option menus, favourites and timer. */

const popup = byId('menu');
let popupOwner = null;
let popupBuild = null;
let popupLabel = null;

function placePopup(owner, align) {
  const panelBox = panel.getBoundingClientRect();
  const ownerBox = owner.getBoundingClientRect();
  const wanted = align === 'right' ? ownerBox.right - panelBox.left - popup.offsetWidth : ownerBox.left - panelBox.left;
  const left = clamp(wanted, 12, panelBox.width - popup.offsetWidth - 12);
  popup.style.left = `${left}px`;
  popup.style.bottom = `${panelBox.bottom - ownerBox.top + 8}px`;
}

// `build` returns the popup's children and `label` its name; both may run again while open, so they must not hold DOM state.
function openPopup(owner, { role, label, align = 'left', build, focus }) {
  closePopup();
  popup.setAttribute('role', role);
  popup.setAttribute('aria-label', label());
  popup.dataset.align = align;
  popup.replaceChildren(...build());
  popup.hidden = false;
  placePopup(owner, align);
  owner.setAttribute('aria-expanded', 'true');
  popupOwner = owner;
  popupBuild = build;
  popupLabel = label;
  (focus?.() ?? focusableIn(popup)[0])?.focus();
}

function closePopup({ restoreFocus = false } = {}) {
  if (!popupOwner) return;
  const owner = popupOwner;
  popup.hidden = true;
  popup.replaceChildren();
  owner.setAttribute('aria-expanded', 'false');
  popupOwner = null;
  popupBuild = null;
  popupLabel = null;
  if (restoreFocus) owner.focus();
}

function togglePopup(owner, options) {
  if (popupOwner === owner) closePopup();
  else openPopup(owner, options);
}

// Rebuilds the open popup after its data changed, keeping the keyboard position when the focused element survives.
function refreshPopup() {
  if (!popupOwner) return;
  const items = focusableIn(popup);
  const focusIndex = popup.contains(document.activeElement) ? items.indexOf(document.activeElement) : -1;
  popup.setAttribute('aria-label', popupLabel());
  popup.replaceChildren(...popupBuild());
  placePopup(popupOwner, popup.dataset.align);
  if (focusIndex < 0) return;
  const next = focusableIn(popup);
  next[Math.min(focusIndex, next.length - 1)]?.focus();
}

function trapFocus(event) {
  const items = focusableIn(popup);
  const edge = event.shiftKey ? items[0] : items.at(-1);
  if (document.activeElement !== edge) return;
  event.preventDefault();
  (event.shiftKey ? items.at(-1) : items[0]).focus();
}

popup.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    trapFocus(event);
    return;
  }
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step || event.target.matches('input')) return;
  event.preventDefault();
  const items = focusableIn(popup).filter((item) => !item.matches('input'));
  const index = items.indexOf(document.activeElement);
  items[(index + step + items.length) % items.length].focus();
});

// composedPath is read at dispatch time, so a click on a row the popup just rebuilt still counts as inside.
document.addEventListener('click', (event) => {
  if (!popupOwner) return;
  const path = event.composedPath();
  if (!path.includes(popup) && !path.includes(popupOwner)) closePopup();
});

/* Option menus: Modo, Vento, Direção */

function optionItem(key, value, selected) {
  const option = optionFor(key, value);
  const attrs = { type: 'button', class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(selected) };
  const item = el('button', attrs);
  const check = el('span', { class: 'menu-check' }, selected ? iconElement('check') : null);
  item.append(iconElement(option.icon), el('span', {}, option.label), check);
  item.addEventListener('click', () => {
    closePopup({ restoreFocus: true });
    window.ac.set(key, value);
  });
  return item;
}

function openOptionMenu(cell) {
  const key = cell.dataset.menu;
  togglePopup(cell, {
    role: 'menu',
    label: () => cell.querySelector('.cell-label').textContent,
    build: () => {
      const device = view?.device;
      return limitsOf(device)[key].map((value) => optionItem(key, value, value === device?.[key]));
    },
    focus: () => popup.querySelector("[aria-checked='true']") ?? popup.firstElementChild,
  });
}

for (const cell of document.querySelectorAll('[data-menu]')) {
  cell.addEventListener('click', () => {
    if (view?.device) openOptionMenu(cell);
  });
}
