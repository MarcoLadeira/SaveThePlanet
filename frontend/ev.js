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
let evDetail = false; // "See each car": the per-car timeline instead of the day chart

// ---------- "Cars that can charge through the day" (in the style of the Forecast page's day chart) ----------
// For each half-hour of the replayed day, the +30 min forecast of energy at risk turned into potential full
// EV charges on the server (dayplan.py: kWh x charging efficiency / 70 kWh). An energy equivalent, not a
// count of cars actually charged. The same forecast line as the Forecast page, in cars instead of MWh.
function evDaySeries() {
  if (!dayPlanReady()) return null;
  const list = dayPlan.data.intervals;
  return { cars: list.map((i) => i.potentialFullCharges ?? 0), mwh: list.map((i) => i.atRiskMwh), times: list.map((i) => i.targetAt) };
}
function evNiceMax(v) {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => v / s <= 4) || Math.ceil(v / 4);
  return { max: Math.max(step, Math.ceil(v / step) * step), step };
}
function evSelectedSlot(times) {
  const alt = planAlternative(), at = alt && new Date(alt.window.startAt).getTime();
  return at ? times.findIndex((t) => new Date(t).getTime() === at) : -1;
}
dashCharts.evDay = {
  values() {
    const d = evDaySeries();
    if (!d) return { cars: [], axis: '1|1', sel: '-1', reveal: 0 };
    const { max, step } = evNiceMax(Math.max(...d.cars, 1));
    return { cars: d.cars, axis: `${max}|${step}`, sel: String(evSelectedSlot(d.times)), reveal: 1 };
  },
  start: (t) => ({ ...t, reveal: 0 }),
  draw({ cars, axis, sel, reveal }) {
    if (!cars.length) return '';
    const [max, step] = axis.split('|').map(Number), d = evDaySeries(), last = cars.length - 1;
    const W = 1000, H = 300, X = (i) => (i / last) * W, Y = (v) => H - (Math.max(0, v) / max) * H;
    const xp = (i) => `${((i / last) * 100).toFixed(3)}%`, yp = (v) => `${((1 - Math.max(0, v) / max) * 100).toFixed(3)}%`;
    const pts = cars.map((v, i) => [X(i), Y(v)]), line = fxSmooth(pts), area = `${line} L${W} ${H} L0 ${H}Z`;
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => `<span class="ev-day-tick" style="bottom:${((i * step) / max) * 100}%"><b>${n(i * step)}</b></span>`).join('');
    const hours = [0, 8, 16, 24, 32, 40, last].map((i) => `<span style="left:${xp(i)}">${escapeHtml(modelTime(d.times[i]))}</span>`).join('');
    const s = Number(sel), peak = cars.indexOf(Math.max(...cars));
    const marker = s >= 0 && reveal > 0.97 ? `<span class="ev-day-sel" style="left:${xp(s)}"><em>${escapeHtml(modelTime(d.times[s]))} · ${n(Math.round(cars[s]))} cars</em></span><i class="ev-day-dot" style="left:${xp(s)};top:${yp(cars[s])}"></i>` : '';
    const label = reveal > 0.97 ? `<span class="ev-day-direct" style="top:${yp(cars[last])}">Predicted +30</span>` : '';
    return `<div class="ev-day"><div class="ev-day-grid">${ticks}</div><div class="ev-day-area">${label}
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs>
        <linearGradient id="ev-day-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ev-day-top"/><stop offset="1" class="ev-day-bottom"/></linearGradient>
        <clipPath id="ev-day-clip"><rect x="-10" y="-40" width="${(W * reveal + 10).toFixed(1)}" height="${H + 80}"/></clipPath></defs>
        <g clip-path="url(#ev-day-clip)"><path class="ev-day-fill" d="${area}"/><path class="ev-day-edge" d="${line}"/><path class="ev-day-line" d="${line}"/></g></svg>
      ${marker}${peak >= 0 && cars[peak] > 0 && reveal > 0.97 && Math.abs(peak - s) > 3 ? `<span class="ev-day-peak" style="left:${xp(peak)};top:${yp(cars[peak])}">Most: ${n(Math.round(cars[peak]))}</span>` : ''}
      </div><div class="ev-day-x">${hours}</div></div>`;
  },
};
function evTimelineCard(plan, alt) {
  const toggle = `<button type="button" class="ev-detail-btn" data-ev-detail>${evDetail ? 'Back to the day' : 'See each car'}</button>`;
  if (evDetail) {
    const run = alt[evView], inWindow = run.vehicles.filter((v) => v.schedule.some((s) => s.inWindow && s.kw > 0)).length;
    const how = evView === 'optimized' ? 'The smart plan moves charging into the green renewable window when it can.' : 'Each car starts charging as soon as it plugs in.';
    return `<section class="dash-card cg-card ev-timeline">${cgHead('green', 'calendar', 'Each car', `${n(inWindow)} of ${n(run.vehicles.length)} cars charge in the renewable window`, `<div class="ev-head-actions">${evViewToggle()}${toggle}</div>`)}
      <p class="ev-how">${how} <span class="ev-keys"><span><i class="ev-key-plug"></i>plugged in</span><span><i class="ev-key-grid"></i>charging</span><span><i class="ev-key-window"></i>charging on renewable energy</span></span></p>
      ${chartSlot('evTimeline', `${EV_VIEWS.find(([id]) => id === evView)[1]}: when each simulated car is plugged in and charging, and whether it is ready when it leaves`, 'ev-timeline-chart')}${evMissed(plan, alt)}</section>`;
  }
  const d = evDaySeries(), day = d ? new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${dayPlan.data.date}T00:00:00Z`)).replace(',', '') : '';
  const head = cgHead('green', 'car', 'Cars that can charge through the day', `Potential full EV charges per half-hour from the +30 min forecast${day ? ` · ${escapeHtml(day)}` : ''}`, toggle);
  if (!d) {
    const failed = dayPlan.status === 'error' && dayPlan.key === dayPlanKey();
    return `<section class="dash-card cg-card ev-timeline">${head}${failed
      ? '<div class="cg-empty" role="status"><span>The replayed day needs the forecast model, so this chart is unavailable. “See each car” still shows the selected half-hour.</span></div>'
      : '<div class="cg-skeleton" role="status"><i></i><span>Replaying the day…</span></div>'}</section>`;
  }
  const peak = Math.max(...d.cars), peakAt = d.times[d.cars.indexOf(peak)], total = dayPlan.data.totals.potentialFullCharges ?? d.cars.reduce((a, b) => a + b, 0);
  const ref = dayPlan.data.evEquivalent?.referenceBatteryKwh || 70;
  return `<section class="dash-card cg-card ev-timeline">${head}
    <div class="ev-day-stats">
      <div class="ev-day-stat"><strong>${n(Math.round(total))}</strong><span>cars could charge<br>across the day</span></div>
      <div class="ev-day-stat is-peak"><strong>${n(Math.round(peak))}</strong><span>cars in the best half-hour<br>at <b>${escapeHtml(modelTime(peakAt))}</b></span></div>
    </div>
    <ul class="cg-legend ev-day-legend"><li><i class="ev-key-pred"></i>Predicted (+30 min) → cars that can charge</li>${evSelectedSlot(d.times) >= 0 ? '<li><i class="ev-key-sel"></i>Your half-hour</li>' : ''}</ul>
    <div class="ev-day-plot" data-ev-day-plot>${chartSlot('evDay', `Potential full EV charges in each half-hour of ${day}, from the +30 minute forecast. Most: ${Math.round(peak)} at ${modelTime(peakAt)}.`, 'ev-day-chart')}<div class="ev-day-tip" hidden></div></div>
    <p class="ev-day-note">1 car = one ${n(ref)} kWh battery charged from empty to full with the forecast energy at risk (after 10% charging loss). An estimate, not cars actually charged.</p></section>`;
}
// Hover: the half-hour under the pointer, its forecast and cars.
document.addEventListener('pointermove', (event) => {
  const plot = event.target.closest?.('[data-ev-day-plot]'), d = evDaySeries();
  if (!plot || !d) return;
  const area = plot.querySelector('.ev-day-area'), tip = plot.querySelector('.ev-day-tip');
  if (!area || !tip) return;
  const box = area.getBoundingClientRect(), f = (event.clientX - box.left) / box.width;
  if (f < 0 || f > 1) { tip.hidden = true; return; }
  const i = Math.round(f * (d.cars.length - 1));
  tip.hidden = false;
  tip.style.left = `${(box.left - plot.getBoundingClientRect().left) + (i / (d.cars.length - 1)) * box.width}px`;
  tip.classList.toggle('is-left', f > 0.6);
  tip.innerHTML = `<b>${escapeHtml(modelTime(d.times[i]))} half-hour</b><span>${n(Math.round(d.mwh[i] * 100) / 100)} MWh predicted (+30 min)</span><span><strong>${n(Math.round(d.cars[i] * 10) / 10)}</strong> cars could charge fully</span>`;
});
document.addEventListener('pointerleave', (event) => {
  if (!event.target.matches?.('[data-ev-day-plot]')) return;
  const tip = event.target.querySelector('.ev-day-tip');
  if (tip) tip.hidden = true;
}, true);

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
  ensureDayPlan(); // the replayed day behind "Cars that can charge through the day"
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
