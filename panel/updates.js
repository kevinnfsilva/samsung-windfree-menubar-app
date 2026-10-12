/* New-version notice: a dot on the settings button and a row at the top of the settings root page. */

function renderUpdate() {
  const button = byId('open-settings');
  button.dataset.update = String(updateNotice !== null);
  button.setAttribute('aria-label', t(updateNotice ? 'main.openSettingsUpdate' : 'main.openSettings'));
  byId('group-update').hidden = updateNotice === null;
  if (updateNotice) byId('update-title').textContent = t('update.available', { version: updateNotice.versao });
}

byId('update-download').addEventListener('click', () => window.ac.openUpdate());
