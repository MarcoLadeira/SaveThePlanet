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

const impactDay={date:null,range:null,status:'idle',data:null,key:'',metric:'energy',timeMetric:'recovery',request:0,prev:null};
const IMPACT_METRICS={
  energy:{label:'Energy',field:'potentialRecoveryMwh',format:v=>`${n(v)} MWh`},
  emissions:{label:'Emissions',field:'avoidedEmissionsTco2',format:v=>impactCo2Text(v)},
  distance:{label:'Distance',field:'evRangeKm',format:v=>`${n(Math.round(v))} km`}
};
// Series for the "Impact over time" dropdown; each is plotted on its own scale.
const IMPACT_SERIES={
  recovery:{label:'Potential recovery',field:'potentialRecoveryMwh',unit:'MWh',tone:'green',format:v=>`${n(v)} MWh`},
  range:{label:'EV range equivalent',field:'evRangeKm',unit:'km',tone:'blue',format:v=>`${n(Math.round(v))} km`},
  risk:{label:'Energy at risk',field:'atRiskMwh',unit:'MWh',tone:'amber',format:v=>`${n(v)} MWh`}
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
  return `<div class="impact-skeleton" role="status" aria-live="polite"><div class="impact-skel-bars" aria-hidden="true">${heights.map(h=>`<i class="motion-loop" style="height:${Math.max(8,h)}%"></i>`).join('')}</div><span>Loading ${escapeHtml(impactDateLabel(impactDay.date))} replay…</span></div>`;
}

