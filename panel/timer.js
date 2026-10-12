function timerText(timer) {
  const time = formatClock(timer.quando);
  const unit = otherUnitName(timer.aparelho);
  if (timer.acao === 'liga') return unit ? t('timer.turnsOnAtUnit', { time, unit }) : t('timer.turnsOnAt', { time });
  return unit ? t('timer.turnsOffAtUnit', { time, unit }) : t('timer.turnsOffAt', { time });
}

function timerItem(icon, label, onPick) {
  const attrs = { type: 'button', class: 'menu-item', role: 'menuitem' };
  const item = el('button', attrs, iconElement(icon), el('span', {}, label), el('span'));
  item.addEventListener('click', () => {
    closePopup({ restoreFocus: true });
    onPick();
  });
  return item;
}

function timerContent() {
  const { timer } = settings;
  // The timer flips the unit: it switches it off while it runs and on while it is off.
  const acao = view?.device?.ligado ? 'desliga' : 'liga';
  const items = [el('div', { class: 'menu-title', role: 'presentation' }, t('timer.title'))];
  if (timer) {
    items.push(
      el('div', { class: 'menu-note', role: 'presentation' }, iconElement('clock'), el('span', {}, timerText(timer))),
      timerItem('x', t('timer.cancel'), () => window.ac.clearTimer()),
      el('div', { class: 'menu-separator', role: 'separator' }),
    );
  }
  for (const option of timerOptions(acao)) {
    const set = () => refused(window.ac.setTimer(acao, option.minutos), 'timer.failed');
    items.push(timerItem(acao === 'liga' ? 'power' : 'power-off', option.label, set));
  }
  return items;
}

byId('open-timer').addEventListener('click', (event) => {
  togglePopup(event.currentTarget, { role: 'menu', label: () => t('timer.title'), align: 'right', build: timerContent });
});
