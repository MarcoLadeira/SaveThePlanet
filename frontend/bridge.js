// Energy bridge on the Dashboard: energy at risk (left) -> battery (middle) -> flexible charging (right).
// The "battery" is the backend optimizer's energy router and ledger (POST /api/v1/charging/optimize),
// not a physical storage battery. Every figure here comes from that response; nothing is recomputed.
const FLEET_PRESETS = [['depot-and-retail', 'Depot and retail car park'], ['constrained-site', 'Constrained site']];
Object.assign(modelState, {
  plan: null,
  planError: '',
  planLoading: false,
  fleetPreset: (() => { try { return localStorage.getItem('fleet-preset') === 'constrained-site' ? 'constrained-site' : 'depot-and-retail'; } catch { return 'depot-and-retail'; } })(),
});
let planRequest = 0;

// Plan for the pinned half-hour. A plan that arrives after the page moved to another half-hour is dropped.
async function loadFleetPlan() {
  if (!modelState.data) return;
  const request = ++planRequest, target = modelState.target;
  modelState.planLoading = true;
  try {
    const response = await fetch('/api/v1/charging/optimize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: modelState.fleetPreset, capacityMw: modelState.capacity, ...(target ? { target } : {}) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'The fleet plan could not be calculated.');
    if (request !== planRequest || (body.forecast?.pinnedTarget || null) !== (modelState.target || null)) return;
    modelState.plan = body;
    modelState.planError = '';
  } catch (error) {
    if (request === planRequest) modelState.planError = error.message || 'The fleet plan could not be calculated.';
  } finally {
    if (request === planRequest) {
      modelState.planLoading = false;
      renderLive();
    }
  }
}

document.addEventListener('change', (event) => {
  if (event.target.id !== 'fleet-preset') return;
  modelState.fleetPreset = FLEET_PRESETS.some(([id]) => id === event.target.value) ? event.target.value : FLEET_PRESETS[0][0];
  try { localStorage.setItem('fleet-preset', modelState.fleetPreset); } catch {}
  event.target.blur();
  loadFleetPlan();
});
document.addEventListener('click', (event) => {
  if (event.target.closest('#plan-retry')) loadFleetPlan();
});

// The plan for the forecast horizon the page shows (+30 or +60 min).
function planAlternative() {
  const alternatives = modelState.plan?.alternatives || [];
  return alternatives.find((a) => a.horizonMinutes === modelState.horizon) || alternatives[0] || null;
}
const kwh = (value) => `${n(value)} kWh`;

function planPlaceholder(title) {
  if (modelState.planError) {
    return `<div class="bridge-empty" role="alert"><strong>${title} unavailable</strong><span>${escapeHtml(modelState.planError)}</span><button type="button" class="studio-button" id="plan-retry">Try again ${icon('arrow', 15)}</button></div>`;
  }
  return `<div class="bridge-empty" role="status"><span class="studio-spinner"></span><span>Planning the simulated fleet…</span></div>`;
}

function presetPicker() {
  return `<label class="bridge-preset"><span>Simulated fleet</span><select id="fleet-preset" aria-label="Simulated fleet">${FLEET_PRESETS
    .map(([id, name]) => `<option value="${id}" ${modelState.fleetPreset === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`;
}

function dashboardBattery() {
  const alt = planAlternative();
  const head = cardHead('green', 'Battery', 'Energy bridge: where every forecast kWh goes') + presetPicker();
  if (!alt) return `<section class="dash-card dash-battery">${head}${planPlaceholder('Energy bridge')}</section>`;
  const L = alt.optimized.ledger;
  const notEligible = L.notEligibleKwh > 0
    ? `<p class="bridge-note">${kwh(L.notEligibleKwh)} of the ${kwh(L.predictedAtRiskKwh)} at risk cannot be claimed by this fleet: ${escapeHtml(L.notEligibleReasons.map((r) => r.message).join(' '))}</p>` : '';
  const why = L.unallocatedReasons[0]?.message;
  const balanced = Math.abs(L.eligibleOpportunityKwh - L.allocatedToChargersGridKwh - L.allocatedToRealStorageKwh - L.unallocatedOpportunityKwh) < 1e-6;
  return `<section class="dash-card dash-battery">${head}
    <div class="bridge-in"><span>In · eligible forecast energy</span><strong>${kwh(L.eligibleOpportunityKwh)}</strong></div>
    ${notEligible}
    ${chartSlot('bridgeBattery', `${n(L.allocatedToChargersGridKwh)} kWh routed to EV chargers: ${n(L.batteryDeliveredKwh)} kWh into EV batteries and ${n(L.chargingLossKwh)} kWh charging loss`, 'bridge-battery')}
    ${chartSlot('bridgeUsed', `${n((L.utilizationFraction || 0) * 100)}% of the eligible energy is used`, 'bridge-used')}
    <dl class="bridge-ledger">
      <div class="is-charger"><dt>To EV chargers</dt><dd>${kwh(L.allocatedToChargersGridKwh)}</dd></div>
      <div class="is-sub"><dt>into EV batteries</dt><dd>${kwh(L.batteryDeliveredKwh)}</dd></div>
      <div class="is-sub"><dt>charging loss (${n((1 - L.chargingEfficiency) * 100)}%)</dt><dd>${kwh(L.chargingLossKwh)}</dd></div>
      <div><dt>To storage</dt><dd>${kwh(L.allocatedToRealStorageKwh)}</dd></div>
      <div class="is-left"><dt>Left unallocated</dt><dd>${kwh(L.unallocatedOpportunityKwh)}</dd></div>
    </dl>
    ${why ? `<p class="bridge-note"><b>Why not more:</b> ${escapeHtml(why)}</p>` : ''}
    <p class="bridge-check ${balanced ? 'is-ok' : 'is-bad'}">${balanced ? icon('check', 14) : ''} ${n(L.eligibleOpportunityKwh)} = ${n(L.allocatedToChargersGridKwh)} + ${n(L.allocatedToRealStorageKwh)} + ${n(L.unallocatedOpportunityKwh)} kWh · every kWh accounted for</p>
    <p class="bridge-foot">Simulated fleet · network eligibility unverified · grid-side kWh · a plan, not measured charging</p>
  </section>`;
}

function dashboardFlexible() {
  const alt = planAlternative();
  const head = cardHead('green', 'Flexible charging', 'Shared equally per site · simulated fleet');
  if (!alt) return `<section class="dash-card dash-flexible">${head}${planPlaceholder('Fleet plan')}</section>`;
  return `<section class="dash-card dash-fleet dash-flexible">${head}
    <div class="fleet-body">${chartSlot('fleetDemand', `${n(alt.optimized.ledger.allocatedToChargersGridKwh)} kWh charged into the cars`, 'fleet-demand', 'group')}<span class="fleet-scene" aria-hidden="true"><img src="./charging-scene.webp?v=20260927a" alt="" width="799" height="516" decoding="async" draggable="false"></span></div>
    ${chartSlot('fleetPower', 'Charging power used', 'fleet-meter', 'group')}
    ${chartSlot('fleetSplit', 'Equal share per car at each site', 'fleet-stats', 'group')}
  </section>`;
}

function dashboardNextMove() {
  const alt = planAlternative();
  const head = cardHead('tricolour', 'Your next move', 'Suggested plan for the selected half-hour');
  if (!alt) return `<section class="dash-card dash-plan">${head}${planPlaceholder('Plan')}</section>`;
  return `<section class="dash-card dash-plan">${head}
    ${chartSlot('planHeadline', 'Recommendation', 'plan-headline-slot', 'group')}
    <p class="plan-units">Bars in kWh (1 MWh = 1,000 kWh): ${kwh(alt.optimized.ledger.unallocatedOpportunityKwh)} more is at risk than this fleet can take.</p>
    ${chartSlot('planBars', `Charging on arrival ${n(alt.baseline.window.claimedKwh)} kWh, equal share ${n(alt.optimized.window.claimedKwh)} kWh, into batteries ${n(alt.optimized.ledger.batteryDeliveredKwh)} kWh`, 'plan-chart')}
    <p class="plan-caveat">Simulated fleet, no charger is controlled; network eligibility unverified.</p>
    <button class="plan-cta" type="button" data-page="charging">Review EV charging ${icon('arrow', 20)}</button>
  </section>`;
}

// Charts drawn by the shared engine in charts3d.js, so they grow in and glide between plans.
dashCharts.bridgeBattery = {
  values() {
    const L = planAlternative().optimized.ledger;
    return { routed: L.allocatedToChargersGridKwh, eligible: L.eligibleOpportunityKwh, battery: L.batteryDeliveredKwh, loss: L.chargingLossKwh, rise: 1 };
  },
  start: (target) => ({ ...target, rise: 0 }),
  draw({ routed, eligible, battery, loss, rise }) {
    const top = 34, bottom = 196, h = bottom - top;
    const lossH = routed > 0 ? Math.max(loss > 0 ? 6 : 0, (loss / routed) * h) * rise : 0;
    const batteryH = routed > 0 ? (h - (loss / routed) * h) * rise : 0;
    return `<svg viewBox="0 0 150 214" aria-hidden="true">
      <defs><linearGradient id="bridge-cell" x2="0" y2="1"><stop stop-color="#7ee8b1"/><stop offset="1" stop-color="#119a63"/></linearGradient>
      <linearGradient id="bridge-shell" x1="0" x2="1"><stop stop-color="var(--bridge-shell-a)"/><stop offset="1" stop-color="var(--bridge-shell-b)"/></linearGradient></defs>
      <rect class="bridge-term" x="42" y="14" width="22" height="16" rx="4"/><rect class="bridge-term" x="86" y="14" width="22" height="16" rx="4"/>
      <rect x="20" y="26" width="110" height="178" rx="16" fill="url(#bridge-shell)" class="bridge-shell"/>
      <clipPath id="bridge-clip"><rect x="28" y="${top}" width="94" height="${h + 0.01}" rx="10"/></clipPath>
      <g clip-path="url(#bridge-clip)">
        <rect class="bridge-empty-cell" x="28" y="${top}" width="94" height="${h}"/>
        <rect x="28" y="${bottom - batteryH}" width="94" height="${batteryH}" fill="url(#bridge-cell)"/>
        <rect class="bridge-loss" x="28" y="${bottom - batteryH - lossH}" width="94" height="${lossH}"/>
      </g>
      <path class="bridge-bolt" d="M82 70 62 118h15l-6 38 22-52H78l4-34Z"/>
    </svg>
    <div class="bridge-battery-copy"><span>Routed to EV chargers</span><strong>${n(routed)}<small>kWh</small></strong><span class="bridge-of">of ${n(eligible)} kWh eligible</span>
      <em><i class="is-battery"></i>${n(battery)} kWh into EV batteries</em><em><i class="is-loss"></i>${n(loss)} kWh charging loss</em></div>`;
  },
};

dashCharts.bridgeUsed = {
  values: () => ({ used: planAlternative().optimized.ledger.utilizationFraction || 0 }),
  start: () => ({ used: 0 }),
  // Drawn to scale: a small share stays a small sliver (with a marker so it is findable), never rounded up.
  draw: ({ used }) => `<div class="bridge-used-head"><span>Share of eligible energy used</span><b>${n(used * 100)}%</b></div>
    <div class="bridge-used-track"><i style="width:${Math.min(100, used * 100)}%"></i><b style="left:${Math.min(100, used * 100)}%"></b></div>`,
};

// Flexible charging card. Equal share happens per site (each has its own power limit and energy cannot
// move between sites), so the two simple bars show each site's share per car.
function fleetSites() {
  const plan = modelState.plan, shares = planAlternative().optimized.opportunityAllocations || [];
  return (plan.fleet?.sites || []).map((site) => {
    const cars = shares.filter((s) => s.site === site.id);
    const equal = cars.filter((c) => c.limitedBy === 'equal-share').map((c) => c.gridKwh);
    return { name: String(site.name).replace(/\s*\(hypothetical\)\s*$/i, ''), powerKw: site.sitePowerKw, cars: cars.length,
             total: cars.reduce((sum, c) => sum + c.gridKwh, 0), each: equal.length ? Math.max(...equal) : Math.max(0, ...cars.map((c) => c.gridKwh)),
             capped: cars.filter((c) => c.limitedBy === 'charger-rate').length };
  }).filter((site) => site.cars);
}

function fleetStat(tone, glyph, value, label, fill, title = '') {
  return `<div class="fleet-stat is-${tone}" title="${escapeHtml(title)}"><span class="fleet-stat-icon">${icon(glyph, 18)}</span><div class="fleet-stat-copy"><strong>${value}</strong><small>${escapeHtml(label)}</small><span class="fleet-stat-bar" role="img" aria-label="${Math.round(fill * 100)}%" style="--fleet-fill:${Math.min(1, Math.max(0, fill))}"><i></i></span></div></div>`;
}

dashCharts.fleetDemand = {
  values() {
    const o = planAlternative().optimized;
    return { energy: o.ledger.allocatedToChargersGridKwh, cars: (o.opportunityAllocations || []).length, total: o.vehiclesMet + o.vehiclesMissed };
  },
  start: (target) => ({ ...target, energy: 0 }),
  draw: ({ energy, cars, total }) => `<p class="fleet-figure"><strong>${n(energy)}</strong><span>kWh</span></p><p class="fleet-caption">charged into ${Math.round(cars)} of ${Math.round(total)} cars</p>`,
};

dashCharts.fleetPower = {
  values() {
    const used = planAlternative().optimized.ledger.allocatedToChargersGridKwh / 0.5;
    return { used, limit: (modelState.plan.fleet?.sites || []).reduce((sum, s) => sum + s.sitePowerKw, 0) };
  },
  start: (target) => ({ ...target, used: 0 }),
  draw: ({ used, limit }) => `<div class="fleet-meter-head"><span>Charging power used</span><span><b>${n(used)}</b> of ${n(limit)} kW</span></div>
    <div class="fleet-track" role="meter" aria-label="Charging power used" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${used}" aria-valuetext="${n(used)} of ${n(limit)} kW" style="--fleet-fill:${limit > 0 ? Math.min(1, used / limit) : 0}"><i></i><b></b></div>`,
};

dashCharts.fleetSplit = {
  values() {
    const o = planAlternative().optimized, sites = fleetSites();
    const routed = o.ledger.allocatedToChargersGridKwh;
    const stats = sites.slice(0, 2).map((site, i) => ({
      tone: i ? 'orange' : 'green', glyph: 'charge', value: site.each, unit: 'kWh each',
      label: `${site.name} · ${site.cars} car${site.cars === 1 ? '' : 's'}`, fill: routed > 0 ? site.total / routed : 0,
      title: `${site.name}: ${n(site.total)} kWh shared by ${site.cars} cars under its ${n(site.powerKw)} kW limit${site.capped ? `; ${site.capped} held back by their own charger` : ''}`,
    }));
    const total = o.vehiclesMet + o.vehiclesMissed;
    if (stats.length < 2) stats.push({ tone: 'orange', glyph: 'clock', value: o.vehiclesMet, unit: `of ${total}`,
      label: 'cars fully charged', fill: total ? o.vehiclesMet / total : 0, title: '' });
    return { stats };
  },
  start: (target) => ({ stats: target.stats.map((s) => ({ ...s, value: 0, fill: 0 })) }),
  draw: ({ stats }) => stats.map((s) => fleetStat(s.tone, s.glyph, `${n(s.value)} ${escapeHtml(s.unit)}`, s.label, s.fill, s.title)).join(''),
};

// "Your next move" now follows the fleet plan rather than the aggregate upper bound.
dashCharts.planHeadline = {
  values() {
    const alt = planAlternative(), o = alt.optimized;
    return { energy: o.ledger.allocatedToChargersGridKwh, cars: (o.opportunityAllocations || []).length, time: modelTime(alt.targetAt) };
  },
  start: (target) => ({ ...target, energy: 0 }),
  draw: ({ energy, cars, time }) => (energy > 0
    ? `<h3 class="plan-headline">Share <em>${n(energy)} kWh</em> equally between <em>${Math.round(cars)} cars</em> at <em>${escapeHtml(time)}</em>.</h3>`
    : `<h3 class="plan-headline">No charging can use this half-hour: <em>charge as usual</em>.</h3>`),
};

dashCharts.planBars = {
  values() {
    const alt = planAlternative();
    return { rise: 1, bars: [
      { key: 'flex', label: 'On arrival', value: alt.baseline.window.claimedKwh },
      { key: 'recovery', label: 'Equal share', value: alt.optimized.window.claimedKwh },
      { key: 'risk', label: 'Into batteries', value: alt.optimized.ledger.batteryDeliveredKwh },
    ] };
  },
  start: (target) => ({ ...target, rise: 0 }),
  draw({ rise, bars }) {
    const max = Math.max(...bars.map((bar) => bar.value));
    return `<div class="plan-bars">${bars.map((bar) => `<div class="plan-bar is-${bar.key}" style="--plan-h:${max > 0 ? (bar.value / max) * rise : 0}"><span class="plan-bar-value"><strong>${n(bar.value)}</strong>kWh</span><i></i></div>`).join('')}</div>
      <div class="plan-labels">${bars.map((bar) => `<span>${bar.label}</span>`).join('')}</div>`;
  },
};
