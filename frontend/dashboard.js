let dashboardMode='energy';

function dashIsoBar(cx,base,width,height,part=''){
  const d=width/2,top=base-height;
  return `<polygon class="${part} l" points="${cx-width},${top} ${cx},${top+d} ${cx},${base+d} ${cx-width},${base}"/><polygon class="${part} r" points="${cx},${top+d} ${cx+width},${top} ${cx+width},${base} ${cx},${base+d}"/><polygon class="${part} t" points="${cx},${top-d} ${cx+width},${top} ${cx},${top+d} ${cx-width},${top}"/>`;
}

function dashboardCharger(){
  return `<svg class="dash-charger dash-ev-scene" viewBox="0 0 300 170" aria-hidden="true" shape-rendering="geometricPrecision"><defs><linearGradient id="ev-deck" x2="0" y2="1"><stop stop-color="#a9e8d4"/><stop offset="1" stop-color="#51bb93"/></linearGradient><linearGradient id="ev-body" x2="0" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#dae7ec"/></linearGradient></defs><ellipse cx="154" cy="152" rx="126" ry="14" fill="#d8ede7"/><path d="m20 117 111-39 150 39-110 43Z" fill="url(#ev-deck)"/><path d="m20 117 151 43v8L20 126Z" fill="#3ca987"/><path d="m171 160 110-43v9l-110 42Z" fill="#21896d"/><ellipse cx="145" cy="123" rx="83" ry="14" fill="#469b88" opacity=".3"/><path d="m55 111 19-27c5-7 18-13 31-15l49-7c11-2 21 0 28 5l27 18 21 7c8 3 12 9 10 16l-5 12-58 11-111-3-11-8Z" fill="url(#ev-body)" stroke="#c6d9e2" stroke-width="2"/><path d="m91 81 16-9 45-6c10-1 17 0 24 6l21 15-49 2-57 2Z" fill="#183e50"/><path d="m152 66 3 22 42-1-21-15c-7-6-14-7-24-6Z" fill="#315a69"/><path d="m91 91 56-2-3 25-71-4Z" fill="#edf5f6"/><path d="m147 89 50-2 25 8-7 21-70-2Z" fill="#f7fbfb"/><path d="m70 113 74 3 72-2 15 6-51 13-105-6Z" fill="#d9e8ed"/><path d="m60 108 12 3-2 8-15-4Z" fill="#2e79aa"/><path d="m213 98 17-2 5 6-15 4Z" fill="#f47768"/><path d="m71 126 107 6 57-14" fill="none" stroke="#a8c4cc" stroke-width="2"/><ellipse cx="92" cy="127" rx="18" ry="12" fill="#183941"/><ellipse cx="92" cy="127" rx="10" ry="9" fill="#c7d8de"/><ellipse cx="92" cy="127" rx="5" ry="5" fill="#829da8"/><ellipse cx="198" cy="128" rx="17" ry="13" fill="#183941"/><ellipse cx="198" cy="128" rx="10" ry="9" fill="#c7d8de"/><ellipse cx="198" cy="128" rx="5" ry="5" fill="#829da8"/><path d="M241 108c18 0 22 10 13 20" fill="none" stroke="#2da978" stroke-width="3"/><rect x="251" y="51" width="27" height="67" rx="4" fill="#eef8f6" stroke="#baded3"/><path d="M251 57h27v53h-27z" fill="#dff2ee"/><rect x="257" y="65" width="15" height="20" rx="2" fill="#155748"/><path d="m267 66-7 11h5l-2 8 9-13h-5l2-6Z" fill="#a5f4cb"/><path d="M264 118v15" stroke="#2f9c78" stroke-width="5"/><ellipse cx="265" cy="133" rx="15" ry="4" fill="#42a986"/></svg>`;
}

