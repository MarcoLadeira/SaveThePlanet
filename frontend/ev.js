// EV page: which simulated EVs charge when, and how much of it uses the forecast renewable half-hour.
// Loaded after charging.js and bridge.js. The EV page opens on the existing Energy & Rewards screen
// (charging.js); this file draws the "Compare charging plans" view it switches to.
// Every figure comes from the energy bridge (POST /api/v1/charging/optimize, loaded by bridge.js into
// modelState.plan for the pinned half-hour and the chosen fleet); nothing is recomputed here.

let evMode = 'current'; // Energy & Rewards (charging.js) stays the default view.
let evView = 'optimized';
function evModeToggle() {
  return `<div class="ev-toggle ev-mode-toggle" role="group" aria-label="EV page view"><button type="button" data-ev-mode="current" aria-pressed="${evMode === 'current'}" class="${evMode === 'current' ? 'is-on' : ''}">Energy & Rewards</button><button type="button" data-ev-mode="comparison" aria-pressed="${evMode === 'comparison'}" class="${evMode === 'comparison' ? 'is-on' : ''}">Compare charging plans</button></div>`;
}
// Plain names: the backend's baseline charges each car on arrival; the optimised plan shares the renewable window.
const EV_VIEWS = [['baseline', 'Charge on arrival'], ['optimized', 'Smart plan']];

