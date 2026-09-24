let dashboardMode='energy';

function dashIsoBar(cx,base,width,height,part=''){
  const d=width/2,top=base-height;
  return `<polygon class="${part} l" points="${cx-width},${top} ${cx},${top+d} ${cx},${base+d} ${cx-width},${base}"/><polygon class="${part} r" points="${cx},${top+d} ${cx+width},${top} ${cx+width},${base} ${cx},${base+d}"/><polygon class="${part} t" points="${cx},${top-d} ${cx+width},${top} ${cx},${top+d} ${cx-width},${top}"/>`;
}

function dashboardCharger(){
  return `<svg class="dash-charger" viewBox="0 0 120 112" aria-hidden="true">${dashIsoBar(60,84,46,7,'slab')}${dashIsoBar(50,72,11,50,'post')}<polygon class="screen" points="41,30 48,33.5 48,46.5 41,43"/><path class="cable" d="M58 44 C 76 44, 88 58, 81 75"/>${dashIsoBar(81,80,5,6,'plug')}<circle class="badge" cx="88" cy="22" r="12"/><path class="bolt" d="M89.5 13.5 83 23h5l-1.2 7.5L93.5 21h-5l1-7.5Z"/></svg>`;
}

function dashboardRiskSurface(){
  const values=modelState.data.predictions.map(p=>p.atRiskMwh),max=Math.max(1,...values)*1.25;
  const y=value=>115-value/max*67;
  const a=y(values[0]),b=y(values[1]);
  const front=`M 80 ${a} L 390 ${b}`;
  const back=`M 93 ${a-13} L 403 ${b-13}`;
  return `<svg viewBox="0 0 460 145" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Two historical model points: ${n(values[0])} MWh at 30 minutes and ${n(values[1])} MWh at 60 minutes"><path d="M 48 116 V 30 H 426 V 116 M 48 75 H 426" fill="none" stroke="#35644d" stroke-width="1"/><path d="M 30 128 L 48 116 H 426 L 408 128 Z" fill="#194832" stroke="#35644d"/><path d="${back} L 390 ${b} L 80 ${a} Z" fill="#b8792d"/><path d="${back}" fill="none" stroke="#f7ce90" stroke-width="4" stroke-linecap="round"/><path d="${front}" fill="none" stroke="#dfa047" stroke-width="6" stroke-linecap="round"/><path d="${front}" fill="none" stroke="#ffe3ad" stroke-width="2.5" stroke-linecap="round"/><circle cx="80" cy="${a}" r="6" fill="#fff" stroke="#e7a953" stroke-width="3"/><circle cx="390" cy="${b}" r="6" fill="#fff" stroke="#e7a953" stroke-width="3"/><text x="80" y="140" text-anchor="middle" fill="#cce4d4" font-size="12">+30 min</text><text x="390" y="140" text-anchor="middle" fill="#cce4d4" font-size="12">+60 min</text></svg>`;
}

function dashboardRecoveryChannel(p,o){
  const ratio=p.atRiskMwh?o.potentialRecoveryMwh/p.atRiskMwh:0;
  const green=Math.min(100,Math.max(0,ratio*100));
  return `<div class="dash-recovery-channel" role="img" aria-label="${n(o.potentialRecoveryMwh)} MWh recoverable of ${n(p.atRiskMwh)} MWh at risk"><div class="dash-channel-label"><strong>${pct(o.recoveryRate)}</strong><span>of risk can be absorbed</span></div><div class="dash-channel-bed"><div class="dash-channel-fill" style="width:${green}%"></div></div><div class="dash-channel-foot"><span>${n(o.potentialRecoveryMwh)} MWh potential</span><span>${n(o.remainingWasteMwh)} MWh remaining</span></div></div>`;
}

