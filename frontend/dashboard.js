// Dashboard: energy at risk + forecast confidence (left) | battery (middle) | flexible charging + next move (right).
// The battery, flexible charging and next-move cards and their charts are in bridge.js.
//
// The two left cards show the daily model (V2) for the day of the dashboard's half-hour: the server
// picks a day EirGrid recorded curtailment on (targets.py), and /api/v1/dashboard/day gives V2's
// chance and predicted curtailment for that whole day, its wind/solar split and EirGrid's record.
// The battery and EV cards keep planning one V1 half-hour of that same day, and say so. Until the
// daily view arrives, or if it cannot (demo data, model down), the V1 half-hour cards are shown.
const dashDay = { key: '', status: 'idle', data: null, error: '' };

function dashDayKey() {
  const d = modelState.data;
  return d && d.dataMode !== 'simulated' ? selectedPrediction().targetAt.slice(0, 10) : '';
}

async function loadDashDay() {
  const key = dashDayKey();
  if (!key || dashDay.key === key) return;
  Object.assign(dashDay, { key, status: 'loading', data: null, error: '' });
  try {
    const response = await fetch(`/api/v1/dashboard/day?date=${key}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'The daily model could not be reached.');
    if (dashDay.key === key) Object.assign(dashDay, { status: 'ready', data: body });
  } catch (error) {
    if (dashDay.key === key) Object.assign(dashDay, { status: 'error', error: error.message });
  }
  if (pageFromHash() === 'overview') render();
}

const dashDayReady = () => dashDay.status === 'ready' && dashDay.key === dashDayKey();
const dashDayLevel = (p) => (p >= 0.7 ? 'high' : p >= 0.4 ? 'medium' : 'low');
function dashDayLabel(day) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${day}T00:00:00Z`));
}
const dashPct = (value) => (Number.isFinite(value) ? `${Math.round(value)}%` : '—');

// The half-hour gauge, fed by the daily model's chance of any curtailment that day.
dashCharts.dayLikelihood = {
  ...dashCharts.likelihood,
  values() {
    const p = dashDay.data?.probability ?? 0;
    return { probability: p, risk: dashDayLevel(p) };
  },
};

// "Waste through the day": model 1's +30 min forecast for each half-hour of the Dashboard day, from the
// same day plan the Battery and EV pages use (bridge.js, GET /api/v1/impact/day; cached server-side).
// Marks the half-hour the battery and EV cards plan, the best charging window and the charger limit.
const WASTE_WINDOW_SLOTS = 8; // up to 4 hours, as on the Wind & Solar page

// The run of up to `slots` half-hours where chargers of `capMwh` per half-hour could take the most:
// sum(min(at risk, cap)). Ties: most energy at risk, then the shortest run, then the earliest.
const wasteBetter = (a, b) => { const i = a.findIndex((k, j) => k !== b[j]); return i >= 0 && a[i] > b[i]; };
function wasteWindow(values, capMwh, slots = WASTE_WINDOW_SLOTS) {
  let best = null;
  for (let start = 0; start < values.length; start++) {
    let taken = 0, total = 0;
    for (let len = 1; len <= slots && start + len <= values.length; len++) {
      const v = values[start + len - 1] || 0;
      taken += Math.min(v, capMwh); total += v;
      const key = [Math.round(taken * 1e6), Math.round(total * 1e6), -len, -start];
      if (taken > 0 && (!best || wasteBetter(key, best.key))) best = { key, start, len, taken, total };
    }
  }
  return best && { start: best.start, len: best.len, takenMwh: best.taken, atRiskMwh: best.total };
}

// A replay day's 48 slots are the +30 min targets from 00:30 to 00:00 the next day. A day with a gap in the
// dataset has fewer intervals, so each one is placed in its own slot (missing slots stay empty).
// Each bar is split into its two causes: curtailment (the same quantity the daily model in the card
// above predicts) and grid constraints (only model 1 predicts these). Comparing the day's curtailment
// like for like is what keeps the two cards consistent: the top card never meets the chart's total.
const WASTE_SLOTS = 48;
function wasteSeries() {
  const plan = dayPlan.data, p = selectedPrediction();
  const first = Date.parse(`${plan.date}T00:30:00Z`), slotOf = (t) => Math.round((Date.parse(t) - first) / 18e5);
  const values = Array(WASTE_SLOTS).fill(null), curt = Array(WASTE_SLOTS).fill(0), rows = Array(WASTE_SLOTS).fill(null);
  for (const i of plan.intervals) {
    const k = slotOf(i.targetAt);
    if (k < 0 || k >= WASTE_SLOTS) continue;
    values[k] = i.atRiskMwh || 0;
    curt[k] = Math.min(values[k], Math.max(0, i.curtailmentMwh ?? 0));
    rows[k] = i;
  }
  const cap = modelState.capacity * 0.5, sel = slotOf(p.targetAt);
  const at = (k) => new Date(first + k * 18e5).toISOString();
  const known = values.filter((v) => v !== null);
  return { plan, values, curt, rows, cap, at, known,
    curtailmentMwh: curt.reduce((a, v) => a + v, 0), totalMwh: known.reduce((a, v) => a + v, 0),
    sel: sel >= 0 && sel < WASTE_SLOTS && rows[sel] ? sel : -1, window: wasteWindow(values, cap) };
}

