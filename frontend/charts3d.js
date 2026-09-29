const dashCharts = {};

function chartLerp(from, to, t) {
  if (typeof to === 'number') {
    const start = typeof from === 'number' ? from : 0;
    return start + (to - start) * t;
  }
  if (Array.isArray(to)) return to.map((value, i) => chartLerp(Array.isArray(from) ? from[i] : undefined, value, t));
  if (to && typeof to === 'object') {
    return Object.fromEntries(Object.entries(to).map(([key, value]) => [key, chartLerp(from?.[key], value, t)]));
  }
  return to;
}

function chartNiceMax(value) {
  if (!(value > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  const ratio = value / step;
  return (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 5 ? 5 : 10) * step;
}

// The API's target timestamp is the START of the predicted half-hour ("the half-hour beginning
// 30 or 60 minutes after issue"), matching PR #26's charging_window.
function targetWindow(p) {
  const start = new Date(p.targetAt);
  const end = new Date(start.getTime() + (modelState.data?.intervalMinutes || 30) * 60000);
  return `${modelTime(start)}–${modelTime(end)}`;
}

function chartSlot(name, label, className = '', role = 'img') {
  return `<div class="chart3d ${className}" data-chart="${name}" role="${role}" aria-label="${escapeHtml(label)}"></div>`;
}

function chartsCollect(root) {
  return Object.fromEntries([...root.querySelectorAll('[data-chart]')].map((el) => [el.dataset.chart, el]));
}

function chartsRestore(root, kept) {
  root.querySelectorAll('[data-chart]').forEach((slot) => {
    const old = kept[slot.dataset.chart];
    if (!old) return;
    old.className = slot.className;
    old.setAttribute('aria-label', slot.getAttribute('aria-label'));
    slot.replaceWith(old);
  });
  Object.values(kept).forEach((el) => { if (!el.isConnected) cancelAnimationFrame(el.chartFrame); });
}

function chartsSync(root) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('[data-chart]').forEach((el) => {
    const chart = dashCharts[el.dataset.chart];
    // Standalone charts (the Forecast page) bring their own data; the rest read the model state.
    if (!chart || (!chart.standalone && !modelState.data)) return;
    const target = chart.values();
    const key = JSON.stringify(target);
    if (key === el.chartKey) return;
    el.chartKey = key;
    const from = el.chartValues || chart.start(target);
    const started = performance.now();
    const duration = el.chartValues ? 750 : 1300;
    cancelAnimationFrame(el.chartFrame);
    const step = (now) => {
      // The first frame's timestamp can precede `started`, so clamp at 0 as well.
      const t = reduce ? 1 : Math.min(1, Math.max(0, (now - started) / duration));
      el.chartValues = chartLerp(from, target, 1 - (1 - t) ** 3);
      el.innerHTML = chart.draw(el.chartValues);
      if (t < 1) el.chartFrame = requestAnimationFrame(step);
    };
    el.chartFrame = requestAnimationFrame(step);
  });
}

const chartPoint = (cx, cy, rx, ry, angle) => [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
const chartPath = (points) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('') + 'Z';

function chartArc(cx, cy, rx, ry, from, to) {
  const count = Math.max(2, Math.ceil(Math.abs(to - from) / 0.05));
  return Array.from({ length: count + 1 }, (_, i) => chartPoint(cx, cy, rx, ry, from + ((to - from) * i) / count));
}

function chartBand(cx, cy, outer, inner, from, to, squash = 1) {
  return chartPath([...chartArc(cx, cy, outer, outer * squash, from, to), ...chartArc(cx, cy, inner, inner * squash, to, from)]);
}

function chartBox(x, top, bottom, width, dx, dy) {
  return {
    front: `M${x} ${top}H${x + width}V${bottom}H${x}Z`,
    side: `M${x + width} ${top}l${dx} ${dy}V${bottom + dy}l${-dx} ${-dy}Z`,
    top: `M${x} ${top}l${dx} ${dy}H${x + width + dx}l${-dx} ${-dy}Z`,
  };
}

dashCharts.likelihood = {
  values() {
    const p = selectedPrediction();
    return { probability: p.probability, risk: p.risk };
  },
  start: (target) => ({ ...target, probability: 0 }),
  draw({ probability, risk }) {
    const value = Math.min(1, Math.max(0, probability));
    const cx = 120, cy = 104, outer = 94, inner = 66;
    const angle = Math.PI + value * Math.PI;
    const zone = (from, to, cls) => `<path class="gauge-zone ${cls}" d="${chartBand(cx, cy, outer, inner, Math.PI + from * Math.PI, Math.PI + to * Math.PI)}"/>`;
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const a = Math.PI + (i / 10) * Math.PI;
      const [x1, y1] = chartPoint(cx, cy, outer + 4, outer + 4, a);
      const [x2, y2] = chartPoint(cx, cy, outer + (i % 5 ? 8 : 11), outer + (i % 5 ? 8 : 11), a);
      return `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }).join('');
    const [tipX, tipY] = chartPoint(cx, cy, outer - 10, outer - 10, angle);
    const [leftX, leftY] = chartPoint(cx, cy, 7, 7, angle - Math.PI / 2);
    const [rightX, rightY] = chartPoint(cx, cy, 7, 7, angle + Math.PI / 2);
    return `<svg viewBox="0 0 240 160" aria-hidden="true">
      <defs><linearGradient id="gauge-fill" x1="${cx - outer}" x2="${cx + outer}" gradientUnits="userSpaceOnUse"><stop stop-color="#22b574"/><stop offset=".5" stop-color="#f4f8f3"/><stop offset="1" stop-color="#ff883e"/></linearGradient></defs>
      <path class="gauge-slab" d="${chartBand(cx, cy + 8, outer, inner, Math.PI, 2 * Math.PI)}"/>
      ${zone(0, 0.4, 'is-low')}${zone(0.4, 0.7, 'is-medium')}${zone(0.7, 1, 'is-high')}
      ${value > 0.002 ? `<path class="gauge-depth" d="${chartBand(cx, cy + 8, outer, inner, Math.PI, angle)}"/><path fill="url(#gauge-fill)" d="${chartBand(cx, cy, outer, inner, Math.PI, angle)}"/>` : ''}
      <path class="gauge-ticks" d="${ticks}"/>
      <text class="gauge-scale" x="${cx - outer + 14}" y="${cy + 20}">0%</text><text class="gauge-scale" x="${cx + outer - 14}" y="${cy + 20}" text-anchor="end">100%</text>
      <path class="gauge-needle-shadow" d="M${leftX.toFixed(1)} ${(leftY + 4).toFixed(1)}L${tipX.toFixed(1)} ${(tipY + 4).toFixed(1)}L${rightX.toFixed(1)} ${(rightY + 4).toFixed(1)}Z"/>
      <path class="gauge-needle" d="M${leftX.toFixed(1)} ${leftY.toFixed(1)}L${tipX.toFixed(1)} ${tipY.toFixed(1)}L${cx} ${cy}Z"/>
      <path class="gauge-needle is-shade" d="M${rightX.toFixed(1)} ${rightY.toFixed(1)}L${tipX.toFixed(1)} ${tipY.toFixed(1)}L${cx} ${cy}Z"/>
      <ellipse class="gauge-hub-side" cx="${cx}" cy="${cy + 4}" rx="11" ry="9"/><ellipse class="gauge-hub" cx="${cx}" cy="${cy}" rx="11" ry="9"/>
      <text class="gauge-value" x="${cx}" y="${cy + 38}" text-anchor="middle">${Math.round(value * 100)}%</text>
      <text class="gauge-caption" x="${cx}" y="${cy + 53}" text-anchor="middle">likely · ${escapeHtml(risk)} risk</text>
    </svg>`;
  },
};

const scenarioNow = () => scenarioOutcome(selectedPrediction());

dashCharts.confidence = {
  values() {
    const rows = [...modelState.data.predictions]
      .sort((a, b) => a.horizonMinutes - b.horizonMinutes)
      .map((p) => ({
        horizon: String(p.horizonMinutes), issued: modelTime(p.issuedAt), window: targetWindow(p), risk: p.risk,
        probability: p.probability, low: p.lowerMwh, high: p.upperMwh, expected: p.atRiskMwh,
      }));
    return { rows, max: chartNiceMax(Math.max(...rows.map((row) => Math.max(row.high, row.expected)))), selected: String(modelState.horizon) };
  },
  start: (target) => ({ ...target, rows: target.rows.map((row) => ({ ...row, low: row.expected, high: row.expected, probability: 0 })) }),
  draw({ rows, max, selected }) {
    const at = (value) => `${Math.min(100, Math.max(0, (value / max) * 100)).toFixed(2)}%`;
    return `<div class="conf-rows">${rows.map((row) => `<button type="button" class="conf-row is-${escapeHtml(row.risk)}${row.horizon === selected ? ' is-selected' : ''}" data-horizon="${row.horizon}" aria-pressed="${row.horizon === selected}">
        <span class="conf-when"><small>+${row.horizon} min · issued ${escapeHtml(row.issued)}</small><b>${escapeHtml(row.window)}</b></span>
        <span class="conf-track"><span class="conf-glass"></span><span class="conf-band" style="left:${at(row.low)};width:calc(${at(row.high)} - ${at(row.low)})"></span>
          <span class="conf-end" style="left:${at(row.low)}">${n(row.low)}</span><span class="conf-end is-high" style="left:${at(row.high)}">${n(row.high)}</span>
          <span class="conf-dot" style="left:${at(row.expected)}"><em>${n(row.expected)} MWh</em></span></span>
        <span class="conf-odds"><b>${Math.round(row.probability * 100)}%</b><small>likely</small></span>
      </button>`).join('')}</div>`;
  },
};