function dashboardRiskSurface(){
  const rows=modelState.data.predictions,max=Math.max(1,...rows.map(p=>p.upperMwh))*1.15;
  const y=v=>135-v/max*74,ax=112,bx=388,ay=y(rows[0].atRiskMwh),by=y(rows[1].atRiskMwh),gy0=y(scenarioRecovery(rows[0])),gy1=y(scenarioRecovery(rows[1]));
  const selected=modelState.horizon===30?{x:ax,y:ay,p:rows[0]}:{x:bx,y:by,p:rows[1]};
  return `<svg viewBox="0 0 500 164" preserveAspectRatio="none" role="img" aria-label="At risk: ${n(rows[0].atRiskMwh)} MWh at 30 minutes and ${n(rows[1].atRiskMwh)} MWh at 60 minutes. Potential absorption: ${n(scenarioRecovery(rows[0]))} and ${n(scenarioRecovery(rows[1]))} MWh"><defs><linearGradient id="hero-risk-fill" x2="0" y2="1"><stop stop-color="#ffbf5d" stop-opacity=".7"/><stop offset="1" stop-color="#ffbf5d" stop-opacity=".04"/></linearGradient><linearGradient id="hero-save-fill" x2="0" y2="1"><stop stop-color="#39d7a6" stop-opacity=".55"/><stop offset="1" stop-color="#39d7a6" stop-opacity=".03"/></linearGradient></defs><path d="M36 137H470M36 93H470" stroke="#2f6957" stroke-width="1"/><path d="M${ax} ${ay} C 206 ${ay-5},294 ${by-5},${bx} ${by} L${bx} 137H${ax}Z" fill="url(#hero-risk-fill)"/><path d="M${ax} ${gy0} C 207 ${gy0+4},294 ${gy1+4},${bx} ${gy1} L${bx} 137H${ax}Z" fill="url(#hero-save-fill)"/><path d="M${ax} ${ay} C 206 ${ay-5},294 ${by-5},${bx} ${by}" stroke="#ffbe4d" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M${ax} ${gy0} C 207 ${gy0+4},294 ${gy1+4},${bx} ${gy1}" stroke="#33d59f" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M${selected.x} 44V137" stroke="#b8e7cf" stroke-width="1" stroke-dasharray="4 5"/>${rows.map((p,i)=>`<circle cx="${i?bx:ax}" cy="${i?by:ay}" r="5.5" fill="#fff" stroke="#f9b43e" stroke-width="3"/><circle cx="${i?bx:ax}" cy="${i?gy1:gy0}" r="5.5" fill="#fff" stroke="#2ac997" stroke-width="3"/>`).join('')}<text x="${ax}" y="157" text-anchor="middle" fill="#d9efe5" font-size="12">+30 min</text><text x="${bx}" y="157" text-anchor="middle" fill="#d9efe5" font-size="12">+60 min</text><g transform="translate(${selected.x>250?selected.x-104:selected.x+12},${Math.max(30,selected.y-47)})"><rect width="91" height="35" rx="9" fill="#174d3d" stroke="#659988"/><text x="10" y="14" fill="#ffd27f" font-size="10">At risk</text><text x="10" y="29" fill="#fff" font-size="13" font-weight="700">${n(selected.p.atRiskMwh)} MWh</text></g></svg>`;
}

function dashboardRecoveryChannel(p,o){
  const ratio=p.atRiskMwh?o.potentialRecoveryMwh/p.atRiskMwh:0;
  const green=Math.min(100,Math.max(0,ratio*100));
  return `<div class="dash-recovery-channel" role="img" aria-label="${n(o.potentialRecoveryMwh)} MWh recoverable of ${n(p.atRiskMwh)} MWh at risk"><div class="dash-channel-label"><strong>${pct(o.recoveryRate)}</strong><span>of risk can be absorbed</span></div><div class="dash-channel-bed"><div class="dash-channel-fill" style="width:${green}%"></div></div><div class="dash-channel-foot"><span>${n(o.potentialRecoveryMwh)} MWh potential</span><span>${n(o.remainingWasteMwh)} MWh remaining</span></div></div>`;
}