dashCharts.dayWaste = {
  values() {
    if (!dayPlanReady()) return { v: [], c: [], max: 1, sel: -1, win: '', cap: 0, rise: 0, meta: '' };
    const s = wasteSeries();
    return { v: s.values.map((x) => x ?? 0), c: s.curt, max: chartNiceMax(Math.max(...s.values.map((x) => x ?? 0), 1)), sel: s.sel, cap: s.cap, rise: 1,
      win: s.window ? `${s.window.start}|${s.window.len}` : '',
      meta: s.rows.map((r, k) => `${modelTime(s.at(k))}~${r ? Math.round(r.probability * 100) : ''}~${r ? 'ok' : 'none'}~${modelTime(s.at(k + 1))}`).join('|') };
  },
  start: (t) => ({ ...t, v: t.v.map(() => 0), c: t.c.map(() => 0), rise: 0 }),
  draw({ v, c, max, sel, win, cap, rise, meta }) {
    if (!v.length) return '';
    const rows = meta.split('|').map((m) => m.split('~'));
    const h = (x) => `${(Math.min(1, Math.max(0, x / max)) * 100 * rise).toFixed(2)}%`;
    const mwh = (x) => n(Math.round(x * 10) / 10);
    const cols = v.map((x, i) => {
      const [time, chance, state, next] = rows[i] || ['', '', 'none', ''];
      if (state === 'none') return `<span class="dw-col is-missing"><span class="dw-tip"><b>${time}–${next}</b><small>No forecast in the dataset for this half-hour</small></span></span>`;
      const curtail = Math.min(c[i] || 0, x), constraint = Math.max(0, x - curtail);
      return `<span class="dw-col${i === sel ? ' is-plan' : ''}"><i class="dw-bar is-constraint" style="height:${h(constraint)}"></i><i class="dw-bar is-curtail" style="height:${h(curtail)}"></i>${i === sel ? '<em class="dw-plan">Plan</em>' : ''}
        <span class="dw-tip"><b>${time}–${next}</b><span><i class="is-curtail"></i>Curtailment <strong>${mwh(curtail)} MWh</strong></span><span><i class="is-constraint"></i>Grid constraint <strong>${mwh(constraint)} MWh</strong></span><span>Chance of any <strong>${chance}%</strong></span>${i === sel ? '<small>Planned: the battery and EV cards on the right use this half-hour (curtailment + constraint)</small>' : ''}</span></span>`;
    }).join('');
    const [ws, wl] = win ? win.split('|').map(Number) : [0, 0];
    const band = win ? `<span class="dw-window" style="left:${(ws / v.length) * 100}%;width:${(wl / v.length) * 100}%" title="Best charging window: ${rows[ws]?.[0]}–${rows[ws + wl - 1]?.[3]}"></span>` : '';
    const limit = cap <= max ? `<span class="dw-cap" style="bottom:${(cap / max) * 100}%"><b>charger limit ${n(Math.round(cap))} MWh</b></span>` : '';
    const ticks = rows.map((r, i) => (i % 8 === 0 ? `<span style="left:${(i / v.length) * 100}%">${r[0]}</span>` : '')).join('');
    return `<div class="dw-chart"><div class="dw-head"><span>${n(max)} MWh</span><span class="dw-key"><i class="is-curtail"></i>Curtailment<i class="is-constraint"></i>Grid constraint${win ? '<i class="is-window"></i>Best window' : ''}</span></div><div class="dw-cols">${band}${cols}${limit}</div><div class="dw-axis">${ticks}</div></div>`;
  },
};

function dashboardHero(p) {
  if (dashDayReady()) return dashboardDayHero(dashDay.data);
  if (dashDay.status === 'loading' && dashDay.key === dashDayKey()) {
    return `<section class="dash-card dash-hero is-daily">${cardHead('orange', 'Curtailment forecast for the day', 'Model 2 (daily): renewable power expected to be switched off across the whole day')}
      <div class="day-loading" role="status"><span class="fx-busy is-on"><i></i>Loading the daily forecast…</span></div></section>`;
  }
  return `<section class="dash-card dash-hero">${cardHead('orange','Renewable energy at risk','Forecast of renewable energy that may be switched off and wasted')}
    <div class="hero-body"><div class="hero-figure"><strong>${n(p.atRiskMwh)}<small>MWh</small></strong><span class="hero-kwh">= ${n(Math.round(p.atRiskMwh*1000))} kWh</span><p>At risk of being wasted<br>+${p.horizonMinutes} min · ${escapeHtml(targetWindow(p))}</p></div>${chartSlot('likelihood',`${Math.round(p.probability*100)}% likelihood of dispatch-down, ${p.risk} risk`,'hero-gauge')}</div>
    <div class="dash-hero-stats"><div><span>Forecast for</span><strong>${escapeHtml(modelTime(p.targetAt,true))}</strong></div><div><span>How far ahead</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Likely range</span><strong>${n(p.lowerMwh)}–${n(p.upperMwh)} MWh</strong></div></div>
  </section>`;
}

