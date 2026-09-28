// Charging page. Loaded after studio.js, so this renderCharging replaces the older one there.
// Three real data sources, each labelled on the page:
//  1. modelState.data.scenario  — the selected forecast half-hour (+30/+60) with the entered
//     demand and EV assumptions (GET /api/v1/scenario).
//  2. cgDay  — the 48-half-hour historical replay day (GET /api/v1/impact/day, same as Impact).
//  3. cgWeek — seven days from the daily model around that day (GET /api/v1/explorer/daily/week).
// Every figure is a model prediction or an upper-bound scenario estimate. Nothing is invented:
// charts without data show a loading or "unavailable" state instead.

const cgDay = { status: 'idle', data: null, key: '', request: 0 };
const cgWeek = { status: 'idle', data: null, date: '', request: 0, message: '', retried: '' };
let cgAssumptionsOpen = false;
// Week picker: chosen Monday (null = week of the replay day), the daily model's date range and the open calendar month.
let cgWeekMonday = null;
let cgCalMonth = null;
const cgRange = { status: 'idle', from: '', to: '' };

// Monday of the week containing day, shifted by offset days (e.g. -7 for last week).
function cgWeekStart(day, offset = 0) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offset);
    return d.toISOString().slice(0, 10);
}
function cgAddDays(day, days) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
function cgToday() {
    return new Date().toISOString().slice(0, 10);
}
function cgSelectedMonday() {
    return cgWeekMonday || (cgDay.status === 'ready' ? cgWeekStart(cgDay.data.date) : '');
}
// Why a week has no data, or '' when at least one of its days is in the daily model's range.
function cgNoDataReason(monday) {
    const sunday = cgAddDays(monday, 6), dateText = (d) => cgDayLabel(d).replace(/^\w+, /, '') + ` ${d.slice(0, 4)}`;
    if (monday > cgToday()) return `No data for this week: it hasn't happened yet.${cgRange.to ? ` The latest data is from ${dateText(cgRange.to)}.` : ''}`;
    if (cgRange.to && monday > cgRange.to) return `No data for this week yet: the daily model's data ends on ${dateText(cgRange.to)}.`;
    if (cgRange.from && sunday < cgRange.from) return `No data for this week: the daily model's data starts on ${dateText(cgRange.from)}.`;
    return '';
}
async function cgLoadRange() {
    cgRange.status = 'loading';
    try {
        const response = await fetch('/api/v1/explorer/daily');
        const body = await response.json();
        if (!response.ok || !body.dataset?.from) throw new Error();
        Object.assign(cgRange, { status: 'ready', from: body.dataset.from.slice(0, 10), to: body.dataset.to.slice(0, 10) });
    } catch {
        cgRange.status = 'error';
    } finally {
        cgWeek.date = '';
        cgRerender();
    }
}
function cgKey() {
    return [modelState.capacity, modelState.totalDemandKwh, modelState.flexibleDemandKwh].join('|');
}
function cgRerender() {
    if (pageFromHash() === 'charging') render();
}
function cgEnsureData() {
    if (!modelState.data) return;
    if (cgDay.key !== cgKey() && cgDay.status !== 'loading') cgLoadDay();
    if (cgRange.status === 'idle') cgLoadRange();
    const monday = cgSelectedMonday();
    if (!monday || cgWeek.date === monday || cgWeek.status === 'loading') return;
    const reason = cgNoDataReason(monday);
    if (reason) {
        cgWeek.request++;
        Object.assign(cgWeek, { status: 'nodata', data: null, date: monday, message: reason });
        return;
    }
    // The backend returns seven days starting at the requested date, so ask from the first day in range.
    cgLoadWeek(monday, cgRange.from && monday < cgRange.from ? cgRange.from : monday);
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
async function cgLoadWeek(day, requestDate = day) {
    const request = ++cgWeek.request;
    Object.assign(cgWeek, { status: 'loading', date: day, message: '' });
    try {
        const response = await fetch(`/api/v1/explorer/daily/week?date=${encodeURIComponent(requestDate)}`);
        const body = await response.json();
        if (request !== cgWeek.request) return;
        if (!response.ok || !Array.isArray(body.days)) throw new Error(body.error?.message || 'Daily model unavailable.');
        // Near the end of the data the backend shifts its window back; keep only the chosen Monday-to-Sunday week.
        const days = body.days.filter((d) => d.date >= day && d.date <= cgAddDays(day, 6));
        Object.assign(cgWeek, days.length ? { status: 'ready', data: { ...body, days } } : { status: 'nodata', data: null, message: 'No data for this week in the daily model.' });
    } catch (error) {
        if (request === cgWeek.request) {
            Object.assign(cgWeek, { status: 'error', data: null, message: error.message || 'Daily model unavailable.' });
            // The hosted model can take about a minute to wake: retry this week once automatically.
            if (cgWeek.retried !== day) {
                cgWeek.retried = day;
                cgWeek.status = 'retrying';
                setTimeout(() => { if (cgWeek.date === day && cgWeek.status === 'retrying') { cgWeek.date = ''; cgRerender(); } }, 20000);
            }
        }
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
cgFigure('cgProposed', () => scenarioOutcome().potentialRecoveryMwh, (v) => [n(v), 'MWh']);
cgFigure('cgAvailable', () => selectedPrediction().atRiskMwh, (v) => [n(v), 'MWh']);

// Per half-hour of the replay day: charging covered by renewable energy at risk and the rest from the grid.
function cgDaySeries() {
    const list = cgDayIntervals(), total = (cgDay.data?.totalDemandKwh || 0) / 1000;
    return {
        renewable: list.map((i) => i.atRiskMwh),
        charging: list.map((i) => i.potentialRecoveryMwh),
        grid: list.map((i) => Math.max(0, total - i.potentialRecoveryMwh)),
    };
}
function cgSpark(name, series, tone) {
    dashCharts[name] = {
        values: () => ({ v: cgDaySeries()[series] }),
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
cgSpark('cgTotalSpark', 'grid', 'green');
cgSpark('cgFlexibleSpark', 'charging', 'green');
cgSpark('cgProposedSpark', 'charging', 'orange');
cgSpark('cgAvailableSpark', 'renewable', 'purple');

const CG_PLOT = { w: 660, h: 160, left: 44, right: 10, top: 18, bottom: 24 };
function cgSelectedIndex(intervals) {
    const target = new Date(selectedPrediction().targetAt).getTime();
    return intervals.findIndex((i) => new Date(i.targetAt).getTime() === target);
}
dashCharts.cgSchedule = {
    values() {
        const toMw = 60 / (cgDay.data?.intervalMinutes || 30), d = cgDaySeries();
        return { renewable: d.renewable.map((v) => v * toMw), charging: d.charging.map((v) => v * toMw), grid: d.grid.map((v) => v * toMw), sel: String(cgSelectedIndex(cgDayIntervals())), status: cgDay.status };
    },
    start: (t) => ({ ...t, renewable: t.renewable.map(() => 0), charging: t.charging.map(() => 0), grid: t.grid.map(() => 0) }),
    draw({ renewable, charging, grid, sel: selText, status }) {
        // The index travels as text so the animation engine does not interpolate it.
        const sel = Number(selText);
        const { w, h, left, right, top, bottom } = CG_PLOT;
        if (!renewable.length) return cgChartState(status, 'Loading the replay day…', 'The replay day could not be loaded. Other figures on this page are unaffected.');
        const max = chartNiceMax(Math.max(...renewable, ...charging, ...grid, 0.001));
        const x = (i) => left + (w - left - right) * (i / (renewable.length - 1 || 1));
        const y = (v) => top + (h - top - bottom) * (1 - v / max);
        const pts = (vals) => vals.map((v, i) => [x(i), y(v)]);
        const area = (vals) => `${cgSmooth(pts(vals))}L${x(vals.length - 1)} ${h - bottom}L${x(0)} ${h - bottom}Z`;
        const series = (name, vals) => `<path class="cg-area is-${name}" d="${area(vals)}"/><path class="cg-line is-${name}" d="${cgSmooth(pts(vals))}"/>`;
        const grid2 = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${left}" x2="${w - right}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${n(max * f)}</text>`).join('');
        const hours = [0, 8, 16, 24, 32, 40, 47].map((i) => `<text x="${x(i)}" y="${h - 8}" text-anchor="middle">${escapeHtml(modelTime(cgDay.data.intervals[i].targetAt))}</text>`).join('');
        const marker = sel >= 0 && Number.isFinite(charging[sel]) ? `<line class="cg-sel" x1="${x(sel)}" x2="${x(sel)}" y1="${top}" y2="${h - bottom}"/><circle class="cg-sel-dot" cx="${x(sel)}" cy="${y(charging[sel])}" r="5"/>` : '';
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><g class="cg-grid">${grid2}</g><text class="cg-axis-unit" x="0" y="${top - 9}">MW</text>
            ${series('grid', grid)}${series('renewable', renewable)}${series('charging', charging)}
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

// Axis top and step so the scale reads 0, 100, 200, 300, 400 (or the same pattern at other sizes).
function cgAxis(max) {
    const step = chartNiceMax(Math.max(max, 1) / 4), top = Math.max(step, Math.ceil(max / step) * step);
    return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
dashCharts.cgWeek = {
    values() {
        const days = cgWeek.status === 'ready' ? [...cgWeek.data.days].sort((a, b) => a.date.localeCompare(b.date)) : [];
        return { v: days.map((d) => d.predictedMwh), days: days.map((d) => d.date), sel: cgDay.data?.date || '', status: cgWeek.status, message: cgWeek.message };
    },
    start: (t) => ({ ...t, v: t.v.map(() => 0) }),
    draw({ v, days, sel, status, message }) {
        if (!v.length) {
            if (status === 'retrying') return cgChartState('loading', 'The daily model is waking up. Trying again in a few seconds…');
            if (status === 'nodata') return `<div class="cg-empty cg-nodata" role="status">${icon('calendar', 22)}<b>${escapeHtml(message)}</b><span>Pick another week with the arrows or the calendar.</span></div>`;
            return cgChartState(status, 'Loading the daily model…', `Weekly figures unavailable: ${escapeHtml(message || 'the daily model did not respond.')}<button class="studio-button cg-retry" type="button" data-cg-week-retry>Try again</button>`);
        }
        const w = 540, h = 150, left = 50, bottom = 24, top = 16, { top: max, ticks } = cgAxis(Math.max(...v));
        const slot = (w - left - 8) / 7, bw = Math.min(46, slot * 0.58);
        const y = (val) => top + (h - top - bottom) * (1 - val / max);
        const grid = ticks.map((t) => `<line x1="${left}" x2="${w - 8}" y1="${y(t)}" y2="${y(t)}"/><text x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${n(t)}</text>`).join('');
        const bars = v.map((val, i) => {
            const slotIndex = (new Date(`${days[i]}T00:00:00Z`).getUTCDay() + 6) % 7;
            const bx = left + slot * slotIndex + (slot - bw) / 2, top2 = y(val);
            return `<rect class="cg-bar${days[i] === sel ? ' is-sel' : ''}" x="${bx.toFixed(1)}" y="${top2.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - bottom - top2).toFixed(1)}" rx="7"/>`;
        }).join('');
        const filled = new Set(days.map((d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
        const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => `<text class="cg-bar-label" x="${(left + slot * i + slot / 2).toFixed(1)}" y="${h - 7}" text-anchor="middle">${d}</text>${filled.has(i) ? '' : `<text class="cg-bar-nodata" x="${(left + slot * i + slot / 2).toFixed(1)}" y="${h - bottom - 6}" text-anchor="middle">no data</text>`}`).join('');
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><g class="cg-grid">${grid}</g><text class="cg-axis-unit" x="0" y="${top - 9}">MWh</text>${bars}${labels}</svg>`;
    },
};

// Best half-hours to charge: ranked by expected surplus = energy at risk x event probability,
// so a half-hour needs both plenty of energy and a likely event to rank high.
function cgBestHalfHours(list, limit = 5) {
    return list.filter((i) => i.atRiskMwh > 0)
        .map((i) => ({ ...i, score: i.atRiskMwh * (i.probability ?? 0) }))
        .sort((a, b) => b.score - a.score || a.targetAt.localeCompare(b.targetAt))
        .slice(0, limit);
}

// ---------- page ----------
function cgKpi(tone, label, figure, note, spark, sparkLabel) {
    const value = dashCharts[figure].values().v;
    return `<article class="dash-card cg-kpi is-${tone}"><div class="cg-kpi-copy"><span>${label}</span><div class="chart3d cg-kpi-figure" data-chart="${figure}" role="img" aria-label="${escapeHtml(`${label}: ${n(value)} MWh`)}"><strong>0<small>MWh</small></strong></div><em>${note}</em></div><div class="cg-kpi-visual">${chartSlot(spark, sparkLabel)}</div></article>`;
}
function cgKpis() {
    const s = modelState.data.scenario, p = selectedPrediction();
    return `<section class="cg-kpis" aria-label="${escapeHtml(`Selected ${modelTime(p.targetAt)} forecast half-hour`)}">
        ${cgKpi('green', 'Total demand', 'cgTotal', 'Your assumption · line: grid-powered part', 'cgTotalSpark', 'Charging from the grid in each half-hour of the replay day')}
        ${cgKpi('green', 'Flexible demand', 'cgFlexible', `${pct(s.totalDemandMwh ? s.flexibleDemandMwh / s.totalDemandMwh : null)} can shift · line: renewable part`, 'cgFlexibleSpark', 'Charging covered by renewable energy at risk in each half-hour')}
        ${cgKpi('orange', 'Proposed charging', 'cgProposed', 'Into the renewable surplus · upper bound', 'cgProposedSpark', 'Proposed charging in each half-hour of the replay day')}
        ${cgKpi('purple', 'Potential absorption', 'cgAvailable', 'Renewable surplus · model prediction', 'cgAvailableSpark', 'Renewable energy at risk in each half-hour of the replay day')}
    </section>`;
}
function cgScheduleCard() {
    const day = cgDay.data;
    const sub = day ? `When charging uses renewable energy · replay day ${escapeHtml(cgDayLabel(day.date))} · average MW per half-hour` : 'When charging uses renewable energy · average MW per half-hour';
    const note = day && cgSelectedIndex(day.intervals) < 0 ? '<p class="cg-note">The selected forecast half-hour is not on this replay day, so no marker is shown.</p>' : '';
    return `<section class="dash-card cg-card cg-schedule">${cardHead('green', 'Charging schedule', sub)}<ul class="cg-legend"><li><i class="is-renewable"></i>Renewable supply at risk</li><li><i class="is-charging"></i>Charging demand on renewable</li><li><i class="is-grid"></i>Charging demand on grid</li><li><i class="is-sel"></i>Selected half-hour</li></ul>
        <div class="cg-plot" data-cg-plot>${chartSlot('cgSchedule', 'Renewable supply at risk and charging demand split between renewable and grid for each half-hour of the replay day', 'cg-chart')}<div class="cg-tooltip" role="status" hidden></div></div>${note}</section>`;
}
function cgMixCard() {
    const s = modelState.data.scenario, o = scenarioOutcome(), ev = s.evAssumptions;
    const grid = Math.max(0, s.totalDemandMwh - o.potentialRecoveryMwh);
    return `<section class="dash-card cg-card cg-mix">${cardHead('green', 'Charging mix', cgTarget(), cgAssumptions())}
        <div class="cg-mix-body">${chartSlot('cgDonut', `${pct(s.totalDemandMwh ? o.potentialRecoveryMwh / s.totalDemandMwh : null)} of charging could use renewable energy`, 'cg-donut')}
            <ul class="cg-mix-legend"><li><i class="is-renewable"></i><span>Renewable energy</span><b>${n(o.potentialRecoveryMwh)} MWh</b></li><li><i class="is-grid"></i><span>Grid energy</span><b>${n(grid)} MWh</b></li></ul></div>
        <div class="cg-ev"><strong>In EV terms</strong><p><b>≈ ${n(Math.round(o.evChargesEquivalent * 10) / 10)}</b> × ${n(ev.kwhPerCharge)} kWh charges' worth of energy <small>(a comparison, not a count of cars)</small></p>
            <p><b>≥ ${n(o.minConcurrentPorts)}</b> × ${n(ev.chargerKw)} kW chargers running at once <small>(≤ ${n(o.portKwhLimit)} kWh each in 30 min, if enough EVs are plugged in)</small></p></div></section>`;
}
function cgWeekPicker() {
    const monday = cgSelectedMonday();
    if (!monday) return '';
    const sunday = cgAddDays(monday, 6), short = (d) => cgDayLabel(d).replace(/^\w+, /, '');
    const label = monday.slice(0, 7) === sunday.slice(0, 7) ? `${Number(monday.slice(8))} – ${short(sunday)} ${sunday.slice(0, 4)}` : `${short(monday)} – ${short(sunday)} ${sunday.slice(0, 4)}`;
    return `<div class="cg-weekpick"><button type="button" class="cg-weekpick-step" data-cg-week-step="-7" aria-label="Previous week">‹</button><button type="button" class="cg-weekpick-label" data-cg-cal-toggle aria-expanded="${cgCalMonth ? 'true' : 'false'}" aria-haspopup="dialog" aria-label="${escapeHtml(`Week of ${label}. Choose a week`)}">${icon('calendar', 16)} ${escapeHtml(label)}</button><button type="button" class="cg-weekpick-step" data-cg-week-step="7" aria-label="Next week">›</button>${cgCalMonth ? cgCalendar(monday) : ''}</div>`;
}
// Month calendar where each row is a Monday-to-Sunday week; clicking a row picks that week.
function cgCalendar(selected) {
    const first = `${cgCalMonth}-01`, monthEnd = cgAddDays(`${cgAddDays(first, 32).slice(0, 7)}-01`, -1);
    const title = new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${first}T00:00:00Z`));
    const rows = [];
    for (let monday = cgWeekStart(first); monday <= monthEnd; monday = cgAddDays(monday, 7)) {
        const days = Array.from({ length: 7 }, (_, i) => cgAddDays(monday, i));
        const empty = !!cgNoDataReason(monday);
        rows.push(`<button type="button" class="cg-cal-week${monday === selected ? ' is-selected' : ''}${empty ? ' is-empty' : ''}" data-cg-week="${monday}" title="${empty ? 'No data for this week' : 'Show this week'}">${days.map((d) => `<span class="${d.slice(0, 7) === cgCalMonth ? '' : 'is-out'}">${Number(d.slice(8))}</span>`).join('')}</button>`);
    }
    const range = cgRange.status === 'ready' ? `<small>Data: ${escapeHtml(cgDayLabel(cgRange.from).replace(/^\w+, /, ''))} ${cgRange.from.slice(0, 4)} – ${escapeHtml(cgDayLabel(cgRange.to).replace(/^\w+, /, ''))} ${cgRange.to.slice(0, 4)}</small>` : '';
    return `<div class="cg-cal" role="dialog" aria-label="Choose a week"><div class="cg-cal-head"><button type="button" data-cg-cal-month="-1" aria-label="Previous month">‹</button><b>${escapeHtml(title)}</b><button type="button" data-cg-cal-month="1" aria-label="Next month">›</button></div><div class="cg-cal-days">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<span>${d}</span>`).join('')}</div>${rows.join('')}${range}</div>`;
}
function cgWeekCard() {
    return `<section class="dash-card cg-card cg-week">${cardHead('orange', 'Chargeable energy opportunity', 'Daily model · predicted curtailment per day', cgWeekPicker())}${chartSlot('cgWeek', 'Predicted curtailment for each day of the chosen week, Monday to Sunday', 'cg-chart')}</section>`;
}
function cgBestCard() {
    const sub = cgDay.status === 'ready' ? `Replay day ${escapeHtml(cgDayLabel(cgDay.data.date))} · bar = energy at risk · ranked by energy × likelihood` : 'Replay day · bar = energy at risk · ranked by energy × likelihood';
    let body;
    if (cgDay.status !== 'ready') {
        body = cgChartState(cgDay.status, 'Loading the replay day…', 'The replay day could not be loaded.');
    } else {
        const best = cgBestHalfHours(cgDay.data.intervals), max = Math.max(...best.map((i) => i.atRiskMwh), 0.001);
        body = best.length
            ? `<ol class="cg-rank">${best.map((i, k) => `<li class="${k === 0 ? 'is-top' : ''}"><span class="cg-rank-no">${k + 1}</span><b class="cg-rank-time">${escapeHtml(modelTime(i.targetAt))}</b><span class="cg-rank-track" role="img" aria-label="${escapeHtml(`${n(i.atRiskMwh)} MWh at risk`)}"><i style="width:${((i.atRiskMwh / max) * 100).toFixed(1)}%"></i></span><span class="cg-rank-mwh">${n(i.atRiskMwh)} MWh</span><span class="cg-rank-prob">${i.probability == null ? '—' : `${n(Math.round(i.probability * 100))}% likely`}</span>${k === 0 ? '<em class="cg-rank-best">★ Best</em>' : '<em></em>'}</li>`).join('')}</ol>`
            : '<div class="cg-empty" role="status">No renewable energy is predicted at risk on this day, so there is no good time to shift charging.</div>';
    }
    return `<section class="dash-card cg-card cg-best-card">${cardHead('green', 'Best half-hours to charge', sub)}${body}</section>`;
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
        const foot = `<p class="studio-provenance">${cgSourceTag()} ${escapeHtml(d.modelVersion)} · selected: ${cgTarget()} (+${modelState.horizon} min forecast) · Proposed charging = min(renewable surplus at risk, flexible demand, ${n(d.flexibleCapacityMw)} MW × 0.5 h). Upper-bound estimates; vehicles, ports and local grid limits are not modelled.</p>`;
        return `${cgKpis()}<div class="cg-row">${cgScheduleCard()}${cgMixCard()}</div><div class="cg-row is-bottom">${cgWeekCard()}${cgBestCard()}</div>${foot}`;
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
    const toMw = 60 / (cgDay.data.intervalMinutes || 30), total = (cgDay.data.totalDemandKwh || 0) / 1000;
    tip.innerHTML = `<b>${escapeHtml(modelTime(row.targetAt))} half-hour</b><span><i class="is-renewable"></i>${n(row.atRiskMwh * toMw)} MW renewable supply at risk</span><span><i class="is-charging"></i>${n(row.potentialRecoveryMwh * toMw)} MW charging on renewable</span><span><i class="is-grid"></i>${n(Math.max(0, total - row.potentialRecoveryMwh) * toMw)} MW charging on grid</span>${row.probability != null ? `<span>${pct(row.probability)} event probability</span>` : ''}`;
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

document.addEventListener('click', (event) => {
    const step = event.target.closest('[data-cg-week-step]'), toggle = event.target.closest('[data-cg-cal-toggle]');
    const month = event.target.closest('[data-cg-cal-month]'), week = event.target.closest('[data-cg-week]');
    if (step) {
        cgWeekMonday = cgAddDays(cgSelectedMonday(), Number(step.dataset.cgWeekStep));
        cgCalMonth = null;
    } else if (toggle) {
        cgCalMonth = cgCalMonth ? null : cgSelectedMonday().slice(0, 7);
    } else if (month) {
        cgCalMonth = cgAddDays(`${cgAddDays(`${cgCalMonth}-15`, Number(month.dataset.cgCalMonth) * 30).slice(0, 7)}-01`, 0).slice(0, 7);
    } else if (week) {
        cgWeekMonday = week.dataset.cgWeek;
        cgCalMonth = null;
    } else if (cgCalMonth && !event.target.closest('.cg-cal')) {
        cgCalMonth = null;
    } else {
        return;
    }
    render();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cgCalMonth) { cgCalMonth = null; render(); }
});

document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-cg-week-retry]')) return;
    cgWeek.date = '';
    cgWeek.retried = '';
    render();
});
