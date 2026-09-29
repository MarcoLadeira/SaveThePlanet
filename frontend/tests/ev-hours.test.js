const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Issue #80: potential full EV charges per day and per hour, from the day plan (GET /api/v1/impact/day).
function load(intervals, { target = '2026-01-10T13:00:00Z', status = 'ready' } = {}) {
  const context = vm.createContext({
    modelState: { horizon: 30, target, capacity: 100 },
    settings: { timezone: 'UTC' },
    selectedPrediction: () => ({ targetAt: target }),
    n: (value) => String(Math.round(value * 100) / 100),
    escapeHtml: String,
    modelTime: (value) => new Date(value).toISOString().slice(11, 16),
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: () => 0,
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    pageFromHash: () => 'overview',
    console, Intl, Date,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../charts3d.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8'), context);
  const total = intervals.reduce((t, i) => t + i.potentialFullCharges, 0);
  vm.runInContext(`modelState.fleetPreset = 'depot-and-retail';
    Object.assign(dayPlan, { status: ${JSON.stringify(status)}, key: dayPlanKey(),
      data: { date: '2026-01-10', intervals: ${JSON.stringify(intervals)}, totals: { potentialFullCharges: ${total} },
              evEquivalent: { referenceBatteryKwh: 70, chargingEfficiency: 0.9 } } });`, context);
  return vm.runInContext('({ dashCharts, evHours, evDayTotal })', context);
}
const halfHours = (charges) => charges.map((c, i) => ({ targetAt: new Date(Date.UTC(2026, 0, 10, 0, 30 * i)).toISOString(), potentialFullCharges: c }));

test('two half-hours add up into their hour, and the day is the sum of the hours', () => {
  const charges = Array.from({ length: 48 }, (_, i) => (i % 2 ? 2 : 1));  // 3 per hour, 72 per day
  const { evHours, evDayTotal } = load(halfHours(charges));
  const hours = evHours();
  assert.equal(hours.length, 24);
  assert.ok(hours.every((h) => h.charges === 3 && h.halfHours === 2));
  assert.equal(evDayTotal(), 72);
});

test('AM shows 12 AM to 11 AM and PM shows 12 PM to 11 PM, 12 rows each', () => {
  const charges = Array.from({ length: 48 }, (_, i) => Math.floor(i / 2));  // hour h: 2h
  const { dashCharts } = load(halfHours(charges));
  const pm = dashCharts.evHours.values();  // the selected half-hour (13:00) is in the afternoon
  assert.equal(pm.half, 'pm');
  assert.deepEqual([...pm.hours], [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  assert.equal(pm.v[7], 38);  // 7 PM = 19 + 19
  const html = dashCharts.evHours.draw(pm);
  assert.equal((html.match(/class="ev-hour[ "]/g) || []).length, 12);
  assert.match(html, /7 PM<\/span>[\s\S]*?38<small> cars/);
  assert.match(html, /is-selected"><span class="ev-hour-label">1 PM/);
});

test('no energy at risk shows zeros, and no day plan shows a placeholder, never made-up numbers', () => {
  const zero = load(halfHours(Array(48).fill(0)));
  assert.equal(zero.evDayTotal(), 0);
  assert.match(zero.dashCharts.evDayTotal.draw(zero.dashCharts.evDayTotal.values()), /<strong>0<\/strong><span>cars\/day/);
  const missing = load(halfHours(Array(48).fill(1)), { status: 'error' });
  assert.equal(missing.evDayTotal(), null);
  assert.match(missing.dashCharts.evDayTotal.draw(missing.dashCharts.evDayTotal.values()), /<strong>—<\/strong>.*Day plan unavailable/s);
  assert.equal(missing.dashCharts.evHours.draw(missing.dashCharts.evHours.values()), '');
});