// ---------- day replay loading ----------
// The replay day follows the dashboard's current forecast target (a random high-MWh dataset
// half-hour chosen by the backend), so a new target also loads a new day.
// The pinned target, not whatever data is on screen: an offline example has its own unrelated time.
function impactTargetDay(){const t=modelState.target;return t?t.slice(0,10):null}
function impactDayKey(){return [impactTargetDay(),modelState.capacity,modelState.totalDemandKwh,modelState.flexibleDemandKwh].join('|')}
async function loadImpactDay(){
  const request=++impactDay.request;
  impactDay.key=impactDayKey();impactDay.status='loading';
  const query=new URLSearchParams({capacityMw:String(modelState.capacity),totalDemandKwh:String(modelState.totalDemandKwh),flexibleDemandKwh:String(modelState.flexibleDemandKwh)});
  if(impactTargetDay())query.set('date',impactTargetDay());
  try{
    const response=await fetch(`/api/v1/impact/day?${query}`);
    if(request!==impactDay.request)return;
    if(response.status===404){impactDay.status='unavailable';impactDay.data=null;return}
    const body=await response.json();
    if(!response.ok||!Array.isArray(body.intervals))throw new Error(body.error?.message||'Day replay unavailable');
    impactDay.data=body;impactDay.range=body.range||impactDay.range;impactDay.date=body.date;impactDay.key=impactDayKey();impactDay.status='ready';
    loadPreviousDay(request);
  }catch{if(request===impactDay.request){impactDay.status='error';impactDay.data=null}}
  finally{if(request===impactDay.request&&pageFromHash()==='impact')render()}
}
// Previous replay day's totals for the KPI "vs previous day" line. Fetched after the main day;
// the backend prefetches the previous day first, so this is usually already cached.
function previousDate(value){const d=new Date(`${value}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10)}
function shortDate(value){return impactDateLabel(value).replace(/ \d{4}$/,'')}
async function loadPreviousDay(request){
  const date=previousDate(impactDay.date),key=impactDayKey();
  if(impactDay.range&&date<impactDay.range.min){impactDay.prev={key,date,status:'none'};return}
  impactDay.prev={key,date,status:'loading'};
  const query=new URLSearchParams({date,capacityMw:String(modelState.capacity),totalDemandKwh:String(modelState.totalDemandKwh),flexibleDemandKwh:String(modelState.flexibleDemandKwh)});
  try{
    const response=await fetch(`/api/v1/impact/day?${query}`),body=await response.json();
    if(!response.ok||!body.totals)throw new Error();
    if(request===impactDay.request)impactDay.prev={key,date,status:'ready',totals:body.totals};
  }catch{if(request===impactDay.request)impactDay.prev={key,date,status:'error'}}
  if(request===impactDay.request&&pageFromHash()==='impact')render();
}
function previousTotals(){const p=impactDay.prev;return p&&p.key===impactDay.key&&p.status==='ready'?p.totals:null}

// Called while rendering: mark the day as loading immediately so this very render shows the
// placeholders (first visit, or capacity/demand changed) rather than the two-target fallback.
function ensureImpactDay(){
  if(impactDay.status==='loading'||impactDay.key===impactDayKey())return;
  impactDay.status='loading';impactDay.key=impactDayKey();setTimeout(loadImpactDay);
}

// ---------- chart primitives ----------
function niceMax(value){if(!(value>0))return 1;const p=10**Math.floor(Math.log10(value)),m=value/p;return (m<=1?1:m<=2?2:m<=2.5?2.5:m<=5?5:10)*p}
function yAxis(max,top,bottom,left,right,unit){
  return [0,.25,.5,.75,1].map(t=>{const y=bottom-(bottom-top)*t;return `<line class="impact-grid" x1="${left}" x2="${right}" y1="${y}" y2="${y}"/><text class="impact-tick" x="${left-8}" y="${y+3}" text-anchor="end">${n(max*t)}</text>`}).join('')+`<text class="impact-tick" x="${left-8}" y="${top-12}" text-anchor="end">${unit}</text>`;
}
// Smooth curve through points; control points are clamped between neighbours so the line
// never overshoots (no invented dips below zero or peaks above the data).
function smoothPath(points){
  if(!points.length)return '';
  let d=`M${points[0][0]} ${points[0][1]}`;
  for(let i=0;i<points.length-1;i++){
    const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2,lo=Math.min(p1[1],p2[1]),hi=Math.max(p1[1],p2[1]);
    const c1=Math.min(hi,Math.max(lo,p1[1]+(p2[1]-p0[1])*.2)),c2=Math.min(hi,Math.max(lo,p2[1]-(p3[1]-p1[1])*.2)),dx=(p2[0]-p1[0])/3;
    d+=` C${p1[0]+dx} ${c1} ${p2[0]-dx} ${c2} ${p2[0]} ${p2[1]}`;
  }
  return d;
}
// Glow filter and gradient fills shared by every chart on the page (referenced by id).
function impactDefs(){
  const grad=tone=>`<linearGradient id="impact-fill-${tone}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop-${tone}" stop-opacity=".55"/><stop offset="1" class="stop-${tone}" stop-opacity="0"/></linearGradient>`;
  return `<svg class="impact-defs" aria-hidden="true" focusable="false"><defs><filter id="impact-glow" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>${['green','blue','amber'].map(grad).join('')}</defs></svg>`;
}
function sparkArea(values,tone){
  const w=110,h=42,max=Math.max(...values,0)||1,pts=values.map((v,i)=>[2+(w-4)*(i/(values.length-1||1)),h-3-(v/max)*(h-8)]);
  const line=smoothPath(pts);
  return `<svg class="impact-spark is-${tone}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="area" d="${line} L${pts.at(-1)[0]} ${h} L${pts[0][0]} ${h}Z" fill="url(#impact-fill-${tone})"/><path class="line" d="${line}" pathLength="1" filter="url(#impact-glow)"/></svg>`;
}
function tipAttrs(text){return `data-tip="${escapeHtml(text)}" tabindex="0" aria-label="${escapeHtml(text)}"`}
// Charts draw themselves in when they first appear or show new data; live refreshes and
// unrelated re-renders leave them still.
const impactDrawn={};
function drawIn(name,signature){const fresh=impactDrawn[name]!==signature;impactDrawn[name]=signature;return fresh&&!liveRender?' is-drawing':''}

// Tiny data-backed microvisuals for the KPI cards.
function microBars(values,active){
  const max=Math.max(...values,0)||1,w=96,h=40,gap=values.length>6?1.5:10,bw=(w-gap*(values.length-1))/values.length;
  return `<svg class="impact-micro" viewBox="0 0 ${w} ${h}" aria-hidden="true">${values.map((v,i)=>{const bh=Math.max(v/max*(h-4),v>0?2:0);return `<rect x="${i*(bw+gap)}" y="${h-bh}" width="${bw}" height="${bh}" rx="${Math.min(3,bw/2)}" class="${i===active?'on':''}"/>`}).join('')}</svg>`;
}
function kpiMicro(field,scale=1,tone='green'){
  if(impactDayLoading())return {svg:'<span class="impact-micro impact-micro-skel motion-loop" aria-hidden="true"></span>',caption:'Loading…'};
  if(impactDayReady())return {svg:sparkArea(impactDay.data.intervals.map(i=>i[field]*scale),tone),caption:`${shortDate(impactDay.date)} · 48 half-hours`};
  const outcomes=modelState.data.scenario.outcomes;
  return {svg:microBars(outcomes.map(o=>o[field]*scale),outcomes.findIndex(o=>o.horizonMinutes===modelState.horizon)),caption:outcomes.map(o=>`+${o.horizonMinutes}`).join(' · ')};
}

// ---------- 1. KPI cards ----------
// Headline figures count up when they appear and glide to new values on live refreshes,
// through the dashboard's chart engine (charts3d.js).
function impactFigure(name,value,format){dashCharts[name]={value,format,values:()=>({v:value()}),start:()=>({v:0}),draw:({v})=>{const [num,unit]=format(v);return `<strong>${num}<small>${unit}</small></strong>`}}}
impactFigure('impactRecovery',()=>scenarioNow().potentialRecoveryMwh,v=>[n(v),'MWh']);
impactFigure('impactCharging',()=>scenarioNow().potentialRecoveryMwh*1000,v=>[n(v),'kWh']);
impactFigure('impactCo2',()=>scenarioNow().avoidedEmissionsTco2,impactCo2Parts);
impactFigure('impactRange',()=>scenarioNow().evRangeKm,v=>[n(Math.round(v)),'km']);
impactFigure('impactFlowRisk',()=>selectedPrediction().atRiskMwh,v=>[n(v),'MWh']);
impactFigure('impactFlowCharging',()=>scenarioNow().potentialRecoveryMwh*1000,v=>[n(v),'kWh']);
impactFigure('impactFlowRange',()=>scenarioNow().evRangeKm,v=>[n(Math.round(v)),'km']);
// Rendered at zero, so the card keeps its height until chartsSync counts the figure up.
function figureSlot(name,label){const f=dashCharts[name];return `<div class="chart3d" data-chart="${name}" role="img" aria-label="${escapeHtml(`${label}: ${f.format(f.value()).join(' ')}`)}">${f.draw({v:0})}</div>`}
function impactKpi(iconName,tone,label,figure,note,micro){
  return `<article class="impact-kpi is-${tone}">${tile(iconName,tone)}<div class="impact-kpi-copy"><span>${label}</span>${figureSlot(figure,label)}<em>${note}</em></div><figure class="impact-kpi-micro">${micro.svg}<figcaption>${micro.caption}</figcaption></figure></article>`;
}
// Day-over-day change between two replay days' totals. Every recovery-derived KPI scales with
// recovered energy, so they share the same change.
function dayDelta(field){
  const prev=previousTotals(),p=impactDay.prev;
  if(!impactDayReady()||!p||p.key!==impactDay.key)return '';
  const vs=shortDate(p.date);
  if(p.status==='loading')return `<span class="impact-delta">vs ${vs} loading…</span>`;
  if(!prev)return '';
  const now=impactDay.data.totals[field],before=prev[field];
  if(!before)return `<span class="impact-delta">${now?'Up from 0':'No change'}<small> vs ${vs}</small></span>`;
  const change=(now-before)/before,dir=Math.abs(change)<.005?'flat':change>0?'up':'down';
  const title=`Day total ${impactDateLabel(impactDay.date)} vs ${impactDateLabel(p.date)}: ${n(before)} → ${n(now)}`;
  return `<span class="impact-delta is-${dir}" title="${escapeHtml(title)}">${{up:'↑',down:'↓',flat:'→'}[dir]} ${Math.round(Math.abs(change*100))}%<small> vs ${vs}</small></span>`;
}
function impactStats(o){
  const scope=`+${o.horizonMinutes} min · ${impactLabel().toLowerCase()}`;
  const note=(field,fallback)=>dayDelta(field)||fallback;
  return `<section class="impact-kpis${drawIn('kpis',`${impactDay.status}|${impactDay.key}`)}" aria-label="Selected scenario impact">
    ${impactKpi('bolt','green','Potential renewable recovery','impactRecovery',note('potentialRecoveryMwh',`${pct(o.recoveryRate)} of at-risk · ${scope}`),kpiMicro('potentialRecoveryMwh'))}
    ${impactKpi('battery','blue','Potential EV charging','impactCharging',note('potentialRecoveryMwh',`${pct(o.cleanChargingShare)} of demand · ${scope}`),kpiMicro('potentialRecoveryMwh',1000,'blue'))}
    ${impactKpi('leaf','green','Est. emissions avoided','impactCo2',note('avoidedEmissionsTco2',scope),kpiMicro('avoidedEmissionsTco2'))}
    ${impactKpi('car','blue','EV range equivalent','impactRange',note('evRangeKm',`Illustrative · ${scope}`),kpiMicro('evRangeKm',1,'blue'))}
  </section>`;
}

// ---------- 2. Energy flow hero ----------
// The static artwork and animated overlay use the same coordinate system (2060x763) and share
// one box at the art's true ratio (impact.css), so the lights stay on the ribbons and the scene
// is never stretched.
// Keep API-driven figures in HTML, never baked into the image.
let impactFlowPaused=false;
// Loops pick up the phase already on screen (the old page is still in the DOM while rendering),
// so re-renders such as live refreshes never make the turbines jump.
function loopDelay(selector,index,delay){
  const running=document.querySelectorAll(`#app ${selector}`)[index]?.getAnimations()[0];
  return running?.currentTime==null?delay:(running.effect.getTiming().delay-running.currentTime)/1000;
}
function flowScene(){
  let rotors=0,pulses=0;
  const rotor=(x,y,scale,duration,delay)=>`<g transform="translate(${x} ${y}) scale(${scale})"><g class="flow-rotor motion-loop" style="animation-duration:${duration}s;animation-delay:${loopDelay('.flow-rotor',rotors++,delay).toFixed(3)}s">${[0,120,240].map(angle=>`<g transform="rotate(${angle})"><path d="M-4 3 C-9 -20 -6 -46 -2 -69 L0 -124 C5 -103 10 -60 9 -34 L4 3Z" fill="url(#rotor-metal)" stroke="#9daeb2" stroke-width=".7"/><path d="M0 -119 L1 -12" stroke="#f5f9f9" stroke-width="1" opacity=".8"/></g>`).join('')}<circle r="8" fill="url(#rotor-hub)" stroke="#9aabad"/></g></g>`;

  const pulse=(tone,d,delay)=>`<path class="flow-light motion-loop ${tone}" d="${d}" pathLength="100" style="animation-delay:${loopDelay('.flow-light',pulses++,delay).toFixed(3)}s"/>`;
  return `<picture><source srcset="./assets/energy-flow-landscape.avif?v=hd1" type="image/avif"><img class="flow-artwork" src="./assets/energy-flow-landscape.webp?v=hd1" width="2061" height="763" alt="Wind turbines beside a lake, an energy cabinet and electric cars at charging stations, linked by illustrative green and orange energy ribbons." decoding="async"></picture>
    <svg class="flow-motion" viewBox="0 0 2060 763" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="rotor-metal"><stop stop-color="#899ca3"/><stop offset=".45" stop-color="#eff4f4"/><stop offset="1" stop-color="#b2c0c3"/></linearGradient>
        <radialGradient id="rotor-hub" cx=".3" cy=".3"><stop stop-color="#eef3ef"/><stop offset="1" stop-color="#84999e"/></radialGradient>
      </defs>
      ${rotor(157,260,.65,11,-4)}
      ${rotor(281,193,1,9,-1)}
      ${pulse('green','M282 205 C380 240 426 352 584 357 S785 290 952 378',0)}
      ${pulse('green soft','M288 214 C407 273 443 377 601 382 S795 316 951 405',-1.8)}
      ${pulse('blue','M1168 395 C1250 402 1304 443 1397 432 S1540 401 1652 446',-1)}
      ${pulse('blue soft','M1168 417 C1260 441 1300 510 1407 482',-2.5)}
      ${pulse('blue soft','M1168 386 C1350 397 1363 456 1510 417 S1755 411 1923 442',-2)}
    </svg>`;
}
function impactFlow(p,o){
  const callout=(cls,tone,iconName,figure,name,label)=>`<div class="flow-callout ${cls} is-${tone}">${tile(iconName,tone)}<div>${figureSlot(figure,name)}<span>${label}</span></div></div>`;
  return `<section class="dash-card impact-flow ${impactFlowPaused?'is-motion-paused':''} ${o.potentialRecoveryMwh>0?'':'is-flow-idle'}" aria-labelledby="impact-flow-title">
    <div class="impact-card-head"><div><h2 id="impact-flow-title">Energy flow</h2><p>From renewables at risk to potential EV charging · +${o.horizonMinutes} min target</p></div>
      <ul class="impact-legend"><li><i class="is-green"></i>Potential recovery</li><li><i class="is-blue"></i>Potential EV charging</li><li><small>Illustrative, not to scale</small></li><li><button class="flow-motion-toggle" type="button" data-flow-pause aria-pressed="${impactFlowPaused}">${impactFlowPaused?'Play animation':'Pause animation'}</button></li></ul></div>
    <div class="flow-stage"><div class="flow-canvas">${flowScene()}
      ${callout('at-source','green','turbine','impactFlowRisk','Renewables at risk',`at risk · up to ${n(o.potentialRecoveryMwh)} MWh recoverable`)}
      ${callout('at-battery','blue','bolt','impactFlowCharging','Potential EV charging','potential EV charging')}
      ${callout('at-chargers','blue','car','impactFlowRange','EV range equivalent','EV range equivalent')}
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
// Area chart of one day-replay series on its own zero-based scale, with a peak callout and a
// focusable hover target per half-hour.
function areaChart(rows,series,{width=420,height=250}={}){
  const left=46,right=width-10,top=34,bottom=height-30,values=rows.map(r=>r[series.field]),peak=Math.max(...values,0),max=niceMax(peak);
  const x=i=>left+(right-left)*(i/(rows.length-1||1)),y=v=>bottom-(v/max)*(bottom-top),pts=values.map((v,i)=>[x(i),y(v)]);
  const line=smoothPath(pts),slot=(right-left)/(rows.length-1||1);
  const hits=rows.map((r,i)=>`<g class="impact-pt" ${tipAttrs(`${modelTime(r.targetAt)}: ${series.format(values[i])}`)}><rect class="hit" x="${x(i)-slot/2}" y="${top}" width="${slot}" height="${bottom-top}"/><line class="guide" x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${bottom}"/><circle cx="${x(i)}" cy="${y(values[i])}" r="4"/></g>`).join('');
  const ticks=rows.map((r,i)=>i%8===0?`<text class="impact-tick" x="${x(i)}" y="${bottom+17}" text-anchor="middle">${modelTime(r.targetAt)}</text>`:'').join('');
  const at=values.indexOf(peak),px=Math.min(Math.max(x(at),left+44),right-44);
  const callout=peak>0?`<g class="impact-peak" aria-hidden="true"><circle class="dot is-${series.tone}" cx="${x(at)}" cy="${y(peak)}" r="4.5"/><rect x="${px-44}" y="${y(peak)-34}" width="88" height="26" rx="7"/><text x="${px}" y="${y(peak)-22}" text-anchor="middle">${escapeHtml(series.format(peak))}</text><text class="sub" x="${px}" y="${y(peak)-12}" text-anchor="middle">peak · ${modelTime(rows[at].targetAt)}</text></g>`:'';
  return `<svg class="impact-chart impact-area is-${series.tone}" viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(series.label)} per half-hour">${yAxis(max,top,bottom,left,right,series.unit)}<path class="area" d="${line} L${x(rows.length-1)} ${bottom} L${left} ${bottom}Z" fill="url(#impact-fill-${series.tone})"/><path class="line" d="${line}" pathLength="1" filter="url(#impact-glow)"/>${ticks}<line class="impact-base" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>${hits}${callout}</svg>`;
}
function seriesSelect(){
  return `<label class="impact-select"><span class="visually-hidden">Series</span><select id="impact-time-metric">${Object.entries(IMPACT_SERIES).map(([k,m])=>`<option value="${k}" ${impactDay.timeMetric===k?'selected':''}>${m.label}</option>`).join('')}</select></label>`;
}
function impactOverTime(s){
  const day=impactDayReady(),legend=`<ul class="impact-legend"><li><i class="is-green"></i>Potential recovery</li><li><i class="is-amber"></i>Still at risk</li></ul>`;
  if(impactDayLoading()){drawIn('time','loading');return `<section class="dash-card impact-time" aria-labelledby="impact-time-title" aria-busy="true">
    <div class="impact-card-head"><div><h2 id="impact-time-title">Impact over time</h2><p>${escapeHtml(impactDateLabel(impactDay.date))} replay · MWh per half-hour</p></div>${legend}</div>${impactSkeleton(48)}</section>`}
  let rows,sub,table;
  if(day){
    const series=IMPACT_SERIES[impactDay.timeMetric];
    rows=impactDay.data.intervals;
    table=`<table><caption>${escapeHtml(series.label)} per half-hour</caption><thead><tr><th>Half-hour</th><th>${escapeHtml(series.label)}</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(modelTime(r.targetAt))}</td><td>${escapeHtml(series.format(r[series.field]))}</td></tr>`).join('')}</tbody></table>`;
    return `<section class="dash-card impact-time" aria-labelledby="impact-time-title">
    <div class="impact-card-head"><div><h2 id="impact-time-title">Impact over time</h2><p>${escapeHtml(shortDate(impactDay.date))} replay · ${series.unit} per half-hour</p></div>${seriesSelect()}</div>
    <div class="impact-chart-wrap${drawIn('time',`${impactDay.key}|${impactDay.timeMetric}`)}">${areaChart(rows,series)}<div class="impact-tooltip" role="status" aria-live="polite"></div></div>
    <details class="impact-data-table"><summary>View data</summary>${table}</details>
  </section>`;
  }else{
    rows=s.outcomes.map(o=>({...o,label:`+${o.horizonMinutes} min (${modelTime(o.targetAt)})`,tick:`${modelTime(o.targetAt)} · +${o.horizonMinutes}`,horizon:o.horizonMinutes,selected:o.horizonMinutes===modelState.horizon}));
    sub='Two forecast targets · MWh per half-hour · select a bar';
  }
  table=`<table><caption>Impact over time data</caption><thead><tr><th>Target</th><th>At risk MWh</th><th>Recoverable MWh</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.label)}</td><td>${n(r.atRiskMwh)}</td><td>${n(r.potentialRecoveryMwh)}</td></tr>`).join('')}</tbody></table>`;
  return `<section class="dash-card impact-time" aria-labelledby="impact-time-title">
    <div class="impact-card-head"><div><h2 id="impact-time-title">Impact over time</h2><p>${sub}</p></div>${legend}</div>
    <div class="impact-chart-wrap${drawIn('time','targets')}">${stackedBars(rows,{label:'Potential recovery and remaining risk per half-hour'})}<div class="impact-tooltip" role="status" aria-live="polite"></div></div>
    ${day?'':`<p class="impact-pending">${impactDay.status==='error'?`Day replay unavailable for ${escapeHtml(impactDateLabel(impactDay.date))} — showing the two forecast targets. It will retry on the next refresh.`:'48-interval day replay appears here once <code>/api/v1/impact/day</code> is connected.'}</p>`}
    <details class="impact-data-table"><summary>View data</summary>${table}</details>
  </section>`;
}

