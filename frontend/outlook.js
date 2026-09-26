// One comparison plot connects the two supplied targets; only those targets are selectable.
const outlookRuntime = { card: null, frame: 0, resize: null, display: null, signature: '', hover: null, focus: null, wheelAt: -Infinity, touchX: null };

function outlookGeometry(card) {
  const plot = card.querySelector('.outlook-plot');
  const width = Math.max(280, plot.clientWidth);
  const height = Math.max(120, plot.clientHeight);
  const left = 50, right = width - 14;
  const inset = Math.min(75, (right - left) * .12);
  return { width, height, left, right, top: 15, base: height - 23,
    centers: [left + inset, right - inset] };
}

function outlookY(value, max, geometry) {
  return geometry.base - value / max * (geometry.base - geometry.top);
}

// A smooth visual connector between real values, with no additional forecast samples.
function outlookTopPath(left, right, firstY, secondY) {
  const handle = (right - left) * .4;
  return `M${left} ${firstY} C${left + handle} ${firstY} ${right - handle} ${secondY} ${right} ${secondY}`;
}

function outlookBandPath(left, right, upper, lower) {
  const handle = (right - left) * .4;
  return `${outlookTopPath(left, right, upper[0], upper[1])} L${right} ${lower[1]} C${right - handle} ${lower[1]} ${left + handle} ${lower[0]} ${left} ${lower[0]} Z`;
}

function outlookTargetLabel(row) {
  return `+${row.horizonMinutes} min · ${modelTime(row.targetAt)}`;
}

function outlookWindowLabel(row) {
  return `${modelTime(new Date(Date.parse(row.targetAt) - 30 * 60 * 1000))} – ${modelTime(row.targetAt)}`;
}

function outlookAccessibleLabel(row) {
  return `${outlookTargetLabel(row)}. At risk ${outlookFormat(row.atRiskMwh)} MWh. Potential absorption ${outlookFormat(row.potentialRecoveryMwh)} MWh. Remaining at risk ${outlookFormat(row.remainingWasteMwh)} MWh.`;
}

function outlookSvg(rows) {
  return `<svg class="outlook-svg" role="group" aria-label="Energy outlook. Scroll or use arrow keys to select the 30 or 60 minute forecast.">
    <defs><linearGradient id="outlook-risk-fill" x2="0" y2="1"><stop stop-color="#ffba4d" stop-opacity=".49"/><stop offset="1" stop-color="#ffba4d" stop-opacity=".06"/></linearGradient>
      <linearGradient id="outlook-recovery-fill" x2="0" y2="1"><stop stop-color="#24bd88" stop-opacity=".43"/><stop offset="1" stop-color="#24bd88" stop-opacity=".05"/></linearGradient>
      <linearGradient id="outlook-remaining-fill" x2="0" y2="1"><stop stop-color="#f0a54b" stop-opacity=".43"/><stop offset="1" stop-color="#f0a54b" stop-opacity=".08"/></linearGradient></defs>
    <g class="outlook-grid">${Array.from({length: 6}, () => '<g><line class="outlook-gridline"/><text class="outlook-axis-label"></text></g>').join('')}</g>
    <g class="outlook-series">
      <path class="outlook-area is-risk" fill="url(#outlook-risk-fill)"/><path class="outlook-line is-risk"/>
      <path class="outlook-area is-recovery" fill="url(#outlook-recovery-fill)"/><path class="outlook-line is-recovery"/>
      <path class="outlook-area is-remaining" fill="url(#outlook-remaining-fill)"/><path class="outlook-line is-remaining"/>
    </g>
    ${rows.map((row, index) => `<g class="outlook-region" data-outlook-region="${row.horizonMinutes}" tabindex="0" role="button" aria-label="${escapeHtml(outlookAccessibleLabel(row))}">
      <line class="outlook-guide is-${index ? 'recovery' : 'risk'}"/>
      <circle class="outlook-marker is-risk" r="6"/><circle class="outlook-marker is-recovery" r="6"/>
      <rect class="outlook-region-hit" fill="transparent"/>
      <text class="outlook-x-label" text-anchor="middle">${escapeHtml(outlookTargetLabel(row))}</text>
    </g>`).join('')}
    <line class="outlook-selected-line"/>
  </svg>`;
}

