let dashboardMode='energy';

function dashIsoBar(cx,base,width,height,part=''){
  const d=width/2,top=base-height;
  return `<polygon class="${part} l" points="${cx-width},${top} ${cx},${top+d} ${cx},${base+d} ${cx-width},${base}"/><polygon class="${part} r" points="${cx},${top+d} ${cx+width},${top} ${cx+width},${base} ${cx},${base+d}"/><polygon class="${part} t" points="${cx},${top-d} ${cx+width},${top} ${cx},${top+d} ${cx-width},${top}"/>`;
}

function dashboardCharger(){
  return `<svg class="dash-charger dash-ev-scene" viewBox="0 0 300 170" aria-hidden="true" shape-rendering="geometricPrecision"><defs><linearGradient id="ev-deck" x2="0" y2="1"><stop stop-color="#a9e8d4"/><stop offset="1" stop-color="#51bb93"/></linearGradient><linearGradient id="ev-body" x2="0" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#dae7ec"/></linearGradient></defs><ellipse cx="154" cy="152" rx="126" ry="14" fill="#d8ede7"/><path d="m20 117 111-39 150 39-110 43Z" fill="url(#ev-deck)"/><path d="m20 117 151 43v8L20 126Z" fill="#3ca987"/><path d="m171 160 110-43v9l-110 42Z" fill="#21896d"/><ellipse cx="145" cy="123" rx="83" ry="14" fill="#469b88" opacity=".3"/><path d="m55 111 19-27c5-7 18-13 31-15l49-7c11-2 21 0 28 5l27 18 21 7c8 3 12 9 10 16l-5 12-58 11-111-3-11-8Z" fill="url(#ev-body)" stroke="#c6d9e2" stroke-width="2"/><path d="m91 81 16-9 45-6c10-1 17 0 24 6l21 15-49 2-57 2Z" fill="#183e50"/><path d="m152 66 3 22 42-1-21-15c-7-6-14-7-24-6Z" fill="#315a69"/><path d="m91 91 56-2-3 25-71-4Z" fill="#edf5f6"/><path d="m147 89 50-2 25 8-7 21-70-2Z" fill="#f7fbfb"/><path d="m70 113 74 3 72-2 15 6-51 13-105-6Z" fill="#d9e8ed"/><path d="m60 108 12 3-2 8-15-4Z" fill="#2e79aa"/><path d="m213 98 17-2 5 6-15 4Z" fill="#f47768"/><path d="m71 126 107 6 57-14" fill="none" stroke="#a8c4cc" stroke-width="2"/><ellipse cx="92" cy="127" rx="18" ry="12" fill="#183941"/><ellipse cx="92" cy="127" rx="10" ry="9" fill="#c7d8de"/><ellipse cx="92" cy="127" rx="5" ry="5" fill="#829da8"/><ellipse cx="198" cy="128" rx="17" ry="13" fill="#183941"/><ellipse cx="198" cy="128" rx="10" ry="9" fill="#c7d8de"/><ellipse cx="198" cy="128" rx="5" ry="5" fill="#829da8"/><path d="M241 108c18 0 22 10 13 20" fill="none" stroke="#2da978" stroke-width="3"/><rect x="251" y="51" width="27" height="67" rx="4" fill="#eef8f6" stroke="#baded3"/><path d="M251 57h27v53h-27z" fill="#dff2ee"/><rect x="257" y="65" width="15" height="20" rx="2" fill="#155748"/><path d="m267 66-7 11h5l-2 8 9-13h-5l2-6Z" fill="#a5f4cb"/><path d="M264 118v15" stroke="#2f9c78" stroke-width="5"/><ellipse cx="265" cy="133" rx="15" ry="4" fill="#42a986"/></svg>`;
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

function dashboardPillars(p,o){
  const values=[['risk','At risk',p.atRiskMwh],['flex','Flexible',modelState.data.scenario.flexibleDemandMwh],['recovery','Absorbable',o.potentialRecoveryMwh]];
  const max=Math.max(1,...values.map(([, ,v])=>v));
  return `<div class="dash-pillars" role="img" aria-label="${values.map(([,label,value])=>`${label} ${n(value)} MWh`).join(', ')}"><div class="dash-pillar-row">${values.map(([key,,value],i)=>`<div class="dash-pillar is-${key}" style="--h:${value/max};--delay:${i*.1}s"><div class="dash-pillar-value"><strong>${n(value)}</strong><span>MWh</span></div><div class="dash-pillar-body"></div></div>`).join('')}</div><div class="dash-plinth">${values.map(([,label])=>`<span>${label}</span>`).join('')}<i></i><i></i></div></div>`;
}

function renderDashboard(){
  return studioShell('Dashboard','Renewable dispatch-down and flexible charging opportunity.',()=>{
    const p=selectedPrediction(),o=scenarioOutcome(p),flex=modelState.data.scenario.flexibleDemandMwh;
    return `<div class="dash-grid restored-dashboard dashboard-redesign">
      <section class="dash-card dash-hero">${cardHead('turbine','green','Renewable energy at risk','Selected half-hour model forecast',`<span class="dash-chip is-amber">${n(p.probability*100)}% likely</span>`)}<div class="dash-hero-body"><div class="dash-hero-figure"><strong>${n(p.atRiskMwh)}</strong><span>MWh</span></div><div class="dash-hero-terrain">${dashboardRiskSurface()}</div><div class="dash-hero-legend"><span><i class="is-amber"></i>At risk</span><span><i class="is-green"></i>Absorbable</span></div></div><div class="dash-hero-stats"><div><span>Forecast target</span><strong>${escapeHtml(modelTime(p.targetAt))}</strong></div><div><span>Horizon</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Risk level</span><strong>${escapeHtml(p.risk)}</strong></div></div></section>
      ${dashboardRecoveryCard(p,o)}
      <section class="dash-card dash-fleet">${cardHead('car','blue','Flexible charging','Scenario input, not vehicle telemetry')}<div class="dash-fleet-body"><div class="dash-fleet-intro"><div class="dash-figure"><strong>${n(flex)}</strong><span>MWh</span></div><p>flexible demand</p></div>${dashboardCharger()}</div><div class="dash-meter"><div class="dash-meter-head"><span>Proposed power</span><span><b>${n(o.proposedPowerMw)}</b> of ${n(modelState.capacity)} MW</span></div><div class="dash-bar"><i style="--fill:${Math.min(1,o.proposedPowerMw/modelState.capacity)}"></i></div></div><div class="dash-fleet-stats"><div><span class="dash-mini is-green">${icon('check',18)}</span><strong>${n(o.potentialRecoveryMwh)} MWh</strong><small>absorbable</small></div><div><span class="dash-mini is-blue">${icon('clock',18)}</span><strong>${n(o.remainingFlexibleMwh)} MWh</strong><small>flexibility left</small></div></div></section>
      ${outlookCard(p)}
      <section class="dash-card dash-plan">${cardHead('swap','lime','Your next move','Scenario recommendation',`<span class="dash-chip is-ready"><i></i>Projected</span>`)}<h3>Use up to <em>${n(o.potentialRecoveryMwh)} MWh</em> of flexible charging at ${escapeHtml(modelTime(p.targetAt))}.</h3>${dashboardPillars(p,o)}<p class="restored-plan-note">Demand and capacity limit the estimate. Vehicle decisions are not supplied.</p><button class="dash-cta" type="button" data-page="charging">Review charging scenario ${icon('arrow',18)}</button></section>
    </div>${provenance()}`;
  });
}
