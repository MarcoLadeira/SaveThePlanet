const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { outlookRows, outlookScale, outlookFormat } = require('../outlook-math.js');

function forecast() {
  return {
    predictions: [
      { horizonMinutes: 60, targetAt: '2026-01-31T13:00:00Z', issuedAt: '2026-01-31T12:00:00Z', atRiskMwh: 0.48 },
      { horizonMinutes: 30, targetAt: '2026-01-31T12:30:00Z', issuedAt: '2026-01-31T12:00:00Z', atRiskMwh: 0.23 },
    ],
    scenario: {
      outcomes: [
        { horizonMinutes: 30, targetAt: '2026-01-31T12:30:00Z', atRiskMwh: 0.23, potentialRecoveryMwh: 0.2, remainingWasteMwh: 0.03 },
        { horizonMinutes: 60, targetAt: '2026-01-31T13:00:00Z', atRiskMwh: 0.48, potentialRecoveryMwh: 0.4, remainingWasteMwh: 0.08 },
      ],
    },
  };
}

test('sorts forecasts and matches each independent scenario outcome by horizon', () => {
  const rows = outlookRows(forecast());
  assert.deepEqual(rows.map((row) => row.horizonMinutes), [30, 60]);
  assert.deepEqual(rows.map((row) => row.potentialRecoveryMwh), [0.2, 0.4]);
  assert.deepEqual(rows.map((row) => row.remainingWasteMwh), [0.03, 0.08]);
  assert.equal(rows[0].targetAt, '2026-01-31T12:30:00Z');
  assert.equal(rows[0].issuedAt, '2026-01-31T12:00:00Z');
  assert.equal(rows[0].atRiskMwh, 0.23);
  assert.equal(rows[1].atRiskMwh, 0.48);
  assert.equal(rows.length, 2);
  assert.equal(rows.some((row) => row.atRiskMwh === 0.71), false);
});

