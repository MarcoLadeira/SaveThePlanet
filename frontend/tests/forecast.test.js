const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads the chart engine and the Forecast page into one sandbox; returns an evaluator.
function load() {
  const context = vm.createContext({
    document: { addEventListener() {} },
    modelState: { capacity: 100 },
    settings: { uncertainty: true },
    n: (value) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value),
    escapeHtml: String,
    icon: (name) => `<svg data-icon="${name}"></svg>`,
  });
  for (const file of ['charts3d.js', 'forecast-explorer.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return (code) => vm.runInContext(code, context);
}

const day = (date, predictedMwh, curtailmentMwh, probability) => ({ date, predictedMwh, probability, actual: { status: curtailmentMwh === null ? 'pending' : 'available', curtailmentMwh, event: curtailmentMwh === null ? null : curtailmentMwh > 25 } });

test('axis scale uses round ticks with little headroom', () => {
  const run = load();
  assert.deepEqual({ ...run('fxScale(6217, 10)') }, { max: 7500, step: 2500 });
  assert.deepEqual({ ...run('fxScale(380, 1)') }, { max: 400, step: 100 });
  const calm = run('fxScale(0, 10)');
  assert.ok(calm.max >= 10 && calm.max <= 15 && calm.max % calm.step === 0);
});

test('lines are split at missing half-hours', () => {
  const run = load();
  assert.deepEqual(JSON.parse(run('JSON.stringify(fxRuns([1, null, 2, 3, undefined, 4]))')), [[0], [2, 3], [5]]);
  assert.equal(run('fxRuns([null, null]).length'), 0);
});

test('week chart marks the selected day and a missing observation', () => {
  const run = load();
  run(`fx.daily.date = '2026-01-27'; fx.daily.week = { days: ${JSON.stringify([
    day('2026-01-25', 4726, 5862, 0.89), day('2026-01-26', 2, 118, 0.01), day('2026-01-27', 4773, 5921, 1),
    day('2026-01-28', 2185, null, 0.85), day('2026-01-29', 3044, 4377, 0.94), day('2026-01-30', 0.3, 0, 0), day('2026-01-31', 23, 1097, 0.03),
  ])} };`);
  const values = run('dashCharts.fxWeek.values()');
  assert.equal(values.axis, '7500|2500');
  const html = run('dashCharts.fxWeek.draw(dashCharts.fxWeek.values())');
  assert.equal(html.match(/fx-week-col is-selected/g).length, 1);
  assert.match(html, /fx-bar is-missing/);
  assert.match(html, />100%</);
  assert.match(html, />7,500</);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  const start = run('dashCharts.fxWeek.draw(dashCharts.fxWeek.start(dashCharts.fxWeek.values()))');
  assert.doesNotMatch(start.replace(/--h:0\.0000/g, ''), /--h:/, 'bars start from the baseline');
});

test('week record counts right and wrong calls', () => {
  const run = load();
  run(`fx.daily.date = '2026-01-31'; fx.daily.week = { days: ${JSON.stringify([
    day('2026-01-29', 3044, 4377, 0.94), day('2026-01-30', 0.3, 0, 0), day('2026-01-31', 23, 1097, 0.03), day('2026-02-01', 10, null, 0.2),
  ])} };`);
  const html = run('fxWeekRecord()');
  assert.match(html, /2 of 3 right/);
  assert.equal(html.match(/class="is-wrong is-selected"/g).length, 1);
  assert.match(html, /is-pending/);
});

test('day replay follows the horizon, skips gaps and marks the selected half-hour', () => {
  const run = load();
  const points = [];
  for (let i = 0; i < 48; i++) {
    if (i === 20) continue; // a half-hour missing from the dataset
    const t = `2026-01-27T${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00Z`;
    for (const h of [30, 60]) points.push({ horizonMinutes: h, targetAt: t, issuedAt: t, atRiskMwh: 100 + i + h, lowerMwh: 80 + i, upperMwh: 140 + i + h, probability: 0.9 });
  }
  const observed = points.filter((p) => p.horizonMinutes === 30).map((p) => ({ targetAt: p.targetAt, actualMwh: 95 + p.atRiskMwh / 10 }));
  run(`fx.short.horizon = 30; fx.short.target = '2026-01-27T03:00:00Z'; fx.short.day = ${JSON.stringify({ date: '2026-01-27', points, observed })};`);
  const values = run('dashCharts.fxDay.values()');
  assert.equal(values.sel, '6');
  assert.equal(values.pred[20], null);
  assert.equal(values.pred[0], 130);
  const html = run('dashCharts.fxDay.draw(dashCharts.fxDay.values())');
  assert.match(html, /class="fx-sel" style="left:12\.766%"><em>03:00<\/em>/);
  const predLine = html.match(/fx-day-line is-pred" d="([^"]+)"/)[1];
  assert.equal(predLine.match(/M/g).length, 2, 'the missing half-hour splits the line');
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  run('fx.short.horizon = 60');
  assert.equal(run('dashCharts.fxDay.values().pred[0]'), 160);
});

test('side-card charts survive zero and missing values', () => {
  const run = load();
  run(`fx.daily.result = { date: '2026-01-30', probability: 0, predictedMwh: 0, actual: { status: 'available', curtailmentMwh: 0, event: false } };
    fx.short.horizon = 30;
    fx.short.result = { targetAt: '2026-01-31T12:00:00Z', capacityMw: 100, actual: { status: 'missing', dispatchDownMwh: null },
      predictions: [{ horizonMinutes: 30, atRiskMwh: 0, lowerMwh: 0, upperMwh: 0, constraintMwh: 0, curtailmentMwh: 0, probability: 0.02, risk: 'low', issuedAt: '2026-01-31T11:30:00Z', recoverableMwh: 0 }] };`);
  for (const name of ['fxDCompare', 'fxSRange', 'fxSSplit', 'fxDProbRing', 'fxS30Range', 'fxS60Range', 'fxDErr', 'fxSErr']) {
    const html = run(`dashCharts.${name}.draw(dashCharts.${name}.values())`);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/, name);
  }
  assert.match(run('dashCharts.fxSErr.draw(dashCharts.fxSErr.values())'), /<strong>—<\/strong>/);
  assert.match(run('dashCharts.fxSSplit.draw(dashCharts.fxSSplit.values())'), /fx-split-bar is-empty/);
});

test('timeline pins the selected day inside its split', () => {
  const run = load();
  run(`fx.daily.date = '2025-10-01'; fx.daily.info = { model: { test: {} }, dataset: { partitions: {
    train: { from: '2023-01-01', to: '2024-12-31', rows: 731 }, validation: { from: '2025-01-01', to: '2025-06-30', rows: 181 }, test: { from: '2025-07-01', to: '2026-01-31', rows: 215 } } } };`);
  const values = run('dashCharts.fxTimeDaily.values()');
  const testStart = (731 + 181) / 1127;
  assert.ok(values.pin > testStart && values.pin < 1, `pin ${values.pin} should fall in the test split`);
  assert.match(run('dashCharts.fxTimeDaily.draw(dashCharts.fxTimeDaily.values())'), /<em>1 Oct<\/em>/);
});