function dashboardRecoveryOrbit(p,o){
  const ratio=p.atRiskMwh?o.potentialRecoveryMwh/p.atRiskMwh:0;
  const rate=Math.min(1,Math.max(0,ratio));
  return `<div class="dash-recovery-channel dash-orbit" role="img" aria-label="${n(o.potentialRecoveryMwh)} MWh recoverable of ${n(p.atRiskMwh)} MWh at risk"><svg viewBox="0 0 190 190" aria-hidden="true"><circle cx="95" cy="95" r="70" fill="none" stroke="#e4eef1" stroke-width="22"/><circle class="dash-orbit-progress" cx="95" cy="95" r="70" fill="none" stroke="#16ad76" stroke-width="22" stroke-linecap="round" stroke-dasharray="${(rate*440).toFixed(2)} 440" transform="rotate(-90 95 95)"/></svg><div class="dash-channel-label"><strong>${pct(o.recoveryRate)}</strong><span>can be absorbed</span></div></div>`;
}

function outlookLegend(){
  return '<small>MWh per half-hour</small><span><i class="is-risk"></i>At risk</span><span><i class="is-charge"></i>Potential absorption</span>'+(dashboardMode==='recovery'?'<span><i class="is-remaining"></i>Remaining at risk</span>':'');
}

function outlookTooltip(index,detailed=false){
  const p=modelState.data.predictions[index],o=scenarioOutcome(p);
  if(!p||!o)return '';
  if(!detailed){
    const value=dashboardMode==='energy'?p.atRiskMwh:o.potentialRecoveryMwh;
    return `<strong>${n(value)} MWh</strong><span>${dashboardMode==='energy'?'at risk':'potential absorption'}</span>`;
  }
  const interval=settings.uncertainty&&Number.isFinite(p.lowerMwh)&&Number.isFinite(p.upperMwh)
    ?`<span>P10–P90 risk range <b>${n(p.lowerMwh)}–${n(p.upperMwh)} MWh</b></span>`:'';
  return `<strong>+${p.horizonMinutes} min · ${escapeHtml(modelTime(p.targetAt))}</strong><span>At risk <b>${n(p.atRiskMwh)} MWh</b></span><span>Potential absorption <b>${n(o.potentialRecoveryMwh)} MWh</b></span><span>Remaining at risk <b>${n(o.remainingWasteMwh)} MWh</b></span><span>Risk level <b>${escapeHtml(p.risk)}</b></span>${interval}`;
}

