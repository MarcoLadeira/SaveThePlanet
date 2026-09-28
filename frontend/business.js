// Impact page: who saves and who earns when our AI finds cheaper energy, for a simulated site.
// Every figure comes from /api/v1/business/impact (backend/business.py and backend/offers.py): the
// discount-window business case (KPIs, where the € goes, both profit bridges, the energy behind the
// offers) and the depot's normal / basic smart / AI comparison, replayed on the same nights of
// Carlson's historical GridToEv forecasts. The page draws the backend's figures and never recomputes
// them; the what-if calculator asks the server too (/api/v1/business/offers/estimate).
const bz = {
  status: 'idle', // idle | loading | preparing | ready | empty | failed
  result: null, progress: null, error: '', token: 0, timer: null, inFlight: false,
  metric: 'money', // comparison chart: money | co2 | renewable
  details: false, // depot investment details open
  // view: which inputs show (main | costs)
  calc: { values: null, errors: {}, view: 'main', result: null, seq: 0, pending: false, error: '', timer: null },
};
try { const m = localStorage.getItem('impact-metric'); if (['money', 'co2', 'renewable'].includes(m)) bz.metric = m; } catch {}

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
async function bzLoad(refresh = false) {
  const token = ++bz.token;
  clearTimeout(bz.timer); bz.timer = null;
  if (!bz.result || refresh) { bz.status = bz.status === 'preparing' ? 'preparing' : 'loading'; if (refresh) bz.result = null; bzRender(); }
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
  Object.assign(bz, next);
  if (bz.status === 'preparing') bz.timer = setTimeout(() => { bz.timer = null; if (pageFromHash() === 'business') bzLoad(); }, 1500);
  if (bz.status === 'ready' && bz.calc.values === null) bzPreset('expected');
  bzRender();
}

// Re-render and put keyboard focus back where it was, since render() rebuilds <main>.
const BZ_FOCUS = ['data-bz-metric', 'data-bz-details', 'data-bz-costs', 'data-bz-retry', 'data-bz-input', 'data-bz-preset'];
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

