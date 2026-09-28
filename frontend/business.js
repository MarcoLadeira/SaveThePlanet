// Impact page: who saves and who earns when our AI finds cheaper energy, for a simulated site.
// Every figure comes from /api/v1/business/impact (backend/business.py and backend/offers.py), replayed
// on the same nights of Carlson's historical GridToEv forecasts, in two views so that one screen tells
// one story:
//  - "Who earns" (per month): the discount-window business case. KPIs, where the € goes (a what-if the
//    server answers: /api/v1/business/offers/estimate) with both profit bridges, and the energy proof.
//  - "Depot savings" (per year): the depot's normal / basic smart / AI comparison, its waterfall and
//    the investment case.
// The page draws the backend's figures and never recomputes them.
const bz = {
  status: 'idle', // idle | loading | preparing | ready | empty | failed
  result: null, progress: null, error: '', token: 0, timer: null, inFlight: false,
  progressSince: null, // {at, done, total}: when this page first saw the build's progress, for the time left
  metric: 'money', // comparison chart: money | co2 | renewable
  view: 'earn', // earn: who earns, per month | depot: the depot's savings, per year
  // view: which inputs show (main | costs)
  calc: { values: null, errors: {}, view: 'main', result: null, seq: 0, pending: false, error: '', timer: null },
};
try { const m = localStorage.getItem('impact-metric'); if (['money', 'co2', 'renewable'].includes(m)) bz.metric = m; } catch {}
try { const v = localStorage.getItem('impact-view'); if (['earn', 'depot'].includes(v)) bz.view = v; } catch {}

const bzGlyphs = {
  euro: '<path d="M17.5 6.3A7 7 0 1 0 17.5 17.7"/><path d="M4 10.2h9M4 13.8h9"/>',
  spark: '<path d="M12 3.5 13.9 10 20.5 12l-6.6 2L12 20.5 10.1 14 3.5 12l6.6-2Z"/>',
  hourglass: '<path d="M6.5 3h11M6.5 21h11M7.5 3c0 5 4.5 6 4.5 9s-4.5 4-4.5 9M16.5 3c0 5-4.5 6-4.5 9s4.5 4 4.5 9"/>',
  building: '<path d="M4 21V8l6-4v17M10 21h10V11l-6-2"/><path d="M7 11v.2M7 15v.2M14 13v.2M17 13v.2M14 17v.2M17 17v.2"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7h7M8.5 11.5h.2M12 11.5h.2M15.5 11.5h.2M8.5 15h.2M12 15h.2M15.5 15h.2M8.5 18h.2M12 18h3.5"/>',
  alert: '<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5M12 17.2v.2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  cross: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m8.6 8.6 6.8 6.8m0-6.8-6.8 6.8" stroke="#fff"/>',
  split: '<circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4M12 12l-6.4 6.4"/>',
  tick: '<path d="m5.5 12.5 4.2 4.2L18.5 8" stroke-width="3"/>',
};
function bzIcon(name, size = 20) {
  return bzGlyphs[name]
    ? `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${bzGlyphs[name]}</svg>`
    : icon(name, size);
}

// ---------------------------------------------------------------- formatting
const bzHas = (v) => v !== null && v !== undefined && Number.isFinite(v);
function bzEur(v, sign = false) {
  if (!bzHas(v)) return '—';
  const r = Math.round(v);
  return `${r < 0 ? '−' : sign && r > 0 ? '+' : ''}€${n(Math.abs(r))}`;
}
// Euros and cents: the settlement ledger is exact to the cent, so its parts always add up on screen.
const bzCentsFormat = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function bzCents(v, sign = false) {
  if (!bzHas(v)) return '—';
  const c = Math.round(v * 100);
  return `${c < 0 ? '−' : sign && c > 0 ? '+' : ''}€${bzCentsFormat.format(Math.abs(c) / 100)}`;
}
function bzShortEur(v) {
  const a = Math.abs(v);
  return a >= 1e6 ? `€${n(Math.round(v / 1e5) / 10)}m` : a >= 1e3 ? `€${n(Math.round(v / 100) / 10)}k` : `€${n(Math.round(v))}`;
}
// Tonnes to exactly one decimal, with a true minus sign (Intl gives a hyphen).
const bzOneDecimal = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const bzT = (v) => (bzHas(v) ? `${Math.round(v * 10) < 0 ? '−' : ''}${bzOneDecimal.format(Math.abs(Math.round(v * 10) / 10))}` : '—');
function bzMonths(v) { return v < 1 ? 'under a month' : `${n(Math.round(v * 10) / 10)} months`; }
function bzDay(day, year = false) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }).format(new Date(`${day}T00:00:00Z`));
}
function bzPeriod(p) {
  const a = p.from, b = p.to, sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return sameMonth ? `${Number(a.slice(8))}–${bzDay(b, true)}` : `${bzDay(a)} – ${bzDay(b, true)}`;
}
// A profit is green, a loss red and zero neutral: a loss is never coloured as profit.
const bzTone = (v) => (!bzHas(v) || Math.round(v * 100) === 0 ? 'zero' : v > 0 ? 'profit' : 'loss');
// Round axis: 3-5 ticks with little headroom (same rule as the Forecast page).
function bzScale(peak) {
  const top = Math.max(peak, 1) * 1.04, base = 10 ** Math.floor(Math.log10(top / 5));
  let best = { max: top, step: top / 4 };
  for (const mult of [1, 2, 2.5, 5, 10, 20, 25, 50]) {
    for (const count of [3, 4, 5]) {
      const max = base * mult * count;
      if (max >= top && (best.max === top || max < best.max)) best = { max, step: base * mult };
    }
  }
  return best;
}

// ---------------------------------------------------------------- data
async function bzFetch(path, timeout = 20000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, body };
  } finally { clearTimeout(timer); }
}
// Loads (or polls) the result. A newer call replaces an older one: late answers are ignored.
// While the server prepares, each poll only updates the loading card, so its animations keep running.
async function bzLoad(refresh = false) {
  const token = ++bz.token;
  clearTimeout(bz.timer); bz.timer = null;
  if (!bz.result || refresh) {
    const polling = bz.status === 'preparing';
    bz.status = polling ? 'preparing' : 'loading';
    if (refresh) bz.result = null;
    if (!polling || !bzProgressPaint()) bzRender();
  }
  bz.inFlight = true;
  let next;
  try {
    const { status, ok, body } = await bzFetch(`/api/v1/business/impact${refresh ? '?refresh=1' : ''}`);
    if (token !== bz.token) return;
    if (status === 202) next = { status: 'preparing', progress: body.progress || null };
    else if (!ok) next = { status: 'failed', error: body.error?.message || 'The impact calculation failed.' };
    else if (body.status === 'empty') next = { status: 'empty', result: body };
    else if (body.status === 'ready' && body.kpis && body.discountWindows) next = { status: 'ready', result: body };
    else next = { status: 'failed', error: 'The impact result was incomplete.' };
  } catch (error) {
    if (token !== bz.token) return;
    next = { status: 'failed', error: error.name === 'AbortError' ? 'The server took too long to answer.' : 'Could not reach the SaveThePlanet server.' };
  }
  bz.inFlight = false;
  const polled = bz.status === 'preparing' && next.status === 'preparing';
  Object.assign(bz, next);
  bzTrackProgress(Date.now());
  if (bz.status === 'preparing') bz.timer = setTimeout(() => { bz.timer = null; if (pageFromHash() === 'business') bzLoad(); }, 1500);
  if (bz.status === 'ready' && bz.calc.values === null) bzPreset('expected');
  if (polled && bzProgressPaint()) return;
  bzRender();
}
// The first progress this page saw, so the replay's time left can be estimated from the days done
// since. A build that starts again (a retry) starts the estimate again.
function bzTrackProgress(now) {
  const p = bz.progress, since = bz.progressSince;
  if (bz.status !== 'preparing' || !p) bz.progressSince = null;
  else if (!since || p.done < since.done || p.total !== since.total) bz.progressSince = { at: now, done: p.done, total: p.total };
}