function dashboardOutlookChart(){
  const rows=modelState.data?.predictions;
  if(!rows?.length)return '<p class="outlook-empty">No forecast targets available.</p>';
  if(rows.length<2)return '<p class="outlook-empty">A second forecast target is unavailable.</p>';
  const points=rows.slice(0,2),outcomes=points.map(scenarioOutcome);
  const ceiling=Math.max(1,...points.map(p=>p.atRiskMwh),...points.map(p=>Number.isFinite(p.upperMwh)?p.upperMwh:0),...outcomes.map(o=>o.potentialRecoveryMwh));
  const step=ceiling<=5?1:ceiling<=10?2:ceiling<=25?5:ceiling<=50?10:Math.ceil(ceiling/50)*10;
  const max=Math.ceil(ceiling/step)*step;
  const ticks=Array.from({length:Math.round(max/step)+1},(_,i)=>i*step);
  const project=(value,index,front=false)=>[(index?490:190)+(front?15:0),Math.round(((index?294:332)+(front?30:0)-value/max*245)*10)/10];
  const riskTop=points.map((p,i)=>project(p.atRiskMwh,i)),riskBase=points.map((_,i)=>project(0,i));
  const saveTop=outcomes.map((o,i)=>project(o.potentialRecoveryMwh,i,true)),saveBase=points.map((_,i)=>project(0,i,true));
  const remainingTop=outcomes.map((o,i)=>project(o.remainingWasteMwh,i));
  const selected=points.findIndex(p=>p.horizonMinutes===modelState.horizon);
  const active=selected<0?0:selected;
  const face=(top,base,kind)=>`<path class="outlook-face outlook-${kind}-face" d="M${top[0]} L${top[1]} L${base[1]} L${base[0]}Z"/><path class="outlook-side outlook-${kind}-side" d="M${top[1]} l7 5 L${base[1][0]+7},${base[1][1]+5} L${base[1]}Z"/><path class="outlook-line outlook-${kind}-line" d="M${top[0]} L${top[1]}"/>`;
  const markers=(coords,kind)=>coords.map(([x,y],i)=>`<g class="outlook-point outlook-${kind}-point ${i===active?'is-selected':''}" data-outlook-point="${i}" data-outlook-series="${kind}" tabindex="0" role="button" aria-label="+${points[i].horizonMinutes} minute target, ${kind==='risk'?'at risk':'potential absorption'} ${n(kind==='risk'?points[i].atRiskMwh:outcomes[i].potentialRecoveryMwh)} megawatt hours"><circle class="outlook-point-hit" cx="${x}" cy="${y}" r="17"/><circle class="outlook-point-mark" cx="${x}" cy="${y}" r="7"/></g>`).join('');
  const grid=ticks.map(v=>{const left=332-v/max*245,right=294-v/max*245;return `<path class="outlook-gridline" d="M60 ${left} L490 ${right} L555 ${right+24}"/><text class="outlook-tick" x="49" y="${left+4}" text-anchor="end">${v}</text>`}).join('');
  const targetLabels=points.map((p,i)=>`<text class="outlook-target" x="${i?505:205}" y="${i?386:401}" text-anchor="middle">+${p.horizonMinutes} min · ${escapeHtml(modelTime(p.targetAt))}</text>`).join('');
  const remaining=dashboardMode==='recovery'? `<path class="outlook-remaining-line" d="M${remainingTop[0]} L${remainingTop[1]}"/>`:'';
  return `<div class="outlook-plot ${dashboardMode==='recovery'?'is-recovery':''}"><svg viewBox="0 0 600 420" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Two separate half-hour forecast targets. At risk: ${n(points[0].atRiskMwh)} and ${n(points[1].atRiskMwh)} MWh. Potential absorption: ${n(outcomes[0].potentialRecoveryMwh)} and ${n(outcomes[1].potentialRecoveryMwh)} MWh."><path class="outlook-platform-side" d="M60 332 L490 294 L555 318 L555 334 L490 310 L60 348Z"/><path class="outlook-platform" d="M60 332 L490 294 L555 318 L205 365Z"/>${grid}<path class="outlook-axis" d="M60 87V332 L205 365 M490 49V294"/><path class="outlook-selected-guide" d="M${riskTop[active][0]} ${riskTop[active][1]} L${riskBase[active]}"/>${face(riskTop,riskBase,'risk')}${remaining}${face(saveTop,saveBase,'save')}${markers(riskTop,'risk')}${markers(saveTop,'save')}${targetLabels}</svg><div class="outlook-tooltip" data-outlook-tooltip data-point="${active}" aria-live="polite">${outlookTooltip(active)}</div></div>`;
}

function dashboardPillars(p,o){
  const values=[['risk','At risk',p.atRiskMwh],['flex','Flexible',modelState.data.scenario.flexibleDemandMwh],['recovery','Absorbable',o.potentialRecoveryMwh]];
  const max=Math.max(1,...values.map(([, ,v])=>v));
  return `<div class="dash-pillars" role="img" aria-label="${values.map(([,label,value])=>`${label} ${n(value)} MWh`).join(', ')}"><div class="dash-pillar-row">${values.map(([key,,value],i)=>`<div class="dash-pillar is-${key}" style="--h:${value/max};--delay:${i*.1}s"><div class="dash-pillar-value"><strong>${n(value)}</strong><span>MWh</span></div><div class="dash-pillar-body"></div></div>`).join('')}</div><div class="dash-plinth">${values.map(([,label])=>`<span>${label}</span>`).join('')}<i></i><i></i></div></div>`;
}

