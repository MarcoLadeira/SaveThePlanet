// Charging page. Loaded after studio.js, so this renderCharging replaces the older one there.
// Three real data sources, each labelled on the page:
//  1. modelState.data.scenario  — the selected forecast half-hour (+30/+60) with the entered
//     demand and EV assumptions (GET /api/v1/scenario).
//  2. cgDay  — the 48-half-hour historical replay day (GET /api/v1/impact/day, same as Impact).
//  3. cgWeek — seven days from the daily model around that day (GET /api/v1/explorer/daily/week).
// Every figure is a model prediction or an upper-bound scenario estimate. Nothing is invented:
// charts without data show a loading or "unavailable" state instead.

const cgDay = { status: 'idle', data: null, key: '', request: 0 };
const cgWeek = { status: 'idle', data: null, date: '', request: 0, message: '' };
let cgAssumptionsOpen = false;

function cgKey() {
    return [modelState.capacity, modelState.totalDemandKwh, modelState.flexibleDemandKwh].join('|');
}
function cgRerender() {
    if (pageFromHash() === 'charging') render();
}
function cgEnsureData() {
    if (!modelState.data) return;
    if (cgDay.key !== cgKey() && cgDay.status !== 'loading') cgLoadDay();
    if (cgDay.status === 'ready' && cgWeek.date !== cgDay.data.date && cgWeek.status !== 'loading') cgLoadWeek(cgDay.data.date);
}
async function cgLoadDay() {
    const request = ++cgDay.request;
    cgDay.key = cgKey();
    cgDay.status = 'loading';
    const query = new URLSearchParams({ capacityMw: String(modelState.capacity), totalDemandKwh: String(modelState.totalDemandKwh), flexibleDemandKwh: String(modelState.flexibleDemandKwh) });
    try {
        const response = await fetch(`/api/v1/impact/day?${query}`);
        const body = await response.json();
        if (request !== cgDay.request) return;
        if (!response.ok || !Array.isArray(body.intervals) || !body.intervals.length) throw new Error();
        Object.assign(cgDay, { status: 'ready', data: body });
    } catch {
        if (request === cgDay.request) Object.assign(cgDay, { status: 'error', data: null });
    } finally {
        if (request === cgDay.request) cgRerender();
    }
}
async function cgLoadWeek(day) {
    const request = ++cgWeek.request;
    Object.assign(cgWeek, { status: 'loading', date: day, message: '' });
    try {
        const response = await fetch(`/api/v1/explorer/daily/week?date=${encodeURIComponent(day)}`);
        const body = await response.json();
        if (request !== cgWeek.request) return;
        if (!response.ok || !Array.isArray(body.days) || !body.days.length) throw new Error(body.error?.message || 'Daily model unavailable.');
        Object.assign(cgWeek, { status: 'ready', data: body });
    } catch (error) {
        if (request === cgWeek.request) Object.assign(cgWeek, { status: 'error', data: null, message: error.message || 'Daily model unavailable.' });
    } finally {
        if (request === cgWeek.request) cgRerender();
    }
}

