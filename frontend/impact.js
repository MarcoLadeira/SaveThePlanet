// Impact page: event-level results per forecast target, best single alternative and
// the assumptions behind every derived figure. Targets are alternatives, never summed.
function impactLabel(){return isDemoData()?'Simulated':'Derived estimate'}

function impactCo2Parts(tonnes){return tonnes<1?[n(tonnes*1000),'kg CO₂']:[n(tonnes),'t CO₂']}
function impactCo2(tonnes){const [value,unit]=impactCo2Parts(tonnes);return `${value}<small>${unit}</small>`}
function impactCo2Text(tonnes){return impactCo2Parts(tonnes).join(' ')}

function impactStats(o){
  const tag=impactLabel();
  return statStrip([
    metric('Renewable energy recovered',n(o.potentialRecoveryMwh),'MWh',`${tag} · ${pct(o.recoveryRate)} of at-risk energy`,'green'),
    metric('EV charging enabled',n(o.potentialRecoveryMwh*1000),'kWh',`${tag} · ${pct(o.cleanChargingShare)} of charging demand`),
    metric('Emissions avoided',impactCo2(o.avoidedEmissionsTco2),'',`${tag} · grid-average displacement`,'green'),
    metric('EV range equivalent',n(Math.round(o.evRangeKm)),'km',`${tag} · illustrative, not vehicles`)
  ]);
}

function impactEventRow(o,best){
  const selected=o.horizonMinutes===modelState.horizon;
  return `<tr class="${selected?'is-selected':''}"><th scope="row">${escapeHtml(modelTime(o.targetAt))} <small>+${o.horizonMinutes} min</small>${o.horizonMinutes===best?'<span class="impact-best">Best</span>':''}</th><td>${n(o.atRiskMwh)}</td><td class="is-green">${n(o.potentialRecoveryMwh)}</td><td>${n(o.remainingWasteMwh)}</td><td>${impactCo2(o.avoidedEmissionsTco2)}</td></tr>`;
}

function impactEvents(s){
  const best=s.recommendedHorizonMinutes;
  const top=best===null?null:s.outcomes.find(o=>o.horizonMinutes===best);
  const summary=top
    ?`Best single alternative: <b>+${best} min</b> recovers <b>${n(top.potentialRecoveryMwh)} MWh</b> and avoids <b>${impactCo2Text(top.avoidedEmissionsTco2)}</b>.`
    :'No recoverable surplus for these assumptions.';
  return `<section class="dash-card impact-events">${cardHead('leaf','green','Impact by forecast event','Each half-hour target evaluated with the same demand')}
    <table class="impact-table"><thead><tr><th scope="col">Target</th><th scope="col">At risk <small>MWh</small></th><th scope="col">Recovered <small>MWh</small></th><th scope="col">Remaining <small>MWh</small></th><th scope="col">CO₂ avoided</th></tr></thead><tbody>${s.outcomes.map(o=>impactEventRow(o,best)).join('')}</tbody></table>
    <div class="impact-cumulative"><p>${summary}</p><small>Targets are alternative uses of the same flexible demand, so their results are not added into a cumulative total.</small></div>
  </section>`;
}

function impactBalance(p,o){
  return `<section class="dash-card studio-side-card impact-balance">${cardHead('pie','green','Energy balance','Selected forecast target')}${dashboardRecoveryChannel(p,o)}
    <div class="studio-balance"><div><i class="is-green"></i><span>Charging from recovered renewables</span><strong>${n(o.potentialRecoveryMwh)} MWh</strong></div><div><i class="is-amber"></i><span>Renewables still at risk</span><strong>${n(o.remainingWasteMwh)} MWh</strong></div><div><i></i><span>Demand to schedule elsewhere</span><strong>${n(o.remainingDemandMwh)} MWh</strong></div></div>
    <button class="studio-button" data-page="charging" type="button">Adjust charging scenario ${icon('arrow',17)}</button>
  </section>`;
}

function impactMethodology(s){
  const a=s.assumptions;
  return `<details class="dash-card impact-method"><summary>${tile('settings','green')}<span class="impact-method-copy"><strong>Methodology and assumptions</strong><small>${n(a.gridIntensityTco2PerMwh*1000)} gCO₂/kWh grid intensity · ${n(a.evKwhPerKm)} kWh/km · ${escapeHtml(impactLabel().toLowerCase())} values</small></span></summary><ul>${s.methodology.map(line=>`<li>${escapeHtml(line)}</li>`).join('')}</ul></details>`;
}

function renderImpact(){return studioShell('Impact','Renewable energy recovered, EV charging enabled and emissions avoided.',()=>{
  const p=selectedPrediction(),o=scenarioOutcome(p),s=modelState.data.scenario;
  return `${impactStats(o)}<div class="studio-page-grid impact-grid">${impactEvents(s)}${impactBalance(p,o)}</div>${impactMethodology(s)}${provenance()}`;
})}
