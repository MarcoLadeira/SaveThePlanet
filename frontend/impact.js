// Impact page. Two data sources, both real:
//  1. modelState.data.scenario — the two +30/+60 alternatives (always available).
//  2. impactDay — a 48-interval historical day replay from GET /api/v1/impact/day
//     (GridToEv /predict/window/from-dataset). Until that endpoint exists the
//     time-series cards fall back to the two-target comparison; nothing is invented.
//
// Day replay contract expected from the backend:
// { date:"2026-01-10", range:{min:"2026-01-02",max:"2026-01-31"}, dataMode, intervalMinutes:30,
//   horizonMinutes:30, intervals:[{targetAt, atRiskMwh, potentialRecoveryMwh, remainingWasteMwh,
//   avoidedEmissionsTco2, evRangeKm}], totals:{atRiskMwh, potentialRecoveryMwh, avoidedEmissionsTco2, evRangeKm} }

const impactDay={date:null,range:null,status:'idle',data:null,key:'',metric:'energy',request:0};
const IMPACT_METRICS={
  energy:{label:'Energy',field:'potentialRecoveryMwh',format:v=>`${n(v)} MWh`},
  emissions:{label:'Emissions',field:'avoidedEmissionsTco2',format:v=>impactCo2Text(v)},
  distance:{label:'Distance',field:'evRangeKm',format:v=>`${n(Math.round(v))} km`}
};

function impactLabel(){return isDemoData()?'Simulated':'Derived estimate'}
function impactCo2Parts(tonnes){return tonnes<1?[n(tonnes*1000),'kg CO₂']:[n(tonnes),'t CO₂']}
function impactCo2Text(tonnes){return impactCo2Parts(tonnes).join(' ')}
function impactDayReady(){return impactDay.status==='ready'&&impactDay.data?.intervals?.length>0}
function impactDayLoading(){return impactDay.status==='loading'}
function impactDateLabel(value){return value?new Intl.DateTimeFormat('en-IE',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(`${value}T00:00:00Z`)):'the replay day'}
// Placeholder for day-replay sections while a day loads, so the previous day's bars never linger.
function impactSkeleton(bars=24){
  const heights=Array.from({length:bars},(_,i)=>28+Math.round(22*Math.sin(i/2.4)+18*Math.sin(i/5.1+1)));
  return `<div class="impact-skeleton" role="status" aria-live="polite"><div class="impact-skel-bars" aria-hidden="true">${heights.map(h=>`<i style="height:${Math.max(8,h)}%"></i>`).join('')}</div><span>Loading ${escapeHtml(impactDateLabel(impactDay.date))} replay…</span></div>`;
}

