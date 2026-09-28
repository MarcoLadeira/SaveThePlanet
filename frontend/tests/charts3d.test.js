const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function prediction(horizonMinutes, overrides = {}) {
  return {
    // Both horizons forecast the same target half-hour, each issued horizonMinutes before it.
    horizonMinutes, targetAt: '2026-09-27T17:55:00Z', issuedAt: horizonMinutes === 30 ? '2026-09-27T17:25:00Z' : '2026-09-27T16:55:00Z',
    probability: .64, risk: 'medium',
    atRiskMwh: .62, constraintMwh: .47, curtailmentMwh: .15, lowerMwh: .34, medianMwh: .57, upperMwh: .84, ...overrides,
  };
}

function load(predictions, horizon = 30) {
  const context = vm.createContext({
    modelState: { horizon, data: { intervalMinutes: 30, predictions, scenario: { flexibleDemandMwh: .5 } } },
    scenarioOutcome: () => ({ potentialRecoveryMwh: .35 }),
    n: (value) => String(Math.round(value * 100) / 100),
    escapeHtml: String,
    modelTime: (value) => new Date(value).toISOString().slice(11, 16),
    modelCause: () => 'Constraint-dominated',
  });
  context.selectedPrediction = () => context.modelState.data.predictions.find((p) => p.horizonMinutes === context.modelState.horizon);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../charts3d.js'), 'utf8'), context);
  context.dashCharts = vm.runInContext('dashCharts', context);
  return context;
}

test('interpolates nested numbers and keeps labels', () => {
  const { chartLerp } = load([prediction(30), prediction(60)]);
  const mid = chartLerp({ a: 0, rows: [{ v: 2, label: 'old' }] }, { a: 10, rows: [{ v: 4, label: 'new' }] }, .5);
  assert.equal(mid.a, 5);
  assert.equal(mid.rows[0].v, 3);
  assert.equal(mid.rows[0].label, 'new');
});

test('rounds chart scales up to readable maxima', () => {
  const { chartNiceMax } = load([prediction(30), prediction(60)]);
  assert.equal(chartNiceMax(.84), 1);
  assert.equal(chartNiceMax(3.2), 5);
  assert.equal(chartNiceMax(0), 1);
  assert.ok(Math.abs(chartNiceMax(.0034) - .005) < 1e-12);
});

test('likelihood gauge shows the selected probability and risk', () => {
  const { dashCharts } = load([prediction(30), prediction(60, { probability: .55 })]);
  const values = dashCharts.likelihood.values();
  assert.equal(values.probability, .64);
  const svg = dashCharts.likelihood.draw(values);
  assert.match(svg, />64%</);
  assert.match(svg, /medium risk/);
  assert.doesNotMatch(dashCharts.likelihood.draw({ probability: 0, risk: 'low' }), /NaN|gauge-fill\)" d/);
});

test('risk drivers split constraint and curtailment and survive zero risk', () => {
  const { dashCharts } = load([prediction(30), prediction(60)]);
  const html = dashCharts.causes.draw(dashCharts.causes.values());
  assert.match(html, />76%</);
  assert.match(html, /0\.47 MWh<small>76%/);
  assert.match(html, /0\.15 MWh<small>24%/);
  const empty = dashCharts.causes.draw({ constraint: 0, curtailment: 0, sweep: 1, cause: 'No predicted dispatch-down' });
  assert.match(empty, />—</);
  assert.doesNotMatch(empty, /NaN|Infinity|donut-top/);
});

test('confidence rows order targets, scale to P90 and mark the selection', () => {
  const context = load([prediction(60, { upperMwh: 1.1, lowerMwh: .4, probability: .55 }), prediction(30)], 60);
  const values = context.dashCharts.confidence.values();
  assert.deepEqual([...values.rows.map((row) => row.horizon)], ['30', '60']);
  assert.equal(values.max, 2);
  const html = context.dashCharts.confidence.draw(values);
  assert.match(html, /data-horizon="60" aria-pressed="true"/);
  assert.match(html, /17:55–18:25/); // target labels the start of its half-hour
  assert.match(html, /\+30 min · issued 17:25/);
  assert.match(html, /\+60 min · issued 16:55/);
  assert.match(html, /left:20\.00%;width:calc\(55\.00% - 20\.00%\)/);
  assert.match(html, /<em>0\.62 MWh<\/em>/);
  assert.match(html, /<b>55%<\/b>/);
  assert.doesNotMatch(context.dashCharts.confidence.draw(context.dashCharts.confidence.start(values)), /NaN|Infinity/);
});

test('next move bars rise from the baseline and scale to the largest value', () => {
  const { dashCharts } = load([prediction(30, { atRiskMwh: .7 }), prediction(60)]);
  const values = dashCharts.planBars.values();
  assert.match(dashCharts.planBars.draw(dashCharts.planBars.start(values)), /--plan-h:0"/);
  const html = dashCharts.planBars.draw(values);
  assert.match(html, /is-risk" style="--plan-h:1"/);
  assert.match(html, /is-flex" style="--plan-h:0\.714/);
  assert.match(html, /<strong>0\.35<\/strong>MWh/);
});