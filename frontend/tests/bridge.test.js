const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The shape of one optimizer alternative (POST /api/v1/charging/optimize), trimmed to what the cards read.
function alternative(horizonMinutes, { allocated = 65, eligible = 350, shares } = {}) {
  const delivered = Math.round(allocated * 0.9 * 1000) / 1000;
  return {
    horizonMinutes, targetAt: '2026-01-31T23:00:00Z',
    baseline: { window: { claimedKwh: 60.8 } },
    optimized: {
      window: { claimedKwh: allocated, limitedBy: [] },
      ledger: {
        eligibleOpportunityKwh: eligible, allocatedToChargersGridKwh: allocated, allocatedToRealStorageKwh: 0,
        unallocatedOpportunityKwh: eligible - allocated, batteryDeliveredKwh: delivered,
        chargingLossKwh: Math.round((allocated - delivered) * 1000) / 1000, chargingEfficiency: 0.9,
        utilizationFraction: eligible ? allocated / eligible : null,
      },
      opportunityAllocations: shares || [
        { vehicle: 'EV-01', gridKwh: 25, batteryKwh: 22.5 }, { vehicle: 'EV-02', gridKwh: 25, batteryKwh: 22.5 },
        { vehicle: 'EV-11', gridKwh: 15, batteryKwh: 13.5 },
      ],
    },
  };
}

function load(horizon = 30, alternatives = [alternative(30), alternative(60, { allocated: 40 })]) {
  const context = vm.createContext({
    modelState: { horizon },
    n: (value) => String(Math.round(value * 100) / 100),
    escapeHtml: String,
    modelTime: (value) => new Date(value).toISOString().slice(11, 16),
    document: { addEventListener() {} },
    console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../charts3d.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8'), context);
  Object.assign(context.modelState, { horizon, plan: { alternatives } });  // bridge.js starts with no plan
  return vm.runInContext('({ dashCharts, planAlternative, modelState })', context);
}

test('cards follow the selected forecast horizon', () => {
  const { dashCharts, planAlternative, modelState } = load(60);
  assert.equal(planAlternative().horizonMinutes, 60);
  assert.equal(dashCharts.planHeadline.values().energy, 40);
  modelState.horizon = 30;
  assert.equal(dashCharts.planHeadline.values().energy, 65);
});

test('battery shows routed energy split into battery and loss', () => {
  const { dashCharts } = load();
  const values = dashCharts.bridgeBattery.values();
  assert.deepEqual({ ...values }, { routed: 65, battery: 58.5, loss: 6.5, rise: 1 });
  const html = dashCharts.bridgeBattery.draw(values);
  assert.match(html, /58\.5 kWh into EV batteries/);
  assert.match(html, /6\.5 kWh charging loss/);
  assert.doesNotMatch(dashCharts.bridgeBattery.draw(dashCharts.bridgeBattery.start(values)), /NaN|Infinity/);
  // Nothing routed: an empty battery, not a division by zero.
  const empty = dashCharts.bridgeBattery.draw({ routed: 0, battery: 0, loss: 0, rise: 1 });
  assert.doesNotMatch(empty, /NaN|Infinity/);
});

test('used share is drawn to scale, never rounded up to 100%', () => {
  const { dashCharts } = load(30, [alternative(30, { allocated: 52.04, eligible: 16479.7 })]);
  const html = dashCharts.bridgeUsed.draw(dashCharts.bridgeUsed.values());
  assert.match(html, /<b>0\.32%<\/b>/);
  assert.match(html, /width:0\.315/);
});

test('per-car bars show equal shares on one scale', () => {
  const { dashCharts } = load();
  const html = dashCharts.bridgeCars.draw(dashCharts.bridgeCars.values());
  assert.equal((html.match(/--h:1;/g) || []).length, 2);  // the two cars with the largest (equal) share
  assert.match(html, /--h:0\.6;--b:0\.9/);  // 15 of 25 kWh, 90% of it into the battery
  assert.match(html, /<small>11<\/small>/);  // "EV-" is dropped from the label
  assert.match(dashCharts.bridgeCars.draw(dashCharts.bridgeCars.start(dashCharts.bridgeCars.values())), /--h:0;/);
});

test('next move compares the baseline with the equal-share plan', () => {
  const { dashCharts } = load();
  const values = dashCharts.planBars.values();
  assert.deepEqual(Array.from(values.bars, (b) => b.value), [60.8, 65, 58.5]);
  const html = dashCharts.planBars.draw(values);
  assert.match(html, /is-recovery" style="--plan-h:1"/);
  assert.match(dashCharts.planHeadline.draw(dashCharts.planHeadline.values()), /Share <em>65 kWh<\/em> equally between <em>3 cars<\/em>/);
  assert.match(dashCharts.planHeadline.draw({ energy: 0, cars: 0, time: '23:00' }), /charge as usual/);
});
