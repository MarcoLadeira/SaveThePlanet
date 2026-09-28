// Energy bridge on the Dashboard: energy at risk (left) -> battery (middle) -> flexible charging (right).
// The card is the backend optimizer's energy router and ledger (POST /api/v1/charging/optimize). Its battery is
// a simulated grid battery (backend/storage.py, ledger.storage) that takes what the EVs could not; no real
// storage asset is claimed. Every figure here comes from that response; nothing is recomputed.
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

// The same fleet + grid battery plan for each half-hour of the pinned target's day (GET /api/v1/impact/day,
// backend/dayplan.py), shared by the Battery and EV pages. Each half-hour is a separate what-if with the same
// fleet and battery, so its recovery figures are never added up across the day.
const dayPlan = { status: 'idle', data: null, key: '', request: 0 };
function dayPlanKey() { return [modelState.target ? modelState.target.slice(0, 10) : '', modelState.capacity, modelState.fleetPreset].join('|'); }
function dayPlanReady() { return dayPlan.status === 'ready' && dayPlan.key === dayPlanKey() && dayPlan.data?.intervals?.length > 0; }
function dayPlanLoading() { return dayPlan.key !== dayPlanKey() || dayPlan.status === 'loading' || dayPlan.status === 'idle'; }
// Called while rendering: starts a load when the target day, capacity or fleet changed.
function ensureDayPlan() {
  if (!modelState.data || (dayPlan.key === dayPlanKey() && dayPlan.status !== 'idle')) return;
  dayPlan.key = dayPlanKey();
  dayPlan.status = 'loading';
  setTimeout(loadDayPlan);
}
async function loadDayPlan() {
  const request = ++dayPlan.request, key = dayPlan.key;
  const query = new URLSearchParams({ capacityMw: String(modelState.capacity), preset: modelState.fleetPreset });
  if (modelState.target) query.set('date', modelState.target.slice(0, 10));
  try {
    const response = await fetch(`/api/v1/impact/day?${query}`);
    const body = await response.json();
    if (request !== dayPlan.request) return;
    if (!response.ok || !Array.isArray(body.intervals) || !body.intervals.length) throw new Error(body.error?.message || 'Day plan unavailable');
    Object.assign(dayPlan, { status: 'ready', data: body, key });
  } catch {
    if (request === dayPlan.request) Object.assign(dayPlan, { status: 'error', data: null, key });
  } finally {
    if (request === dayPlan.request && ['impact', 'charging'].includes(pageFromHash())) render();
  }
}
// The day-plan half-hour that is the selected forecast target (-1 when the target is not on the day).
function dayPlanIndex(p = selectedPrediction()) {
  const target = new Date(p.targetAt).getTime();
  return dayPlanReady() ? dayPlan.data.intervals.findIndex((i) => new Date(i.targetAt).getTime() === target) : -1;
}
// A replay day runs from 00:30 to 00:00 the next day (48 +30 min forecasts issued across one UTC day).
function dayPlanTime(targetAt) {
  const next = dayPlanReady() && targetAt.slice(0, 10) > dayPlan.data.date;
  return `${modelTime(targetAt)}${next ? ' (next day)' : ''}`;
}

