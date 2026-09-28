// Forecast page: explore GridToEv's two models on dates from their own datasets.
// Daily (V2) predicts curtailment over a UTC day; short-term (V1) predicts
// half-hour dispatch-down 30 and 60 minutes ahead. The short-term view is organised
// by target half-hour, so a target always stays on its own day even when its
// forecast was issued the previous evening.
const fx = {
  model: 'daily',
  picker: null, // {month:'YYYY-MM'} while the date picker is open
  caveatsOpen: { daily: true, short: false }, // survives re-renders
  daily: { info: null, infoLoading: false, infoError: '', date: null, result: null, loading: false, error: '', week: null, weekLoading: false },
  short: { info: null, infoLoading: false, infoError: '', date: null, target: null, result: null, loading: false, error: '', day: null, dayLoading: false, horizon: 30, targets: null, byDate: null, issueSet: null },
};
try { if (localStorage.getItem('forecast-model') === 'short') fx.model = 'short'; } catch {}
const fxTokens = { daily: 0, short: 0, week: 0, day: 0 };
const fxChevron = (dir) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir === 'left' ? 'm15 5-7 7 7 7' : dir === 'right' ? 'm9 5 7 7-7 7' : 'm6 9 6 6 6-6'}"/></svg>`;
const fxPartitions = {
  train: ['Train', 'Seen while fitting · in-sample'],
  validation: ['Validation', 'Used to choose settings'],
  test: ['Test', 'Held out · honest accuracy'],
};

// ---------------------------------------------------------------- formatting (all UTC)
function fxDateLabel(day, style = 'long') {
  const options = style === 'long' ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', ...options }).format(new Date(`${day}T00:00:00Z`));
}
function fxClock(stamp) { return stamp.slice(11, 16); }
function fxShift(stamp, minutes) { return new Date(Date.parse(stamp) + minutes * 6e4).toISOString().replace('.000Z', 'Z'); }
// Issue time relative to the target's day, e.g. "23:30 prev. day" for a 00:00 target.
function fxIssueLabel(issue, day) { return issue.slice(0, 10) === day ? fxClock(issue) : `${fxClock(issue)} prev. day`; }
function fxMonthLabel(month) { return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T00:00:00Z`)); }
function fxShiftMonth(month, delta) { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); }
function fxAddDays(day, delta) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); }
function fxMwh(value) { return value === null || value === undefined ? '—' : n(value); }
function fxPercent(value, digits = 0) { return value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`; }
function fxPartitionOf(stamp, partitions) {
  for (const name of ['train', 'validation', 'test']) { const p = partitions?.[name]; if (p && p.from <= stamp && stamp <= p.to) return name; }
  return null;
}

// ---------------------------------------------------------------- data
async function fxGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(path, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'The model request failed.');
    return body;
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? 'The model took too long to answer. A sleeping hosted service can take a minute to wake — please retry.' : error.message);
  } finally { clearTimeout(timer); }
}
function fxRerender() { if (pageFromHash() === 'forecast') render(); }

async function fxLoadInfo(kind) {
  const s = fx[kind];
  if (s.info || s.infoLoading) return;
  s.infoLoading = true; s.infoError = ''; fxRerender();
  try {
    s.info = await fxGet(`/api/v1/explorer/${kind === 'daily' ? 'daily' : 'short-term'}`);
    if (kind === 'short') {
      // A target is selectable when the dataset has its +30 or +60 minute issue time.
      s.issueSet = new Set(s.info.times);
      s.targets = [...new Set(s.info.times.flatMap((t) => [fxShift(t, 30), fxShift(t, 60)]))].sort();
      s.byDate = new Map();
      for (const t of s.targets) { const d = t.slice(0, 10); if (!s.byDate.has(d)) s.byDate.set(d, []); s.byDate.get(d).push(t); }
    }
  } catch (error) { s.infoError = error.message; }
  s.infoLoading = false;
  if (s.info && kind === 'daily') fxSelectDaily(s.info.dataset.to);
  else if (s.info) {
    // Default to midday on the latest day where all 48 targets have both forecasts (held-out test split).
    const both = (t) => s.issueSet.has(fxShift(t, -30)) && s.issueSet.has(fxShift(t, -60));
    const full = [...s.byDate.keys()].filter((d) => s.byDate.get(d).length === 48 && s.byDate.get(d).every(both)).at(-1);
    const noon = `${full}T12:00:00Z`;
    fxSelectShort(s.byDate.get(full)?.includes(noon) ? noon : s.targets.at(-1));
  }
  else fxRerender();
}

// keepWeek: a day clicked on the week chart only updates the details; any other
// selection (calendar, shortcuts) starts a new week on the chosen day.
async function fxSelectDaily(day, keepWeek = false) {
  const s = fx.daily, token = ++fxTokens.daily;
  const inWeek = Boolean(s.week?.days.some((d) => d.date === day));
  const weekChanged = keepWeek ? !inWeek : s.week?.days[0]?.date !== day;
  s.date = day; s.loading = true; s.error = ''; fxRerender();
  if (weekChanged) fxLoadWeek(day);
  else s.week = { ...s.week, selected: day };
  try { const result = await fxGet(`/api/v1/explorer/daily/predict?date=${day}`); if (token === fxTokens.daily) s.result = result; }
  catch (error) { if (token === fxTokens.daily) { s.error = error.message; s.result = null; } }
  if (token === fxTokens.daily) { s.loading = false; fxRerender(); }
}
async function fxLoadWeek(day) {
  const s = fx.daily, token = ++fxTokens.week;
  s.weekLoading = true; fxRerender();
  try { const week = await fxGet(`/api/v1/explorer/daily/week?date=${day}`); if (token === fxTokens.week) s.week = week; }
  catch { if (token === fxTokens.week) s.week = null; }
  if (token === fxTokens.week) { s.weekLoading = false; fxRerender(); }
}

