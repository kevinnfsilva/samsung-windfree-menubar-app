/* Settings > Aparelho: pick which air conditioner of the account the app controls. */

// The row the user just picked, shown as selected until the bridge confirms it.
let chosenDevice = null;

function enterDevicePage() {
  chosenDevice = null;
  window.ac.listDevices();
  renderDevicePage();
}

function deviceRow(device) {
  const row = el(
    'button',
    { type: 'button', class: 'row row-plain', role: 'radio', 'aria-checked': 'false', 'data-id': device.id },
    el('span', { class: 'row-text' }, el('span', { class: 'row-title' }, device.nome)),
    el('span', { class: 'radio', 'aria-hidden': 'true' }),
  );
  row.addEventListener('click', () => {
    chosenDevice = device.id;
    window.ac.useDevice(device.id);
    renderDevicePage();
  });
  return row;
}

function renderDevicePage() {
  const devices = view?.devices;
  const list = byId('devices-list');
  byId('devices-loading').hidden = devices != null;
  byId('devices-empty').hidden = devices?.length !== 0;
  list.hidden = !devices?.length;
  if (!devices?.length) return;
  const activeId = devices.find((device) => device.ativo)?.id;
  if (chosenDevice === activeId || view.error) chosenDevice = null;
  const selectedId = chosenDevice ?? activeId;
  if (changed('devices', devices.map(({ id, nome }) => [id, nome]))) list.replaceChildren(...devices.map(deviceRow));
  for (const row of list.children) row.setAttribute('aria-checked', String(row.dataset.id === selectedId));
}
