// Forecast page: replay GridToEv's two models on dates from their own datasets.
// Daily (V2) predicts curtailment over a UTC day; short-term (V1) predicts
// half-hour dispatch-down 30 and 60 minutes ahead. The short-term view is organised
// by target half-hour, so a target always stays on its own day even when its
// forecast was issued the previous evening.
const fx = {
  model: 'daily',
  picker: null, // {month:'YYYY-MM'} while the date picker is open
  caveatsOpen: { daily: false, short: false }, // survives re-renders
  daily: { info: null, infoLoading: false, infoError: '', date: null, result: null, loading: false, error: '', week: null, weekLoading: false },
  short: { info: null, infoLoading: false, infoError: '', date: null, target: null, result: null, loading: false, error: '', replays: {}, observed: {}, horizon: 30, targets: null, byDate: null, issueSet: null },
};
try { if (localStorage.getItem('forecast-model') === 'short') fx.model = 'short'; } catch {}
const fxTokens = { daily: 0, short: 0, week: 0 };
const fxChevron = (dir) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir === 'left' ? 'm15 5-7 7 7 7' : dir === 'right' ? 'm9 5 7 7-7 7' : 'm6 9 6 6 6-6'}"/></svg>`;
const fxPartitions = {
  train: ['Train', 'Seen while fitting'],
  validation: ['Validation', 'Used to tune settings'],
  test: ['Test', 'Held out · honest check'],
};
// Glyphs this page needs beyond the shared icon() set, drawn on the same 24px grid.
const fxGlyphs = {
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.2"/>',
  alert: '<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5M12 17.2v.2"/>',
  cross: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m8.6 8.6 6.8 6.8m0-6.8-6.8 6.8" stroke="#fff"/>',
  wait: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7v5.2l3.2 2" stroke="#fff"/>',
  replay: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/><path d="M12 8v4.2l2.8 1.8"/>',
  scale: '<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 6.5a3 3 0 0 0 6 0L5 7Zm14 0-3 6.5a3 3 0 0 0 6 0L19 7Z"/>',
};
function fxIcon(name, size = 20) {
  return fxGlyphs[name]
    ? `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${fxGlyphs[name]}</svg>`
    : icon(name, size);
}

