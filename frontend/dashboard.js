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
  return `<section class="dash-card dash-fleet">${cardHead('car','sky','Flexible charging','Scenario input, not vehicle telemetry')}
    <div class="fleet-body"><div class="fleet-demand"><p class="fleet-figure"><strong>${n(flex)}</strong><span>MWh</span></p><p class="fleet-caption">Flexible demand</p></div><span class="fleet-scene" aria-hidden="true"><img src="./charging-scene.webp?v=20260927a" alt="" width="799" height="516" decoding="async" draggable="false"></span></div>
    <div class="fleet-meter"><div class="fleet-meter-head"><span id="fleet-power-label">Proposed power</span><span><b>${n(o.proposedPowerMw)}</b> of ${n(capacity)} MW</span></div><div class="fleet-track" role="meter" aria-labelledby="fleet-power-label" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${power}" aria-valuetext="${n(o.proposedPowerMw)} of ${n(capacity)} MW" style="--fleet-fill:${fleetShare(power,capacity)}"><i></i><b></b></div></div>
    <div class="fleet-stats">${fleetStat('green','charge',o.potentialRecoveryMwh,'Absorbable',fleetShare(o.potentialRecoveryMwh,flex))}${fleetStat('blue','clock',o.remainingFlexibleMwh,'Flexibility left',fleetShare(o.remainingFlexibleMwh,flex))}</div>
  </section>`;
}

