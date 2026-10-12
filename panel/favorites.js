const FAVORITE_NAME_MAX = 40;

let favoriteNaming = false;
let favoriteDraft = '';
let favoriteFailed = false;

function favoriteRow(favorite) {
  const detail = el(
    'span',
    { class: 'fav-detail' },
    el('span', {}, `${formatTemp(favorite.temp)}°`),
    favorite.modo != null && el('span', {}, optionFor('modo', favorite.modo).short),
    favorite.vento != null && el('span', {}, optionFor('vento', favorite.vento).short),
  );
  const apply = el(
    'button',
    { type: 'button', class: 'menu-item fav-apply' },
    iconElement('star'),
    el('span', { class: 'fav-text' }, el('span', { class: 'fav-name' }, favorite.nome), detail),
  );
  apply.addEventListener('click', () => {
    closePopup({ restoreFocus: true });
    refused(window.ac.applyFavorite(favorite.id), 'fav.applyFailed');
  });
  const remove = el(
    'button',
    { type: 'button', class: 'menu-delete', 'aria-label': t('fav.deleteNamed', { name: favorite.nome }), title: t('fav.delete') },
    iconElement('trash-2'),
  );
  remove.addEventListener('click', () => window.ac.deleteFavorite(favorite.id));
  return el('div', { class: 'fav-row' }, apply, remove);
}

async function saveCurrentFavorite() {
  const name = favoriteDraft.trim();
  if (!name) return;
  const saved = await window.ac.saveFavorite(name);
  favoriteFailed = saved === null;
  if (!favoriteFailed) {
    favoriteNaming = false;
    favoriteDraft = '';
  }
  refreshPopup();
  popup.querySelector(favoriteFailed ? 'input' : '.menu-save')?.focus();
}

function favoriteForm() {
  const input = el('input', {
    class: 'field',
    type: 'text',
    maxlength: String(FAVORITE_NAME_MAX),
    autocomplete: 'off',
    placeholder: t('fav.nameLabel'),
    'aria-label': t('fav.nameLabel'),
  });
  input.value = favoriteDraft;
  const submit = el(
    'button',
    { class: 'btn btn-primary btn-small', type: 'submit', disabled: !favoriteDraft.trim() },
    t('fav.save'),
  );
  input.addEventListener('input', () => {
    favoriteDraft = input.value;
    submit.disabled = !input.value.trim();
    favoriteFailed = false;
    popup.querySelector('.menu-error')?.remove();
  });
  const form = el('form', { class: 'fav-form' }, input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveCurrentFavorite();
  });
  return el(
    'div',
    {},
    form,
    favoriteFailed && el('p', { class: 'menu-error', role: 'alert' }, t('fav.saveFailed')),
  );
}

function startNaming() {
  favoriteNaming = true;
  refreshPopup();
  popup.querySelector('input').focus();
}

function saveButton() {
  const button = el(
    'button',
    { type: 'button', class: 'menu-item menu-save', disabled: !view?.device },
    iconElement('bookmark-plus'),
    el('span', {}, t('fav.saveCurrent')),
  );
  button.addEventListener('click', startNaming);
  return button;
}

function favoritesContent() {
  const { favoritos } = settings;
  const list =
    favoritos.length > 0
      ? el('div', { class: 'fav-list' }, ...favoritos.map(favoriteRow))
      : el('p', { class: 'menu-empty' }, t('fav.empty'));
  return [
    el('div', { class: 'menu-title' }, t('fav.title')),
    list,
    el('div', { class: 'menu-separator', role: 'separator' }),
    favoriteNaming ? favoriteForm() : saveButton(),
  ];
}

byId('open-favorites').addEventListener('click', (event) => {
  favoriteNaming = false;
  favoriteDraft = '';
  favoriteFailed = false;
  togglePopup(event.currentTarget, { role: 'dialog', label: () => t('fav.title'), align: 'right', build: favoritesContent });
});
