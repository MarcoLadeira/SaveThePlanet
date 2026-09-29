const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The /api/v1/dashboard/day answer for 11 Jan 2026 (real figures).
const DAY = {
  date: '2026-01-11', model: { id: 'v2', version: '2.0.0-daily-experimental', experimental: true, test: { rows: 242, dailyMaeMwh: 1723.39, zeroBaselineMaeMwh: 2310.37, rocAuc: 0.823 } },
  issuedAt: '2026-01-11T00:00:00+00:00', weatherAvailableAt: '2026-01-10T23:00:00+00:00', probability: 0.9478, predictedMwh: 8962.79,
  split: { status: 'ok', windMwh: 8846.09, solarMwh: 116.69, windSharePercent: 98.7, solarSharePercent: 1.3, version: '2.0.0-sources-experimental' },
  recorded: { status: 'available', curtailmentMwh: 7010.69, split: { status: 'available', windMwh: 6983.6, solarMwh: 27.09, windSharePercent: 99.61, solarSharePercent: 0.39 } },
};
const HALF_HOUR = { targetAt: '2026-01-11T14:00:00+00:00', horizonMinutes: 30, atRiskMwh: 44.2, probability: 1, risk: 'high', lowerMwh: 30, upperMwh: 60 };

// A day plan (GET /api/v1/impact/day): +30 min targets from 00:30 to 00:00 the next day.
function dayPlan({ skip = [] } = {}) {
  const first = Date.parse('2026-01-11T00:30:00Z'), intervals = [];
  for (let k = 0; k < 48; k++) {
    if (skip.includes(k)) continue;
    const mwh = k >= 20 && k < 30 ? 80 : k === 27 ? 90 : 5; // a daytime peak
    intervals.push({ targetAt: new Date(first + k * 18e5).toISOString().replace('.000Z', '+00:00'), atRiskMwh: k === 27 ? 90 : mwh, probability: 0.9, risk: mwh > 50 ? 'high' : 'low' });
  }
  return { date: '2026-01-11', intervals };
}

function load({ dataMode = 'historical-prediction', plan = dayPlan(), planStatus = 'ready' } = {}) {
  const context = vm.createContext({
    document: { addEventListener() {} },
    modelState: { data: { dataMode, intervalMinutes: 30, predictions: [HALF_HOUR] }, horizon: 30, capacity: 100 },
    settings: { timezone: 'UTC' },
    n: (value) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value),
    escapeHtml: (value) => String(value),
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    cardHead: (tone, title, subtitle, extra = '') => `<div class="head"><h2>${title}</h2><p>${subtitle}</p>${extra}</div>`,
    modelTime: (value, date) => (date ? '11 Jan 2026, 14:00' : new Date(value).toISOString().slice(11, 16)),
    selectedPrediction: () => HALF_HOUR,
    pageFromHash: () => 'overview',
    render() {},
    fetch: async () => { throw new Error('no network in tests'); },
    // bridge.js's day plan, stubbed.
    dayPlan: { status: planStatus, data: planStatus === 'ready' ? plan : null },
    dayPlanReady: () => planStatus === 'ready',
    dayPlanLoading: () => planStatus === 'loading',
    ensureDayPlan() {},
  });
  for (const file of ['charts3d.js', 'dashboard.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  context.DAY = DAY;
  return run;
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the top card shows the daily model for the dashboard day', () => {
  const run = load();
  run(`Object.assign(dashDay, { key: '2026-01-11', status: 'ready', data: DAY })`);
  const html = text(run('dashboardHero(selectedPrediction())'));
  assert.match(html, /Curtailment forecast for the day/);
  assert.match(html, /8,963 MWh/);
  assert.match(html, /99% wind · 1% solar/);
  assert.match(html, /EirGrid recorded 7,011 MWh/);
  assert.match(html, /Sun 11 Jan 2026/);
  assert.equal(run('dashCharts.dayLikelihood.values().risk'), 'high');
});

test('waste through the day: 48 half-hours, the planned one, the best window and the charger limit', () => {
  const run = load();
  run(`Object.assign(dashDay, { key: '2026-01-11', status: 'ready', data: DAY })`);
  const html = text(run('dashboardConfidence(selectedPrediction())'));
  assert.match(html, /Waste through the day/);
  assert.match(html, /Peak 14:00–14:30 ?: 90 MWh/);
  assert.match(html, /Best window 10:30–14:30 ?: up to 400 MWh for chargers/);
  assert.match(html, /Battery &amp; EV plan: 14:00–14:30 \(outlined\) · 44\.2 MWh at risk/);
  const values = run('dashCharts.dayWaste.values()');
  assert.equal(values.v.length, 48);
  assert.equal(values.sel, 27, '14:00 is the 28th +30 min slot after 00:30');
  assert.equal(values.win, '20|8');
  assert.equal(values.cap, 50);
  const chart = run('dashCharts.dayWaste.draw(dashCharts.dayWaste.values())');
  assert.equal(chart.match(/class="dw-col[ "]/g).length, 48);
  assert.equal(chart.match(/dw-col is-plan/g).length, 1);
  assert.match(chart, /charger limit 50 MWh/);
  assert.doesNotMatch(chart, /NaN|undefined/);
});

test('the best window prefers the most energy, then the shortest, then the earliest run', () => {
  const run = load();
  assert.deepEqual({ ...run('wasteWindow([0, 60, 60, 0, 0, 90, 90, 0], 50, 4)') }, { start: 5, len: 2, takenMwh: 100, atRiskMwh: 180 });
  assert.deepEqual({ ...run('wasteWindow([0, 60, 60, 0, 0, 60, 60, 0], 50, 4)') }, { start: 1, len: 2, takenMwh: 100, atRiskMwh: 120 });
  assert.equal(run('wasteWindow([0, 0, 0], 50)'), null);
});

test('a day with a gap in the dataset keeps every bar in its own time slot', () => {
  const run = load({ plan: dayPlan({ skip: [30, 31] }) });
  const values = run('dashCharts.dayWaste.values()');
  assert.equal(values.v.length, 48);
  assert.equal(values.sel, 27);
  const chart = run('dashCharts.dayWaste.draw(dashCharts.dayWaste.values())');
  assert.equal(chart.match(/dw-col is-missing/g).length, 2);
  assert.match(chart, /15:30–16:00/);
  assert.match(text(run('dashboardConfidence(selectedPrediction())')), /\(2 missing\)/);
});

test('while the day plan loads it says so; on error, or for demo data, the half-hour card is shown', () => {
  assert.match(text(load({ planStatus: 'loading' })('dashboardConfidence(selectedPrediction())')), /Replaying the day’s 48 half-hours/);
  assert.match(text(load({ planStatus: 'error' })('dashboardConfidence(selectedPrediction())')), /Forecast confidence/);
  assert.match(text(load({ dataMode: 'simulated' })('dashboardConfidence(selectedPrediction())')), /Forecast confidence/);
  assert.equal(load({ dataMode: 'simulated' })('dashDayKey()'), '', 'demo data never asks for a daily view');
});