function dashboardDayHero(d) {
  const split = d.split.status === 'ok' ? d.split : null, rec = d.recorded.curtailmentMwh;
  const chance = Math.round(d.probability * 100), level = dashDayLevel(d.probability);
  return `<section class="dash-card dash-hero is-daily">${cardHead('orange', 'Curtailment forecast for the day', 'Model 2 (daily): renewable power expected to be switched off across the whole day')}
    <div class="hero-body"><div class="hero-figure"><strong>${n(Math.round(d.predictedMwh))}<small>MWh</small></strong><span class="hero-kwh">= ${n(Math.round(d.predictedMwh * 1000))} kWh</span><p>Predicted curtailment<br>whole UTC day · made 00:00 UTC</p></div>${chartSlot('dayLikelihood', `${chance}% chance of curtailment that day, ${level} risk`, 'hero-gauge')}</div>
    <div class="dash-hero-stats"><div><span>Forecast for</span><strong>${escapeHtml(dashDayLabel(d.date))}</strong></div><div><span>Expected mix</span><strong>${split ? `${dashPct(split.windSharePercent)} wind · ${dashPct(split.solarSharePercent)} solar` : '—'}</strong></div><div><span>EirGrid recorded</span><strong>${Number.isFinite(rec) ? `${n(Math.round(rec))} MWh` : 'pending'}</strong></div></div>
  </section>`;
}

function dashboardConfidence(p) {
  if (modelState.data?.dataMode !== 'simulated') {
    ensureDayPlan();
    if (dayPlanReady()) return dashboardWaste(p);
    if (dayPlanLoading()) {
      return `<section class="dash-card dash-confidence is-daily is-waste">${cardHead('orange', 'Waste through the day', 'Renewable power model 1 expects to be switched off in each half-hour of the day')}
        <div class="day-loading is-light" role="status"><span class="fx-busy is-on"><i></i>Replaying the day’s 48 half-hours…</span><small>About 15 seconds the first time</small></div></section>`;
    }
  }
  const legend='<div class="confidence-legend"><span><i class="is-range"></i>Likely range</span><span><i class="is-expected"></i>Expected</span></div>';
  return `<section class="dash-card dash-confidence">${cardHead('orange','Forecast confidence','Energy at risk (MWh) for the selected half-hour, forecast 30 and 60 minutes before it: the expected value and the range it will likely fall in',legend)}${chartSlot('confidence','Forecast targets','confidence-chart','group')}</section>`;
}

function dashboardWaste(p) {
  const s = wasteSeries(), day = dashDayReady() ? dashDayLabel(dashDay.data.date) : modelTime(p.targetAt, true).slice(0, 11);
  const missing = WASTE_SLOTS - s.known.length;
  const rec = dashDayReady() ? dashDay.data.recorded.curtailmentMwh : null, ahead = dashDayReady() ? dashDay.data.predictedMwh : null;
  const cell = (label, value, cls, title) => `<div class="dw-stat ${cls}" title="${title}"><span>${label}</span><b>${Number.isFinite(value) ? `${n(Math.round(value))}<small>MWh</small>` : dashDay.status === 'loading' ? '…' : '—'}</b></div>`;
  return `<section class="dash-card dash-confidence is-daily is-waste">${cardHead('orange', 'Waste through the day', `Model 1, 30 min ahead, per half-hour${missing ? ` · ${missing} missing from the dataset` : ''}`)}
    ${chartSlot('dayWaste', `Curtailment and grid constraints forecast for each half-hour of ${day}; the planned half-hour is outlined`, 'dw-slot')}
    <div class="dw-compare" title="The same quantity, curtailment, forecast three ways. Half-hour forecasts are made 30 minutes ahead with live grid readings, so they are usually much closer to what happens than the forecast made at midnight from the weather.">
      <p>Curtailment over the day, forecast three ways</p>
      ${cell('Day-ahead', ahead, 'is-ahead', 'Model 2: one forecast for the whole day, made at midnight from the weather forecast')}${cell('Half-hourly', s.curtailmentMwh, 'is-now', 'Model 1: the curtailment part of the 48 half-hour forecasts above, each made 30 minutes ahead, added up')}${cell('Recorded', rec, 'is-rec', 'What EirGrid recorded')}
    </div>
  </section>`;
}

function renderDashboard() {
  queueMicrotask(loadDashDay);
  return studioShell('Dashboard', 'How much renewable energy may be wasted, how the battery routes it, and which EVs charge with it.', () => {
    const p = selectedPrediction();
    return `<div class="dash-grid restored-dashboard dashboard-redesign bridge-layout">
      <svg class="dashboard-flow-links" aria-hidden="true" preserveAspectRatio="none"></svg>
      ${dashboardHero(p)}
      ${dashboardConfidence(p)}
      ${dashboardBattery()}
      ${dashboardFlexible()}
      ${dashboardNextMove()}
    </div>${provenance()}`;
  });
}
