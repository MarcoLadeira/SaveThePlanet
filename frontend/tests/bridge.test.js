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
      window: { claimedKwh: allocated, limitedBy: [] }, vehiclesMet: 17, vehiclesMissed: 1,
      ledger: {
        eligibleOpportunityKwh: eligible, allocatedToChargersGridKwh: allocated, allocatedToRealStorageKwh: 0,
        unallocatedOpportunityKwh: eligible - allocated, batteryDeliveredKwh: delivered,
        chargingLossKwh: Math.round((allocated - delivered) * 1000) / 1000, chargingEfficiency: 0.9,
        utilizationFraction: eligible ? allocated / eligible : null,
      },
      opportunityAllocations: shares || [
        { vehicle: 'EV-01', site: 'depot', gridKwh: 25, batteryKwh: 22.5, limitedBy: 'equal-share', chargerKw: 50 },
        { vehicle: 'EV-02', site: 'depot', gridKwh: 25, batteryKwh: 22.5, limitedBy: 'equal-share', chargerKw: 50 },
        { vehicle: 'EV-11', site: 'retail', gridKwh: 3.7, batteryKwh: 3.33, limitedBy: 'charger-rate', chargerKw: 7.4 },
        { vehicle: 'EV-12', site: 'retail', gridKwh: 11.3, batteryKwh: 10.17, limitedBy: 'equal-share', chargerKw: 22 },
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
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../charts3d.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8'), context);
  const sites = [{ id: 'depot', name: 'Fleet depot (hypothetical)', sitePowerKw: 100 }, { id: 'retail', name: 'Retail car park (hypothetical)', sitePowerKw: 30 }];
  Object.assign(context.modelState, { horizon, plan: { alternatives, fleet: { sites } } });  // bridge.js starts with no plan
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
  assert.deepEqual({ ...values }, { routed: 65, eligible: 350, battery: 58.5, loss: 6.5, rise: 1 });
  assert.match(dashCharts.bridgeBattery.draw(values), /65<small>kWh<\/small><\/strong><span class="bridge-of">of 350 kWh eligible/);
  const html = dashCharts.bridgeBattery.draw(values);
  assert.match(html, /58\.5 kWh into EV batteries/);
  assert.match(html, /6\.5 kWh charging loss/);
  assert.doesNotMatch(dashCharts.bridgeBattery.draw(dashCharts.bridgeBattery.start(values)), /NaN|Infinity/);
  // Nothing routed: an empty battery, not a division by zero.
  const empty = dashCharts.bridgeBattery.draw({ routed: 0, eligible: 0, battery: 0, loss: 0, rise: 1 });
  assert.doesNotMatch(empty, /NaN|Infinity/);
});

test('used share is drawn to scale, never rounded up to 100%', () => {
  const { dashCharts } = load(30, [alternative(30, { allocated: 52.04, eligible: 16479.7 })]);
  const html = dashCharts.bridgeUsed.draw(dashCharts.bridgeUsed.values());
  assert.match(html, /<b>0\.32%<\/b>/);
  assert.match(html, /width:0\.315/);
});

test('flexible charging card: charged energy, power used and the equal share at each site', () => {
  const { dashCharts } = load();
  assert.match(dashCharts.fleetDemand.draw(dashCharts.fleetDemand.values()), /<strong>65<\/strong><span>kWh<\/span>.*charged into 4 of 18 cars/s);
  const power = dashCharts.fleetPower.values();
  assert.deepEqual({ ...power }, { used: 130, limit: 130 });  // 65 kWh in half an hour = 130 kW, both sites at their limit
  assert.match(dashCharts.fleetPower.draw(power), /<b>130<\/b> of 130 kW/);
  const stats = dashCharts.fleetSplit.values().stats;
  assert.deepEqual(Array.from(stats, (s) => [s.value, s.label]), [[25, 'Fleet depot · 2 cars'], [11.3, 'Retail car park · 2 cars']]);
  const html = dashCharts.fleetSplit.draw({ stats });
  assert.match(html, /25 kWh each/);
  assert.match(html, /--fleet-fill:0\.769/);  // the depot's 50 of 65 kWh
  assert.match(html, /1 held back by their own charger/);
  assert.doesNotMatch(dashCharts.fleetSplit.draw(dashCharts.fleetSplit.start({ stats })), /NaN|Infinity/);
});

test('one-site fleets show cars fully charged as the second bar', () => {
  const { dashCharts, modelState } = load();
  modelState.plan.fleet.sites = modelState.plan.fleet.sites.slice(0, 1);
  const stats = dashCharts.fleetSplit.values().stats;
  assert.equal(stats.length, 2);
  assert.equal(stats[1].label, 'cars fully charged');
});

test('next move compares the baseline with the equal-share plan', () => {
  const { dashCharts } = load();
  const values = dashCharts.planBars.values();
  assert.deepEqual(Array.from(values.bars, (b) => b.value), [60.8, 65, 58.5]);
  const html = dashCharts.planBars.draw(values);
  assert.match(html, /is-recovery" style="--plan-h:1"/);
  assert.match(dashCharts.planHeadline.draw(dashCharts.planHeadline.values()), /Share <em>65 kWh<\/em> equally between <em>4 cars<\/em>/);
  assert.match(dashCharts.planHeadline.draw({ energy: 0, cars: 0, time: '23:00' }), /charge as usual/);
});