// ---------- formatting ----------
function cgTarget(p = selectedPrediction()) {
    return `${escapeHtml(modelTime(p.targetAt))} forecast half-hour`;
}
function cgDayLabel(value) {
    return value ? new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${value}T00:00:00Z`)) : '';
}
function cgSourceTag() {
    return isDemoData() ? '<span class="cg-tag is-demo">Example data</span>' : '<span class="cg-tag">Historical dataset prediction</span>';
}
function cgSmooth(points) {
    if (points.length < 2) return '';
    let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i], mx = (x0 + x1) / 2;
        d += `C${mx.toFixed(1)} ${y0.toFixed(1)} ${mx.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    return d;
}
function cgDayIntervals() {
    return cgDay.status === 'ready' ? cgDay.data.intervals : [];
}

// ---------- charts (drawn and animated by the shared engine in charts3d.js) ----------
function cgFigure(name, value, format) {
    dashCharts[name] = { values: () => ({ v: value() }), start: () => ({ v: 0 }), draw: ({ v }) => { const [num, unit] = format(v); return `<strong>${num}<small>${unit}</small></strong>`; } };
}
cgFigure('cgTotal', () => modelState.data.scenario.totalDemandMwh, (v) => [n(v), 'MWh']);
cgFigure('cgFlexible', () => modelState.data.scenario.flexibleDemandMwh, (v) => [n(v), 'MWh']);
cgFigure('cgRisk', () => selectedPrediction().atRiskMwh, (v) => [n(v), 'MWh']);
cgFigure('cgAbsorb', () => scenarioOutcome().potentialRecoveryMwh, (v) => [n(v), 'MWh']);

function cgSpark(name, field, tone) {
    dashCharts[name] = {
        values: () => ({ v: cgDayIntervals().map((i) => i[field]) }),
        start: (t) => ({ v: t.v.map(() => 0) }),
        draw({ v }) {
            if (!v.length) return '<span class="cg-spark-empty"></span>';
            const w = 120, h = 44, max = Math.max(...v, 0) || 1;
            const pts = v.map((y, i) => [2 + (w - 4) * (i / (v.length - 1 || 1)), h - 3 - (y / max) * (h - 8)]);
            const line = cgSmooth(pts);
            return `<svg class="cg-spark is-${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${line}L${w - 2} ${h}L2 ${h}Z"/><path class="line" d="${line}"/></svg>`;
        },
    };
}
cgSpark('cgRiskSpark', 'atRiskMwh', 'green');
cgSpark('cgAbsorbSpark', 'potentialRecoveryMwh', 'blue');

// A share bar for the demand cards: they are inputs, so they get no fake trend line.
function cgShareBar(part, whole, label) {
    const share = whole > 0 ? Math.min(1, part / whole) : 0;
    return `<div class="cg-share" role="img" aria-label="${escapeHtml(label)}"><i style="width:${(share * 100).toFixed(1)}%"></i></div>`;
}

const CG_PLOT = { w: 660, h: 160, left: 44, right: 10, top: 18, bottom: 24 };
function cgSelectedIndex(intervals) {
    const target = new Date(selectedPrediction().targetAt).getTime();
    return intervals.findIndex((i) => new Date(i.targetAt).getTime() === target);
}
dashCharts.cgSchedule = {
    values() {
        const list = cgDayIntervals();
        return { risk: list.map((i) => i.atRiskMwh), rec: list.map((i) => i.potentialRecoveryMwh), sel: cgSelectedIndex(list), status: cgDay.status };
    },
    start: (t) => ({ ...t, risk: t.risk.map(() => 0), rec: t.rec.map(() => 0) }),
    draw({ risk, rec, sel, status }) {
        const { w, h, left, right, top, bottom } = CG_PLOT;
        if (!risk.length) return cgChartState(status, 'Loading the replay day…', 'The replay day could not be loaded. Other figures on this page are unaffected.');
        const max = chartNiceMax(Math.max(...risk, ...rec, 0.001));
        const x = (i) => left + (w - left - right) * (i / (risk.length - 1 || 1));
        const y = (v) => top + (h - top - bottom) * (1 - v / max);
        const pts = (vals) => vals.map((v, i) => [x(i), y(v)]);
        const area = (vals) => `${cgSmooth(pts(vals))}L${x(vals.length - 1)} ${h - bottom}L${x(0)} ${h - bottom}Z`;
        const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${left}" x2="${w - right}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${n(max * f)}</text>`).join('');
        const hours = [0, 8, 16, 24, 32, 40, 47].map((i) => `<text x="${x(i)}" y="${h - 8}" text-anchor="middle">${escapeHtml(modelTime(cgDay.data.intervals[i].targetAt))}</text>`).join('');
        const marker = sel >= 0 ? `<line class="cg-sel" x1="${x(sel)}" x2="${x(sel)}" y1="${top}" y2="${h - bottom}"/><circle class="cg-sel-dot" cx="${x(sel)}" cy="${y(rec[sel])}" r="5"/>` : '';
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><g class="cg-grid">${grid}</g><text class="cg-axis-unit" x="0" y="${top - 9}">MWh</text>
            <path class="cg-area is-risk" d="${area(risk)}"/><path class="cg-line is-risk" d="${cgSmooth(pts(risk))}"/>
            <path class="cg-area is-rec" d="${area(rec)}"/><path class="cg-line is-rec" d="${cgSmooth(pts(rec))}"/>
            ${marker}<g class="cg-hours">${hours}</g><line class="cg-hover" x1="0" x2="0" y1="${top}" y2="${h - bottom}"/></svg>`;
    },
};
function cgChartState(status, loading, failed) {
    return status === 'loading' || status === 'idle'
        ? `<div class="cg-skeleton" role="status"><i></i><span>${loading}</span></div>`
        : `<div class="cg-empty" role="status">${failed}</div>`;
}

dashCharts.cgDonut = {
    values() {
        const o = scenarioOutcome(), total = modelState.data.scenario.totalDemandMwh;
        return { share: total > 0 ? Math.min(1, o.potentialRecoveryMwh / total) : 0 };
    },
    start: () => ({ share: 0 }),
    draw({ share }) {
        const r = 70, c = 2 * Math.PI * r;
        return `<svg viewBox="0 0 180 180" aria-hidden="true"><circle class="cg-ring-track" cx="90" cy="90" r="${r}"/><circle class="cg-ring" cx="90" cy="90" r="${r}" stroke-dasharray="${(c * share).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 90 90)"/>
            <text class="cg-ring-value" x="90" y="92" text-anchor="middle">${n(Math.round(share * 100))}%</text><text class="cg-ring-label" x="90" y="114" text-anchor="middle">renewable</text></svg>`;
    },
};

dashCharts.cgWeek = {
    values() {
        const days = cgWeek.status === 'ready' ? cgWeek.data.days : [];
        return { v: days.map((d) => d.predictedMwh), days: days.map((d) => d.date), sel: cgDay.data?.date || '', status: cgWeek.status, message: cgWeek.message };
    },
    start: (t) => ({ ...t, v: t.v.map(() => 0) }),
    draw({ v, days, sel, status, message }) {
        if (!v.length) return cgChartState(status, 'Loading the daily model…', `Weekly figures unavailable: ${escapeHtml(message || 'the daily model did not respond.')}`);
        const w = 540, h = 150, left = 50, bottom = 24, top = 16, max = chartNiceMax(Math.max(...v, 1));
        const slot = (w - left - 8) / v.length, bw = Math.min(46, slot * 0.58);
        const y = (val) => top + (h - top - bottom) * (1 - val / max);
        const grid = [0, 0.5, 1].map((f) => `<line x1="${left}" x2="${w - 8}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${n(max * f)}</text>`).join('');
        const bars = v.map((val, i) => {
            const bx = left + slot * i + (slot - bw) / 2, top2 = y(val), label = cgDayLabel(days[i]).split(/[ ,]/)[0];
            return `<rect class="cg-bar${days[i] === sel ? ' is-sel' : ''}" x="${bx.toFixed(1)}" y="${top2.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - bottom - top2).toFixed(1)}" rx="7"/><text class="cg-bar-label" x="${(bx + bw / 2).toFixed(1)}" y="${h - 9}" text-anchor="middle">${escapeHtml(label)}</text>`;
        }).join('');
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><g class="cg-grid">${grid}</g><text class="cg-axis-unit" x="0" y="${top - 9}">MWh</text>${bars}</svg>`;
    },
};

// Half-hours with both a likely dispatch-down event and high predicted energy.
function cgBestWindows(list) {
    const energies = list.map((i) => i.atRiskMwh).filter((v) => v > 0).sort((a, b) => a - b);
    if (!energies.length) return [];
    const cut = energies[Math.floor(energies.length * 0.75)];
    return list.filter((i) => i.atRiskMwh > 0 && i.atRiskMwh >= cut && (i.probability ?? 0) >= 0.7);
}
dashCharts.cgScatter = {
    values() {
        const list = cgDayIntervals(), best = new Set(cgBestWindows(list).map((i) => i.targetAt));
        return { x: list.map((i) => i.atRiskMwh), y: list.map((i) => (i.probability ?? 0) * 100), best: list.map((i) => (best.has(i.targetAt) ? 1 : 0)), status: cgDay.status };
    },
    start: (t) => ({ ...t, y: t.y.map(() => 0) }),
    draw({ x, y, best, status }) {
        if (!x.length) return cgChartState(status, 'Loading the replay day…', 'The replay day could not be loaded.');
        const w = 380, h = 140, left = 40, bottom = 32, top = 8, right = 8, xmax = chartNiceMax(Math.max(...x, 0.001));
        const px = (v) => left + (w - left - right) * (v / xmax), py = (v) => top + (h - top - bottom) * (1 - v / 100);
        const zone = `<rect class="cg-zone" x="${left}" y="${py(100)}" width="${w - left - right}" height="${py(70) - py(100)}"/><text class="cg-zone-label" x="${left + 6}" y="${py(100) + 14}">Likely event ≥ 70%</text>`;
        const grid = [0, 50, 100].map((v) => `<line x1="${left}" x2="${w - right}" y1="${py(v)}" y2="${py(v)}"/><text x="${left - 8}" y="${py(v) + 4}" text-anchor="end">${v}%</text>`).join('')
            + [0, 0.5, 1].map((f) => `<text x="${px(xmax * f)}" y="${h - 14}" text-anchor="middle">${n(xmax * f)}</text>`).join('');
        const dots = x.map((v, i) => `<circle class="cg-dot${best[i] ? ' is-best' : ''}" cx="${px(v).toFixed(1)}" cy="${py(y[i]).toFixed(1)}" r="${best[i] ? 6.5 : 4.5}"/>`).join('');
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${zone}<g class="cg-grid">${grid}</g><text class="cg-axis-unit" x="${(left + w) / 2}" y="${h - 1}" text-anchor="middle">Energy at risk per half-hour (MWh)</text>${dots}</svg>`;
    },
};

// ---------- page ----------
function cgKpi(tone, label, figure, note, visual, aria) {
    const f = dashCharts[figure], [num, unit] = [n(f.values().v), 'MWh'];
    return `<article class="dash-card cg-kpi is-${tone}"><div class="cg-kpi-copy"><span>${label}</span><div class="chart3d cg-kpi-figure" data-chart="${figure}" role="img" aria-label="${escapeHtml(`${aria}: ${num} ${unit}`)}"><strong>0<small>MWh</small></strong></div><em>${note}</em></div><div class="cg-kpi-visual">${visual}</div></article>`;
}
function cgKpis() {
    const s = modelState.data.scenario, o = scenarioOutcome(), p = selectedPrediction(), day = cgDay.data;
    const dayNote = (field) => (day ? `Replay day total ${n(day.totals[field])} MWh` : 'Day profile loading…');
    return `<section class="cg-kpis" aria-label="${escapeHtml(`Selected ${modelTime(p.targetAt)} forecast half-hour`)}">
        ${cgKpi('green', 'Total demand', 'cgTotal', 'Your assumption for the half-hour', cgShareBar(s.flexibleDemandMwh, s.totalDemandMwh, 'Flexible share of total demand'), 'Total demand')}
        ${cgKpi('green', 'Flexible demand', 'cgFlexible', `${pct(s.totalDemandMwh ? s.flexibleDemandMwh / s.totalDemandMwh : null)} can shift to renewable periods`, cgShareBar(s.flexibleDemandMwh, s.totalDemandMwh, 'Flexible share of total demand'), 'Flexible demand')}
        ${cgKpi('orange', 'Energy at risk', 'cgRisk', `Model prediction · ${dayNote('atRiskMwh')}`, chartSlot('cgRiskSpark', 'Replay day profile of energy at risk'), 'Renewable energy at risk')}
        ${cgKpi('blue', 'Potential absorption', 'cgAbsorb', `Upper-bound estimate · ${dayNote('potentialRecoveryMwh')}`, chartSlot('cgAbsorbSpark', 'Replay day profile of potential absorption'), 'Potential absorption')}
    </section>`;
}
function cgScheduleCard() {
    const day = cgDay.data;
    const sub = day ? `Replay day ${escapeHtml(cgDayLabel(day.date))} · +${day.horizonMinutes} min forecasts · per half-hour` : 'Historical replay day · per half-hour';
    const note = day && cgSelectedIndex(day.intervals) < 0 ? '<p class="cg-note">The selected forecast half-hour is not on this replay day, so no marker is shown.</p>' : '';
    return `<section class="dash-card cg-card cg-schedule">${cardHead('green', 'Charging opportunity through the day', sub)}<ul class="cg-legend"><li><i class="is-risk"></i>Renewable energy at risk</li><li><i class="is-rec"></i>Potential EV absorption</li><li><i class="is-sel"></i>Selected half-hour</li></ul>
        <div class="cg-plot" data-cg-plot>${chartSlot('cgSchedule', 'Renewable energy at risk and potential EV absorption for each half-hour of the replay day', 'cg-chart')}<div class="cg-tooltip" role="status" hidden></div></div>${note}</section>`;
}
function cgMixCard() {
    const s = modelState.data.scenario, o = scenarioOutcome(), ev = s.evAssumptions;
    const grid = Math.max(0, s.totalDemandMwh - o.potentialRecoveryMwh);
    return `<section class="dash-card cg-card cg-mix">${cardHead('green', 'Charging mix', `${cgTarget()} · upper-bound estimate`)}
        <div class="cg-mix-body">${chartSlot('cgDonut', `${pct(s.totalDemandMwh ? o.potentialRecoveryMwh / s.totalDemandMwh : null)} of total demand could use renewable energy at risk`, 'cg-donut')}
            <ul class="cg-mix-legend"><li><i class="is-risk"></i><span>From renewable energy at risk</span><b>${n(o.potentialRecoveryMwh)} MWh</b></li><li><i class="is-grid"></i><span>Other supply</span><b>${n(grid)} MWh</b></li></ul></div>
        <div class="cg-ev"><p><b>≈ ${n(o.evChargesEquivalent)}</b> × ${n(ev.kwhPerCharge)} kWh charge equivalents · <small>energy comparison, not vehicles</small></p>
            <p><b>≥ ${n(o.minConcurrentPorts)}</b> × ${n(ev.chargerKw)} kW ports running together · <small>≤ ${n(o.portKwhLimit)} kWh each in 30 min, if enough EVs are plugged in</small></p></div></section>`;
}
function cgWeekCard() {
    const sub = cgWeek.status === 'ready' ? `Daily model · predicted curtailment per day · upper bound for EV charging` : 'Daily model · predicted curtailment per day · upper bound for EV charging';
    return `<section class="dash-card cg-card cg-week">${cardHead('orange', 'Chargeable energy opportunity', sub)}${chartSlot('cgWeek', 'Predicted curtailment for each day of the week', 'cg-chart')}</section>`;
}
function cgScatterCard() {
    const best = cgBestWindows(cgDayIntervals());
    const box = cgDay.status !== 'ready' ? '' : best.length
        ? `<div class="cg-best"><b>Best charging windows</b><span>${best.slice(0, 4).map((i) => escapeHtml(modelTime(i.targetAt))).join(' · ')} forecast half-hours</span><small>High probability and high predicted energy</small></div>`
        : '<div class="cg-best is-none"><b>No standout window</b><small>No half-hour combines a likely event (≥ 70%) with top-quarter energy.</small></div>';
    return `<section class="dash-card cg-card cg-scatter">${cardHead('green', 'When is charging most useful?', 'Replay day · each dot is one half-hour')}<div class="cg-scatter-body">${chartSlot('cgScatter', 'Dispatch-down probability against predicted energy at risk for each half-hour', 'cg-chart')}${box}</div></section>`;
}
function cgAssumptions() {
    const s = modelState.data.scenario;
    const field = (id, label, unit, value, min, max, hint) => `<div class="cg-field"><label for="${id}">${label} <span>${unit}</span></label><input id="${id}" type="number" min="${min}" max="${max}" step="any" required value="${value}" aria-describedby="${id}-hint scenario-validation"><small id="${id}-hint">${hint}</small></div>`;
    return `<details class="cg-assumptions"${cgAssumptionsOpen ? ' open' : ''}><summary>${icon('settings', 17)} Assumptions</summary>
        <div class="cg-assume-panel"><form id="charging-scenario-form" novalidate>
            <fieldset><legend>Charging demand per half-hour</legend>
                ${field('scenario-total', 'Total demand', 'kWh', modelState.totalDemandKwh, 0, 1e9, `= ${n(s.totalDemandMwh)} MWh`)}
                ${field('scenario-flexible', 'Flexible demand', 'kWh', modelState.flexibleDemandKwh, 0, 1e9, 'Part that can move in time')}
            </fieldset>
            <fieldset><legend>EV assumptions</legend>
                ${field('scenario-kwh-per-charge', 'Energy per charge', 'kWh', modelState.kwhPerCharge, 1, 200, 'Typical top-up: 30 kWh')}
                ${field('scenario-charger-kw', 'Charger power', 'kW', modelState.chargerKw, 1, 400, 'Home 7 kW · public 22 kW')}
            </fieldset>
            <p id="scenario-validation" role="alert"></p>
            <button class="studio-button" type="submit">Apply ${icon('arrow', 17)}</button>
        </form>
        <details class="cg-method"><summary>How this is calculated</summary><ul>${s.methodology.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></details></div></details>`;
}
function renderCharging() {
    return studioShell('Charging', 'Historical dataset prediction · illustrative EV charging opportunity, not live control.', () => {
        cgEnsureData();
        const d = modelState.data;
        const foot = `<p class="studio-provenance">${cgSourceTag()} ${escapeHtml(d.modelVersion)} · selected: ${cgTarget()} (+${modelState.horizon} min forecast) · Potential absorption = min(energy at risk, flexible demand, ${n(d.flexibleCapacityMw)} MW × 0.5 h). Upper-bound estimates; vehicles, ports and local grid limits are not modelled.</p>`;
        return `<div class="cg-toolbar">${studioControls()}${cgAssumptions()}</div>${cgKpis()}<div class="cg-row">${cgScheduleCard()}${cgMixCard()}</div><div class="cg-row is-bottom">${cgWeekCard()}${cgScatterCard()}</div>${foot}`;
    });
}

// ---------- interactions ----------
document.addEventListener('toggle', (event) => {
    if (event.target.classList?.contains('cg-assumptions')) cgAssumptionsOpen = event.target.open;
}, true);
document.addEventListener('pointermove', (event) => {
    const plot = event.target.closest?.('[data-cg-plot]');
    if (!plot || cgDay.status !== 'ready') return;
    const list = cgDay.data.intervals, svg = plot.querySelector('svg'), tip = plot.querySelector('.cg-tooltip');
    if (!svg || !tip) return;
    const box = svg.getBoundingClientRect(), { w, left, right } = CG_PLOT;
    const vx = ((event.clientX - box.left) / box.width) * w;
    const i = Math.round(((vx - left) / (w - left - right)) * (list.length - 1));
    if (i < 0 || i >= list.length) { tip.hidden = true; return; }
    const row = list[i], sx = left + (w - left - right) * (i / (list.length - 1));
    svg.querySelector('.cg-hover')?.setAttribute('x1', sx);
    svg.querySelector('.cg-hover')?.setAttribute('x2', sx);
    plot.classList.add('is-hovering');
    tip.hidden = false;
    tip.innerHTML = `<b>${escapeHtml(modelTime(row.targetAt))} half-hour</b><span><i class="is-risk"></i>${n(row.atRiskMwh)} MWh at risk</span><span><i class="is-rec"></i>${n(row.potentialRecoveryMwh)} MWh could be absorbed</span>${row.probability != null ? `<span>${pct(row.probability)} event probability</span>` : ''}`;
    const pos = (sx / w) * 100;
    tip.style.left = `${Math.min(80, Math.max(4, pos))}%`;
});
document.addEventListener('pointerleave', (event) => {
    const plot = event.target.closest?.('[data-cg-plot]');
    if (!plot) return;
    plot.classList.remove('is-hovering');
    const tip = plot.querySelector('.cg-tooltip');
    if (tip) tip.hidden = true;
}, true);

function chargingFieldError(total, flexible, kwh, kw) {
    const bad = (value, min, max) => !Number.isFinite(value) || value < min || value > max;
    if (bad(total, 0, 1e9)) return ['scenario-total', 'Total demand must be between 0 and 1,000,000,000 kWh.'];
    if (bad(flexible, 0, 1e9)) return ['scenario-flexible', 'Flexible demand must be between 0 and 1,000,000,000 kWh.'];
    if (flexible > total) return ['scenario-flexible', 'Flexible demand cannot be larger than total demand.'];
    if (bad(kwh, 1, 200)) return ['scenario-kwh-per-charge', 'Energy per charge must be between 1 and 200 kWh.'];
    if (bad(kw, 1, 400)) return ['scenario-charger-kw', 'Charger power must be between 1 and 400 kW.'];
    return null;
}
// Capture on window so the older scenario.js submit handler never sees this form.
window.addEventListener('submit', (event) => {
    if (event.target.id !== 'charging-scenario-form') return;
    event.preventDefault();
    event.stopPropagation();
    const value = (id) => {
        const raw = document.getElementById(id).value;
        return raw.trim() === '' ? NaN : Number(raw);
    };
    const total = value('scenario-total'), flexible = value('scenario-flexible');
    const kwh = value('scenario-kwh-per-charge'), kw = value('scenario-charger-kw');
    event.target.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
    const error = chargingFieldError(total, flexible, kwh, kw);
    if (error) {
        const input = document.getElementById(error[0]);
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        document.getElementById('scenario-validation').textContent = error[1];
        return;
    }
    Object.assign(modelState, { totalDemandKwh: total, flexibleDemandKwh: flexible, kwhPerCharge: kwh, chargerKw: kw });
    loadModelForecast();
}, true);
