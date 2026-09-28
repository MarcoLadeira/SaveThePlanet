// Dashboard: energy at risk + forecast confidence (left) | battery (middle) | flexible charging + next move (right).
// The battery, flexible charging and next-move cards and their charts are in bridge.js.
function dashboardHero(p){
  return `<section class="dash-card dash-hero">${cardHead('orange','Renewable energy at risk','Forecast of renewable energy that may be switched off and wasted')}
    <div class="hero-body"><div class="hero-figure"><strong>${n(p.atRiskMwh)}<small>MWh</small></strong><span class="hero-kwh">= ${n(Math.round(p.atRiskMwh*1000))} kWh</span><p>At risk of being wasted<br>+${p.horizonMinutes} min · ${escapeHtml(targetWindow(p))}</p></div>${chartSlot('likelihood',`${Math.round(p.probability*100)}% likelihood of dispatch-down, ${p.risk} risk`,'hero-gauge')}</div>
    <div class="dash-hero-stats"><div><span>Forecast for</span><strong>${escapeHtml(modelTime(p.targetAt,true))}</strong></div><div><span>How far ahead</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Likely range</span><strong>${n(p.lowerMwh)}–${n(p.upperMwh)} MWh</strong></div></div>
  </section>`;
}

function dashboardConfidence(p){
  const legend='<div class="confidence-legend"><span><i class="is-range"></i>Likely range</span><span><i class="is-expected"></i>Expected</span></div>';
  return `<section class="dash-card dash-confidence">${cardHead('orange','Forecast confidence','Energy at risk (MWh) for the selected half-hour, forecast 30 and 60 minutes before it: the expected value and the range it will likely fall in',legend)}${chartSlot('confidence','Forecast targets','confidence-chart','group')}</section>`;
}

function renderDashboard() {
  return studioShell('Dashboard', 'How much renewable energy may be wasted, how the battery routes it, and which EVs charge with it.', () => {
    const p = selectedPrediction();
    return `<div class="dash-grid restored-dashboard dashboard-redesign bridge-layout">
      <svg class="dashboard-flow-links" aria-hidden="true" preserveAspectRatio="none"></svg>
      ${dashboardHero(p)}
      ${dashboardConfidence(p)}
      ${dashboardBattery()}
      ${dashboardFlexible()}
      ${dashboardNextMove()}
    </div>${provenance()}`;
  });
}