function renderDashboard(){
  return studioShell('Dashboard','Renewable dispatch-down and flexible charging opportunity.',()=>{
    const p=selectedPrediction(),o=scenarioOutcome(p),flex=modelState.data.scenario.flexibleDemandMwh;
    const tabs=['energy','recovery'].map(mode=>`<button type="button" data-dashboard-mode="${mode}" aria-pressed="${dashboardMode===mode}" class="${dashboardMode===mode?'active':''}">${mode==='energy'?'Energy risk':'Recovery view'}</button>`).join('');
    return `<div class="dash-grid restored-dashboard dashboard-redesign">
      <section class="dash-card dash-hero">${cardHead('turbine','green','Renewable energy at risk','Selected half-hour model forecast',`<span class="dash-chip is-amber">${n(p.probability*100)}% likely</span>`)}<div class="dash-hero-body"><div class="dash-hero-figure"><strong>${n(p.atRiskMwh)}</strong><span>MWh</span></div><div class="dash-hero-terrain">${dashboardRiskSurface()}</div><div class="dash-hero-legend"><span><i class="is-amber"></i>At risk</span><span><i class="is-green"></i>Absorbable</span></div></div><div class="dash-hero-stats"><div><span>Forecast target</span><strong>${escapeHtml(modelTime(p.targetAt))}</strong></div><div><span>Horizon</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Risk level</span><strong>${escapeHtml(p.risk)}</strong></div></div></section>
      <section class="dash-card dash-recovery">${cardHead('leaf','green','Recovery potential','Clean energy flexible load could retain')}<div class="dash-recovery-body restored-recovery"><div class="dash-recovery-copy"><div class="dash-figure"><strong>${n(o.potentialRecoveryMwh)}</strong><span>MWh</span></div><p>of ${n(p.atRiskMwh)} MWh predicted at risk</p><ul class="dash-key"><li><i class="is-green"></i><span>Potential absorption</span><b>${n(o.potentialRecoveryMwh)} MWh</b></li><li><i class="is-amber"></i><span>Still at risk</span><b>${n(o.remainingWasteMwh)} MWh</b></li></ul></div>${dashboardRecoveryOrbit(p,o)}</div><div class="dash-recovery-scale"><i style="width:${Math.min(100,Math.max(0,o.recoveryRate*100))}%"></i></div><div class="dash-recovery-foot"><span><b>${n(o.potentialRecoveryMwh)}</b> MWh potential</span><span><b>${n(o.remainingWasteMwh)}</b> MWh remaining</span></div></section>
      <section class="dash-card dash-fleet">${cardHead('car','blue','Flexible charging','Scenario input, not vehicle telemetry')}<div class="dash-fleet-intro"><div class="dash-figure"><strong>${n(flex)}</strong><span>MWh</span></div><p>flexible demand</p></div>${dashboardCharger()}<div class="dash-meter"><div class="dash-meter-head"><span>Proposed power</span><span><b>${n(o.proposedPowerMw)}</b> of ${n(modelState.capacity)} MW</span></div><div class="dash-bar"><i style="--fill:${Math.min(1,o.proposedPowerMw/modelState.capacity)}"></i></div></div><div class="dash-fleet-stats"><div><span class="dash-mini is-green">${icon('check',18)}</span><strong>${n(o.potentialRecoveryMwh)} MWh</strong><small>absorbable</small></div><div><span class="dash-mini is-blue">${icon('clock',18)}</span><strong>${n(o.remainingFlexibleMwh)} MWh</strong><small>flexibility left</small></div></div></section>
      <section class="dash-card dash-outlook">${cardHead('pulse','neutral','Energy outlook','Two actual model targets; each covers a separate half-hour',`<div class="dash-tabs">${tabs}</div>`)}<div class="dash-chart-legend">${outlookLegend()}</div><div class="dash-chart-host restored-chart">${dashboardOutlookChart()}</div><div class="dash-insight">${tile('tower','amber-soft')}<div><strong>${settings.cause?modelCause(p):'Model context hidden'}</strong><span>Prediction issued ${escapeHtml(modelTime(p.issuedAt,true))} · ${escapeHtml(settings.timezone)} · ${dataSourceLabel()} · Two independent half-hours</span></div><button type="button" data-page="forecast">Explore forecast ${icon('arrow',16)}</button></div></section>
      <section class="dash-card dash-plan">${cardHead('swap','lime','Your next move','Scenario recommendation',`<span class="dash-chip is-ready"><i></i>Projected</span>`)}<h3>Use up to <em>${n(o.potentialRecoveryMwh)} MWh</em> of flexible charging at ${escapeHtml(modelTime(p.targetAt))}.</h3>${dashboardPillars(p,o)}<p class="restored-plan-note">Demand and capacity limit the estimate. Vehicle decisions are not supplied.</p><button class="dash-cta" type="button" data-page="charging">Review charging scenario ${icon('arrow',18)}</button></section>
    </div>${provenance()}`;
  });
}

