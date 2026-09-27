function studioControls(){return `<div class="studio-toolbar"><div class="studio-segment" role="group" aria-label="Forecast target"><button type="button" data-horizon="30" class="${modelState.horizon===30?'active':''}">+30 min</button><button type="button" data-horizon="60" class="${modelState.horizon===60?'active':''}">+60 min</button></div><span class="studio-target">${icon('calendar',19)}${modelState.data?`Target ${escapeHtml(modelTime(selectedPrediction().targetAt,true))}`:'Two model targets'}</span></div>`}
function tile(glyph,tone='green'){return `<span class="dash-tile is-${tone}">${icon(glyph,20)}</span>`}
function n(value){return modelNumber(value)}
function pct(value){return value===null?'—':`${n(value*100)}%`}
function studioHeader(title,subtitle){const art={Forecast:'forecast',Charging:'charging',Impact:'impact',Settings:'settings'}[title]||'overview';return `<header class="dash-header studio-header"><div class="dashboard-header-art is-${art}" aria-hidden="true"></div><div class="dash-title"><p>Renewable energy planner / Ireland</p><h1>${title}</h1><span>${subtitle}</span></div></header>`}
function studioShell(title,subtitle,content){
  const top=studioHeader(title,subtitle);
  if(modelState.loading){
    if(title==='Dashboard' && modelState.data)return top+content();
    return top+'<section class="dash-card studio-message" role="status"><span class="studio-spinner"></span><h2>Loading model predictions</h2><p>Connecting to GridToEv and calculating charging scenarios.</p></section>';
  }
  if(modelState.error)return top+`<section class="dash-card studio-message" role="alert"><h2>Forecast unavailable</h2><p>${escapeHtml(modelState.error)}</p><button class="studio-button" id="model-retry" type="button">Try again ${icon('arrow',17)}</button></section>`;
  return top+content();
}
function cardHead(tone,title,subtitle,extra=''){return `<div class="dash-card-head"><span class="dash-accent is-${tone}" aria-hidden="true"></span><div class="dash-head-copy"><h2>${title}</h2><p>${subtitle}</p></div>${extra}</div>`}
function metric(label,value,unit='',note='',tone=''){return `<div class="studio-metric ${tone}"><span>${label}</span><strong>${value}<small>${unit}</small></strong><em>${note}</em></div>`}
function statStrip(items){return `<section class="studio-stat-strip" aria-label="Selected forecast metrics">${items.join('')}</section>`}
function provenance(){const issued=modelState.data.predictions[0].issuedAt,zone=settings.timezone==='Europe/Dublin'?'Irish time':escapeHtml(settings.timezone);return `<p class="studio-provenance">${isDemoData()?`Demo data while the forecast model is offline · Updated ${escapeHtml(modelTime(issued))} ${zone}`:`GridToEv forecast (historical replay) · Issued ${escapeHtml(modelTime(issued,true))} ${zone}`} · Each forecast covers one half-hour · Recovery figures are estimates, not measured charging.</p>`}
function settingSwitch(label,key,description){const active=key==='theme'?dashboardTheme==='dark':settings[key];const action=key==='theme'?'data-dashboard-theme':`data-toggle="${key}"`;return `<div class="studio-setting"><div><strong>${label}</strong><span>${description}</span></div><button type="button" class="studio-switch ${active?'active':''}" ${action} role="switch" aria-checked="${active}" aria-label="${label}"><i></i></button></div>`}