function outlookTooltip(row) {
  return `<strong class="outlook-tooltip-time">${escapeHtml(outlookTargetLabel(row))}</strong>
    <span><i class="is-risk"></i>At risk <b class="outlook-tooltip-risk">${outlookFormat(row.atRiskMwh)} MWh</b></span>
    <span><i class="is-recovery"></i>Potential absorption <b class="outlook-tooltip-recovery">${outlookFormat(row.potentialRecoveryMwh)} MWh</b></span>
    <span><i class="is-remaining"></i>Remaining at risk <b class="outlook-tooltip-remaining">${outlookFormat(row.remainingWasteMwh)} MWh</b></span>`;
}

function outlookCallout(row, tone, value, label) {
  return `<div class="outlook-callout is-${tone}" data-outlook-callout="${row.horizonMinutes}" aria-hidden="true"><span class="outlook-callout-time"><i></i>${escapeHtml(outlookWindowLabel(row))}</span><strong class="outlook-callout-value">${outlookFormat(value)} MWh</strong><small>${label}</small></div>`;
}

function outlookCard(prediction) {
  let rows;
  try { rows = outlookRows(modelState.data); outlookScale(rows); }
  catch { return '<section class="dash-card dash-outlook outlook-unavailable" role="alert"><h2>Energy outlook unavailable</h2><p>The forecast values could not be charted. Refresh the forecast to try again.</p></section>'; }
  const selected = rows.find(row => row.horizonMinutes === modelState.horizon) || rows[0];
  const tabs = ['energy', 'recovery'].map(mode => `<button type="button" data-dashboard-mode="${mode}" aria-pressed="${dashboardMode === mode}" class="${dashboardMode === mode ? 'active' : ''}">${mode === 'energy' ? 'Energy risk' : 'Recovery view'}</button>`).join('');
  const summary = (tone, label, value) => `<div class="outlook-summary is-${tone}"><span class="outlook-summary-label">${label}</span><div><strong class="outlook-summary-value" data-outlook-counter="${tone}">${outlookFormat(value)}</strong><span class="outlook-unit"> MWh</span></div><small class="outlook-summary-time">${escapeHtml(outlookWindowLabel(selected))}</small><span class="outlook-mini" data-outlook-mini="${tone}" aria-hidden="true"><i></i><i></i></span></div>`;
  return `<section class="dash-card dash-outlook outlook-card outlook-ready" aria-label="Energy outlook" aria-busy="${modelState.loading}">
    ${cardHead('pulse', 'neutral', 'Energy outlook', 'Scroll between +30 and +60 min · each target covers a half-hour', `<div class="dash-tabs" role="group" aria-label="Energy outlook view">${tabs}</div>`)}
    <div class="outlook-summaries" aria-label="Selected forecast summary">${summary('risk', 'At risk (wasted)', selected.atRiskMwh)}${summary('recovery', 'Potential absorption', selected.potentialRecoveryMwh)}</div>
    <div class="outlook-chart-toolbar"><span class="outlook-axis-title">MWh per half-hour</span><div class="outlook-legend"><span><i class="is-risk"></i><span data-outlook-legend="first">At risk</span></span><span><i class="is-recovery"></i><span data-outlook-legend="second">Potential absorption</span></span></div></div>
    <div class="outlook-plot">${outlookSvg(rows)}${outlookCallout(rows[0], 'risk', rows[0].atRiskMwh, 'At risk of being wasted')}${outlookCallout(rows[1], 'recovery', rows[1].potentialRecoveryMwh, 'Potential absorption')}<div class="outlook-tooltip" aria-hidden="true">${outlookTooltip(selected)}</div></div>
    <div class="dash-insight">${tile('tower', 'amber-soft')}<div><strong class="outlook-context">${settings.cause ? modelCause(prediction) : 'Model context hidden'}</strong><span class="outlook-issued">Prediction issued ${escapeHtml(modelTime(prediction.issuedAt, true))} · Europe/Dublin · Two independent half-hours</span></div><button type="button" data-page="forecast">Explore forecast ${icon('arrow', 16)}</button></div>
    <table class="sr-only outlook-data-table"><caption>Energy outlook forecast values in MWh per half-hour</caption><thead><tr><th>Target</th><th>At risk</th><th>Potential absorption</th><th>Remaining at risk</th></tr></thead><tbody></tbody></table>
  </section>`;
}

