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

// Predicted vs recorded curtailment on one scale, then the wind / solar mix of each.
dashCharts.dayCompare = {
  values() {
    const d = dashDay.data, rec = d?.recorded.curtailmentMwh;
    const split = d?.split.status === 'ok' ? d.split : null, recSplit = d?.recorded.split;
    return {
      pred: d?.predictedMwh ?? 0, rec: rec ?? 0, hasRec: Number.isFinite(rec) ? '1' : '',
      max: chartNiceMax(Math.max(d?.predictedMwh ?? 0, rec ?? 0, 1)),
      predWind: split ? split.windSharePercent : 0, hasPredMix: split ? '1' : '',
      recWind: recSplit?.windSharePercent ?? 0, hasRecMix: recSplit && Number.isFinite(recSplit.windSharePercent) ? '1' : '',
      rise: 1,
    };
  },
  start: (t) => ({ ...t, pred: 0, rec: 0, predWind: 0, recWind: 0, rise: 0 }),
  draw({ pred, rec, hasRec, max, predWind, hasPredMix, recWind, hasRecMix, rise }) {
    const w = (v) => `${Math.max(0, Math.min(100, (v / max) * 100)).toFixed(2)}%`;
    const amount = (cls, label, value, note) => `<div class="day-row"><span class="day-label">${label}</span><span class="day-track"><i class="day-bar ${cls}" style="width:${w(value)}"></i></span><b>${note || `${n(Math.round(value))} MWh`}</b></div>`;
    const mix = (label, wind) => `<div class="day-row is-mix"><span class="day-label">${label}</span><span class="day-track is-mix"><i class="is-wind" style="width:${(wind * rise).toFixed(2)}%"><em>${Math.round(wind)}% wind</em></i><i class="is-solar" style="width:${((100 - wind) * rise).toFixed(2)}%"><em>${Math.round(100 - wind)}% solar</em></i></span></div>`;
    const recMix = hasRecMix ? mix('Recorded', recWind) : `<div class="day-row is-mix"><span class="day-label">Recorded</span><span class="day-none">${hasRec && rec === 0 ? 'nothing was curtailed' : 'no wind / solar record'}</span></div>`;
    return `<div class="day-cmp"><p class="day-title">Curtailment over the day</p>${amount('is-pred', 'Predicted', pred)}${amount('is-rec', 'Recorded', rec, hasRec ? '' : 'pending')}
      <p class="day-title">Where it comes from</p>${hasPredMix ? mix('Predicted', predWind) : '<div class="day-row is-mix"><span class="day-label">Predicted</span><span class="day-none">split unavailable</span></div>'}${recMix}</div>`;
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
  if (dashDayReady()) return dashboardDayCompare(dashDay.data, p);
  const legend='<div class="confidence-legend"><span><i class="is-range"></i>Likely range</span><span><i class="is-expected"></i>Expected</span></div>';
  return `<section class="dash-card dash-confidence">${cardHead('orange','Forecast confidence','Energy at risk (MWh) for the selected half-hour, forecast 30 and 60 minutes before it: the expected value and the range it will likely fall in',legend)}${chartSlot('confidence','Forecast targets','confidence-chart','group')}</section>`;
}

function dashboardDayCompare(d, p) {
  const t = d.model.test, miss = t.dailyMaeMwh ? ` · typically off by ${n(Math.round(t.dailyMaeMwh))} MWh a day` : '';
  return `<section class="dash-card dash-confidence is-daily">${cardHead('orange', 'Forecast vs what happened', `Model 2 for ${escapeHtml(dashDayLabel(d.date))} against EirGrid’s record${miss}`)}
    ${chartSlot('dayCompare', `Predicted ${n(Math.round(d.predictedMwh))} MWh, recorded ${Number.isFinite(d.recorded.curtailmentMwh) ? `${n(Math.round(d.recorded.curtailmentMwh))} MWh` : 'pending'}`, 'day-compare')}
    <p class="day-plan-link" title="The battery and EV cards plan one half-hour with the short-term model (model 1), which includes grid constraints as well as curtailment.">${icon('charge', 15)}<span>Battery and EV plan: <b>${escapeHtml(targetWindow(p))}</b> this day · model 1, +${p.horizonMinutes} min · <b>${n(p.atRiskMwh)} MWh</b> at risk</span></p>
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
