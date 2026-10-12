/* Settings > Consumo: kWh per day and the last 48 h of power, as plain inline SVG. */

const HISTORY_DAYS = 14;
const POWER_WINDOW_MS = 48 * 3_600_000;
// Samples are at least 5 minutes apart; a longer silence means nothing was reporting, so the line breaks there
// instead of interpolating across it.
const POWER_GAP_MS = 30 * 60_000;
const CHART = { width: 316, top: 18, base: 94, labelY: 111 };

let historyToken = 0;
// What the page last drew, so that a language change can draw it again without asking the main process.
let shownHistory = null;

// The empty state's texts are dictionary keys: they stay marked with data-i18n, so a language change translates them.
function showHistory(state, keys) {
  byId('history-loading').hidden = state !== 'loading';
  byId('history-empty').hidden = state !== 'empty';
  byId('history-content').hidden = state !== 'content';
  if (!keys) return;
  for (const [id, key] of [['history-empty-title', keys.title], ['history-empty-text', keys.text]]) {
    byId(id).dataset.i18n = key;
    byId(id).textContent = t(key);
  }
}

async function enterHistoryPage() {
  const token = (historyToken += 1);
  shownHistory = null;
  showHistory('loading');
  try {
    const history = await window.ac.getHistory();
    if (token === historyToken) renderHistory(history);
  } catch {
    if (token !== historyToken) return;
    showHistory('empty', { title: 'history.errorTitle', text: 'history.errorText' });
  }
}

function lastDays(dias, count) {
  const byDay = new Map(dias.map(({ dia, kwh }) => [dia, Number(kwh) || 0]));
  const today = new Date();
  return Array.from({ length: count }, (_unused, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - index));
    return { date, kwh: byDay.get(dayKey(date)) ?? 0 };
  });
}

function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 1.5, 2, 3, 4, 5, 6, 8, 10].find((step) => step * magnitude >= value) * magnitude;
}

function formatDayMonth(date) {
  return date.toLocaleDateString(intlLocale(), { day: '2-digit', month: '2-digit' });
}

