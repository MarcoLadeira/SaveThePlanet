// Wind & Solar page (issue #65): where Ireland's curtailed renewable power came from, and when.
// Opened from the Forecast header; the sidebar keeps Forecast highlighted. Every number comes from
// /api/v1/sources/* (backend/sources.py), which calls GridToEv with the key kept on the server:
// the recorded EirGrid split per half-hour, the experimental wind/solar forecast, and the derived
// values (peak, best charging window, errors), so nothing is recomputed here. Reuses the Forecast
// page's building blocks (fxKpi, fxHead, fxFigure, fxScale, the calendar popover styles).
const sw = {
  coverage: null, coverageError: '', coverageLoading: false,
  date: null, days: {}, dayErrors: {}, loading: {},
  forecasts: {}, forecastErrors: {}, forecastLoading: {},
  info: null, infoError: '', infoLoading: false,
  months: {}, monthErrors: {}, monthLoading: {}, month: null,
  picker: null, open: new Set(), hover: -1,
};
// A sun for the solar KPI (added here so the shared icon sets stay untouched).
fxGlyphs.sun = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>';
const SW_KWH_PER_CHARGE_NOTE = 'An energy comparison with 100% charging efficiency, not real cars.';

const swCapacity = () => (Number(modelState.capacity) > 0 ? Number(modelState.capacity) : 100);
const swKey = (date = sw.date) => `${date}|${swCapacity()}`;
// The recorded day (fast) and the forecast (a cold one takes ~7 s upstream) load separately and are
// merged here, so the recorded figures never wait for the forecast panel.
function swDay() {
  const rec = sw.date ? sw.days[swKey()] : null;
  if (!rec) return null;
  const fc = sw.forecasts[sw.date], error = sw.forecastErrors[sw.date];
  const forecast = fc ? fc.forecast : error ? { status: 'unavailable', message: error } : { status: 'loading' };
  return { date: rec.date, recorded: rec.recorded, forecast,
    derived: { ...rec.derived, comparison: fc?.comparison ?? null, potentialRatio: fc?.potentialRatio ?? null } };
}
// Re-render in place: the page scrolls inside the frame, and a re-render replaces that scroller,
// so keep its position (data arriving or a click on the month grid must not jump to the top).
function swRender() {
  if (pageFromHash() !== 'sources') return;
  const top = document.querySelector('main .sw-page')?.scrollTop || 0;
  render();
  const page = document.querySelector('main .sw-page');
  if (page && top) page.scrollTop = top;
}
const swMonthOf = (day) => day.slice(0, 7);

async function swGet(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || 'The model service could not be reached.');
  return body;
}

async function swLoadCoverage() {
  if (sw.coverage || sw.coverageLoading) return;
  sw.coverageLoading = true; sw.coverageError = '';
  try {
    sw.coverage = await swGet('/api/v1/sources/coverage');
    let saved = null;
    try { saved = localStorage.getItem('sources-day'); } catch {}
    const c = sw.coverage;
    swSelect(saved && saved >= c.from && saved <= c.to ? saved : c.suggestedDay);
  } catch (error) { sw.coverageError = error.message; }
  sw.coverageLoading = false;
  swRender();
}

async function swLoadDay(date, force = false) {
  const key = swKey(date);
  if (sw.loading[key] || (sw.days[key] && !force)) return;
  sw.loading[key] = true; delete sw.dayErrors[key];
  swRender();
  try { sw.days[key] = await swGet(`/api/v1/sources/day?date=${date}&capacityMw=${swCapacity()}`); } catch (error) { sw.dayErrors[key] = error.message; }
  delete sw.loading[key];
  swRender();
}

async function swLoadForecast(date, force = false) {
  if (sw.forecastLoading[date] || (sw.forecasts[date] && !force)) return;
  sw.forecastLoading[date] = true; delete sw.forecastErrors[date];
  swRender();
  try { sw.forecasts[date] = await swGet(`/api/v1/sources/forecast?date=${date}`); } catch (error) { sw.forecastErrors[date] = error.message; }
  delete sw.forecastLoading[date];
  swRender();
}

async function swLoadInfo() {
  if (sw.info || sw.infoLoading) return;
  sw.infoLoading = true; sw.infoError = '';
  try {
    const info = await swGet('/api/v1/sources/info');
    if (info.status === 'ok') sw.info = info; else sw.infoError = info.message;
  } catch (error) { sw.infoError = error.message; }
  sw.infoLoading = false;
  swRender();
}

async function swLoadMonth(month) {
  if (sw.months[month] || sw.monthLoading[month]) return;
  sw.monthLoading[month] = true; delete sw.monthErrors[month];
  try { sw.months[month] = await swGet(`/api/v1/sources/month?month=${month}`); } catch (error) { sw.monthErrors[month] = error.message; }
  delete sw.monthLoading[month];
  swRender();
}

function swSelect(date) {
  sw.date = date; sw.month = swMonthOf(date); sw.hover = -1; sw.picker = null;
  try { localStorage.setItem('sources-day', date); } catch {}
  swLoadDay(date);
  swLoadForecast(date);
  swLoadMonth(sw.month);
  swRender();
}

// ---------------------------------------------------------------- formatting
// Days are UTC calendar days (as EirGrid and GridToEv define them); times follow the display timezone.
function swTime(stamp) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(stamp));
}
function swZone(stamp) {
  if (settings.timezone === 'UTC') return 'UTC';
  const part = new Intl.DateTimeFormat('en-IE', { timeZone: settings.timezone, timeZoneName: 'short' }).formatToParts(new Date(stamp)).find((p) => p.type === 'timeZoneName');
  return part ? part.value : settings.timezone;
}
const swSlotStamp = (date, i) => `${date}T${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00Z`;
const swPct = (value, digits = 0) => (fxHas(value) ? `${value.toFixed(digits)}%` : '—');
const swSigned = (value, digits = 0) => (value > 0 ? '+' : value < 0 ? '−' : '') + fxMwh(Math.abs(value), digits);
function swDetails(key, summary, body, extraClass = '') {
  return `<details class="sw-drop ${extraClass}" data-sw-open="${key}"${sw.open.has(key) ? ' open' : ''}><summary>${summary}</summary><div class="sw-drop-body">${body}</div></details>`;
}

