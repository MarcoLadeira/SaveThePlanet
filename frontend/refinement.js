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

function renderSettings(){
  const live=modelState.data;
  const modelLabel=live?escapeHtml(live.modelVersion):'Connecting';
  return studioHeader('Settings','Model display and workspace preferences.')+`<div class="settings-layout">
    <div class="settings-upper">
      <section class="dash-card settings-section">${cardHead('settings','green','General','Location, display and appearance')}
        <div class="settings-rows">
          <div class="settings-row"><span>Region</span><strong>Ireland</strong></div>
          <label class="settings-row" for="settings-timezone"><span>Display timezone</span><select id="settings-timezone" data-setting="timezone"><option ${settings.timezone==='Europe/Dublin'?'selected':''}>Europe/Dublin</option><option ${settings.timezone==='Europe/London'?'selected':''}>Europe/London</option><option ${settings.timezone==='UTC'?'selected':''}>UTC</option></select></label>
          <div class="settings-row"><span>Energy units</span><strong>MWh</strong></div>
          ${settingSwitch('Dark appearance','theme','Use the same appearance on every page')}
        </div>
      </section>
      <section class="dash-card settings-section">${cardHead('forecast','green','Forecast view','Choose the details shown across the app')}
        <div class="settings-rows">
          ${settingSwitch('Show uncertainty range','uncertainty','Display the model P10–P90 interval')}
          ${settingSwitch('Show component context','cause','Show the predicted constraint and curtailment split')}
          ${settingSwitch('Show methodology notes','explanations','Keep source and scenario limits visible')}
        </div>
      </section>
    </div>
    <div class="settings-lower">
      <section class="dash-card settings-section">${cardHead('battery','blue','Charging inputs','Shared by Charging and Impact')}
        <div class="settings-facts"><div><span>Flexible capacity</span><strong>${n(modelState.capacity)} MW</strong></div><div><span>Total demand</span><strong>${n(modelState.totalDemandKwh)} kWh</strong></div><div><span>Flexible demand</span><strong>${n(modelState.flexibleDemandKwh)} kWh</strong></div></div>
        <button class="settings-link" type="button" data-page="charging">Edit charging inputs ${icon('arrow',17)}</button>
      </section>
      <section class="dash-card settings-section">${cardHead('pulse','green','Model connection','Forecast source and version')}
        <div class="settings-source"><span class="dash-live"><i></i>${sourceText()}</span><strong>${modelLabel}</strong><small>${live?`Historical issue ${escapeHtml(modelTime(live.predictions[0].issuedAt,true))}`:'Waiting for model response'}</small></div>
        <button class="settings-link" id="model-retry" type="button">Refresh model ${icon('arrow',17)}</button>
      </section>
      <section class="dash-card settings-section">${cardHead('leaf','green','About this workspace','Understand what the figures mean')}
        <p class="settings-explain">Forecasts come from the historical GridToEv model. Charging and impact show possible energy absorption using the demand and capacity you enter.</p>
        <p class="settings-explain">Each target covers a separate half-hour. No measured charging or financial savings are shown.</p>
      </section>
    </div>
    <div class="settings-footer"><span>${saved?'Display preferences saved on this device':'Unsaved display changes'}</span><div><button class="studio-ghost" type="button" data-action="reset">Reset display</button><button class="studio-button" type="button" data-action="save">${saved?'Saved':'Save changes'} ${icon('check',17)}</button></div></div>
  </div>`;
}

document.addEventListener('click',event=>{const horizon=event.target.closest('[data-horizon]');if(horizon){modelState.horizon=Number(horizon.dataset.horizon);render()}});