// ---------- 4. Impact by forecast event ----------
// Honest event label: which dispatch-down component the model predicts dominates.
function eventDriver(horizon){
  const p=modelState.data.predictions.find(x=>x.horizonMinutes===horizon);
  if(!p||p.atRiskMwh===0)return `<span class="impact-driver is-none">No surplus</span>`;
  const constraint=p.constraintMwh>=p.curtailmentMwh;
  return `<span class="impact-driver ${constraint?'is-constraint':'is-curtailment'}" title="${escapeHtml(`Constraint ${n(p.constraintMwh)} MWh · curtailment ${n(p.curtailmentMwh)} MWh`)}">${icon(constraint?'tower':'turbine',13)}${constraint?'Constraint-led':'Curtailment-led'}</span>`;
}
function impactEvents(s){
  const best=s.recommendedHorizonMinutes;
  const rows=s.outcomes.map(o=>{const selected=o.horizonMinutes===modelState.horizon;return `<button type="button" class="impact-event ${selected?'is-selected':''}" data-horizon="${o.horizonMinutes}" aria-pressed="${selected}">
    <span class="impact-event-time"><b>${escapeHtml(modelTime(o.targetAt))} ${eventDriver(o.horizonMinutes)}</b><small>+${o.horizonMinutes} min${o.horizonMinutes===best?' · <em>Recommended</em>':''}</small></span>
    <span><small>At risk</small>${n(o.atRiskMwh)} MWh</span><span class="is-green"><small>Recoverable</small>${n(o.potentialRecoveryMwh)} MWh</span><span class="is-blue"><small>EV charging</small>${n(o.potentialRecoveryMwh*1000)} kWh</span><span><small>CO₂ avoided</small>${impactCo2Text(o.avoidedEmissionsTco2)}</span></button>`}).join('');
  return `<section class="dash-card impact-events" aria-labelledby="impact-events-title">
    <div class="impact-card-head"><div><h2 id="impact-events-title">Impact by forecast event</h2><p>Both targets use the <b>same</b> flexible demand — alternatives, never summed</p></div></div>
    <div class="impact-event-list">${rows}</div>
  </section>`;
}

