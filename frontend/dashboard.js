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

function dashboardFleet(o){
  const flex=modelState.data.scenario.flexibleDemandMwh,capacity=modelState.data.flexibleCapacityMw;
  const power=Math.min(capacity,Math.max(0,o.proposedPowerMw));
  return `<section class="dash-card dash-fleet">${cardHead('green','Flexible charging','Scenario input, not vehicle telemetry')}
    <div class="fleet-body"><div class="fleet-demand"><p class="fleet-figure"><strong>${n(flex)}</strong><span>MWh</span></p><p class="fleet-caption">Flexible demand</p></div><span class="fleet-scene" aria-hidden="true"><img src="./charging-scene.webp?v=20260927a" alt="" width="799" height="516" decoding="async" draggable="false"></span></div>
    <div class="fleet-meter"><div class="fleet-meter-head"><span id="fleet-power-label">Proposed power</span><span><b>${n(o.proposedPowerMw)}</b> of ${n(capacity)} MW</span></div><div class="fleet-track" role="meter" aria-labelledby="fleet-power-label" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${power}" aria-valuetext="${n(o.proposedPowerMw)} of ${n(capacity)} MW" style="--fleet-fill:${fleetShare(power,capacity)}"><i></i><b></b></div></div>
    <div class="fleet-stats">${fleetStat('green','charge',o.potentialRecoveryMwh,'Absorbable',fleetShare(o.potentialRecoveryMwh,flex))}${fleetStat('orange','clock',o.remainingFlexibleMwh,'Flexibility left',fleetShare(o.remainingFlexibleMwh,flex))}</div>
  </section>`;
}

function dashboardRecoveryChannel(p,o){
  const ratio=p.atRiskMwh?o.potentialRecoveryMwh/p.atRiskMwh:0;
  const green=Math.min(100,Math.max(0,ratio*100));
  return `<div class="dash-recovery-channel" role="img" aria-label="${n(o.potentialRecoveryMwh)} MWh recoverable of ${n(p.atRiskMwh)} MWh at risk"><div class="dash-channel-label"><strong>${pct(o.recoveryRate)}</strong><span>of risk can be absorbed</span></div><div class="dash-channel-bed"><div class="dash-channel-fill" style="width:${green}%"></div></div><div class="dash-channel-foot"><span>${n(o.potentialRecoveryMwh)} MWh potential</span><span>${n(o.remainingWasteMwh)} MWh remaining</span></div></div>`;
}

function dashboardPlan(p,o){
  const bars=[['risk','At risk',p.atRiskMwh],['flex','Flexible',modelState.data.scenario.flexibleDemandMwh],['recovery','Absorbable',o.potentialRecoveryMwh]];
  const max=Math.max(...bars.map(([,,value])=>value));
  return `<section class="dash-card dash-plan">${cardHead('tricolour','Your next move','Scenario recommendation')}
    <h3 class="plan-headline">Use up to <em>${n(o.potentialRecoveryMwh)} MWh</em> of flexible charging at <em>${escapeHtml(modelTime(p.targetAt))}</em>.</h3>
    <div class="plan-chart" role="img" aria-label="${bars.map(([,label,value])=>`${label} ${n(value)} MWh`).join(', ')}"><div class="plan-bars">${bars.map(([key,,value],i)=>`<div class="plan-bar is-${key}" style="--plan-h:${max>0?value/max:0};--plan-delay:${i*.08}s"><span class="plan-bar-value"><strong>${n(value)}</strong>MWh</span><i></i></div>`).join('')}</div><div class="plan-labels">${bars.map(([,label])=>`<span>${label}</span>`).join('')}</div></div>
    <button class="plan-cta" type="button" data-page="charging">Review charging scenario ${icon('arrow',20)}</button>
  </section>`;
}

function dashboardHero(p){
  return `<section class="dash-card dash-hero">${cardHead('orange','Renewable energy at risk','<i class="live-dot"></i>Live · selected half-hour forecast')}
    <div class="hero-body"><div class="hero-figure"><strong>${n(p.atRiskMwh)}<small>MWh</small></strong><p>At risk of being wasted<br>+${p.horizonMinutes} min · ${escapeHtml(targetWindow(p))}</p></div>${chartSlot('likelihood',`${Math.round(p.probability*100)}% likelihood of dispatch-down, ${p.risk} risk`,'hero-gauge')}</div>
    <div class="dash-hero-stats"><div><span>Forecast target</span><strong>${escapeHtml(modelTime(p.targetAt))}</strong></div><div><span>Horizon</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Likely range</span><strong>${n(p.lowerMwh)}–${n(p.upperMwh)} MWh</strong></div></div>
  </section>`;
}

function dashboardCauses(p){
  return `<section class="dash-card dash-causes">${cardHead('orange','What drives the risk','Predicted components of energy at risk')}${chartSlot('causes',`Grid constraint ${n(p.constraintMwh)} MWh and curtailment ${n(p.curtailmentMwh)} MWh`,'causes-chart')}</section>`;
}

function dashboardConfidence(p){
  const legend='<div class="confidence-legend"><span><i class="is-range"></i>Likely range</span><span><i class="is-expected"></i>Expected</span></div>';
  return `<section class="dash-card dash-confidence">${cardHead('orange','Forecast confidence','Expected energy at risk and its likely range for each half-hour',legend)}${chartSlot('confidence','Forecast targets','confidence-chart','group')}</section>`;
}

function renderDashboard(){
  return studioShell('Dashboard','Renewable dispatch-down and flexible charging opportunity.',()=>{
    const p=selectedPrediction(),o=scenarioOutcome(p);
    return `<div class="dash-grid restored-dashboard dashboard-redesign">
      ${dashboardHero(p)}
      ${dashboardCauses(p)}
      ${dashboardFleet(o)}
      ${dashboardConfidence(p)}
      ${dashboardPlan(p,o)}
    </div>${provenance()}`;
  });
}
