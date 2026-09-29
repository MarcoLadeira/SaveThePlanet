// EV page: which simulated EVs charge when, and how much of it uses the forecast renewable half-hour.
// Loaded after charging.js and bridge.js; charging.js's renderCharging draws this page. It reuses the
// Charging page's card helpers and the SaveThePlanet Rewards card (dwCard) from charging.js.
// Every figure comes from the energy bridge (POST /api/v1/charging/optimize, loaded by bridge.js into
// modelState.plan for the pinned half-hour and the chosen fleet); nothing is recomputed here.

let evView = 'optimized';
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
// ---------- "When the cars charge": kWh per half-hour, both plans side by side ----------
// A simpler reading of the same plan: for each half-hour, how much the whole fleet charges with each plan
// (siteLoad kW x 0.5 h, summed over sites). The renewable window is the highlighted column.
let evDetail = false;
function evSlotKwh(run, slots) {
  const kwh = Array(slots).fill(0);
  run.siteLoad.forEach((l) => { if (l.slot < slots) kwh[l.slot] += l.kw * 0.5; });
  return kwh;
}
dashCharts.evBars = {
  values() {
    const plan = modelState.plan, alt = planAlternative();
    if (!alt) return { a: [], b: [], key: '' };
    const slots = plan.fleet.planSlots;
    return { a: evSlotKwh(alt.baseline, slots), b: evSlotKwh(alt.optimized, slots), key: String(plan.id) };
  },
  start: (t) => ({ ...t, a: t.a.map(() => 0), b: t.b.map(() => 0) }),
  draw({ a, b }) {
    const plan = modelState.plan, alt = planAlternative();
    if (!alt || !a.length) return '';
    const win = alt.window.slot;
    let last = a.length - 1;
    while (last > win + 1 && a[last] < 0.05 && b[last] < 0.05) last--;
    const n2 = last + 1, w = 700, h = 250, left = 44, right = 8, top = 46, bottom = 30;
    const max = chartNiceMax(Math.max(...a, ...b, 1)), colW = (w - left - right) / n2, bw = Math.min(22, colW * 0.34);
    const y = (v) => top + (h - top - bottom) * (1 - v / max), x0 = (i) => left + colW * i;
    const grid = [0, 0.5, 1].map((f) => `<line class="ev-bars-grid" x1="${left}" x2="${w - right}" y1="${y(max * f)}" y2="${y(max * f)}"/><text class="ev-bars-axis" x="${left - 6}" y="${y(max * f) + 4}" text-anchor="end">${n(max * f)}</text>`).join('');
    // The green column is only one half-hour wide, so its label sits in its own box above it (sized to the
    // text, kept inside the chart) with a small pointer down to the column.
    const cx = x0(win) + colW / 2, labelW = 150, labelX = Math.min(Math.max(cx - labelW / 2, left), w - right - labelW);
    const band = `<rect class="ev-bars-window" x="${x0(win) + 2}" y="${top}" width="${colW - 4}" height="${h - bottom - top}" rx="6"/>
      <rect class="ev-bars-window-tag" x="${labelX}" y="2" width="${labelW}" height="36" rx="8"/>
      <path class="ev-bars-window-tag" d="M${cx - 6} 37 L${cx} ${top - 2} L${cx + 6} 37 Z"/>
      <text class="ev-bars-window-label" x="${labelX + labelW / 2}" y="17" text-anchor="middle">Renewable window</text>
      <text class="ev-bars-window-value" x="${labelX + labelW / 2}" y="32" text-anchor="middle">${n(Math.round(a[win] * 10) / 10)} → ${n(Math.round(b[win] * 10) / 10)} kWh</text>`;
    const bars = a.slice(0, n2).map((va, i) => {
      const vb = b[i], cx = x0(i) + colW / 2, isWin = i === win;
      const bar = (v, x, cls) => v > 0.05 ? `<rect class="${cls}" x="${x}" y="${y(v)}" width="${bw}" height="${h - bottom - y(v)}" rx="3"><title>${escapeHtml(`${modelTime(evSlotTime(plan, i))}: ${n(Math.round(v * 10) / 10)} kWh`)}</title></rect>` : '';
      return bar(va, cx - bw - 1.5, 'ev-bar-arrival') + bar(vb, cx + 1.5, `ev-bar-smart${isWin ? ' is-window' : ''}`);
    }).join('');
    const ticks = Array.from({ length: n2 }, (_, i) => i).filter((i) => i % 2 === 0 || i === win).map((i) => `<text class="ev-bars-axis${i === win ? ' is-window' : ''}" x="${x0(i) + colW / 2}" y="${h - 10}" text-anchor="middle">${escapeHtml(modelTime(evSlotTime(plan, i)))}</text>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${grid}${band}${bars}${ticks}<text class="ev-bars-axis" x="0" y="${top - 18}">kWh</text></svg>`;
  },
};
function evReadyRow(label, run) {
  const cars = run.vehicles.map((v) => `<i class="${v.met ? 'is-ready' : 'is-short'}" title="${escapeHtml(`${v.id}: ${v.met ? 'ready' : `${n(Math.round(v.unmetKwh * 10) / 10)} kWh short`}`)}">${icon('car', 14)}</i>`).join('');
  return `<div class="ev-ready-row"><span>${label}</span><div class="ev-ready-cars">${cars}</div><b>${n(run.vehiclesMet)} of ${n(run.vehicles.length)} ready</b></div>`;
}
function evTimelineCard(plan, alt) {
  const toggle = `<button type="button" class="ev-detail-btn" data-ev-detail>${evDetail ? 'Back to summary' : 'See each car'}</button>`;
  if (evDetail) {
    const run = alt[evView], inWindow = run.vehicles.filter((v) => v.schedule.some((s) => s.inWindow && s.kw > 0)).length;
    const how = evView === 'optimized' ? 'The smart plan moves charging into the green renewable window when it can.' : 'Each car starts charging as soon as it plugs in.';
    return `<section class="dash-card cg-card ev-timeline">${cgHead('green', 'calendar', 'Each car', `${n(inWindow)} of ${n(run.vehicles.length)} cars charge in the renewable window`, `<div class="ev-head-actions">${evViewToggle()}${toggle}</div>`)}
      <p class="ev-how">${how} <span class="ev-keys"><span><i class="ev-key-plug"></i>plugged in</span><span><i class="ev-key-grid"></i>charging</span><span><i class="ev-key-window"></i>charging on renewable energy</span></span></p>
      ${chartSlot('evTimeline', `${EV_VIEWS.find(([id]) => id === evView)[1]}: when each simulated car is plugged in and charging, and whether it is ready when it leaves`, 'ev-timeline-chart')}${evMissed(plan, alt)}</section>`;
  }
  const b = alt.baseline, o = alt.optimized;
  return `<section class="dash-card cg-card ev-timeline">${cgHead('green', 'calendar', 'When the cars charge', 'How much the whole fleet charges in each half-hour', toggle)}
    <p class="ev-how"><span><b>Green column</b> = the half-hour when wind and solar would otherwise be wasted. The taller the smart-plan bar there, the more charging runs on that clean energy.</span></p>
    <p class="ev-keys"><span><i class="ev-key-arrival"></i>Charge on arrival (normal)</span><span><i class="ev-key-smart"></i>Smart plan</span><span><i class="ev-key-window"></i>Smart plan in the renewable window</span></p>
    ${chartSlot('evBars', `kWh charged in each half-hour: ${n(b.window.chargedKwh)} kWh with charging on arrival and ${n(o.window.chargedKwh)} kWh with the smart plan in the renewable window`, 'ev-bars-chart')}
    <div class="ev-ready">${evReadyRow('Charge on arrival', b)}${evReadyRow('Smart plan', o)}</div></section>`;
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
  return studioShell('EV', 'Which simulated EVs charge when, and how much of it uses renewable energy at risk.', evPage);
}

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-ev-detail]')) { evDetail = !evDetail; render(); return; }
  const button = event.target.closest('[data-ev-view]');
  if (!button) return;
  evView = EV_VIEWS.some(([id]) => id === button.dataset.evView) ? button.dataset.evView : 'optimized';
  render();
});
