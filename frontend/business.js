// Impact page: what smarter EV charging could save, in money and CO2, for a simulated depot.
// Every figure comes from /api/v1/business/impact (backend/business.py): three charging strategies
// charge the same vans on the same nights of Carlson's historical GridToEv forecasts, scored against
// what EirGrid observed. The page draws the backend's figures and never recomputes them, so the KPI
// cards, the waterfall, the comparison and the investment details always agree.
const bz = {
  status: 'idle', // idle | loading | preparing | ready | empty | failed
  result: null, progress: null, error: '', token: 0, timer: null, inFlight: false,
  metric: 'money', // comparison chart: money | co2 | renewable
  details: false, // investment details open
  // advanced: the optional costs are part of the estimate; view: which inputs show (fleet | costs)
  calc: { values: null, errors: {}, advanced: false, view: 'fleet', result: null, seq: 0, pending: false, error: '', timer: null },
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
    else if (body.status === 'ready' && body.kpis) next = { status: 'ready', result: body };
    else next = { status: 'failed', error: 'The impact result was incomplete.' };
  } catch (error) {
    if (token !== bz.token) return;
    next = { status: 'failed', error: error.name === 'AbortError' ? 'The server took too long to answer.' : 'Could not reach the SaveThePlanet server.' };
  }
  bz.inFlight = false;
  Object.assign(bz, next);
  if (bz.status === 'preparing') bz.timer = setTimeout(() => { bz.timer = null; if (pageFromHash() === 'business') bzLoad(); }, 1500);
  if (bz.status === 'ready' && bz.calc.values === null) bzCalcReset();
  bzRender();
}

// Re-render and put keyboard focus back where it was, since render() rebuilds <main>.
const BZ_FOCUS = ['data-bz-metric', 'data-bz-details', 'data-bz-costs', 'data-bz-retry', 'data-bz-input', 'data-bz-reset'];
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

// Animated KPI figures; money counts up in whole euros, payback in tenths of a month.
function bzFigure(name, get) {
  bzChart(name, {
    values: () => { const f = get(); return { v: bzHas(f?.v) ? f.v : 0, kind: f?.kind || 'none', text: f?.text || '' }; },
    start: (t) => ({ ...t, v: 0 }),
    draw({ v, kind, text }) {
      if (kind === 'text') return `<strong class="is-text">${text}</strong>`;
      if (kind === 'eur') return `<strong>${bzEur(v)}<small>/year</small></strong>`;
      if (kind === 'co2') return `<strong>${bzT(v)}<small>t CO₂/year</small></strong>`;
      if (kind === 'months') return `<strong>${n(Math.round(v * 10) / 10)}<small>${Math.round(v * 10) === 10 ? 'month' : 'months'}</small></strong>`;
      return '<strong>—</strong>';
    },
  });
}
bzFigure('bzSavings', () => bzR() && { v: bzR().kpis.annualSavingsEur, kind: 'eur' });
bzFigure('bzCo2', () => bzR() && { v: bzR().kpis.co2ReductionT, kind: 'co2' });
bzFigure('bzAi', () => bzR() && { v: bzR().kpis.aiSavingsEur, kind: 'eur' });
bzFigure('bzPayback', () => {
  const k = bzR()?.kpis;
  if (!k) return null;
  return k.paybackStatus === 'months' ? { v: k.paybackMonths, kind: 'months' } : { kind: 'text', text: 'Not achieved' };
});

