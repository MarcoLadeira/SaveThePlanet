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
  return `<section class="dash-card dash-fleet">${cardHead('green','Flexible charging','EV charging that can be moved in time · assumed, not measured')}
    <div class="fleet-body">${chartSlot('fleetDemand','Flexible demand','fleet-demand','group')}<span class="fleet-scene" aria-hidden="true"><img src="./charging-scene.webp?v=20260927a" alt="" width="799" height="516" decoding="async" draggable="false"></span></div>
    ${chartSlot('fleetPower','Proposed power','fleet-meter','group')}
    ${chartSlot('fleetSplit','How flexible demand splits','fleet-stats','group')}
  </section>`;
}

function dashboardRecoveryChannel(p,o){
  const ratio=p.atRiskMwh?o.potentialRecoveryMwh/p.atRiskMwh:0;
  const green=Math.min(100,Math.max(0,ratio*100));
  return `<div class="dash-recovery-channel" role="img" aria-label="${n(o.potentialRecoveryMwh)} MWh recoverable of ${n(p.atRiskMwh)} MWh at risk"><div class="dash-channel-label"><strong>${pct(o.recoveryRate)}</strong><span>of risk can be absorbed</span></div><div class="dash-channel-bed"><div class="dash-channel-fill" style="width:${green}%"></div></div><div class="dash-channel-foot"><span>${n(o.potentialRecoveryMwh)} MWh potential</span><span>${n(o.remainingWasteMwh)} MWh remaining</span></div></div>`;
}

function dashboardPlan(p,o){
  const label=`At risk ${n(p.atRiskMwh)} MWh, flexible ${n(modelState.data.scenario.flexibleDemandMwh)} MWh, absorbable ${n(o.potentialRecoveryMwh)} MWh`;
  return `<section class="dash-card dash-plan">${cardHead('tricolour','Your next move','Suggested action for the selected half-hour')}
    ${chartSlot('planHeadline','Recommendation','plan-headline-slot','group')}
    ${chartSlot('planBars',label,'plan-chart')}
    <button class="plan-cta" type="button" data-page="charging">Review charging scenario ${icon('arrow',20)}</button>
  </section>`;
}

function dashboardHero(p){
  return `<section class="dash-card dash-hero">${cardHead('orange','Renewable energy at risk','Forecast of renewable energy that may be switched off and wasted')}
    <div class="hero-body"><div class="hero-figure"><strong>${n(p.atRiskMwh)}<small>MWh</small></strong><p>At risk of being wasted<br>+${p.horizonMinutes} min · ${escapeHtml(targetWindow(p))}</p></div>${chartSlot('likelihood',`${Math.round(p.probability*100)}% likelihood of dispatch-down, ${p.risk} risk`,'hero-gauge')}</div>
    <div class="dash-hero-stats"><div><span>Forecast for</span><strong>${escapeHtml(modelTime(p.targetAt))}</strong></div><div><span>How far ahead</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Likely range</span><strong>${n(p.lowerMwh)}–${n(p.upperMwh)} MWh</strong></div></div>
  </section>`;
}

function dashboardCauses(p){
  return `<section class="dash-card dash-causes">${cardHead('orange','Why it is at risk','Constraint: local network full · Curtailment: system-wide limit')}${chartSlot('causes',`Grid constraint ${n(p.constraintMwh)} MWh and curtailment ${n(p.curtailmentMwh)} MWh`,'causes-chart')}</section>`;
}

function dashboardConfidence(p){
  const legend='<div class="confidence-legend"><span><i class="is-range"></i>Likely range</span><span><i class="is-expected"></i>Expected</span></div>';
  return `<section class="dash-card dash-confidence">${cardHead('orange','Forecast confidence','Energy at risk (MWh) for each forecast half-hour: the expected value and the range it will likely fall in',legend)}${chartSlot('confidence','Forecast targets','confidence-chart','group')}</section>`;
}

function renderDashboard(){
  return studioShell('Dashboard','How much renewable energy may be wasted, and how much flexible EV charging could use it.',()=>{
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