// Estimated CO2 avoided and EV range for one plan ledger, the same formulas as backend/dayplan.py:
// EV charging plus energy stored in the battery displaces grid-average electricity at 0.25 kg/kWh;
// range = energy into EV batteries / 0.18 kWh per km.
const PLAN_KG_CO2_PER_KWH = 0.25, PLAN_EV_KWH_PER_KM = 0.18;
function planImpact(L) {
  const stored = L.storage?.storedKwh || 0, captured = L.allocatedToChargersGridKwh + (L.allocatedToRealStorageKwh || 0);
  return { stored, captured, co2Kg: (L.allocatedToChargersGridKwh + stored) * PLAN_KG_CO2_PER_KWH,
           rangeKm: L.batteryDeliveredKwh / PLAN_EV_KWH_PER_KM,
           share: L.predictedAtRiskKwh > 0 ? captured / L.predictedAtRiskKwh : null };
}

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
  const why = L.unallocatedReasons[0]?.message, S = L.storage;
  const storageRows = S
    ? `<div class="is-storage"><dt>To grid battery (simulated)</dt><dd>${kwh(L.allocatedToRealStorageKwh)}</dd></div>
      <div class="is-sub"><dt>stored</dt><dd>${kwh(S.storedKwh)}</dd></div>
      <div class="is-sub"><dt>conversion loss (${n((1 - S.chargeEfficiency) * 100)}%)</dt><dd>${kwh(S.lossKwh)}</dd></div>`
    : `<div><dt>To storage</dt><dd>${kwh(L.allocatedToRealStorageKwh)}</dd></div>`;
  const label = S
    ? `Simulated grid battery: ${n(S.gridKwh)} kWh taken, ${n(S.storedKwh)} kWh stored, from ${n(S.startFraction * 100)}% to ${n(S.endFraction * 100)}% full`
    : `${n(L.allocatedToChargersGridKwh)} kWh routed to EV chargers: ${n(L.batteryDeliveredKwh)} kWh into EV batteries and ${n(L.chargingLossKwh)} kWh charging loss`;
  const balanced = Math.abs(L.eligibleOpportunityKwh - L.allocatedToChargersGridKwh - L.allocatedToRealStorageKwh - L.unallocatedOpportunityKwh) < 1e-6;
  return `<section class="dash-card dash-battery">${head}
    <div class="bridge-in"><span>In · eligible forecast energy</span><strong>${kwh(L.eligibleOpportunityKwh)}</strong></div>
    ${notEligible}
    ${chartSlot('bridgeBattery', label, 'bridge-battery')}
    ${chartSlot('bridgeUsed', `${n((L.usedWithStorageFraction ?? L.utilizationFraction ?? 0) * 100)}% of the eligible energy is used`, 'bridge-used')}
    <dl class="bridge-ledger">
      <div class="is-charger"><dt>To EV chargers</dt><dd>${kwh(L.allocatedToChargersGridKwh)}</dd></div>
      <div class="is-sub"><dt>into EV batteries</dt><dd>${kwh(L.batteryDeliveredKwh)}</dd></div>
      <div class="is-sub"><dt>charging loss (${n((1 - L.chargingEfficiency) * 100)}%)</dt><dd>${kwh(L.chargingLossKwh)}</dd></div>
      ${storageRows}
      <div class="is-left"><dt>Left unallocated</dt><dd>${kwh(L.unallocatedOpportunityKwh)}</dd></div>
    </dl>
    ${why ? `<p class="bridge-note"><b>Why not more:</b> ${escapeHtml(why)}</p>` : ''}
    <p class="bridge-check ${balanced ? 'is-ok' : 'is-bad'}">${balanced ? icon('check', 14) : ''} ${n(L.eligibleOpportunityKwh)} = ${n(L.allocatedToChargersGridKwh)} + ${n(L.allocatedToRealStorageKwh)} + ${n(L.unallocatedOpportunityKwh)} kWh · every kWh accounted for</p>
    <p class="bridge-foot">Simulated fleet${S ? ' and grid battery (charging only; release not modelled)' : ''} · network eligibility unverified · grid-side kWh · a plan, not measured charging</p>
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
    <p class="plan-units">Bars in kWh (1 MWh = 1,000 kWh): ${kwh(alt.optimized.ledger.unallocatedOpportunityKwh)} more is at risk than this fleet${alt.optimized.ledger.storage ? ' and the grid battery' : ''} can take.</p>
    ${chartSlot('planBars', `Charging on arrival ${n(alt.baseline.window.claimedKwh)} kWh, equal share ${n(alt.optimized.window.claimedKwh)} kWh, into batteries ${n(alt.optimized.ledger.batteryDeliveredKwh)} kWh`, 'plan-chart')}
    <p class="plan-caveat">Simulated fleet, no charger is controlled; network eligibility unverified.</p>
    <button class="plan-cta" type="button" data-page="charging">Review EV charging ${icon('arrow', 20)}</button>
  </section>`;
}

// Charts drawn by the shared engine in charts3d.js, so they grow in and glide between plans.
dashCharts.bridgeBattery = {
  values() {
    const L = planAlternative().optimized.ledger, S = L.storage;
    const base = { routed: L.allocatedToChargersGridKwh, eligible: L.eligibleOpportunityKwh, battery: L.batteryDeliveredKwh, loss: L.chargingLossKwh, rise: 1 };
    if (!S) return base;
    return { ...base, grid: S.gridKwh, stored: S.storedKwh, start: S.startFraction, end: S.endFraction,
             capacity: S.capacityKwh, power: S.maxPowerKw, limitedBy: S.limitedBy };
  },
  // The battery fills from its starting charge.
  start: (target) => ({ ...target, rise: 0, ...(target.end === undefined ? {} : { grid: 0, stored: 0, end: target.start }) }),
  draw(v) {
    if (v.end === undefined) return bridgeRoutingCopy(v);
    const start = Math.max(0, Math.min(1, v.start)), end = Math.max(start, Math.min(1, v.end));
    const limit = { 'power-limit': `held to its ${n(v.power)} kW power limit`, full: 'now full', 'took-everything': 'took all that was left' }[v.limitedBy] || 'nothing left to take';
    return `<div class="bridge-cabinet-art is-yard" aria-hidden="true"><img src="./assets/dashboard-grid-battery.webp" alt="" decoding="async"><span>Simulated grid battery · ${n(v.capacity / 1000)} MWh / ${n(v.power / 1000)} MW</span></div>
    <div class="bridge-battery-copy is-grid"><span>Stored in the grid battery</span><strong>${n(v.stored)}<small>kWh</small></strong><span class="bridge-of">${n(v.grid)} kWh taken from the grid, ${escapeHtml(limit)}</span>
      <div class="bridge-soc"><i class="is-start" style="width:${+(start * 100).toFixed(3)}%"></i><i class="is-added" style="left:${+(start * 100).toFixed(3)}%;width:${+((end - start) * 100).toFixed(3)}%"></i></div>
      <em><i class="is-battery"></i>${n(v.start * 100)}% → ${n(v.end * 100)}% full · EV chargers took ${n(v.routed)} kWh first</em></div>`;
  },
};