// Where does the money come from: yearly cost from normal charging to our AI, step by step.
const BZ_STEP_NOTES = {
  baseline: 'Every van charges as soon as it plugs in, mostly at peak and day prices.',
  timing: 'A simple rule moves charging into the cheapest night hours. No forecast needed.',
  ai: 'Charging moved into half-hours where GridToEv forecast surplus renewable energy.',
  running: 'Example yearly software cost.',
  final: 'Electricity plus software, with our AI.',
};
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
      const note = s.id === 'ai' && s.value > 0 ? 'The forecast-led plan cost more than the simple rule here.' : BZ_STEP_NOTES[s.id] || '';
      const join = i < count - 1 ? `<i class="bz-join" style="bottom:${at(s.to).toFixed(2)}%;opacity:${grow > 0.98 ? 1 : 0}"></i>` : '';
      const tipSide = i >= Math.floor(count / 2) ? ' is-left' : ''; // right-hand bars open their tip leftwards
      return `<div class="bz-wf-col ${tone}" tabindex="0" aria-label="${escapeHtml(`${s.label}: ${value} a year. ${note}`)}">
        <span class="bz-wf-bar" style="bottom:${bottom.toFixed(2)}%;height:${height.toFixed(2)}%"><em style="opacity:${grow > 0.9 ? 1 : 0}">${value}</em></span>${join}
        <span class="bz-tip${tipSide}" style="bottom:${Math.min(80, Math.max(12, (at(lo) + at(hi)) / 2)).toFixed(1)}%"><b>${escapeHtml(s.label)}</b><strong>${value} a year</strong><small>${escapeHtml(note)}</small></span></div>`;
    }).join('');
    const labels = steps.map((s) => `<span>${escapeHtml(s.label)}</span>`).join('');
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
  if (req.allMet) return `<span class="bz-req is-met" title="Every van reached its required charge before it left">${icon('check', 14)}${n(req.met)}/${n(req.total)} van-nights on time</span>`;
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

// Calculator output: estimated yearly savings.
bzChart('bzCalcOut', {
  values() {
    const c = bz.calc.result;
    return { v: c && !Object.keys(bz.calc.errors).length ? c.yearlySavingsEur : 0, none: c && !Object.keys(bz.calc.errors).length ? '' : '1' };
  },
  start: (t) => ({ ...t, v: 0 }),
  draw: ({ v, none }) => (none ? '<strong>—</strong>' : `<strong>${bzEur(v)}<small>/year</small></strong>`),
});

// Investment range: conservative, expected and optimistic yearly savings on one track from €0.
// The two extremes are named at the ends of the track, so close values never overlap.
bzChart('bzRange', {
  values() {
    const s = bzR()?.scenarios;
    if (!s) return { lo: 0, mid: 0, hi: 0, max: 1, min: 0 };
    const lo = s.conservative.annualSavingsEur, mid = s.expected.annualSavingsEur, hi = s.optimistic.annualSavingsEur;
    const top = bzScale(Math.max(Math.abs(lo), Math.abs(hi), 1)).max;
    return { lo, mid, hi, max: top, min: lo < 0 ? -top : 0 };
  },
  start: (t) => ({ ...t, lo: t.mid, hi: t.mid }),
  draw({ lo, mid, hi, max, min }) {
    const at = (v) => Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
    return `<div class="bz-range"><span class="bz-range-track"><i style="left:${at(lo).toFixed(2)}%;width:${Math.max(0, at(hi) - at(lo)).toFixed(2)}%"></i>${min < 0 ? `<em class="bz-range-zero" style="left:${at(0).toFixed(2)}%" title="€0"></em>` : ''}<b style="left:${at(mid).toFixed(2)}%"></b></span>
      <span class="bz-range-scale"><small>${bzShortEur(min)}</small><small>${bzShortEur(max)}</small></span>
      <span class="bz-range-values"><span><small>Conservative</small><b>${bzEur(lo)}</b></span><span class="is-mid"><small>Expected</small><b>${bzEur(mid)}</b></span><span><small>Optimistic</small><b>${bzEur(hi)}</b></span></span></div>`;
  },
});

