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
    // Browser pieces bridge.js wires up at load (energy ribbons); the charts under test do not need them.
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: () => 0,
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
  assert.match(dashCharts.bridgeBattery.draw(values), /Routed to EV chargers<\/span><strong>0\.065<small>MWh<\/small><\/strong>/);
  const html = dashCharts.bridgeBattery.draw(values);
  assert.match(html, /Usable<\/span><b>0\.35 MWh<\/b>/);
  assert.doesNotMatch(dashCharts.bridgeBattery.draw(dashCharts.bridgeBattery.start(values)), /NaN|Infinity/);
  // Nothing routed: an empty battery, not a division by zero.
  const empty = dashCharts.bridgeBattery.draw({ routed: 0, eligible: 0, battery: 0, loss: 0, rise: 1 });
  assert.doesNotMatch(empty, /NaN|Infinity/);
});

test('grid battery: level, room left and the charge bar from its starting level', () => {
  const alt = alternative(30, { allocated: 65, eligible: 8000 });
  Object.assign(alt.optimized.ledger, {
    allocatedToRealStorageKwh: 2500, unallocatedOpportunityKwh: 5435,
    storage: { gridKwh: 2500, storedKwh: 2250, lossKwh: 250, startKwh: 4000, endKwh: 6250, startFraction: 0.4, endFraction: 0.625,
               capacityKwh: 10000, maxPowerKw: 5000, chargeEfficiency: 0.9, limitedBy: 'power-limit' },
  });
  const { dashCharts } = load(30, [alt]);
  const values = dashCharts.bridgeBattery.values();
  const html = dashCharts.bridgeBattery.draw(values);
  assert.match(html, /Battery level<\/span><strong>63%<small>full<\/small><\/strong><em>6\.25 of 10 MWh<\/em>/);
  assert.match(html, /Room left<\/span><b>3\.75<small>MWh<\/small><\/b>/);
  assert.match(html, /\+2\.25 MWh stored this half-hour · 40% → 63%/);  // whole percentages for the pitch
  assert.match(html, /class="bridge-level-box" style="--level:62\.5%"><div class="bridge-level"><\/div><b class="bridge-level-tag">63%<\/b>/);
  assert.doesNotMatch(html, /kWh/);
  assert.match(html, /is-start" style="width:40%/);
  assert.match(html, /is-added" style="left:40%;width:22\.5/);
  // It fills from the starting charge, never from empty or past full.
  const first = dashCharts.bridgeBattery.draw(dashCharts.bridgeBattery.start(values));
  assert.match(first, /is-added" style="left:40%;width:0%/);
  assert.doesNotMatch(first, /NaN|Infinity/);
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