// ---------------------------------------------------------------- charts (shared engine in charts3d.js)
fxFigure('swWind', () => swDay()?.recorded.windMwh, 'MWh', 0);
fxFigure('swSolar', () => swDay()?.recorded.solarMwh, 'MWh', 0);
fxFigure('swTotal', () => swDay()?.recorded.totalMwh, 'MWh', 0);
fxFigure('swCharges', () => swDay()?.derived.recordedEv?.charges, '', 0);

// 48 half-hours stacked wind (bottom) and solar (top), with the best charging window as a band,
// the charger limit per half-hour as a dashed line and the peak marked.
fxChart('swDay', {
  values() {
    const d = swDay(), halves = d?.recorded.halfHours;
    if (!halves) return { w: [], s: [], axis: '1|1', rise: 0, win: '', peak: -1, cap: 0, labels: '', empty: d ? d.recorded.status : 'loading' };
    const w = halves.map((h) => h.windMwh ?? 0), s = halves.map((h) => h.solarMwh ?? 0);
    const top = Math.max(0, ...w.map((v, i) => v + s[i]));
    const { max, step } = fxScale(top, 10);
    const bw = d.derived.bestWindow, first = Date.parse(`${d.date}T00:00:00Z`);
    const win = bw ? `${Math.round((Date.parse(bw.start) - first) / 18e5)}|${bw.slots}` : '';
    const labels = halves.map((h, i) => (i % 6 === 0 ? swTime(h.at) : '')).join('|');
    return { w, s, axis: `${max}|${step}`, rise: 1, win, peak: d.derived.profile?.peak ? halves.findIndex((h) => h.at === d.derived.profile.peak.at) : -1,
      cap: swCapacity() * 0.5, labels, empty: top > 0 ? '' : 'zero' };
  },
  start: (t) => ({ ...t, rise: 0 }),
  draw({ w, s, axis, rise, win, peak, cap, labels, empty }) {
    if (!w.length) {
      const text = { loading: 'Loading the half-hours…', pending: 'EirGrid hasn’t published this day yet.', missing: 'EirGrid’s record for this day is incomplete.' }[empty] || 'No half-hour figures for this day.';
      return `<div class="sw-day-empty">${text}</div>`;
    }
    const [max, step] = axis.split('|').map(Number);
    const h = (v) => (Math.min(1, Math.max(0, v / max)) * rise * 100).toFixed(3);
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => `<span class="fx-tick" style="bottom:${((i * step) / max) * 100}%"><b>${n(i * step)}</b></span>`).join('');
    const names = labels.split('|');
    const cols = w.map((v, i) => `<span class="sw-col${i === peak ? ' is-peak' : ''}"><i class="sw-seg is-solar" style="height:${h(s[i])}%"></i><i class="sw-seg is-wind" style="height:${h(v)}%"></i>${i === peak ? '<em class="sw-peak" aria-hidden="true">Peak</em>' : ''}</span>`).join('');
    const [ws, wl] = win ? win.split('|').map(Number) : [0, 0];
    const band = win ? `<span class="sw-window" style="left:${(ws / 48) * 100}%;width:${(wl / 48) * 100}%"><b>Best window</b></span>` : '';
    const limit = cap <= max ? `<span class="sw-cap" style="bottom:${(cap / max) * 100}%"><b>charger limit ${n(fxRound(cap, 1))} MWh</b></span>` : '';
    const axisX = names.map((label, i) => (label ? `<span style="left:${(i / 48) * 100}%">${label}</span>` : '')).join('');
    return `<div class="sw-day"><div class="fx-week-grid">${ticks}</div><div class="sw-cols">${band}${cols}${limit}</div><div class="sw-axis-x">${axisX}</div>${empty === 'zero' ? '<div class="sw-day-empty is-over">Nothing was curtailed on this day.</div>' : ''}</div>`;
  },
});

// Predicted vs recorded on one MWh scale, then both wind shares on a 0–100% scale.
fxChart('swCompare', {
  values() {
    const d = swDay(), f = d?.forecast, r = d?.recorded;
    if (f?.status !== 'ok') return { pw: 0, ps: 0, rw: 0, rs: 0, max: 1, rec: '', rise: 0 };
    const rec = fxHas(r.totalMwh) && r.totalMwh > 0 && fxHas(r.solarMwh);
    const why = rec ? '' : r.totalMwh === 0 ? 'nothing was curtailed (0 MWh)' : r.status === 'pending' ? 'not recorded by EirGrid yet' : 'no wind/solar record';
    return { pw: f.windMwh, ps: f.solarMwh, rw: rec ? r.windMwh : 0, rs: rec ? r.solarMwh : 0,
      max: fxScale(Math.max(f.totalMwh, rec ? r.totalMwh : 0), 10).max, rec: rec ? '1' : why, rise: 1 };
  },
  start: (t) => ({ ...t, rise: 0 }),
  draw({ pw, ps, rw, rs, max, rec, rise }) {
    const pct = (v) => `${Math.max(0, (v / max) * 100 * rise).toFixed(2)}%`;
    const row = (label, wind, solar, note) => `<div class="sw-cmp-row"><span class="sw-cmp-label">${label}</span><span class="sw-cmp-track"><i class="is-wind" style="width:${pct(wind)}"></i><i class="is-solar" style="width:${pct(solar)}"></i></span><b>${fxMwh(wind + solar)} MWh</b>${note ? `<small>${note}</small>` : ''}</div>`;
    const share = (label, wind, solar) => {
      const t = wind + solar, wp = t > 0 ? (wind / t) * 100 : 0;
      return `<div class="sw-cmp-row is-share"><span class="sw-cmp-label">${label}</span><span class="sw-cmp-track"><i class="is-wind" style="width:${(wp * rise).toFixed(2)}%"><em>${Math.round(wp)}% wind</em></i><i class="is-solar" style="width:${((100 - wp) * rise).toFixed(2)}%"><em>${Math.round(100 - wp)}% solar</em></i></span></div>`;
    };
    return `<div class="sw-cmp"><p class="sw-cmp-title">Amount (MWh)</p>${row('Predicted', pw, ps)}${rec === '1' ? row('Recorded', rw, rs) : row('Recorded', 0, 0, rec)}
      <p class="sw-cmp-title">Split (share of the day’s curtailment)</p>${share('Predicted', pw, ps)}${rec === '1' ? share('Recorded', rw, rs) : ''}</div>`;
  },
});