function dashboardOutlookChart(){
  const rows=modelState.data.predictions;
  const first=rows.map(p=>dashboardMode==='energy'?p.atRiskMwh:scenarioRecovery(p));
  const second=rows.map(p=>dashboardMode==='energy'?scenarioRecovery(p):scenarioOutcome(p).remainingWasteMwh);
  const max=Math.max(1,...first,...second)*1.3;
  const x=[100,690],y=v=>230-v/max*170;
  const path=values=>`M ${x[0]} ${y(values[0])} L ${x[1]} ${y(values[1])}`;
  const line=(values,tone)=>`<path d="${path(values)}" transform="translate(0 6)" fill="none" stroke="var(--${tone}-deep)" stroke-width="8" stroke-linecap="round"/><path d="${path(values)}" fill="none" stroke="var(--${tone})" stroke-width="5" stroke-linecap="round"/>${values.map((v,i)=>`<circle cx="${x[i]}" cy="${y(v)}" r="8" fill="var(--surface)" stroke="var(--${tone})" stroke-width="4"/><text x="${x[i]}" y="${y(v)-18}" text-anchor="middle" fill="var(--ink)" font-size="15" font-weight="750">${n(v)}</text>`).join('')}`;
  return `<svg viewBox="0 0 790 285" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${dashboardMode==='energy'?'Energy at risk and potential recovery':'Potential recovery and remaining risk'} for two model targets"><path d="M 54 229 H 743 M 54 144 H 743 M 54 60 H 743" stroke="var(--line)" stroke-dasharray="4 5"/><path d="M 54 237 H 743 L 731 249 H 42 Z" fill="var(--chart-plinth)"/><path d="M 100 60 V 232 M 690 60 V 232" stroke="var(--line)" stroke-dasharray="3 5"/>${line(first,dashboardMode==='energy'?'amber':'green')}${line(second,dashboardMode==='energy'?'green':'grey')}<text x="100" y="274" text-anchor="middle" fill="var(--ink-2)" font-size="14">+30 min · ${escapeHtml(modelTime(rows[0].targetAt))}</text><text x="690" y="274" text-anchor="middle" fill="var(--ink-2)" font-size="14">+60 min · ${escapeHtml(modelTime(rows[1].targetAt))}</text></svg>`;
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
    return `<div class="dash-grid restored-dashboard">
      <section class="dash-card dash-hero">${cardHead('turbine','amber','Renewable energy at risk','Selected half-hour model forecast',`<span class="dash-chip is-amber">${n(p.probability*100)}% likely</span>`)}<div class="dash-hero-body"><div class="dash-hero-figure"><strong>${n(p.atRiskMwh)}</strong><span>MWh</span></div><div class="dash-hero-terrain">${dashboardRiskSurface()}</div></div><div class="dash-hero-stats"><div><span>Forecast target</span><strong>${escapeHtml(modelTime(p.targetAt))}</strong></div><div><span>Horizon</span><strong>+${p.horizonMinutes} min</strong></div><div><span>Risk level</span><strong>${escapeHtml(p.risk)}</strong></div></div></section>
      <section class="dash-card dash-recovery">${cardHead('leaf','green','Recovery potential','Clean energy flexible load could retain')}<div class="dash-recovery-body restored-recovery"><div class="dash-recovery-copy"><div class="dash-figure"><strong>${n(o.potentialRecoveryMwh)}</strong><span>MWh</span></div><p>of ${n(p.atRiskMwh)} MWh predicted at risk</p><ul class="dash-key"><li><i class="is-green"></i><span>Potential absorption</span><b>${n(o.potentialRecoveryMwh)} MWh</b></li><li><i class="is-amber"></i><span>Still at risk</span><b>${n(o.remainingWasteMwh)} MWh</b></li></ul></div>${dashboardRecoveryChannel(p,o)}</div></section>
      <section class="dash-card dash-fleet">${cardHead('car','blue','Flexible charging','Scenario input, not vehicle telemetry')}<div class="dash-figure"><strong>${n(flex)}</strong><span>MWh flexible demand</span></div>${dashboardCharger()}<div class="dash-meter"><div class="dash-meter-head"><span>Proposed power</span><span><b>${n(o.proposedPowerMw)}</b> of ${n(modelState.capacity)} MW</span></div><div class="dash-bar"><i style="--fill:${Math.min(1,o.proposedPowerMw/modelState.capacity)}"></i></div></div><div class="dash-fleet-stats"><div><span class="dash-mini is-green">${icon('check',18)}</span><strong>${n(o.potentialRecoveryMwh)} MWh</strong><small>absorbable</small></div><div><span class="dash-mini is-blue">${icon('clock',18)}</span><strong>${n(o.remainingFlexibleMwh)} MWh</strong><small>flexibility left</small></div></div></section>
      <section class="dash-card dash-outlook">${cardHead('pulse','neutral','Energy outlook','Two actual model targets; each covers a separate half-hour',`<div class="dash-tabs">${tabs}</div>`)}<div class="dash-chart-legend"><span><i class="is-risk"></i>${dashboardMode==='energy'?'At risk':'Potential absorption'}</span><span><i class="is-charge"></i>${dashboardMode==='energy'?'Potential absorption':'Remaining at risk'}</span><small>MWh per half-hour</small></div><div class="dash-chart-host restored-chart">${dashboardOutlookChart()}</div><div class="dash-insight">${tile('tower','amber-soft')}<div><strong>${settings.cause?modelCause(p):'Model context hidden'}</strong><span>Prediction issued ${escapeHtml(modelTime(p.issuedAt,true))}</span></div><button type="button" data-page="forecast">Explore forecast ${icon('arrow',16)}</button></div></section>
      <section class="dash-card dash-plan">${cardHead('swap','lime','Your next move','Scenario recommendation',`<span class="dash-chip is-ready"><i></i>Projected</span>`)}<h3>Use up to <em>${n(o.potentialRecoveryMwh)} MWh</em> of flexible charging at ${escapeHtml(modelTime(p.targetAt))}.</h3>${dashboardPillars(p,o)}<p class="restored-plan-note">Demand and capacity limit this estimate. Vehicle deadlines are not supplied.</p><button class="dash-cta" type="button" data-page="charging">Review charging scenario ${icon('arrow',18)}</button></section>
    </div>${provenance()}`;
  });
}

document.addEventListener('click',event=>{const mode=event.target.closest('[data-dashboard-mode]');if(mode){dashboardMode=mode.dataset.dashboardMode;render()}});