function setOutlookTooltip(point,detailed){
  const card=point.closest('.dash-outlook'),tooltip=card?.querySelector('[data-outlook-tooltip]');
  if(!tooltip)return;
  const index=Number(point.dataset.outlookPoint);
  tooltip.dataset.point=String(index);
  tooltip.classList.toggle('is-detail',detailed);
  tooltip.innerHTML=outlookTooltip(index,detailed);
}

document.addEventListener('pointerover',event=>{
  const point=event.target.closest('[data-outlook-point]');
  if(point)setOutlookTooltip(point,true);
});
document.addEventListener('pointerout',event=>{
  const point=event.target.closest('[data-outlook-point]');
  if(!point||point.contains(event.relatedTarget))return;
  const selected=point.closest('.dash-outlook')?.querySelector(`[data-outlook-point="${modelState.horizon===30?0:1}"]`);
  if(selected)setOutlookTooltip(selected,false);
});
document.addEventListener('focusin',event=>{
  const point=event.target.closest('[data-outlook-point]');
  if(point)setOutlookTooltip(point,true);
});
document.addEventListener('focusout',event=>{
  const point=event.target.closest('[data-outlook-point]');
  if(!point)return;
  const selected=point.closest('.dash-outlook')?.querySelector(`[data-outlook-point="${modelState.horizon===30?0:1}"]`);
  if(selected)setOutlookTooltip(selected,false);
});
document.addEventListener('keydown',event=>{
  const point=event.target.closest('[data-outlook-point]');
  if(!point||(event.key!=='Enter'&&event.key!==' '))return;
  event.preventDefault();
  const index=Number(point.dataset.outlookPoint),series=point.dataset.outlookSeries;
  modelState.horizon=modelState.data.predictions[index].horizonMinutes;
  render();
  document.querySelector(`.dash-outlook [data-outlook-point="${index}"][data-outlook-series="${series}"]`)?.focus();
});
document.addEventListener('click',event=>{
  const point=event.target.closest('[data-outlook-point]');
  if(point){modelState.horizon=modelState.data.predictions[Number(point.dataset.outlookPoint)].horizonMinutes;render();return}
  const mode=event.target.closest('[data-dashboard-mode]');
  if(!mode||dashboardMode===mode.dataset.dashboardMode)return;
  dashboardMode=mode.dataset.dashboardMode;
  const card=mode.closest('.dash-outlook'),host=card?.querySelector('.dash-chart-host'),legend=card?.querySelector('.dash-chart-legend');
  if(!host||!legend){render();return}
  card.querySelectorAll('[data-dashboard-mode]').forEach(button=>{
    button.classList.toggle('active',button.dataset.dashboardMode===dashboardMode);
    button.setAttribute('aria-pressed',String(button.dataset.dashboardMode===dashboardMode));
  });
  legend.innerHTML=outlookLegend();
  host.innerHTML=dashboardOutlookChart();
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches)host.animate([{opacity:.6},{opacity:1}],{duration:220,easing:'ease-out'});
});
