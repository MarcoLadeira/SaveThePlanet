function comparisonChart(kind='forecast'){
  const rows=modelState.data.predictions;
  const series=p=>{
    const outcome=scenarioOutcome(p);
    if(kind==='forecast')return [
      {label:'Predicted energy at risk',value:p.atRiskMwh,tone:'amber'},
      {label:settings.uncertainty?'P90 upper estimate':'Median estimate · P50',value:settings.uncertainty?p.upperMwh:p.medianMwh,tone:'sage'}
    ];
    if(kind==='charging')return [
      {label:'Energy at risk',value:p.atRiskMwh,tone:'sage'},
      {label:'Potential absorption',value:outcome.potentialRecoveryMwh,tone:'green'}
    ];
    return [
      {label:'Remaining at risk',value:outcome.remainingWasteMwh,tone:'sage'},
      {label:'Potential absorption',value:outcome.potentialRecoveryMwh,tone:'green'}
    ];
  };
  const all=rows.map(series);
  const max=Math.max(1,...all.flatMap(pair=>pair.map(item=>item.value)));
  const bar=item=>`<div class="energy-lane"><div class="energy-lane-label"><span>${item.label}</span><strong>${n(item.value)} <small>MWh</small></strong></div><div class="energy-track" role="img" aria-label="${item.label}: ${n(item.value)} megawatt-hours"><div class="energy-track-fill is-${item.tone}" style="width:${Math.max(0,Math.min(100,item.value/max*100))}%"></div></div></div>`;
  return `<div class="energy-chart" aria-label="Two separate model forecast targets"><div class="energy-chart-scale"><span>0</span><span>${n(max/2)}</span><span>${n(max)} MWh</span></div><div class="energy-chart-rows">${rows.map((p,i)=>`<div class="energy-target ${p.horizonMinutes===modelState.horizon?'is-selected':''}"><div class="energy-target-info"><span>+${p.horizonMinutes} MINUTES</span><strong>${escapeHtml(modelTime(p.targetAt))}</strong><small>Separate half-hour forecast</small></div><div class="energy-target-lanes">${all[i].map(bar).join('')}</div></div>`).join('')}</div><div class="energy-chart-foot">Bar lengths use the same scale across both targets. Values are model predictions or scenario estimates.</div></div>`;
}

const healthLabels={up:'Model online',down:'Model unavailable',unknown:'Not checked yet'};
function healthItem(label,value,wide=false){return `<div class="${wide?'is-wide':''}"><span>${label}</span><strong>${value}</strong></div>`}
function healthGrid(){
  const live=modelState.data,m=modelState.health?.model,e=m?.error;
  const items=[];
  if(!m)items.push(healthItem('Status',modelState.healthChecking?'Checking…':'Status unavailable',true));
  else{
    items.push(healthItem('Status',`<b class="settings-state is-${escapeHtml(m.state)}">${healthLabels[m.state]||escapeHtml(m.state)}</b>`));
    items.push(healthItem('Model version',m.modelVersion?escapeHtml(m.modelVersion):'—'));
    if(e)items.push(healthItem(`Reason · ${escapeHtml(e.code)}${e.httpStatus?` · HTTP ${e.httpStatus}`:''}`,escapeHtml(e.message)+(e.detail?`<em>Model said: ${escapeHtml(e.detail)}</em>`:''),true));
    items.push(healthItem('Response time',m.latencyMs===null?'—':`${n(m.latencyMs)} ms`));
    items.push(healthItem('Last checked',m.checkedAt?escapeHtml(modelTime(m.checkedAt,true)):'—'));
    items.push(healthItem('Service',`${m.target==='local'?'Local':'Hosted'} · key ${m.apiKeyConfigured?'set':'not set'} · ${n(m.timeoutSeconds)} s`));
  }
  const mode={'historical-prediction':'Historical model prediction',simulated:'Simulated demo fallback'}[live?.dataMode]||(live?escapeHtml(live.dataMode):'—');
  items.push(healthItem('Data shown',mode));
  items.push(healthItem('Last updated',live?escapeHtml(modelTime(live.generatedAt,true)):'—'));
  return `<div class="settings-health">${items.join('')}</div>`;
}