// Where the € goes: one stacked bar of the month's extra AI savings, 50 / 25 / 25.
const BZ_PARTS = [['driver', 'Drivers'], ['operator', 'Charging operator'], ['platform', 'Us']];
function bzParts(d) {
  const m = d.month;
  return { driver: m.driversEur, operator: m.operator.retainedEur, platform: m.platform.grossEur };
}
bzChart('bzSplit', {
  values() {
    const d = bzD();
    if (!d) return { w: [0, 0, 0], text: ['', '', ''], empty: '1', reveal: 0 };
    const parts = bzParts(d), pool = d.month.poolEur;
    return {
      w: BZ_PARTS.map(([id]) => (pool > 0 ? Math.max(0, parts[id]) / pool : 0)),
      text: BZ_PARTS.map(([id]) => bzCents(parts[id])), empty: pool > 0 ? '' : '1', reveal: 1,
    };
  },
  start: (t) => ({ ...t, w: t.w.map(() => 0), reveal: 0 }),
  draw({ w, text, empty, reveal }) {
    if (empty) return '<div class="bz-split is-empty"><span>No eligible extra savings this month: nothing to share, no commission.</span></div>';
    const segs = BZ_PARTS.map(([id], i) => `<i class="is-${id}" style="width:${(w[i] * 100).toFixed(2)}%"><b style="opacity:${reveal > 0.85 ? 1 : 0}">${text[i]}</b></i>`).join('');
    return `<div class="bz-split">${segs}</div>`;
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
// The AI's change against normal charging, and whether that change is an improvement.
function bzDelta(metric, ai, normal) {
  if (!bzHas(ai) || !bzHas(normal)) return { text: '', tone: '' };
  const better = BZ_METRICS[metric].better === 'lower' ? -1 : 1;
  const d = metric === 'renewable' ? Math.round(ai - normal) : normal ? Math.round(((ai - normal) / normal) * 100) : null;
  if (d === null) return { text: '', tone: '' };
  if (!d) return { text: 'same as normal', tone: 'same' };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d)}${metric === 'renewable' ? ' pts' : '%'} vs normal`, tone: Math.sign(d) === better ? 'good' : 'bad' };
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
    if (!r) return { rows: [], delta: '', reveal: 0 };
    const vals = r.strategies.map((s) => m.get(s)), peak = Math.max(0, ...vals.filter(bzHas));
    const max = bz.metric === 'renewable' ? 100 : bzScale(peak).max; // a share is always drawn out of 100%
    const of = (id) => vals[r.strategies.findIndex((s) => s.id === id)];
    const delta = bzDelta(bz.metric, of('ai'), of('normal'));
    return {
      rows: r.strategies.map((s, i) => ({ id: s.id, w: bzHas(vals[i]) ? Math.min(1, Math.max(0, vals[i] / max)) : 0, text: bzHas(vals[i]) ? m.fmt(vals[i]) : '—' })),
      delta: delta.text, tone: delta.tone, reveal: 1,
    };
  },
  start: (t) => ({ ...t, rows: t.rows.map((row) => ({ ...row, w: 0 })), reveal: 0 }),
  draw({ rows, delta, tone, reveal }) {
    const r = bzR();
    if (!r || !rows.length) return '';
    const byId = Object.fromEntries(r.strategies.map((s) => [s.id, s]));
    return rows.map((row) => {
      const s = byId[row.id], w = (row.w * 100).toFixed(2);
      const chip = row.id === 'ai' && delta ? `<span class="bz-cmp-delta is-${tone}">${delta}</span>` : '';
      return `<div class="bz-cmp-row is-${row.id}">
        <div class="bz-cmp-name"><b>${escapeHtml(s.label)}</b>${chip}${bzRequirement(s.requirements)}</div>
        <div class="bz-cmp-track"><i style="width:${w}%"></i><strong style="left:${w}%;opacity:${reveal > 0.85 ? 1 : 0}">${row.text}</strong></div>
      </div>`;
    }).join('');
  },
});

// Calculator output: our operating profit for the month.
bzChart('bzCalcOut', {
  values() {
    const c = bz.calc.result, ok = c && !Object.keys(bz.calc.errors).length;
    return { v: ok ? c.month.platform.profitEur : 0, none: ok ? '' : '1' };
  },
  start: (t) => ({ ...t, v: 0 }),
  draw: ({ v, none }) => (none ? '<strong>—</strong>' : `<strong class="is-${bzTone(v)}">${bzEur(v)}<small>/month</small></strong>`),
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
function bzCalcDetail() {
  const c = bz.calc, r = c.result, invalid = Object.keys(c.errors).length;
  if (invalid) return `<p class="bz-out-note is-warn">${bzIcon('alert', 15)}Fix the highlighted ${invalid === 1 ? 'field' : 'fields'} to see an estimate.</p>`;
  if (c.error) return `<p class="bz-out-note is-warn">${bzIcon('alert', 15)}${escapeHtml(c.error)}</p>`;
  if (!r) return '<p class="bz-out-note">Working it out…</p>';
  const m = r.month, even = (x) => (bzHas(x) ? `${n(x)} sessions` : 'never');
  const cap = r.capacity.limit ? `<li class="is-warn" title="${escapeHtml(r.capacity.limit)}"><span>Site cap</span><b>${n(r.capacity.counted)} of ${n(r.capacity.requested)} counted</b></li>` : '';
  const none = r.noSpareEnergy ? `<li class="is-warn"><span>No spare energy</span><b>no commission</b></li>` : '';
  return `<ul class="bz-out-list">${cap}${none}
    <li><span>Our gross commission</span><b>${bzCents(m.platform.grossEur)}</b></li>
    <li><span>Operator profit</span><b class="is-${bzTone(m.operator.profitEur)}">${bzCents(m.operator.profitEur)}</b></li>
    <li><span>Drivers save</span><b>${bzCents(m.driversEur)}</b></li>
    <li><span>Break-even: us · operator</span><b>${even(m.platform.breakEvenSessions)} · ${even(m.operator.breakEvenSessions)}</b></li>
    <li><span>Per year: us · operator</span><b><span class="is-${bzTone(m.yearly.platformProfitEur)}">${bzEur(m.yearly.platformProfitEur)}</span> · <span class="is-${bzTone(m.yearly.operatorProfitEur)}">${bzEur(m.yearly.operatorProfitEur)}</span></b></li></ul>`;
}
// Updates only the calculator output, presets and field errors, so typing never loses focus.
function bzCalcPaint() {
  const main = document.querySelector('main[data-current-page="business"]');
  if (!main) return;
  const detail = main.querySelector('.bz-out-detail'), card = main.querySelector('.bz-calc');
  if (!detail || !card) return;
  detail.innerHTML = bzCalcDetail();
  card.classList.toggle('is-pending', bz.calc.pending);
  const active = bzActivePreset();
  main.querySelectorAll('[data-bz-preset]').forEach((b) => { const on = b.dataset.bzPreset === active; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); });
  const note = main.querySelector('.bz-adv-note');
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
  const chart = main.querySelector('[data-chart="bzCalcOut"]');
  if (chart) chartsSync(chart.parentElement);
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
function bzScenario() {
  const r = bz.result;
  if (!r || bz.status !== 'ready') {
    const chip = bz.status === 'failed' ? '<span class="bz-chip is-error">Unavailable</span>' : bz.status === 'empty' ? '<span class="bz-chip">No data</span>' : `<span class="bz-chip is-busy"><i></i>${bz.progress?.total ? `Preparing · ${bz.progress.done + 1} of ${bz.progress.total}` : 'Preparing'}</span>`;
    return `<div class="bz-scenario" aria-label="Scenario">${chip}</div>`;
  }
  const sim = r.dataMode === 'simulated', d = r.discountWindows;
  const mode = sim
    ? `<button type="button" class="bz-chip is-sim" data-bz-retry="model" title="GridToEv is unavailable (${escapeHtml(r.fallback?.reason || '')}); this is a fixed simulated example. Click to try the model again.">${bzIcon('alert', 14)}Simulated data · retry model</button>`
    : `<span class="bz-chip is-replay" title="GridToEv ${escapeHtml(r.modelVersion || '')} historical forecasts, scored against observed EirGrid curtailment">Historical replay</span>`;
  return `<div class="bz-scenario" aria-label="Scenario">
    <span class="bz-scn"><span class="bz-scn-icon">${bzIcon('building', 17)}</span><span><b>Example site</b><small>${n(d.hub.chargers)} × ${n(d.hub.chargerKw)} kW · simulated</small></span></span>
    <span class="bz-scn"><span class="bz-scn-icon">${icon('calendar', 17)}</span><span>${sim ? `<b>Example week</b><small>${n(r.period.nights)} nights · fixed weather</small>` : `<b>${bzPeriod(r.period)}</b><small>${n(r.period.nights)} nights replayed</small>`}</span></span>
    <span class="bz-chip is-projected" title="${escapeHtml(`${d.label}. No real customers, bookings, payments or battery: without real settlement data these are projections, never money earned.`)}">Projected</span>
    ${mode}</div>`;
}

function bzKpiRow(r) {
  const d = r.discountWindows, k = d.kpis, m = d.month, per = m.perSession;
  const loss = (v, tone) => (bzTone(v) === 'profit' ? tone : bzTone(v));
  const extraFoot = k.sessions ? `vs basic smart charging · ${n(k.sessions)} sessions` : 'no eligible sessions: nothing extra to share';
  const driverFoot = k.sessions ? `${bzCents(per.driverEur)} off each ${n(d.sessionKwh)} kWh charge` : 'normal prices apply';
  const opFoot = `${bzCents(m.operator.retainedEur)} kept − ${bzCents(m.operator.fixedEur)} programme costs`;
  const usFoot = `from ${bzCents(m.platform.grossEur)} gross commission`;
  return `<section class="bz-kpis" aria-label="Monthly business case at the example site, projected from the replay">
    ${bzKpi('blue', 'spark', 'Extra savings from our AI', 'bzExtra', `Extra savings from our AI ${bzEur(k.aiExtraSavingsEur)} a month versus basic smart charging`, `<em>${extraFoot}</em>`)}
    ${bzKpi('green', 'car', 'Drivers saved', 'bzDrivers', `Drivers saved ${bzEur(k.driversSavedEur)} a month`, `<em>${driverFoot}</em>`)}
    ${bzKpi(loss(k.operatorProfitEur, 'teal'), 'building', 'Charging operator profit', 'bzOperator', `Charging operator profit ${bzEur(k.operatorProfitEur)} a month after its programme costs`, `<em>${opFoot}</em>`)}
    ${bzKpi(loss(k.platformProfitEur, 'profit'), 'euro', 'Our operating profit', 'bzPlatform', `Our operating profit ${bzEur(k.platformProfitEur)} a month, from ${bzEur(k.platformGrossEur)} gross commission`, `<em>${usFoot}</em>`)}
  </section>`;
}

// One profit bridge: revenue, then costs, then the profit (or loss) that is left.
function bzBridge(id, title, rows, total, breakEven) {
  const tone = bzTone(total[1]);
  const even = bzHas(breakEven) ? `Break-even: ${n(breakEven)} sessions` : 'Never breaks even';
  return `<div class="bz-bridge is-${id}"><h3><i></i>${title}</h3>
    <ul>${rows.map(([label, v]) => `<li><span>${label}</span><b>${bzCents(v, false)}</b></li>`).join('')}</ul>
    <p class="bz-bridge-total is-${tone}"><span>${total[0]}</span><b>${bzCents(total[1])}</b></p>
    <small>${even}</small></div>`;
}
function bzSplitCard(r) {
  const d = r.discountWindows, m = d.month, parts = bzParts(d);
  const legend = BZ_PARTS.map(([id, label]) => `<li class="is-${id}"><i></i><span>${id === 'operator' ? 'Operator' : label} <small>${d.split[id]}%</small></span></li>`).join('');
  return `<section class="dash-card bz-card bz-split-card">
    ${bzHead('split', 'blue', 'Where the € goes', `Extra AI savings a month, split ${d.split.driver} / ${d.split.operator} / ${d.split.platform}`, `<span class="bz-split-total"><b>${bzCents(m.poolEur)}</b><small>${n(m.sessions)} sessions</small></span>`)}
    ${chartSlot('bzSplit', `Of ${bzCents(m.poolEur)} extra savings a month: drivers ${bzCents(parts.driver)}, charging operator ${bzCents(parts.operator)}, us ${bzCents(parts.platform)}`, 'bz-split-chart')}
    <ul class="bz-legend">${legend}</ul>
    <div class="bz-bridges">
      ${bzBridge('platform', 'Us', [['Commission', m.platform.grossEur], ['Per-session costs', -m.platform.variableEur], ['Overhead', -m.platform.fixedEur]], ['Operating profit', m.platform.profitEur], m.platform.breakEvenSessions)}
      ${bzBridge('operator', 'Charging operator', [[`${d.split.operator}% share`, m.operator.retainedEur], ['Programme costs', -m.operator.fixedEur]], ['Extra profit', m.operator.profitEur], m.operator.breakEvenSessions)}
    </div>
  </section>`;
}

function bzMoneyCard(r) {
  const s = r.seasonal, f = r.financials;
  const basis = s.available ? 'season-adjusted' : 'not season-adjusted';
  const payback = f.paybackStatus === 'months' ? `Setup pays back in ${bzMonths(f.paybackMonths)}` : 'Depot setup does not pay back';
  const button = `<button type="button" class="bz-link" data-bz-details aria-expanded="false">Investment details</button>`;
  return `<section class="dash-card bz-card bz-money">
    ${bzHead('euro', 'green', 'Where does the money come from?', `Depot · ${n(r.company.vehicles)} vans · yearly · ${basis}`)}
    ${chartSlot('bzWaterfall', `Waterfall: normal charging ${bzEur(r.financials.baselineCostEur)}, smarter timing ${bzEur(-r.financials.smartTimingSavingsEur, true)}, AI forecast ${bzEur(-r.financials.aiSavingsEur, true)}, software ${bzEur(r.financials.annualCostsEur, true)}, with our AI ${bzEur(r.financials.finalCostEur)} a year`, 'bz-wf-chart')}
    <p class="bz-foot is-invest">${bzIcon('hourglass', 14)}<span title="${escapeHtml(`${bzEur(f.implementationEur)} example setup cost`)}">${payback}</span>${button}</p>
  </section>`;
}

function bzCompareCard(r) {
  const m = BZ_METRICS[bz.metric], c = r.forecastCalls;
  const seg = `<div class="bz-seg" role="group" aria-label="Compare by">${Object.entries(BZ_METRICS).map(([key, x]) => `<button type="button" data-bz-metric="${key}" aria-pressed="${bz.metric === key}" class="${bz.metric === key ? 'is-active' : ''}">${x.label}</button>`).join('')}</div>`;
  const calls = c.surplusCalls ? `Forecast said “surplus” ${n(c.surplusCalls)} times: ${n(c.right)} right, ${n(c.falseAlarms)} false alarms, ${n(c.missed)} missed` : 'The forecast never called a surplus while vans were plugged in';
  return `<section class="dash-card bz-card bz-compare">
    ${bzHead('spark', 'blue', 'Is our AI making a difference?', 'Same vans, prices and limits · no look-ahead')}
    <div class="bz-cmp-bar">${seg}<p class="bz-cmp-unit"><span>${m.unit}</span><em>${m.better === 'lower' ? 'lower is better' : 'higher is better'}</em></p></div>
    ${chartSlot('bzCompare', `${m.unit} for normal, basic smart and AI charging`, 'bz-cmp-chart')}
    <p class="bz-foot" title="Each call is a half-hour with vans plugged in where the +30 minute forecast predicted enough curtailment to cover the site's full draw; checked against observed curtailment.">${bzIcon('info', 14)}<span>${calls}</span></p>
  </section>`;
}

function bzCalcCard(r) {
  const c = bz.calc, costs = c.view === 'costs', d = r.discountWindows, active = bzActivePreset();
  const presets = `<div class="bz-seg is-small" role="group" aria-label="Start from">${BZ_PRESETS.map(([id, label]) => `<button type="button" data-bz-preset="${id}" aria-pressed="${active === id}" class="${active === id ? 'is-active' : ''}">${label}</button>`).join('')}</div>`;
  // The cost inputs replace the main inputs in the same space, so the page never reflows.
  const fields = costs
    ? `<p class="bz-fields-title">Costs <small>per site · savings are shared before these, profit is what is left</small></p>${BZ_COSTS.map(bzField).join('')}
      <div class="bz-adv"><button type="button" class="bz-link" data-bz-costs="done">${icon('check', 14)}Done</button></div>`
    : `${BZ_MAIN.map(bzField).join('')}<div class="bz-adv"><span class="bz-adv-note">${escapeHtml(bzCostNote())}</span><button type="button" class="bz-link" data-bz-costs="open">Edit costs</button></div>`;
  const cap = d.calculator.capacity;
  return `<section class="dash-card bz-card bz-calc${c.pending ? ' is-pending' : ''}">
    ${bzHead('calc', 'amber', 'What if…?', `One site, one month · the site fits ${n(cap.sessionsPerWindow)} sessions per window, ${n(cap.maxPerMonth)} a month`, presets)}
    <form class="bz-form" novalidate onsubmit="return false">
      <div class="bz-fields${costs ? ' is-costs' : ''}">${fields}</div>
      <div class="bz-out" aria-live="polite"><span class="bz-out-label">Our operating profit <small>projected · after our costs</small></span>
        ${chartSlot('bzCalcOut', 'Our operating profit per month', 'bz-out-figure')}
        <div class="bz-out-detail">${bzCalcDetail()}</div></div>
    </form>
  </section>`;
}

function bzEnergyCard(r) {
  const d = r.discountWindows, e = d.energy, b = e.battery, l = d.ledger;
  const src = [['stored', 'Stored surplus', e.sources.storedSurplusKwh], ['direct', 'Direct surplus', e.sources.directSurplusKwh], ['grid', 'Conventional grid', e.sources.conventionalKwh]];
  const top = Math.max(1, ...src.map((s) => s[2]));
  const rows = src.map(([id, label, kwh]) => `<li class="is-${id}"><span>${label}</span><i><em style="width:${((kwh / top) * 100).toFixed(1)}%"></em></i><b>${n(Math.round(kwh))} kWh</b></li>`).join('');
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
    <ul class="bz-sources">${rows}</ul>
    <dl class="bz-facts">${facts}</dl>
  </section>`;
}

function bzInvestCard(r) {
  const s = r.scenarios, f = r.financials;
  const button = '<button type="button" class="bz-details-btn" data-bz-details aria-expanded="true">Hide details' + bzIcon('close', 16) + '</button>';
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
  return `<section class="dash-card bz-card bz-invest is-open" aria-label="Investment details">
    ${bzHead('hourglass', 'amber', 'Depot investment details', `Example costs: ${bzEur(f.implementationEur)} setup, ${bzEur(f.annualCostsEur)} a year`, button)}
    <div class="bz-roi">
      <div><span>Payback</span><strong>${f.paybackStatus === 'months' ? bzMonths(f.paybackMonths) : 'Not achieved'}</strong></div>
      <div><span>${n(f.roiYears)}-year net return</span><strong>${bzEur(f.roiNetEur)}</strong></div>
      <div><span>Return on investment</span><strong>${bzHas(f.roiPct) ? `${n(f.roiPct)}%` : '—'}</strong></div>
    </div>
    <div class="bz-tables">
      <table class="bz-table"><caption>Scenarios</caption><thead><tr><th scope="col"></th><th scope="col">Savings/year</th><th scope="col">CO₂/year</th><th scope="col">Payback</th></tr></thead><tbody>${rows}</tbody></table>
      <table class="bz-table is-sites"><caption>More locations <small>each needs its own grid check</small></caption><thead><tr><th scope="col"></th><th scope="col">Savings/year</th><th scope="col">CO₂/year</th><th scope="col">Setup</th></tr></thead><tbody>${sites}</tbody></table>
    </div>
    <p class="bz-note">${season} Prices, fleet and costs are examples; replace them with your own quotes.</p>
  </section>`;
}

function bzProvenance(r) {
  const cov = r.coverage || {};
  const gaps = (cov.missingForecasts || cov.missingObservations) ? ` · ${n(cov.missingForecasts || 0)} forecasts and ${n(cov.missingObservations || 0)} observations missing (not filled in)` : '';
  const how = r.dataMode === 'simulated'
    ? 'Simulated example (GridToEv unavailable): fixed weather, same site and prices'
    : `GridToEv ${escapeHtml(r.modelVersion || '')} +30 min historical forecasts scored against observed EirGrid curtailment`;
  const d = r.discountWindows;
  const tip = [...(d.methodology || []), ...(d.limitations || []), d.prices.vat, ...(r.methodology || []), ...(r.limitations || [])].join('\n');
  return `<p class="bz-provenance" title="${escapeHtml(tip)}">${bzIcon('info', 13)}<span>${how} · hypothetical battery · illustrative prices, costs and demand · amounts ex VAT · projected revenue, simulated profit, not money earned · network deliverability not verified${gaps}</span></p>`;
}

// ---------------------------------------------------------------- states
function bzSkeleton() {
  const p = bz.progress, share = p?.total ? Math.min(1, (p.done + 0.5) / p.total) : 0.06;
  const kpi = '<article class="dash-card bz-kpi is-skeleton"><span class="bz-skel is-block"></span><span class="bz-skel"></span><span class="bz-skel is-short"></span></article>';
  const card = (cls) => `<section class="dash-card bz-card ${cls} is-skeleton"><span class="bz-skel is-short"></span><span class="bz-skel is-fill"></span></section>`;
  return `<div class="bz-layout is-loading" aria-busy="true"><section class="bz-kpis">${kpi.repeat(4)}</section>
    <section class="dash-card bz-card bz-split-card bz-progress" role="status"><span class="bz-progress-icon">${bzIcon('spark', 22)}</span>
      <h2>Replaying a week of charging</h2><p>${escapeHtml(p?.stage || 'Starting')}${p?.total ? ` · step ${n(Math.min(p.done + 1, p.total))} of ${n(p.total)}` : ''}. The first run replays a week of GridToEv forecasts; after that it is instant.</p>
      <span class="bz-bar"><i style="width:${(share * 100).toFixed(1)}%"></i></span></section>
    ${card('bz-money')}${card('bz-compare')}${card('bz-calc')}${card('bz-energy')}</div>`;
}
function bzMessage(kind, title, text, action = '') {
  return `<section class="dash-card bz-message is-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="bz-message-icon">${bzIcon(kind === 'error' ? 'alert' : 'info', 26)}</span><h2>${title}</h2><p>${text}</p>${action}</section>`;
}

function renderBusiness() {
  // First visit, or back on the page while the result was still being prepared (polling pauses off-page).
  if (bz.status === 'idle' || (bz.status === 'preparing' && !bz.timer && !bz.inFlight)) queueMicrotask(() => bzLoad());
  const top = studioHeader('Impact', 'Who saves and who earns from our AI.', bzScenario());
  const r = bz.result;
  if (bz.status === 'failed' && !r) {
    return top + bzMessage('error', 'The impact figures are unavailable', escapeHtml(bz.error || 'Something went wrong.'), `<button type="button" class="studio-button" data-bz-retry="load">Try again ${icon('arrow', 17)}</button>`);
  }
  if (bz.status === 'empty' && r) return top + bzMessage('empty', 'Nothing to evaluate yet', escapeHtml(r.message || 'No complete night of forecasts was available.'), '<button type="button" class="studio-button" data-bz-retry="model">Check again</button>');
  if (bz.status !== 'ready' || !r?.kpis) return top + bzSkeleton();
  const cards = bz.details ? bzInvestCard(r) : `${bzMoneyCard(r)}${bzCompareCard(r)}`;
  return `${top}<div class="bz-layout${bz.details ? ' is-details' : ''}">${bzKpiRow(r)}${bzSplitCard(r)}${cards}${bzCalcCard(r)}${bzEnergyCard(r)}</div>${bzProvenance(r)}`;
}
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
  if (pick('data-bz-details')) { bz.details = !bz.details; bzRender(); return; }
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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && bz.details && pageFromHash() === 'business') { bz.details = false; bzRender(); }
});