function bridgeRoutingCopy({ routed, eligible, battery, loss }) {
  return `<div class="bridge-cabinet-art" aria-hidden="true"><img src="./assets/dashboard-battery-cutout.png" alt="" decoding="async"><span>Illustrative energy routing</span></div>
    <div class="bridge-battery-copy"><span>Routed to EV chargers</span><strong>${n(routed)}<small>kWh</small></strong><span class="bridge-of">of ${n(eligible)} kWh eligible</span>
      <em><i class="is-battery"></i>${n(battery)} kWh into EV batteries</em><em><i class="is-loss"></i>${n(loss)} kWh charging loss</em></div>`;
}

dashCharts.bridgeUsed = {
  values() {
    const L = planAlternative().optimized.ledger, eligible = L.eligibleOpportunityKwh;
    return { used: L.utilizationFraction || 0, stored: eligible > 0 ? (L.allocatedToRealStorageKwh || 0) / eligible : 0 };
  },
  start: () => ({ used: 0, stored: 0 }),
  // Drawn to scale: a small share stays a small sliver (with a marker so it is findable), never rounded up.
  // EV chargers first, then the grid battery's share stacked after it.
  draw: ({ used, stored = 0 }) => {
    const ev = Math.min(100, used * 100), total = Math.min(100, (used + stored) * 100);
    return `<div class="bridge-used-head"><span>Share of eligible energy used${stored > 0 ? ' <i class="is-battery"></i>EVs <i class="is-storage"></i>grid battery' : ''}</span><b>${n((used + stored) * 100)}%</b></div>
    <div class="bridge-used-track"><i style="width:${ev}%"></i>${stored > 0 ? `<i class="is-storage" style="left:${ev}%;width:${total - ev}%"></i>` : ''}<b style="left:${total}%"></b></div>`;
  },
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
      { key: 'risk', label: 'Into EV batteries', value: alt.optimized.ledger.batteryDeliveredKwh },
    ] };
  },
  start: (target) => ({ ...target, rise: 0 }),
  draw({ rise, bars }) {
    const max = Math.max(...bars.map((bar) => bar.value));
    return `<div class="plan-bars">${bars.map((bar) => `<div class="plan-bar is-${bar.key}" style="--plan-h:${max > 0 ? (bar.value / max) * rise : 0}"><span class="plan-bar-value"><strong>${n(bar.value)}</strong>kWh</span><i></i></div>`).join('')}</div>
      <div class="plan-labels">${bars.map((bar) => `<span>${bar.label}</span>`).join('')}</div>`;
  },
};

// Re-measure after layout so the ribbons connect cards at any desktop scale.
function updateDashboardFlow(){
  const grid=document.querySelector('.bridge-layout'),svg=grid?.querySelector('.dashboard-flow-links');
  if(!svg)return;
  const source=grid.querySelector('.dash-hero'),art=grid.querySelector('.bridge-cabinet-art'),dest=grid.querySelector('.dash-flexible');
  if(!source||!art||!dest){svg.innerHTML='';return}
  const g=grid.getBoundingClientRect(),a=source.getBoundingClientRect(),b=art.getBoundingClientRect(),c=dest.getBoundingClientRect();
  if(c.left<=b.left){svg.innerHTML='';return}
  svg.setAttribute('viewBox',`0 0 ${g.width} ${g.height}`);
  const y=b.top-g.top+b.height*.43;
  const paths=[
    ['green',a.right-g.left-10,a.top-g.top+a.height*.72,b.left-g.left+b.width*.32,y],
    ['orange',b.left-g.left+b.width*.68,y,c.left-g.left+12,c.top-g.top+c.height*.65]
  ];
  const L=planAlternative()?.optimized.ledger;
  svg.innerHTML=paths.map(([tone,x1,y1,x2,y2])=>{
    const d=`M${x1} ${y1} C${x1+(x2-x1)*.45} ${y1} ${x1+(x2-x1)*.55} ${y2} ${x2} ${y2}`;
    const active=tone==='green'?L?.eligibleOpportunityKwh>0:L?.allocatedToChargersGridKwh>0;
    return `<g class="dashboard-ribbon is-${tone} ${active?'':'is-idle'}"><path class="ribbon-halo" d="${d}"/><path class="ribbon-core" d="${d}"/><path class="ribbon-pulse" d="${d}" pathLength="100"/></g>`;
  }).join('');
}
window.addEventListener('resize',()=>requestAnimationFrame(updateDashboardFlow));
new MutationObserver(records=>{
 if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('.app-shell,.bridge-cabinet-art')||n.querySelector?.('.bridge-cabinet-art')))))requestAnimationFrame(updateDashboardFlow);
}).observe(document.getElementById('app'),{childList:true,subtree:true});

