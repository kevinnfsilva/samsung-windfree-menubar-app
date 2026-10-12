/* Settings > Agendamentos: the saved schedules and the form for a new one. */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_SET = [1, 2, 3, 4, 5];
const WEEKEND_SET = [0, 6];
const SAVED_FEEDBACK_MS = 1600;

const scheduleDraft = { acao: 'desliga', dias: [...ALL_DAYS], favorito: null };
let savedFeedbackTimer = null;
// Dictionary key of the message the save button shows for a moment after a save, so a language change translates it.
let saveFeedback = null;

function sameDays(dias, expected) {
  return dias.length === expected.length && expected.every((day) => dias.includes(day));
}

function daysText(dias) {
  if (sameDays(dias, ALL_DAYS)) return t('schedules.everyDay');
  if (sameDays(dias, WEEKDAY_SET)) return t('schedules.weekdays');
  if (sameDays(dias, WEEKEND_SET)) return t('schedules.weekends');
  return [...dias].sort((a, b) => a - b).map((day) => (ALL_DAYS.includes(day) ? weekdayName(day, 'short') : String(day))).join(', ');
}

function scheduleRow(agenda) {
  const action = scheduleActions().find((item) => item.value === agenda.acao);
  const favorite = settings.favoritos.find((item) => item.id === agenda.favorito);
  const time = formatTimeOfDay(agenda.hora);
  const unit = otherUnitName(agenda.aparelho);
  const toggle = el('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': String(agenda.ativo),
    'aria-label': t('schedules.enableLabel', { time }),
    'data-agenda': agenda.id,
    'data-kind': 'toggle',
  });
  toggle.addEventListener('click', () => {
    refused(window.ac.saveSchedule({ ...agenda, ativo: !agenda.ativo }), 'schedules.saveFailed');
  });
  const remove = el(
    'button',
    {
      type: 'button',
      class: 'icon-button small',
      'aria-label': t('schedules.deleteLabel', { time }),
      title: t('schedules.delete'),
      'data-agenda': agenda.id,
      'data-kind': 'delete',
    },
    iconElement('trash-2'),
  );
  remove.addEventListener('click', () => window.ac.deleteSchedule(agenda.id));
  return el(
    'div',
    { class: 'row schedule-row', 'data-active': String(agenda.ativo) },
    el('strong', { class: 'schedule-time' }, time),
    el(
      'span',
      { class: 'row-text' },
      el('span', { class: 'row-title' }, action?.label ?? agenda.acao),
      el('span', { class: 'row-note' }, daysText(agenda.dias)),
      favorite && el('span', { class: 'row-note' }, t('schedules.withFavorite', { name: favorite.nome })),
      unit && el('span', { class: 'row-note row-unit' }, t('schedules.unit', { name: unit })),
    ),
    toggle,
    remove,
  );
}

function renderScheduleList() {
  const { agendas } = settings;
  const list = byId('schedules-list');
  list.hidden = agendas.length === 0;
  byId('schedules-empty').hidden = agendas.length > 0;
  // Which unit is on screen decides whose name shows, so it is part of what the list is drawn from.
  if (!changed('schedules', [agendas, settings.favoritos.map(({ id, nome }) => [id, nome]), view?.device?.id])) return;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset : null;
  const sorted = [...agendas].sort((a, b) => a.hora.localeCompare(b.hora));
  list.replaceChildren(...sorted.map(scheduleRow));
  if (!focused) return;
  const survivor = list.querySelector(`[data-agenda='${focused.agenda}'][data-kind='${focused.kind}']`);
  (survivor ?? byId('settings-title')).focus();
}

function dayChip(index) {
  const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true' });
  chip.addEventListener('click', () => {
    const selected = scheduleDraft.dias.includes(index);
    const { dias } = scheduleDraft;
    scheduleDraft.dias = selected ? dias.filter((item) => item !== index) : [...dias, index];
    renderScheduleForm();
  });
  return chip;
}

function favoriteChoice(favorite) {
  const attrs = { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-id': favorite.id ?? '' };
  const chip = el('button', attrs, favorite.nome);
  chip.addEventListener('click', () => {
    scheduleDraft.favorito = favorite.id;
    renderScheduleForm();
  });
  return chip;
}

function renderScheduleForm() {
  const days = byId('schedule-days');
  if (days.children.length === 0) days.replaceChildren(...ALL_DAYS.map(dayChip));
  [...days.children].forEach((chip, index) => {
    chip.textContent = weekdayName(index, 'short');
    chip.setAttribute('aria-label', weekdayName(index, 'long'));
    chip.setAttribute('aria-pressed', String(scheduleDraft.dias.includes(index)));
  });
  renderSegmented(byId('schedule-action'), scheduleActions(), scheduleDraft.acao, (value) => {
    scheduleDraft.acao = value;
    renderScheduleForm();
  });
  const { favoritos } = settings;
  if (!favoritos.some((favorite) => favorite.id === scheduleDraft.favorito)) scheduleDraft.favorito = null;
  const row = byId('schedule-favorite-row');
  row.hidden = scheduleDraft.acao !== 'liga' || favoritos.length === 0;
  const choices = byId('schedule-favorites');
  if (changed('schedule-favorites', favoritos.map(({ id, nome }) => [id, nome]))) {
    choices.replaceChildren(...[{ id: null }, ...favoritos].map(favoriteChoice));
  }
  choices.firstElementChild.textContent = t('schedules.favoriteNone');
  for (const chip of choices.children) {
    chip.setAttribute('aria-pressed', String((chip.dataset.id || null) === scheduleDraft.favorito));
  }
  const save = byId('schedule-save');
  save.textContent = saveFeedback ? t(saveFeedback) : t('schedules.add');
  save.disabled = saveFeedback !== null || scheduleDraft.dias.length === 0;
}

function renderSchedulesPage() {
  renderScheduleList();
  renderScheduleForm();
}

// The new row lands above the form, possibly out of sight, so the button itself confirms the save.
function confirmSaved(saved) {
  saveFeedback = saved ? 'schedules.added' : 'schedules.notSaved';
  renderScheduleForm();
  clearTimeout(savedFeedbackTimer);
  savedFeedbackTimer = setTimeout(() => {
    saveFeedback = null;
    renderScheduleForm();
  }, SAVED_FEEDBACK_MS);
}

byId('schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const hora = byId('schedule-time').value;
  if (!/^\d{2}:\d{2}$/.test(hora) || scheduleDraft.dias.length === 0) return;
  const saved = await window.ac.saveSchedule({
    ativo: true,
    hora,
    dias: [...scheduleDraft.dias].sort((a, b) => a - b),
    acao: scheduleDraft.acao,
    favorito: scheduleDraft.acao === 'liga' ? scheduleDraft.favorito : null,
  });
  confirmSaved(saved !== null);
});
