const IS_MAC = process.platform === 'darwin';

// Windows reads an ampersand in a menu label as the mnemonic of the next letter.
function literal(text) {
  return IS_MAC ? text : text.replaceAll('&', '&&');
}

function tooltipFor({ device, login }, { t, number }) {
  if (login === 'needed') return ['WindFree', t('tray.tooltip.signIn')].join('\n');
  if (login === 'waiting') return ['WindFree', t('tray.tooltip.waiting')].join('\n');
  if (!device) return 'WindFree';
  const name = device.nome ?? t('device.defaultName');
  if (device.online === false) return t('tray.tooltip.offline', { name });
  const lines = [];
  if (!device.ligado) lines.push(t('tray.tooltip.off', { name }));
  else lines.push(device.temp == null ? t('tray.tooltip.on', { name }) : t('tray.tooltip.onAt', { name, temp: number(device.temp) }));
  // Not every unit reports the room, so each reading is optional.
  const room = device.ambiente == null ? null : number(device.ambiente);
  const humidity = device.umidade == null ? null : number(device.umidade);
  if (room !== null && humidity !== null) lines.push(t('tray.tooltip.ambientBoth', { room, humidity }));
  else if (room !== null) lines.push(t('tray.tooltip.ambientRoom', { room }));
  else if (humidity !== null) lines.push(t('tray.tooltip.humidity', { humidity }));
  return lines.join('\n');
}

function menuTemplate({ view, favoritos, autostart, update, i18n: { t }, actions }) {
  const { device, login } = view;
  const powerState = device?.ligado;
  const template = [];
  if (update) template.push({ label: t('tray.menu.update', { version: update.versao }), click: actions.openUpdate }, { type: 'separator' });
  template.push({ label: t('tray.menu.open'), click: actions.showPanel });
  if (login === 'needed') {
    template.push({ label: t('tray.menu.signIn'), click: actions.login });
  } else if (login === 'waiting') {
    template.push({ label: t('tray.menu.waiting'), enabled: false }, { label: t('tray.menu.cancelLogin'), click: actions.cancelLogin });
  } else {
    template.push({
      label: powerState ? t('tray.menu.turnOff') : t('tray.menu.turnOn'),
      enabled: Boolean(device),
      click: () => actions.setPower(!powerState),
    });
    if (device && favoritos.length > 0) {
      template.push({
        label: t('tray.menu.favorites'),
        submenu: favoritos.map(({ id, nome }) => ({ label: literal(nome), click: () => actions.applyFavorite(id) })),
      });
    }
    template.push({ label: t('tray.menu.refresh'), click: actions.refresh });
  }
  template.push(
    { type: 'separator' },
    { label: t(IS_MAC ? 'autostart.mac' : 'autostart.windows'), type: 'checkbox', checked: autostart, click: (item) => actions.setAutostart(item.checked) },
    { type: 'separator' },
    { label: t('tray.menu.quit'), click: actions.quit },
  );
  return template;
}

module.exports = { menuTemplate, tooltipFor };