// ---------------------------------------------------------------- formatting (all UTC)
function fxDateLabel(day, style = 'long') {
  const options = style === 'long' ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', ...options }).format(new Date(`${day}T00:00:00Z`));
}
function fxWeekday(day) { return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${day}T00:00:00Z`)); }
function fxDayMonth(day) { return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${day}T00:00:00Z`)); }
function fxClock(stamp) { return stamp.slice(11, 16); }
function fxShift(stamp, minutes) { return new Date(Date.parse(stamp) + minutes * 6e4).toISOString().replace('.000Z', 'Z'); }
// Issue time relative to the target's day, e.g. "23:30 prev. day" for a 00:00 target.
function fxIssueLabel(issue, day) { return issue.slice(0, 10) === day ? fxClock(issue) : `${fxClock(issue)} prev. day`; }
function fxMonthLabel(month) { return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T00:00:00Z`)); }
function fxShiftMonth(month, delta) { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); }
function fxAddDays(day, delta) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); }
function fxRound(value, digits = 0) { const f = 10 ** digits; return Math.round(value * f) / f; }
function fxMwh(value, digits = 0) { return value === null || value === undefined || !Number.isFinite(value) ? '—' : n(fxRound(value, digits)); }
function fxPercent(value, digits = 0) { return value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`; }
function fxPartitionOf(stamp, partitions) {
  for (const name of ['train', 'validation', 'test']) { const p = partitions?.[name]; if (p && p.from <= stamp && stamp <= p.to) return name; }
  return null;
}
const fxHas = (value) => value !== null && value !== undefined && Number.isFinite(value);
// Axis top and tick step: 3–5 round ticks with as little empty headroom as possible.
function fxScale(peak, floor) {
  const top = Math.max(peak, floor) * 1.04, base = 10 ** Math.floor(Math.log10(top / 5));
  let best = { max: top, step: top / 4 };
  for (const mult of [1, 2, 2.5, 5, 10, 20, 25, 50]) {
    for (const count of [3, 4, 5]) {
      const max = base * mult * count;
      if (max >= top && (best.max === top || max < best.max)) best = { max, step: base * mult };
    }
  }
  return best;
}
// Smooth line through points without overshooting between neighbours (same curve as the Charging page).
function fxSmooth(points, move = 'M') {
  if (!points.length) return '';
  const f = (v) => v.toFixed(1);
  let d = `${move}${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
    const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]), dx = (p2[0] - p1[0]) / 3;
    const c1 = Math.min(hi, Math.max(lo, p1[1] + (p2[1] - p0[1]) * 0.2)), c2 = Math.min(hi, Math.max(lo, p2[1] - (p3[1] - p1[1]) * 0.2));
    d += ` C${f(p1[0] + dx)} ${f(c1)} ${f(p2[0] - dx)} ${f(c2)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}
// Indices of gap-free runs, so lines and bands never bridge half-hours missing from the data.
function fxRuns(values) {
  const runs = [];
  values.forEach((v, i) => { if (!fxHas(v)) return; if (!runs.length || runs.at(-1).at(-1) !== i - 1) runs.push([]); runs.at(-1).push(i); });
  return runs;
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
// Re-render and put keyboard focus back on the control that had it, since render() rebuilds <main>.
// fxFocusNext asks for a different control (e.g. the next day after an arrow key) once it exists.
const FX_FOCUS = ['data-fx-day', 'data-fx-target', 'data-fx-model', 'data-fx-step', 'data-fx-horizon', 'data-fx-picker', 'data-fx-plot', 'data-fx-month'];
const FX_FOCUS_ANY = ['data-fx-plot', 'data-fx-picker']; // matched by attribute alone
let fxFocusNext = null; // [attribute, value or null, inside the week chart]
function fxRender() {
  if (pageFromHash() !== 'forecast') return;
  const el = document.activeElement, attr = el && FX_FOCUS.find((a) => el.hasAttribute?.(a));
  const want = fxFocusNext || (attr ? [attr, FX_FOCUS_ANY.includes(attr) ? null : el.getAttribute(attr), el.hasAttribute('data-fx-in-week')] : null);
  render();
  if (!want) return;
  const [a, value, inWeek] = want;
  const next = [...document.querySelectorAll(`main [${a}]`)].find((x) => (value === null || x.getAttribute(a) === value) && x.hasAttribute('data-fx-in-week') === Boolean(inWeek));
  if (!next) return;
  next.focus({ preventScroll: true });
  fxFocusNext = null;
}
const fxRerender = fxRender;

async function fxLoadInfo(kind) {
  const s = fx[kind];
  if (s.info || s.infoLoading) return;
  s.infoLoading = true; s.infoError = ''; fxRerender();
  try {
    s.info = await fxGet(`/api/v1/explorer/${kind === 'daily' ? 'daily' : 'short-term'}`);
    if (kind === 'short') {
      // Selectable targets come from the server: only half-hours the model has a dataset row
      // for at +30 or +60 min (e.g. not 31 Jan 23:30, which is past the last labelled target).
      s.issueSet = new Set(s.info.times);
      s.targets = s.info.targets;
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
  catch (error) { if (token === fxTokens.daily) { s.error = error.message; if (s.result?.date !== day) s.result = null; } }
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
  fxLoadObserved(day); // ~0.3 s: lets the chart show reality while the forecast replay (~13 s) runs
  const shown = s.horizon;
  // The horizon on screen first; the other is prefetched afterwards (if the day is still shown).
  fxEnsureReplay(day, shown).then(() => { if (s.date === day) fxEnsureReplay(day, shown === 30 ? 60 : 30, true); });
  try {
    const result = await fxGet(`/api/v1/explorer/short-term/predict?target=${encodeURIComponent(target)}&capacityMw=${modelState.capacity}`);
    if (token === fxTokens.short) s.result = result;
  } catch (error) { if (token === fxTokens.short) { s.error = error.message; if (s.result?.targetAt !== target) s.result = null; } }
  if (token === fxTokens.short) { s.loading = false; fxRerender(); }
}
// Day replays are heavy for the hosted model (~13 s each, much slower when two overlap). The
// server's replay gate runs one at a time for all viewers, puts on-screen requests before
// prefetches and drops this tab's superseded work, identified by fxClient and fxSeq. It answers
// 503 (busy: retry with backoff) or 409 (superseded: ignore).
const fxClient = (globalThis.crypto?.randomUUID?.() || `tab-${Math.random().toString(36).slice(2)}`).slice(0, 64);
let fxSeq = 0;
const fxSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fxFetchReplay(day, horizon, seq, prefetch) {
  const query = new URLSearchParams({ date: day, horizon: String(horizon), client: fxClient, seq: String(seq) });
  if (prefetch) query.set('prefetch', '1');
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`/api/v1/explorer/short-term/day?${query}`);
    const body = await response.json().catch(() => ({}));
    if (response.status === 409) throw Object.assign(new Error('superseded'), { superseded: true });
    if (response.status === 503 && attempt < 3) {
      await fxSleep((Number(response.headers.get('Retry-After')) || 2) * 1000 * 2 ** attempt);
      if (seq < fxSeq && !prefetch) throw Object.assign(new Error('superseded'), { superseded: true });
      continue;
    }
    if (!response.ok) throw new Error(body.error?.message || 'The model request failed.');
    return body;
  }
}
async function fxLoadObserved(day) {
  const s = fx.short;
  if (s.observed[day] && s.observed[day].status !== 'error') return;
  s.observed[day] = { status: 'loading' };
  try { s.observed[day] = { status: 'ok', data: await fxGet(`/api/v1/explorer/short-term/observed?date=${day}`) }; }
  catch (error) { s.observed[day] = { status: 'error', error: error.message }; }
  fxRerender();
}
function fxReplay(day = fx.short.date, horizon = fx.short.horizon) { return fx.short.replays[`${day}|${horizon}`]; }
function fxEnsureReplay(day, horizon, prefetch = false) {
  const s = fx.short, key = `${day}|${horizon}`;
  const existing = s.replays[key];
  if (existing && existing.status !== 'error' && !(existing.prefetch && !prefetch)) return existing.promise || Promise.resolve();
  if (!prefetch) fxSeq += 1; // a new on-screen request supersedes this tab's older queued work
  const seq = fxSeq, entry = { status: 'loading', prefetch };
  entry.promise = fxFetchReplay(day, horizon, seq, prefetch).then(
    (data) => { if (s.replays[key] === entry) s.replays[key] = { status: 'ok', data }; },
    (error) => { if (s.replays[key] === entry) { if (error.superseded) delete s.replays[key]; else s.replays[key] = { status: 'error', error: error.message }; } },
  ).then(fxRerender);
  s.replays[key] = entry;
  return entry.promise;
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
function fxShortPred(horizon) { return fx.short.result?.predictions.find((p) => p.horizonMinutes === horizon); }

// ---------------------------------------------------------------- date picker
function fxPickerButton() {
  const daily = fx.model === 'daily', s = fx[fx.model];
  const value = daily ? (s.date ? fxDateLabel(s.date) : 'Choose a day') : (s.target ? `${fxDateLabel(s.date)} · ${fxClock(s.target)}` : 'Choose a half-hour');
  const open = Boolean(fx.picker);
  const atStart = daily ? s.date === s.info?.dataset.from : s.target === s.targets?.[0];
  const atEnd = daily ? s.date === s.info?.dataset.to : s.target === s.targets?.at(-1);
  return `<div class="fx-target">
    <button type="button" class="fx-step" data-fx-step="-1" aria-label="Previous ${daily ? 'day' : 'half-hour'}" ${!s.info || atStart ? 'disabled' : ''}>${fxChevron('left')}</button>
    <div class="fx-picker-anchor">
      <button type="button" class="fx-date-button${open ? ' is-open' : ''}" data-fx-picker aria-haspopup="dialog" aria-expanded="${open}" ${s.info ? '' : 'disabled'}>
        <span class="fx-date-icon">${icon(daily ? 'calendar' : 'clock', 18)}</span>
        <span class="fx-date-text"><small>${daily ? 'Day · UTC' : 'Half-hour · UTC'}</small><strong>${escapeHtml(value)}</strong></span>
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
    cells.push(`<button type="button" class="fx-cal-day${day === selected ? ' is-selected' : ''}${partition ? ` is-${partition}` : ''}" ${available ? `data-fx-day="${day}"` : 'disabled'} aria-label="${fxDateLabel(day)}${available ? '' : ' (not in dataset)'}" ${day === selected ? 'aria-pressed="true"' : ''}>${d}<i></i></button>`);
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
    times = `<div class="fx-times"><div class="fx-times-head"><strong>${fxDateLabel(s.date)}</strong><span>${available.size} of 48 half-hours</span></div><div class="fx-times-grid">${slots.map((t) => {
      const ok = available.has(t), partition = ok ? fxPartitionOf(fxShortIssue(t), info.model.partitions) : null;
      return `<button type="button" class="fx-time${t === s.target ? ' is-selected' : ''}${partition ? ` is-${partition}` : ''}" ${ok ? `data-fx-target="${t}"` : 'disabled'}>${fxClock(t)}</button>`;
    }).join('')}</div><p>Each half-hour has a +30 min forecast (made 30 min before) and a +60 min one (made an hour before). Greyed-out times have no forecast in the dataset.</p></div>`;
  }
  const quick = [['first', 'Earliest'], ['last', 'Latest'], ['random', 'Surprise me']];
  return `<div class="fx-popover${daily ? '' : ' is-wide'}" role="dialog" aria-label="Choose a ${daily ? 'day' : 'half-hour'}">
    <div class="fx-popover-head"><div><strong>${daily ? 'Pick a day' : 'Pick a half-hour'}</strong><span>Dataset: ${fxDateLabel(first, 'short')} – ${fxDateLabel(last, 'short')} · ${count}</span></div><button type="button" class="fx-close" data-fx-close aria-label="Close">×</button></div>
    <div class="fx-popover-body">${calendar}${times}</div>
    <div class="fx-popover-foot">${quick.map(([key, label]) => `<button type="button" data-fx-quick="${key}">${label}</button>`).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- engine charts
// Every chart below is drawn by the shared engine in charts3d.js: it interpolates values() from
// start() and redraws each frame, so bars grow in, lines draw left to right and everything glides
// to new values when the day, half-hour or horizon changes. `standalone` charts bring their own
// data instead of the Dashboard's model state. Labels travel as strings so they never interpolate.
function fxChart(name, chart) { dashCharts[name] = { standalone: true, ...chart }; }

// Animated KPI figures.
function fxFigure(name, get, unit, digits) {
  fxChart(name, {
    values: () => { const v = get(); return { v: fxHas(v) ? v : 0, none: fxHas(v) ? '' : '1' }; },
    start: (t) => ({ ...t, v: 0 }),
    draw: ({ v, none }) => (none ? '<strong>—</strong>' : `<strong>${n(fxRound(v, digits))}${unit ? `<small${unit === '%' ? ' class="is-pct"' : ''}>${unit}</small>` : ''}</strong>`),
  });
}
const fxDailyObs = () => fx.daily.result?.actual?.curtailmentMwh;
fxFigure('fxDProb', () => (fx.daily.result ? fx.daily.result.probability * 100 : null), '%', 0);
fxFigure('fxDPred', () => fx.daily.result?.predictedMwh, 'MWh', 0);
fxFigure('fxDObs', fxDailyObs, 'MWh', 0);
fxFigure('fxDErr', () => (fxHas(fxDailyObs()) ? Math.abs(fx.daily.result.predictedMwh - fxDailyObs()) : null), 'MWh', 0);
const fxShortObs = () => fx.short.result?.actual?.dispatchDownMwh;
fxFigure('fxS30', () => fxShortPred(30)?.atRiskMwh, 'MWh', 1);
fxFigure('fxS60', () => fxShortPred(60)?.atRiskMwh, 'MWh', 1);
fxFigure('fxSObs', fxShortObs, 'MWh', 1);
fxFigure('fxSErr', () => { const p = fxShortPred(fx.short.horizon); return p && fxHas(fxShortObs()) ? Math.abs(p.atRiskMwh - fxShortObs()) : null; }, 'MWh', 1);

// KPI sparklines: gradient area and soft glowing line, with the selected point marked.
function fxSpark(name, get, tone) {
  fxChart(name, {
    values: () => { const { v, sel } = get(); return { v, sel: String(sel), reveal: v.some(fxHas) ? 1 : 0 }; },
    start: (t) => ({ ...t, reveal: 0 }),
    draw({ v, sel, reveal }) {
      if (!v.some(fxHas)) return '<span class="fx-spark-empty"></span>';
      const w = 120, h = 46, max = Math.max(...v.filter(fxHas), 0) || 1;
      const X = (i) => 4 + (w - 8) * (i / (v.length - 1 || 1)), Y = (x) => h - 4 - (x / max) * (h - 12);
      const runs = fxRuns(v).map((run) => run.map((i) => [X(i), Y(v[i])]));
      const area = runs.map((pts) => `${fxSmooth(pts)} L${pts.at(-1)[0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h}Z`).join(' ');
      const line = runs.map((pts) => fxSmooth(pts)).join(' ');
      const i = Number(sel), dot = i >= 0 && fxHas(v[i]) && reveal > 0.98 ? `<circle class="dot" cx="${X(i).toFixed(1)}" cy="${Y(v[i]).toFixed(1)}" r="3.6"/>` : '';
      return `<svg class="fx-spark is-${tone}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><defs><linearGradient id="fx-spark-${name}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop" stop-opacity=".5"/><stop offset="1" class="stop" stop-opacity="0"/></linearGradient><clipPath id="fx-clip-${name}"><rect x="0" y="-4" width="${(w * reveal).toFixed(1)}" height="${h + 8}"/></clipPath></defs><g clip-path="url(#fx-clip-${name})"><path class="area" d="${area}" fill="url(#fx-spark-${name})"/><path class="line" d="${line}"/></g>${dot}</svg>`;
    },
  });
}
const fxWeekDays = () => fx.daily.week?.days || [];
fxSpark('fxDPredSpark', () => ({ v: fxWeekDays().map((d) => d.predictedMwh), sel: fxWeekDays().findIndex((d) => d.date === fx.daily.date) }), 'orange');
fxSpark('fxDObsSpark', () => ({ v: fxWeekDays().map((d) => d.actual?.curtailmentMwh ?? null), sel: fxWeekDays().findIndex((d) => d.date === fx.daily.date) }), 'green');
fxSpark('fxSObsSpark', () => { const d = fxDaySeries(); return { v: d.obs, sel: d.sel }; }, 'green');

// Small 3D half-ring for the chance of curtailment.
fxChart('fxDProbRing', {
  values: () => ({ p: fx.daily.result?.probability ?? 0 }),
  start: () => ({ p: 0 }),
  draw({ p }) {
    const v = Math.min(1, Math.max(0, p)), cx = 50, cy = 48, outer = 44, inner = 29, end = Math.PI + v * Math.PI;
    const knob = chartPoint(cx, cy, (outer + inner) / 2, (outer + inner) / 2, end);
    return `<svg class="fx-ring" viewBox="0 0 100 60" aria-hidden="true"><defs><linearGradient id="fx-ring-fill" x1="${cx - outer}" x2="${cx + outer}" gradientUnits="userSpaceOnUse"><stop class="lo"/><stop offset=".55" class="mid"/><stop offset="1" class="hi"/></linearGradient></defs>
      <path class="slab" d="${chartBand(cx, cy + 4, outer, inner, Math.PI, 2 * Math.PI)}"/><path class="track" d="${chartBand(cx, cy, outer, inner, Math.PI, 2 * Math.PI)}"/>
      ${v > 0.004 ? `<path fill="url(#fx-ring-fill)" d="${chartBand(cx, cy, outer, inner, Math.PI, end)}"/>` : ''}
      <circle class="knob" cx="${knob[0].toFixed(1)}" cy="${knob[1].toFixed(1)}" r="5.2"/></svg>`;
  },
});

// Mini forecast range for the +30/+60 KPIs: P10–P90 band, forecast dot and the observed tick.
function fxMiniRange(name, horizon) {
  fxChart(name, {
    values() {
      const p = fxShortPred(horizon), obs = fxShortObs();
      const peak = Math.max(...[30, 60].map((h) => fxShortPred(h)?.upperMwh ?? 0), fxHas(obs) ? obs : 0, 1);
      return p ? { lo: p.lowerMwh, mid: p.atRiskMwh, hi: p.upperMwh, obs: fxHas(obs) ? obs : null, max: peak * 1.08, ok: '1' } : { lo: 0, mid: 0, hi: 0, obs: null, max: 1, ok: '' };
    },
    start: (t) => ({ ...t, lo: t.mid, hi: t.mid }),
    draw({ lo, mid, hi, obs, max, ok }) {
      if (!ok) return '<span class="fx-spark-empty"></span>';
      const at = (v) => `${Math.min(100, Math.max(0, (v / max) * 100)).toFixed(2)}%`;
      return `<span class="fx-mini"><span class="fx-mini-track">${settings.uncertainty ? `<i class="fx-mini-band" style="left:${at(lo)};width:calc(${at(hi)} - ${at(lo)})"></i>` : ''}${obs === null ? '' : `<em class="fx-mini-obs" style="left:${at(obs)}"></em>`}<b class="fx-mini-dot" style="left:${at(mid)}"></b></span><small>${settings.uncertainty ? `${fxMwh(lo)}–${fxMwh(hi)} MWh` : 'median'}</small></span>`;
    },
  });
}
fxMiniRange('fxS30Range', 30);
fxMiniRange('fxS60Range', 60);

// Week of daily results: predicted and observed glowing bars with the chance of curtailment on top.
fxChart('fxWeek', {
  values() {
    const days = fxWeekDays();
    const peak = Math.max(0, ...days.map((d) => Math.max(d.predictedMwh, d.actual?.curtailmentMwh ?? 0)));
    const { max, step } = fxScale(peak, 10);
    return {
      days: days.map((d) => ({ date: d.date, pred: d.predictedMwh, obs: d.actual?.curtailmentMwh ?? null, prob: d.probability })),
      axis: `${max}|${step}`, sel: fx.daily.date || '', rise: days.length ? 1 : 0,
      state: fx.daily.week ? 'ready' : fx.daily.weekLoading ? 'loading' : 'failed',
    };
  },
  start: (t) => ({ ...t, rise: 0 }),
  draw({ days, axis, sel, rise, state }) {
    if (!days.length) return fxChartState(state, 'Loading the week…', 'The week around this day could not be loaded.', 'week');
    const [max, step] = axis.split('|').map(Number);
    const h = (v) => (Math.min(1, Math.max(0, v / max)) * rise).toFixed(4);
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => `<span class="fx-tick" style="bottom:${((i * step) / max) * 100}%"><b>${n(i * step)}</b></span>`).join('');
    const cols = days.map((d) => {
      const level = d.prob >= 0.7 ? 'high' : d.prob >= 0.4 ? 'medium' : 'low';
      return `<div class="fx-week-col${d.date === sel ? ' is-selected' : ''}"><span class="fx-prob is-${level}"><b>${Math.round(d.prob * 100)}%</b></span>
        <span class="fx-week-bars"><i class="fx-bar is-pred" style="--h:${h(d.pred)}"></i>${d.obs === null ? '<i class="fx-bar is-missing" title="Not observed"><em>?</em></i>' : `<i class="fx-bar is-obs" style="--h:${h(d.obs)}"></i>`}</span>
        <span class="fx-week-day"><b>${fxWeekday(d.date)}</b><small>${fxDayMonth(d.date)}</small></span></div>`;
    }).join('');
    return `<div class="fx-week"><div class="fx-week-grid">${ticks}</div><div class="fx-week-cols" style="grid-template-columns:repeat(${days.length},minmax(0,1fr))">${cols}</div></div>`;
  },
});

// One replayed day of the short-term model, as 48 target half-hours.
// The observed values arrive first (fast route); the forecast line joins when its replay does.
function fxDaySeries() {
  const s = fx.short, date = s.date, replay = fxReplay(), fast = date ? s.observed[date] : null;
  const points = replay?.status === 'ok' ? replay.data.points || [] : [];
  const observed = replay?.status === 'ok' ? replay.data.observed : fast?.status === 'ok' ? fast.data.observed : null;
  if (!date || (!points.length && !observed)) return { pred: [], lo: [], hi: [], obs: [], issued: [], sel: -1, date: date || '' };
  const start = Date.parse(`${date}T00:00:00Z`), slot = (t) => Math.round((Date.parse(t) - start) / 18e5);
  const out = { pred: Array(48).fill(null), lo: Array(48).fill(null), hi: Array(48).fill(null), obs: Array(48).fill(null), issued: Array(48).fill(''), sel: -1, date };
  for (const p of points) {
    const i = slot(p.targetAt);
    if (p.horizonMinutes !== s.horizon || i < 0 || i > 47) continue;
    out.pred[i] = p.atRiskMwh; out.lo[i] = p.lowerMwh; out.hi[i] = p.upperMwh; out.issued[i] = p.issuedAt;
  }
  for (const o of observed || []) { const i = slot(o.targetAt); if (i >= 0 && i < 48 && fxHas(o.actualMwh)) out.obs[i] = o.actualMwh; }
  if (s.target?.startsWith(date)) out.sel = slot(s.target);
  return out;
}
function fxDayState() {
  const replay = fxReplay(), fast = fx.short.observed[fx.short.date];
  if (replay?.status === 'ok' || fast?.status === 'ok') return 'ready';
  return replay?.status === 'error' || fast?.status === 'error' ? 'failed' : 'loading';
}
let fxDayMax = 1; // axis top of the drawn day chart, shared with the hover layer
fxChart('fxDay', {
  values() {
    const d = fxDaySeries(), band = settings.uncertainty ? 1 : 0;
    const peak = Math.max(0, ...d.pred.filter(fxHas), ...d.obs.filter(fxHas), ...(band ? d.hi.filter(fxHas) : []));
    const { max, step } = fxScale(peak, 1);
    return { pred: d.pred, lo: d.lo, hi: d.hi, obs: d.obs, axis: `${max}|${step}`, sel: String(d.sel), band, reveal: d.pred.some(fxHas) || d.obs.some(fxHas) ? 1 : 0,
      state: fxDayState(), horizon: String(fx.short.horizon) };
  },
  start: (t) => ({ ...t, reveal: 0 }),
  draw({ pred, lo, hi, obs, axis, sel, band, reveal, state, horizon }) {
    if (!pred.some(fxHas) && !obs.some(fxHas)) return fxChartState(state, 'Loading this day\'s observed values…', 'This day could not be loaded.', 'day');
    const [max, step] = axis.split('|').map(Number);
    fxDayMax = max;
    const W = 1000, H = 300, X = (i) => (i / 47) * W, Y = (v) => H - (Math.max(0, v) / max) * H;
    const xp = (i) => `${((i / 47) * 100).toFixed(3)}%`, yp = (v) => `${((1 - Math.max(0, v) / max) * 100).toFixed(3)}%`;
    const line = (vals) => fxRuns(vals).map((run) => fxSmooth(run.map((i) => [X(i), Y(vals[i])]))).join(' ');
    const bandPath = band ? fxRuns(hi.map((v, i) => (fxHas(v) && fxHas(lo[i]) ? v : null))).map((run) => `${fxSmooth(run.map((i) => [X(i), Y(hi[i])]))} ${fxSmooth(run.slice().reverse().map((i) => [X(i), Y(lo[i])]), 'L')} Z`).join(' ') : '';
    const predArea = fxRuns(pred).map((run) => { const pts = run.map((i) => [X(i), Y(pred[i])]); return `${fxSmooth(pts)} L${pts.at(-1)[0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H}Z`; }).join(' ');
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => `<span class="fx-tick" style="bottom:${((i * step) / max) * 100}%"><b>${n(i * step)}</b></span>`).join('');
    const hours = [0, 8, 16, 24, 32, 40, 47].map((i) => `<span style="left:${xp(i)}">${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}</span>`).join('');
    const dots = obs.map((v, i) => (fxHas(v) && i / 47 <= reveal ? `<i class="fx-obs-dot" style="left:${xp(i)};top:${yp(v)}"></i>` : '')).join('');
    const s = Number(sel), marker = s >= 0 && reveal > 0.97
      ? `<span class="fx-sel" style="left:${xp(s)}"><em>${String(Math.floor(s / 2)).padStart(2, '0')}:${s % 2 ? '30' : '00'}</em></span>${fxHas(obs[s]) ? `<i class="fx-sel-dot is-obs" style="left:${xp(s)};top:${yp(obs[s])}"></i>` : ''}${fxHas(pred[s]) ? `<i class="fx-sel-dot" style="left:${xp(s)};top:${yp(pred[s])}"></i>` : ''}`
      : '';
    const lastOf = (vals) => { for (let i = vals.length - 1; i >= 0; i--) if (fxHas(vals[i])) return i; return -1; };
    const lp = lastOf(pred), lo2 = lastOf(obs);
    let predTop = lp >= 0 ? (1 - Math.max(0, pred[lp]) / max) * 100 : null, obsTop = lo2 >= 0 ? (1 - Math.max(0, obs[lo2]) / max) * 100 : null;
    if (predTop !== null && obsTop !== null && Math.abs(predTop - obsTop) < 9) { const mid = (predTop + obsTop) / 2, up = predTop <= obsTop ? -4.5 : 4.5; predTop = mid + up; obsTop = mid - up; }
    const direct = reveal > 0.97 ? `${predTop !== null ? `<span class="fx-direct is-pred" style="top:${predTop.toFixed(2)}%">Predicted +${horizon}</span>` : ''}${obsTop !== null ? `<span class="fx-direct is-obs" style="top:${obsTop.toFixed(2)}%">Observed</span>` : ''}` : '';
    return `<div class="fx-day"><div class="fx-day-grid">${ticks}</div><div class="fx-day-area">${direct}
        <svg class="fx-day-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs>
          <linearGradient id="fx-band-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="band-top"/><stop offset="1" class="band-bottom"/></linearGradient>
          <linearGradient id="fx-pred-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="pred-top"/><stop offset="1" class="pred-bottom"/></linearGradient>
          <clipPath id="fx-day-clip"><rect x="-10" y="-40" width="${(W * reveal + 10).toFixed(1)}" height="${H + 80}"/></clipPath></defs>
          <g clip-path="url(#fx-day-clip)">${band ? `<path class="fx-day-band" d="${bandPath}"/>` : `<path class="fx-day-fill" d="${predArea}"/>`}
            <path class="fx-day-edge" d="${line(obs)}"/><path class="fx-day-line is-obs" d="${line(obs)}"/>
            <path class="fx-day-edge" d="${line(pred)}"/><path class="fx-day-line is-pred" d="${line(pred)}"/></g></svg>
        ${dots}${marker}</div><div class="fx-day-x">${hours}</div></div>`;
  },
});

// Daily side card: predicted and observed totals on one scale.
fxChart('fxDCompare', {
  values() {
    const r = fx.daily.result, pred = r?.predictedMwh ?? 0, obs = fxDailyObs();
    return { pred, obs: fxHas(obs) ? obs : null, max: String(fxScale(Math.max(pred, fxHas(obs) ? obs : 0), 10).max) };
  },
  start: (t) => ({ ...t, pred: 0, obs: t.obs === null ? null : 0 }),
  draw({ pred, obs, max }) {
    const w = (v) => `${Math.min(100, Math.max(0, (v / Number(max)) * 100)).toFixed(2)}%`;
    const row = (cls, label, v) => `<div class="fx-cmp is-${cls}"><span class="fx-cmp-label">${label}</span><span class="fx-cmp-track"><i style="width:${v === null ? '0%' : w(v)}"></i></span><b>${v === null ? '—' : `${fxMwh(v)}<small>MWh</small>`}</b></div>`;
    return row('pred', 'Predicted', pred) + row('obs', 'Observed', obs);
  },
});

// Short-term side card: the forecast range on a glass track with the observed value.
fxChart('fxSRange', {
  values() {
    const p = fxShortPred(fx.short.horizon), obs = fxShortObs();
    if (!p) return { lo: 0, mid: 0, hi: 0, obs: null, axis: '1', ok: '' };
    const band = settings.uncertainty;
    return { lo: band ? p.lowerMwh : p.atRiskMwh, mid: p.atRiskMwh, hi: band ? p.upperMwh : p.atRiskMwh, obs: fxHas(obs) ? obs : null,
      axis: String(fxScale(Math.max(p.upperMwh, p.atRiskMwh, fxHas(obs) ? obs : 0), 1).max), ok: '1' };
  },
  start: (t) => ({ ...t, lo: t.mid, hi: t.mid }),
  draw({ lo, mid, hi, obs, axis, ok }) {
    if (!ok) return '';
    const max = Number(axis), f = (v) => Math.min(100, Math.max(0, (v / max) * 100)), at = (v) => `${f(v).toFixed(2)}%`;
    const edge = (v) => (f(v) < 14 ? ' is-start' : f(v) > 86 ? ' is-end' : '');
    const near = (v) => obs !== null && Math.abs(f(v) - f(obs)) < 13;
    const band = hi - lo > max * 0.004;
    return `<div class="fx-range"><span class="fx-range-glass"></span>${band ? `<span class="fx-range-band" style="left:${at(lo)};width:calc(${at(hi)} - ${at(lo)})"></span>${near(lo) ? '' : `<span class="fx-range-end" style="left:${at(lo)}">${fxMwh(lo)}</span>`}${near(hi) ? '' : `<span class="fx-range-end is-high" style="left:${at(hi)}">${fxMwh(hi)}</span>`}` : ''}
      ${obs === null ? '' : `<span class="fx-range-obs${edge(obs)}" style="left:${at(obs)}"><em>Observed ${fxMwh(obs, 1)}</em></span>`}
      <span class="fx-range-dot${edge(mid)}" style="left:${at(mid)}"><em>${fxMwh(mid, 1)} MWh</em></span></div>`;
  },
});

// Short-term side card: grid constraint vs curtailment, both parts of the forecast.
fxChart('fxSSplit', {
  values() {
    const p = fxShortPred(fx.short.horizon);
    return { constraint: p?.constraintMwh ?? 0, curtailment: p?.curtailmentMwh ?? 0, grow: p ? 1 : 0 };
  },
  start: (t) => ({ ...t, grow: 0 }),
  draw({ constraint, curtailment, grow }) {
    const total = constraint + curtailment, share = total > 0 ? constraint / total : 0;
    const row = (cls, label, v) => `<li class="is-${cls}"><i></i><span>${label}</span><b>${fxMwh(v, 1)} MWh</b></li>`;
    const seg = (cls, part) => `<i class="is-${cls}" style="flex:${part.toFixed(4)}">${part >= 0.12 && grow > 0.9 ? `<b>${Math.round(part * 100)}%</b>` : ''}</i>`;
    return `<div class="fx-split-bar${total > 0 ? '' : ' is-empty'}" style="--grow:${grow.toFixed(3)}">${total > 0 ? seg('constraint', share) + seg('curtailment', 1 - share) : ''}</div>
      <ul class="fx-split-key">${row('constraint', 'Grid constraint', constraint)}${row('curtailment', 'Curtailment', curtailment)}</ul>`;
  },
});

// Accuracy: the model's error against simple baselines, and scores on their own scale.
function fxErrorBars(name, get) {
  fxChart(name, {
    values: () => ({ rows: get(), grow: 1 }),
    start: (t) => ({ ...t, grow: 0 }),
    draw({ rows, grow }) {
      const max = Math.max(...rows.map((r) => r.v || 0), 0.001);
      return rows.map((r) => `<div class="fx-err${r.model ? ' is-model' : ''}"><span>${r.label}</span><span class="fx-err-track"><i style="width:${((Math.max(0, r.v || 0) / max) * 100 * grow).toFixed(2)}%"></i></span><b>${fxHas(r.v) ? `${n(fxRound(r.v, r.digits))}` : '—'}</b></div>`).join('');
    },
  });
}
function fxMeter(name, get) {
  fxChart(name, {
    values: () => ({ ...get(), grow: 1 }),
    start: (t) => ({ ...t, grow: 0 }),
    draw({ v, lo, hi, mark, markLabel, lowLabel, highLabel, grow }) {
      if (!fxHas(v)) return '<div class="fx-meter is-empty"></div>';
      const at = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
      return `<div class="fx-meter"><span class="fx-meter-track"><i style="width:${(at(v) * grow).toFixed(2)}%"></i>${fxHas(mark) ? `<em style="left:${at(mark).toFixed(2)}%" title="${markLabel}"></em>` : ''}</span><span class="fx-meter-scale"><small>${lowLabel}</small>${fxHas(mark) ? `<small class="is-mark" style="left:${at(mark).toFixed(2)}%">${markLabel}</small>` : ''}<small>${highLabel}</small></span></div>`;
    },
  });
}
const fxDailyTest = () => fx.daily.info?.model.test || {};
const fxShortTest = () => fx.short.info?.model.test || {};
fxErrorBars('fxAccDailyErr', () => [
  { label: 'This model', v: fxDailyTest().dailyMaeMwh, model: '1', digits: 0 },
  { label: 'Monthly median', v: fxDailyTest().monthlyMedianBaselineMaeMwh, digits: 0 },
  { label: 'Always zero', v: fxDailyTest().zeroBaselineMaeMwh, digits: 0 },
].filter((r) => r.model || fxHas(r.v)));
fxMeter('fxAccDailyAuc', () => ({ v: fxDailyTest().rocAuc, lo: 0.5, hi: 1, mark: null, lowLabel: '0.5 coin flip', highLabel: '1 perfect' }));
fxMeter('fxAccDailyAp', () => ({ v: fxDailyTest().eventAveragePrecision, lo: 0, hi: 1, mark: fxDailyTest().eventRate, markLabel: 'base rate', lowLabel: '0', highLabel: '1' }));
fxErrorBars('fxAccShortErr', () => [
  { label: 'This model', v: fxShortTest().maeMwh, model: '1', digits: 1 },
  { label: 'Repeat last value', v: fxShortTest().latestObservationMaeMwh, digits: 1 },
  { label: 'Stale value', v: fxShortTest().stalePersistenceMaeMwh, digits: 1 },
].filter((r) => r.model || fxHas(r.v)));
fxMeter('fxAccShortF1', () => ({ v: fxShortTest().eventF1, lo: 0, hi: 1, mark: null, lowLabel: '0', highLabel: '1 perfect' }));
fxMeter('fxAccShortCov', () => ({ v: fxShortTest().intervalCoverage, lo: 0, hi: 1, mark: 0.8, markLabel: 'target 80%', lowLabel: '0%', highLabel: '100%' }));

// Training timeline with a pin on the selected day (its issue time for the short-term model).
function fxTimeline(name, kind) {
  fxChart(name, {
    values() {
      const s = fx[kind], info = s.info;
      const parts = kind === 'daily' ? info?.dataset.partitions : info?.model.partitions;
      const order = ['train', 'validation', 'test'].filter((k) => parts?.[k]);
      const total = order.reduce((sum, k) => sum + parts[k].rows, 0) || 1;
      const stamp = kind === 'daily' ? s.date : s.target && s.issueSet ? fxShortIssue(s.target) : null;
      let pin = null, offset = 0;
      for (const k of order) {
        const share = parts[k].rows / total, from = Date.parse(parts[k].from), to = Date.parse(parts[k].to), at = stamp ? Date.parse(stamp) : NaN;
        if (at >= from && at <= to) pin = offset + share * (to > from ? (at - from) / (to - from) : 0.5);
        offset += share;
      }
      return { segs: order.map((k) => ({ key: k, share: parts[k].rows / total, from: parts[k].from, to: parts[k].to, rows: String(parts[k].rows) })), pin: pin ?? -1, tag: stamp ? (kind === 'daily' ? fxDayMonth(stamp) : `${fxDayMonth(stamp.slice(0, 10))} ${fxClock(stamp)}`) : '' };
    },
    start: (t) => ({ ...t, pin: t.pin < 0 ? t.pin : 0 }),
    draw({ segs, pin, tag }) {
      if (!segs.length) return '';
      const range = (seg) => { const a = fxDateLabel(seg.from.slice(0, 10), 'short').replace(/^\d+ /, ''), b = fxDateLabel(seg.to.slice(0, 10), 'short').replace(/^\d+ /, ''); return a === b ? a : `${a} – ${b}`; };
      return `<div class="fx-tl"><div class="fx-tl-bar">${segs.map((seg) => `<span class="fx-tl-seg is-${seg.key}" style="flex:${seg.share.toFixed(4)}" title="${fxPartitions[seg.key][0]}: ${range(seg)} · ${n(Number(seg.rows))} rows"><b>${fxPartitions[seg.key][0]}</b></span>`).join('')}</div>
        ${pin >= 0 ? `<span class="fx-tl-pin" style="left:${(pin * 100).toFixed(2)}%"><em>${escapeHtml(tag)}</em></span>` : ''}
        <div class="fx-tl-key">${segs.map((seg) => `<span class="is-${seg.key}"><i></i>${range(seg)}</span>`).join('')}</div></div>`;
    },
  });
}
fxTimeline('fxTimeDaily', 'daily');
fxTimeline('fxTimeShort', 'short');

function fxChartState(state, loading, failed, reload = '') {
  return state === 'loading'
    ? `<div class="fx-chart-state" role="status"><span class="fx-skel-line"></span><span class="fx-skel-line is-short"></span><small>${loading}</small></div>`
    : `<div class="fx-chart-state is-failed" role="status">${fxIcon('info', 22)}<small>${failed}</small>${reload ? `<button type="button" class="fx-reload" data-fx-reload="${reload}">Try again</button>` : ''}</div>`;
}

// ---------------------------------------------------------------- building blocks
function fxHead(glyph, tone, title, subtitle, extra = '') {
  return `<div class="dash-card-head fx-head"><span class="fx-head-icon is-${tone}" aria-hidden="true">${fxIcon(glyph, 19)}</span><div class="dash-head-copy"><h2>${title}</h2><p>${subtitle}</p></div>${extra}</div>`;
}
function fxKpi(tone, glyph, label, figure, figureLabel, foot, visual) {
  return `<article class="dash-card fx-kpi is-${tone}"><span class="fx-kpi-icon" aria-hidden="true">${fxIcon(glyph, 21)}</span>
    <span class="fx-kpi-label">${label}</span>${chartSlot(figure, figureLabel, 'fx-kpi-figure')}
    <div class="fx-kpi-visual">${visual}</div><p class="fx-kpi-foot">${foot}</p></article>`;
}
function fxBadge(state, label) {
  const glyph = state === 'right' ? 'check' : state === 'wrong' ? 'cross' : 'wait';
  return `<span class="fx-badge is-${state}">${fxIcon(glyph, 30)}<small>${label}</small></span>`;
}
function fxSplitChip(partition) {
  if (!fxPartitions[partition]) return '';
  const [label, note] = fxPartitions[partition];
  return `<span class="fx-split-chip is-${partition}" title="${note}"><i></i>${label} ${fx.model === 'daily' ? 'day' : 'half-hour'}</span>`;
}
function fxLegend(items) { return `<ul class="fx-legend">${items.map(([cls, label]) => `<li><i class="is-${cls}"></i>${label}</li>`).join('')}</ul>`; }

function fxToolbar() {
  const s = fx[fx.model], busy = s.loading || s.infoLoading || (fx.model === 'daily' ? s.weekLoading : fxReplay()?.status === 'loading');
  const tab = (key, title, sub, glyph) => `<button type="button" role="tab" aria-selected="${fx.model === key}" class="fx-model${fx.model === key ? ' is-active' : ''}" data-fx-model="${key}"><span class="fx-model-icon">${icon(glyph, 18)}</span><span class="fx-model-copy"><strong>${title}</strong><small>${sub}</small></span></button>`;
  const version = s.info?.model.version ? ` · v${escapeHtml(String(s.info.model.version).replace(/^v/, ''))}` : '';
  const failed = s.error && s.result ? `<button type="button" class="fx-chip is-error" data-fx-retry="${fx.model}">${fxIcon('alert', 15)}Couldn't update · retry</button>` : '';
  return `<div class="fx-toolbar">
    <div class="fx-models" role="tablist" aria-label="Forecast model">${tab('daily', 'Daily curtailment', 'Whole UTC day', 'calendar')}${tab('short', 'Short-term', '30 and 60 min ahead', 'clock')}</div>
    ${fxPickerButton()}
    <div class="fx-toolbar-end">
      <span class="fx-busy${busy ? ' is-on' : ''}" role="status">${busy ? `<i></i>${s.infoLoading ? 'Loading…' : 'Predicting…'}` : ''}</span>${failed}
      <span class="fx-chip is-replay" title="Past data re-run through the model, then compared with what EirGrid observed. Not a live forecast.">${fxIcon('replay', 15)}Historical replay${version}</span>
    </div>
  </div>`;
}

function fxAccBlock(title, value, caption, chart) {
  return `<div class="fx-acc"><div class="fx-acc-head"><span>${title}</span><strong>${value}</strong></div>${chart}<small>${caption}</small></div>`;
}
function fxAccuracyCard(kind) {
  const t = kind === 'daily' ? fxDailyTest() : fxShortTest();
  const daily = kind === 'daily';
  const unit = daily ? 'days' : 'half-hours';
  const gain = daily ? (t.zeroBaselineMaeMwh ? 1 - t.dailyMaeMwh / t.zeroBaselineMaeMwh : null) : (t.latestObservationMaeMwh ? 1 - t.maeMwh / t.latestObservationMaeMwh : null);
  const blocks = daily ? [
    fxAccBlock('Miss per day', `${fxMwh(t.dailyMaeMwh)}<small>MWh</small>`, gain === null ? 'Mean absolute error' : `Mean absolute error · ${Math.round(Math.abs(gain) * 100)}% ${gain >= 0 ? 'smaller' : 'larger'} than always guessing zero`, chartSlot('fxAccDailyErr', 'Mean absolute error of the model and two simple baselines', 'fx-acc-chart')),
    fxAccBlock('Spots curtailment', fxHas(t.rocAuc) ? t.rocAuc.toFixed(2) : '—', 'ROC AUC: how well it ranks curtailment days above calm ones', chartSlot('fxAccDailyAuc', 'ROC AUC on a scale from coin flip to perfect', 'fx-acc-chart')),
    fxAccBlock('Warning accuracy', fxHas(t.eventAveragePrecision) ? t.eventAveragePrecision.toFixed(2) : '—', `Average precision · ${fxPercent(t.eventRate)} of test days had curtailment`, chartSlot('fxAccDailyAp', 'Average precision against the base rate', 'fx-acc-chart')),
  ] : [
    fxAccBlock('Miss per half-hour', `${fxMwh(t.maeMwh, 1)}<small>MWh</small>`, gain === null ? 'Mean absolute error' : `Mean absolute error · ${Math.round(Math.abs(gain) * 100)}% ${gain >= 0 ? 'smaller' : 'larger'} than repeating the last value`, chartSlot('fxAccShortErr', 'Mean absolute error of the model and two simple baselines', 'fx-acc-chart')),
    fxAccBlock('Catches events', fxHas(t.eventF1) ? t.eventF1.toFixed(2) : '—', `Event F1 score at an alarm threshold of ${fx.short.info?.model.classificationThreshold ?? '—'}`, chartSlot('fxAccShortF1', 'Event F1 on a scale from 0 to 1', 'fx-acc-chart')),
    fxAccBlock('Range hit rate', fxPercent(t.intervalCoverage), 'Share of real values that landed inside P10–P90', chartSlot('fxAccShortCov', 'P10 to P90 coverage against the 80% target', 'fx-acc-chart')),
  ];
  return `<section class="dash-card fx-card fx-accuracy">${fxHead('target', 'blue', 'How accurate is it?', `Scored on ${t.rows ? `${n(t.rows)} ` : ''}held-out ${unit} it never saw while training`)}<div class="fx-acc-grid">${blocks.join('')}</div></section>`;
}

function fxAboutCard(kind) {
  const s = fx[kind], model = s.info.model, daily = kind === 'daily';
  const mlOff = !daily && Object.values(model.mlWeightByHorizon || {}).length > 0 && Object.values(model.mlWeightByHorizon).every((w) => w === 0);
  const caveats = [...(mlOff ? ['The MWh estimate currently comes from a tuned trend baseline (ML blend weight 0); the ML models supply the chance, the split and the range.'] : []), ...(model.caveats || [])];
  const version = `v${escapeHtml(String(model.version).replace(/^v/, ''))}`;
  const what = daily
    ? 'Chance of <b>any curtailment</b> in Ireland on a UTC day, and the <b>total MWh</b>. Made at 00:00 UTC from the previous day\'s weather forecast.'
    : '<b>Dispatch-down</b> (grid constraint + curtailment) in one half-hour, <b>30 or 60 minutes</b> ahead, with a chance and a P10–P90 range.';
  const inputs = daily
    ? `${model.features.length} weather inputs: wind, sun and temperature in 4 regions`
    : `${n(model.featureCount)} live grid signals into ${model.estimators.length} gradient-boosted models${mlOff ? ' · MWh from a trend baseline' : ''}`;
  const warn = caveats.length ? `<details class="fx-caveats" data-fx-caveats="${kind}"${fx.caveatsOpen[kind] ? ' open' : ''}><summary>${fxIcon('alert', 15)}${caveats.length} caveat${caveats.length === 1 ? '' : 's'}</summary><div class="fx-caveats-panel"><strong>From the model's own report</strong><ul>${caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div></details>` : '';
  return `<section class="dash-card fx-card fx-about">${fxHead('info', 'green', `About the ${daily ? 'daily' : 'short-term'} model`, `${version}${model.experimental ? ' · experimental' : ''} · trained on past data`, warn)}
    <p class="fx-about-what">${what}</p>
    <p class="fx-about-inputs" title="${daily ? 'Regions: West (Galway), South (Cork), East (Dublin), North (Belfast); plus season and weekend' : 'ENTSO-E generation, load and price; EirGrid wind, solar, SNSP and interconnectors, plus lags and rolling statistics'}">${fxIcon('pulse', 15)}<span>${inputs}</span></p>
    ${chartSlot(daily ? 'fxTimeDaily' : 'fxTimeShort', 'Training, validation and test periods, with the selected date marked', 'fx-timeline')}
  </section>`;
}

function fxProvenance(kind) {
  const s = fx[kind], version = s.info?.model.version ? `v${escapeHtml(String(s.info.model.version).replace(/^v/, ''))}` : '';
  const text = kind === 'daily'
    ? `Historical replay: the GridToEv daily model ${version} was re-run for this past date using the weather forecast archived for it, then compared with what EirGrid observed. It is not a forecast of the future.`
    : `Historical replay: the GridToEv short-term model ${version} was re-run on archived grid data for this past half-hour, then compared with what EirGrid observed. It is not a live forecast.`;
  return `<p class="studio-provenance fx-provenance">${text}</p>`;
}

function fxSkeleton(message) {
  const kpi = '<article class="dash-card fx-kpi is-skeleton"><span class="fx-skel-block"></span><span class="fx-skel-line"></span><span class="fx-skel-line is-short"></span></article>';
  const card = (cls) => `<section class="dash-card fx-card ${cls} is-skeleton"><span class="fx-skel-line"></span><span class="fx-skel-line is-short"></span><span class="fx-skel-fill"></span></section>`;
  return `<div class="fx-layout is-loading" aria-busy="true"><section class="fx-kpis">${kpi.repeat(4)}</section>${card('fx-main')}${card('fx-side')}${card('fx-accuracy')}${card('fx-about')}</div>
    <p class="studio-provenance fx-provenance" role="status"><span class="fx-busy is-on"><i></i>${message}</span> A sleeping hosted service can take up to a minute to wake.</p>`;
}
function fxErrorCard(message, retry) {
  return `<section class="dash-card fx-error" role="alert"><span class="fx-error-icon">${fxIcon('alert', 28)}</span><h2>The model couldn't answer</h2><p>${escapeHtml(message)}</p><button class="studio-button" type="button" data-fx-retry="${retry}">Try again ${icon('arrow', 17)}</button></section>`;
}

// How the model did across the week (daily) or the replayed day (short-term). Side cards show these
// only when they are tall enough (container query in the CSS), so the 1440×900 layout never overflows.
function fxWeekRecord() {
  const days = fxWeekDays();
  if (!days.length) return '';
  const scored = days.map((d) => {
    const event = d.actual?.event, known = event !== null && event !== undefined;
    return { date: d.date, state: known ? ((d.probability >= 0.5) === Boolean(event) ? 'right' : 'wrong') : 'pending', miss: fxHas(d.actual?.curtailmentMwh) ? Math.abs(d.predictedMwh - d.actual.curtailmentMwh) : null };
  });
  const known = scored.filter((d) => d.state !== 'pending'), right = known.filter((d) => d.state === 'right').length;
  const misses = scored.filter((d) => d.miss !== null), mae = misses.length ? misses.reduce((sum, d) => sum + d.miss, 0) / misses.length : null;
  const chips = scored.map((d) => `<li class="is-${d.state}${d.date === fx.daily.date ? ' is-selected' : ''}" title="${fxDateLabel(d.date)}: ${d.state === 'right' ? 'right call' : d.state === 'wrong' ? 'wrong call' : 'not observed yet'}">${fxIcon(d.state === 'right' ? 'check' : d.state === 'wrong' ? 'cross' : 'wait', 18)}<b>${fxWeekday(d.date).slice(0, 2)}</b></li>`).join('');
  return `<div class="fx-qa fx-record-block"><p class="fx-qa-q"><span>✓</span>The week's calls<em class="is-exact">${right} of ${known.length} right</em></p>
    <ul class="fx-record">${chips}</ul><p class="fx-note">${mae === null ? 'No observed figures this week yet.' : `Typical miss this week: ${fxMwh(mae)} MWh a day.`}</p></div>`;
}
function fxDayRecord() {
  const d = fxDaySeries();
  const cells = d.pred.map((v, i) => {
    if (!fxHas(v) || !fxHas(d.obs[i])) return 'none';
    return !settings.uncertainty || (d.obs[i] >= d.lo[i] && d.obs[i] <= d.hi[i]) ? 'in' : 'out';
  });
  const scored = cells.filter((c) => c !== 'none');
  if (!scored.length) return '';
  const inside = scored.filter((c) => c === 'in').length;
  const misses = d.pred.map((v, i) => (fxHas(v) && fxHas(d.obs[i]) ? Math.abs(v - d.obs[i]) : null)).filter(fxHas);
  const mae = misses.reduce((sum, v) => sum + v, 0) / misses.length;
  const strip = cells.map((c, i) => `<i class="is-${c}${i === d.sel ? ' is-selected' : ''}"></i>`).join('');
  return `<div class="fx-block fx-record-block"><p class="fx-block-head"><b>Across this day</b><span>${settings.uncertainty ? `${inside} of ${scored.length} half-hours in range` : `${scored.length} half-hours scored`}</span></p>
    <div class="fx-strip" aria-hidden="true">${strip}</div><p class="fx-note">Typical miss today: ${fxMwh(mae, 1)} MWh per half-hour at +${fx.short.horizon} min.</p></div>`;
}

// ---------------------------------------------------------------- daily view
function fxDailyView() {
  const s = fx.daily;
  if (s.infoError) return fxErrorCard(s.infoError, 'info');
  if (s.info && s.error && !s.result) return fxErrorCard(s.error, 'daily');
  if (!s.info || !s.result) return fxSkeleton(s.info ? 'Predicting the selected day…' : 'Loading the daily model…');
  const r = s.result, a = r.actual, obs = a.curtailmentMwh, likely = r.probability >= 0.5;
  const happened = a.event === null || a.event === undefined ? null : Boolean(a.event);
  const call = happened === null ? 'pending' : happened === likely ? 'right' : 'wrong';
  const diff = fxHas(obs) ? r.predictedMwh - obs : null, rel = diff === null || !obs ? null : diff / obs;
  const level = r.probability >= 0.7 ? 'high' : r.probability >= 0.4 ? 'medium' : 'low';
  const exact = diff !== null && Math.round(Math.abs(diff)) === 0;
  const errPill = diff === null ? '' : exact ? '<span class="fx-pill is-good">spot on</span>' : `<span class="fx-pill is-${rel !== null && Math.abs(rel) <= 0.2 ? 'good' : 'warn'}">${rel === null ? 'too ' : `${Math.round(Math.abs(rel) * 100)}% `}${diff > 0 ? 'high' : 'low'}</span>`;
  const kpis = `<section class="fx-kpis" aria-label="Selected day at a glance">
    ${fxKpi('orange', 'pulse', 'Chance of curtailment', 'fxDProb', `Chance of curtailment: ${fxPercent(r.probability)}`, `<span class="fx-pill is-${level}">${likely ? 'Likely' : 'Unlikely'}</span><em>for this day</em>`, chartSlot('fxDProbRing', 'Chance of curtailment gauge', 'fx-kpi-ring'))}
    ${fxKpi('amber', 'forecast', 'Predicted curtailment', 'fxDPred', `Predicted curtailment: ${fxMwh(r.predictedMwh)} MWh`, '<em>total for the UTC day</em>', chartSlot('fxDPredSpark', 'Predicted curtailment across the week', 'fx-kpi-spark'))}
    ${fxKpi('green', 'eye', 'Observed curtailment', 'fxDObs', `Observed curtailment: ${fxMwh(obs)} MWh`, `<em>${fxHas(obs) ? 'measured by EirGrid' : a.status === 'pending' ? 'EirGrid figure pending' : 'no EirGrid figure'}</em>`, chartSlot('fxDObsSpark', 'Observed curtailment across the week', 'fx-kpi-spark'))}
    ${fxKpi('blue', 'target', 'Forecast error', 'fxDErr', `Forecast error: ${diff === null ? 'unknown' : `${fxMwh(Math.abs(diff))} MWh`}`, diff === null ? '<em>needs an observed figure</em>' : `${errPill}<em>vs observed</em>`, fxBadge(call, call === 'right' ? 'Called it' : call === 'wrong' ? 'Missed it' : 'Pending'))}
  </section>`;
  const days = fxWeekDays();
  const hits = days.map((d) => {
    const o = d.actual?.curtailmentMwh, sel = d.date === s.date;
    return `<button type="button" class="fx-week-hit${sel ? ' is-selected' : ''}" data-fx-day="${d.date}" data-fx-in-week aria-pressed="${sel}" aria-label="${fxDateLabel(d.date)}: predicted ${fxMwh(d.predictedMwh)} MWh, observed ${fxMwh(o)} MWh, ${fxPercent(d.probability)} chance of curtailment">
      <span class="fx-tip" aria-hidden="true"><b>${fxDateLabel(d.date)}</b><span><i class="is-pred"></i>Predicted<strong>${fxMwh(d.predictedMwh)} MWh</strong></span><span><i class="is-obs"></i>Observed<strong>${fxMwh(o)} MWh</strong></span><span><i class="is-chance"></i>Chance<strong>${fxPercent(d.probability)}</strong></span></span></button>`;
  }).join('');
  const week = `<section class="dash-card fx-card fx-main">
    ${fxHead('forecast', 'amber', 'Predicted vs observed, day by day', 'MWh of renewable energy curtailed per UTC day, for the week around your day · click a day to open it')}
    ${fxLegend([['pred', 'Predicted'], ['obs', 'Observed (EirGrid)'], ['chance', 'Chance of any curtailment'], ['day', 'Your day']])}
    <div class="fx-week-wrap">${chartSlot('fxWeek', 'Predicted and observed curtailment for each day of the week', 'fx-week-chart')}<div class="fx-week-hits" style="grid-template-columns:repeat(${days.length || 7},minmax(0,1fr))">${hits}</div></div>
  </section>`;
  const issued = escapeHtml((r.issuedAt || 'T00:00').slice(11, 16)), weather = escapeHtml(fxClock(r.weatherAvailableAt || 'T18:00'));
  const side = `<section class="dash-card fx-card fx-side">
    ${fxHead('calendar', 'green', fxDateLabel(r.date), `Made ${issued} UTC from day-ahead weather`, fxSplitChip(r.partition))}
    <div class="fx-qa"><p class="fx-qa-q"><span>1</span>Would there be any curtailment?</p>
      <div class="fx-qa-row"><div class="fx-qa-cell"><small>Model said</small><strong>${likely ? 'Likely' : 'Unlikely'}</strong><em>${fxPercent(r.probability)} chance</em></div>
        <span class="fx-qa-arrow" aria-hidden="true">${icon('arrow', 16)}</span>
        <div class="fx-qa-cell"><small>EirGrid saw</small><strong>${happened === null ? (a.status === 'pending' ? 'Pending' : 'No data') : happened ? 'Curtailment' : 'None'}</strong><em>${fxHas(obs) ? `${fxMwh(obs)} MWh` : '—'}</em></div>
        <span class="fx-verdict is-${call}">${fxIcon(call === 'right' ? 'check' : call === 'wrong' ? 'cross' : 'wait', 18)}${call === 'right' ? 'Right call' : call === 'wrong' ? 'Wrong call' : 'Pending'}</span></div></div>
    <div class="fx-qa"><p class="fx-qa-q"><span>2</span>How much?${diff === null ? '' : exact ? '<em class="is-exact">spot on</em>' : `<em class="is-${diff > 0 ? 'high' : 'low'}">${diff > 0 ? '+' : '−'}${fxMwh(Math.abs(diff))} MWh</em>`}</p>
      ${chartSlot('fxDCompare', `Predicted ${fxMwh(r.predictedMwh)} MWh, observed ${fxMwh(obs)} MWh`, 'fx-compare')}
      <p class="fx-note" title="Weather forecasts published by ${weather} UTC the day before">Forecast = chance × likely size, so it runs low on big days.</p></div>
    ${fxWeekRecord()}
  </section>`;
  return `<div class="fx-layout${s.loading ? ' is-updating' : ''}">${kpis}${week}${side}${fxAccuracyCard('daily')}${fxAboutCard('daily')}</div>${fxProvenance('daily')}`;
}

// ---------------------------------------------------------------- short-term view
function fxShortView() {
  const s = fx.short;
  if (s.infoError) return fxErrorCard(s.infoError, 'info');
  if (s.info && s.error && !s.result) return fxErrorCard(s.error, 'short');
  if (!s.info || !s.result) return fxSkeleton(s.info ? 'Predicting the selected half-hour…' : 'Loading the short-term model…');
  const r = s.result, p = fxShortPred(s.horizon) || r.predictions[0], obs = fxShortObs();
  const diff = fxHas(obs) ? p.atRiskMwh - obs : null;
  const inRange = diff === null ? null : obs >= p.lowerMwh && obs <= p.upperMwh;
  const horizonKpi = (h) => {
    const x = fxShortPred(h);
    return fxKpi(h === 30 ? 'orange' : 'amber', 'clock', `+${h} min forecast`, `fxS${h}`, `+${h} minute forecast: ${x ? `${fxMwh(x.atRiskMwh, 1)} MWh` : 'none'}`,
      x ? `<span class="fx-pill is-${escapeHtml(x.risk)}">${fxPercent(x.probability)} chance</span><em>made ${fxIssueLabel(x.issuedAt, s.date)}</em>` : '<em>no forecast for this time</em>',
      chartSlot(`fxS${h}Range`, `+${h} minute forecast range`, 'fx-kpi-range'));
  };
  const errState = inRange === null ? 'pending' : inRange ? 'right' : 'wrong';
  const kpis = `<section class="fx-kpis" aria-label="Selected half-hour at a glance">
    ${horizonKpi(30)}${horizonKpi(60)}
    ${fxKpi('green', 'eye', `Observed at ${fxClock(r.targetAt)}`, 'fxSObs', `Observed: ${fxMwh(obs, 1)} MWh`, `<em>${fxHas(obs) ? 'EirGrid measurement' : r.actual?.status === 'pending' ? 'EirGrid figure pending' : 'no EirGrid figure'}</em>`, chartSlot('fxSObsSpark', 'Observed dispatch-down through the day', 'fx-kpi-spark'))}
    ${fxKpi('blue', 'target', `Forecast error · +${p.horizonMinutes} min`, 'fxSErr', `Forecast error: ${diff === null ? 'unknown' : `${fxMwh(Math.abs(diff), 1)} MWh`}`, diff === null ? '<em>needs an observed figure</em>' : (Math.abs(diff) < 0.05 ? '<span class="fx-pill is-good">spot on</span>' : `<span class="fx-pill is-${inRange ? 'good' : 'warn'}">${obs > 0 ? `${Math.round(Math.abs(diff / obs) * 100)}% ` : 'too '}${diff > 0 ? 'high' : 'low'}</span>`) + '<em>vs observed</em>', fxBadge(errState, inRange === null ? 'Pending' : inRange ? 'In range' : 'Outside range'))}
  </section>`;
  const d = fxDaySeries(), sel = d.sel, replay = fxReplay(), fast = s.observed[s.date];
  const replayStatus = replay?.status === 'error' && fast?.status === 'ok'
    ? `<p class="fx-plot-status is-error" role="alert" title="${escapeHtml(replay.error)}">${fxIcon('alert', 14)}<span>Forecast replay failed</span><button type="button" class="fx-reload" data-fx-reload="day">Retry</button></p>`
    : replay?.status !== 'ok' && fast?.status === 'ok' ? `<p class="fx-plot-status" role="status" title="The model is re-running this day; it takes about 15 seconds">${'<i></i>'}Replaying the +${s.horizon} min forecast…</p>` : '';
  const selText = sel >= 0 ? `${fxClock(s.target)}: predicted ${fxMwh(d.pred[sel], 1)} MWh, observed ${fxMwh(d.obs[sel], 1)} MWh` : 'No half-hour selected on this day';
  const seg = `<div class="fx-seg" role="group" aria-label="Forecast horizon">${[30, 60].map((h) => `<button type="button" data-fx-horizon="${h}" aria-pressed="${s.horizon === h}" class="${s.horizon === h ? 'is-active' : ''}">+${h} min</button>`).join('')}</div>`;
  const chart = `<section class="dash-card fx-card fx-main">
    ${fxHead('pulse', 'amber', 'Forecast vs reality through the day', `MWh switched off per half-hour on ${fxDateLabel(s.date)} · click to pick a time`, seg)}
    <div class="fx-legend-row">${fxLegend([['pred', `Predicted (+${s.horizon} min)`], ['obs', 'Observed'], ...(settings.uncertainty ? [['band', 'Likely range']] : []), ['sel', 'Your half-hour']])}${replayStatus}</div>
    <div class="fx-plot" data-fx-plot="${escapeHtml(s.date)}" tabindex="0" role="slider" aria-label="Half-hour on ${fxDateLabel(s.date)}. Use the arrow keys to move." aria-valuemin="0" aria-valuemax="47" aria-valuenow="${Math.max(0, sel)}" aria-valuetext="${escapeHtml(selText)}">
      ${chartSlot('fxDay', `Predicted and observed dispatch-down for each half-hour of ${fxDateLabel(s.date)}, ${s.horizon} minutes ahead`, 'fx-day-chart')}
      <div class="fx-hover" aria-hidden="true"><i class="fx-hover-line"></i><i class="fx-hover-dot is-pred"></i><i class="fx-hover-dot is-obs"></i><div class="fx-tip"></div></div>
    </div>
  </section>`;
  const side = `<section class="dash-card fx-card fx-side">
    ${fxHead('clock', 'green', `${fxClock(r.targetAt)} half-hour`, `+${p.horizonMinutes} min forecast, made at ${fxIssueLabel(p.issuedAt, s.date)} UTC`, `<span class="fx-risk is-${escapeHtml(p.risk)}">${escapeHtml(p.risk)} risk</span>`)}
    <div class="fx-block"><p class="fx-block-head"><b>${settings.uncertainty ? 'Forecast and likely range' : 'Forecast'}</b><span>${settings.uncertainty ? '8 in 10 outcomes land in the band' : 'median estimate'}</span></p>
      ${chartSlot('fxSRange', `Forecast ${fxMwh(p.atRiskMwh, 1)} MWh, likely range ${fxMwh(p.lowerMwh)} to ${fxMwh(p.upperMwh)} MWh, observed ${fxMwh(obs, 1)} MWh`, 'fx-srange')}</div>
    <div class="fx-block fx-cause"><p class="fx-block-head"><b>Why it gets switched off</b><span>${fxPercent(p.probability)} chance it happens</span></p>
      ${chartSlot('fxSSplit', `Grid constraint ${fxMwh(p.constraintMwh, 1)} MWh and curtailment ${fxMwh(p.curtailmentMwh, 1)} MWh`, 'fx-split')}</div>
    ${fxDayRecord()}
    <p class="fx-absorb" title="min(forecast, capacity × 0.5 h), with the capacity set on the Dashboard. ${typeof RECOVERY_CAVEAT === 'string' ? escapeHtml(RECOVERY_CAVEAT) : ''}">${icon('charge', 17)}<span>Upper bound <b>${fxMwh(p.recoverableMwh, 1)} MWh</b> for ${n(r.capacityMw)} MW of flexible load</span></p>
  </section>`;
  return `<div class="fx-layout${s.loading ? ' is-updating' : ''}">${kpis}${chart}${side}${fxAccuracyCard('short')}${fxAboutCard('short')}</div>${fxProvenance('short')}`;
}

function renderForecast() {
  const s = fx[fx.model];
  if (!s.info && !s.infoLoading && !s.infoError) queueMicrotask(() => fxLoadInfo(fx.model));
  return `${studioHeader('Forecast', 'Replay a model on a past day and compare its forecast with what actually happened.')}
  ${fxToolbar()}
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
  fx.picker = { month: day.slice(0, 7) }; // keep open so a time can be chosen
  fxSelectShort(times.includes(sameClock) ? sameClock : times[0]);
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
// The half-hour under the pointer on the day chart, or -1 when the pointer is off the plot.
function fxPlotIndex(plot, clientX) {
  const area = plot.querySelector('.fx-day-area');
  if (!area) return -1;
  const box = area.getBoundingClientRect(), f = (clientX - box.left) / box.width;
  return f < -0.03 || f > 1.03 ? -1 : Math.min(47, Math.max(0, Math.round(f * 47)));
}
function fxHover(plot, i) {
  const layer = plot.querySelector('.fx-hover'), d = fxDaySeries();
  if (!layer) return;
  if (i < 0 || !d.pred.length) { plot.classList.remove('is-hovering'); return; }
  const at = (v) => `${((1 - Math.max(0, v) / fxDayMax) * 100).toFixed(2)}%`, x = `${((i / 47) * 100).toFixed(2)}%`;
  const [line, predDot, obsDot] = layer.querySelectorAll('i'), tip = layer.querySelector('.fx-tip');
  line.style.left = x;
  predDot.style.cssText = fxHas(d.pred[i]) ? `left:${x};top:${at(d.pred[i])}` : 'display:none';
  obsDot.style.cssText = fxHas(d.obs[i]) ? `left:${x};top:${at(d.obs[i])}` : 'display:none';
  const clock = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  const range = settings.uncertainty && fxHas(d.lo[i]) ? `<small>likely ${fxMwh(d.lo[i])}–${fxMwh(d.hi[i])}</small>` : '';
  tip.innerHTML = `<b>${clock} half-hour</b><span><i class="is-pred"></i>Predicted<strong>${fxMwh(d.pred[i], 1)} MWh</strong></span>${range}<span><i class="is-obs"></i>Observed<strong>${fxMwh(d.obs[i], 1)} MWh</strong></span>${d.issued[i] ? `<small>made ${fxIssueLabel(d.issued[i], d.date)} UTC · click to open</small>` : '<small>no forecast for this time</small>'}`;
  tip.style.left = x;
  tip.classList.toggle('is-left', i > 30);
  plot.classList.add('is-hovering');
}

document.addEventListener('click', (event) => {
  if (pageFromHash() !== 'forecast') return;
  const t = event.target, pick = (attr) => t.closest(`[${attr}]`);
  let el;
  fxFocusNext = null;
  if ((el = pick('data-fx-model'))) {
    if (fx.model === el.dataset.fxModel) return;
    fx.model = el.dataset.fxModel; fx.picker = null;
    try { localStorage.setItem('forecast-model', fx.model); } catch {}
    fxRender(); return;
  }
  if (pick('data-fx-picker')) { if (fx.picker) fx.picker = null; else fxOpenPicker(); fxRender(); return; }
  if (pick('data-fx-close')) { fx.picker = null; fxRender(); return; }
  if ((el = pick('data-fx-month'))) { fx.picker.month = fxShiftMonth(fx.picker.month, Number(el.dataset.fxMonth)); fxRender(); return; }
  if ((el = pick('data-fx-year'))) {
    const s = fx[fx.model], year = el.dataset.fxYear, first = (s.targets?.[0] || s.info.dataset.from).slice(0, 7), last = (s.targets?.at(-1) || s.info.dataset.to).slice(0, 7);
    const month = `${year}-${fx.picker.month.slice(5)}`;
    fx.picker.month = month < first ? first : month > last ? last : month; fxRender(); return;
  }
  if ((el = pick('data-fx-quick'))) { fxQuick(el.dataset.fxQuick); return; }
  if ((el = pick('data-fx-target'))) { fx.picker = null; fxSelectShort(el.dataset.fxTarget); return; }
  if ((el = pick('data-fx-day'))) { if ('fxInWeek' in el.dataset) fxSelectDaily(el.dataset.fxDay, true); else fxChooseDay(el.dataset.fxDay); return; }
  if ((el = pick('data-fx-step'))) { fxStep(Number(el.dataset.fxStep)); return; }
  if ((el = pick('data-fx-horizon'))) { fx.short.horizon = Number(el.dataset.fxHorizon); fxEnsureReplay(fx.short.date, fx.short.horizon); fxRender(); return; }
  if ((el = pick('data-fx-reload'))) {
    const s = fx.short;
    if (el.dataset.fxReload === 'week') fxLoadWeek(fx.daily.date);
    else { if (s.observed[s.date]?.status === 'error') fxLoadObserved(s.date); fxEnsureReplay(s.date, s.horizon); fxRender(); }
    return;
  }
  if ((el = pick('data-fx-plot'))) {
    const i = fxPlotIndex(el, event.clientX), day = el.dataset.fxPlot;
    const target = i < 0 ? null : `${day}T${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00Z`;
    if (target && fx.short.byDate?.get(day)?.includes(target) && target !== fx.short.target) fxSelectShort(target);
    return;
  }
  if ((el = pick('data-fx-retry'))) {
    const s = fx[fx.model];
    if (el.dataset.fxRetry === 'info') { s.infoError = ''; fxLoadInfo(fx.model); }
    else if (fx.model === 'daily') fxSelectDaily(s.date, true); else fxSelectShort(s.target);
    return;
  }
  if (fx.picker && !t.closest('.fx-picker-anchor')) { fx.picker = null; fxRender(); }
});
document.addEventListener('pointermove', (event) => {
  if (pageFromHash() !== 'forecast') return;
  const plot = event.target.closest?.('[data-fx-plot]');
  document.querySelectorAll('main [data-fx-plot].is-hovering').forEach((p) => { if (p !== plot) p.classList.remove('is-hovering'); });
  if (plot) fxHover(plot, fxPlotIndex(plot, event.clientX));
});
// <details> toggle does not bubble, so listen in the capture phase.
document.addEventListener('toggle', (event) => {
  const kind = event.target.dataset?.fxCaveats;
  if (kind) fx.caveatsOpen[kind] = event.target.open;
}, true);
document.addEventListener('keydown', (event) => {
  if (pageFromHash() !== 'forecast') return;
  if (event.key === 'Tab') fxFocusNext = null;
  if (event.key === 'Escape' && fx.picker) { fx.picker = null; fxRender(); document.querySelector('[data-fx-picker]')?.focus(); return; }
  if (event.target.matches?.('[data-fx-plot]')) {
    const s = fx.short, day = event.target.dataset.fxPlot, times = s.byDate?.get(day) || [];
    const moves = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (event.key in moves) { event.preventDefault(); fxFocusNext = ['data-fx-plot', null, false]; fxStep(moves[event.key]); }
    else if ((event.key === 'Home' || event.key === 'End') && times.length) { event.preventDefault(); fxSelectShort(event.key === 'Home' ? times[0] : times.at(-1)); }
    return;
  }
  // Arrow keys on the week chart move to the neighbouring day of the one in focus.
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target.matches?.('[data-fx-in-week]')) {
    event.preventDefault();
    const s = fx.daily, next = fxAddDays(event.target.dataset.fxDay, event.key === 'ArrowLeft' ? -1 : 1);
    if (!s.info || next < s.info.dataset.from || next > s.info.dataset.to) return;
    fxFocusNext = ['data-fx-day', next, true];
    fxSelectDaily(next, true);
  }
});