// ---------- day replay loading ----------
function impactDayKey(){return [impactDay.date,modelState.capacity,modelState.totalDemandKwh,modelState.flexibleDemandKwh].join('|')}
async function loadImpactDay(){
  const request=++impactDay.request;
  impactDay.key=impactDayKey();impactDay.status='loading';
  const query=new URLSearchParams({capacityMw:String(modelState.capacity),totalDemandKwh:String(modelState.totalDemandKwh),flexibleDemandKwh:String(modelState.flexibleDemandKwh)});
  if(impactDay.date)query.set('date',impactDay.date);
  try{
    const response=await fetch(`/api/v1/impact/day?${query}`);
    if(request!==impactDay.request)return;
    if(response.status===404){impactDay.status='unavailable';impactDay.data=null;return}
    const body=await response.json();
    if(!response.ok||!Array.isArray(body.intervals))throw new Error(body.error?.message||'Day replay unavailable');
    impactDay.data=body;impactDay.range=body.range||impactDay.range;impactDay.date=body.date;impactDay.key=impactDayKey();impactDay.status='ready';
  }catch{if(request===impactDay.request){impactDay.status='error';impactDay.data=null}}
  finally{if(request===impactDay.request&&pageFromHash()==='impact')render()}
}
// Called while rendering: mark the day as loading immediately so this very render shows the
// placeholders (first visit, or capacity/demand changed) rather than the two-target fallback.
function ensureImpactDay(){
  if(impactDay.status==='loading'||impactDay.key===impactDayKey())return;
  impactDay.status='loading';impactDay.key=impactDayKey();setTimeout(loadImpactDay);
}
function shiftImpactDate(days){
  if(!impactDay.date)return;
  const d=new Date(`${impactDay.date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);
  const next=d.toISOString().slice(0,10);
  if(impactDay.range&&(next<impactDay.range.min||next>impactDay.range.max))return;
  impactDay.date=next;requestImpactDay();
}
// Show the loading state at once, but only ask the backend once clicking stops: each replay
// ties up the single-worker model for ~15 s, so skipped-over days should never be requested.
let impactDayTimer=null;
function requestImpactDay(){
  impactDay.request++;impactDay.status='loading';impactDay.key=impactDayKey();render();
  clearTimeout(impactDayTimer);impactDayTimer=setTimeout(loadImpactDay,400);
}

// ---------- chart primitives ----------
function niceMax(value){if(!(value>0))return 1;const p=10**Math.floor(Math.log10(value)),m=value/p;return (m<=1?1:m<=2?2:m<=2.5?2.5:m<=5?5:10)*p}
function yAxis(max,top,bottom,left,right,unit){
  return [0,.25,.5,.75,1].map(t=>{const y=bottom-(bottom-top)*t;return `<line class="impact-grid" x1="${left}" x2="${right}" y1="${y}" y2="${y}"/><text class="impact-tick" x="${left-8}" y="${y+3}" text-anchor="end">${n(max*t)}</text>`}).join('')+`<text class="impact-tick" x="${left-8}" y="${top-12}" text-anchor="end">${unit}</text>`;
}
function tipAttrs(text){return `data-tip="${escapeHtml(text)}" tabindex="0" aria-label="${escapeHtml(text)}"`}

// Tiny data-backed microvisuals for the KPI cards.
function microBars(values,active){
  const max=Math.max(...values,0)||1,w=96,h=40,gap=values.length>6?1.5:10,bw=(w-gap*(values.length-1))/values.length;
  return `<svg class="impact-micro" viewBox="0 0 ${w} ${h}" aria-hidden="true">${values.map((v,i)=>{const bh=Math.max(v/max*(h-4),v>0?2:0);return `<rect x="${i*(bw+gap)}" y="${h-bh}" width="${bw}" height="${bh}" rx="${Math.min(3,bw/2)}" class="${i===active?'on':''}"/>`}).join('')}</svg>`;
}
function kpiMicro(field,scale=1){
  if(impactDayLoading())return {svg:'<span class="impact-micro impact-micro-skel" aria-hidden="true"></span>',caption:'Loading…'};
  if(impactDayReady())return {svg:microBars(impactDay.data.intervals.map(i=>i[field]*scale),-1),caption:'48 half-hours'};
  const outcomes=modelState.data.scenario.outcomes;
  return {svg:microBars(outcomes.map(o=>o[field]*scale),outcomes.findIndex(o=>o.horizonMinutes===modelState.horizon)),caption:outcomes.map(o=>`+${o.horizonMinutes}`).join(' · ')};
}

// ---------- 1. KPI cards ----------
function impactKpi(iconName,tone,label,value,unit,note,micro){
  return `<article class="impact-kpi is-${tone}">${tile(iconName,tone)}<div class="impact-kpi-copy"><span>${label}</span><strong>${value}<small>${unit}</small></strong><em>${note}</em></div><figure class="impact-kpi-micro">${micro.svg}<figcaption>${micro.caption}</figcaption></figure></article>`;
}
function impactStats(o){
  const scope=`+${o.horizonMinutes} min · ${impactLabel().toLowerCase()}`,[co2,co2Unit]=impactCo2Parts(o.avoidedEmissionsTco2);
  return `<section class="impact-kpis" aria-label="Selected scenario impact">
    ${impactKpi('bolt','green','Potential renewable recovery',n(o.potentialRecoveryMwh),'MWh',`${pct(o.recoveryRate)} of at-risk · ${scope}`,kpiMicro('potentialRecoveryMwh'))}
    ${impactKpi('battery','blue','Potential EV charging',n(o.potentialRecoveryMwh*1000),'kWh',`${pct(o.cleanChargingShare)} of demand · ${scope}`,kpiMicro('potentialRecoveryMwh',1000))}
    ${impactKpi('leaf','green','Est. emissions avoided',co2,co2Unit,scope,kpiMicro('avoidedEmissionsTco2'))}
    ${impactKpi('car','blue','EV range equivalent',n(Math.round(o.evRangeKm)),'km',`Illustrative · ${scope}`,kpiMicro('evRangeKm'))}
  </section>`;
}

// ---------- 2. Energy flow hero ----------
function flowScene(){
  const tree=(x,y,s=1)=>`<g class="flow-tree" transform="translate(${x} ${y}) scale(${s})"><rect x="-1.5" y="0" width="3" height="9"/><circle cy="-4" r="8"/></g>`;
  const turbine=(x,y,s=1)=>`<g class="flow-turbine" transform="translate(${x} ${y}) scale(${s})"><path d="M-2 0 L-1 -78 L1 -78 L2 0Z"/><g class="flow-blades" style="transform-origin:0 -78px"><path d="M0 -78 L-3 -120 L3 -120Z"/><path d="M0 -78 L-3 -120 L3 -120Z" transform="rotate(120 0 -78)"/><path d="M0 -78 L-3 -120 L3 -120Z" transform="rotate(240 0 -78)"/></g><circle cy="-78" r="3.5"/></g>`;
  const charger=(x,y)=>`<g class="flow-charger" transform="translate(${x} ${y})"><path class="side" d="M0 0 L10 -6 L10 -52 L0 -46Z"/><path class="face" d="M-16 -9 L0 0 L0 -46 L-16 -55Z"/><path class="top" d="M-16 -55 L0 -46 L10 -52 L-6 -61Z"/><rect class="screen" x="-13" y="-44" width="10" height="13" transform="skewY(30)"/></g>`;
  // 1000x300 scene; callouts in impact.css use the same x positions (source ~14%, battery 50%, chargers ~85%).
  return `<svg class="flow-scene" viewBox="0 60 1000 240" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="flow-water" d="M0 262 Q250 238 500 268 T1000 256 V300 H0Z"/>
    <path class="flow-land" d="M10 222 L420 176 L990 206 L600 276 Z"/>
    <path class="flow-land-edge" d="M10 222 L600 276 L990 206 L990 216 L600 288 L10 232Z"/>
    <path class="flow-hill" d="M24 222 Q90 150 170 168 Q250 186 300 178 L360 190 L170 236Z"/>
    ${turbine(100,204,.8)}${turbine(160,194,.7)}${turbine(220,204,.58)}
    ${tree(290,192,.8)}${tree(320,200,.7)}${tree(400,184,.7)}${tree(600,180,.8)}${tree(630,188,.7)}${tree(960,212,.8)}${tree(520,256,.9)}${tree(60,226,.7)}
    <path class="flow-ribbon green" d="M250 214 C330 232 380 180 452 200"/>
    <path class="flow-ribbon green core" d="M250 214 C330 232 380 180 452 200"/>
    <path class="flow-ribbon blue" d="M548 204 C630 232 680 182 772 212"/>
    <path class="flow-ribbon blue core" d="M548 204 C630 232 680 182 772 212"/>
    <g class="flow-battery" transform="translate(500 226)"><path class="side" d="M0 0 L46 -24 L46 -80 L0 -56Z"/><path class="face" d="M-48 -24 L0 0 L0 -56 L-48 -80Z"/><path class="top" d="M-48 -80 L0 -56 L46 -80 L-2 -104Z"/><path class="bolt" d="M-20 -64 L-29 -42 L-21 -42 L-26 -25 L-11 -49 L-19 -49 L-12 -64Z"/></g>
    <path class="flow-bay" d="M760 240 L870 206 L960 222 L850 258Z"/>
    ${charger(815,236)}${charger(855,222)}${charger(895,208)}
  </svg>`;
}
function impactFlow(p,o){
  const callout=(cls,tone,iconName,value,unit,label)=>`<div class="flow-callout ${cls} is-${tone}">${tile(iconName,tone)}<div><strong>${value}<small>${unit}</small></strong><span>${label}</span></div></div>`;
  return `<section class="dash-card impact-flow" aria-labelledby="impact-flow-title">
    <div class="impact-card-head"><div><h2 id="impact-flow-title">Energy flow</h2><p>From renewables at risk to potential EV charging · +${o.horizonMinutes} min target</p></div>
      <ul class="impact-legend"><li><i class="is-green"></i>Potential recovery</li><li><i class="is-blue"></i>Potential EV charging</li><li><small>Illustrative, not to scale</small></li></ul></div>
    <div class="flow-stage"><div class="flow-canvas">${flowScene()}
      ${callout('at-source','green','turbine',n(p.atRiskMwh),'MWh',`at risk · up to ${n(o.potentialRecoveryMwh)} MWh recoverable`)}
      ${callout('at-battery','blue','bolt',n(o.potentialRecoveryMwh*1000),'kWh','potential EV charging')}
      ${callout('at-chargers','blue','car',n(Math.round(o.evRangeKm)),'km','EV range equivalent')}
    </div></div>
    <ol class="flow-steps" aria-label="Energy flow summary">
      <li><span>1</span><b>${n(p.atRiskMwh)} MWh</b> renewables predicted at risk</li>
      <li><span>2</span><b>${n(o.potentialRecoveryMwh)} MWh</b> potentially recoverable</li>
      <li><span>3</span><b>${n(o.potentialRecoveryMwh*1000)} kWh</b> potential EV charging ≈ <b>${n(Math.round(o.evRangeKm))} km</b></li>
    </ol>
  </section>`;
}

// ---------- 3. Impact over time ----------
// Bars are stacked recovered + remaining = at risk, so nothing is double counted.
function stackedBars(rows,{width=420,height=250,label}){
  const left=46,right=width-10,top=24,bottom=height-30,max=niceMax(Math.max(...rows.map(r=>r.atRiskMwh),0));
  const slot=(right-left)/rows.length,bw=Math.max(2,Math.min(56,slot*(rows.length>6?.72:.44)));
  const y=v=>bottom-(v/max)*(bottom-top);
  const bars=rows.map((r,i)=>{
    const x=left+slot*i+(slot-bw)/2,rec=r.potentialRecoveryMwh,rem=r.atRiskMwh-rec;
    const tip=`${r.label}: ${n(r.atRiskMwh)} MWh at risk, ${n(rec)} MWh potentially recoverable, ${n(rem)} MWh remaining`;
    const act=r.horizon?`data-horizon="${r.horizon}" role="button"`:'';
    return `<g class="impact-bar ${r.selected?'is-selected':''}" ${act} ${tipAttrs(tip)}><rect class="hit" x="${left+slot*i}" y="${top}" width="${slot}" height="${bottom-top}"/><rect class="rem" x="${x}" y="${y(r.atRiskMwh)}" width="${bw}" height="${y(rec)-y(r.atRiskMwh)}" rx="${Math.min(4,bw/3)}"/><rect class="rec" x="${x}" y="${y(rec)}" width="${bw}" height="${bottom-y(rec)}" rx="${Math.min(4,bw/3)}"/>${r.tick?`<text class="impact-tick" x="${x+bw/2}" y="${bottom+17}" text-anchor="middle">${escapeHtml(r.tick)}</text>`:''}</g>`;
  }).join('');
  return `<svg class="impact-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(label)}">${yAxis(max,top,bottom,left,right,'MWh')}${bars}<line class="impact-base" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/></svg>`;
}
function impactOverTime(s){
  const day=impactDayReady(),legend=`<ul class="impact-legend"><li><i class="is-green"></i>Potential recovery</li><li><i class="is-amber"></i>Still at risk</li></ul>`;
  if(impactDayLoading())return `<section class="dash-card impact-time" aria-labelledby="impact-time-title" aria-busy="true">
    <div class="impact-card-head"><div><h2 id="impact-time-title">Impact over time</h2><p>${escapeHtml(impactDateLabel(impactDay.date))} replay · MWh per half-hour</p></div>${legend}</div>${impactSkeleton(48)}</section>`;
  let rows,sub,table;
  if(day){
    rows=impactDay.data.intervals.map((r,i)=>({...r,label:modelTime(r.targetAt),tick:i%8===0?modelTime(r.targetAt):''}));
    sub=`${escapeHtml(impactDay.date)} replay · MWh per half-hour`;
  }else{
    rows=s.outcomes.map(o=>({...o,label:`+${o.horizonMinutes} min (${modelTime(o.targetAt)})`,tick:`${modelTime(o.targetAt)} · +${o.horizonMinutes}`,horizon:o.horizonMinutes,selected:o.horizonMinutes===modelState.horizon}));
    sub='Two forecast targets · MWh per half-hour · select a bar';
  }
  table=`<table><caption>Impact over time data</caption><thead><tr><th>Target</th><th>At risk MWh</th><th>Recoverable MWh</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.label)}</td><td>${n(r.atRiskMwh)}</td><td>${n(r.potentialRecoveryMwh)}</td></tr>`).join('')}</tbody></table>`;
  return `<section class="dash-card impact-time" aria-labelledby="impact-time-title">
    <div class="impact-card-head"><div><h2 id="impact-time-title">Impact over time</h2><p>${sub}</p></div>${legend}</div>
    <div class="impact-chart-wrap">${stackedBars(rows,{label:'Potential recovery and remaining risk per half-hour'})}<div class="impact-tooltip" role="status" aria-live="polite"></div></div>
    ${day?'':`<p class="impact-pending">${impactDay.status==='error'?`Day replay unavailable for ${escapeHtml(impactDateLabel(impactDay.date))} — showing the two forecast targets. Pick another day to retry.`:'48-interval day replay appears here once <code>/api/v1/impact/day</code> is connected.'}</p>`}
    <details class="impact-data-table"><summary>View data</summary>${table}</details>
  </section>`;
}