// ---------- 5. Cumulative impact (day replay) or allocation (fallback) ----------
function cumulativeChart(metric){
  const m=IMPACT_METRICS[metric],rows=impactDay.data.intervals;let sum=0;
  const points=rows.map(r=>({t:r.targetAt,v:(sum+=r[m.field])}));
  const width=420,height=190,left=46,right=width-12,top=26,bottom=height-28,max=niceMax(sum);
  const x=i=>left+(right-left)*(i/(points.length-1||1)),y=v=>bottom-(v/max)*(bottom-top);
  const line=smoothPath(points.map((p,i)=>[x(i),y(p.v)]));
  const dots=points.map((p,i)=>`<circle class="impact-cum-dot" cx="${x(i)}" cy="${y(p.v)}" r="5" ${tipAttrs(`${modelTime(p.t)}: ${m.format(p.v)} cumulative`)}/>`).join('');
  const ticks=points.map((p,i)=>i%8===0?`<text class="impact-tick" x="${x(i)}" y="${bottom+17}" text-anchor="middle">${modelTime(p.t)}</text>`:'').join('');
  return `<div class="impact-chart-wrap${drawIn('cum',`${impactDay.key}|${metric}`)}"><svg class="impact-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Cumulative ${m.label.toLowerCase()} over the replayed day">${yAxis(max,top,bottom,left,right,'')}<path class="impact-cum-area" d="${line} L${x(points.length-1)} ${bottom} L${left} ${bottom}Z" fill="url(#impact-fill-green)"/><path class="impact-cum-line" d="${line}" pathLength="1" filter="url(#impact-glow)"/>${dots}${ticks}<line class="impact-base" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/></svg><div class="impact-tooltip" role="status" aria-live="polite"></div><span class="impact-cum-total">${m.format(sum)}<small>day total</small></span></div>`;
}
function allocationBars(o,s){
  const bar=(title,total,parts)=>`<div class="impact-alloc"><div class="impact-alloc-head"><span>${title}</span><b>${n(total)} MWh</b></div><div class="impact-alloc-bar">${parts.map(([cls,v])=>`<i class="${cls}" style="flex-grow:${total>0?v/total:0}"></i>`).join('')}</div><div class="impact-alloc-key">${parts.map(([cls,v,l])=>`<span><i class="${cls}"></i>${l} <b>${n(v)} MWh</b></span>`).join('')}</div></div>`;
  return bar('Renewables at risk',o.atRiskMwh,[['is-green',o.potentialRecoveryMwh,'Potentially recoverable'],['is-amber',o.remainingWasteMwh,'Still at risk']])
    +bar('Charging demand',s.totalDemandMwh,[['is-blue',o.potentialRecoveryMwh,'From recovered renewables'],['is-grey',o.remainingDemandMwh,'Schedule elsewhere']]);
}
function impactCumulative(o,s){
  if(impactDayLoading()){drawIn('cum','loading');return `<section class="dash-card impact-cumulative" aria-labelledby="impact-cum-title" aria-busy="true">
    <div class="impact-card-head"><div><h2 id="impact-cum-title">Cumulative impact</h2><p>Running total · ${escapeHtml(impactDateLabel(impactDay.date))} replay</p></div></div>${impactSkeleton(16)}</section>`}
  const day=impactDayReady();
  const tabs=day?`<div class="studio-segment" role="group" aria-label="Cumulative metric">${Object.entries(IMPACT_METRICS).map(([k,m])=>`<button type="button" data-impact-metric="${k}" class="${impactDay.metric===k?'active':''}" aria-pressed="${impactDay.metric===k}">${m.label}</button>`).join('')}</div>`:'';
  return `<section class="dash-card impact-cumulative" aria-labelledby="impact-cum-title">
    <div class="impact-card-head"><div><h2 id="impact-cum-title">${day?'Cumulative impact':'Energy allocation'}</h2><p>${day?`Running total · ${escapeHtml(impactDay.date)} replay`:`Selected +${o.horizonMinutes} min scenario`}</p></div>${tabs||`<button class="impact-link" data-page="charging" type="button">Adjust scenario ${icon('arrow',15)}</button>`}</div>
    ${day?cumulativeChart(impactDay.metric):allocationBars(o,s)}
  </section>`;
}

