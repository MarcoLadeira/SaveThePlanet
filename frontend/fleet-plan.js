// Charging page: the fleet plan from POST /api/v1/charging/optimize (issue #39).
// A simulated fleet is scheduled against the server's own forecast. Everything shown here comes
// from that response: the page never computes plan figures itself. Loaded after charging.js.

const fpState = { preset: 'depot-and-retail', mode: 'expected', view: 'optimized', status: 'idle', data: null, error: '', key: '', request: 0 };
const FP_PRESETS = [['depot-and-retail', 'Depot and retail car park'], ['constrained-site', 'Constrained site']];
const FP_LIMITS = {
    'site-power': 'Site power limit', chargers: 'Not enough chargers', deadline: 'Leaves too soon',
    'not-connected': 'Not plugged in long enough', rate: 'Charging rate', vehicles: 'No more vehicles to charge',
    'forecast-window': 'All eligible forecast energy used', 'no-forecast': 'Nothing forecast at risk','outside-plan': 'No vehicles in the window', policy: 'Capacity left unused',
};

function fpKey() {
    const issued = modelState.data?.predictions?.[0]?.issuedAt || '';
    return [fpState.preset, fpState.mode, modelState.capacity, issued, modelState.data?.dataMode].join('|');
}
function fpEnsure() {
    if (!modelState.data || fpState.key === fpKey()) return;
    fpLoad();
}
async function fpLoad() {
    const request = ++fpState.request;
    fpState.key = fpKey();
    fpState.status = 'loading';
    try {
        const response = await fetch('/api/v1/charging/optimize', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preset: fpState.preset, uncertainty: fpState.mode, capacityMw: modelState.capacity }),
        });
        const body = await response.json();
        if (request !== fpState.request) return; // inputs changed while this was in flight
        if (!response.ok || !Array.isArray(body.alternatives)) throw new Error(body.error?.message || 'The fleet plan could not be calculated.');
        Object.assign(fpState, { status: 'ready', data: body, error: '' });
    } catch (error) {
        if (request === fpState.request) Object.assign(fpState, { status: 'error', error: error.message || 'The fleet plan could not be calculated.' });
    } finally {
        if (request === fpState.request) cgRerender();
    }
}

// ---------- formatting ----------
const fpKwh = (value) => `${n(Math.round(value * 10) / 10)} kWh`;
function fpClock(iso) {
    return escapeHtml(modelTime(iso));
}
function fpAlternative() {
    const list = fpState.data?.alternatives || [];
    return list.find((a) => a.horizonMinutes === modelState.horizon) || list[0];
}
function fpTags(d) {
    const forecast = d.forecast.fallback?.active ? '<span class="cg-tag is-demo">Example forecast</span>' : '<span class="cg-tag">Historical forecast</span>';
    return `<span class="cg-tag is-demo">Simulated fleet</span>${forecast}<span class="cg-tag">Projected, not measured</span>`;
}
function fpDelta(value, unit, better) {
    if (Math.abs(value) < 0.05) return '<span class="fp-delta">no change</span>';
    const good = better === 'up' ? value > 0 : value < 0;
    return `<span class="fp-delta ${good ? 'is-good' : 'is-bad'}">${value > 0 ? '+' : '−'}${n(Math.round(Math.abs(value) * 10) / 10)}${unit}</span>`;
}