async function fxSelectShort(target) {
  const s = fx.short, token = ++fxTokens.short, day = target.slice(0, 10);
  s.target = target; s.date = day; s.loading = true; s.error = ''; fxRerender();
  if (s.day?.date !== day) fxLoadDay(day);
  try {
    const result = await fxGet(`/api/v1/explorer/short-term/predict?target=${encodeURIComponent(target)}&capacityMw=${modelState.capacity}`);
    if (token === fxTokens.short) s.result = result;
  } catch (error) { if (token === fxTokens.short) { s.error = error.message; s.result = null; } }
  if (token === fxTokens.short) { s.loading = false; fxRerender(); }
}
async function fxLoadDay(day) {
  const s = fx.short, token = ++fxTokens.day;
  s.day = { date: day, points: null }; s.dayLoading = true; fxRerender();
  try { const replay = await fxGet(`/api/v1/explorer/short-term/day?date=${day}`); if (token === fxTokens.day) s.day = replay; }
  catch { if (token === fxTokens.day) s.day = { date: day, points: null, failed: true }; }
  if (token === fxTokens.day) { s.dayLoading = false; fxRerender(); }
}

// Step to the previous/next selectable target without opening the picker.
function fxStep(delta) {
  if (fx.model === 'daily') {
    const s = fx.daily, next = fxAddDays(s.date, delta);
    if (s.info && next >= s.info.dataset.from && next <= s.info.dataset.to) fxSelectDaily(next, true);
  } else {
    const s = fx.short, i = s.targets.indexOf(s.target) + delta;
    if (i >= 0 && i < s.targets.length) fxSelectShort(s.targets[i]);
  }
}

// The issue time that colours a target's train/validation/test dot: its +30 issue, else +60.
function fxShortIssue(target) { const s = fx.short, i30 = fxShift(target, -30); return s.issueSet.has(i30) ? i30 : fxShift(target, -60); }

// ---------------------------------------------------------------- date picker
function fxPickerButton() {
  const daily = fx.model === 'daily', s = fx[fx.model];
  const value = daily ? (s.date ? fxDateLabel(s.date) : 'Choose a day') : (s.target ? `${fxDateLabel(s.date)} · ${fxClock(s.target)}` : 'Choose a time');
  const open = Boolean(fx.picker);
  const atStart = daily ? s.date === s.info?.dataset.from : s.target === s.targets?.[0];
  const atEnd = daily ? s.date === s.info?.dataset.to : s.target === s.targets?.at(-1);
  return `<div class="fx-target">
    <button type="button" class="fx-step" data-fx-step="-1" aria-label="Previous ${daily ? 'day' : 'half-hour'}" ${!s.info || atStart ? 'disabled' : ''}>${fxChevron('left')}</button>
    <div class="fx-picker-anchor">
      <button type="button" class="fx-date-button ${open ? 'is-open' : ''}" data-fx-picker aria-haspopup="dialog" aria-expanded="${open}" ${s.info ? '' : 'disabled'}>
        <span class="fx-date-icon">${icon(daily ? 'calendar' : 'clock', 19)}</span>
        <span class="fx-date-text"><small>${daily ? 'Target day · UTC' : 'Target half-hour · UTC'}</small><strong>${escapeHtml(value)}</strong></span>
        <span class="fx-date-chevron">${fxChevron('down')}</span>
      </button>
      ${open ? fxPicker() : ''}
    </div>
    <button type="button" class="fx-step" data-fx-step="1" aria-label="Next ${daily ? 'day' : 'half-hour'}" ${!s.info || atEnd ? 'disabled' : ''}>${fxChevron('right')}</button>
  </div>`;
}