function renderImpact(){
  const subtitle='Turning renewable energy at risk into potential EV-charging benefits.';
  if(modelState.loading||modelState.error)return studioShell('Impact',subtitle,()=>'');
  ensureImpactDay();
  // Cards rise in only when the page (or its first data) arrives; the old page is still in the DOM here.
  const intro=!liveRender&&!document.querySelector('#app .impact-layout');
  if(intro)for(const name in impactDrawn)delete impactDrawn[name];
  const top=studioHeader('Impact',subtitle);
  const p=selectedPrediction(),o=scenarioOutcome(p),s=modelState.data.scenario;
  return `${impactDefs()}${top}<div class="impact-layout${intro?' is-intro':''}">${impactStats(o)}${impactFlow(p,o)}${impactOverTime(s)}${impactEvents(s)}${impactCumulative(o,s)}</div>${provenance()}`;
}

// ---------- interactions ----------
document.addEventListener('click',event=>{
  const motion=event.target.closest('[data-flow-pause]');
  if(motion){impactFlowPaused=!impactFlowPaused;const card=motion.closest('.impact-flow');card.classList.toggle('is-motion-paused',impactFlowPaused);motion.setAttribute('aria-pressed',String(impactFlowPaused));motion.textContent=impactFlowPaused?'Play animation':'Pause animation';return}
  const metric=event.target.closest('[data-impact-metric]');
  if(metric){impactDay.metric=metric.dataset.impactMetric;render();return}
});
document.addEventListener('change',event=>{
  if(event.target.id==='impact-time-metric'){impactDay.timeMetric=event.target.value;render();return}
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