// ---------- 4. Impact by forecast event ----------
function impactEvents(s){
  const best=s.recommendedHorizonMinutes;
  const rows=s.outcomes.map(o=>{const selected=o.horizonMinutes===modelState.horizon;return `<button type="button" class="impact-event ${selected?'is-selected':''}" data-horizon="${o.horizonMinutes}" aria-pressed="${selected}">
    <span class="impact-event-time"><b>${escapeHtml(modelTime(o.targetAt))}</b><small>+${o.horizonMinutes} min${o.horizonMinutes===best?' · <em>Recommended</em>':''}</small></span>
    <span><small>At risk</small>${n(o.atRiskMwh)} MWh</span><span class="is-green"><small>Recoverable</small>${n(o.potentialRecoveryMwh)} MWh</span><span class="is-blue"><small>EV charging</small>${n(o.potentialRecoveryMwh*1000)} kWh</span><span><small>CO₂ avoided</small>${impactCo2Text(o.avoidedEmissionsTco2)}</span></button>`}).join('');
  return `<section class="dash-card impact-events" aria-labelledby="impact-events-title">
    <div class="impact-card-head"><div><h2 id="impact-events-title">Impact by forecast event</h2><p>Each half-hour target evaluated with the same demand</p></div></div>
    <div class="impact-event-list">${rows}</div>
    <p class="impact-note">Both targets use the <b>same</b> flexible demand — alternatives, never summed.</p>
  </section>`;
}

