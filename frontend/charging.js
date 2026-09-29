// Charging (EV) page. Loaded after studio.js, so this renderCharging replaces the older one there.
// Four data sources, each labelled on the page:
//  1. modelState.plan — the Dashboard's simulated fleet + grid battery plan for the selected half-hour
//     (POST /api/v1/charging/optimize), so every figure here matches the Dashboard.
//  2. dayPlan (bridge.js) — that same plan for each half-hour of the replay day (GET /api/v1/impact/day).
//     Each half-hour is a separate what-if with the same fleet, so charging is never added up across the day.
//  3. cgWeek — seven days from the experimental daily model (GET /api/v1/explorer/daily/week), a different
//     model from the half-hour forecasts, labelled as such, with EirGrid's observed values beside it.
//  4. dw — SaveThePlanet Rewards: discount windows at the example hub, from the Impact replay (GET/POST /api/v1/business/offers).
// Nothing is invented: charts without data show a loading or "unavailable" state instead.

const cgWeek = { status: 'idle', data: null, date: '', request: 0, message: '', retried: '' };
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
    return cgWeekMonday || (dayPlanReady() ? cgWeekStart(dayPlan.data.date) : '');
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
// The schedule follows the pinned dashboard target's day (see pinning.js), like the Battery page, so
// Dashboard, Charging, Battery and Volt always describe the same half-hour.
function cgRerender() {
    if (pageFromHash() === 'charging') render();
}
function cgEnsureData() {
    if (!modelState.data) return;
    ensureDayPlan();
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
    const f = (v) => v.toFixed(1);
    let d = `M${f(points[0][0])} ${f(points[0][1])}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
        const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]), dx = (p2[0] - p1[0]) / 3;
        const c1 = Math.min(hi, Math.max(lo, p1[1] + (p2[1] - p0[1]) * 0.2)), c2 = Math.min(hi, Math.max(lo, p2[1] - (p3[1] - p1[1]) * 0.2));
        d += ` C${f(p1[0] + dx)} ${f(c1)} ${f(p2[0] - dx)} ${f(c2)} ${f(p2[0])} ${f(p2[1])}`;
    }
    return d;
}
// Gradient fills and glow shared by the KPI line graphs (same look as the Impact cards).
function cgDefs() {
    const grad = (tone) => `<linearGradient id="cg-fill-${tone}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="cg-stop-${tone}" stop-opacity=".55"/><stop offset="1" class="cg-stop-${tone}" stop-opacity="0"/></linearGradient>`;
    return `<svg class="cg-defs" aria-hidden="true" focusable="false"><defs><filter id="cg-glow" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>${['green', 'orange', 'purple'].map(grad).join('')}</defs></svg>`;
}
function cgDayIntervals() {
    return dayPlanReady() ? dayPlan.data.intervals : [];
}

// ---------- motion ----------
// Charts animate through the shared engine in charts3d.js: it interpolates values() from start()
// and redraws each frame, and it skips motion when the viewer prefers reduced motion. Each chart
// carries a 'reveal' value that goes 0 -> 1 on first appearance (lines draw in left to right, bars
// grow in turn); later data changes keep reveal at 1 so the shapes glide to their new values.
const cgEase = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
function cgClip(id, x, y, width, height, reveal) {
    return `<clipPath id="${id}"><rect x="${x}" y="${y - 6}" width="${Math.max(0, width * reveal).toFixed(1)}" height="${height + 12}"/></clipPath>`;
}
// HTML parts (not engine charts) replay their CSS entrance only when their data changes.
const cgDrawn = {};
function cgDrawIn(name, signature) {
    const fresh = cgDrawn[name] !== signature;
    cgDrawn[name] = signature;
    return fresh && !liveRender ? ' is-drawing' : '';
}

// ---------- charts (drawn and animated by the shared engine in charts3d.js) ----------
function cgFigure(name, value, format) {
    dashCharts[name] = { format, values: () => ({ v: value() }), start: () => ({ v: 0 }), draw: ({ v }) => { const [num, unit] = format(v); return `<strong>${num}<small>${unit}</small></strong>`; } };
}
const cgPlan = () => planAlternative().optimized;
const cgCarCount = (o) => (o.opportunityAllocations || []).length;
cgFigure('cgNeed', () => cgPlan().requiredKwh, (v) => [n(v), 'kWh']);
cgFigure('cgCars', () => cgCarCount(cgPlan()), (v) => [n(Math.round(v)), `of ${cgPlan().vehiclesMet + cgPlan().vehiclesMissed} cars`]);
cgFigure('cgEv', () => cgPlan().ledger.allocatedToChargersGridKwh, (v) => [n(v), 'kWh']);
cgFigure('cgAvailable', () => selectedPrediction().atRiskMwh, (v) => [n(v), 'MWh']);

// Per half-hour of the replay day: the Dashboard's plan if charging were planned for that half-hour.
function cgDaySeries() {
    const list = cgDayIntervals();
    return {
        renewable: list.map((i) => i.atRiskMwh),
        charging: list.map((i) => i.evGridKwh),
        delivered: list.map((i) => i.evBatteryKwh),
        cars: list.map((i) => i.carsCharged),
    };
}
function cgSpark(name, series, tone) {
    dashCharts[name] = {
        values: () => { const v = cgDaySeries()[series]; return { v, reveal: v.length ? 1 : 0 }; },
        start: (t) => ({ v: t.v, reveal: 0 }),
        draw({ v, reveal }) {
            if (!v.length) return '<span class="cg-spark-empty"></span>';
            const w = 110, h = 42, max = Math.max(...v, 0) || 1;
            const pts = v.map((y, i) => [2 + (w - 4) * (i / (v.length - 1 || 1)), h - 3 - (y / max) * (h - 8)]);
            const line = cgSmooth(pts), clip = `cg-clip-${name}`;
            return `<svg class="cg-spark is-${tone}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><defs>${cgClip(clip, -4, 0, w + 8, h, reveal)}</defs><g clip-path="url(#${clip})"><path class="area" d="${line} L${pts.at(-1)[0]} ${h} L${pts[0][0]} ${h}Z" fill="url(#cg-fill-${tone})"/><path class="line" d="${line}" filter="url(#cg-glow)"/></g></svg>`;
        },
    };
}
cgSpark('cgNeedSpark', 'delivered', 'green');
cgSpark('cgCarsSpark', 'cars', 'green');
cgSpark('cgEvSpark', 'charging', 'orange');
cgSpark('cgAvailableSpark', 'renewable', 'purple');