// ---------------------------------------------------------------- calculator
const BZ_FIELDS = {
  // name: [label, min, max, whole number, unit, explanation]
  evs: ['Number of EVs', 1, 10000, true, 'EVs', 'Planned by the energy bridge on the example site: once its chargers and connection are full, more EVs add nothing.'],
  shiftablePct: ['Electricity that can feasibly be shifted', 0, 100, false, '% of charging', 'Share of each EV\'s daily charging that can move to cheaper or cleaner hours.'],
  priceDiffEurPerKwh: ['Achievable electricity price difference', 0, 1, false, '€/kWh', 'Average saving on each kWh that moves.'],
  operatingDays: ['Operating days per year', 1, 366, true, 'days', 'Days a year the fleet charges.'],
  implementationEur: ['One-off implementation cost', 0, 10000000, false, '€', 'Setup: software, charger integration, installation.'],
  annualEur: ['Yearly running cost', 0, 1000000, false, '€/year', 'Software subscription and support.'],
};
const BZ_OPTIONAL = ['implementationEur', 'annualEur'];
// Same limits as the server (business.parse_estimate); the server's answer is authoritative.
function bzValidate(raw, advanced) {
  const values = {}, errors = {};
  for (const [name, [label, lo, hi, whole]] of Object.entries(BZ_FIELDS)) {
    const optional = BZ_OPTIONAL.includes(name);
    if (optional && !advanced) continue;
    const text = String(raw?.[name] ?? '').trim().replace(/,/g, '');
    if (text === '') { if (!optional) errors[name] = 'Required'; continue; }
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
function bzCalcReset() {
  const d = bz.result?.calculator?.defaults;
  if (!d) return;
  bz.calc.values = Object.fromEntries(Object.keys(BZ_FIELDS).map((k) => [k, String(d[k] ?? '')]));
  bz.calc.errors = {}; bz.calc.error = '';
  bzEstimate();
}
function bzCalcChanged() {
  const { errors } = bzValidate(bz.calc.values, bz.calc.advanced);
  bz.calc.errors = errors;
  clearTimeout(bz.calc.timer);
  bz.calc.seq++; // any answer still on its way now describes old inputs
  bz.calc.pending = !Object.keys(errors).length; // the figure dims until the new answer arrives
  bzCalcPaint();
  if (bz.calc.pending) bz.calc.timer = setTimeout(bzEstimate, 280);
}
// Asks the server for the estimate. Only the newest request may update the page.
async function bzEstimate() {
  const { values, errors } = bzValidate(bz.calc.values, bz.calc.advanced);
  bz.calc.errors = errors;
  const seq = ++bz.calc.seq;
  if (Object.keys(errors).length) { bz.calc.pending = false; bzCalcPaint(); return; }
  bz.calc.pending = true; bzCalcPaint();
  try {
    const { ok, body } = await bzFetch(`/api/v1/business/estimate?${bzCalcQuery(values)}`, 10000);
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
  const costs = c.advanced && (r.annualCostsEur > 0 || r.implementationEur > 0);
  const payback = !c.advanced || r.paybackStatus === 'no-investment' ? ''
    : r.paybackStatus === 'months' ? `<li><span>Pays back in</span><b>${bzMonths(r.paybackMonths)}</b></li>`
      : '<li class="is-warn"><span>Payback</span><b>Not achieved</b></li>';
  return `<ul class="bz-out-list">${bzSiteCheck(r.feasibility)}<li><span>Shifted</span><b>${n(r.shiftedKwhPerYear)} kWh/yr</b></li>
    ${costs ? `<li><span>Before costs</span><b>${bzEur(r.grossSavingsEur)}</b></li>` : ''}${payback}</ul>`;
}
// The energy bridge's verdict for these EVs on the example site (chargers, connection, plug-in hours).
const BZ_LIMITS = {
  'site-power': (site) => `the site's ${n(site.sitePowerKw)} kW connection is full overnight`,
  chargers: (site) => `all ${n(site.chargers)} chargers are busy`,
  'plug-in-hours': () => 'there is not enough plug-in time',
};
function bzSiteCheck(f) {
  if (!f) return '';
  if (f.vehiclesMet >= f.evs) return `<li title="Planned by the energy bridge on the example site: ${n(f.site.chargers)} × ${n(f.site.chargerKw)} kW chargers, ${n(f.site.sitePowerKw)} kW connection."><span>Site check</span><b>all ${n(f.evs)} EVs fit</b></li>`;
  const why = (BZ_LIMITS[f.limitedBy] || (() => 'the site is full'))(f.site);
  return `<li class="is-warn" title="Only energy the example site can deliver overnight is counted: ${escapeHtml(why)}. More EVs need more charging capacity."><span>Site check</span><b>${n(f.vehiclesMet)} of ${n(f.evs)} EVs fit</b></li>`;
}
// Whether the figure shown includes costs: taken from the answer on screen, not the toggle.
function bzCalcBasis() {
  const r = bz.calc.result;
  return r && (r.annualCostsEur > 0 || r.implementationEur > 0) ? 'after costs' : 'before costs';
}
// Updates only the calculator output and field errors, so typing never loses focus.
function bzCalcPaint() {
  const main = document.querySelector('main[data-current-page="business"]');
  if (!main) return;
  const detail = main.querySelector('.bz-out-detail'), card = main.querySelector('.bz-calc');
  if (!detail || !card) return;
  detail.innerHTML = bzCalcDetail();
  const basis = main.querySelector('.bz-out-basis');
  if (basis) basis.textContent = bzCalcBasis();
  card.classList.toggle('is-pending', bz.calc.pending);
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
  const sim = r.dataMode === 'simulated';
  const mode = sim
    ? `<button type="button" class="bz-chip is-sim" data-bz-retry="model" title="GridToEv is unavailable (${escapeHtml(r.fallback?.reason || '')}); this is a fixed simulated example. Click to try the model again.">${bzIcon('alert', 14)}Simulated data · retry model</button>`
    : `<span class="bz-chip is-replay" title="GridToEv ${escapeHtml(r.modelVersion || '')} historical forecasts, scored against observed EirGrid curtailment">Historical replay</span>`;
  return `<div class="bz-scenario" aria-label="Scenario">
    <span class="bz-scn"><span class="bz-scn-icon">${bzIcon('building', 17)}</span><span><b>${escapeHtml(r.company.name)}</b><small>${n(r.company.vehicles)} EVs · simulated company</small></span></span>
    <span class="bz-scn"><span class="bz-scn-icon">${icon('calendar', 17)}</span><span>${sim ? `<b>Example week</b><small>${n(r.period.nights)} nights · fixed weather</small>` : `<b>${bzPeriod(r.period)}</b><small>${n(r.period.nights)} nights simulated</small>`}</span></span>
    ${mode}</div>`;
}

function bzKpiRow(r) {
  const k = r.kpis, f = r.financials, base = f.baselineCostEur;
  const pct = (v) => (base > 0 && bzHas(v) ? Math.round((v / base) * 100) : null);
  const saved = pct(k.annualSavingsEur), normalCo2 = r.strategies.find((s) => s.id === 'normal')?.annual.co2T;
  const co2Pct = normalCo2 > 0 ? Math.round((k.co2ReductionT / normalCo2) * 100) : null;
  const savingsFoot = `${saved !== null && saved > 0 ? `−${saved}% vs normal · ` : ''}net of ${bzEur(f.annualCostsEur)} software`;
  const aiFoot = k.aiSavingsEur < 0 ? 'costs more than basic smart charging here' : k.aiSavingsEur === 0 ? 'no gain over basic smart charging here' : 'on top of basic smart charging';
  const co2Foot = k.co2ReductionT < 0 ? 'estimated · more than normal charging' : `estimated · ${co2Pct ? `−${co2Pct}% ` : ''}vs normal charging`;
  const payFoot = k.paybackStatus === 'months' ? `${bzEur(f.implementationEur)} example setup cost` : 'net savings are not positive';
  return `<section class="bz-kpis" aria-label="Headline results">
    ${bzKpi('green', 'euro', 'Projected annual savings', 'bzSavings', `Projected annual savings ${bzEur(k.annualSavingsEur)} a year`, `<em>${savingsFoot}</em>`)}
    ${bzKpi('teal', 'leaf', 'Estimated CO₂ reduction', 'bzCo2', `Estimated CO2 reduction ${bzT(k.co2ReductionT)} tonnes a year`, `<em>${co2Foot}</em>`)}
    ${bzKpi('blue', 'spark', 'Additional AI savings', 'bzAi', `Additional AI savings ${bzEur(k.aiSavingsEur)} a year versus rule-based charging`, `<em>${aiFoot}</em>`)}
    ${bzKpi('amber', 'hourglass', 'Investment payback', 'bzPayback', k.paybackStatus === 'months' ? `Investment payback ${bzMonths(k.paybackMonths)}` : 'Investment payback not achieved', `<em>${payFoot}</em>`)}
  </section>`;
}

function bzMoneyCard(r) {
  const s = r.seasonal;
  const basis = s.available ? 'adjusted to a full year of weather' : 'not adjusted for the season';
  return `<section class="dash-card bz-card bz-money">
    ${bzHead('euro', 'green', 'Where does the money come from?', `Yearly cost for ${n(r.company.vehicles)} vans · ${n(r.period.operatingDays)} charging days · ${basis}`)}
    ${chartSlot('bzWaterfall', `Waterfall: normal charging ${bzEur(r.financials.baselineCostEur)}, smarter timing ${bzEur(-r.financials.smartTimingSavingsEur, true)}, AI forecast ${bzEur(-r.financials.aiSavingsEur, true)}, software ${bzEur(r.financials.annualCostsEur, true)}, with our AI ${bzEur(r.financials.finalCostEur)} a year`, 'bz-wf-chart')}
  </section>`;
}

function bzCompareCard(r) {
  const m = BZ_METRICS[bz.metric], c = r.forecastCalls;
  const seg = `<div class="bz-seg" role="group" aria-label="Compare by">${Object.entries(BZ_METRICS).map(([key, x]) => `<button type="button" data-bz-metric="${key}" aria-pressed="${bz.metric === key}" class="${bz.metric === key ? 'is-active' : ''}">${x.label}</button>`).join('')}</div>`;
  const calls = c.surplusCalls ? `Forecast said “surplus” ${n(c.surplusCalls)} times: ${n(c.right)} right, ${n(c.falseAlarms)} false alarms, ${n(c.missed)} missed` : 'The forecast never called a surplus while vans were plugged in';
  return `<section class="dash-card bz-card bz-compare">
    ${bzHead('spark', 'blue', 'Is our AI making a difference?', 'Same vans, prices and limits · no strategy sees the future')}
    <div class="bz-cmp-bar">${seg}<p class="bz-cmp-unit"><span>${m.unit}</span><em>${m.better === 'lower' ? 'lower is better' : 'higher is better'}</em></p></div>
    ${chartSlot('bzCompare', `${m.unit} for normal, basic smart and AI charging`, 'bz-cmp-chart')}
    <p class="bz-foot" title="Each call is a half-hour with vans plugged in where the +30 minute forecast predicted enough curtailment to cover the site's full draw; checked against observed curtailment.">${bzIcon('info', 14)}<span>${calls}</span></p>
  </section>`;
}

function bzCalcCard(r) {
  const c = bz.calc, costs = c.view === 'costs';
  // The optional costs replace the fleet inputs in the same space, so the page never reflows.
  let fields;
  if (costs) {
    fields = `<p class="bz-fields-title">Optional costs <small>used for the after-costs saving and payback</small></p>
      ${bzField('implementationEur')}${bzField('annualEur')}
      <div class="bz-adv"><button type="button" class="bz-link" data-bz-costs="done">${icon('check', 14)}Done</button><button type="button" class="bz-link is-quiet" data-bz-costs="remove">Remove costs</button></div>`;
  } else {
    const included = c.advanced && !BZ_OPTIONAL.some((k) => c.errors[k]);
    fields = ['evs', 'shiftablePct', 'priceDiffEurPerKwh', 'operatingDays'].map(bzField).join('') + (included
      ? `<div class="bz-adv"><span class="bz-adv-note">Costs included: ${escapeHtml(bzEur(Number(c.values.implementationEur) || 0))} setup · ${escapeHtml(bzEur(Number(c.values.annualEur) || 0))}/year</span><button type="button" class="bz-link" data-bz-costs="open">Edit</button><button type="button" class="bz-link is-quiet" data-bz-costs="remove">Remove</button></div>`
      : '<div class="bz-adv"><button type="button" class="bz-link" data-bz-costs="open">+ Add implementation and yearly costs <small>(optional)</small></button></div>');
  }
  return `<section class="dash-card bz-card bz-calc${c.pending ? ' is-pending' : ''}">
    ${bzHead('calc', 'amber', 'What if my company used this?', `Starts from the example depot: ${n(r.company.kwhPerEvDay)} kWh per EV per day`,
    `<span class="bz-chip is-illustrative" title="EVs × ${n(r.company.kwhPerEvDay)} kWh a day × share shifted × price difference × days. Every input changes the result. The energy bridge plans your EVs on the example site (${n(r.company.chargers)} × ${n(r.company.chargerKw)} kW chargers, ${n(r.company.sitePowerKw)} kW connection): charging it cannot fit overnight is not counted. The share and price difference are your assumptions.">Site checked · illustrative prices</span>`)}
    <form class="bz-form" novalidate onsubmit="return false">
      <div class="bz-fields${costs ? ' is-costs' : ''}">${fields}</div>
      <div class="bz-out" aria-live="polite"><span class="bz-out-label">Estimated yearly savings <small class="bz-out-basis">${bzCalcBasis()}</small></span>
        ${chartSlot('bzCalcOut', 'Estimated yearly savings', 'bz-out-figure')}
        <div class="bz-out-detail">${bzCalcDetail()}</div>
        <button type="button" class="bz-link is-reset" data-bz-reset>Reset to the example depot</button></div>
    </form>
  </section>`;
}

function bzInvestCard(r) {
  const s = r.scenarios, f = r.financials, open = bz.details;
  const button = `<button type="button" class="bz-details-btn" data-bz-details aria-expanded="${open}">${open ? 'Hide details' : 'View investment details'}${bzIcon(open ? 'close' : 'chevron', 16)}</button>`;
  if (!open) {
    return `<section class="dash-card bz-card bz-invest">
      ${bzHead('hourglass', 'amber', 'Investment case', `${bzEur(f.implementationEur)} example setup · ${n(f.roiYears)}-year view`)}
      <p class="bz-range-title"><span>Yearly savings, net of costs</span><small>depends on how often surplus occurs</small></p>
      ${chartSlot('bzRange', `Yearly savings from ${bzEur(s.conservative.annualSavingsEur)} (conservative) to ${bzEur(s.optimistic.annualSavingsEur)} (optimistic), expected ${bzEur(s.expected.annualSavingsEur)}`, 'bz-range-chart')}
      ${button}
    </section>`;
  }
  const pay = (x) => (x.paybackStatus === 'months' ? bzMonths(x.paybackMonths) : 'Not achieved');
  const rows = [
    ['conservative', 'Conservative', 'No surplus benefit: smarter timing only'],
    ['expected', 'Expected', r.seasonal.available ? 'Surplus scaled to a full observed year' : 'The evaluation week, not seasonally adjusted'],
    ['optimistic', 'Optimistic', 'Every week as good as the evaluation week'],
  ].map(([key, label, note]) => `<tr class="${key === 'expected' ? 'is-expected' : ''}"><th scope="row"><b>${label}</b><small>${note}</small></th><td>${bzEur(s[key].annualSavingsEur)}</td><td>${bzT(s[key].co2ReductionT)} t</td><td>${pay(s[key])}</td></tr>`).join('');
  const sites = r.scaling.map((x) => `<tr><th scope="row">${n(x.sites)} ${x.sites === 1 ? 'site' : 'sites'}</th><td>${bzEur(x.annualSavingsEur)}</td><td>${bzT(x.co2ReductionT)} t</td><td>${bzEur(x.implementationEur)}</td></tr>`).join('');
  const season = r.seasonal.available
    ? `Curtailment happened on ${Math.round(r.seasonal.yearEventRate * 100)}% of days over a full year (${bzDay(r.seasonal.yearFrom, true)} – ${bzDay(r.seasonal.yearTo, true)}) and ${Math.round(r.seasonal.periodEventRate * 100)}% of the evaluation days, so the surplus part is scaled ×${n(Math.round(r.seasonal.appliedFactor * 100) / 100)}.`
    : `No seasonal adjustment: ${escapeHtml(r.seasonal.reason || 'not available')}`;
  return `<section class="dash-card bz-card bz-invest is-open" aria-label="Investment details">
    ${bzHead('hourglass', 'amber', 'Investment details', `Example costs: ${bzEur(f.implementationEur)} setup, ${bzEur(f.annualCostsEur)} a year`, button)}
    <div class="bz-roi">
      <div><span>Payback</span><strong>${f.paybackStatus === 'months' ? bzMonths(f.paybackMonths) : 'Not achieved'}</strong></div>
      <div><span>${n(f.roiYears)}-year net return</span><strong>${bzEur(f.roiNetEur)}</strong></div>
      <div><span>Return on investment</span><strong>${bzHas(f.roiPct) ? `${n(f.roiPct)}%` : '—'}</strong></div>
    </div>
    <table class="bz-table"><caption>Scenarios</caption><thead><tr><th scope="col"></th><th scope="col">Savings/year</th><th scope="col">CO₂/year</th><th scope="col">Payback</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="bz-table is-sites"><caption>More locations <small>each site needs its own charger and grid check</small></caption><thead><tr><th scope="col"></th><th scope="col">Savings/year</th><th scope="col">CO₂/year</th><th scope="col">Setup</th></tr></thead><tbody>${sites}</tbody></table>
    <p class="bz-note">${season} Prices, fleet and costs are examples; replace them with your own quotes.</p>
  </section>`;
}

function bzProvenance(r) {
  const cov = r.coverage || {};
  const gaps = (cov.missingForecasts || cov.missingObservations) ? ` · ${n(cov.missingForecasts || 0)} forecasts and ${n(cov.missingObservations || 0)} observations missing (not filled in)` : '';
  const how = r.dataMode === 'simulated'
    ? 'Simulated example (GridToEv unavailable): fixed weather, same fleet and prices'
    : `GridToEv ${escapeHtml(r.modelVersion || '')} +30 min historical forecasts scored against observed EirGrid curtailment`;
  return `<p class="bz-provenance" title="${escapeHtml([...(r.methodology || []), ...(r.limitations || [])].join('\n'))}">${bzIcon('info', 13)}<span>${how} · simulated fleet · illustrative prices · CO₂ estimated at ${n(r.emissions.gridIntensityKgPerKwh)} kg/kWh · network deliverability not verified${gaps}</span></p>`;
}

// ---------------------------------------------------------------- states
function bzSkeleton() {
  const p = bz.progress, share = p?.total ? Math.min(1, (p.done + 0.5) / p.total) : 0.06;
  const kpi = '<article class="dash-card bz-kpi is-skeleton"><span class="bz-skel is-block"></span><span class="bz-skel"></span><span class="bz-skel is-short"></span></article>';
  const card = (cls) => `<section class="dash-card bz-card ${cls} is-skeleton"><span class="bz-skel is-short"></span><span class="bz-skel is-fill"></span></section>`;
  return `<div class="bz-layout is-loading" aria-busy="true"><section class="bz-kpis">${kpi.repeat(4)}</section>
    <section class="dash-card bz-card bz-money bz-progress" role="status"><span class="bz-progress-icon">${bzIcon('spark', 22)}</span>
      <h2>Simulating three ways to charge</h2><p>${escapeHtml(p?.stage || 'Starting')}${p?.total ? ` · step ${n(Math.min(p.done + 1, p.total))} of ${n(p.total)}` : ''}. The first run replays a week of GridToEv forecasts; after that it is instant.</p>
      <span class="bz-bar"><i style="width:${(share * 100).toFixed(1)}%"></i></span></section>
    ${card('bz-compare')}${card('bz-calc')}${card('bz-invest')}</div>`;
}
function bzMessage(kind, title, text, action = '') {
  return `<section class="dash-card bz-message is-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="bz-message-icon">${bzIcon(kind === 'error' ? 'alert' : 'info', 26)}</span><h2>${title}</h2><p>${text}</p>${action}</section>`;
}

function renderBusiness() {
  // First visit, or back on the page while the result was still being prepared (polling pauses off-page).
  if (bz.status === 'idle' || (bz.status === 'preparing' && !bz.timer && !bz.inFlight)) queueMicrotask(() => bzLoad());
  const top = studioHeader('Impact', 'See what smarter EV charging could save.', bzScenario());
  const r = bz.result;
  if (bz.status === 'failed' && !r) {
    return top + bzMessage('error', 'The impact figures are unavailable', escapeHtml(bz.error || 'Something went wrong.'), `<button type="button" class="studio-button" data-bz-retry="load">Try again ${icon('arrow', 17)}</button>`);
  }
  if (bz.status === 'empty' && r) return top + bzMessage('empty', 'Nothing to evaluate yet', escapeHtml(r.message || 'No complete night of forecasts was available.'), '<button type="button" class="studio-button" data-bz-retry="model">Check again</button>');
  if (bz.status !== 'ready' || !r?.kpis) return top + bzSkeleton();
  return `${top}<div class="bz-layout${bz.details ? ' is-details' : ''}">${bzKpiRow(r)}${bzMoneyCard(r)}${bz.details ? '' : bzCompareCard(r)}${bzCalcCard(r)}${bzInvestCard(r)}</div>${bzProvenance(r)}`;
}
// Optional costs: open (and include them), done (back to the fleet inputs), remove.
function bzCosts(action) {
  const c = bz.calc;
  if (action === 'open') { c.advanced = true; c.view = 'costs'; }
  else if (action === 'done') {
    const { errors } = bzValidate(c.values, true);
    if (BZ_OPTIONAL.some((k) => errors[k])) { bzCalcChanged(); return; } // stay until the costs are valid
    c.view = 'fleet';
  } else if (action === 'remove') { c.advanced = false; c.view = 'fleet'; }
  bzRender();
  bzCalcChanged();
  const first = document.querySelector(action === 'open' ? 'main [data-bz-input="implementationEur"]' : 'main [data-bz-costs]');
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
  if (pick('data-bz-reset')) { Object.assign(bz.calc, { advanced: false, view: 'fleet', values: null }); bzCalcReset(); bzRender(); return; }
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