// ---------- 5. Cumulative impact (day replay) or allocation (fallback) ----------
function cumulativeChart(metric){
  const m=IMPACT_METRICS[metric],rows=impactDay.data.intervals;let sum=0;
  const points=rows.map(r=>({t:r.targetAt,v:(sum+=r[m.field])}));
  const width=420,height=190,left=46,right=width-12,top=26,bottom=height-28,max=niceMax(sum);
  const x=i=>left+(right-left)*(i/(points.length-1||1)),y=v=>bottom-(v/max)*(bottom-top);
  const line=points.map((p,i)=>`${i?'L':'M'}${x(i)} ${y(p.v)}`).join(' ');
  const dots=points.map((p,i)=>`<circle class="impact-cum-dot" cx="${x(i)}" cy="${y(p.v)}" r="5" ${tipAttrs(`${modelTime(p.t)}: ${m.format(p.v)} cumulative`)}/>`).join('');
  const ticks=points.map((p,i)=>i%8===0?`<text class="impact-tick" x="${x(i)}" y="${bottom+17}" text-anchor="middle">${modelTime(p.t)}</text>`:'').join('');
  return `<div class="impact-chart-wrap"><svg class="impact-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Cumulative ${m.label.toLowerCase()} over the replayed day">${yAxis(max,top,bottom,left,right,'')}<path class="impact-cum-area" d="${line} L${x(points.length-1)} ${bottom} L${left} ${bottom}Z"/><path class="impact-cum-line" d="${line}"/>${dots}${ticks}<line class="impact-base" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/></svg><div class="impact-tooltip" role="status" aria-live="polite"></div><span class="impact-cum-total">${m.format(sum)}<small>day total</small></span></div>`;
}
function allocationBars(o,s){
  const bar=(title,total,parts)=>`<div class="impact-alloc"><div class="impact-alloc-head"><span>${title}</span><b>${n(total)} MWh</b></div><div class="impact-alloc-bar">${parts.map(([cls,v])=>`<i class="${cls}" style="flex-grow:${total>0?v/total:0}"></i>`).join('')}</div><div class="impact-alloc-key">${parts.map(([cls,v,l])=>`<span><i class="${cls}"></i>${l} <b>${n(v)} MWh</b></span>`).join('')}</div></div>`;
  return bar('Renewables at risk',o.atRiskMwh,[['is-green',o.potentialRecoveryMwh,'Potentially recoverable'],['is-amber',o.remainingWasteMwh,'Still at risk']])
    +bar('Charging demand',s.totalDemandMwh,[['is-blue',o.potentialRecoveryMwh,'From recovered renewables'],['is-grey',o.remainingDemandMwh,'Schedule elsewhere']]);
}
function impactCumulative(o,s){
  if(impactDayLoading())return `<section class="dash-card impact-cumulative" aria-labelledby="impact-cum-title" aria-busy="true">
    <div class="impact-card-head"><div><h2 id="impact-cum-title">Cumulative impact</h2><p>Running total · ${escapeHtml(impactDateLabel(impactDay.date))} replay</p></div></div>${impactSkeleton(16)}</section>`;
  const day=impactDayReady();
  const tabs=day?`<div class="studio-segment" role="group" aria-label="Cumulative metric">${Object.entries(IMPACT_METRICS).map(([k,m])=>`<button type="button" data-impact-metric="${k}" class="${impactDay.metric===k?'active':''}" aria-pressed="${impactDay.metric===k}">${m.label}</button>`).join('')}</div>`:'';
  return `<section class="dash-card impact-cumulative" aria-labelledby="impact-cum-title">
    <div class="impact-card-head"><div><h2 id="impact-cum-title">${day?'Cumulative impact':'Energy allocation'}</h2><p>${day?`Running total · ${escapeHtml(impactDay.date)} replay`:`Selected +${o.horizonMinutes} min scenario`}</p></div>${tabs||`<button class="impact-link" data-page="charging" type="button">Adjust scenario ${icon('arrow',15)}</button>`}</div>
    ${day?cumulativeChart(impactDay.metric):allocationBars(o,s)}
  </section>`;
}