// ---------------------------------------------------------------- page blocks
function swPickerButton() {
  const c = sw.coverage, open = Boolean(sw.picker);
  const value = sw.date ? fxDateLabel(sw.date) : 'Choose a day';
  return `<div class="fx-target">
    <button type="button" class="fx-step" data-sw-step="-1" aria-label="Previous day" ${!c || sw.date <= c.from ? 'disabled' : ''}>${fxChevron('left')}</button>
    <div class="fx-picker-anchor">
      <button type="button" class="fx-date-button${open ? ' is-open' : ''}" data-sw-picker aria-haspopup="dialog" aria-expanded="${open}" ${c ? '' : 'disabled'}>
        <span class="fx-date-icon">${icon('calendar', 18)}</span>
        <span class="fx-date-text"><small>Day · UTC</small><strong>${escapeHtml(value)}</strong></span>
        <span class="fx-date-chevron">${fxChevron('down')}</span>
      </button>
      ${open ? swPicker() : ''}
    </div>
    <button type="button" class="fx-step" data-sw-step="1" aria-label="Next day" ${!c || sw.date >= c.to ? 'disabled' : ''}>${fxChevron('right')}</button>
  </div>`;
}

function swDayKind(day) {
  const c = sw.coverage;
  if (day < c.from || day > c.to) return null;
  if (c.completeFrom && day < c.completeFrom) return 'windonly';
  if (c.completeTo && day > c.completeTo) return day >= c.forecastFrom ? 'forecastonly' : null;
  return 'recorded';
}