function dashboardRiskSurface(width = 320, height = 110){
  let rows,max;
  try { rows=outlookRows(modelState.data);max=outlookScale(rows).max; }
  catch { return '<p role="status">Chart unavailable</p>'; }
  const top=10,base=height-20,ax=24,bx=width-24;
  const y=value=>base-value/max*(base-top);
  const risk=rows.map(row=>y(row.atRiskMwh)),recovery=rows.map(row=>y(row.potentialRecoveryMwh));
  const line=values=>outlookTopPath(ax,bx,...values),area=values=>`${line(values)} L${bx} ${base} H${ax}Z`;
  const selected=rows.findIndex(row=>row.horizonMinutes===modelState.horizon),selectedX=selected?bx:ax;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${rows.map(row=>`+${row.horizonMinutes} minutes: at risk ${n(row.atRiskMwh)} MWh, absorbable ${n(row.potentialRecoveryMwh)} MWh`).join('. ')}">
    <defs><linearGradient id="hero-risk-fill" x2="0" y2="1"><stop stop-color="#ffbf5d" stop-opacity=".7"/><stop offset="1" stop-color="#ffbf5d" stop-opacity=".04"/></linearGradient><linearGradient id="hero-save-fill" x2="0" y2="1"><stop stop-color="#39d7a6" stop-opacity=".55"/><stop offset="1" stop-color="#39d7a6" stop-opacity=".03"/></linearGradient></defs>
    ${[top,(top+base)/2,base].map(gy=>`<path d="M${ax} ${gy}H${bx}" stroke="#2f6957" stroke-width="1"/>`).join('')}
    <path d="${area(risk)}" fill="url(#hero-risk-fill)"/><path d="${area(recovery)}" fill="url(#hero-save-fill)"/>
    <path d="${line(risk)}" stroke="#ffbe4d" stroke-width="2" fill="none"/><path d="${line(recovery)}" stroke="#33d59f" stroke-width="2" fill="none"/>
    <path d="M${selectedX} ${top}V${base}" stroke="#b8e7cf" stroke-dasharray="3 4"/>
    ${rows.map((row,i)=>`<circle cx="${i?bx:ax}" cy="${risk[i]}" r="${i===selected?5:4}" fill="#fff" stroke="#f9b43e" stroke-width="2"/><circle cx="${i?bx:ax}" cy="${recovery[i]}" r="${i===selected?4:3}" fill="#fff" stroke="#2ac997" stroke-width="2"/><text x="${i?bx:ax}" y="${height-3}" text-anchor="middle" fill="#d9efe5" font-size="10">+${row.horizonMinutes} min</text>`).join('')}
  </svg>`;
}

function fitDashboardCards(){
  const terrain=document.querySelector('.dashboard-redesign .dash-hero-terrain');
  if(!terrain || !modelState.data)return;
  terrain.innerHTML=dashboardRiskSurface(Math.max(60,terrain.clientWidth),Math.max(40,terrain.clientHeight));
}

function dashboardRecoveryChannel(p,o){
  const ratio=p.atRiskMwh?o.potentialRecoveryMwh/p.atRiskMwh:0;
  const green=Math.min(100,Math.max(0,ratio*100));
  return `<div class="dash-recovery-channel" role="img" aria-label="${n(o.potentialRecoveryMwh)} MWh recoverable of ${n(p.atRiskMwh)} MWh at risk"><div class="dash-channel-label"><strong>${pct(o.recoveryRate)}</strong><span>of risk can be absorbed</span></div><div class="dash-channel-bed"><div class="dash-channel-fill" style="width:${green}%"></div></div><div class="dash-channel-foot"><span>${n(o.potentialRecoveryMwh)} MWh potential</span><span>${n(o.remainingWasteMwh)} MWh remaining</span></div></div>`;
}

function dashboardRecoveryOrbit(p,o){
  const rate=p.atRiskMwh?Math.min(1,Math.max(0,o.potentialRecoveryMwh/p.atRiskMwh)):0;
  return `<div class="recovery-ring" role="img" aria-label="${pct(rate)} of predicted at-risk energy can be absorbed">
    <svg viewBox="0 0 220 220" aria-hidden="true"><defs>
      <linearGradient id="recovery-ring-green" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#15d69c"/><stop offset=".45" stop-color="#00c68b"/><stop offset="1" stop-color="#00bb83"/></linearGradient>
      <radialGradient id="recovery-ring-center"><stop offset=".6" stop-color="#fff"/><stop offset="1" stop-color="#f5fffa"/></radialGradient>
    </defs><circle cx="110" cy="110" r="104" fill="url(#recovery-ring-center)" stroke="#edfff6" stroke-width="7"/>
    <circle cx="110" cy="110" r="89" fill="none" stroke="#e4f4ec" stroke-width="26"/>
    <circle class="recovery-ring-progress" cx="110" cy="110" r="89" fill="none" stroke="url(#recovery-ring-green)" stroke-width="26" stroke-linecap="round" pathLength="100" stroke-dasharray="${rate*100} 100" stroke-opacity="${rate?1:0}" transform="rotate(-90 110 110)"/>
    </svg><div class="recovery-ring-label"><strong>${pct(rate)}</strong><span>can be absorbed</span></div>
  </div>`;
}

function dashboardRecoveryCard(p,o){
  const rate=p.atRiskMwh?Math.min(1,Math.max(0,o.potentialRecoveryMwh/p.atRiskMwh)):0;
  const caption=p.atRiskMwh===0?'No predicted at-risk energy for this window.'
    :o.remainingWasteMwh===0?'All predicted at-risk energy can be recovered.'
    :`${pct(rate)} of at-risk energy could be recovered.`;
  return `<section class="dash-card dash-recovery recovery-reference" aria-label="Recovery potential"><div class="recovery-content">
    <header class="recovery-header"><span class="recovery-icon">${icon('leaf',24)}</span><div><h2>Recovery potential</h2><p>Clean energy flexible load could retain</p></div></header>
    <div class="recovery-main"><div class="recovery-copy">
      <div class="recovery-amount"><strong>${n(o.potentialRecoveryMwh)}</strong><span>MWh</span></div>
      <p class="recovery-caption">${caption}</p>
      <ul class="recovery-breakdown"><li class="is-absorbable"><i></i><span>Absorbable</span><b>${n(o.potentialRecoveryMwh)} MWh</b></li><li class="is-remaining"><i></i><span>Still at risk</span><b>${n(o.remainingWasteMwh)} MWh</b></li></ul>
    </div>${dashboardRecoveryOrbit(p,o)}</div>
    <footer class="recovery-bottom"><div class="recovery-progress" role="img" aria-label="${pct(rate)} potentially recoverable"><i style="width:${rate*100}%"></i></div><div class="recovery-totals"><span><b>${n(o.potentialRecoveryMwh)} MWh</b> potential</span><span><b>${n(o.remainingWasteMwh)} MWh</b> remaining</span></div></footer>
  </div></section>`;
}

function dashboardPlan(p,o){
  const bars=[['risk','At risk',p.atRiskMwh],['flex','Flexible',modelState.data.scenario.flexibleDemandMwh],['recovery','Absorbable',o.potentialRecoveryMwh]];
  const max=Math.max(...bars.map(([,,value])=>value));
  return `<section class="dash-card dash-plan">${cardHead('swap','lime','Your next move','Scenario recommendation')}
    <h3 class="plan-headline">Use up to <em>${n(o.potentialRecoveryMwh)} MWh</em> of flexible charging at <em>${escapeHtml(modelTime(p.targetAt))}</em>.</h3>
    <div class="plan-chart" role="img" aria-label="${bars.map(([,label,value])=>`${label} ${n(value)} MWh`).join(', ')}"><div class="plan-bars">${bars.map(([key,,value],i)=>`<div class="plan-bar is-${key}" style="--plan-h:${max>0?value/max:0};--plan-delay:${i*.08}s"><span class="plan-bar-value"><strong>${n(value)}</strong>MWh</span><i></i></div>`).join('')}</div><div class="plan-labels">${bars.map(([,label])=>`<span>${label}</span>`).join('')}</div></div>
    <button class="plan-cta" type="button" data-page="charging">Review charging scenario ${icon('arrow',20)}</button>
  </section>`;
}

function renderDashboard(){
  return studioShell('Dashboard','Renewable dispatch-down and flexible charging opportunity.',()=>{
    const p=selectedPrediction(),o=scenarioOutcome(p);
    return `<div class="dash-grid restored-dashboard dashboard-redesign">
      <section class="dash-card dash-hero">${cardHead('turbine','green','Renewable energy at risk','Selected half-hour model forecast',`<span class="dash-chip is-amber">${n(p.probability*100)}% likely</span>`)}<div class="dash-hero-body"><div class="dash-hero-figure"><strong>${n(p.atRiskMwh)}</strong><span>MWh</span></div><div class="dash-hero-terrain">${dashboardRiskSurface()}</div><div class="dash-hero-legend"><span><i class="is-amber"></i>At risk</span><span><i class="is-green"></i>Absorbable</span></div></div><div class="dash-hero-stats"><div><span>Forecast target</span><strong>${escapeHtml(modelTime(p.targetAt))}</strong></div><div><span>Horizon</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Risk level</span><strong>${escapeHtml(p.risk)}</strong></div></div></section>
      ${dashboardRecoveryCard(p,o)}
      ${dashboardFleet(o)}
      ${outlookCard(p)}
      ${dashboardPlan(p,o)}
    </div>${provenance()}`;
  });
}