// ---------- cards ----------
function fpControls() {
    const options = FP_PRESETS.map(([id, label]) => `<option value="${id}"${id === fpState.preset ? ' selected' : ''}>${label}</option>`).join('');
    const mode = (id, label) => `<button type="button" data-fp-mode="${id}" class="${fpState.mode === id ? 'active' : ''}" aria-pressed="${fpState.mode === id}">${label}</button>`;
    return `<div class="fp-controls"><label class="cg-select"><span class="sr-only">Simulated fleet</span><select id="fp-preset" aria-label="Simulated fleet">${options}</select></label>
        <div class="studio-segment fp-segment" role="group" aria-label="Forecast energy used">${mode('expected', 'Expected')}${mode('conservative', 'Conservative (P10)')}</div></div>`;
}
function fpRecommendation(d, alt) {
    const best = d.alternatives.find((a) => a.horizonMinutes === d.selectedHorizonMinutes);
    const o = best.optimized, total = o.vehiclesMet + o.vehiclesMissed;
    const nothing = d.alternatives.every((a) => a.opportunity.availableKwh <= 0);
    const headline = nothing
        ? 'No renewable energy is forecast to be wasted in either window, so there is nothing to move charging into. Charge as usual.'
        : o.window.claimedKwh > 0
            ? `Plan <b>${fpKwh(o.window.claimedKwh)}</b> of charging between <b>${fpClock(best.window.startAt)}–${fpClock(best.window.endAt)}</b>, when renewable energy is forecast to be wasted.`
            : 'None of this fleet\'s charging can be moved into a forecast window.';
    const vehicles = total ? `${o.vehiclesMet} of ${total} simulated vehicles fully charged by their departure.` : 'This fleet has no vehicles.';
    const other = nothing ? '' : alt.horizonMinutes !== best.horizonMinutes
        ? `<button type="button" class="fp-link" data-horizon="${best.horizonMinutes}">Show the recommended +${best.horizonMinutes} min plan</button>`
        : '<span class="fp-badge">Recommended window</span>';
    return `<div class="fp-reco"><p class="fp-headline">${headline}</p><p class="fp-sub">${vehicles}</p>${other}</div>`;
}
function fpAlternatives(d) {
    return `<div class="fp-alts" role="group" aria-label="Forecast window">${d.alternatives.map((a) => {
        const active = a.horizonMinutes === modelState.horizon;
        const rec = a.horizonMinutes === d.selectedHorizonMinutes && d.alternatives.some((x) => x.opportunity.availableKwh > 0);
        return `<button type="button" data-horizon="${a.horizonMinutes}" class="fp-alt${active ? ' is-active' : ''}" aria-pressed="${active}">
            <span>+${a.horizonMinutes} min · ${fpClock(a.window.startAt)}–${fpClock(a.window.endAt)}${rec ? ' <em>Recommended</em>' : ''}</span>
            <b>${fpKwh(a.optimized.window.claimedKwh)}</b><small>of ${fpKwh(a.opportunity.availableKwh)} forecast at risk</small></button>`;
    }).join('')}<p class="fp-note">Alternatives for the same fleet: pick one. Their energy is never added together.</p></div>`;
}
function fpCompare(alt) {
    const b = alt.baseline, o = alt.optimized, total = o.vehiclesMet + o.vehiclesMissed;
    const row = (label, before, after, delta) => `<tr><th scope="row">${label}</th><td>${before}</td><td>${after}</td><td>${delta}</td></tr>`;
    const siteName = (id) => fpState.data.fleet.sites.find((s) => s.id === id)?.name || id;
    const limits = o.window.limitedBy.map((l) => `<li><b>${escapeHtml(FP_LIMITS[l.code] || l.code)}</b>${l.site ? ` · ${escapeHtml(siteName(l.site))}` : ''}<small>${escapeHtml(l.message.replace(/^[^:]+:\s*/, ''))}</small></li>`).join('');
    const verdict = alt.improvement.improved
        ? `The optimized plan moves <b>${fpKwh(alt.improvement.claimedKwh)}</b> more charging into the window${alt.improvement.claimedPercent != null ? ` (+${n(Math.round(alt.improvement.claimedPercent))}%)` : ''}.`
        : 'No improvement over charging on arrival here: the limits below already bind.';
    return `<div class="fp-compare"><table class="fp-table"><caption class="sr-only">Baseline versus optimized plan for the +${alt.horizonMinutes} minute window</caption>
        <thead><tr><th></th><th scope="col">On arrival <small>baseline</small></th><th scope="col">Optimized</th><th scope="col">Change</th></tr></thead><tbody>
        ${row('Charging on forecast renewables', fpKwh(b.window.claimedKwh), fpKwh(o.window.claimedKwh), fpDelta(o.window.claimedKwh - b.window.claimedKwh, ' kWh', 'up'))}
        ${row('Vehicles fully charged', `${b.vehiclesMet} / ${total}`, `${o.vehiclesMet} / ${total}`, fpDelta(o.vehiclesMet - b.vehiclesMet, '', 'up'))}
        ${row('Charging still needed', fpKwh(b.unmetKwh), fpKwh(o.unmetKwh), fpDelta(o.unmetKwh - b.unmetKwh, ' kWh', 'down'))}
        </tbody></table><p class="fp-verdict">${verdict}</p><div class="fp-limits"><strong>Why not more in the window?</strong><ul>${limits}</ul></div></div>`;
}
function fpTimeline(alt) {
    const d = fpState.data, plan = fpState.view === 'baseline' ? alt.baseline : alt.optimized, slots = d.fleet.planSlots;
    if (!plan.vehicles.length) return '<div class="cg-empty" role="status">This fleet has no vehicles to schedule.</div>';
    const step = 30 * 60000, issued = new Date(d.forecast.issuedAt).getTime(), slotAt = (i) => new Date(issued + i * step).toISOString();
    const order = [...plan.vehicles].sort((a, b) => (a.met - b.met) || a.departAt.localeCompare(b.departAt) || a.id.localeCompare(b.id));
    const head = Array.from({ length: slots }, (_, i) => `<span class="fp-slot-head${i === alt.window.slot ? ' is-window' : ''}">${i % 2 === 0 || slots <= 10 ? fpClock(slotAt(i)) : ''}</span>`).join('');
    const rows = order.map((v) => {
        const bySlot = Object.fromEntries(v.schedule.map((s) => [s.slot, s]));
        const from = new Date(v.arriveAt).getTime(), to = new Date(v.departAt).getTime();
        const cells = Array.from({ length: slots }, (_, i) => {
            const start = issued + i * step, s = bySlot[i];
            const present = start >= from && start + step <= to;
            const cls = s ? (s.inWindow ? 'is-window-charge' : 'is-charge') : present ? 'is-idle' : 'is-away';
            const label = s ? `${n(s.kw)} kW, ${fpKwh(s.gridKwh)}${s.inWindow ? ' in the forecast window' : ''}` : present ? 'plugged in, not charging' : 'not plugged in';
            return `<span class="fp-cell ${cls}${i === alt.window.slot ? ' in-window' : ''}" title="${escapeHtml(`${v.id} ${modelTime(slotAt(i))}: ${label}`)}"></span>`;
        }).join('');
        const status = v.met ? `<span class="fp-met">✓ ${fpKwh(v.deliveredKwh)}</span>` : `<span class="fp-miss" title="${escapeHtml(v.limitingReason.message)}">${fpKwh(v.unmetKwh)} short · ${escapeHtml(FP_LIMITS[v.limitingReason.code] || v.limitingReason.code)}</span>`;
        return `<div class="fp-row${v.met ? '' : ' is-missed'}"><span class="fp-ev"><b>${escapeHtml(v.id)}</b><small>${escapeHtml(v.site)} · leaves ${fpClock(v.departAt)}</small></span><span class="fp-cells" style="--slots:${slots}">${cells}</span>${status}</div>`;
    }).join('');
    return `<div class="fp-timeline" aria-label="Half-hour charging schedule per simulated vehicle"><div class="fp-row fp-head"><span class="fp-ev">Vehicle</span><span class="fp-cells" style="--slots:${slots}">${head}</span><span>Result</span></div>${rows}</div>`;
}
function fpTimelineCard(alt) {
    const view = (id, label) => `<button type="button" data-fp-view="${id}" class="${fpState.view === id ? 'active' : ''}" aria-pressed="${fpState.view === id}">${label}</button>`;
    const legend = '<ul class="cg-legend fp-legend"><li><i class="is-window-charge"></i>Charging during the forecast window</li><li><i class="is-charge"></i>Charging at other times</li><li><i class="is-idle"></i>Plugged in, waiting</li></ul>';
    return `<section class="dash-card cg-card fp-card fp-timeline-card">${cgHead('green', 'clock', 'Charging schedule per vehicle', 'Each half-hour after the forecast was issued · vehicles that miss their charge are listed first', `<div class="studio-segment fp-segment" role="group" aria-label="Plan shown">${view('optimized', 'Optimized')}${view('baseline', 'Baseline')}</div>`)}${legend}${fpTimeline(alt)}</section>`;
}
function fpMethod(d) {
    const sites = d.fleet.sites.map((s) => `<li><b>${escapeHtml(s.name)}</b>: ${s.chargers} × ${n(s.chargerKw)} kW chargers, ${n(s.sitePowerKw)} kW site limit. Constraint energy ${escapeHtml(s.claims.constraint.status)}: ${escapeHtml(s.claims.constraint.reason)}</li>`).join('');
    return `<details class="cg-method fp-method"><summary>Assumptions and limits</summary><ul>${sites}${[...d.assumptions, ...d.limitations].map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul></details>`;
}
function fpSection() {
    fpEnsure();
    const head = cgHead('orange', 'car', 'Fleet plan', 'A simulated fleet scheduled against the forecast · a recommendation, not live charger control', fpControls());
    if (!fpState.data) {
        const body = fpState.status === 'error'
            ? `<div class="cg-empty" role="alert">${escapeHtml(fpState.error)}<button type="button" class="studio-button cg-retry" data-fp-retry>Try again</button></div>`
            : '<div class="cg-skeleton" role="status"><i></i><i></i>Planning the fleet…</div>';
        return `<section class="dash-card cg-card fp-card">${head}${body}</section>`;
    }
    const d = fpState.data, alt = fpAlternative();
    const note = fpState.status === 'error' ? `<p class="fp-stale" role="alert">${escapeHtml(fpState.error)} Showing the previous plan.</p>` : '';
    return `<section class="dash-card cg-card fp-card${fpState.status === 'loading' ? ' cg-is-updating' : ''}">${head}<p class="fp-tags">${fpTags(d)}</p>${note}
        <div class="fp-grid">${fpRecommendation(d, alt)}${fpCompare(alt)}${fpAlternatives(d)}</div>${fpMethod(d)}</section>${fpTimelineCard(alt)}`;
}

// ---------- interactions ----------
document.addEventListener('change', (event) => {
    if (event.target.id !== 'fp-preset') return;
    fpState.preset = event.target.value;
    render();
});
document.addEventListener('click', (event) => {
    const mode = event.target.closest('[data-fp-mode]'), view = event.target.closest('[data-fp-view]');
    if (mode) fpState.mode = mode.dataset.fpMode;
    else if (view) fpState.view = view.dataset.fpView;
    else if (event.target.closest('[data-fp-retry]')) fpState.key = '';
    else return;
    render();
});