// Re-render and put keyboard focus back where it was, since render() rebuilds <main>.
const BZ_FOCUS = ['data-bz-metric', 'data-bz-view', 'data-bz-costs', 'data-bz-retry', 'data-bz-input', 'data-bz-preset'];
function bzRender() {
  if (pageFromHash() !== 'business') return;
  const el = document.activeElement, attr = el && BZ_FOCUS.find((a) => el.hasAttribute?.(a));
  const want = attr ? [attr, el.getAttribute(attr), el.selectionStart ?? null] : null;
  render();
  if (!want) return;
  const next = [...document.querySelectorAll(`main [${want[0]}]`)].find((x) => x.getAttribute(want[0]) === want[1]) || document.querySelector(`main [${want[0]}]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (want[2] !== null && next.setSelectionRange) try { next.setSelectionRange(want[2], want[2]); } catch {}
}

// ---------------------------------------------------------------- engine charts
function bzChart(name, chart) { dashCharts[name] = { standalone: true, ...chart }; }
const bzR = () => bz.result;
const bzD = () => bz.result?.discountWindows;

// Animated KPI figures; money counts up in whole euros.
function bzFigure(name, get) {
  bzChart(name, {
    values: () => { const f = get(); return { v: bzHas(f?.v) ? f.v : 0, kind: f?.kind || 'none', text: f?.text || '' }; },
    start: (t) => ({ ...t, v: 0 }),
    draw({ v, kind, text }) {
      if (kind === 'text') return `<strong class="is-text">${text}</strong>`;
      if (kind === 'eur') return `<strong>${bzEur(v)}<small>/year</small></strong>`;
      if (kind === 'month') return `<strong>${bzEur(v)}<small>/month</small></strong>`;
      return '<strong>—</strong>';
    },
  });
}
bzFigure('bzExtra', () => bzD() && { v: bzD().kpis.aiExtraSavingsEur, kind: 'month' });
bzFigure('bzDrivers', () => bzD() && { v: bzD().kpis.driversSavedEur, kind: 'month' });
bzFigure('bzOperator', () => bzD() && { v: bzD().kpis.operatorProfitEur, kind: 'month' });
bzFigure('bzPlatform', () => bzD() && { v: bzD().kpis.platformProfitEur, kind: 'month' });

// Where the € goes: one stacked bar of the month's extra AI savings, 50 / 25 / 25, named in the bar.
const BZ_PARTS = [['driver', 'Drivers'], ['operator', 'Operator'], ['platform', 'Us']];
function bzParts(m) {
  return { driver: m.driversEur, operator: m.operator.retainedEur, platform: m.platform.grossEur };
}
// The month the card shows: the what-if's latest answer, or the replay until there is one.
const bzShownMonth = () => bz.calc.result?.month || bzD()?.month;
bzChart('bzSplit', {
  values() {
    const m = bzShownMonth();
    if (!m) return { w: [0, 0, 0], amounts: [0, 0, 0], pool: 0, sessions: '0', empty: '1', reveal: 0 };
    const parts = bzParts(m), pool = m.poolEur;
    return {
      w: BZ_PARTS.map(([id]) => (pool > 0 ? Math.max(0, parts[id]) / pool : 0)), amounts: BZ_PARTS.map(([id]) => parts[id]),
      pool, sessions: String(m.sessions), empty: pool > 0 ? '' : '1', reveal: 1,
    };
  },
  start: (t) => ({ ...t, w: t.w.map(() => 0), amounts: t.amounts.map(() => 0), pool: 0, reveal: 0 }),
  draw({ w, amounts, pool, sessions, empty, reveal }) {
    const sum = `<p class="bz-split-sum"><b>${bzCents(pool)}</b><span>extra AI savings a month · ${n(Number(sessions))} sessions</span></p>`;
    if (empty) return `${sum}<div class="bz-split is-empty"><span>No eligible extra savings: nothing to share, no commission.</span></div>`;
    const segs = BZ_PARTS.map(([id, label], i) => `<i class="is-${id}" style="width:${(w[i] * 100).toFixed(2)}%"><b style="opacity:${reveal > 0.85 ? 1 : 0}"><span>${label}</span> ${bzCents(amounts[i])}</b></i>`).join('');
    return `${sum}<div class="bz-split">${segs}</div>`;
  },
});

// Where does the money come from: the depot's yearly cost from normal charging to our AI, step by step.
const BZ_STEP_NOTES = {
  baseline: 'Every van charges as soon as it plugs in, mostly at peak and day prices.',
  timing: 'A simple rule moves charging into the cheapest night hours. No forecast needed.',
  ai: 'Charging moved into half-hours where GridToEv forecast surplus renewable energy.',
  running: 'Example yearly software cost.',
  final: 'Electricity plus software, with our AI.',
};
const BZ_STEP_SHORT = { baseline: 'Normal', timing: 'Timing', ai: 'AI forecast', running: 'Software', final: 'With AI' };
function bzSteps(r) {
  let run = 0;
  return r.waterfall.map((s) => {
    const from = s.kind === 'total' ? 0 : run, to = s.kind === 'total' ? s.valueEur : run + s.valueEur;
    run = to;
    return { id: s.id, label: s.label, kind: s.kind, value: s.valueEur, from, to };
  });
}
bzChart('bzWaterfall', {
  values() {
    const r = bzR();
    if (!r) return { steps: [], axis: '1|1', rise: 0 };
    const steps = bzSteps(r), { max, step } = bzScale(Math.max(...steps.map((s) => Math.max(s.from, s.to)), 0));
    return { steps: steps.map((s) => ({ ...s, value: s.value })), axis: `${max}|${step}`, rise: 1 };
  },
  start: (t) => ({ ...t, rise: 0 }),
  draw({ steps, axis, rise }) {
    if (!steps.length) return '';
    const [max, step] = axis.split('|').map(Number), at = (v) => Math.min(100, Math.max(0, (v / max) * 100));
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => `<span class="bz-tick" style="bottom:${at(i * step)}%"><b>${bzShortEur(i * step)}</b></span>`).join('');
    const count = steps.length;
    const cols = steps.map((s, i) => {
      // Bars grow one after another; each keeps its own share of the rise.
      const grow = Math.min(1, Math.max(0, rise * count * 0.72 - i * 0.62));
      const lo = Math.min(s.from, s.to), hi = Math.max(s.from, s.to), anchor = s.kind === 'total' || s.to >= s.from ? lo : hi;
      const tone = s.kind === 'total' ? (s.id === 'baseline' ? 'is-base' : 'is-final') : s.value > 0 ? 'is-up' : s.value < 0 ? 'is-down' : 'is-zero';
      const bottom = s.kind !== 'total' && s.to < s.from ? at(hi) - (at(hi) - at(lo)) * grow : at(anchor);
      const height = Math.max(s.value === 0 && s.kind !== 'total' ? 0 : 0.6, (at(hi) - at(lo)) * grow);
      const value = s.kind === 'total' ? bzEur(s.value) : bzEur(s.value, true);
      const short = `${s.kind !== 'total' && s.value > 0 ? '+' : s.value < 0 ? '−' : ''}${bzShortEur(Math.abs(s.value))}`;
      const note = s.id === 'ai' && s.value > 0 ? 'The forecast-led plan cost more than the simple rule here.' : BZ_STEP_NOTES[s.id] || '';
      const join = i < count - 1 ? `<i class="bz-join" style="bottom:${at(s.to).toFixed(2)}%;opacity:${grow > 0.98 ? 1 : 0}"></i>` : '';
      const tipSide = i >= Math.floor(count / 2) ? ' is-left' : ''; // right-hand bars open their tip leftwards
      return `<div class="bz-wf-col ${tone}" tabindex="0" aria-label="${escapeHtml(`${s.label}: ${value} a year. ${note}`)}">
        <span class="bz-wf-bar" style="bottom:${bottom.toFixed(2)}%;height:${height.toFixed(2)}%"><em style="opacity:${grow > 0.9 ? 1 : 0}">${short}</em></span>${join}
        <span class="bz-tip${tipSide}" style="bottom:${Math.min(80, Math.max(12, (at(lo) + at(hi)) / 2)).toFixed(1)}%"><b>${escapeHtml(s.label)}</b><strong>${value} a year</strong><small>${escapeHtml(note)}</small></span></div>`;
    }).join('');
    const labels = steps.map((s) => `<span>${escapeHtml(BZ_STEP_SHORT[s.id] || s.label)}</span>`).join('');
    return `<div class="bz-wf"><div class="bz-wf-grid">${ticks}</div><div class="bz-wf-cols" style="grid-template-columns:repeat(${count},minmax(0,1fr))">${cols}</div><div class="bz-wf-x" style="grid-template-columns:repeat(${count},minmax(0,1fr))">${labels}</div></div>`;
  },
});

// Is our AI making a difference: the three strategies on one metric.
const BZ_METRICS = {
  money: { label: 'Money', unit: 'Charging cost per year', better: 'lower', get: (s) => s.annual.costEur, fmt: (v) => bzEur(v) },
  co2: { label: 'CO₂', unit: 'Estimated t CO₂ per year', better: 'lower', get: (s) => s.annual.co2T, fmt: (v) => `${bzT(v)} t` },
  renewable: { label: 'Renewable energy', unit: 'Charging from surplus renewables', better: 'higher', get: (s) => (bzHas(s.annual.renewableShare) ? s.annual.renewableShare * 100 : null), fmt: (v) => (bzHas(v) ? `${Math.round(v)}%` : '—') },
};
// A strategy's change against the one it builds on (basic against normal, our AI against basic), and
// whether that change is an improvement. Changes under 1 keep a decimal, so a small gain never reads as "same".
function bzDelta(metric, value, reference, name) {
  if (!bzHas(value) || !bzHas(reference)) return { text: '', tone: '' };
  const better = BZ_METRICS[metric].better === 'lower' ? -1 : 1;
  const raw = metric === 'renewable' ? value - reference : reference ? ((value - reference) / reference) * 100 : null;
  if (raw === null) return { text: '', tone: '' };
  const d = Math.abs(raw) < 1 ? Math.round(raw * 10) / 10 : Math.round(raw);
  if (!d) return { text: `same as ${name}`, tone: 'same' };
  return { text: `${d > 0 ? '+' : '−'}${n(Math.abs(d))}${metric === 'renewable' ? ' pts' : '%'} vs ${name}`, tone: Math.sign(d) === better ? 'good' : 'bad' };
}
function bzRequirement(req) {
  if (req.allMet) return `<span class="bz-req is-met" title="Every van reached its required charge before it left: van-nights on time">${icon('check', 14)}${n(req.met)}/${n(req.total)} on time</span>`;
  return `<span class="bz-req is-missed" title="Vans that left without their required charge">${bzIcon('cross', 14)}${n(req.total - req.met)} of ${n(req.total)} van-nights short · ${n(Math.round(req.unmetKwh))} kWh</span>`;
}
// Bars travel as fractions of the axis and labels as finished strings, so switching metric glides
// the bars without counting through meaningless mixed-unit numbers.
bzChart('bzCompare', {
  values() {
    const r = bzR(), m = BZ_METRICS[bz.metric];
    if (!r) return { rows: [], deltas: {}, reveal: 0 };
    const vals = r.strategies.map((s) => m.get(s)), peak = Math.max(0, ...vals.filter(bzHas));
    const max = bz.metric === 'renewable' ? 100 : bzScale(peak).max; // a share is always drawn out of 100%
    const of = (id) => vals[r.strategies.findIndex((s) => s.id === id)];
    return {
      rows: r.strategies.map((s, i) => ({ id: s.id, w: bzHas(vals[i]) ? Math.min(1, Math.max(0, vals[i] / max)) : 0, text: bzHas(vals[i]) ? m.fmt(vals[i]) : '—' })),
      deltas: { basic: bzDelta(bz.metric, of('basic'), of('normal'), 'normal'), ai: bzDelta(bz.metric, of('ai'), of('basic'), 'basic') },
      reveal: 1,
    };
  },
  start: (t) => ({ ...t, rows: t.rows.map((row) => ({ ...row, w: 0 })), reveal: 0 }),
  draw({ rows, deltas, reveal }) {
    const r = bzR();
    if (!r || !rows.length) return '';
    const byId = Object.fromEntries(r.strategies.map((s) => [s.id, s]));
    const fade = Math.min(1, Math.max(0, (reveal - 0.55) / 0.4)).toFixed(2); // chips fade in as the bars land
    return rows.map((row) => {
      const s = byId[row.id], w = (row.w * 100).toFixed(2), d = deltas?.[row.id];
      const chip = d?.text ? `<span class="bz-cmp-delta is-${row.id} is-${d.tone}" style="opacity:${fade}">${d.text}</span>` : '';
      return `<div class="bz-cmp-row is-${row.id}">
        <div class="bz-cmp-name"><b>${escapeHtml(s.label)}</b>${chip}${s.requirements.allMet ? '' : bzRequirement(s.requirements)}</div>
        <div class="bz-cmp-track"><i style="width:${w}%"></i><strong style="left:${w}%;opacity:${reveal > 0.85 ? 1 : 0}">${row.text}</strong></div>
      </div>`;
    }).join('');
  },
});

// ---------------------------------------------------------------- calculator
const BZ_FIELDS = {
  // name: [label, min, max, whole number, unit, explanation]
  sessions: ['Qualifying sessions', 0, 100000, true, '/month', 'Sessions that book a discount window and complete. Demand is your assumption; the site caps it.'],
  kwhPerSession: ['Energy per session', 1, 100, false, 'kWh', 'Delivered at the charger. An 11 kW charger gives at most 22 kWh in a two-hour window.'],
  savingEurPerKwh: ['Extra AI saving', 0, 1, false, '€/kWh', 'Versus basic smart charging, net of storage losses, battery wear, network and session costs.'],
  operatorFixedEur: ['Operator programme costs', 0, 1000000, false, '€/month', 'The charging operator\'s remaining fixed costs for the programme.'],
  platformVariableEur: ['Our cost per session', 0, 100, false, '€', 'Our own extra cost for each session (payments, messages, support).'],
  platformFixedEur: ['Our monthly overhead', 0, 1000000, false, '€/month', 'Software, integration and support allocated to this site.'],
};
const BZ_MAIN = ['sessions', 'kwhPerSession', 'savingEurPerKwh'];
const BZ_COSTS = ['operatorFixedEur', 'platformVariableEur', 'platformFixedEur'];
const BZ_PRESETS = [['expected', 'Replay'], ['example', '400 sessions'], ['noSurplus', 'No spare energy']];
// Same limits as the server (offers.parse_calculator); the server's answer is authoritative.
function bzValidate(raw) {
  const values = {}, errors = {};
  for (const [name, [, lo, hi, whole]] of Object.entries(BZ_FIELDS)) {
    const text = String(raw?.[name] ?? '').trim().replace(/,/g, '');
    if (text === '') { errors[name] = 'Required'; continue; }
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) { errors[name] = 'Not a number'; continue; }
    const v = Number(text);
    if (v < lo || v > hi) { errors[name] = `${n(lo)}–${n(hi)}`; continue; }
    if (whole && !Number.isInteger(v)) { errors[name] = 'Whole number'; continue; }
    values[name] = v;
  }
  return { values, errors };
}
function bzCalcQuery(values) {
  return new URLSearchParams(Object.entries(values).map(([k, v]) => [k, String(v)])).toString();
}
// Fills the calculator with one of the backend's scenarios (the replay, the worked example, no spare energy).
function bzPreset(id) {
  const d = bzD(), s = d?.scenarios?.[id];
  if (!s) return;
  const costs = d.calculator.defaults;
  bz.calc.values = Object.fromEntries(Object.keys(BZ_FIELDS).map((k) => [k, String(k in s.inputs ? s.inputs[k] : costs[k])]));
  bz.calc.errors = {}; bz.calc.error = '';
  bzEstimate();
}
// The preset the inputs currently match, if any.
function bzActivePreset() {
  const d = bzD(), v = bz.calc.values;
  if (!d || !v) return '';
  const costs = d.calculator.defaults;
  return BZ_PRESETS.map(([id]) => id).find((id) => Object.keys(BZ_FIELDS).every((k) => Number(v[k]) === Number(k in d.scenarios[id].inputs ? d.scenarios[id].inputs[k] : costs[k]))) || '';
}
function bzCalcChanged() {
  const { errors } = bzValidate(bz.calc.values);
  bz.calc.errors = errors;
  clearTimeout(bz.calc.timer);
  bz.calc.seq++; // any answer still on its way now describes old inputs
  bz.calc.pending = !Object.keys(errors).length; // the figure dims until the new answer arrives
  bzCalcPaint();
  if (bz.calc.pending) bz.calc.timer = setTimeout(bzEstimate, 280);
}
// Asks the server for the estimate. Only the newest request may update the page.
async function bzEstimate() {
  const { values, errors } = bzValidate(bz.calc.values);
  bz.calc.errors = errors;
  const seq = ++bz.calc.seq;
  if (Object.keys(errors).length) { bz.calc.pending = false; bzCalcPaint(); return; }
  bz.calc.pending = true; bzCalcPaint();
  try {
    const { ok, body } = await bzFetch(`/api/v1/business/offers/estimate?${bzCalcQuery(values)}`, 10000);
    if (seq !== bz.calc.seq) return;
    if (ok) { bz.calc.result = body; bz.calc.error = ''; } else { bz.calc.errors = body.error?.fields || {}; bz.calc.error = body.error?.message || 'Check the inputs.'; }
  } catch {
    if (seq !== bz.calc.seq) return;
    bz.calc.error = 'Could not update the estimate. Check the connection and try again.';
  }
  bz.calc.pending = false;
  bzCalcPaint();
}
// A field's problem is shown in place of its unit, so an error never moves the layout; the full
// sentence is read out by screen readers.
const bzShortError = (message) => (message.length > 14 ? 'Check value' : message);
function bzFieldError(name) {
  const error = bz.calc.errors[name];
  return error ? `${BZ_FIELDS[name][0]}: ${error}${/\.$/.test(error) ? '' : '.'} Allowed ${n(BZ_FIELDS[name][1])} to ${n(BZ_FIELDS[name][2])}.` : '';
}
function bzField(name) {
  const [label, lo, hi, whole, unit, about] = BZ_FIELDS[name], error = bz.calc.errors[name];
  return `<label class="bz-field${error ? ' is-invalid' : ''}" data-bz-field="${name}" title="${escapeHtml(`${about} ${n(lo)} to ${n(hi)}.`)}">
    <span class="bz-field-label">${label}</span>
    <span class="bz-input"><input type="text" inputmode="${whole ? 'numeric' : 'decimal'}" autocomplete="off" spellcheck="false" data-bz-input="${name}" value="${escapeHtml(bz.calc.values?.[name] ?? '')}" aria-invalid="${Boolean(error)}" aria-describedby="bz-err-${name}"><em>${error ? escapeHtml(bzShortError(error)) : unit}</em></span>
    <small class="bz-err" id="bz-err-${name}">${escapeHtml(bzFieldError(name))}</small></label>`;
}
// The what-if's profit bridges and any note about the answer (a cap, no spare energy, an error).
function bzWhatIf() {
  const c = bz.calc, m = bzShownMonth(), d = bzD(), invalid = Object.keys(c.errors).length;
  if (!m || !d) return '';
  const warn = (text) => `<p class="bz-out-note is-warn">${bzIcon('alert', 15)}<span>${escapeHtml(text)}</span></p>`;
  const note = invalid ? warn(`Fix the highlighted ${invalid === 1 ? 'field' : 'fields'} to update the split.`)
    : c.error ? warn(c.error)
      : c.result?.capacity?.limit ? warn(c.result.capacity.limitedBy === 'session-kwh' ? c.result.capacity.limit
        : `${n(c.result.capacity.counted)} of ${n(c.result.capacity.requested)} sessions counted: ${c.result.capacity.limit}`)
        : c.result?.noSpareEnergy ? `<p class="bz-out-note">${bzIcon('info', 15)}<span>No spare energy: no discount and no commission, while both businesses still carry their fixed costs.</span></p>` : '';
  return `<div class="bz-bridges">
      ${bzBridge('platform', 'Us', [['Commission', m.platform.grossEur], ['Per-session costs', -m.platform.variableEur], ['Overhead', -m.platform.fixedEur]], ['Operating profit', m.platform.profitEur], m.platform.breakEvenSessions, m.yearly.platformProfitEur)}
      ${bzBridge('operator', 'Charging operator', [[`${d.split.operator}% share`, m.operator.retainedEur], ['Programme costs', -m.operator.fixedEur]], ['Extra profit', m.operator.profitEur], m.operator.breakEvenSessions, m.yearly.operatorProfitEur)}
    </div>${note}`;
}
// Updates the what-if in place (bar, bridges, presets, field errors), so typing never loses focus.
function bzCalcPaint() {
  const main = document.querySelector('main[data-current-page="business"]');
  const card = main?.querySelector('.bz-split-card:not(.bz-progress)');
  if (!card) return;
  card.classList.toggle('is-pending', bz.calc.pending);
  card.classList.toggle('is-stale', Object.keys(bz.calc.errors).length > 0 || Boolean(bz.calc.error));
  const detail = card.querySelector('.bz-whatif');
  if (detail) detail.innerHTML = bzWhatIf();
  const active = bzActivePreset();
  main.querySelectorAll('[data-bz-preset]').forEach((b) => { const on = b.dataset.bzPreset === active; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); });
  const note = bz.calc.view === 'main' && main.querySelector('.bz-adv-note'); // the costs view explains, it does not summarise
  if (note) note.textContent = bzCostNote();
  for (const name of Object.keys(BZ_FIELDS)) {
    const field = main.querySelector(`[data-bz-field="${name}"]`);
    if (!field) continue;
    const error = bz.calc.errors[name] || '';
    field.classList.toggle('is-invalid', Boolean(error));
    field.querySelector('input').setAttribute('aria-invalid', String(Boolean(error)));
    field.querySelector('.bz-input em').textContent = error ? bzShortError(error) : BZ_FIELDS[name][4];
    field.querySelector('.bz-err').textContent = bzFieldError(name);
  }
  const chart = card.querySelector('[data-chart="bzSplit"]');
  if (chart) { chart.setAttribute('aria-label', bzSplitLabel()); chartsSync(chart.parentElement); }
}
function bzCostNote() {
  const v = bz.calc.values || {}, num = (k) => Number(String(v[k] ?? '').replace(/,/g, ''));
  return `Costs: operator ${bzEur(num('operatorFixedEur'))}/month · us ${bzCents(num('platformVariableEur'))}/session + ${bzEur(num('platformFixedEur'))}/month`;
}

// ---------------------------------------------------------------- building blocks
function bzHead(glyph, tone, title, subtitle, extra = '') {
  return `<div class="dash-card-head bz-head"><span class="bz-head-icon is-${tone}" aria-hidden="true">${bzIcon(glyph, 19)}</span><div class="dash-head-copy"><h2>${title}</h2><p>${subtitle}</p></div>${extra}</div>`;
}
function bzKpi(tone, glyph, label, figure, figureLabel, foot) {
  return `<article class="dash-card bz-kpi is-${tone}"><span class="bz-kpi-icon" aria-hidden="true">${bzIcon(glyph, 21)}</span>
    <span class="bz-kpi-label">${label}</span>${chartSlot(figure, figureLabel, 'bz-kpi-figure')}
    <p class="bz-kpi-foot">${foot}</p></article>`;
}
// `intro`: '' after the entrance, else the entrance is playing (with its elapsed time as a style).
function bzScenario(intro = '') {
  const r = bz.result;
  if (!r || bz.status !== 'ready') {
    const chip = bz.status === 'failed' ? '<span class="bz-chip is-error">Unavailable</span>' : bz.status === 'empty' ? '<span class="bz-chip">No data</span>'
      : `<span class="bz-chip is-busy"><i class="motion-loop"></i><span>${bz.status === 'preparing' ? bzPreparing(bz.progress) : 'Loading'}</span></span>`;
    return `<div class="bz-scenario" aria-label="Scenario">${chip}</div>`;
  }
  const sim = r.dataMode === 'simulated', d = r.discountWindows;
  const mode = sim
    ? `<button type="button" class="bz-chip is-sim" data-bz-retry="model" title="GridToEv is unavailable (${escapeHtml(r.fallback?.reason || '')}); this is a fixed simulated example. Click to try the model again.">${bzIcon('alert', 14)}Simulated data · retry model</button>`
    : `<span class="bz-chip is-replay" title="GridToEv ${escapeHtml(r.modelVersion || '')} historical forecasts, scored against observed EirGrid curtailment">Historical replay</span>`;
  return `<div class="bz-scenario${intro ? ' is-intro' : ''}"${intro} aria-label="Scenario">
    <span class="bz-scn"><span class="bz-scn-icon">${bzIcon('building', 17)}</span><span><b>Example site</b><small>${n(d.hub.chargers)} × ${n(d.hub.chargerKw)} kW · simulated</small></span></span>
    <span class="bz-scn"><span class="bz-scn-icon">${icon('calendar', 17)}</span><span>${sim ? `<b>Example week</b><small>${n(r.period.nights)} nights · fixed weather</small>` : `<b>${bzPeriod(r.period)}</b><small>${n(r.period.nights)} nights replayed</small>`}</span></span>
    ${mode}</div>`;
}

function bzKpiRow(r) {
  const d = r.discountWindows, k = d.kpis, m = d.month, per = m.perSession;
  const loss = (v, tone) => (bzTone(v) === 'profit' ? tone : bzTone(v));
  const extraFoot = k.sessions ? `vs basic smart charging · ${n(k.sessions)} sessions` : 'no eligible sessions: nothing extra to share';
  const driverFoot = k.sessions ? `${bzCents(per.driverEur)} off each ${n(d.sessionKwh)} kWh charge` : 'normal prices apply';
  const opFoot = `after ${bzEur(m.operator.fixedEur)} programme costs`;
  const usFoot = `from ${bzCents(m.platform.grossEur)} gross commission`;
  return `<section class="bz-kpis" aria-label="Monthly business case at the example site, projected from the replay">
    ${bzKpi('blue', 'spark', 'Extra savings from our AI', 'bzExtra', `Extra savings from our AI ${bzEur(k.aiExtraSavingsEur)} a month versus basic smart charging`, `<em>${extraFoot}</em>`)}
    ${bzKpi('green', 'car', 'Drivers saved', 'bzDrivers', `Drivers saved ${bzEur(k.driversSavedEur)} a month`, `<em>${driverFoot}</em>`)}
    ${bzKpi(loss(k.operatorProfitEur, 'teal'), 'building', 'Charging operator profit', 'bzOperator', `Charging operator profit ${bzEur(k.operatorProfitEur)} a month after its programme costs`, `<em>${opFoot}</em>`)}
    ${bzKpi(loss(k.platformProfitEur, 'profit'), 'euro', 'Our operating profit', 'bzPlatform', `Our operating profit ${bzEur(k.platformProfitEur)} a month, from ${bzEur(k.platformGrossEur)} gross commission`, `<em>${usFoot}</em>`)}
  </section>`;
}

// One profit bridge: revenue, then costs, then the profit (or loss) that is left.
function bzBridge(id, title, rows, total, breakEven, yearly) {
  const tone = bzTone(total[1]);
  const even = bzHas(breakEven) ? `Breaks even at ${n(breakEven)} sessions` : 'Never breaks even';
  return `<div class="bz-bridge is-${id}"><h3><i></i>${title}</h3>
    <ul>${rows.map(([label, v]) => `<li><span>${label}</span><b>${bzCents(v, false)}</b></li>`).join('')}</ul>
    <p class="bz-bridge-total is-${tone}"><span>${total[0]}</span><b>${bzCents(total[1])}</b></p>
    <small>${even}${bzHas(yearly) ? ` · <span class="is-${bzTone(yearly)}">${bzEur(yearly)}</span> a year` : ''}</small></div>`;
}
function bzSplitLabel() {
  const m = bzShownMonth();
  if (!m) return 'Where the € goes';
  const parts = bzParts(m);
  return `Of ${bzCents(m.poolEur)} extra savings a month: drivers ${bzCents(parts.driver)}, charging operator ${bzCents(parts.operator)}, us ${bzCents(parts.platform)}`;
}
// Where the € goes, as a what-if: presets and three inputs drive the bar and both profit bridges, so the
// split is shown once. It starts from the replay (the KPIs above); the server answers every change.
function bzSplitCard(r) {
  const c = bz.calc, d = r.discountWindows, costs = c.view === 'costs', active = bzActivePreset();
  const presets = `<div class="bz-seg is-small" role="group" aria-label="Start from">${BZ_PRESETS.map(([id, label]) => `<button type="button" data-bz-preset="${id}" aria-pressed="${active === id}" class="${active === id ? 'is-active' : ''}">${label}</button>`).join('')}</div>`;
  // The cost inputs replace the main inputs in the same space, so the card never reflows.
  const updating = '<span class="bz-updating" aria-hidden="true"><i class="bz-out-spin motion-loop"></i>Updating</span>';
  const fields = costs
    ? `${BZ_COSTS.map(bzField).join('')}<div class="bz-adv"><span class="bz-adv-note">Savings are shared first; these costs come out of each share.</span><button type="button" class="bz-link" data-bz-costs="done">${icon('check', 14)}Done</button>${updating}</div>`
    : `${BZ_MAIN.map(bzField).join('')}<div class="bz-adv"><span class="bz-adv-note">${escapeHtml(bzCostNote())}</span><button type="button" class="bz-link" data-bz-costs="open">Edit costs</button>${updating}</div>`;
  const stale = Object.keys(c.errors).length || c.error;
  return `<section class="dash-card bz-card bz-split-card${c.pending ? ' is-pending' : ''}${stale ? ' is-stale' : ''}">
    ${bzHead('split', 'blue', 'Where the € goes', `One site, one month · split ${d.split.driver} / ${d.split.operator} / ${d.split.platform}`, presets)}
    <form class="bz-form" novalidate onsubmit="return false"><div class="bz-fields${costs ? ' is-costs' : ''}">${fields}</div></form>
    ${chartSlot('bzSplit', bzSplitLabel(), 'bz-split-chart')}
    <div class="bz-whatif" aria-live="polite">${bzWhatIf()}</div>
  </section>`;
}

function bzMoneyCard(r) {
  const s = r.seasonal, f = r.financials;
  const basis = s.available ? 'season-adjusted' : 'not season-adjusted';
  const payback = f.paybackStatus === 'months' ? `Setup pays back in ${bzMonths(f.paybackMonths)}` : 'Depot setup does not pay back';
  return `<section class="dash-card bz-card bz-money">
    ${bzHead('euro', 'green', 'Where does the money come from?', `Depot · ${n(r.company.vehicles)} vans · yearly · ${basis}`)}
    ${chartSlot('bzWaterfall', `Waterfall: normal charging ${bzEur(r.financials.baselineCostEur)}, smarter timing ${bzEur(-r.financials.smartTimingSavingsEur, true)}, AI forecast ${bzEur(-r.financials.aiSavingsEur, true)}, software ${bzEur(r.financials.annualCostsEur, true)}, with our AI ${bzEur(r.financials.finalCostEur)} a year`, 'bz-wf-chart')}
    <p class="bz-foot is-invest">${bzIcon('hourglass', 14)}<span title="${escapeHtml(`${bzEur(f.implementationEur)} example setup cost`)}">${payback}</span></p>
  </section>`;
}

function bzCompareCard(r) {
  const m = BZ_METRICS[bz.metric], c = r.forecastCalls, req = r.strategies.map((s) => s.requirements);
  const onTime = req.every((q) => q.allMet) ? ` · all ${n(req[0].total)} van-nights on time` : '';
  const seg = `<div class="bz-seg" role="group" aria-label="Compare by">${Object.entries(BZ_METRICS).map(([key, x]) => `<button type="button" data-bz-metric="${key}" aria-pressed="${bz.metric === key}" class="${bz.metric === key ? 'is-active' : ''}">${x.label}</button>`).join('')}</div>`;
  const calls = c.surplusCalls ? `Forecast said “surplus” ${n(c.surplusCalls)} times: ${n(c.right)} right, ${n(c.falseAlarms)} false alarms, ${n(c.missed)} missed` : 'The forecast never called a surplus while vans were plugged in';
  return `<section class="dash-card bz-card bz-compare">
    ${bzHead('spark', 'blue', 'Is our AI making a difference?', `Same vans, prices and limits · no look-ahead${onTime}`)}
    <div class="bz-cmp-bar">${seg}<p class="bz-cmp-unit"><span>${m.unit}</span><em>${m.better === 'lower' ? 'lower is better' : 'higher is better'}</em></p></div>
    ${chartSlot('bzCompare', `${m.unit} for normal, basic smart and AI charging`, 'bz-cmp-chart')}
    <p class="bz-foot" title="Each call is a half-hour with vans plugged in where the +30 minute forecast predicted enough curtailment to cover the site's full draw; checked against observed curtailment.">${bzIcon('info', 14)}<span>${calls}</span></p>
  </section>`;
}

function bzEnergyCard(r) {
  const d = r.discountWindows, e = d.energy, b = e.battery, l = d.ledger;
  const src = [['stored', 'Stored surplus', e.sources.storedSurplusKwh], ['direct', 'Direct surplus', e.sources.directSurplusKwh], ['grid', 'Conventional grid', e.sources.conventionalKwh]];
  const sum = src.reduce((a, s) => a + s[2], 0);
  const bar = src.map(([id, , kwh]) => (sum > 0 && kwh > 0 ? `<i class="is-${id}" style="width:${((kwh / sum) * 100).toFixed(1)}%"></i>` : '')).join('');
  const legend = src.map(([id, label, kwh]) => `<li class="is-${id}"><i></i><span>${label}</span><b>${n(Math.round(kwh))} kWh</b></li>`).join('');
  const kwh = (v) => n(Math.round(v));
  const facts = [
    ['Battery in · out · left', `${kwh(b.gridChargedKwh)} · ${kwh(b.dischargedKwh)} · ${kwh(b.unallocatedSurplusKwh + b.unallocatedConventionalKwh)} kWh`, 'Grid energy into the battery, energy out at the chargers, and energy still stored (unallocated) at the end of the replay.'],
    ['Lost in storage', `${kwh(b.chargeLossKwh + b.dischargeLossKwh)} kWh · ${Math.round(b.roundTripEfficiency * 100)}% round trip`, 'Charging and discharging losses: stored kWh are not all recovered kWh.'],
    ['Bought on false alarms', `${kwh(b.falseAlarmKwh)} kWh · never offered`, 'Energy bought when the forecast called surplus but none was observed: conventional grid energy, sold at the normal price.'],
    ['Network access', e.network.status === 'conditional' ? 'Conditional · not verified' : escapeHtml(e.network.status), e.network.reason],
  ].map(([label, value, tip]) => `<div title="${escapeHtml(tip)}"><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  const offers = `offers on ${n(l.byWindow.evening.offers)}/${n(l.byWindow.evening.windows)} evenings, ${n(l.byWindow.morning.offers)}/${n(l.byWindow.morning.windows)} mornings`;
  return `<section class="dash-card bz-card bz-energy" title="${escapeHtml(e.notes.join('\n'))}">
    ${bzHead('battery', 'green', 'Energy proof', 'Apart from the money', `<span class="bz-chip is-hypo" title="${escapeHtml(d.battery.note)}">Hypothetical battery</span>`)}
    <p class="bz-energy-top"><b>${kwh(e.qualifyingKwh)} kWh</b><span>qualifying · ${n(l.sessions)} sessions · ${offers}</span></p>
    <div class="bz-mix" role="img" aria-label="${escapeHtml(src.map(([, label, kwh]) => `${label} ${n(Math.round(kwh))} kWh`).join(', '))}">${bar}</div>
    <ul class="bz-mix-legend">${legend}</ul>
    <dl class="bz-facts">${facts}</dl>
  </section>`;
}

function bzInvestCard(r) {
  const s = r.scenarios, f = r.financials;
  const pay = (x) => (x.paybackStatus === 'months' ? bzMonths(x.paybackMonths) : 'Not achieved');
  const rows = [
    ['conservative', 'Conservative', 'No surplus benefit: smarter timing only'],
    ['expected', 'Expected', r.seasonal.available ? 'Surplus scaled to a full observed year' : 'The evaluation week, not seasonally adjusted'],
    ['optimistic', 'Optimistic', 'Every week as good as the evaluation week'],
  ].map(([key, label, note]) => `<tr class="${key === 'expected' ? 'is-expected' : ''}"><th scope="row" title="${escapeHtml(note)}"><b>${label}</b></th><td>${bzEur(s[key].annualSavingsEur)}</td><td>${bzT(s[key].co2ReductionT)} t</td><td>${pay(s[key])}</td></tr>`).join('');
  const sites = r.scaling.map((x) => `<tr><th scope="row">${n(x.sites)} ${x.sites === 1 ? 'site' : 'sites'}</th><td>${bzEur(x.annualSavingsEur)}</td><td>${bzT(x.co2ReductionT)} t</td><td>${bzEur(x.implementationEur)}</td></tr>`).join('');
  const season = r.seasonal.available
    ? `Curtailment happened on ${Math.round(r.seasonal.yearEventRate * 100)}% of days over a full year (${bzDay(r.seasonal.yearFrom, true)} – ${bzDay(r.seasonal.yearTo, true)}) and ${Math.round(r.seasonal.periodEventRate * 100)}% of the evaluation days, so the surplus part is scaled ×${n(Math.round(r.seasonal.appliedFactor * 100) / 100)}.`
    : `No seasonal adjustment: ${escapeHtml(r.seasonal.reason || 'not available')}`;
  return `<section class="dash-card bz-card bz-invest" aria-label="Investment case">
    ${bzHead('hourglass', 'amber', 'Investment case', `Example costs: ${bzEur(f.implementationEur)} setup, ${bzEur(f.annualCostsEur)} a year · 5-year view`)}
    <div class="bz-invest-body"><div class="bz-roi">
      <div><span>Payback</span><strong>${f.paybackStatus === 'months' ? bzMonths(f.paybackMonths) : 'Not achieved'}</strong></div>
      <div><span>${n(f.roiYears)}-year net return</span><strong>${bzEur(f.roiNetEur)}</strong></div>
      <div><span>Return on investment</span><strong>${bzHas(f.roiPct) ? `${n(f.roiPct)}%` : '—'}</strong></div>
    </div>
    <div class="bz-tables">
      <table class="bz-table"><caption>Scenarios</caption><thead><tr><th scope="col"></th><th scope="col">Savings/year</th><th scope="col">CO₂/year</th><th scope="col">Payback</th></tr></thead><tbody>${rows}</tbody></table>
      <table class="bz-table is-sites"><caption>More locations <small>each needs its own grid check</small></caption><thead><tr><th scope="col"></th><th scope="col">Savings/year</th><th scope="col">CO₂/year</th><th scope="col">Setup</th></tr></thead><tbody>${sites}</tbody></table>
    </div></div>
    <p class="bz-note">${season} Prices, fleet and costs are examples; replace them with your own quotes.</p>
  </section>`;
}

// Two views, one story each. The label says what the figures below are.
const BZ_VIEWS = [['earn', 'Who earns', 'per month'], ['depot', 'Depot savings', 'per year']];
function bzViews(r) {
  const tabs = BZ_VIEWS.map(([id, label, unit]) => `<button type="button" data-bz-view="${id}" aria-pressed="${bz.view === id}" class="${bz.view === id ? 'is-active' : ''}">${label}<small>${unit}</small></button>`).join('');
  const sim = r?.dataMode === 'simulated';
  const label = !r ? '' : bz.view === 'earn'
    ? `${sim ? 'Illustrative example' : 'Illustrative replay'} · projected revenue, simulated profit · ex VAT`
    : `${sim ? 'Simulated example' : 'Historical replay'} · ${n(r.company.vehicles)} simulated vans · illustrative tariff`;
  return `<div class="bz-views"><div class="bz-seg is-views" role="group" aria-label="Impact view">${tabs}</div>${label ? `<p class="bz-views-label">${bzIcon('info', 14)}${label}</p>` : ''}</div>`;
}

function bzProvenance(r, intro = '') {
  const cov = r.coverage || {};
  const gaps = (cov.missingForecasts || cov.missingObservations) ? ` · ${n(cov.missingForecasts || 0)} forecasts and ${n(cov.missingObservations || 0)} observations missing (not filled in)` : '';
  const how = r.dataMode === 'simulated'
    ? 'Simulated example (GridToEv unavailable): fixed weather'
    : `GridToEv ${escapeHtml(r.modelVersion || '')} historical forecasts vs observed EirGrid curtailment`;
  const d = r.discountWindows, earn = bz.view === 'earn';
  const tip = (earn ? [...(d.methodology || []), ...(d.limitations || []), d.prices.vat] : [...(r.methodology || []), ...(r.limitations || [])]).join('\n');
  const what = earn ? 'hypothetical battery · illustrative prices, costs and demand' : `simulated fleet · illustrative prices · CO₂ estimated at ${n(r.emissions.gridIntensityKgPerKwh)} kg/kWh`;
  return `<p class="bz-provenance${intro ? ' is-intro' : ''}"${intro} title="${escapeHtml(tip)}">${bzIcon('info', 13)}<span>${how} · ${what} · network access not verified${gaps}</span></p>`;
}

// ---------------------------------------------------------------- states
// The build's stages (business.compute): one step per day replayed, then the observed year, then the
// scoring (the three strategies and the discount windows). `total` counts every step, so the days
// replayed are total - 2.
const bzDays = (p) => (p?.total > 2 ? p.total - 2 : 0);
function bzLoadingSteps(p, now = Date.now()) {
  const days = bzDays(p), done = p?.done ?? 0;
  const at = !days || done < days ? 0 : done === days ? 1 : 2;
  const eta = bzEta(p, bz.progressSince, now);
  const replay = !days ? 'starting' : done < days ? `day ${n(done + 1)} of ${n(days)}${eta ? ` · ${eta}` : ''}` : `${n(days)} days replayed`;
  return [
    ['Replay a week of GridToEv forecasts', replay],
    ['Read a year of observed curtailment', 'for the seasonal adjustment'],
    ['Score the week and split the savings', 'normal, basic smart and our AI'],
  ].map(([label, detail], i) => ({ label, detail, state: i < at ? 'done' : i === at ? 'active' : 'pending' }));
}
const bzShare = (p) => (p?.total ? Math.min(1, (p.done + 0.5) / p.total) : 0.04);
// Time left for the replay, at the pace of the days this page has seen finish. Only the replay: its
// days take alike, while the observed year and the scoring take their own time.
function bzEta(p, since, now) {
  const days = bzDays(p);
  if (!days || !since || p.done >= days || p.done <= since.done) return '';
  const left = (((now - since.at) / (p.done - since.done)) * (days - p.done)) / 1000;
  if (left < 5) return 'a few seconds left';
  return left < 60 ? `about ${Math.ceil(left / 5) * 5} s left` : `about ${Math.round(left / 60)} min left`;
}
const bzProgressMeta = (p) => `${Math.round(bzShare(p) * 100)}%`;
const bzPreparing = (p) => (p?.total ? `Preparing · ${n(Math.min(p.done + 1, p.total))} of ${n(p.total)}` : 'Preparing');
function bzStep(s) {
  const mark = s.state === 'done' ? bzIcon('tick', 14) : s.state === 'active' ? '<i class="bz-spin motion-loop"></i>' : '<i class="bz-dot"></i>';
  return `<li class="is-${s.state}" data-state="${s.state}"><span class="bz-step-mark">${mark}</span><span class="bz-step-copy"><b>${s.label}</b><small>${s.detail}</small></span></li>`;
}
function bzProgressCard(p, slot = 'bz-split-card') {
  const share = bzShare(p);
  return `<section class="dash-card bz-card ${slot} bz-progress" role="status">
    <div class="bz-progress-head"><span class="bz-progress-icon motion-loop">${bzIcon('spark', 22)}</span>
      <div><h2>Replaying a week of charging</h2><p>The first run replays GridToEv's forecasts; after that the page opens instantly.</p></div></div>
    <ol class="bz-steps">${bzLoadingSteps(p).map(bzStep).join('')}</ol>
    <div class="bz-progress-foot"><span class="bz-bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(share * 100)}"><i style="width:${(share * 100).toFixed(1)}%"><b class="motion-loop"></b></i></span>
      <span class="bz-progress-meta" aria-hidden="true">${bzProgressMeta(p)}</span></div>
  </section>`;
}
// Updates the loading card in place between polls, so its spinner, shimmer and bar keep moving
// instead of restarting with every re-render. False when there is no card to update.
function bzProgressPaint() {
  const main = document.querySelector('main[data-current-page="business"]'), card = main?.querySelector('.bz-progress');
  if (!card) return false;
  const p = bz.progress, items = card.querySelectorAll('.bz-steps li'), share = bzShare(p);
  bzLoadingSteps(p).forEach((s, i) => {
    if (!items[i]) return;
    if (items[i].dataset.state !== s.state) items[i].outerHTML = bzStep(s); // a finished step's tick pops in
    else items[i].querySelector('small').textContent = s.detail;
  });
  const bar = card.querySelector('.bz-bar');
  bar.firstElementChild.style.width = `${(share * 100).toFixed(1)}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  card.querySelector('.bz-progress-meta').textContent = bzProgressMeta(p);
  const chip = main.querySelector('.bz-chip.is-busy span');
  if (chip) chip.textContent = bzPreparing(p);
  return true;
}
// Placeholders shaped like the cards they stand for, so the results replace them without a jump.
// A quick answer never shows them: they fade in only after a moment (.is-waiting). Loading motion is
// .motion-loop, so it keeps running through the app's live model refreshes (studio.css).
function bzSkeleton() {
  const line = (cls, style = '') => `<span class="bz-skel motion-loop ${cls}"${style ? ` style="${style}"` : ''}></span>`;
  const head = `<div class="bz-skel-head">${line('is-icon')}<span class="bz-skel-copy">${line('is-title')}${line('is-sub')}</span></div>`;
  const kpi = `<article class="dash-card bz-kpi is-skeleton">${line('is-kpi-icon')}<span class="bz-skel-copy">${line('is-label')}${line('is-figure')}</span>${line('is-foot')}</article>`;
  const card = (cls, body) => `<section class="dash-card bz-card ${cls} is-skeleton">${head}${body}</section>`;
  const preparing = bz.status === 'preparing';
  const rows = (widths) => `<div class="bz-skel-rows">${widths.map((w) => `<div class="bz-skel-row">${line('is-row-label')}${line('is-row-bar', `width:${w}%`)}</div>`).join('')}</div>`;
  const cards = bz.view === 'depot'
    ? `${preparing ? bzProgressCard(bz.progress, 'bz-money') : card('bz-money', `<div class="bz-skel-bars">${[84, 44, 10, 7, 42].map((h) => line('', `height:${h}%`)).join('')}</div>`)}
      ${card('bz-compare', `${line('is-seg')}${rows([88, 46, 42])}`)}${card('bz-invest', `<div class="bz-skel-pair">${line('is-block')}${line('is-block')}</div>`)}`
    : `<section class="bz-kpis">${kpi.repeat(4)}</section>
      ${preparing ? bzProgressCard(bz.progress, 'bz-split-card') : card('bz-split-card', `<div class="bz-skel-fields">${line('is-field').repeat(3)}</div>${line('is-stack')}<div class="bz-skel-pair">${line('is-block')}${line('is-block')}</div>`)}
      ${card('bz-energy', `${line('is-title')}${line('is-stack')}${rows([90, 55, 30])}`)}`;
  return `<div class="bz-layout is-loading is-${bz.view}${preparing ? '' : ' is-waiting'}" aria-busy="true">${bzViews(null)}${cards}</div>`;
}
function bzMessage(kind, title, text, action = '') {
  return `<section class="dash-card bz-message is-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="bz-message-icon">${bzIcon(kind === 'error' ? 'alert' : 'info', 26)}</span><h2>${title}</h2><p>${text}</p>${action}</section>`;
}

function renderBusiness() {
  // First visit, or back on the page while the result was still being prepared (polling pauses off-page).
  if (bz.status === 'idle' || (bz.status === 'preparing' && !bz.timer && !bz.inFlight)) queueMicrotask(() => bzLoad());
  const r = bz.result, shown = bz.status === 'ready' && Boolean(r?.kpis);
  // The results rise in card by card when they first appear (after loading, or on arriving at the
  // page). render() builds the new page while the old one is still there, so a re-render finds the
  // results already shown: while the entrance still plays (a live model update, say) it continues
  // from the same point; after that the cards stay still.
  const live = typeof liveRender !== 'undefined' && liveRender, now = Date.now();
  if (shown && !live && !document.querySelector(`#app .bz-layout.is-ready.is-${bz.view}`)) bz.introAt = now; // arrival or a new view
  const since = shown && bz.introAt !== undefined ? now - bz.introAt : Infinity;
  const intro = since < BZ_INTRO_MS ? (since > 0 ? ` style="--bz-t:-${since}ms"` : ' ') : '';
  const top = studioHeader('Impact', 'Who saves and who earns from our AI.', bzScenario(intro));
  if (bz.status === 'failed' && !r) {
    return top + bzMessage('error', 'The impact figures are unavailable', escapeHtml(bz.error || 'Something went wrong.'), `<button type="button" class="studio-button" data-bz-retry="load">Try again ${icon('arrow', 17)}</button>`);
  }
  if (bz.status === 'empty' && r) return top + bzMessage('empty', 'Nothing to evaluate yet', escapeHtml(r.message || 'No complete night of forecasts was available.'), '<button type="button" class="studio-button" data-bz-retry="model">Check again</button>');
  if (!shown) return top + bzSkeleton();
  const cards = bz.view === 'depot' ? `${bzMoneyCard(r)}${bzCompareCard(r)}${bzInvestCard(r)}` : `${bzKpiRow(r)}${bzSplitCard(r)}${bzEnergyCard(r)}`;
  return `${top}<div class="bz-layout is-ready is-${bz.view}${intro ? ' is-intro' : ''}"${intro}>${bzViews(r)}${cards}</div>${bzProvenance(r, intro)}`;
}
const BZ_INTRO_MS = 1000; // the entrance's longest delay plus its animation
// Cost inputs: open, or done (back to the main inputs once they are valid).
function bzCosts(action) {
  const c = bz.calc;
  if (action === 'open') c.view = 'costs';
  else if (action === 'done') {
    const { errors } = bzValidate(c.values);
    if (BZ_COSTS.some((k) => errors[k])) { bzCalcChanged(); return; } // stay until the costs are valid
    c.view = 'main';
  }
  bzRender();
  bzCalcChanged();
  const first = document.querySelector(action === 'open' ? 'main [data-bz-input="operatorFixedEur"]' : 'main [data-bz-costs]');
  first?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (event) => {
  if (pageFromHash() !== 'business') return;
  const t = event.target, pick = (attr) => t.closest(`[${attr}]`);
  let el;
  if ((el = pick('data-bz-metric'))) {
    if (bz.metric === el.dataset.bzMetric) return;
    bz.metric = el.dataset.bzMetric;
    try { localStorage.setItem('impact-metric', bz.metric); } catch {}
    bzRender(); return;
  }
  if ((el = pick('data-bz-view'))) {
    if (bz.view === el.dataset.bzView) return;
    bz.view = el.dataset.bzView;
    try { localStorage.setItem('impact-view', bz.view); } catch {}
    bzRender(); return;
  }
  if ((el = pick('data-bz-costs'))) { bzCosts(el.dataset.bzCosts); return; }
  if ((el = pick('data-bz-preset'))) { bzPreset(el.dataset.bzPreset); bzRender(); return; }
  if ((el = pick('data-bz-retry'))) { bzLoad(el.dataset.bzRetry === 'model'); }
});
document.addEventListener('input', (event) => {
  const el = event.target.closest?.('[data-bz-input]');
  if (!el || pageFromHash() !== 'business' || !bz.calc.values) return;
  bz.calc.values[el.dataset.bzInput] = el.value;
  bzCalcChanged();
});