function renderSettings(){
  const live=modelState.data,s=live?.scenario;
  const region=live?escapeHtml(live.region):'Ireland';
  const interval=live?`MWh per ${n(live.intervalMinutes)}-minute interval`:'MWh';
  const targets=live?live.predictions.map(p=>`+${p.horizonMinutes} min`).join(' · '):'—';
  const methodology=s?.methodology?.length?s.methodology.map(line=>`<p class="settings-explain">${escapeHtml(line)}</p>`).join(''):'<p class="settings-explain">Methodology loads with the forecast.</p>';
  const capacity=live?live.flexibleCapacityMw:modelState.capacity,total=s?s.totalDemandKwh:modelState.totalDemandKwh,flexible=s?s.flexibleDemandKwh:modelState.flexibleDemandKwh;
  return studioHeader('Settings','Model display and workspace preferences.')+`<div class="settings-layout">
    <div class="settings-upper">
      <section class="dash-card settings-section">${cardHead('settings','green','General','Location, display and appearance')}
        <div class="settings-rows">
          <div class="settings-row"><span>Region</span><strong>${region}</strong></div>
          <label class="settings-row" for="settings-timezone"><span>Display timezone</span><select id="settings-timezone" data-setting="timezone"><option ${settings.timezone==='Europe/Dublin'?'selected':''}>Europe/Dublin</option><option ${settings.timezone==='Europe/London'?'selected':''}>Europe/London</option><option ${settings.timezone==='UTC'?'selected':''}>UTC</option></select></label>
          <div class="settings-row"><span>Energy units</span><strong>${interval}</strong></div>
          ${settingSwitch('Dark appearance','theme','Use the same appearance on every page')}
        </div>
      </section>
      <section class="dash-card settings-section">${cardHead('forecast','green','Forecast view','Choose the details shown across the app')}
        <div class="settings-rows">
          <div class="settings-row"><span>Forecast targets</span><strong>${targets}</strong></div>
          ${settingSwitch('Show uncertainty range','uncertainty','Display the model P10–P90 interval')}
          ${settingSwitch('Show component context','cause','Show the predicted constraint and curtailment split')}
          ${settingSwitch('Show methodology notes','explanations','Keep source and scenario limits visible')}
        </div>
      </section>
    </div>
    <div class="settings-lower">
      <section class="dash-card settings-section">${cardHead('battery','blue','Charging inputs','Values used by the backend for Charging and Impact')}
        <div class="settings-facts"><div><span>Flexible capacity</span><strong>${n(capacity)} MW</strong></div><div><span>Total demand</span><strong>${n(total)} kWh</strong></div><div><span>Flexible demand</span><strong>${n(flexible)} kWh</strong></div>${s?`<div><span>Scenario ID</span><strong>${escapeHtml(s.id)}</strong></div>`:''}</div>
        <button class="settings-link" type="button" data-page="charging">Edit charging inputs ${icon('arrow',17)}</button>
      </section>
      <section class="dash-card settings-section">${cardHead('pulse','green','Model connection','Live status reported by the backend')}
        ${healthGrid()}
        <div class="settings-actions"><button class="settings-link" id="model-health-check" type="button" ${modelState.healthChecking?'disabled':''}>${modelState.healthChecking?'Checking…':'Check connection'} ${icon('pulse',17)}</button><button class="settings-link" id="model-retry" type="button" ${modelState.loading?'disabled':''}>Reload forecast ${icon('arrow',17)}</button></div>
      </section>
      <section class="dash-card settings-section">${cardHead('leaf','green','About this workspace','How the backend calculates the figures')}
        <div class="settings-methodology">${methodology}</div>
      </section>
    </div>
    <div class="settings-footer"><span>${saved?'Display preferences saved on this device':'Unsaved display changes'}</span><div><button class="studio-ghost" type="button" data-action="reset">Reset display</button><button class="studio-button" type="button" data-action="save">${saved?'Saved':'Save changes'} ${icon('check',17)}</button></div></div>
  </div>`;
}

document.addEventListener('click',event=>{const horizon=event.target.closest('[data-horizon]');if(horizon){modelState.horizon=Number(horizon.dataset.horizon);render()}});