const evKwh = (value) => `${n(Math.round(value * 10) / 10)} kWh`;
function evSlotTime(plan, slot) {
  return new Date(new Date(plan.forecast.planStartAt).getTime() + slot * 30 * 60000).toISOString();
}
const evPlain = (text) => String(text).replace(/ \(hypothetical\)/g, '');
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
    ${evKpi('green', 'car', 'Cars fully charged', `${n(o.vehiclesMet)}`, `of ${n(total)}`, `<span class="cg-pill is-share">${n(b.vehiclesMet)}</span>`, 'if they charge on arrival')}
    ${evKpi('green', 'leaf', 'Charged on renewable energy', n(Math.round(o.window.chargedKwh * 10) / 10), 'kWh', gain, `vs ${n(Math.round(b.window.chargedKwh * 10) / 10)} on arrival`)}
    ${evKpi('orange', 'charge', 'Into EV batteries', n(Math.round(L.batteryDeliveredKwh * 10) / 10), 'kWh', `<span class="cg-pill is-share">≈ ${n(Math.round(planImpact(L).rangeKm))} km</span>`, 'of driving')}
    ${evKpi('purple', 'battery', 'Charge still missing', n(Math.round(o.unmetKwh * 10) / 10), 'kWh', `<span class="cg-pill ${o.vehiclesMissed ? 'is-down' : 'is-share'}">${n(o.vehiclesMissed)}</span>`, o.vehiclesMissed === 1 ? 'car leaves short' : 'cars leave short')}
  </section>`;
}

// ---------- charging timeline (one row per EV) ----------
// One row per car: a light bar while it is plugged in, a block for each half-hour it charges (green when that
// half-hour is the renewable window), and a Ready / Short tag at the end.
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
    const w = 700, left = 56, right = 116, top = 34, rowH = Math.max(14, Math.min(24, 390 / cars.length)), h = top + rowH * cars.length + 22;
    const colW = (w - left - right) / slots, x = (slot) => left + colW * slot;
    const at = (iso) => (new Date(iso) - new Date(plan.forecast.planStartAt)) / 60000 / 30;
    const block = Math.min(rowH - 5, 13);
    const band = `<rect class="ev-window" x="${x(win)}" y="${top - 8}" width="${colW}" height="${rowH * cars.length + 8}" rx="5"/>
      <text class="ev-window-label" x="${x(win) + colW / 2}" y="${top - 21}" text-anchor="middle">Renewable window</text>
      <text class="ev-window-time" x="${x(win) + colW / 2}" y="${top - 7}" text-anchor="middle">${escapeHtml(modelTime(alt.window.startAt))}–${escapeHtml(modelTime(alt.window.endAt))}</text>`;
    const rows = cars.map((v, i) => {
      const y = top + i * rowH, mid = y + rowH / 2, from = Math.max(0, at(v.arriveAt)), to = Math.min(slots, at(v.departAt));
      const plug = `<rect class="ev-plug" x="${x(from)}" y="${mid - 3}" width="${Math.max(0, x(to) - x(from))}" height="6" rx="3"><title>${escapeHtml(`${v.id} plugged in ${modelTime(v.arriveAt)}–${modelTime(v.departAt)}`)}</title></rect>`;
      const blocks = v.schedule.filter((s) => s.kw > 0 && s.slot < slots * Math.min(1, reveal * 1.25)).map((s) =>
        `<rect class="ev-charge ${s.inWindow ? 'is-window' : ''}" x="${x(s.slot) + 1.5}" y="${mid - block / 2}" width="${colW - 3}" height="${block}" rx="3"><title>${escapeHtml(`${v.id} · ${modelTime(evSlotTime(plan, s.slot))} · ${n(s.gridKwh)} kWh${s.inWindow ? ' on renewable energy' : ''}`)}</title></rect>`).join('');
      const tag = v.met
        ? `<rect class="ev-tag is-ready" x="${w - right + 10}" y="${mid - 9}" width="64" height="18" rx="9"/><text class="ev-tag-text is-ready" x="${w - right + 42}" y="${mid + 4}" text-anchor="middle">✓ Ready</text>`
        : `<rect class="ev-tag is-short" x="${w - right + 10}" y="${mid - 9}" width="${right - 12}" height="18" rx="9"/><text class="ev-tag-text is-short" x="${w - right + 10 + (right - 12) / 2}" y="${mid + 4}" text-anchor="middle">Short ${n(Math.round(v.unmetKwh * 10) / 10)} kWh</text>`;
      return `<g class="ev-row${v.met ? '' : ' is-missed'}"><text class="ev-id" x="${left - 8}" y="${mid + 4}" text-anchor="end">${escapeHtml(v.id)}</text>${plug}${blocks}${tag}</g>`;
    }).join('');
    const ticks = Array.from({ length: Math.floor(slots / 4) + 1 }, (_, k) => k * 4).map((slot) => `<text class="ev-tick" x="${x(slot)}" y="${h - 6}" text-anchor="middle">${escapeHtml(modelTime(evSlotTime(plan, slot)))}</text>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${band}${rows}${ticks}</svg>`;
  },
};
function evViewToggle() {
  return `<div class="ev-toggle" role="group" aria-label="Plan shown">${EV_VIEWS.map(([id, label]) => `<button type="button" data-ev-view="${id}" aria-pressed="${evView === id}" class="${evView === id ? 'is-on' : ''}">${label}</button>`).join('')}</div>`;
}
function evTimelineCard(plan, alt) {
  const run = alt[evView], inWindow = run.vehicles.filter((v) => v.schedule.some((s) => s.inWindow && s.kw > 0)).length;
  const how = evView === 'optimized' ? 'The smart plan moves charging into the green renewable window when it can.' : 'Each car starts charging as soon as it plugs in.';
  return `<section class="dash-card cg-card ev-timeline">${cgHead('green', 'calendar', 'Charging timeline', `When each car charges · ${n(inWindow)} of ${n(run.vehicles.length)} use the renewable window`, evViewToggle())}
    <p class="ev-how">${how} <span class="ev-keys"><span><i class="ev-key-plug"></i>plugged in</span><span><i class="ev-key-grid"></i>charging</span><span><i class="ev-key-window"></i>charging on renewable energy</span></span></p>
    ${chartSlot('evTimeline', `${EV_VIEWS.find(([id]) => id === evView)[1]}: when each simulated car is plugged in and charging, and whether it is ready when it leaves`, 'ev-timeline-chart')}${evMissed(plan, alt)}</section>`;
}

// ---------- charge on arrival vs smart plan ----------
function evCompareCard(plan, alt) {
  const b = alt.baseline, o = alt.optimized, imp = alt.improvement, cars = o.vehicles.length, extra = evKwh(imp.claimedKwh);
  const lost = b.vehiclesMet - o.vehiclesMet, carWord = (k) => (k === 1 ? 'car' : 'cars');
  let verdict, tone = 'is-good';
  if (imp.improved && lost <= 0) verdict = `The smart plan charges <b>${extra} more on renewable energy</b> (+${n(Math.round(imp.claimedPercent * 10) / 10)}%)${lost < 0 ? ` and gets ${n(-lost)} more ${carWord(-lost)} ready` : ', and every car is still ready on time'}.`;
  else if (imp.improved) { verdict = `The smart plan charges <b>${extra} more on renewable energy</b>, but <b>${n(lost)} fewer ${carWord(lost)}</b> ${lost === 1 ? 'is' : 'are'} ready on time.`; tone = 'is-mixed'; }
  else if (lost > 0) { verdict = `<b>Charging on arrival is better here</b>: the smart plan adds no renewable charging and ${n(lost)} fewer ${carWord(lost)} ${lost === 1 ? 'is' : 'are'} ready on time.`; tone = 'is-bad'; }
  else { verdict = '<b>No difference here</b>: the chargers are already full during the renewable window.'; tone = 'is-flat'; }
  const cell = (value, better, worse) => `<td class="${better ? 'is-better' : worse ? 'is-worse' : ''}">${value}${better ? ' ↑' : worse ? ' ↓' : ''}</td>`;
  const row = (label, before, after, format, higherIsBetter) => {
    const better = higherIsBetter ? after > before + 1e-9 : after < before - 1e-9, worse = higherIsBetter ? after < before - 1e-9 : after > before + 1e-9;
    return `<tr><th scope="row">${label}</th><td>${format(before)}</td>${cell(format(after), better, worse)}</tr>`;
  };
  const limits = [...new Set(o.window.limitedBy.map((r) => evPlain(r.message)))];
  return `<section class="dash-card cg-card ev-compare">${cgHead('green', 'swap', 'Charge on arrival vs smart plan', 'Same cars, chargers and leaving times · simulated')}
    <p class="ev-verdict ${tone}">${verdict}</p>
    <table class="ev-table"><thead><tr><th></th><th scope="col">Charge on arrival</th><th scope="col">Smart plan</th></tr></thead><tbody>
      ${row('Charged on renewable energy', b.window.chargedKwh, o.window.chargedKwh, evKwh, true)}
      ${row('Cars ready on time', b.vehiclesMet, o.vehiclesMet, (v) => `${n(Math.round(v))} of ${n(cars)}`, true)}
      ${row('Charge still missing', b.unmetKwh, o.unmetKwh, evKwh, false)}
    </tbody></table>
    <p class="ev-limit"><b>What limits it:</b> ${limits.length ? escapeHtml(limits.join(' ')) : 'nothing, the plan used everything it could.'}</p></section>`;
}

// ---------- cars that miss their charge (under the timeline) ----------
function evMissed(plan, alt) {
  const run = alt[evView], missed = run.vehicles.filter((v) => !v.met);
  if (!missed.length) return `<p class="ev-all-good">${icon('check', 18)}<b>All ${n(run.vehicles.length)} cars are ready when they leave.</b></p>`;
  return `<div class="ev-missed-box"><h3>Why ${n(missed.length)} of ${n(run.vehicles.length)} cars leave short</h3><ol class="ev-missed">${missed.map((v) => `<li><b>${escapeHtml(v.id)}</b><span class="ev-missed-gap">${evKwh(v.unmetKwh)} short</span><span class="ev-missed-why">${escapeHtml(v.limitingReason?.message || 'Not enough time or power before it leaves.')}</span></li>`).join('')}</ol></div>`;
}

// ---------- page ----------
function evPage() {
  const plan = modelState.plan, alt = planAlternative();
  const picker = `<div class="ev-toolbar">${presetPicker()}<em class="ev-sim">Simulated fleet · plans are recommendations, no charger is controlled</em></div>`;
  if (!alt) return `${picker}<section class="dash-card cg-card ev-wait">${planPlaceholder('EV charging plan')}</section>`;
  const foot = `<p class="studio-provenance"><span class="cg-source">${escapeHtml(plan.dataMode === 'simulated' ? 'Example data' : 'Historical dataset prediction')}</span> ${escapeHtml(plan.fleet.fixture)} · solver ${escapeHtml(plan.solver.id)} · ${escapeHtml(plan.status)} · Window energy is a projection, not measured recovery · no charger is controlled.</p>`;
  return `${picker}${evKpis(plan, alt)}<div class="ev-main">${evTimelineCard(plan, alt)}<div class="ev-side">${evCompareCard(plan, alt)}${dwCard()}</div></div>${foot}`;
}
function renderEvComparison() {
  return studioShell('EV', 'Which simulated EVs charge when, and how much of it uses renewable energy at risk.', () => `${evModeToggle()}${evPage()}`);
}

document.addEventListener('click', (event) => {
  const mode = event.target.closest('[data-ev-mode]');
  if (mode) {
    evMode = mode.dataset.evMode === 'comparison' ? 'comparison' : 'current';
    render();
    return;
  }
  const button = event.target.closest('[data-ev-view]');
  if (!button) return;
  evView = EV_VIEWS.some(([id]) => id === button.dataset.evView) ? button.dataset.evView : 'optimized';
  render();
});