const CG_PLOT = { w: 660, h: 160, left: 44, right: 44, top: 18, bottom: 24 };
let cgScheduleScale = { max: 1, evMax: 1, n: 0 };
function cgSelectedIndex() {
    return dayPlanIndex();
}
dashCharts.cgSchedule = {
    values() {
        const toMw = 60 / (dayPlan.data?.intervalMinutes || 30), d = cgDaySeries();
        return { renewable: d.renewable.map((v) => v * toMw), charging: d.charging.map((v) => v * toMw), sel: String(cgSelectedIndex()), status: dayPlanLoading() ? 'loading' : dayPlan.status, reveal: d.renewable.length ? 1 : 0,
            axisMax: String(chartNiceMax(Math.max(...d.renewable, 0.001) * toMw)), evAxisMax: String(chartNiceMax(Math.max(...d.charging, 0.001) * toMw)) };
    },
    start: (t) => ({ ...t, reveal: 0 }),
    draw({ renewable, charging, sel: selText, status, reveal, axisMax, evAxisMax }) {
        // The index travels as text so the animation engine does not interpolate it.
        const sel = Number(selText);
        const { w, h, left, right, top, bottom } = CG_PLOT;
        if (!renewable.length) return cgChartState(status, 'Planning the replay day…', 'The day plan could not be loaded. Other figures on this page are unaffected.');
        const max = Number(axisMax) || 1, evMax = Number(evAxisMax) || 1;
        const x = (i) => left + (w - left - right) * (i / (renewable.length - 1 || 1));
        const y = (v, m = max) => top + (h - top - bottom) * (1 - v / m);
        const pts = (vals, m) => vals.map((v, i) => [x(i), y(v, m)]);
        const area = (vals, m) => `${cgSmooth(pts(vals, m))}L${x(vals.length - 1)} ${h - bottom}L${x(0)} ${h - bottom}Z`;
        // Areas fade from each line's colour to transparent; every line is drawn on top with a thin white edge.
        const fill = (name, vals, m) => `<path class="cg-area is-${name}" d="${area(vals, m)}" fill="url(#cg-sched-${name})"/>`;
        const line = (name, vals, m) => { const d = cgSmooth(pts(vals, m)); return `<path class="cg-line-edge" d="${d}"/><path class="cg-line is-${name}" d="${d}"/>`; };
        const fade = (name, top) => `<linearGradient id="cg-sched-${name}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="cg-stop-${name}" stop-opacity="${top}"/><stop offset="1" class="cg-stop-${name}" stop-opacity=".04"/></linearGradient>`;
        cgScheduleScale = { max, evMax, n: renewable.length };
        const grid2 = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${left}" x2="${w - right}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${n(max * f)}</text><text class="is-ev" x="${w - right + 8}" y="${y(max * f) + 4}">${n(evMax * f)}</text>`).join('');
        const hours = [0, 8, 16, 24, 32, 40, 47].map((i) => `<line class="cg-vgrid" x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${h - bottom}"/><text x="${x(i)}" y="${h - 8}" text-anchor="middle">${escapeHtml(modelTime(dayPlan.data.intervals[i].targetAt))}</text>`).join('');
        const marker = sel >= 0 && Number.isFinite(charging[sel]) && reveal > 0.97 ? `<line class="cg-sel" x1="${x(sel)}" x2="${x(sel)}" y1="${top}" y2="${h - bottom}"/><circle class="cg-sel-dot" cx="${x(sel)}" cy="${y(charging[sel], evMax)}" r="5"/>` : '';
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><defs>${cgClip('cg-clip-schedule', left, top, w - left - right, h - top - bottom, reveal)}${fade('renewable', '.7')}${fade('charging', '.75')}</defs><g class="cg-grid">${grid2}</g><text class="cg-axis-unit" x="0" y="${top - 9}">MW at risk</text><text class="cg-axis-unit is-ev" x="${w}" y="${top - 9}" text-anchor="end">kW EV charging</text>
            <g clip-path="url(#cg-clip-schedule)">${fill('renewable', renewable, max)}${fill('charging', charging, evMax)}${line('renewable', renewable, max)}${line('charging', charging, evMax)}</g>
            ${marker}<g class="cg-hours">${hours}</g><line class="cg-hover" x1="0" x2="0" y1="${top}" y2="${h - bottom}"/><circle class="cg-hover-dot is-renewable" r="5" cx="-20" cy="-20"/><circle class="cg-hover-dot is-charging" r="5" cx="-20" cy="-20"/></svg>`;
    },
};
function cgChartState(status, loading, failed) {
    return status === 'loading' || status === 'idle'
        ? `<div class="cg-skeleton" role="status"><i></i><span>${loading}</span></div>`
        : `<div class="cg-empty" role="status">${failed}</div>`;
}

// 3D ring in the style of the Dashboard's "What drives the risk" chart (charts3d.js helpers,
// used read-only): renewable share in green, grid share in grey, with depth walls and a soft shadow.
dashCharts.cgDonut = {
    values() {
        const o = cgPlan();
        return { share: o.gridKwh > 0 ? Math.min(1, o.ledger.allocatedToChargersGridKwh / o.gridKwh) : 0, sweep: 1 };
    },
    start: (t) => ({ ...t, sweep: 0 }),
    draw({ share, sweep }) {
        const cx = 96, cy = 56, outer = 86, inner = 57, squash = 0.5, depth = 14;
        const gap = share > 0 && share < 1 ? 4 : 0, start = -Math.PI / 2;
        const split = start + 2 * Math.PI * share * sweep, end = start + 2 * Math.PI * sweep;
        const clip = (from, to, lo, hi) => [Math.max(from, lo), Math.min(to, hi)];
        const layers = { inner: '', outer: '', top: '' };
        for (const [tone, from, to] of [['green', start, split], ['grey', split, end]]) {
            if (to - from < 0.001) continue;
            const mid = (from + to) / 2, ox = Math.cos(mid) * gap, oy = Math.sin(mid) * gap * squash;
            const wall = (radius, a, b) => {
                const edge = chartArc(cx + ox, cy + oy, radius, radius * squash, a, b);
                return chartPath([...edge, ...edge.slice().reverse().map(([x, y]) => [x, y + depth])]);
            };
            for (const [lo, hi] of [[-Math.PI / 2, 0], [Math.PI, 1.5 * Math.PI]]) {
                const [a, b] = clip(from, to, lo, hi);
                if (b > a) layers.inner += `<path class="cg-donut-inner is-${tone}" d="${wall(inner, a, b)}"/>`;
            }
            const [a, b] = clip(from, to, 0, Math.PI);
            if (b > a) layers.outer += `<path fill="url(#cg-donut-${tone}-wall)" d="${wall(outer, a, b)}"/>`;
            layers.top += `<path class="cg-donut-top" fill="url(#cg-donut-${tone}-top)" d="${chartBand(cx + ox, cy + oy, outer, inner, from, to, squash)}"/>`;
        }
        return `<svg class="cg-donut3d" viewBox="0 0 192 150" aria-hidden="true">
            <defs>
                <linearGradient id="cg-donut-green-top" x2="0" y2="1"><stop stop-color="#5fd89d"/><stop offset="1" stop-color="#1fae6c"/></linearGradient>
                <linearGradient id="cg-donut-green-wall" x2="0" y2="1"><stop stop-color="#169b62"/><stop offset="1" stop-color="#0c6b42"/></linearGradient>
                <linearGradient id="cg-donut-grey-top" x2="0" y2="1"><stop stop-color="#dfe7e2"/><stop offset="1" stop-color="#b9c6be"/></linearGradient>
                <linearGradient id="cg-donut-grey-wall" x2="0" y2="1"><stop stop-color="#a3b2a9"/><stop offset="1" stop-color="#7f9187"/></linearGradient>
                <filter id="cg-donut-blur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
            </defs>
            <ellipse class="cg-donut-shadow" cx="${cx}" cy="${cy + depth + 16}" rx="${outer - 6}" ry="${outer * squash * 0.55}" filter="url(#cg-donut-blur)"/>
            <ellipse class="cg-donut-hole" cx="${cx}" cy="${cy}" rx="${inner + 2}" ry="${(inner + 2) * squash}"/>
            ${layers.inner}${layers.outer}${layers.top}
            <text class="cg-donut-value" x="${cx}" y="${cy + 6}" text-anchor="middle">${n(Math.round(share * 100))}%</text>
            <text class="cg-donut-label" x="${cx}" y="${cy + 20}" text-anchor="middle">renewable</text>
        </svg>`;
    },
};

// Rounded 3D cube bar: a front face with soft rounded corners, a lit top face and a
// shaded right side receding up and to the right, plus a soft glow at the base.
const CG_CUBE = { dx: 9, dy: 6 };
function cgBar3d(x, y, width, height, tone) {
    if (height < 0.5) return '';
    const { dx, dy } = CG_CUBE, f = (v) => v.toFixed(1);
    const r = Math.min(5, width / 4, height / 2), b = y + height;
    const front = `M${f(x)} ${f(b - r)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}H${f(x + width - r)}Q${f(x + width)} ${f(y)} ${f(x + width)} ${f(y + r)}V${f(b - r)}Q${f(x + width)} ${f(b)} ${f(x + width - r)} ${f(b)}H${f(x + r)}Q${f(x)} ${f(b)} ${f(x)} ${f(b - r)}Z`;
    const topFace = `M${f(x + r)} ${f(y)}L${f(x + r + dx)} ${f(y - dy)}H${f(x + width + dx - r / 2)}Q${f(x + width + dx)} ${f(y - dy)} ${f(x + width + dx)} ${f(y - dy + r / 2)}L${f(x + width)} ${f(y + r)}Q${f(x + width)} ${f(y)} ${f(x + width - r)} ${f(y)}Z`;
    const side = `M${f(x + width)} ${f(y + r)}L${f(x + width + dx)} ${f(y - dy + r / 2)}V${f(b - dy - r / 2)}Q${f(x + width + dx)} ${f(b - dy)} ${f(x + width + dx - r / 2)} ${f(b - dy + r / 4)}L${f(x + width - r)} ${f(b)}Q${f(x + width)} ${f(b)} ${f(x + width)} ${f(b - r)}Z`;
    return `<g class="cg-bar3d is-${tone}"><ellipse class="cg-bar-glow" cx="${f(x + (width + dx) / 2)}" cy="${f(b)}" rx="${f(width * 0.7)}" ry="5"/>
        <path class="cg-bar-side" d="${side}" fill="url(#cg-bar-${tone}-side)"/>
        <path class="cg-bar-front" d="${front}" fill="url(#cg-bar-${tone})"/>
        <path class="cg-bar-top" d="${topFace}" fill="url(#cg-bar-${tone}-top)"/>
        ${height > 12 ? `<rect class="cg-bar-shine" x="${f(x + 4)}" y="${f(y + 4)}" width="${f(Math.max(0, width * 0.22))}" height="${f(Math.max(0, height - 10))}" rx="2.5"/>` : ''}</g>`;
}
function cgBarDefs() {
    const grad = (id, stops, horizontal) => `<linearGradient id="${id}" x1="0" y1="0" x2="${horizontal ? 1 : 0}" y2="${horizontal ? 0 : 1}">${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>`;
    return `<defs>${grad('cg-bar-green', ['#4fcf8f', '#22b574', '#179a61'])}${grad('cg-bar-green-top', ['#b4f0cf', '#7fe0ae'], true)}${grad('cg-bar-green-side', ['#138a56', '#0c6b42'], true)}`
        + `${grad('cg-bar-orange', ['#ffa262', '#ff883e', '#e3701f'])}${grad('cg-bar-orange-top', ['#ffd9b8', '#ffbd8a'], true)}${grad('cg-bar-orange-side', ['#cc5f17', '#a94b0f'], true)}</defs>`;
}
// Axis top and step so the scale reads 0, 100, 200, 300, 400 (or the same pattern at other sizes).
function cgAxis(max) {
    const step = chartNiceMax(Math.max(max, 1) / 4), top = Math.max(step, Math.ceil(max / step) * step);
    return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
dashCharts.cgWeek = {
    values() {
        const days = cgWeek.status === 'ready' ? [...cgWeek.data.days].sort((a, b) => a.date.localeCompare(b.date)) : [];
        const observed = days.map((d) => (d.actual?.status === 'available' ? d.actual.curtailmentMwh : -1));
        return { v: days.map((d) => d.predictedMwh), seen: observed, days: days.map((d) => d.date), sel: dayPlan.data?.date || '', status: cgWeek.status, message: cgWeek.message, reveal: days.length ? 1 : 0, axisMax: String(days.length ? Math.max(...days.map((d) => d.predictedMwh), ...observed) : 0) };
    },
    start: (t) => ({ ...t, reveal: 0 }),
    draw({ v, seen = [], days, sel, status, message, reveal, axisMax }) {
        if (!v.length) {
            if (status === 'retrying') return cgChartState('loading', 'The daily model is waking up. Trying again in a few seconds…');
            if (status === 'nodata') return `<div class="cg-empty cg-nodata" role="status">${icon('calendar', 22)}<b>${escapeHtml(message)}</b><span>Pick another week with the arrows or the calendar.</span></div>`;
            return cgChartState(status, 'Loading the daily model…', `Weekly figures unavailable: ${escapeHtml(message || 'the daily model did not respond.')}<button class="studio-button cg-retry" type="button" data-cg-week-retry>Try again</button>`);
        }
        const w = 540, h = 150, left = 50, bottom = 24, top = 20, { top: max, ticks } = cgAxis(Number(axisMax) || Math.max(...v));
        const slot = (w - left - 8) / 7, bw = Math.min(40, slot * 0.5);
        const y = (val) => top + (h - top - bottom) * (1 - val / max);
        const grid = ticks.map((t) => `<line x1="${left}" x2="${w - 8}" y1="${y(t)}" y2="${y(t)}"/><text x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${n(t)}</text>`).join('');
        const bars = v.map((val, i) => {
            const slotIndex = (new Date(`${days[i]}T00:00:00Z`).getUTCDay() + 6) % 7;
            const grow = cgEase(reveal * 1.6 - slotIndex * 0.09);
            const bx = left + slot * slotIndex + (slot - bw) / 2, top2 = y(val * grow);
            const obs = seen[i] >= 0 && reveal > 0.97 ? `<line class="cg-observed" x1="${(bx - 4).toFixed(1)}" x2="${(bx + bw + CG_CUBE.dx + 4).toFixed(1)}" y1="${y(seen[i]).toFixed(1)}" y2="${y(seen[i]).toFixed(1)}"><title>Observed: ${n(seen[i])} MWh</title></line>` : '';
            return cgBar3d(bx, top2, bw, Math.max(0, h - bottom - top2), days[i] === sel ? 'orange' : 'green') + obs;
        }).join('');
        const filled = new Set(days.map((d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
        const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => `<text class="cg-bar-label" x="${(left + slot * i + slot / 2).toFixed(1)}" y="${h - 7}" text-anchor="middle">${d}</text>${filled.has(i) ? '' : `<text class="cg-bar-nodata" x="${(left + slot * i + slot / 2).toFixed(1)}" y="${h - bottom - 6}" text-anchor="middle">no data</text>`}`).join('');
        return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${cgBarDefs()}<g class="cg-grid">${grid}</g><text class="cg-axis-unit" x="0" y="${top - 9}">MWh</text>${bars}${labels}</svg>`;
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
// Card header like cardHead() in studio.js, with a tinted icon chip in place of the accent bar.
function cgHead(tone, iconName, title, subtitle, extra = '') {
    return `<div class="dash-card-head"><span class="cg-head-icon is-${tone}" aria-hidden="true">${icon(iconName, 20)}</span><div class="dash-head-copy"><h2>${title}</h2><p>${subtitle}</p></div>${extra}</div>`;
}
// Percentage pill: the selected half-hour against the replay-day average (arrow) or a share (no arrow).
function cgVsDay(value, series) {
    const list = cgDaySeries()[series];
    if (!list.length) return null;
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    return avg > 0 ? (value - avg) / avg : null;
}
function cgPill(change, share) {
    if (share != null) return `<span class="cg-pill is-share">${pct(share)}</span>`;
    if (change == null || !Number.isFinite(change)) return '<span class="cg-pill is-flat">—</span>';
    const dir = change > 0.005 ? 'up' : change < -0.005 ? 'down' : 'flat';
    return `<span class="cg-pill is-${dir}">${dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'} ${n(Math.round(Math.abs(change) * 100))}%</span>`;
}
function cgKpi(tone, iconName, label, figure, pill, note, spark, sparkLabel) {
    const chart = dashCharts[figure], [num, unit] = chart.format(chart.values().v);
    return `<article class="dash-card cg-kpi is-${tone}"><span class="cg-kpi-icon" aria-hidden="true">${icon(iconName, 22)}</span><div class="cg-kpi-copy"><span>${label}</span><div class="chart3d cg-kpi-figure" data-chart="${figure}" role="img" aria-label="${escapeHtml(`${label}: ${num} ${unit}`)}"><strong>0<small>${escapeHtml(unit)}</small></strong></div></div><div class="cg-kpi-visual" title="${escapeHtml(sparkLabel)}">${chartSlot(spark, sparkLabel)}</div><p class="cg-kpi-foot">${pill}<em>${note}</em></p></article>`;
}
function cgKpis() {
    const p = selectedPrediction(), o = cgPlan(), L = o.ledger, cars = cgCarCount(o), total = o.vehiclesMet + o.vehiclesMissed;
    const whatIf = 'if each half-hour of the replay day were planned like this one';
    return `<section class="cg-kpis" aria-label="${escapeHtml(`Selected ${modelTime(p.targetAt)} forecast half-hour`)}">
        ${cgKpi('green', 'bolt', 'Fleet charging need', 'cgNeed', cgPill(null, o.requiredKwh ? L.batteryDeliveredKwh / o.requiredKwh : null), 'met by renewables at risk', 'cgNeedSpark', `Line: energy into EV batteries, ${whatIf}`)}
        ${cgKpi('green', 'car', 'Cars charging on renewables', 'cgCars', cgPill(null, total ? cars / total : null), 'of the simulated fleet', 'cgCarsSpark', `Line: cars charging on renewables, ${whatIf}`)}
        ${cgKpi('orange', 'charge', 'EV charging on renewables', 'cgEv', cgPill(cgVsDay(L.allocatedToChargersGridKwh, 'charging')), "vs the day's average half-hour", 'cgEvSpark', `Line: EV charging on renewables, ${whatIf}`)}
        ${cgKpi('purple', 'tower', 'Renewable energy at risk', 'cgAvailable', cgPill(cgVsDay(p.atRiskMwh, 'renewable')), "vs the day's average half-hour", 'cgAvailableSpark', 'Line: renewable energy at risk in each half-hour of the replay day')}
    </section>`;
}
function cgScheduleCard() {
    const day = dayPlanReady() ? dayPlan.data : null;
    const sub = day
        ? `Each half-hour of ${escapeHtml(cgDayLabel(day.date))} (a past day replayed, 00:30 to 00:00 the next day): energy at risk (MW, left) and the fleet's charging on it if that half-hour were planned (kW, right) · ${n(day.totals.atRiskMwh)} MWh at risk over the day`
        : 'Each half-hour: energy at risk (MW, left) and the fleet\'s charging on it (kW, right)';
    const note = day && cgSelectedIndex() < 0 ? '<p class="cg-note">The selected forecast half-hour is not on this replay day, so no marker is shown.</p>' : '';
    return `<section class="dash-card cg-card cg-schedule">${cgHead('green', 'calendar', 'When charging can run on renewables', sub)}<ul class="cg-legend"><li><i class="is-renewable"></i>Renewable energy at risk of being wasted (MW)</li><li><i class="is-charging"></i>Simulated fleet charging on it (kW)</li><li><i class="is-sel"></i>Selected forecast half-hour</li></ul>
        <div class="cg-plot" data-cg-plot>${chartSlot('cgSchedule', 'Renewable energy at risk and the simulated fleet charging on it for each half-hour of the replay day', 'cg-chart')}<div class="cg-tooltip" role="status" hidden></div></div>${note}</section>`;
}
function cgMixCard() {
    const o = cgPlan(), L = o.ledger, S = L.storage, m = planImpact(L), cars = cgCarCount(o), total = o.vehiclesMet + o.vehiclesMissed;
    const renewable = L.allocatedToChargersGridKwh, grid = Math.max(0, o.gridKwh - renewable);
    return `<section class="dash-card cg-card cg-mix">${cgHead('green', 'pie', 'Renewable vs grid', `The fleet's charging · ${cgTarget()}`, presetPicker())}
        <div class="cg-mix-body">${chartSlot('cgDonut', `${pct(o.gridKwh ? renewable / o.gridKwh : null)} of the fleet's charging runs on renewable energy at risk`, 'cg-donut')}
            <ul class="cg-mix-legend"><li title="Charging in this half-hour, on renewable energy that would otherwise be wasted"><i class="is-renewable"></i><span>On renewables</span><b>${n(renewable)} kWh</b></li><li title="Charging in the fleet's other half-hours, from the grid"><i class="is-grid"></i><span>From the grid</span><b>${n(grid)} kWh</b></li></ul></div>
        <div class="cg-ev"><strong>In EV terms</strong><p><b>${cars} of ${total}</b> cars charge now: <b>${n(L.batteryDeliveredKwh)} kWh</b> ≈ <b>${n(Math.round(m.rangeKm))} km</b> <small>· ${n(o.vehiclesMet)} of ${total} full on time</small></p>
            ${S ? `<p>Grid battery takes <b>${n(S.gridKwh)} kWh</b> more <small>(${n(S.startFraction * 100)}% → ${n(S.endFraction * 100)}% full)</small></p>` : ''}</div></section>`;
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
    return `<section class="dash-card cg-card cg-week">${cgHead('green', 'bolt', 'Renewables likely wasted each day', 'Experimental daily model (a different model from the half-hour forecasts) · MWh per day · line: observed', cgWeekPicker())}${chartSlot('cgWeek', 'Daily model forecast of curtailment for each day of the chosen week, Monday to Sunday, with the observed value where available', 'cg-chart')}</section>`;
}
function cgBestCard() {
    const sub = dayPlanReady() ? `${escapeHtml(cgDayLabel(dayPlan.data.date))} (a past day replayed) · ranked by MWh at risk × how likely it is` : 'Replayed past day · ranked by MWh at risk × how likely it is';
    let body;
    if (!dayPlanReady()) {
        body = cgChartState(dayPlanLoading() ? 'loading' : 'error', 'Planning the replay day…', 'The day plan could not be loaded.');
    } else {
        const best = cgBestHalfHours(dayPlan.data.intervals), max = Math.max(...best.map((i) => i.atRiskMwh), 0.001);
        // One line per row: "+1" marks the half-hour ending at midnight, which falls on the next day, and
        // whole MWh from 100 up keep the column narrow (the bar's label has the exact value).
        const time = (at) => `${escapeHtml(modelTime(at))}${at.slice(0, 10) > dayPlan.data.date ? '<sup title="The next day">+1</sup><span class="visually-hidden"> the next day</span>' : ''}`;
        const mwh = (x) => n(x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
        body = best.length
            ? `<ol class="cg-rank${cgDrawIn('rank', `${dayPlan.data.date}|${best.map((i) => i.targetAt).join(',')}`)}">${best.map((i, k) => `<li class="${k === 0 ? 'is-top' : ''}" style="--i:${k}" title="${escapeHtml(`${n(i.evGridKwh)} kWh to the simulated EVs in this half-hour`)}"><span class="cg-rank-no">${k + 1}</span><b class="cg-rank-time">${time(i.targetAt)}</b><span class="cg-rank-track" role="img" aria-label="${escapeHtml(`${n(i.atRiskMwh)} MWh at risk`)}"><i style="width:${((i.atRiskMwh / max) * 100).toFixed(1)}%"></i></span><span class="cg-rank-mwh">${mwh(i.atRiskMwh)}<small> MWh</small></span><span class="cg-rank-prob">${i.probability == null ? '—' : `${n(Math.round(i.probability * 100))}% likely`}<span class="visually-hidden"> · ${n(i.evGridKwh)} kWh to EVs</span></span>${k === 0 ? '<em class="cg-rank-best">★ Best</em>' : '<em></em>'}</li>`).join('')}</ol>`
            : '<div class="cg-empty" role="status">No renewable energy is predicted at risk on this day, so there is no good time to shift charging.</div>';
    }
    return `<section class="dash-card cg-card cg-best-card">${cgHead('green', 'clock', 'Best half-hours to charge', sub)}${body}</section>`;
}
function cgModeMenu() { return typeof evModeToggle === 'function' ? evModeToggle() : ''; }
function renderCharging() {
    if (typeof evMode !== 'undefined' && evMode === 'comparison') return renderEvComparison();
    const title = 'Charging EVs on renewable energy that would be wasted · historical data, not live control.';
    // While new assumptions are being calculated, keep the current figures on screen (dimmed, with
    // an "Updating" note) instead of replacing the whole page with a spinner; they then glide to the new values.
    if (modelState.loading && modelState.data) {
        return `${studioHeader('EV', title)}${cgModeMenu()}<p class="cg-updating" role="status"><span class="cg-updating-dot"></span>Updating the charging figures…</p><div class="cg-is-updating">${cgPage()}</div>`;
    }
    return studioShell('EV', title, () => `${cgModeMenu()}${cgPage()}`); // the page is "EV" in the navigation and in both views
}
function cgPage() {
    {
        cgEnsureData();
        const d = modelState.data;
        if (!planAlternative()) return planPlaceholder('Fleet plan');
        const foot = `<p class="studio-provenance">${cgSourceTag()} ${escapeHtml(d.modelVersion)} · selected: ${cgTarget()} (+${modelState.horizon} min forecast) · The Dashboard's simulated fleet and grid battery plan: the same optimizer, charger and site power limits and ${n(cgPlan().ledger.chargingEfficiency * 100)}% charging efficiency. The day chart repeats that plan for each half-hour as separate what-ifs; they are never added up. Simulated fleet, not measured charging.</p>`;
        return `${cgDefs()}${cgKpis()}<div class="cg-row">${cgScheduleCard()}${cgMixCard()}</div><div class="cg-row is-bottom">${cgWeekCard()}${cgBestCard()}${dwCard()}</div>${foot}`;
    }
}

// ---------- interactions ----------
document.addEventListener('pointermove', (event) => {
    const plot = event.target.closest?.('[data-cg-plot]');
    if (!plot || !dayPlanReady()) return;
    const list = dayPlan.data.intervals, svg = plot.querySelector('svg'), tip = plot.querySelector('.cg-tooltip');
    if (!svg || !tip) return;
    const box = svg.getBoundingClientRect(), { w, left, right } = CG_PLOT;
    const vx = ((event.clientX - box.left) / box.width) * w;
    const i = Math.round(((vx - left) / (w - left - right)) * (list.length - 1));
    if (i < 0 || i >= list.length) { tip.hidden = true; return; }
    const row = list[i], sx = left + (w - left - right) * (i / (list.length - 1));
    svg.querySelector('.cg-hover')?.setAttribute('x1', sx);
    svg.querySelector('.cg-hover')?.setAttribute('x2', sx);
    const perHour = 60 / (dayPlan.data.intervalMinutes || 30), { top, bottom, h } = CG_PLOT;
    const yOf = (value, max) => top + (h - top - bottom) * (1 - (value * perHour) / (max || 1));
    for (const [cls, cy] of [['is-renewable', yOf(row.atRiskMwh, cgScheduleScale.max)], ['is-charging', yOf(row.evGridKwh, cgScheduleScale.evMax)]]) {
        const dot = svg.querySelector(`.cg-hover-dot.${cls}`);
        if (dot) { dot.setAttribute('cx', sx); dot.setAttribute('cy', cy); }
    }
    plot.classList.add('is-hovering');
    tip.hidden = false;
    tip.innerHTML = `<b>${escapeHtml(dayPlanTime(row.targetAt))} half-hour</b><span><i class="is-renewable"></i>${n(row.atRiskMwh * perHour)} MW renewable energy at risk</span><span><i class="is-charging"></i>${n(row.evGridKwh * perHour)} kW fleet charging on it (${row.carsCharged} cars)</span><span><i class="is-grid"></i>${n(row.storageGridKwh * perHour)} kW grid battery charging</span>${row.probability != null ? `<span>${pct(row.probability)} event probability</span>` : ''}`;
    // Beside the hovered half-hour (like the mockup) so the dots on the lines stay visible.
    const pos = (sx / w) * 100;
    tip.style.left = `${pos}%`;
    tip.classList.toggle('is-left', pos > 55);
});
document.addEventListener('pointerleave', (event) => {
    // Captured leave events also fire for every shape inside the chart; only react to the chart itself.
    const plot = event.target.matches?.('[data-cg-plot]') ? event.target : null;
    if (!plot) return;
    plot.classList.remove('is-hovering');
    const tip = plot.querySelector('.cg-tooltip');
    if (tip) tip.hidden = true;
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

// ---------- SaveThePlanet Rewards: discount windows (demo sign-up and booking) ----------
// Offers, prices and quotes come from the server (backend/offers.py); the page only shows them. Joining
// is a demo opt-in kept by the server under a random id: not a real account, reservation or payment.
const dw = { status: 'idle', data: null, day: '', window: '', kwh: 20, busy: false, error: '', timer: null };
function dwMember() {
    try {
        let id = localStorage.getItem('dw-member');
        if (!/^[a-z0-9-]{8,40}$/.test(id || '')) { id = `demo-${Math.random().toString(36).slice(2, 12)}`; localStorage.setItem('dw-member', id); }
        return id;
    } catch {
        dw.id = dw.id || `demo-${Math.random().toString(36).slice(2, 12)}`;
        return dw.id;
    }
}
async function dwLoad() {
    dw.status = dw.data ? dw.status : 'loading';
    clearTimeout(dw.timer);
    try {
        const response = await fetch(`/api/v1/business/offers?member=${encodeURIComponent(dwMember())}`);
        const body = await response.json();
        if (response.status === 202) {
            dw.status = 'preparing';
            dw.timer = setTimeout(() => { if (pageFromHash() === 'charging') dwLoad(); else dw.status = 'idle'; }, 2000);
        } else if (!response.ok || body.status !== 'ready') {
            Object.assign(dw, { status: body.status === 'empty' ? 'empty' : 'error', error: body.error?.message || body.message || '' });
        } else {
            dw.data = body;
            dw.status = 'ready';
            if (!dw.day || !body.offers.some((o) => o.date === dw.day)) {
                const first = body.offers.find((o) => o.status === 'offer') || body.offers[0];
                dw.day = first?.date || '';
                dw.window = first?.window || '';
            }
        }
    } catch {
        dw.status = 'error';
    }
    cgRerender();
}
async function dwAct(action, extra = {}) {
    dw.busy = true; dw.error = '';
    cgRerender();
    try {
        const response = await fetch('/api/v1/business/offers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: dwMember(), action, ...extra }) });
        const body = await response.json();
        if (response.ok && body.member) dw.data.member = body.member;
        else dw.error = body.error?.message || 'That did not work. Try again.';
        if (response.status === 409 && /changed or expired/.test(dw.error)) dwLoad();
    } catch {
        dw.error = 'Could not reach the server. Try again.';
    }
    dw.busy = false;
    cgRerender();
}
const dwDays = () => [...new Set((dw.data?.offers || []).map((o) => o.date))];
const dwEur = (v) => `€${v.toFixed(2)}`;
const dwKwhPrice = (v) => `€${v.toFixed(3).replace(/0$/, '')}`;
function dwWindowTile(o, booked) {
    const on = o.window === dw.window, price = o.status === 'offer'
        ? `<b>${dwKwhPrice(o.memberEurPerKwh)}<small>/kWh</small></b><em>−${dwKwhPrice(o.discountEurPerKwh)}</em>`
        : '<b class="is-none">No discount</b><em>normal price</em>';
    return `<button type="button" class="dw-tile${on ? ' is-on' : ''}${o.status === 'offer' ? ' is-offer' : ''}" data-dw-window="${o.window}" aria-pressed="${on}"><span>${escapeHtml(o.label)}${booked ? ` ${icon('check', 13)}` : ''}</span>${price}</button>`;
}
function dwDetail(o, booking, d) {
    if (o.status !== 'offer') {
        const next = o.next ? `<button type="button" class="dw-link" data-dw-day="${o.next.date}" data-dw-pick="${o.next.id.split(':').pop()}">Next opportunity: ${escapeHtml(cgDayLabel(o.next.date))} ${escapeHtml(o.next.label)} ›</button>` : '<span class="dw-muted">No other discount in this replay.</span>';
        return `<div class="dw-none"><b>No discounted window right now</b><span>${escapeHtml(o.reasonText || '')} Normal charging stays open at ${dwKwhPrice(d.prices.publicEurPerKwh)}/kWh.</span>${next}</div>`;
    }
    if (booking && booking.status === 'reserved') {
        return `<div class="dw-booked"><b>${icon('check', 15)} Reserved · ${n(booking.kwh)} kWh<button type="button" class="dw-link is-quiet" data-dw-act="cancel"${dw.busy ? ' disabled' : ''}>Cancel (no fee)</button></b>
            <span>Arrive ${escapeHtml(o.label)}, plug in, pick “Discount window” on the charger.</span>
            <span class="dw-price">You pay <b>${dwEur(booking.priceEur)}</b> instead of ${dwEur(booking.publicEur)} · save <b>${dwEur(booking.discountEur)}</b></span>
            <span class="dw-share">Operator keeps ${dwEur(booking.split.operatorEur)} · SaveThePlanet commission ${dwEur(booking.split.platformEur)}</span></div>`;
    }
    const q = o.quotes.find((x) => x.kwh === dw.kwh) || o.quotes.at(-1);
    const sizes = o.quotes.map((x) => `<button type="button" class="${x.kwh === q.kwh ? 'is-on' : ''}" data-dw-kwh="${x.kwh}" aria-pressed="${x.kwh === q.kwh}">${n(x.kwh)}${x === o.quotes.at(-1) ? ' kWh' : ''}</button>`).join('');
    return `<div class="dw-offer"><div class="dw-row"><div class="dw-sizes" role="group" aria-label="Energy to charge">${sizes}</div>
        <button type="button" class="studio-button dw-reserve" data-dw-act="book"${dw.busy ? ' disabled' : ''}>Reserve ${icon('arrow', 15)}</button></div>
        <span class="dw-price">You pay <b>${dwEur(q.priceEur)}</b> instead of ${dwEur(q.publicEur)} · save <b>${dwEur(q.discountEur)}</b></span>
        <span class="dw-muted">${n(o.sessions)} places · price fixed now · from stored surplus · <button type="button" class="dw-link is-quiet" data-dw-act="leave">leave demo</button></span></div>`;
}
function dwCard() {
    if (dw.status === 'idle') queueMicrotask(dwLoad);
    const d = dw.data, joined = dw.status === 'ready' && d.member.joined;
    // Once joined the day switcher takes the title row: the programme name moves to the subtitle, which
    // runs under the switcher (charging.css), and "demo" stands in for the Demo tag.
    const sim = d?.dataMode === 'simulated', title = joined ? 'Discount windows' : 'SaveThePlanet Rewards';
    const sub = !d ? 'Discount windows when our AI has stored surplus'
        : joined ? `SaveThePlanet Rewards · ${sim ? 'example data' : 'demo'} · ex VAT` : `Discount windows · ${sim ? 'example data' : 'replay'} · ex VAT`;
    let body, extra = '<span class="cg-tag is-demo">Demo</span>';
    if (joined) {
        const days = dwDays(), at = days.indexOf(dw.day);
        const step = (delta, label, glyph) => `<button type="button" class="dw-step" data-dw-step="${delta}" aria-label="${label}"${at + delta < 0 || at + delta >= days.length ? ' disabled' : ''}>${glyph}</button>`;
        extra = `<div class="dw-bar">${step(-1, 'Previous day', '‹')}<b>${escapeHtml(cgDayLabel(dw.day).replace(',', ''))}</b>${step(1, 'Next day', '›')}</div>`;
    }
    const head = cgHead('green', 'charge', title, sub, extra);
    if (dw.status !== 'ready') {
        body = dw.status === 'error' || dw.status === 'empty'
            ? `<div class="cg-empty" role="status">SaveThePlanet Rewards is unavailable${dw.error ? `: ${escapeHtml(dw.error)}` : '.'}</div>`
            : `<div class="cg-skeleton" role="status"><i></i><span>Preparing this week's offers…</span></div>`;
    } else if (!d.member.joined) {
        body = `<div class="dw-join"><p>Book a cheaper charge at <b>07:00–09:00</b> or <b>17:00–19:00</b> when our AI has stored surplus energy. You get half of the extra saving.</p>
            <button type="button" class="studio-button" data-dw-act="join"${dw.busy ? ' disabled' : ''}>Join free (demo) ${icon('arrow', 16)}</button>
            <small>Optional: anyone can charge at the normal price, ${dwKwhPrice(d.prices.publicEurPerKwh)}/kWh, without joining. Prices shown before you charge; no fees.</small></div>`;
    } else {
        const windows = d.offers.filter((o) => o.date === dw.day);
        const pick = windows.find((o) => o.window === dw.window) || windows.find((o) => o.status === 'offer') || windows[0];
        dw.window = pick?.window || '';
        const booking = pick && d.member.bookings.find((b) => b.offerId === pick.id && b.status === 'reserved');
        const booked = (o) => d.member.bookings.some((b) => b.offerId === o.id && b.status === 'reserved');
        body = `<div class="dw-tiles">${windows.map((o) => dwWindowTile(o, booked(o))).join('')}</div>
            ${pick ? dwDetail(pick, booking, d) : ''}${dw.error ? `<p class="dw-error" role="alert">${escapeHtml(dw.error)}</p>` : ''}`;
    }
    return `<section class="dash-card cg-card dw-card${joined ? ' is-joined' : ''}" aria-label="SaveThePlanet Rewards (demo)">${head}${body}</section>`;
}
document.addEventListener('click', (event) => {
    if (pageFromHash() !== 'charging') return;
    const t = event.target, pick = (attr) => t.closest(`[${attr}]`);
    let el;
    if ((el = pick('data-dw-act'))) {
        const action = el.dataset.dwAct, offer = dw.data?.offers.find((o) => o.date === dw.day && o.window === dw.window);
        dwAct(action, action === 'book' || action === 'cancel' ? { offerId: offer?.id, kwh: dw.kwh } : {});
    } else if ((el = pick('data-dw-step'))) {
        const days = dwDays();
        dw.day = days[Math.min(days.length - 1, Math.max(0, days.indexOf(dw.day) + Number(el.dataset.dwStep)))];
        dw.window = ''; dw.error = '';
        render();
    } else if ((el = pick('data-dw-day'))) {
        dw.day = el.dataset.dwDay; dw.window = el.dataset.dwPick || ''; dw.error = '';
        render();
    } else if ((el = pick('data-dw-window'))) {
        dw.window = el.dataset.dwWindow; dw.error = '';
        render();
    } else if ((el = pick('data-dw-kwh'))) {
        dw.kwh = Number(el.dataset.dwKwh);
        render();
    }
});