test('uses a shared sub-1 MWh scale with useful ticks', () => {
  const scale = outlookScale(outlookRows(forecast()));
  assert.equal(scale.max, 0.5);
  assert.deepEqual(scale.ticks, [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
});

test('provides finite zero, large and tiny scales', () => {
  const rows = outlookRows(forecast());
  const zero = rows.map((row) => ({ ...row, atRiskMwh: 0, potentialRecoveryMwh: 0, remainingWasteMwh: 0 }));
  assert.deepEqual(outlookScale(zero), { max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] });
  const large = rows.map((row) => ({ ...row, atRiskMwh: 123456, potentialRecoveryMwh: 100000, remainingWasteMwh: 23456 }));
  assert.deepEqual(outlookScale(large), { max: 125000, ticks: [0, 25000, 50000, 75000, 100000, 125000] });
  const tiny = rows.map((row) => ({ ...row, atRiskMwh: 0.0000034, potentialRecoveryMwh: 0.000002, remainingWasteMwh: 0.0000014 }));
  assert.deepEqual(outlookScale(tiny), { max: 0.000004, ticks: [0, 0.000001, 0.000002, 0.000003, 0.000004] });
});

test('rejects missing, duplicate, nonfinite, negative or mismatched data', () => {
  const cases = [
    (data) => data.predictions.pop(),
    (data) => { data.predictions[0].horizonMinutes = 30; },
    (data) => { data.predictions[0].atRiskMwh = NaN; },
    (data) => { data.scenario.outcomes[0].potentialRecoveryMwh = Infinity; },
    (data) => { data.scenario.outcomes[0].remainingWasteMwh = -1; },
    (data) => { data.scenario.outcomes[0].horizonMinutes = 90; },
    (data) => { data.scenario.outcomes[0].targetAt = '2026-01-31T13:00:00Z'; },
    (data) => { data.scenario.outcomes[0].atRiskMwh = 1; },
    (data) => { data.scenario.outcomes[0].remainingWasteMwh = 0.04; },
  ];
  for (const mutate of cases) {
    const data = forecast();
    mutate(data);
    assert.throws(() => outlookRows(data));
  }
  assert.throws(() => outlookScale([{ atRiskMwh: -1, potentialRecoveryMwh: 0, remainingWasteMwh: 0 }]));
});

test('accepts harmless floating point energy arithmetic', () => {
  const data = forecast();
  data.predictions[1].atRiskMwh = 0.3;
  data.scenario.outcomes[0].atRiskMwh = 0.3;
  data.scenario.outcomes[0].potentialRecoveryMwh = 0.1;
  data.scenario.outcomes[0].remainingWasteMwh = 0.2;
  assert.equal(outlookRows(data)[0].atRiskMwh, 0.3);
});

test('does not waive an energy-balance error just because the values are tiny', () => {
  const data = forecast();
  data.predictions[1].atRiskMwh = 0.0000000000001;
  data.scenario.outcomes[0].atRiskMwh = 0.0000000000001;
  data.scenario.outcomes[0].potentialRecoveryMwh = 0;
  data.scenario.outcomes[0].remainingWasteMwh = 0;
  assert.throws(() => outlookRows(data));
});

test('formats ordinary values to six decimals and preserves tiny nonzero values', () => {
  assert.equal(outlookFormat(0), '0');
  assert.equal(outlookFormat(0.23), '0.23');
  assert.equal(outlookFormat(1234.123456), '1,234.123456');
  assert.equal(outlookFormat(0.00000034), '3.4e-7');
  assert.throws(() => outlookFormat(Infinity));
});

// Exercise the real controller with a deterministic clock and a minimal chart shell.
// Paint is replaced so these tests check update scheduling independently of SVG layout.
function chartHarness() {
  let now = 0, nextFrame = 0, reducedMotion = false;
  const frames = new Map(), cancelled = [], paints = [], listeners = new Map();
  const data = forecast();
  const context = vm.createContext({
    modelState: { data, horizon: 30, loading: false },
    dashboardMode: 'energy',
    outlookRows, outlookScale, outlookFormat,
    modelTime: (value) => new Date(value).toISOString().slice(11, 16),
    escapeHtml: String,
    document: {
      hidden: false,
      querySelector: () => ({ focus() {} }),
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: reducedMotion }),
    performance: { now: () => now },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { cancelled.push(id); frames.delete(id); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../outlook.js'), 'utf8'), context);
  const runtime = vm.runInContext('outlookRuntime', context);
  context.outlookSyncStatic = () => {};
  context.outlookPaint = (_card, display) => {
    runtime.display = JSON.parse(JSON.stringify(display));
    paints.push(runtime.display);
  };
  const card = {
    isConnected: true,
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {} },
    querySelector(selector) {
      assert.equal(selector, '.outlook-plot');
      return { clientWidth: 720, clientHeight: 300 };
    },
  };
  return {
    context, card, runtime, data, frames, cancelled, paints, listeners,
    setNow(value) { now = value; },
    setReducedMotion(value) { reducedMotion = value; },
    tick(value) {
      now = value;
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      callback(now);
    },
  };
}

function setOutcome(data, horizon, atRiskMwh, potentialRecoveryMwh) {
  const prediction = data.predictions.find((row) => row.horizonMinutes === horizon);
  const outcome = data.scenario.outcomes.find((row) => row.horizonMinutes === horizon);
  prediction.atRiskMwh = outcome.atRiskMwh = atRiskMwh;
  outcome.potentialRecoveryMwh = potentialRecoveryMwh;
  outcome.remainingWasteMwh = atRiskMwh - potentialRecoveryMwh;
}

test('interpolation moves values, axis, mode and selection from the previous display', () => {
  const h = chartHarness();
  const fromRows = outlookRows(h.data);
  const toRows = fromRows.map((row) => ({ ...row, atRiskMwh: row.atRiskMwh * 2 }));
  const middle = h.context.outlookInterpolate(
    { rows: fromRows, max: 0.5, mix: 0, selection: 0 },
    { rows: toRows, max: 1, mix: 1, selection: 1 }, 0.5);
  assert.ok(Math.abs(middle.rows[0].atRiskMwh - 0.345) < 1e-12);
  assert.equal(middle.max, 0.75);
  assert.equal(middle.mix, 0.5);
  assert.equal(middle.selection, 0.5);
  assert.equal(middle.rows.length, 2);
});

test('a newer update cancels the old animation and continues from the visible values', () => {
  const h = chartHarness();
  h.context.outlookSync(h.card);
  assert.equal(h.paints.length, 1);
  const originalCard = h.runtime.card;
  setOutcome(h.data, 30, 2, 0.7);
  h.setNow(100);
  h.context.outlookSync(h.card);
  assert.equal(h.frames.size, 1);
  h.tick(380);
  const interim = h.runtime.display.rows[0].atRiskMwh;
  assert.ok(interim > 1 && interim < 2);
  const obsoleteFrame = [...h.frames.keys()][0];

  setOutcome(h.data, 30, 1, 0.5);
  h.setNow(400);
  h.context.outlookSync(h.card);
  assert.ok(h.cancelled.includes(obsoleteFrame));
  assert.equal(h.frames.size, 1);
  assert.equal(h.runtime.card, originalCard);
  h.tick(680);
  assert.ok(h.runtime.display.rows[0].atRiskMwh > 1);
  assert.ok(h.runtime.display.rows[0].atRiskMwh < interim);
  h.tick(960);
  assert.equal(h.runtime.display.rows[0].atRiskMwh, 1);
  assert.equal(h.runtime.display.max, 1);
  assert.equal(h.frames.size, 0);
});

test('mode and selected target animate, while reduced motion updates immediately', () => {
  const h = chartHarness();
  h.context.outlookSync(h.card);
  h.context.dashboardMode = 'recovery';
  h.context.modelState.horizon = 60;
  h.setNow(100);
  h.context.outlookSync(h.card);
  assert.equal(h.frames.size, 1);
  h.tick(380);
  assert.ok(h.runtime.display.mix > 0 && h.runtime.display.mix < 1);
  assert.ok(h.runtime.display.selection > 0 && h.runtime.display.selection < 1);
  h.tick(660);
  assert.equal(h.runtime.display.mix, 1);
  assert.equal(h.runtime.display.selection, 1);
  assert.equal(h.runtime.display.rows.length, 2);

  h.setReducedMotion(true);
  setOutcome(h.data, 60, 3, 1);
  h.context.outlookSync(h.card);
  assert.equal(h.runtime.display.rows[1].atRiskMwh, 3);
  assert.equal(h.runtime.display.max, 3);
  assert.equal(h.frames.size, 0);
});

test('mode buttons and SVG regions drive the same persistent chart', () => {
  const h = chartHarness();
  h.context.outlookSync(h.card);
  h.context.render = () => h.context.outlookSync(h.card);
  const modeButton = {
    dataset: { dashboardMode: 'recovery' },
    closest: () => h.card,
  };
  h.setNow(100);
  h.listeners.get('click')[0]({ target: {
    closest: (selector) => selector === '[data-dashboard-mode]' ? modeButton : null,
  } });
  assert.equal(h.context.dashboardMode, 'recovery');
  assert.equal(h.frames.size, 1);

  const region60 = {
    dataset: { outlookRegion: '60' },
    closest: () => h.card,
  };
  h.setNow(200);
  h.listeners.get('click')[0]({ target: {
    closest: (selector) => selector === '[data-outlook-region]' ? region60 : null,
  } });
  assert.equal(h.context.modelState.horizon, 60);
  assert.equal(h.frames.size, 1);
  h.tick(760);
  assert.equal(h.runtime.display.mix, 1);
  assert.equal(h.runtime.display.selection, 1);

  let prevented = false;
  const region = { dataset: { outlookRegion: '30' } };
  h.setNow(800);
  h.listeners.get('keydown')[0]({
    target: { closest: () => region },
    key: 'Enter',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(h.context.modelState.horizon, 30);
  h.tick(1360);
  assert.equal(h.runtime.display.selection, 0);
  assert.equal(h.runtime.card, h.card);
});

test('one shared series connects both labeled targets without a gap', () => {
  const h = chartHarness();
  const line = h.context.outlookTopPath(50, 500, 80, 40);
  assert.match(line, /^M50 80 C/);
  assert.match(line, / 500 40$/);
  assert.equal((line.match(/\bM/g) || []).length, 1);
  assert.equal((line.match(/\bC/g) || []).length, 1);
  const svg = h.context.outlookSvg(outlookRows(h.data));
  assert.equal((svg.match(/class="outlook-series"/g) || []).length, 1);
  assert.equal((svg.match(/class="outlook-area is-risk"/g) || []).length, 1);
  assert.equal((svg.match(/class="outlook-area is-recovery"/g) || []).length, 1);
  assert.match(svg, /data-outlook-region="30" tabindex="0" role="button"/);
  assert.match(svg, /data-outlook-region="60" tabindex="0" role="button"/);
  assert.equal((svg.match(/class="outlook-x-label"/g) || []).length, 2);
  assert.doesNotMatch(svg, /outlook-target/);
});

test('scrolling and arrow keys select targets while retaining the same chart', () => {
  const h = chartHarness();
  h.context.outlookSync(h.card);
  h.context.render = () => h.context.outlookSync(h.card);
  const wheel = h.listeners.get('wheel')[0];
  let prevented = 0;
  const scroll = delta => wheel({ target: { closest: () => ({}) }, deltaY: delta, deltaX: 0, deltaMode: 0, preventDefault() { prevented++; } });
  scroll(100);
  assert.equal(h.context.modelState.horizon, 60);
  assert.equal(h.runtime.card, h.card);
  scroll(-100);
  assert.equal(h.context.modelState.horizon, 30);
  assert.equal(prevented, 2);
  const keydown = h.listeners.get('keydown')[0];
  keydown({ target: { closest: () => ({ dataset: { outlookRegion: '30' } }) }, key: 'ArrowRight', preventDefault() {} });
  assert.equal(h.context.modelState.horizon, 60);
  keydown({ target: { closest: () => ({ dataset: { outlookRegion: '60' } }) }, key: 'ArrowLeft', preventDefault() {} });
  assert.equal(h.context.modelState.horizon, 30);
});

test('chart geometry reserves space for labels and uses the actual panel width', () => {
  const h = chartHarness();
  const card = {
    querySelector: () => ({ clientWidth: 250, clientHeight: 190 }),
    querySelectorAll: () => [{ offsetHeight: 54 }, { offsetHeight: 68 }],
  };
  const geometry = h.context.outlookGeometry(card);
  assert.equal(geometry.width, 250);
  assert.equal(geometry.height, 190);
  assert.equal(geometry.top, 76);
  assert.ok(geometry.base > geometry.top);
  assert.ok(geometry.centers.every(x => x > 0 && x < 250));
});

test('floating details stay inside both edges of a narrow chart', () => {
  const h = chartHarness();
  for (const width of [250, 340, 768]) {
    for (const center of [20, width / 2, width - 10]) {
      const placed = h.context.outlookLabelCenter(center, 210, width);
      assert.ok(placed - 105 >= 4);
      assert.ok(placed + 105 <= width - 4);
    }
  }
});

test('an unmounted chart cancels its pending animation', () => {
  const h = chartHarness();
  h.context.outlookSync(h.card);
  setOutcome(h.data, 30, 2, 0.7);
  h.setNow(100);
  h.context.outlookSync(h.card);
  h.card.isConnected = false;
  h.tick(200);
  assert.equal(h.runtime.card, null);
  assert.equal(h.runtime.display, null);
  assert.equal(h.frames.size, 0);
});