// ---------- header controls ----------
function impactToolbar(){
  // Once the dataset range is known the controls stay usable, even while a day is loading.
  const r=impactDay.range,d=impactDay.date,usable=Boolean(r&&d);
  const period={ready:'Day',loading:'Loading…',error:'Unavailable'}[impactDay.status]||'Day replay pending';
  const dateNav=`<div class="impact-date ${usable?'':'is-off'} ${impactDayLoading()?'is-loading':''}" role="group" aria-label="Replay day">
    <button type="button" data-impact-shift="-1" aria-label="Previous day" ${usable&&d>r.min?'':'disabled'}>‹</button>
    <label>${icon('calendar',17)}<input id="impact-date" type="date" aria-label="Replay date" value="${d||''}" min="${r?.min||''}" max="${r?.max||''}" ${usable?'':'disabled'}></label>
    <button type="button" data-impact-shift="1" aria-label="Next day" ${usable&&d<r.max?'':'disabled'}>›</button>
    <span class="impact-period">${period}</span></div>`;
  return `<div class="impact-toolbar">${dateNav}${studioControls()}</div>`;
}

function impactMethodology(s){
  const a=s.assumptions;
  return `<details class="dash-card impact-method"><summary>${tile('settings','green')}<span class="impact-method-copy"><strong>Methodology and assumptions</strong><small>${n(a.gridIntensityTco2PerMwh*1000)} gCO₂/kWh grid intensity · ${n(a.evKwhPerKm)} kWh/km · ${escapeHtml(impactLabel().toLowerCase())} values</small></span></summary><ul>${s.methodology.map(line=>`<li>${escapeHtml(line)}</li>`).join('')}</ul></details>`;
}

