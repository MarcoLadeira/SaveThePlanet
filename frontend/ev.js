// EV page: which simulated EVs charge when, and how much of it uses the forecast renewable half-hour.
// Loaded after charging.js and bridge.js, so this renderCharging replaces the older Charging page.
// Every figure comes from the energy bridge (POST /api/v1/charging/optimize, loaded by bridge.js into
// modelState.plan for the pinned half-hour and the chosen fleet); nothing is recomputed here.

let evView = 'optimized';
const EV_VIEWS = [['baseline', 'Normal charging'], ['optimized', 'Optimised']];

const evKwh = (value) => `${n(Math.round(value * 10) / 10)} kWh`;
function evSlotTime(plan, slot) {
  return new Date(new Date(plan.forecast.planStartAt).getTime() + slot * 30 * 60000).toISOString();
}
function evSiteName(plan, id) {
  return plan.fleet.sites.find((s) => s.id === id)?.name.replace(/ \(hypothetical\)$/, '') || id;
}

// ---------- KPI row ----------
function evKpi(tone, glyph, label, value, unit, pill, note) {
  return `<article class="dash-card cg-kpi ev-kpi is-${tone}"><span class="cg-kpi-icon" aria-hidden="true">${icon(glyph, 22)}</span><div class="cg-kpi-copy"><span>${label}</span><div class="cg-kpi-figure"><strong>${value}<small>${unit}</small></strong></div></div><p class="cg-kpi-foot">${pill}<em>${note}</em></p></article>`;
}
function evKpis(plan, alt) {
  const o = alt.optimized, b = alt.baseline, L = o.ledger, total = o.vehicles.length, imp = alt.improvement;
  const gain = imp.improved
    ? `<span class="cg-pill is-up">↑ ${n(Math.round(imp.claimedPercent * 10) / 10)}%</span>`
    : '<span class="cg-pill is-flat">→ 0%</span>';
  return `<section class="cg-kpis" aria-label="Optimised plan for the selected half-hour">
    ${evKpi('green', 'car', 'Cars fully charged', `${n(o.vehiclesMet)}`, `of ${n(total)}`, `<span class="cg-pill is-share">${n(b.vehiclesMet)}</span>`, 'with normal charging')}
    ${evKpi('green', 'leaf', 'Renewable half-hour charging', n(Math.round(o.window.chargedKwh * 10) / 10), 'kWh', gain, `vs ${evKwh(b.window.chargedKwh)} normal`)}
    ${evKpi('orange', 'charge', 'Into EV batteries', n(Math.round(L.batteryDeliveredKwh * 10) / 10), 'kWh', `<span class="cg-pill is-flat">${evKwh(L.chargingLossKwh)}</span>`, 'charging loss')}
    ${evKpi('purple', 'battery', 'Charge still missing', n(Math.round(o.unmetKwh * 10) / 10), 'kWh', `<span class="cg-pill ${o.vehiclesMissed ? 'is-down' : 'is-share'}">${n(o.vehiclesMissed)}</span>`, o.vehiclesMissed === 1 ? 'car leaves short' : 'cars leave short')}
  </section>`;
}