function chartFrame(label, topLabel) {
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${CHART.width} 124`, role: 'img', 'aria-label': label });
  svg.append(
    svgEl('line', { class: 'chart-grid', x1: 0, x2: CHART.width, y1: CHART.top, y2: CHART.top }),
    svgEl('line', { class: 'chart-grid', x1: 0, x2: CHART.width, y1: CHART.base, y2: CHART.base }),
    svgEl('text', { class: 'chart-label', x: 0, y: CHART.top - 6 }, topLabel),
  );
  return svg;
}

function chartText(text, x, anchor, extraClass = '') {
  const attrs = { class: `chart-label ${extraClass}`.trim(), x, y: CHART.labelY, 'text-anchor': anchor };
  return svgEl('text', attrs, text);
}

// Rounded data end, square at the baseline; a day without readings keeps a hairline so it reads as empty, not missing.
function barShape(x, width, height) {
  const y = CHART.base - height;
  if (height < 0.5) return svgEl('rect', { class: 'chart-zero', x, y: CHART.base - 1.5, width, height: 1.5 });
  const r = Math.min(4, width / 2, height);
  const right = x + width;
  const d = `M${x} ${CHART.base} V${y + r} Q${x} ${y} ${x + r} ${y} H${right - r} Q${right} ${y} ${right} ${y + r} V${CHART.base} Z`;
  return svgEl('path', { class: 'chart-bar', d });
}

function showReadout(id, date, value) {
  byId(id).replaceChildren(el('span', {}, date), el('strong', {}, value));
}

function renderDaysChart(days) {
  const max = niceMax(Math.max(...days.map((day) => day.kwh)));
  const slot = CHART.width / days.length;
  const barWidth = Math.min(14, slot - 4);
  const label = days.map(({ date, kwh }) => `${formatDayMonth(date)}: ${t('fmt.kwh', { value: formatNumber(kwh, 1) })}`).join('; ');
  const svg = chartFrame(label, t('fmt.kwh', { value: formatNumber(max, max < 10 ? 1 : 0) }));
  days.forEach(({ date, kwh }, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    const isToday = index === days.length - 1;
    const bar = barShape(x, barWidth, (kwh / max) * (CHART.base - CHART.top));
    if (isToday) bar.classList.add('is-today');
    const hit = svgEl('rect', { class: 'chart-hit', x: index * slot, y: 0, width: slot, height: CHART.labelY + 4 });
    hit.addEventListener('mouseenter', () => {
      showReadout('days-readout', formatDayMonth(date), t('fmt.kwh', { value: formatNumber(kwh, 1) }));
    });
    const text = chartText(String(date.getDate()), x + barWidth / 2, 'middle', isToday ? 'is-today' : '');
    svg.append(svgEl('g', { class: 'chart-slot' }, bar, text, hit));
  });
  svg.addEventListener('mouseleave', () => byId('days-readout').replaceChildren());
  byId('chart-days').replaceChildren(svg);
}

function powerSegments(samples) {
  const segments = [];
  for (const sample of samples) {
    const current = segments.at(-1);
    if (current && sample.t - current.at(-1).t <= POWER_GAP_MS) current.push(sample);
    else segments.push([sample]);
  }
  return segments;
}

function powerShapes(segment, x, y) {
  if (segment.length === 1) {
    return [svgEl('circle', { class: 'chart-point', cx: x(segment[0].t), cy: y(segment[0].w), r: 2.5 })];
  }
  const points = segment.map(({ t, w }) => `${x(t).toFixed(1)} ${y(w).toFixed(1)}`);
  const start = x(segment[0].t).toFixed(1);
  const end = x(segment.at(-1).t).toFixed(1);
  return [
    svgEl('path', { class: 'chart-area', d: `M${points.join(' L')} L${end} ${CHART.base} L${start} ${CHART.base} Z` }),
    svgEl('path', { class: 'chart-line', d: `M${points.join(' L')}` }),
  ];
}

function bindPowerReadout(svg, samples, x, since) {
  const guide = svgEl('line', { class: 'chart-guide', x1: 0, x2: 0, y1: CHART.top, y2: CHART.base, visibility: 'hidden' });
  svg.append(guide);
  svg.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const time = since + ((event.clientX - box.left) / box.width) * POWER_WINDOW_MS;
    const nearest = samples.reduce((best, sample) => (Math.abs(sample.t - time) < Math.abs(best.t - time) ? sample : best));
    guide.setAttribute('x1', x(nearest.t));
    guide.setAttribute('x2', x(nearest.t));
    guide.setAttribute('visibility', 'visible');
    const when = new Date(nearest.t).toLocaleString(intlLocale(), {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    showReadout('power-readout', when, t('fmt.watts', { value: formatNumber(nearest.w) }));
  });
  svg.addEventListener('mouseleave', () => {
    guide.setAttribute('visibility', 'hidden');
    byId('power-readout').replaceChildren();
  });
}

function renderPowerChart(allSamples) {
  const now = Date.now();
  const since = now - POWER_WINDOW_MS;
  const samples = allSamples
    .filter(({ t, w }) => t >= since && t <= now && Number.isFinite(w))
    .sort((a, b) => a.t - b.t);
  if (samples.length === 0) {
    byId('chart-power').replaceChildren(el('p', { class: 'chart-empty' }, t('history.noPower')));
    return;
  }
  const max = niceMax(Math.max(...samples.map((sample) => sample.w)));
  const x = (t) => ((t - since) / POWER_WINDOW_MS) * CHART.width;
  const y = (w) => CHART.base - (w / max) * (CHART.base - CHART.top);
  const svg = chartFrame(t('history.power48Label'), t('fmt.watts', { value: formatNumber(max) }));
  for (const segment of powerSegments(samples)) svg.append(...powerShapes(segment, x, y));
  const last = samples.at(-1);
  svg.append(
    chartText(t('history.ago', { hours: 48 }), 0, 'start'),
    chartText(t('history.ago', { hours: 24 }), CHART.width / 2, 'middle'),
    chartText(t('history.now'), CHART.width, 'end'),
    svgEl('circle', { class: 'chart-dot', cx: x(last.t), cy: y(last.w), r: 4 }),
  );
  bindPowerReadout(svg, samples, x, since);
  byId('chart-power').replaceChildren(svg);
}

function renderStat(id, kwh) {
  byId(id).replaceChildren(...(kwh == null ? ['--'] : [formatNumber(kwh, 1), el('small', {}, t('unit.kwh'))]));
}

function renderHistoryLabels() {
  byId('history-total-label').textContent = t('history.lastDays', { days: HISTORY_DAYS });
}

// Draws again what is on screen after a language change.
function refreshHistory() {
  if (shownHistory) renderHistory(shownHistory);
}

function renderHistory(history) {
  shownHistory = history;
  const dias = history?.dias ?? [];
  const amostras = history?.amostras ?? [];
  if (dias.length === 0 && amostras.length === 0) {
    showHistory('empty', { title: 'history.emptyTitle', text: 'history.emptyText' });
    return;
  }
  const days = lastDays(dias, HISTORY_DAYS);
  renderStat('history-today', dias.length > 0 ? days.at(-1).kwh : null);
  renderStat('history-total', dias.length > 0 ? days.reduce((sum, day) => sum + day.kwh, 0) : null);
  if (dias.length > 0) renderDaysChart(days);
  else byId('chart-days').replaceChildren(el('p', { class: 'chart-empty' }, t('history.noDaily')));
  byId('days-readout').replaceChildren();
  byId('power-readout').replaceChildren();
  renderPowerChart(amostras);
  showHistory('content');
}
