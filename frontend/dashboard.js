let dashboardMode='energy';

function dashIsoBar(cx,base,width,height,part=''){
  const d=width/2,top=base-height;
  return `<polygon class="${part} l" points="${cx-width},${top} ${cx},${top+d} ${cx},${base+d} ${cx-width},${base}"/><polygon class="${part} r" points="${cx},${top+d} ${cx+width},${top} ${cx+width},${base} ${cx},${base+d}"/><polygon class="${part} t" points="${cx},${top-d} ${cx+width},${top} ${cx},${top+d} ${cx-width},${top}"/>`;
}

function fleetShare(value,total){return total>0?Math.min(1,Math.max(0,value/total)):0}

function fleetStat(tone,glyph,value,label,share){
  const percent=Math.round(share*100);
  return `<div class="fleet-stat is-${tone}"><span class="fleet-stat-icon">${icon(glyph,18)}</span><div class="fleet-stat-copy"><strong>${n(value)} MWh</strong><small>${label}</small><span class="fleet-stat-bar" role="img" aria-label="${percent}% of flexible demand" style="--fleet-fill:${share}"><i></i></span></div></div>`;
}

function dashboardFleet(){
  return `<section class="dash-card dash-fleet">${cardHead('green','Flexible charging','Scenario input, not vehicle telemetry')}
    <div class="fleet-body">${chartSlot('fleetDemand','Flexible demand','fleet-demand','group')}<span class="fleet-scene" aria-hidden="true"><img src="./charging-scene.webp?v=20260927a" alt="" width="799" height="516" decoding="async" draggable="false"></span></div>
    ${chartSlot('fleetPower','Proposed power','fleet-meter','group')}
    ${chartSlot('fleetSplit','How flexible demand splits','fleet-stats','group')}
  </section>`;
}

function dashboardRecoveryChannel(p,o){
  const ratio=p.atRiskMwh?o.potentialRecoveryMwh/p.atRiskMwh:0;
  const green=Math.min(100,Math.max(0,ratio*100));
  return `<div class="dash-recovery-channel" role="img" aria-label="At most ${n(o.potentialRecoveryMwh)} MWh of ${n(p.atRiskMwh)} MWh at risk could be used by flexible charging (upper bound)"><div class="dash-channel-label"><strong>${pct(o.recoveryRate)}</strong><span>of risk is the charging upper bound</span></div><div class="dash-channel-bed"><div class="dash-channel-fill" style="width:${green}%"></div></div><div class="dash-channel-foot"><span>${n(o.potentialRecoveryMwh)} MWh potential</span><span>${n(o.remainingWasteMwh)} MWh remaining</span></div></div>`;
}

function dashboardPlan(p,o){
  const label=`At risk ${n(p.atRiskMwh)} MWh, flexible ${n(modelState.data.scenario.flexibleDemandMwh)} MWh, upper bound ${n(o.potentialRecoveryMwh)} MWh`;
  return `<section class="dash-card dash-plan">${cardHead('tricolour','Your next move','Scenario recommendation')}
    ${chartSlot('planHeadline','Recommendation','plan-headline-slot','group')}
    ${chartSlot('planBars',label,'plan-chart')}
    <p class="plan-caveat">Upper bound: assumes chargers are connected where and when the dispatch-down happens. Location, local grid constraints, fleet connection, charging power and response time can reduce it.</p>
    <button class="plan-cta" type="button" data-page="charging">Review charging scenario ${icon('arrow',20)}</button>
  </section>`;
}

function dashboardHero(p){
  return `<section class="dash-card dash-hero">${cardHead('orange','Renewable energy at risk','Selected half-hour model forecast')}
    <div class="hero-body"><div class="hero-figure"><strong>${n(p.atRiskMwh)}<small>MWh</small></strong><p>At risk of being wasted<br>+${p.horizonMinutes} min · ${escapeHtml(targetWindow(p))}</p></div>${chartSlot('likelihood',`${Math.round(p.probability*100)}% likelihood of dispatch-down, ${p.risk} risk`,'hero-gauge')}</div>
    <div class="dash-hero-stats"><div><span>Forecast target</span><strong>${escapeHtml(modelTime(p.targetAt,true))}</strong></div><div><span>Horizon</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Likely range</span><strong>${n(p.lowerMwh)}–${n(p.upperMwh)} MWh</strong></div></div>
  </section>`;
}

function dashboardCauses(p){
  return `<section class="dash-card dash-causes">${cardHead('orange','What drives the risk','Predicted components of energy at risk')}${chartSlot('causes',`Grid constraint ${n(p.constraintMwh)} MWh and curtailment ${n(p.curtailmentMwh)} MWh`,'causes-chart')}</section>`;
}

function dashboardConfidence(p){
  const legend='<div class="confidence-legend"><span><i class="is-range"></i>Likely range</span><span><i class="is-expected"></i>Expected</span></div>';
  return `<section class="dash-card dash-confidence">${cardHead('orange','Forecast confidence','Two forecasts of the same half-hour: expected energy at risk and its likely range',legend)}${chartSlot('confidence','Forecast targets','confidence-chart','group')}</section>`;
}

function renderDashboard(){
  return studioShell('Dashboard','Renewable dispatch-down and flexible charging opportunity.',()=>{
    const p=selectedPrediction(),o=scenarioOutcome(p);
    return `<div class="dash-grid restored-dashboard dashboard-redesign">
      ${dashboardHero(p)}
      ${dashboardCauses(p)}
      ${dashboardFleet()}
      ${dashboardConfidence(p)}
      ${dashboardPlan(p,o)}
    </div>${provenance()}`;
  });
}