function swPicker() {
  const c = sw.coverage, month = sw.picker.month, [y, m] = month.split('-').map(Number);
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7, days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Array.from({ length: offset }, () => '<span class="fx-cal-blank"></span>');
  for (let d = 1; d <= days; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`, kind = swDayKind(day);
    cells.push(`<button type="button" class="fx-cal-day sw-cal-day${day === sw.date ? ' is-selected' : ''}${kind ? ` is-${kind}` : ''}" ${kind ? `data-sw-day="${day}"` : 'disabled'} aria-label="${fxDateLabel(day)}${kind === 'windonly' ? ' (wind only)' : kind === 'forecastonly' ? ' (forecast only, not yet recorded)' : kind ? '' : ' (no data)'}" aria-pressed="${day === sw.date}">${d}</button>`);
  }
  const years = [];
  for (let year = Number(c.from.slice(0, 4)); year <= Number(c.to.slice(0, 4)); year++) years.push(year);
  const canPrev = fxShiftMonth(month, -1) >= c.from.slice(0, 7), canNext = fxShiftMonth(month, 1) <= c.to.slice(0, 7);
  const quick = [['suggested', 'Latest with curtailment'], ['recorded', 'Latest recorded'], ['today', 'Today (forecast)']];
  return `<div class="fx-popover" role="dialog" aria-label="Choose a day">
    <div class="fx-popover-head"><div><strong>Pick a day</strong><span>EirGrid records ${fxDateLabel(c.from, 'short')} – ${fxDateLabel(c.completeTo, 'short')} · forecast from ${fxDateLabel(c.forecastFrom, 'short')}</span></div><button type="button" class="fx-close" data-sw-close aria-label="Close">×</button></div>
    <div class="fx-popover-body"><div class="fx-cal">
      <div class="fx-cal-nav"><button type="button" data-sw-month="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">${fxChevron('left')}</button><strong>${fxMonthLabel(month)}</strong><button type="button" data-sw-month="1" ${canNext ? '' : 'disabled'} aria-label="Next month">${fxChevron('right')}</button></div>
      <div class="fx-cal-years">${years.map((year) => `<button type="button" class="${year === y ? 'is-active' : ''}" data-sw-year="${year}">${year}</button>`).join('')}</div>
      <div class="fx-cal-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<span class="fx-cal-week">${w}</span>`).join('')}${cells.join('')}</div>
      <div class="fx-cal-legend sw-cal-legend"><span><i class="is-recorded"></i>Wind + solar</span><span><i class="is-windonly"></i>Wind only</span><span><i class="is-forecastonly"></i>Forecast only</span></div>
    </div></div>
    <div class="fx-popover-foot">${quick.map(([key, label]) => `<button type="button" data-sw-quick="${key}">${label}</button>`).join('')}</div>
  </div>`;
}

function swToolbar() {
  const d = swDay(), busy = sw.coverageLoading || Boolean(sw.loading[swKey()]);
  const rec = d?.recorded.status, f = d?.forecast.status;
  const recChip = !d ? '' : rec === 'available' ? `<span class="fx-chip sw-chip is-recorded" title="EirGrid's recorded figures for all 48 half-hours">${fxIcon('eye', 15)}Recorded</span>`
    : rec === 'solar_not_published' ? `<span class="fx-chip sw-chip is-windonly" title="EirGrid published wind only before April 2023">${fxIcon('eye', 15)}Wind only</span>`
    : `<span class="fx-chip sw-chip is-pending">${fxIcon('wait', 15)}${rec === 'pending' ? 'Not yet recorded' : 'Record incomplete'}</span>`;
  const fChip = !d || f === 'not_forecastable' ? '' : f === 'loading' ? `<span class="fx-chip sw-chip is-pending">${fxIcon('wait', 15)}Forecast loading…</span>` : f === 'ok' ? `<span class="fx-chip sw-chip is-forecast" title="Not yet confirmed on fresh data">${fxIcon('forecast', 15)}Forecast · experimental</span>`
    : `<button type="button" class="fx-chip is-error" data-sw-retry="forecast">${fxIcon('alert', 15)}Forecast unavailable · retry</button>`;
  return `<div class="fx-toolbar sw-toolbar">
    <div class="sw-toolbar-title"><span class="fx-head-icon is-green" aria-hidden="true">${fxIcon('pulse', 19)}</span><div><strong>Wind vs solar</strong><small>Curtailed renewable power in Ireland, per UTC day</small></div></div>
    ${swPickerButton()}
    <div class="fx-toolbar-end"><span class="fx-busy${busy ? ' is-on' : ''}" role="status">${busy ? '<i></i>Loading…' : ''}</span>${recChip}${fChip}</div>
  </div>`;
}

function swKpis(d) {
  const r = d.recorded, windOnly = r.status === 'solar_not_published', none = r.totalMwh === 0;
  const shareBar = (pct, cls) => (fxHas(pct) ? `<span class="sw-kpi-share is-${cls}" aria-hidden="true"><i style="width:${pct}%"></i></span>` : '<span class="sw-kpi-share is-empty" aria-hidden="true"></span>');
  const waiting = r.status === 'pending' ? 'EirGrid figure pending' : r.status === 'missing' ? 'record incomplete' : null;
  const ev = d.derived.recordedEv;
  return `<section class="fx-kpis" aria-label="The day at a glance">
    ${fxKpi('blue', 'turbine', 'Wind curtailed', 'swWind', `Wind curtailed: ${fxMwh(r.windMwh)} MWh`, `<em>${waiting || (none ? 'nothing curtailed' : fxHas(r.windSharePercent) ? `${swPct(r.windSharePercent, 1)} of the total` : 'solar unknown, so no share')}</em>`, shareBar(r.windSharePercent, 'wind'))}
    ${fxKpi('amber', 'sun', 'Solar curtailed', 'swSolar', `Solar curtailed: ${windOnly ? 'not published' : `${fxMwh(r.solarMwh)} MWh`}`, `<em>${windOnly ? 'not published before Apr 2023: unknown, not zero' : waiting || (none ? 'nothing curtailed' : `${swPct(r.solarSharePercent, 1)} of the total`)}</em>`, shareBar(r.solarSharePercent, 'solar'))}
    ${fxKpi('orange', 'pulse', 'Total curtailed', 'swTotal', `Total curtailed: ${fxMwh(r.totalMwh)} MWh`, `<em>${waiting || (windOnly ? 'unknown without solar' : 'same total as the Forecast page')}</em>`, chartSlot('swTotalSpark', 'Curtailed MWh on each day of this month', 'fx-kpi-spark'))}
    ${fxKpi('green', 'car', 'EV charging equivalent', 'swCharges', `About ${fxMwh(ev?.charges)} charges`, `<em title="${SW_KWH_PER_CHARGE_NOTE}">${ev ? `${n(ev.kwhPerCharge)} kWh top-ups · energy comparison` : 'needs a recorded total'}</em>`, '')}
  </section>`;
}

// Month sparkline in the Total KPI, selected day highlighted.
fxChart('swTotalSpark', {
  values() {
    const m = sw.months[sw.month];
    return { v: (m?.days || []).map((d) => d.totalMwh ?? 0), sel: m ? m.days.findIndex((d) => d.date === sw.date) : -1 };
  },
  start: (t) => ({ ...t, v: t.v.map(() => 0) }),
  draw({ v, sel }) {
    if (!v.length) return '<span class="fx-spark-empty"></span>';
    const top = Math.max(...v, 1);
    return `<span class="sw-spark">${v.map((x, i) => `<i class="${i === sel ? 'is-sel' : ''}" style="height:${Math.max(4, (x / top) * 100).toFixed(1)}%"></i>`).join('')}</span>`;
  },
});

function swDayCard(d) {
  const r = d.recorded, p = d.derived.profile, zone = swZone(`${d.date}T12:00:00Z`);
  const lines = [];
  if (p?.peak) lines.push(`Peak <b>${fxMwh(p.peak.totalMwh)} MWh</b> at ${swTime(p.peak.at)} (${fxMwh(p.peak.windMwh)} wind${fxHas(p.peak.solarMwh) ? ` + ${fxMwh(p.peak.solarMwh)} solar` : ''})`);
  if (p?.solarHours) lines.push(`solar curtailed ${swTime(p.solarHours.from)}–${swTime(p.solarHours.to)}`);
  if (p?.curtailedHalfHours) lines.push(`${p.curtailedHalfHours} of 48 half-hours affected`);
  const legend = fxLegend([['sw-wind', 'Wind'], ['sw-solar', 'Solar'], ['sw-window', 'Best charging window'], ['sw-cap', 'Charger limit']]);
  const selText = r.halfHours ? `Half-hours of ${fxDateLabel(d.date)}. Use the arrow keys to read each one.` : 'No half-hour figures';
  return `<section class="dash-card fx-card sw-main">
    ${fxHead('pulse', 'amber', 'When was it wasted?', `MWh curtailed in each half-hour of ${fxDateLabel(d.date)} · times in ${escapeHtml(zone)}`)}
    <div class="fx-legend-row">${legend}</div>
    <div class="sw-plot" data-sw-plot tabindex="${r.halfHours ? 0 : -1}" role="slider" aria-label="${selText}" aria-valuemin="0" aria-valuemax="47" aria-valuenow="${Math.max(0, sw.hover)}">
      ${chartSlot('swDay', r.summary || 'Wind and solar curtailment for each half-hour', 'sw-day-chart')}
      <div class="sw-hover" aria-hidden="true"><i class="sw-hover-line"></i><div class="fx-tip sw-tip"></div></div>
    </div>
    <p class="sw-summary">${lines.length ? `${lines.join(' · ')}.` : escapeHtml(r.summary || '')}${p?.windOnly ? ' Solar was not published for this day, so the bars show wind only.' : ''}</p>
  </section>`;
}

function swWindowCard(d) {
  const w = d.derived.bestWindow, cap = swCapacity(), slotCap = fxRound(cap * 0.5, 1);
  const head = fxHead('car', 'green', 'Could EVs have used it?', `With ${n(cap)} MW of flexible charging, set on the Dashboard`);
  if (!w) {
    const why = d.recorded.halfHours ? 'Nothing was curtailed on this day, so there was nothing to absorb.' : 'This needs EirGrid’s half-hour figures for the day.';
    return `<section class="dash-card fx-card sw-side">${head}<p class="sw-empty">${why}</p></section>`;
  }
  const share = w.curtailedMwh > 0 ? (w.absorbableMwh / w.curtailedMwh) * 100 : 0;
  const formula = `<p class="sw-eq" role="math">absorbable = Σ min(curtailed in the half-hour, ${n(cap)} MW × 0.5 h)</p>
    <p>Each half-hour, chargers can take at most <b>${n(slotCap)} MWh</b> (${n(cap)} MW for half an hour), and never more than was curtailed. The window is the run of up to 4 hours with the largest total. Ties go to the run with the most curtailed energy, then the shortest, then the earliest.</p>`;
  return `<section class="dash-card fx-card sw-side">${head}
    <p class="sw-window-lead">Between <b>${swTime(w.start)}</b> and <b>${swTime(w.end)}</b>, flexible charging could have absorbed up to</p>
    <p class="sw-window-figure"><strong>${fxMwh(w.absorbableMwh, 1)}</strong><small>MWh</small></p>
    <ul class="sw-stats">
      <li><span>Curtailed in that window</span><b>${fxMwh(w.curtailedMwh)} MWh</b></li>
      <li><span>Share the chargers could take</span><b>${swPct(share)}</b></li>
      <li><span>EV charging equivalent</span><b title="${SW_KWH_PER_CHARGE_NOTE}">≈ ${fxMwh(w.ev.charges)} charges</b></li>
      <li><span>Driving range equivalent</span><b>≈ ${fxMwh(w.ev.rangeKm)} km</b></li>
    </ul>
    ${swDetails('window-formula', 'How is this worked out?', formula)}
    <p class="sw-caveat">An <b>upper bound</b>: the most that could have been used <i>if</i> chargers had been connected where and when the power was curtailed. It is not energy that was saved.</p>
  </section>`;
}

function swVerdict(label, text, tone, title) {
  return `<span class="sw-verdict is-${tone}" title="${escapeHtml(title)}"><small>${label}</small><b>${text}</b></span>`;
}

function swForecastCard(d) {
  const f = d.forecast, r = d.recorded, c = d.derived.comparison;
  const badge = f.status === 'ok' ? `<span class="sw-exp${f.validationStatus === 'passed_release_gate' ? ' is-validated' : ''}">${f.validationStatus === 'passed_release_gate' ? 'Validated' : 'Experimental'}</span>` : '';
  const head = fxHead('forecast', 'orange', 'What did the model expect?', 'V2’s daily total, split into wind and solar from the day-ahead weather', badge);
  if (f.status === 'loading') return `<section class="dash-card fx-card sw-forecast">${head}<p class="sw-empty" role="status"><span class="fx-busy is-on"><i></i>Asking the model…</span> The first look at a day takes a few seconds while the weather forecast is fetched.</p></section>`;
  if (f.status === 'not_forecastable') return `<section class="dash-card fx-card sw-forecast">${head}<p class="sw-empty">${escapeHtml(f.message)}</p></section>`;
  if (f.status !== 'ok') {
    return `<section class="dash-card fx-card sw-forecast">${head}<div class="sw-empty is-error" role="alert">${fxIcon('alert', 18)}<p>The experimental forecast can’t be reached right now (${escapeHtml(f.message || 'unavailable')}). The recorded figures above are unaffected.</p><button type="button" class="studio-button" data-sw-retry="forecast">Try again ${icon('arrow', 16)}</button></div></section>`;
  }
  const made = `Made at 00:00 UTC from weather forecasts published by ${f.weatherAvailableAt ? `${fxClock(f.weatherAvailableAt)} UTC the day before` : 'the day before'}`;
  let verdicts = '';
  if (c && !c.nothingCurtailed) {
    const pts = c.shareErrorPoints, abs = Math.abs(pts ?? 0);
    const split = pts === null ? '' : swVerdict('Split', `${pts > 0 ? '+' : pts < 0 ? '−' : ''}${fxRound(abs, 1)} pts wind`, abs <= 10 ? 'good' : abs <= 20 ? 'fair' : 'off',
      'Predicted wind share minus recorded wind share, in percentage points. This is the split method’s own error.');
    const ratio = r.totalMwh > 0 ? f.totalMwh / r.totalMwh : null;
    const tone = ratio === null ? 'fair' : ratio >= 0.8 && ratio <= 1.25 ? 'good' : ratio >= 0.5 && ratio <= 2 ? 'fair' : 'off';
    const total = swVerdict('Total', `${swSigned(c.totalErrorMwh)} MWh${ratio !== null && tone === 'off' ? ` (${ratio < 1 ? `${fxRound(1 / ratio, 1)}× too low` : `${fxRound(ratio, 1)}× too high`})` : ''}`, tone,
      'Predicted daily total minus recorded total. This error comes from V2’s total, not from the split.');
    verdicts = `<div class="sw-verdicts">${split}${total}</div><p class="sw-note">The split only divides V2’s total, so it can be right about the <i>mix</i> even when the <i>amount</i> is off.</p>`;
  } else if (c?.nothingCurtailed) {
    verdicts = `<p class="sw-note">The model expected a small amount (${fxPercent(f.probability)} chance of any curtailment). Nothing was curtailed on the day.</p>`;
  } else if (r.status === 'pending') {
    verdicts = '<p class="sw-note">Awaiting EirGrid’s figures for this day. Check back after the archive refresh to see how the forecast did.</p>';
  }
  return `<section class="dash-card fx-card sw-forecast">${head}
    <p class="sw-forecast-lead"><b>${fxPercent(f.probability)}</b> chance of curtailment · <b>${fxMwh(f.totalMwh)} MWh</b> predicted: ${fxMwh(f.windMwh)} wind + ${fxMwh(f.solarMwh)} solar. <span>${made}.</span></p>
    ${chartSlot('swCompare', `Predicted ${fxMwh(f.windMwh)} MWh wind and ${fxMwh(f.solarMwh)} MWh solar; recorded ${fxMwh(r.windMwh)} MWh wind and ${fxMwh(r.solarMwh)} MWh solar`, 'sw-compare')}
    ${verdicts}
    <p class="sw-capacity">${fxIcon('scale', 15)}<span>Assumes ${fxMwh(f.capacity.windMw)} MW wind and ${fxMwh(f.capacity.solarMw)} MW solar installed (estimated from EirGrid data to ${f.capacity.dataThrough ? fxDateLabel(f.capacity.dataThrough, 'short') : '—'}).</span></p>
  </section>`;
}

function swMethodCard(d) {
  const i = sw.info, head = fxHead('info', 'green', 'How is this predicted?', i ? `Physics-share split ${escapeHtml(i.version || '')} · ${i.experimental ? 'experimental' : 'validated'}` : 'The experimental wind/solar split');
  if (!i) return `<section class="dash-card fx-card sw-method">${head}<p class="sw-empty">${sw.infoError ? `The method details are unavailable right now (${escapeHtml(sw.infoError)}).` : 'Loading the method…'}</p></section>`;
  const f = d?.forecast.status === 'ok' ? d.forecast : null, ratio = d?.derived.potentialRatio, k = i.constants;
  const signed = (value) => String(fxRound(value, 4)).replace('-', '−');
  const a = signed(i.intercept), b = signed(i.slope);
  const v = i.validation, fresh = v.fresh, prov = v.provisional;
  const better = (x, base) => (fxHas(x) && fxHas(base) && base > 0 ? Math.round((1 - x / base) * 100) : null);
  const freshPct = fresh.required ? Math.min(100, ((fresh.rows || 0) / fresh.required) * 100) : 0;
  const steps = [
    swDetails('m-what', 'What does it predict?', `<p>${escapeHtml(i.plainLanguage || '')}</p><p>It splits the daily total that the Forecast page already shows into a wind part and a solar part. The two always add up to that total.</p>`),
    swDetails('m-1', '1 · The day’s total (V2)', `<p class="sw-eq" role="math">total = chance of curtailment × likely size on a curtailment day</p><p>${f ? `For ${fxDateLabel(d.date, 'short')}: ${fxPercent(f.probability)} × ≈${fxMwh(f.totalMwh / f.probability)} MWh = <b>${fxMwh(f.totalMwh, 1)} MWh</b>.` : 'The same daily model the Forecast page uses.'} This part is unchanged; the split only divides it.</p>`),
    swDetails('m-2', '2 · How much wind and solar is installed', `<p class="sw-eq" role="math">installed MW = the highest availability EirGrid recorded in the ${n(k.capacity_window_days)} days up to the end of month M − ${n(k.capacity_publication_months)}</p><p>Official capacity isn’t published daily, so the most each fleet was ever available to produce stands in for it. It only uses data EirGrid had already published, so nothing from the future leaks in.${f ? ` For this day: <b>${fxMwh(f.capacity.windMw)} MW wind</b> and <b>${fxMwh(f.capacity.solarMw)} MW solar</b> (data to ${fxDateLabel(f.capacity.dataThrough, 'short')}).` : ''}</p>`),
    swDetails('m-3', '3 · How much each could produce that day', `<p class="sw-eq" role="math">wind energy = wind MW × 24 h × clip((v − ${k.wind_cut_in_ms}) ÷ (${k.wind_rated_ms} − ${k.wind_cut_in_ms}), 0, 1)<sup>${k.wind_curve_exponent}</sup><br>solar energy = solar MW × sunshine (kWh/m² per day)</p><p><i>v</i> is the forecast wind speed at 100 m, averaged over four regions. Below ${k.wind_cut_in_ms} m/s turbines don’t turn; from ${k.wind_rated_ms} m/s they run flat out. Sunshine per day works as “peak-sun hours”. <i>Example:</i> 9 m/s gives (9 − 3) ÷ 9 = 0.67, and 0.67<sup>1.5</sup> ≈ 0.54, so turbines produce 54% of their maximum.</p>`),
    swDetails('m-4', '4 · From the ratio to a share', `<p class="sw-eq" role="math">x = ln((wind energy + 1) ÷ (solar energy + 1))<br>wind share = 1 ÷ (1 + e<sup>−(${a} + ${b} × x)</sup>)<br>wind MWh = total × wind share · solar MWh = total − wind MWh</p><p>${f && ratio ? `For this day the model saw about <b>${fxRound(ratio.ratio, 1)}×</b> as much potential wind energy as solar (x = ${fxRound(ratio.x, 2)}), which gives a <b>${swPct(f.windSharePercent, 1)}</b> wind share: ${fxMwh(f.totalMwh, 1)} × ${fxRound(f.windSharePercent / 100, 4)} = <b>${fxMwh(f.windMwh, 1)} MWh</b> wind.` : 'The more potential wind energy there is compared with solar, the larger wind’s share.'} The two numbers ${a} and ${b} are the only fitted values, set once on ${escapeHtml((i.fittedOn || []).join(' – '))}. Because ${b} is below 1, the share leans towards 50/50: EirGrid doesn’t cut exactly in proportion.</p>`),
    swDetails('m-acc', `How accurate is it so far? <span class="sw-fresh-chip">${n(fresh.rows || 0)} of ${n(fresh.required || 60)} fresh days</span>`, `
      <div class="sw-fresh"><span class="sw-fresh-track"><i style="width:${freshPct.toFixed(1)}%"></i></span><small>Fair test on new days (from 31 Aug 2026) that nobody had seen: ${escapeHtml(fresh.status || 'pending')}.</small></div>
      <ul class="sw-stats">
        <li><span>Wind and solar error per day</span><b>${fxMwh(prov.maeMwh)} MWh</b><small>vs ${fxMwh(prov.baselineMaeMwh)} MWh for “the usual monthly share”${better(prov.maeMwh, prov.baselineMaeMwh) !== null ? `, ${better(prov.maeMwh, prov.baselineMaeMwh)}% better` : ''}</small></li>
        <li><span>Solar error on solar days</span><b>${fxMwh(prov.solarMaeMwh)} MWh</b><small>vs ${fxMwh(prov.baselineSolarMaeMwh)} MWh${better(prov.solarMaeMwh, prov.baselineSolarMaeMwh) !== null ? `, ${better(prov.solarMaeMwh, prov.baselineSolarMaeMwh)}% better` : ''}</small></li>
      </ul><p class="sw-note">${escapeHtml(prov.note || '')}</p>`),
    swDetails('m-lim', 'Limitations', `<ul class="sw-list">${i.limitations.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}<li>A planning estimate, not a dispatch instruction.</li></ul>`),
    swDetails('m-raw', 'Exact formula from the API', `<code class="sw-code">${escapeHtml(i.formula || '')}</code>`),
  ];
  return `<section class="dash-card fx-card sw-method">${head}<div class="sw-drops">${steps.join('')}</div></section>`;
}

function swMonthCard() {
  const month = sw.month, m = sw.months[month], c = sw.coverage;
  const canPrev = fxShiftMonth(month, -1) >= c.from.slice(0, 7), canNext = fxShiftMonth(month, 1) <= c.to.slice(0, 7);
  const nav = `<div class="sw-month-nav"><button type="button" class="fx-step" data-sw-mstep="-1" aria-label="Previous month" ${canPrev ? '' : 'disabled'}>${fxChevron('left')}</button><strong>${fxMonthLabel(month)}</strong><button type="button" class="fx-step" data-sw-mstep="1" aria-label="Next month" ${canNext ? '' : 'disabled'}>${fxChevron('right')}</button></div>`;
  const head = fxHead('calendar', 'blue', 'Month at a glance', 'Darker = more curtailed · the yellow part of each bar is solar · click a day to open it', nav);
  if (!m) {
    const error = sw.monthErrors[month];
    return `<section class="dash-card fx-card sw-month">${head}<p class="sw-empty">${error ? `${escapeHtml(error)} <button type="button" class="fx-reload" data-sw-retry="month">Retry</button>` : '<span class="fx-busy is-on"><i></i>Loading the month…</span>'}</p></section>`;
  }
  const top = Math.max(1, ...m.days.map((x) => x.totalMwh ?? x.windMwh ?? 0));
  const [y, mo] = month.split('-').map(Number), offset = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: offset }, () => '<span class="sw-cell is-blank"></span>');
  for (const x of m.days) {
    const total = x.totalMwh ?? (x.status === 'solar_not_published' ? x.windMwh : null);
    const level = total === null ? 0 : Math.sqrt(total / top);
    const solar = fxHas(x.solarSharePercent) ? x.solarSharePercent : 0;
    const label = total === null ? (x.status === 'pending' ? 'not yet recorded' : 'no data') : `${fxMwh(total)} MWh${x.status === 'solar_not_published' ? ' wind (solar unknown)' : fxHas(x.solarSharePercent) ? `, ${Math.round(solar)}% solar` : ''}`;
    cells.push(`<button type="button" class="sw-cell is-${x.status}${level > 0.62 ? ' is-dark' : ''}${x.date === sw.date ? ' is-selected' : ''}" data-sw-day="${x.date}" style="--level:${level.toFixed(3)}" aria-label="${fxDateLabel(x.date)}: ${label}" title="${fxDateLabel(x.date)}: ${label}">
      <b>${Number(x.date.slice(8))}</b><small>${total === null ? '—' : fxMwh(total)}</small>${total > 0 && fxHas(x.solarSharePercent) ? `<span class="sw-cell-mix"><i style="width:${(100 - solar).toFixed(1)}%"></i><em style="width:${solar.toFixed(1)}%"></em></span>` : ''}</button>`);
  }
  const t = m.totals;
  const summary = `<b>${fxMwh(t.totalMwh)} MWh</b> curtailed on <b>${t.daysCurtailed}</b> of ${t.daysKnown} recorded days${fxHas(t.solarSharePercent) ? ` · <b>${swPct(t.solarSharePercent)}</b> solar` : ''}${t.daysKnown ? ` · ≈ ${fxMwh((t.totalMwh * 1000) / 30)} charges’ worth` : ''}`;
  return `<section class="dash-card fx-card sw-month">${head}<p class="sw-month-summary">${summary}</p>
    <div class="sw-heat">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => `<span class="sw-heat-week">${w}</span>`).join('')}${cells.join('')}</div></section>`;
}

function swProvenance(d) {
  const f = d?.forecast.status === 'ok' ? d.forecast : null;
  const zone = settings.timezone === 'UTC' ? 'UTC' : settings.timezone;
  return `<p class="studio-provenance sw-provenance">Recorded: EirGrid half-hourly dispatch-down workbooks for Ireland (wind and solar), via GridToEv. Historical records, not live. ${f ? `Forecast: GridToEv V2 ${escapeHtml(f.parentVersion || '')} split by the experimental ${escapeHtml(f.version || '')} method, not a dispatch instruction. ` : ''}Days are UTC; times are shown in ${escapeHtml(zone)}.</p>`;
}

function swSkeleton() {
  const kpi = '<article class="dash-card fx-kpi is-skeleton"><span class="fx-skel-block"></span><span class="fx-skel-line"></span><span class="fx-skel-line is-short"></span></article>';
  const card = (cls) => `<section class="dash-card fx-card ${cls} is-skeleton"><span class="fx-skel-line"></span><span class="fx-skel-line is-short"></span><span class="fx-skel-fill"></span></section>`;
  return `<div class="sw-layout is-loading" aria-busy="true"><section class="fx-kpis">${kpi.repeat(4)}</section>${card('sw-main')}${card('sw-side')}</div>`;
}

function renderSources() {
  queueMicrotask(() => { swLoadCoverage(); swLoadInfo(); if (sw.date) { swLoadDay(sw.date); swLoadForecast(sw.date); swLoadMonth(sw.month); } });
  const back = `<button type="button" class="sw-back" data-page="forecast">${icon('arrow', 16, 'sw-back-icon')}Back to Forecast</button>`;
  const header = studioHeader('Wind & Solar', 'Where Ireland’s wasted renewable power came from, and when.', back);
  if (sw.coverageError) return `${header}<div class="sw-page">${fxErrorCard(sw.coverageError, 'coverage').replace('data-fx-retry', 'data-sw-retry')}</div>`;
  const d = swDay(), error = sw.dayErrors[swKey()];
  let body;
  if (!sw.coverage || (!d && !error)) body = swSkeleton();
  else if (!d) body = `<section class="dash-card fx-error" role="alert"><span class="fx-error-icon">${fxIcon('alert', 28)}</span><h2>EirGrid’s figures couldn’t be loaded</h2><p>${escapeHtml(error)}</p><button class="studio-button" type="button" data-sw-retry="day">Try again ${icon('arrow', 17)}</button></section>`;
  else body = `<div class="sw-layout${sw.loading[swKey()] ? ' is-updating' : ''}">${swKpis(d)}${swDayCard(d)}${swWindowCard(d)}${swForecastCard(d)}${swMethodCard(d)}${swMonthCard()}</div>${swProvenance(d)}`;
  return `${header}<div class="sw-page">${sw.coverage ? swToolbar() : ''}${body}</div>`;
}

// ---------------------------------------------------------------- interaction
function swShowTip(plot, i) {
  const d = swDay(), halves = d?.recorded.halfHours, tip = plot.querySelector('.sw-tip'), wrap = plot.querySelector('.sw-hover');
  if (!halves || i < 0 || i > 47) { plot.classList.remove('is-hovering'); return; }
  const h = halves[i], total = (h.windMwh ?? 0) + (h.solarMwh ?? 0), cap = swCapacity() * 0.5;
  const end = new Date(Date.parse(h.at) + 18e5).toISOString();
  tip.innerHTML = `<b>${swTime(h.at)}–${swTime(end)}</b><span><i class="is-sw-wind"></i>Wind<strong>${fxMwh(h.windMwh, 1)} MWh</strong></span><span><i class="is-sw-solar"></i>Solar<strong>${h.solarMwh === null ? 'unknown' : `${fxMwh(h.solarMwh, 1)} MWh`}</strong></span><span>Total<strong>${fxMwh(total, 1)} MWh</strong></span>${total > 0 ? `<small>Chargers could take ${fxMwh(Math.min(total, cap), 1)} MWh of it</small>` : ''}`;
  const x = `${((i + 0.5) / 48) * 100}%`;
  wrap.querySelector('.sw-hover-line').style.left = x;
  tip.style.left = x;
  // Narrow plots have no room beside the bar, so the tip sits centred above the chart instead.
  const narrow = plot.clientWidth < 520;
  tip.classList.toggle('is-center', narrow);
  tip.classList.toggle('is-left', !narrow && i > 30);
  plot.classList.add('is-hovering');
  plot.setAttribute('aria-valuenow', String(i));
  plot.setAttribute('aria-valuetext', `${swTime(h.at)}: wind ${fxMwh(h.windMwh, 1)} MWh, solar ${h.solarMwh === null ? 'unknown' : `${fxMwh(h.solarMwh, 1)} MWh`}`);
}
function swPlotIndex(plot, clientX) {
  const cols = plot.querySelector('.sw-cols');
  if (!cols) return -1;
  const box = cols.getBoundingClientRect();
  return Math.min(47, Math.max(0, Math.floor(((clientX - box.left) / box.width) * 48)));
}

function swStep(delta) {
  const c = sw.coverage, next = fxAddDays(sw.date, delta);
  if (c && next >= c.from && next <= c.to) swSelect(next);
}

document.addEventListener('click', (event) => {
  if (pageFromHash() !== 'sources') return;
  const t = event.target, pick = (attr) => t.closest(`[${attr}]`);
  let el;
  if (pick('data-sw-picker')) { sw.picker = sw.picker ? null : { month: swMonthOf(sw.date || sw.coverage.to) }; swRender(); return; }
  if (pick('data-sw-close')) { sw.picker = null; swRender(); return; }
  if ((el = pick('data-sw-month'))) { sw.picker.month = fxShiftMonth(sw.picker.month, Number(el.dataset.swMonth)); swRender(); return; }
  if ((el = pick('data-sw-year'))) {
    const c = sw.coverage, month = `${el.dataset.swYear}-${sw.picker.month.slice(5)}`;
    sw.picker.month = month < c.from.slice(0, 7) ? c.from.slice(0, 7) : month > c.to.slice(0, 7) ? c.to.slice(0, 7) : month;
    swRender(); return;
  }
  if ((el = pick('data-sw-quick'))) {
    const c = sw.coverage;
    swSelect({ suggested: c.suggestedDay, recorded: c.completeTo, today: c.to }[el.dataset.swQuick]); return;
  }
  if ((el = pick('data-sw-day'))) { swSelect(el.dataset.swDay); return; }
  if ((el = pick('data-sw-step'))) { swStep(Number(el.dataset.swStep)); return; }
  if ((el = pick('data-sw-mstep'))) { sw.month = fxShiftMonth(sw.month, Number(el.dataset.swMstep)); swLoadMonth(sw.month); swRender(); return; }
  if ((el = pick('data-sw-retry'))) {
    const what = el.dataset.swRetry;
    if (what === 'coverage') { sw.coverageError = ''; swLoadCoverage(); }
    else if (what === 'month') swLoadMonth(sw.month);
    else if (what === 'forecast') swLoadForecast(sw.date, true);
    else { swLoadDay(sw.date, true); swLoadForecast(sw.date, true); }
    return;
  }
  if (sw.picker && !t.closest('.fx-picker-anchor')) { sw.picker = null; swRender(); }
});
document.addEventListener('pointermove', (event) => {
  if (pageFromHash() !== 'sources') return;
  const plot = event.target.closest?.('[data-sw-plot]');
  document.querySelectorAll('main [data-sw-plot].is-hovering').forEach((p) => { if (p !== plot) p.classList.remove('is-hovering'); });
  if (plot) swShowTip(plot, swPlotIndex(plot, event.clientX));
});
document.addEventListener('keydown', (event) => {
  if (pageFromHash() !== 'sources') return;
  if (event.key === 'Escape' && sw.picker) { sw.picker = null; swRender(); document.querySelector('[data-sw-picker]')?.focus(); return; }
  const plot = event.target.closest?.('[data-sw-plot]');
  if (!plot) return;
  const moves = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
  if (event.key in moves) { event.preventDefault(); sw.hover = Math.min(47, Math.max(0, (sw.hover < 0 ? 0 : sw.hover + moves[event.key]))); swShowTip(plot, sw.hover); }
  else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); sw.hover = event.key === 'Home' ? 0 : 47; swShowTip(plot, sw.hover); }
});
document.addEventListener('focusout', (event) => { if (event.target.matches?.('[data-sw-plot]')) event.target.classList.remove('is-hovering'); });
// <details> toggle does not bubble, so listen in the capture phase; open dropdowns survive re-renders.
document.addEventListener('toggle', (event) => {
  const key = event.target.dataset?.swOpen;
  if (key) sw.open[event.target.open ? 'add' : 'delete'](key);
}, true);