function renderImpact(){
  const subtitle='Turning renewable energy at risk into potential EV-charging benefits.';
  if(modelState.loading||modelState.error)return studioShell('Impact',subtitle,()=>'');
  ensureImpactDay();
  const top=studioHeader('Impact',subtitle)+impactToolbar();
  const p=selectedPrediction(),o=scenarioOutcome(p),s=modelState.data.scenario;
  return `${top}<div class="impact-layout">${impactStats(o)}${impactFlow(p,o)}${impactOverTime(s)}${impactEvents(s)}${impactCumulative(o,s)}</div>${impactMethodology(s)}${provenance()}`;
}

// ---------- interactions ----------
document.addEventListener('click',event=>{
  const metric=event.target.closest('[data-impact-metric]');
  if(metric){impactDay.metric=metric.dataset.impactMetric;render();return}
  const shift=event.target.closest('[data-impact-shift]');
  if(shift)shiftImpactDate(Number(shift.dataset.impactShift));
});
document.addEventListener('change',event=>{
  if(event.target.id!=='impact-date'||!event.target.value)return;
  impactDay.date=event.target.value;requestImpactDay();
});
document.addEventListener('keydown',event=>{
  const bar=event.target.closest?.('[data-horizon][role="button"]');
  if(bar&&(event.key==='Enter'||event.key===' ')){event.preventDefault();bar.dispatchEvent(new MouseEvent('click',{bubbles:true}))}
});
function showImpactTip(event){
  const target=event.target.closest?.('[data-tip]'),wrap=target?.closest('.impact-chart-wrap');if(!wrap)return;
  const tip=wrap.querySelector('.impact-tooltip'),box=target.getBoundingClientRect(),host=wrap.getBoundingClientRect(),scale=host.width/wrap.offsetWidth||1;
  tip.textContent=target.dataset.tip;tip.classList.add('on');
  tip.style.left=`${(box.left+box.width/2-host.left)/scale}px`;tip.style.top=`${(box.top-host.top)/scale}px`;
}
function hideImpactTip(event){event.target.closest?.('.impact-chart-wrap')?.querySelector('.impact-tooltip')?.classList.remove('on')}
document.addEventListener('pointerover',showImpactTip);document.addEventListener('focusin',showImpactTip);
document.addEventListener('pointerout',hideImpactTip);document.addEventListener('focusout',hideImpactTip);