function outlookSkeleton() {
  return `<section class="dash-card dash-outlook outlook-skeleton" role="status" aria-label="Loading Energy outlook">
    ${cardHead('pulse', 'neutral', 'Energy outlook', 'Loading two half-hour targets')}
    <div class="outlook-summaries"><span></span><span></span></div><div class="outlook-plot"><div class="outlook-skeleton-grid"></div><div class="outlook-skeleton-area"></div></div>
    <p>Loading forecast and charging scenario…</p></section>`;
}

function outlookCloneDisplay(display) {
  return { rows: display.rows.map(row => ({ ...row })), max: display.max, mix: display.mix, selection: display.selection };
}

function outlookInterpolate(from, to, fraction) {
  const between = (a, b) => a + (b - a) * fraction;
  return { rows: to.rows.map((row, index) => ({ ...row,
      atRiskMwh: between(from.rows[index].atRiskMwh, row.atRiskMwh),
      potentialRecoveryMwh: between(from.rows[index].potentialRecoveryMwh, row.potentialRecoveryMwh),
      remainingWasteMwh: between(from.rows[index].remainingWasteMwh, row.remainingWasteMwh) })),
    max: between(from.max, to.max), mix: between(from.mix, to.mix), selection: between(from.selection, to.selection) };
}

function outlookPaint(card, display) {
  const geometry = outlookRuntime.geometry, svg = card.querySelector('.outlook-svg');
  svg.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`);
  card.querySelectorAll('.outlook-grid > g').forEach((group, index) => {
    const fraction = index / 5, y = outlookY(display.max * fraction, display.max, geometry);
    const line = group.querySelector('line'), label = group.querySelector('text');
    line.setAttribute('x1', geometry.left); line.setAttribute('x2', geometry.right);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    label.setAttribute('x', geometry.left - 10); label.setAttribute('y', y + 4);
    label.textContent = outlookFormat(display.max * fraction);
  });
  const [firstX, lastX] = geometry.centers;
  const riskYs = display.rows.map(row => outlookY(row.atRiskMwh, display.max, geometry));
  const recoveryYs = display.rows.map(row => outlookY(row.potentialRecoveryMwh, display.max, geometry));
  const series = card.querySelector('.outlook-series');
  const riskLine = outlookTopPath(firstX, lastX, ...riskYs);
  const recoveryLine = outlookTopPath(firstX, lastX, ...recoveryYs);
  const closeArea = line => `${line} L${lastX} ${geometry.base} H${firstX} Z`;
  series.querySelector('.outlook-area.is-risk').setAttribute('d', closeArea(riskLine));
  series.querySelector('.outlook-line.is-risk').setAttribute('d', riskLine);
  series.querySelector('.outlook-area.is-recovery').setAttribute('d', closeArea(recoveryLine));
  series.querySelector('.outlook-line.is-recovery').setAttribute('d', recoveryLine);
  series.querySelector('.outlook-area.is-remaining').setAttribute('d', outlookBandPath(firstX, lastX, riskYs, recoveryYs));
  series.querySelector('.outlook-line.is-remaining').setAttribute('d', riskLine);
  series.querySelector('.outlook-area.is-risk').style.opacity = 1 - .88 * display.mix;
  series.querySelector('.outlook-line.is-risk').style.opacity = 1 - .78 * display.mix;
  series.querySelector('.outlook-area.is-remaining').style.opacity = display.mix;
  series.querySelector('.outlook-line.is-remaining').style.opacity = display.mix;
  display.rows.forEach((row, index) => {
    const group = card.querySelector(`[data-outlook-region="${row.horizonMinutes}"]`);
    const center = geometry.centers[index], middle = (geometry.left + geometry.right) / 2;
    const left = index ? middle : geometry.left, right = index ? geometry.right : middle;
    const riskY = riskYs[index], recoveryY = recoveryYs[index];
    const riskMarker = group.querySelector('.outlook-marker.is-risk');
    const recoveryMarker = group.querySelector('.outlook-marker.is-recovery');
    riskMarker.setAttribute('cx', center); riskMarker.setAttribute('cy', riskY);
    recoveryMarker.setAttribute('cx', center); recoveryMarker.setAttribute('cy', recoveryY);
    riskMarker.setAttribute('r', 5 + 2 * (index ? display.selection : 1 - display.selection));
    recoveryMarker.setAttribute('r', 4 + 2 * (index ? display.selection : 1 - display.selection));
    const hit = group.querySelector('.outlook-region-hit');
    hit.setAttribute('x', left); hit.setAttribute('y', geometry.top);
    hit.setAttribute('width', right - left); hit.setAttribute('height', geometry.base - geometry.top + 12);
    const guide = group.querySelector('.outlook-guide');
    guide.setAttribute('x1', center); guide.setAttribute('x2', center);
    guide.setAttribute('y1', 0); guide.setAttribute('y2', geometry.base);
    const xLabel = group.querySelector('.outlook-x-label');
    xLabel.setAttribute('x', center); xLabel.setAttribute('y', geometry.height - 3);
    const callout = card.querySelector(`[data-outlook-callout="${row.horizonMinutes}"]`);
    callout.style.left = `${center / geometry.width * 100}%`;
    callout.querySelector('.outlook-callout-value').textContent = `${outlookFormat(index ? row.potentialRecoveryMwh : row.atRiskMwh)} MWh`;
  });
  const selectedLine = card.querySelector('.outlook-selected-line');
  const center = geometry.centers[0] + (geometry.centers[1] - geometry.centers[0]) * display.selection;
  selectedLine.setAttribute('x1', center); selectedLine.setAttribute('x2', center);
  selectedLine.setAttribute('y1', geometry.top); selectedLine.setAttribute('y2', geometry.base);
  const summaryRisk = display.rows[0].atRiskMwh + (display.rows[1].atRiskMwh - display.rows[0].atRiskMwh) * display.selection;
  const summaryRecovery = display.rows[0].potentialRecoveryMwh + (display.rows[1].potentialRecoveryMwh - display.rows[0].potentialRecoveryMwh) * display.selection;
  card.querySelector('[data-outlook-counter="risk"]').textContent = outlookFormat(Math.max(0, summaryRisk));
  card.querySelector('[data-outlook-counter="recovery"]').textContent = outlookFormat(Math.max(0, summaryRecovery));
  for (const tone of ['risk', 'recovery']) {
    card.querySelectorAll(`[data-outlook-mini="${tone}"] i`).forEach((bar, index) => {
      const value = tone === 'risk' ? display.rows[index].atRiskMwh : display.rows[index].potentialRecoveryMwh;
      bar.style.setProperty('--level', String(Math.min(1, value / display.max)));
    });
  }
  outlookRuntime.display = outlookCloneDisplay(display);
  outlookUpdateTooltip(card);
}

function outlookUpdateTooltip(card) {
  if (!outlookRuntime.display) return;
  const display = outlookRuntime.display;
  const selectedIndex = display.selection >= .5 ? 1 : 0;
  const activeTarget = outlookRuntime.focus ?? outlookRuntime.hover;
  const index = activeTarget == null ? selectedIndex : display.rows.findIndex(row => row.horizonMinutes === activeTarget);
  const row = display.rows[Math.max(0, index)];
  const tooltip = card.querySelector('.outlook-tooltip');
  tooltip.querySelector('.outlook-tooltip-time').textContent = outlookTargetLabel(row);
  tooltip.querySelector('.outlook-tooltip-risk').textContent = `${outlookFormat(row.atRiskMwh)} MWh`;
  tooltip.querySelector('.outlook-tooltip-recovery').textContent = `${outlookFormat(row.potentialRecoveryMwh)} MWh`;
  tooltip.querySelector('.outlook-tooltip-remaining').textContent = `${outlookFormat(row.remainingWasteMwh)} MWh`;
  tooltip.style.left = `${outlookRuntime.geometry.centers[Math.max(0, index)] / outlookRuntime.geometry.width * 100}%`;
  tooltip.classList.toggle('is-visible', activeTarget != null);
}

function outlookSyncStatic(card, rows) {
  const selected = rows.find(row => row.horizonMinutes === modelState.horizon) || rows[0];
  card.setAttribute('aria-busy', String(modelState.loading));
  card.querySelectorAll('[data-dashboard-mode]').forEach(button => {
    const active = button.dataset.dashboardMode === dashboardMode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  const firstLegend = card.querySelector('[data-outlook-legend="first"]');
  const secondLegend = card.querySelector('[data-outlook-legend="second"]');
  firstLegend.textContent = dashboardMode === 'energy' ? 'At risk' : 'Potential absorption';
  secondLegend.textContent = dashboardMode === 'energy' ? 'Potential absorption' : 'Remaining at risk';
  firstLegend.previousElementSibling.className = dashboardMode === 'energy' ? 'is-risk' : 'is-recovery';
  secondLegend.previousElementSibling.className = dashboardMode === 'energy' ? 'is-recovery' : 'is-remaining';
  card.querySelectorAll('.outlook-summary-time').forEach(node => { node.textContent = outlookWindowLabel(selected); });
  card.querySelectorAll('.outlook-region').forEach(group => {
    const row = rows.find(item => item.horizonMinutes === Number(group.dataset.outlookRegion));
    group.setAttribute('aria-label', outlookAccessibleLabel(row));
    group.setAttribute('aria-pressed', String(row.horizonMinutes === modelState.horizon));
    group.querySelector('.outlook-x-label').textContent = outlookTargetLabel(row);
    card.querySelector(`[data-outlook-callout="${row.horizonMinutes}"] .outlook-callout-time`).lastChild.textContent = outlookWindowLabel(row);
  });
  card.querySelector('.outlook-context').textContent = settings.cause ? modelCause(selectedPrediction()) : 'Model context hidden';
  card.querySelector('.outlook-issued').textContent = `Prediction issued ${modelTime(selected.issuedAt, true)} · Europe/Dublin · Two independent half-hours`;
  card.querySelector('.outlook-data-table tbody').innerHTML = rows.map(row => `<tr><th>+${row.horizonMinutes} min, ${escapeHtml(modelTime(row.targetAt))}</th><td>${outlookFormat(row.atRiskMwh)} MWh</td><td>${outlookFormat(row.potentialRecoveryMwh)} MWh</td><td>${outlookFormat(row.remainingWasteMwh)} MWh</td></tr>`).join('');
}

function outlookTeardown() {
  if (outlookRuntime.frame) cancelAnimationFrame(outlookRuntime.frame);
  outlookRuntime.resize?.disconnect();
  outlookRuntime.card = null; outlookRuntime.frame = 0; outlookRuntime.resize = null;
  outlookRuntime.display = null; outlookRuntime.signature = ''; outlookRuntime.hover = null; outlookRuntime.focus = null;
  outlookRuntime.wheelAt = -Infinity; outlookRuntime.wheelDelta = 0; outlookRuntime.touchX = null;
}

function outlookSync(card) {
  let rows, scale;
  try { rows = outlookRows(modelState.data); scale = outlookScale(rows); }
  catch { outlookTeardown(); return; }
  const selectedIndex = Math.max(0, rows.findIndex(row => row.horizonMinutes === modelState.horizon));
  const target = { rows, max: scale.max, mix: dashboardMode === 'recovery' ? 1 : 0, selection: selectedIndex };
  const signature = JSON.stringify([rows, scale.max, dashboardMode, modelState.horizon]);
  const first = outlookRuntime.card !== card;
  if (first) {
    outlookTeardown(); outlookRuntime.card = card;
    outlookRuntime.geometry = outlookGeometry(card);
    outlookRuntime.resize = new ResizeObserver(() => {
      if (outlookRuntime.card !== card || !card.isConnected) return;
      outlookRuntime.geometry = outlookGeometry(card);
      if (outlookRuntime.display) outlookPaint(card, outlookRuntime.display);
    });
    outlookRuntime.resize.observe(card.querySelector('.outlook-plot'));
  }
  outlookSyncStatic(card, rows);
  if (!first && signature === outlookRuntime.signature) return;
  if (outlookRuntime.frame) cancelAnimationFrame(outlookRuntime.frame);
  outlookRuntime.frame = 0; outlookRuntime.signature = signature;
  if (first || !outlookRuntime.display || matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) {
    outlookPaint(card, target);
    if (first) card.classList.add('is-entering');
    return;
  }
  const start = outlookCloneDisplay(outlookRuntime.display), begin = performance.now(), duration = 560;
  card.classList.add('is-updating');
  function step(now) {
    if (outlookRuntime.card !== card || !card.isConnected) { outlookTeardown(); return; }
    const progress = Math.min(1, (now - begin) / duration);
    const eased = 1 - (1 - progress) ** 3;
    outlookPaint(card, outlookInterpolate(start, target, eased));
    if (progress < 1) outlookRuntime.frame = requestAnimationFrame(step);
    else { outlookRuntime.frame = 0; card.classList.remove('is-updating'); }
  }
  outlookRuntime.frame = requestAnimationFrame(step);
}

function outlookSelect(horizon, keepFocus = false) {
  if (![30, 60].includes(horizon) || modelState.horizon === horizon) return;
  modelState.horizon = horizon;
  render();
  if (keepFocus) document.querySelector(`.outlook-card [data-outlook-region="${horizon}"]`)?.focus({ preventScroll: true });
}

document.addEventListener('click', event => {
  const mode = event.target.closest('[data-dashboard-mode]');
  if (mode && mode.closest('.outlook-card')) {
    if (dashboardMode !== mode.dataset.dashboardMode) { dashboardMode = mode.dataset.dashboardMode; outlookSync(mode.closest('.outlook-card')); }
    return;
  }
  const target = event.target.closest('[data-outlook-region]');
  if (!target || !target.closest('.outlook-card')) return;
  const horizon = Number(target.dataset.outlookRegion);
  outlookSelect(horizon);
});

document.addEventListener('keydown', event => {
  const region = event.target.closest('[data-outlook-region]');
  if (!region || !['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const horizon = ['ArrowLeft', 'ArrowUp', 'Home'].includes(event.key) ? 30
    : ['ArrowRight', 'ArrowDown', 'End'].includes(event.key) ? 60 : Number(region.dataset.outlookRegion);
  outlookSelect(horizon, true);
});

document.addEventListener('wheel', event => {
  if (event.ctrlKey || !event.target.closest('.outlook-plot')) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  event.preventDefault();
  const now = performance.now();
  if (now - outlookRuntime.wheelAt > 250 || Math.sign(delta) !== Math.sign(outlookRuntime.wheelDelta || 0)) outlookRuntime.wheelDelta = 0;
  outlookRuntime.wheelAt = now;
  outlookRuntime.wheelDelta += delta * (event.deltaMode === 1 ? 16 : 1);
  if (Math.abs(outlookRuntime.wheelDelta) < 12) return;
  const horizon = outlookRuntime.wheelDelta > 0 ? 60 : 30;
  outlookRuntime.wheelDelta = 0;
  outlookSelect(horizon);
}, { passive: false });

document.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch' && event.target.closest('.outlook-plot')) outlookRuntime.touchX = event.clientX;
});
document.addEventListener('pointerup', event => {
  if (outlookRuntime.touchX == null) return;
  const distance = event.clientX - outlookRuntime.touchX;
  outlookRuntime.touchX = null;
  if (Math.abs(distance) > 30) outlookSelect(distance < 0 ? 60 : 30);
});
document.addEventListener('pointercancel', () => { outlookRuntime.touchX = null; });

document.addEventListener('pointerover', event => {
  const target = event.target.closest('[data-outlook-region]');
  if (!target || !target.closest('.outlook-card')) return;
  outlookRuntime.hover = Number(target.dataset.outlookRegion);
  outlookUpdateTooltip(target.closest('.outlook-card'));
});
document.addEventListener('pointerout', event => {
  const target = event.target.closest('[data-outlook-region]');
  if (!target || target.contains(event.relatedTarget)) return;
  outlookRuntime.hover = null;
  const card = target.closest('.outlook-card'); if (card) outlookUpdateTooltip(card);
});
document.addEventListener('focusin', event => {
  const target = event.target.closest('[data-outlook-region]');
  if (!target || !target.closest('.outlook-card')) return;
  outlookRuntime.focus = Number(target.dataset.outlookRegion);
  outlookUpdateTooltip(target.closest('.outlook-card'));
});
document.addEventListener('focusout', event => {
  const card = event.target.closest('.outlook-card');
  if (!card) return;
  outlookRuntime.focus = null; outlookUpdateTooltip(card);
});