function fxPicker() {
  const daily = fx.model === 'daily', s = fx[fx.model], info = s.info;
  const first = daily ? info.dataset.from : s.targets[0].slice(0, 10);
  const last = daily ? info.dataset.to : s.targets.at(-1).slice(0, 10);
  const partitions = daily ? info.dataset.partitions : info.model.partitions;
  const month = fx.picker.month;
  const [y, m] = month.split('-').map(Number);
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const selected = s.date;
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<span class="fx-cal-blank"></span>');
  for (let d = 1; d <= days; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    const available = daily ? day >= first && day <= last : s.byDate.has(day);
    const partition = available ? fxPartitionOf(daily ? day : fxShortIssue(s.byDate.get(day)[0]), partitions) : null;
    cells.push(`<button type="button" class="fx-cal-day ${day === selected ? 'is-selected' : ''} ${partition ? `is-${partition}` : ''}" ${available ? `data-fx-day="${day}"` : 'disabled'} aria-label="${fxDateLabel(day)}${available ? '' : ' (not in dataset)'}" ${day === selected ? 'aria-pressed="true"' : ''}>${d}<i></i></button>`);
  }
  const years = [];
  for (let year = Number(first.slice(0, 4)); year <= Number(last.slice(0, 4)); year++) years.push(year);
  const yearChips = years.length > 1 ? `<div class="fx-cal-years">${years.map((year) => `<button type="button" class="${year === y ? 'is-active' : ''}" data-fx-year="${year}">${year}</button>`).join('')}</div>` : '';
  const canPrev = fxShiftMonth(month, -1) >= first.slice(0, 7), canNext = fxShiftMonth(month, 1) <= last.slice(0, 7);
  const count = daily ? `${n(info.dataset.count)} complete days` : `${n(s.targets.length)} target half-hours`;
  const calendar = `<div class="fx-cal">
      <div class="fx-cal-nav"><button type="button" data-fx-month="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">${fxChevron('left')}</button><strong>${fxMonthLabel(month)}</strong><button type="button" data-fx-month="1" ${canNext ? '' : 'disabled'} aria-label="Next month">${fxChevron('right')}</button></div>
      ${yearChips}
      <div class="fx-cal-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<span class="fx-cal-week">${w}</span>`).join('')}${cells.join('')}</div>
      <div class="fx-cal-legend">${Object.entries(fxPartitions).map(([key, [label]]) => `<span><i class="is-${key}"></i>${label}</span>`).join('')}</div>
    </div>`;
  let times = '';
  if (!daily) {
    const available = new Set(s.byDate.get(s.date) || []);
    const slots = Array.from({ length: 48 }, (_, i) => `${s.date}T${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00Z`);
    times = `<div class="fx-times"><div class="fx-times-head"><strong>${fxDateLabel(s.date)}</strong><span>${available.size} of 48 half-hours available</span></div><div class="fx-times-grid">${slots.map((t) => {
      const ok = available.has(t), partition = ok ? fxPartitionOf(fxShortIssue(t), info.model.partitions) : null;
      return `<button type="button" class="fx-time ${t === s.target ? 'is-selected' : ''} ${partition ? `is-${partition}` : ''}" ${ok ? `data-fx-target="${t}"` : 'disabled'}>${fxClock(t)}</button>`;
    }).join('')}</div><p>Each half-hour gets a +30 min forecast (issued 30 min before) and a +60 min one (issued 60 min before). Greyed-out slots have no forecast in the dataset.</p></div>`;
  }
  const quick = [['first', 'Earliest'], ['last', 'Latest'], ['random', 'Surprise me']];
  return `<div class="fx-popover ${daily ? '' : 'is-wide'}" role="dialog" aria-label="Choose a target ${daily ? 'day' : 'half-hour'}">
    <div class="fx-popover-head"><div><strong>${daily ? 'Pick a target day' : 'Pick a target half-hour'}</strong><span>Dataset: ${fxDateLabel(first, 'short')} – ${fxDateLabel(last, 'short')} · ${count}</span></div><button type="button" class="fx-close" data-fx-close aria-label="Close">×</button></div>
    <div class="fx-popover-body">${calendar}${times}</div>
    <div class="fx-popover-foot">${quick.map(([key, label]) => `<button type="button" data-fx-quick="${key}">${label}</button>`).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- charts
function fxWeekChart() {
  const s = fx.daily;
  if (!s.week) return `<div class="fx-chart-empty">${s.weekLoading ? '<span class="studio-spinner"></span>Loading the week…' : 'Week context unavailable.'}</div>`;
  const days = s.week.days, W = 720, H = 270, top = 42, base = 222, left = 58;
  const max = Math.max(1, ...days.map((d) => Math.max(d.predictedMwh, d.actual.curtailmentMwh ?? 0))) * 1.08;
  const y = (v) => base - (v / max) * (base - top);
  const step = (W - left - 10) / days.length;
  const grid = [0, 0.5, 1].map((f) => `<line class="fx-gridline" x1="${left}" x2="${W - 10}" y1="${y(max * f)}" y2="${y(max * f)}"/><text class="fx-axis" x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${n(Math.round(max * f))}</text>`).join('');
  const bars = days.map((d, i) => {
    const x = left + i * step, w = Math.min(26, step / 3.4), cx = x + step / 2, sel = d.date === s.date;
    const actual = d.actual.curtailmentMwh;
    return `<g class="fx-week-day ${sel ? 'is-selected' : ''}" data-fx-day="${d.date}" data-fx-in-week role="button" tabindex="0" aria-label="${fxDateLabel(d.date)}: predicted ${n(d.predictedMwh)} MWh, observed ${fxMwh(actual)} MWh">
      <rect class="fx-week-hit" x="${x + 3}" y="8" width="${step - 6}" height="${H - 12}" rx="14"/>
      <text class="fx-prob" x="${cx}" y="30" text-anchor="middle">${fxPercent(d.probability)}</text>
      <rect class="fx-bar-pred" x="${cx - w - 2}" y="${y(d.predictedMwh)}" width="${w}" height="${base - y(d.predictedMwh)}" rx="5"/>
      ${actual === null ? `<text class="fx-axis" x="${cx + w / 2 + 2}" y="${base - 6}" text-anchor="middle">?</text>` : `<rect class="fx-bar-actual" x="${cx + 2}" y="${y(actual)}" width="${w}" height="${base - y(actual)}" rx="5"/>`}
      <text class="fx-day-label" x="${cx}" y="${base + 20}" text-anchor="middle">${new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${d.date}T00:00:00Z`))}</text>
      <text class="fx-axis" x="${cx}" y="${base + 36}" text-anchor="middle">${fxDateLabel(d.date, 'short').replace(/ \d{4}$/, '')}</text>
    </g>`;
  }).join('');
  return `<svg class="fx-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted versus observed curtailment for the selected week"><text class="fx-axis" x="8" y="14">MWh / day</text>${grid}${bars}</svg>`;
}

function fxDayChart() {
  const s = fx.short, h = s.horizon;
  if (!s.day?.points) return `<div class="fx-chart-empty">${s.dayLoading ? '<span class="studio-spinner"></span>Replaying every half-hour of this day… (can take ~15 s)' : 'Day replay unavailable.'}</div>`;
  const pts = s.day.points.filter((p) => p.horizonMinutes === h).sort((a, b) => a.targetAt.localeCompare(b.targetAt));
  if (!pts.length) return '<div class="fx-chart-empty">No replay points for this horizon.</div>';
  // The x-axis is the day's 48 target half-hours (00:00-23:30 UTC); observed values cover every slot.
  const observed = (s.day.observed || []).filter((o) => o.actualMwh !== null);
  const W = 720, H = 270, left = 52, right = 12, top = 18, base = 228;
  const start = Date.parse(`${s.day.date}T00:00:00Z`);
  const x = (stamp) => left + ((Date.parse(stamp) - start) / 18e5 / 47) * (W - left - right);
  const max = Math.max(1, ...pts.map((p) => p.upperMwh), ...observed.map((o) => o.actualMwh)) * 1.08;
  const y = (v) => base - (v / max) * (base - top);
  // Split into gap-free runs so lines and bands never bridge half-hours missing from the dataset.
  const runsOf = (rows) => { const runs = []; rows.forEach((p, i) => { if (!i || Date.parse(p.targetAt) - Date.parse(rows[i - 1].targetAt) > 18e5) runs.push([]); runs.at(-1).push(p); }); return runs; };
  const runs = runsOf(pts);
  const path = (rows, key) => runsOf(rows).map((run) => run.map((p, i) => `${i ? 'L' : 'M'}${x(p.targetAt).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ')).join(' ');
  const band = runs.map((run) => `M${run.map((p) => `${x(p.targetAt).toFixed(1)} ${y(p.upperMwh).toFixed(1)}`).join(' L')} L${run.slice().reverse().map((p) => `${x(p.targetAt).toFixed(1)} ${y(p.lowerMwh).toFixed(1)}`).join(' L')} Z`).join(' ');
  const grid = [0, 0.5, 1].map((f) => `<line class="fx-gridline" x1="${left}" x2="${W - right}" y1="${y(max * f)}" y2="${y(max * f)}"/><text class="fx-axis" x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${n(Math.round(max * f))}</text>`).join('');
  const hours = ['00:00', '06:00', '12:00', '18:00', '23:30'].map((clock) => `<text class="fx-axis" x="${x(`${s.day.date}T${clock}:00Z`)}" y="${base + 20}" text-anchor="middle">${clock}</text>`).join('');
  const selected = pts.find((p) => p.targetAt === s.target);
  const marker = s.target?.startsWith(s.day.date) ? `<line class="fx-marker" x1="${x(s.target)}" x2="${x(s.target)}" y1="${top - 6}" y2="${base}"/>${selected ? `<circle class="fx-marker-dot" cx="${x(s.target)}" cy="${y(selected.atRiskMwh)}" r="6"/>` : ''}` : '';
  const hitW = (W - left - right) / 47;
  const hits = pts.map((p) => `<rect class="fx-hit" data-fx-target="${p.targetAt}" x="${x(p.targetAt) - hitW / 2}" y="${top}" width="${hitW}" height="${base - top}"><title>Issued ${fxIssueLabel(p.issuedAt, s.day.date)} → target ${fxClock(p.targetAt)} UTC · predicted ${n(p.atRiskMwh)} MWh · observed ${fxMwh(p.actualMwh)} MWh</title></rect>`).join('');
  const actualDots = observed.map((o) => `<circle class="fx-actual-dot" cx="${x(o.targetAt).toFixed(1)}" cy="${y(o.actualMwh).toFixed(1)}" r="2.4"/>`).join('');
  return `<svg class="fx-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted and observed dispatch-down for each target half-hour of ${fxDateLabel(s.day.date)}, ${h} minutes ahead"><text class="fx-axis" x="8" y="12">MWh / half-hour</text>${grid}${settings.uncertainty ? `<path class="fx-band" d="${band}"/>` : ''}<path class="fx-line-pred" d="${path(pts, 'atRiskMwh')}"/><path class="fx-line-actual" d="${path(observed, 'actualMwh')}"/>${actualDots}${marker}${hours}${hits}</svg>`;
}

// ---------------------------------------------------------------- model information
function fxTimeline(partitions, format) {
  const order = ['train', 'validation', 'test'].filter((k) => partitions[k]);
  const total = order.reduce((sum, k) => sum + partitions[k].rows, 0);
  return `<div class="fx-timeline">${order.map((k) => `<div class="is-${k}" style="flex:${partitions[k].rows / total}"><b>${fxPartitions[k][0]}</b><span>${format(partitions[k].from)} – ${format(partitions[k].to)}</span><em>${n(partitions[k].rows)} rows</em></div>`).join('')}</div>`;
}
function fxInfoTile(title, body, wide = '') { return `<div class="fx-info-tile ${wide}"><h3>${title}</h3>${body}</div>`; }
function fxScore(label, value, compare) { return `<div class="fx-score"><span>${label}</span><strong>${value}</strong>${compare ? `<em>${compare}</em>` : ''}</div>`; }

function fxDailyInfo() {
  const { model, dataset } = fx.daily.info, t = model.test;
  const gain = t.zeroBaselineMaeMwh ? 1 - t.dailyMaeMwh / t.zeroBaselineMaeMwh : null;
  const regions = ['West · Galway', 'South · Cork', 'East · Dublin', 'North · Belfast'];
  return `<section class="dash-card fx-info-card">${cardHead('pulse', 'blue', `About the daily model <span class="fx-badge">v${escapeHtml(model.version)}</span>${model.experimental ? '<span class="fx-badge is-amber">Experimental</span>' : ''}`, 'What it predicts, what it looks at and how well it did on unseen days')}
    <div class="fx-info-grid">
      ${fxInfoTile('What it predicts', `<p>The chance that <b>any curtailment</b> happens in Ireland on a UTC day, and the <b>total MWh</b> curtailed. It is issued at 00:00 UTC using the previous day's weather forecast — one number for the whole day, not hourly.</p>`)}
      ${fxInfoTile('What it looks at', `<p>${model.features.length} features from day-ahead weather forecasts: wind speed (mean, max, P75), solar radiation and temperature in four regions, plus season and weekend.</p><div class="fx-chips">${regions.map((r) => `<span>${r}</span>`).join('')}</div>`)}
      ${fxInfoTile(`Accuracy on ${n(t.rows)} held-out days`, `<div class="fx-scores">${fxScore('Event ROC AUC', t.rocAuc?.toFixed(2), '0.5 = coin flip')}${fxScore('Avg. precision', t.eventAveragePrecision?.toFixed(2), `base rate ${fxPercent(t.eventRate)}`)}${fxScore('Daily MAE', `${n(Math.round(t.dailyMaeMwh))} MWh`, gain !== null ? `${fxPercent(gain)} better than guessing zero` : '')}</div>`)}
      ${fxInfoTile('Training timeline', `${fxTimeline(dataset.partitions, (d) => fxDateLabel(d, 'short'))}<p class="fx-fine">Fitted through ${fxDateLabel(model.trainedThrough || dataset.fittedThrough, 'short')}. Pick a <b class="fx-t-test">test</b> day for an honest check against reality.</p>`, 'is-wide')}
      ${fxCaveats(model.caveats, 'daily')}
    </div></section>`;
}

function fxShortInfo() {
  const { model, dataset } = fx.short.info, t = model.test;
  const mlOff = Object.values(model.mlWeightByHorizon || {}).every((w) => w === 0);
  return `<section class="dash-card fx-info-card">${cardHead('pulse', 'blue', `About the short-term model <span class="fx-badge">v${escapeHtml(model.version)}</span>`, 'What it predicts, how the number is produced and how well it did on unseen half-hours')}
    <div class="fx-info-grid">
      ${fxInfoTile('What it predicts', `<p><b>Dispatch-down</b> — renewable energy turned down for grid <b>constraints</b> or system-wide <b>curtailment</b> — in one half-hour, <b>30 or 60 minutes</b> after the issue time. It also gives the event probability and a P10–P90 range.</p>`)}
      ${fxInfoTile('How the number is made', `<p>${n(model.featureCount)} live grid signals (ENTSO-E generation, load and price; EirGrid wind, solar, SNSP and interconnectors, plus lags and rolling stats) feed ${model.estimators.length} gradient-boosted models.</p>${mlOff ? '<p class="fx-fine">The MWh estimate currently comes from a tuned <b>trend baseline</b> (ML blend weight 0); the ML models supply the probability, split and range.</p>' : ''}`)}
      ${fxInfoTile(`Accuracy on ${n(t.rows)} held-out half-hours`, `<div class="fx-scores">${fxScore('MAE', `${t.maeMwh?.toFixed(1)} MWh`, `vs ${t.latestObservationMaeMwh?.toFixed(1)} repeating last value`)}${fxScore('Event F1', t.eventF1?.toFixed(2), `threshold ${model.classificationThreshold}`)}${fxScore('P10–P90 coverage', fxPercent(t.intervalCoverage), 'target 80%')}</div>`)}
      ${fxInfoTile('Training timeline', `${fxTimeline(model.partitions, (d) => `${fxDateLabel(d.slice(0, 10), 'short').replace(/ \d{4}$/, '')} ${fxClock(d)}`)}<p class="fx-fine">Dataset covers ${fxDateLabel(dataset.from.slice(0, 10), 'short')} – ${fxDateLabel(dataset.to.slice(0, 10), 'short')} (January 2026). It is a replay of history, not a live feed.</p>`, 'is-wide')}
      ${fxCaveats(model.caveats, 'short')}
    </div></section>`;
}

function fxCaveats(caveats, kind) {
  if (!caveats?.length) return '';
  return `<details class="fx-info-tile is-wide fx-caveats" data-fx-caveats="${kind}" ${fx.caveatsOpen[kind] ? 'open' : ''}><summary><h3>Caveats from the model's own report <span>${caveats.length}</span></h3></summary><ul>${caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></details>`;
}

// Every Forecast result is a replay of the real model on archived inputs, never a live forecast
// and never the Dashboard's simulated fallback, so each view says so explicitly.
function fxReplayNote(kind) {
  const text = kind === 'daily'
    ? 'The GridToEv daily model was re-run for this past date using the weather forecast archived for it, then compared with what EirGrid observed. It is not a forecast of the future.'
    : 'The GridToEv short-term model was re-run on archived grid data for this past half-hour, then compared with what EirGrid observed. It is not a live forecast.';
  return `<p class="fx-replay-note" role="note"><b>${icon('clock', 15)} Historical replay</b><span>${text}</span></p>`;
}

// ---------------------------------------------------------------- views
function fxPartitionMetric(partition) {
  const [label, note] = fxPartitions[partition] || ['—', 'Outside the modelling splits'];
  return metric('Data split', label, '', note, partition === 'test' ? 'green' : '');
}
function fxErrorCard(message, retry) { return `<section class="dash-card studio-message" role="alert"><h2>Prediction unavailable</h2><p>${escapeHtml(message)}</p><button class="studio-button" type="button" data-fx-retry="${retry}">Try again ${icon('arrow', 17)}</button></section>`; }
function fxWaiting(text) { return `<section class="dash-card studio-message" role="status"><span class="studio-spinner"></span><h2>${text}</h2><p>Talking to the GridToEv model service. A sleeping hosted service can take up to a minute to wake.</p></section>`; }

function fxDailyView() {
  const s = fx.daily;
  if (s.infoError) return fxErrorCard(s.infoError, 'info');
  if (!s.info) return fxWaiting('Loading the daily model');
  if (s.error && !s.result) return fxErrorCard(s.error, 'daily');
  if (!s.result) return fxWaiting('Predicting the selected day');
  const r = s.result, a = r.actual, likely = r.probability >= 0.5;
  const observed = a.curtailmentMwh === null
    ? metric('Observed (EirGrid)', a.status === 'pending' ? 'Pending' : 'Missing', '', 'No complete observation yet')
    : metric('Observed (EirGrid)', n(Math.round(a.curtailmentMwh)), 'MWh', `Model was ${n(Math.round(Math.abs(r.predictedMwh - a.curtailmentMwh)))} MWh ${r.predictedMwh > a.curtailmentMwh ? 'high' : 'low'}`, 'green');
  const gaugeR = 62, circ = Math.PI * gaugeR;
  return `<div class="fx-content ${s.loading ? 'is-loading' : ''}">
    ${fxReplayNote('daily')}
    ${statStrip([
      metric('Curtailment probability', n(Math.round(r.probability * 100)), '%', likely ? 'Curtailment likely on this day' : 'Curtailment unlikely on this day', 'amber'),
      metric('Predicted curtailment', n(Math.round(r.predictedMwh)), 'MWh', 'Total over the UTC day'),
      observed,
      fxPartitionMetric(r.partition),
    ])}
    <div class="studio-page-grid fx-grid">
      <section class="dash-card studio-chart-card">${cardHead('forecast', 'amber', 'Your week ahead', 'Renewable energy curtailed per day (MWh), predicted vs observed, for your day and the six after it · click a bar to see that day')}
        <div class="fx-legend"><span><i class="is-pred"></i>Predicted</span><span><i class="is-actual"></i>Observed</span><span><i class="is-prob"></i>% = chance of any curtailment that day</span></div>
        <div class="fx-chart-wrap">${fxWeekChart()}</div></section>
      <section class="dash-card studio-side-card">${cardHead('calendar', 'green', fxDateLabel(r.date), 'The day you picked: predicted vs observed curtailment')}
        <div class="fx-gauge"><svg viewBox="0 0 160 92" aria-hidden="true"><path class="fx-gauge-track" d="M18 82 A62 62 0 0 1 142 82"/><path class="fx-gauge-fill" d="M18 82 A62 62 0 0 1 142 82" stroke-dasharray="${circ * r.probability} ${circ}"/></svg><div><strong>${fxPercent(r.probability)}</strong><span>chance of curtailment</span></div></div>
        <div class="fx-verdict ${a.event === null || a.event === undefined ? '' : a.event === likely ? 'is-right' : 'is-wrong'}">${a.event === null || a.event === undefined ? 'Outcome not observed yet' : `${a.event ? 'Curtailment did happen' : 'No curtailment happened'} — the model ${a.event === likely ? 'called it' : 'missed it'}`}</div>
        <div class="studio-balance"><div><i class="is-amber"></i><span>Predicted total</span><strong>${n(Math.round(r.predictedMwh))} MWh</strong></div><div><i class="is-green"></i><span>Observed total</span><strong>${fxMwh(a.curtailmentMwh === null ? null : Math.round(a.curtailmentMwh))} MWh</strong></div></div>
        <p class="studio-note">Issued ${escapeHtml((r.issuedAt || '').slice(11, 16))} UTC from weather forecasts published by ${escapeHtml(fxClock(r.weatherAvailableAt || 'T00:00'))} UTC the day before. MWh is probability × likely size, so it runs low on big days.</p>
      </section>
    </div>
    ${fxDailyInfo()}
  </div>`;
}

function fxShortView() {
  const s = fx.short;
  if (s.infoError) return fxErrorCard(s.infoError, 'info');
  if (!s.info) return fxWaiting('Loading the short-term model');
  if (s.error && !s.result) return fxErrorCard(s.error, 'short');
  if (!s.result) return fxWaiting('Predicting the selected half-hour');
  const r = s.result, preds = r.predictions;
  const p = preds.find((x) => x.horizonMinutes === s.horizon) || preds[0];
  const horizonMetric = (h) => {
    const x = preds.find((q) => q.horizonMinutes === h);
    return x ? metric(`+${h} min forecast`, n(Math.round(x.atRiskMwh * 10) / 10), 'MWh', `${fxPercent(x.probability, 1)} event chance · issued ${fxIssueLabel(x.issuedAt, s.date)}`, h === s.horizon ? 'amber' : '') : metric(`+${h} min forecast`, '—', '', 'No dataset issue time for this target');
  };
  const actual = r.actual?.dispatchDownMwh;
  const range = Math.max(p.upperMwh, actual ?? 0, p.atRiskMwh, 1) * 1.05;
  const pos = (v) => `${Math.min(100, (v / range) * 100)}%`;
  return `<div class="fx-content ${s.loading ? 'is-loading' : ''}">
    ${fxReplayNote('short')}
    ${statStrip([
      horizonMetric(30),
      horizonMetric(60),
      actual === null || actual === undefined ? metric('Observed at target', r.actual?.status === 'pending' ? 'Pending' : '—', '', 'No observation available') : metric(`Observed at ${fxClock(r.targetAt)}`, n(Math.round(actual * 10) / 10), 'MWh', `+${p.horizonMinutes} min forecast was ${n(Math.round(Math.abs(p.atRiskMwh - actual) * 10) / 10)} MWh ${p.atRiskMwh > actual ? 'high' : 'low'}`, 'green'),
      fxPartitionMetric(p.partition),
    ])}
    <div class="studio-page-grid fx-grid">
      <section class="dash-card studio-chart-card">${cardHead('forecast', 'amber', `Day replay · ${fxDateLabel(s.date)}`, 'Renewable energy switched off in each half-hour (MWh), forecast vs what actually happened · click the chart to pick a half-hour', `<div class="studio-segment fx-horizon" role="group" aria-label="Chart horizon"><button type="button" data-fx-horizon="30" class="${s.horizon === 30 ? 'active' : ''}">+30 min</button><button type="button" data-fx-horizon="60" class="${s.horizon === 60 ? 'active' : ''}">+60 min</button></div>`)}
        <div class="fx-legend"><span><i class="is-pred"></i>Predicted</span><span><i class="is-actual"></i>Observed</span>${settings.uncertainty ? '<span><i class="is-band"></i>Likely range (P10–P90)</span>' : ''}<span><i class="is-marker"></i>Selected half-hour</span></div>
        <div class="fx-chart-wrap">${fxDayChart()}</div></section>
      <section class="dash-card studio-side-card">${cardHead('clock', 'green', `+${p.horizonMinutes} min forecast`, `Made ${fxIssueLabel(p.issuedAt, s.date)} for the half-hour at ${fxClock(p.targetAt)} UTC`, `<span class="fx-risk is-${escapeHtml(p.risk)}">${escapeHtml(p.risk)} risk</span>`)}
        <div class="fx-range"><div class="fx-range-head"><span>Prediction range</span><b>${n(Math.round(p.lowerMwh))}–${n(Math.round(p.upperMwh))} MWh</b></div>
          <div class="fx-range-track"><span class="fx-range-band" style="left:${pos(p.lowerMwh)};width:calc(${pos(p.upperMwh)} - ${pos(p.lowerMwh)})"></span><span class="fx-range-point" style="left:${pos(p.atRiskMwh)}" title="Predicted"></span>${actual === null || actual === undefined ? '' : `<span class="fx-range-actual" style="left:${pos(actual)}" title="Observed"></span>`}</div>
          <div class="fx-range-key"><span><i class="is-pred"></i>Predicted ${n(Math.round(p.atRiskMwh * 10) / 10)}</span>${actual === null || actual === undefined ? '' : `<span><i class="is-actual"></i>Observed ${n(Math.round(actual * 10) / 10)}</span>`}<span><i class="is-band"></i>P10–P90</span></div></div>
        <div class="studio-component"><div><span>Grid constraint</span><b>${n(Math.round(p.constraintMwh * 10) / 10)} MWh</b></div><progress max="${Math.max(p.atRiskMwh, 0.001)}" value="${p.constraintMwh}"></progress></div>
        <div class="studio-component"><div><span>Curtailment</span><b>${n(Math.round(p.curtailmentMwh * 10) / 10)} MWh</b></div><progress max="${Math.max(p.atRiskMwh, 0.001)}" value="${p.curtailmentMwh}"></progress></div>
        <div class="studio-side-number"><span>Absorbable with ${n(r.capacityMw)} MW flexible load</span><strong>${n(Math.round(p.recoverableMwh * 10) / 10)} MWh</strong><small>min(predicted energy, capacity × 0.5 h) · set capacity on the Dashboard</small></div>
      </section>
    </div>
    ${fxShortInfo()}
  </div>`;
}

function renderForecast() {
  const s = fx[fx.model];
  if (!s.info && !s.infoLoading && !s.infoError) queueMicrotask(() => fxLoadInfo(fx.model));
  const busy = s.loading || s.infoLoading;
  const tab = (key, title, sub, glyph) => `<button type="button" role="tab" aria-selected="${fx.model === key}" class="fx-tab ${fx.model === key ? 'active' : ''}" data-fx-model="${key}"><span class="fx-tab-icon">${icon(glyph, 18)}</span><span><strong>${title}</strong><small>${sub}</small></span></button>`;
  return `${studioHeader('Forecast', 'Pick a model and a target from its dataset to see what it predicts — and what actually happened.')}
  <div class="studio-toolbar fx-toolbar">
    <div class="fx-tabs" role="tablist" aria-label="Forecast model">${tab('daily', 'Daily curtailment', 'V2 · whole UTC day', 'calendar')}${tab('short', 'Short-term', 'V1 · +30 & +60 min', 'clock')}</div>
    ${fxPickerButton()}
    <span class="fx-status ${busy ? 'is-busy' : ''}" role="status">${busy ? '<span class="fx-dot-spin"></span>Predicting…' : s.result ? `${icon('clock', 16)} Historical replay · model v${escapeHtml((s.result.modelVersion || '').replace(/^v/, ''))}` : ''}</span>
  </div>
  ${fx.model === 'daily' ? fxDailyView() : fxShortView()}`;
}

// ---------------------------------------------------------------- events
function fxOpenPicker() {
  const s = fx[fx.model];
  fx.picker = { month: (s.date || (fx.model === 'daily' ? s.info.dataset.to : s.targets.at(-1))).slice(0, 7) };
}
function fxChooseDay(day) {
  if (fx.model === 'daily') { fx.picker = null; fxSelectDaily(day); return; }
  const s = fx.short, times = s.byDate.get(day);
  if (!times) return;
  const sameClock = `${day}T${(s.target || 'T12:00:00Z').slice(11)}`;
  fxSelectShort(times.includes(sameClock) ? sameClock : times[0]);
  fx.picker = { month: day.slice(0, 7) }; // keep open so a time can be chosen
  render();
}
function fxQuick(kind) {
  const daily = fx.model === 'daily', s = fx[fx.model];
  fx.picker = null;
  if (daily) {
    const { from, to } = s.info.dataset;
    if (kind === 'first') fxSelectDaily(from);
    else if (kind === 'last') fxSelectDaily(to);
    else { const span = (Date.parse(to) - Date.parse(from)) / 864e5; fxSelectDaily(fxAddDays(from, Math.floor(Math.random() * (span + 1)))); }
  } else {
    const times = s.targets;
    fxSelectShort(kind === 'first' ? times[0] : kind === 'last' ? times.at(-1) : times[Math.floor(Math.random() * times.length)]);
  }
}

document.addEventListener('click', (event) => {
  if (pageFromHash() !== 'forecast') return;
  const t = event.target, pick = (attr) => t.closest(`[${attr}]`);
  let el;
  if ((el = pick('data-fx-model'))) {
    fx.model = el.dataset.fxModel; fx.picker = null;
    try { localStorage.setItem('forecast-model', fx.model); } catch {}
    render(); return;
  }
  if (pick('data-fx-picker')) { if (fx.picker) fx.picker = null; else fxOpenPicker(); render(); return; }
  if (pick('data-fx-close')) { fx.picker = null; render(); return; }
  if ((el = pick('data-fx-month'))) { fx.picker.month = fxShiftMonth(fx.picker.month, Number(el.dataset.fxMonth)); render(); return; }
  if ((el = pick('data-fx-year'))) {
    const s = fx[fx.model], year = el.dataset.fxYear, first = (s.targets?.[0] || s.info.dataset.from).slice(0, 7), last = (s.targets?.at(-1) || s.info.dataset.to).slice(0, 7);
    const month = `${year}-${fx.picker.month.slice(5)}`;
    fx.picker.month = month < first ? first : month > last ? last : month; render(); return;
  }
  if ((el = pick('data-fx-quick'))) { fxQuick(el.dataset.fxQuick); return; }
  if ((el = pick('data-fx-target'))) { fx.picker = null; fxSelectShort(el.dataset.fxTarget); return; }
  if ((el = pick('data-fx-day'))) { if ('fxInWeek' in el.dataset) fxSelectDaily(el.dataset.fxDay, true); else fxChooseDay(el.dataset.fxDay); return; }
  if ((el = pick('data-fx-step'))) { fxStep(Number(el.dataset.fxStep)); return; }
  if ((el = pick('data-fx-horizon'))) { fx.short.horizon = Number(el.dataset.fxHorizon); render(); return; }
  if ((el = pick('data-fx-retry'))) {
    const s = fx[fx.model];
    if (el.dataset.fxRetry === 'info') { s.infoError = ''; fxLoadInfo(fx.model); }
    else if (fx.model === 'daily') fxSelectDaily(s.date); else fxSelectShort(s.target);
    return;
  }
  if (fx.picker && !t.closest('.fx-picker-anchor')) { fx.picker = null; render(); }
});
// <details> toggle does not bubble, so listen in the capture phase.
document.addEventListener('toggle', (event) => {
  const kind = event.target.dataset?.fxCaveats;
  if (kind) fx.caveatsOpen[kind] = event.target.open;
}, true);
document.addEventListener('keydown', (event) => {
  if (pageFromHash() !== 'forecast') return;
  if (event.key === 'Escape' && fx.picker) { fx.picker = null; render(); document.querySelector('[data-fx-picker]')?.focus(); return; }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('g[data-fx-day]')) { event.preventDefault(); fxSelectDaily(event.target.dataset.fxDay, true); }
});