// ---------- charging timeline (one row per EV) ----------
dashCharts.evTimeline = {
  values() {
    const alt = planAlternative();
    return { key: String(alt ? `${modelState.plan.id}|${evView}` : ''), reveal: alt ? 1 : 0 };
  },
  start: (t) => ({ ...t, reveal: 0 }),
  draw({ reveal }) {
    const plan = modelState.plan, alt = planAlternative();
    if (!alt) return '';
    const run = alt[evView], slots = plan.fleet.planSlots, win = alt.window.slot, cars = run.vehicles;
    const w = 700, left = 52, right = 84, top = 22, rowH = Math.max(14, Math.min(24, 390 / cars.length)), h = top + rowH * cars.length + 24;
    const colW = (w - left - right) / slots, x = (slot) => left + colW * slot;
    const minute = (iso) => (new Date(iso) - new Date(plan.forecast.planStartAt)) / 60000 / 30;
    const maxKw = Math.max(...cars.flatMap((v) => v.schedule.map((s) => s.kw)), 1);
    const band = `<rect class="ev-window" x="${x(win)}" y="${top - 16}" width="${colW}" height="${rowH * cars.length + 16}" rx="4"/><text class="ev-window-label" x="${x(win) + colW / 2}" y="${top - 5}" text-anchor="middle">renewable</text>`;
    const rows = cars.map((v, i) => {
      const y = top + i * rowH, from = Math.max(0, minute(v.arriveAt)), to = Math.min(slots, minute(v.departAt));
      const plug = `<rect class="ev-plug" x="${x(from)}" y="${y + rowH * 0.3}" width="${Math.max(0, x(to) - x(from))}" height="${rowH * 0.4}" rx="${rowH * 0.2}"/>`;
      const bars = v.schedule.filter((s) => s.kw > 0 && s.slot < slots * Math.min(1, reveal * 1.25)).map((s) => {
        const hgt = Math.max(3, (rowH - 4) * (0.35 + 0.65 * s.kw / maxKw));
        return `<rect class="ev-charge ${s.inWindow ? 'is-window' : ''}" x="${x(s.slot) + 1}" y="${y + (rowH - hgt) / 2}" width="${colW - 2}" height="${hgt}" rx="2.5"><title>${escapeHtml(`${v.id} · ${modelTime(evSlotTime(plan, s.slot))} · ${n(s.kw)} kW · ${n(s.gridKwh)} kWh from the grid`)}</title></rect>`;
      }).join('');
      const got = `${n(Math.round(v.deliveredKwh * 10) / 10)}/${n(v.requiredKwh)} kWh`;
      return `<g class="ev-row${v.met ? '' : ' is-missed'}"><text class="ev-id" x="${left - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${escapeHtml(v.id)}</text>${plug}${bars}<text class="ev-got" x="${w - right + 8}" y="${y + rowH / 2 + 4}">${v.met ? '✓' : '✗'} ${got}</text></g>`;
    }).join('');
    const ticks = Array.from({ length: slots / 2 + 1 }, (_, k) => k * 2).map((slot) => `<text class="ev-tick" x="${x(slot)}" y="${h - 6}" text-anchor="middle">${escapeHtml(modelTime(evSlotTime(plan, slot)))}</text>`).join('');
    const grid = Array.from({ length: slots + 1 }, (_, k) => `<line class="ev-grid" x1="${x(k)}" x2="${x(k)}" y1="${top}" y2="${top + rowH * cars.length}"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${band}${grid}${rows}${ticks}</svg>`;
  },
};
function evViewToggle() {
  return `<div class="ev-toggle" role="group" aria-label="Plan shown">${EV_VIEWS.map(([id, label]) => `<button type="button" data-ev-view="${id}" aria-pressed="${evView === id}" class="${evView === id ? 'is-on' : ''}">${label}</button>`).join('')}</div>`;
}
function evTimelineCard(plan, alt) {
  const sub = `${n(alt[evView].vehicles.length)} simulated EVs · renewable half-hour ${escapeHtml(modelTime(alt.window.startAt))}–${escapeHtml(modelTime(alt.window.endAt))} · +${alt.horizonMinutes} min forecast`;
  return `<section class="dash-card cg-card ev-timeline">${cgHead('green', 'calendar', 'Charging timeline', sub, evViewToggle())}
    <ul class="cg-legend ev-legend"><li><i class="ev-key-plug"></i>Plugged in</li><li><i class="ev-key-grid"></i>Charging</li><li><i class="ev-key-window"></i>Charging in the renewable half-hour</li><li><b>✓/✗</b> fully charged by departure</li></ul>
    ${chartSlot('evTimeline', `${EV_VIEWS.find(([id]) => id === evView)[1]} plan: when each simulated EV is plugged in and charging`, 'ev-timeline-chart')}</section>`;
}

// ---------- normal vs optimised ----------
function evCompareRow(label, normal, optimised, format, max, better) {
  const width = (v) => `${max > 0 ? Math.min(100, (v / max) * 100).toFixed(1) : 0}%`;
  return `<div class="ev-compare-row"><span>${label}</span>
    <div class="ev-compare-bar is-normal"><i style="width:${width(normal)}"></i><b>${format(normal)}</b></div>
    <div class="ev-compare-bar is-optimised ${better ? 'is-better' : ''}"><i style="width:${width(optimised)}"></i><b>${format(optimised)}</b></div></div>`;
}
function evCompareCard(plan, alt) {
  const b = alt.baseline, o = alt.optimized, imp = alt.improvement, cars = o.vehicles.length;
  const headline = imp.improved
    ? `<strong>+${evKwh(imp.claimedKwh)}</strong> more charging in the renewable half-hour (+${n(Math.round(imp.claimedPercent * 10) / 10)}%)`
    : '<strong>No extra renewable charging</strong>: the chargers and site limits are already full in that half-hour';
  const fewer = o.vehiclesMet < b.vehiclesMet
    ? `<p class="ev-warn">${icon('pulse', 14)}<span>Trade-off: ${n(b.vehiclesMet - o.vehiclesMet)} fewer ${b.vehiclesMet - o.vehiclesMet === 1 ? 'car is' : 'cars are'} fully charged than with normal charging, because the shared half-hour spreads the energy across more cars.</span></p>` : '';
  const why = [...new Map(o.window.limitedBy.map((r) => [r.message, r])).values()];
  const whyList = why.length
    ? `<ul class="ev-why">${why.map((r) => `<li>${icon('pulse', 14)}<span>${escapeHtml(r.message)}</span></li>`).join('')}</ul>`
    : '<p class="ev-why-none">Nothing limited the plan in that half-hour.</p>';
  return `<section class="dash-card cg-card ev-compare">${cgHead('green', 'swap', 'Normal vs optimised', 'Same cars, chargers and deadlines · simulated')}
    <p class="ev-headline">${headline}</p>${fewer}
    <div class="ev-compare-legend"><span><i class="is-normal"></i>Normal: charge on arrival</span><span><i class="is-optimised"></i>Optimised: share the renewable half-hour</span></div>
    ${evCompareRow('Charged in the renewable half-hour', b.window.chargedKwh, o.window.chargedKwh, evKwh, Math.max(b.window.chargedKwh, o.window.chargedKwh), o.window.chargedKwh > b.window.chargedKwh)}
    ${evCompareRow('Cars fully charged', b.vehiclesMet, o.vehiclesMet, (v) => `${n(Math.round(v))} of ${n(cars)}`, cars, o.vehiclesMet > b.vehiclesMet)}
    ${evCompareRow('Charge still missing', b.unmetKwh, o.unmetKwh, evKwh, Math.max(b.unmetKwh, o.unmetKwh, 1), o.unmetKwh < b.unmetKwh)}
    <h3 class="ev-why-title">Why not more?</h3>${whyList}</section>`;
}

// ---------- cars that miss their charge ----------
function evMissedCard(plan, alt) {
  const run = alt[evView], missed = run.vehicles.filter((v) => !v.met);
  const body = missed.length
    ? `<ol class="ev-missed">${missed.map((v) => `<li><b>${escapeHtml(v.id)}</b><span class="ev-missed-site">${escapeHtml(evSiteName(plan, v.site))} · ${escapeHtml(modelTime(v.arriveAt))}–${escapeHtml(modelTime(v.departAt))}</span><span class="ev-missed-gap">${evKwh(v.unmetKwh)} short</span><p>${escapeHtml(v.limitingReason?.message || 'Not enough time or power before it leaves.')}</p></li>`).join('')}</ol>`
    : `<div class="ev-all-good">${icon('check', 22)}<b>All ${n(run.vehicles.length)} cars are fully charged by departure.</b></div>`;
  return `<section class="dash-card cg-card ev-missed-card">${cgHead('green', 'clock', 'Cars that miss their charge', `${EV_VIEWS.find(([id]) => id === evView)[1]} plan · ${n(missed.length)} of ${n(run.vehicles.length)} cars`)}${body}</section>`;
}

// ---------- page ----------
function evPage() {
  const plan = modelState.plan, alt = planAlternative();
  const picker = `<div class="ev-toolbar">${presetPicker()}<em class="ev-sim">Simulated fleet · plans are recommendations, no charger is controlled</em></div>`;
  if (!alt) return `${picker}<section class="dash-card cg-card ev-wait">${planPlaceholder('EV charging plan')}</section>`;
  const foot = `<p class="studio-provenance"><span class="cg-source">${escapeHtml(plan.dataMode === 'simulated' ? 'Example data' : 'Historical dataset prediction')}</span> ${escapeHtml(plan.fleet.fixture)} · solver ${escapeHtml(plan.solver.id)} · ${escapeHtml(plan.status)} · Window energy is a projection, not measured recovery · no charger is controlled.</p>`;
  return `${picker}${evKpis(plan, alt)}<div class="ev-main">${evTimelineCard(plan, alt)}<div class="ev-side">${evCompareCard(plan, alt)}${evMissedCard(plan, alt)}</div></div>${foot}`;
}
function renderCharging() {
  return studioShell('EV', 'Which simulated EVs charge when, and how much of it uses renewable energy at risk.', evPage);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ev-view]');
  if (!button) return;
  evView = EV_VIEWS.some(([id]) => id === button.dataset.evView) ? button.dataset.evView : 'optimized';
  render();
});
