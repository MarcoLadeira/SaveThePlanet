// Battery page: the Dashboard's fleet + grid battery plan, explained. Two data sources, both from the
// same optimizer and energy ledger as the Dashboard, so the figures always agree with it:
//  1. modelState.plan — POST /api/v1/charging/optimize for the selected half-hour (the Dashboard's plan).
//  2. dayPlan (bridge.js) — GET /api/v1/impact/day: that same plan for each half-hour of the replay day.
//     Each half-hour is a separate what-if with the same fleet and battery, so recovery is never summed
//     across the day; only the forecast energy at risk is.

const impactView={series:'captured'};
// Series for the "Across the day" dropdown; each is plotted on its own scale.
const IMPACT_SERIES={
  captured:{label:'Captured by EVs + battery',field:'capturedKwh',unit:'kWh',tone:'green',format:v=>`${n(v)} kWh`},
  stored:{label:'Stored in the grid battery',field:'storedKwh',unit:'kWh',tone:'blue',format:v=>`${n(v)} kWh`},
  ev:{label:'Charged into EVs',field:'evBatteryKwh',unit:'kWh',tone:'blue',format:v=>`${n(v)} kWh`},
  share:{label:'Share of energy at risk captured',field:'capturedSharePct',unit:'%',tone:'green',format:v=>`${n(v)}%`},
  risk:{label:'Energy at risk',field:'atRiskMwh',unit:'MWh',tone:'amber',format:v=>`${n(v)} MWh`}
};

function impactLabel(){return isDemoData()?'Simulated':'Simulated fleet and battery'}
function impactCo2Parts(kg){return kg<1000?[n(kg),'kg CO₂']:[n(kg/1000),'t CO₂']}
function impactCo2Text(kg){return impactCo2Parts(kg).join(' ')}
function impactDateLabel(value){return value?new Intl.DateTimeFormat('en-IE',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(`${value}T00:00:00Z`)):'the replay day'}
function shortDate(value){return impactDateLabel(value).replace(/ \d{4}$/,'')}
function impactDayDate(){return modelState.target?modelState.target.slice(0,10):dayPlan.data?.date}
// Placeholder for day sections while the day plan loads, so the previous day's figures never linger.
function impactSkeleton(bars=24){
  const heights=Array.from({length:bars},(_,i)=>28+Math.round(22*Math.sin(i/2.4)+18*Math.sin(i/5.1+1)));
  return `<div class="impact-skeleton" role="status" aria-live="polite"><div class="impact-skel-bars" aria-hidden="true">${heights.map(h=>`<i class="motion-loop" style="height:${Math.max(8,h)}%"></i>`).join('')}</div><span>Planning ${escapeHtml(impactDateLabel(impactDayDate()))}…</span></div>`;
}
function impactRows(){return dayPlanReady()?dayPlan.data.intervals.map(r=>({...r,capturedSharePct:r.capturedShare==null?0:r.capturedShare*100})):[]}

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
function kpiMicro(field,tone='green'){
  if(dayPlanReady())return {svg:sparkArea(impactRows().map(r=>r[field]),tone),caption:`each half-hour of ${shortDate(dayPlan.data.date)}`};
  if(!dayPlanLoading())return {svg:'',caption:'day plan unavailable'};
  return {svg:'<span class="impact-micro impact-micro-skel motion-loop" aria-hidden="true"></span>',caption:'Loading…'};
}

// ---------- 1. KPI cards (the selected half-hour, exactly as on the Dashboard) ----------
// Headline figures count up when they appear and glide to new values on live refreshes,
// through the dashboard's chart engine (charts3d.js).
function impactFigure(name,value,format){dashCharts[name]={value,format,values:()=>({v:value()}),start:()=>({v:0}),draw:({v})=>{const [num,unit]=format(v);return `<strong>${num}<small>${unit}</small></strong>`}}}
const impactLedger=()=>planAlternative().optimized.ledger;
impactFigure('impactStored',()=>planImpact(impactLedger()).stored,v=>[n(v),'kWh']);
impactFigure('impactEv',()=>impactLedger().batteryDeliveredKwh,v=>[n(v),'kWh']);
impactFigure('impactCo2',()=>planImpact(impactLedger()).co2Kg,impactCo2Parts);
impactFigure('impactShare',()=>(planImpact(impactLedger()).share||0)*100,v=>[n(v),'%']);
impactFigure('impactFlowRisk',()=>selectedPrediction().atRiskMwh,v=>[n(v),'MWh']);
impactFigure('impactFlowStored',()=>planImpact(impactLedger()).stored,v=>[n(v),'kWh']);
impactFigure('impactFlowEv',()=>impactLedger().batteryDeliveredKwh,v=>[n(v),'kWh']);
// Rendered at zero, so the card keeps its height until chartsSync counts the figure up.
function figureSlot(name,label){const f=dashCharts[name];return `<div class="chart3d" data-chart="${name}" role="img" aria-label="${escapeHtml(`${label}: ${f.format(f.value()).join(' ')}`)}">${f.draw({v:0})}</div>`}
function impactKpi(iconName,tone,label,figure,note,micro){
  return `<article class="impact-kpi is-${tone}">${tile(iconName,tone)}<div class="impact-kpi-copy"><span>${label}</span>${figureSlot(figure,label)}<em>${note}</em></div><figure class="impact-kpi-micro">${micro.svg}<figcaption>${micro.caption}</figcaption></figure></article>`;
}
function impactStats(alt){
  const L=alt.optimized.ledger,S=L.storage,m=planImpact(L),scope=`${modelTime(alt.targetAt)} · +${alt.horizonMinutes} min`;
  const cars=(alt.optimized.opportunityAllocations||[]).length,total=alt.optimized.vehiclesMet+alt.optimized.vehiclesMissed;
  return `<section class="impact-kpis${drawIn('kpis',`${dayPlan.status}|${dayPlan.key}`)}" aria-label="Selected half-hour">
    ${impactKpi('battery','blue','Stored in the grid battery','impactStored',S?`${n(S.startFraction*100)}% → ${n(S.endFraction*100)}% full · ${scope}`:scope,kpiMicro('storedKwh','blue'))}
    ${impactKpi('car','blue','Charged into EVs','impactEv',`${cars} of ${total} simulated cars · ${scope}`,kpiMicro('evBatteryKwh','blue'))}
    ${impactKpi('leaf','green','Est. CO₂ avoided','impactCo2',`EV charging + stored energy · ${scope}`,kpiMicro('co2AvoidedKg'))}
    ${impactKpi('bolt','green','Energy at risk captured','impactShare',`${n(m.captured)} kWh of ${n(L.predictedAtRiskKwh/1000)} MWh · ${scope}`,kpiMicro('capturedSharePct'))}
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
function impactFlow(p,alt){
  const L=alt.optimized.ledger,m=planImpact(L);
  const callout=(cls,tone,iconName,figure,name,label)=>`<div class="flow-callout ${cls} is-${tone}">${tile(iconName,tone)}<div>${figureSlot(figure,name)}<span>${label}</span></div></div>`;
  return `<section class="dash-card impact-flow ${impactFlowPaused?'is-motion-paused':''} ${m.captured>0?'':'is-flow-idle'}" aria-labelledby="impact-flow-title">
    <div class="impact-card-head"><div><h2 id="impact-flow-title">Energy flow</h2><p>Renewables at risk → grid battery and EV chargers · +${alt.horizonMinutes} min forecast</p></div>
      <ul class="impact-legend"><li><i class="is-green"></i>Energy at risk</li><li><i class="is-blue"></i>Stored and charged</li><li><small>Illustrative, not to scale</small></li><li><button class="flow-motion-toggle" type="button" data-flow-pause aria-pressed="${impactFlowPaused}">${impactFlowPaused?'Play animation':'Pause animation'}</button></li></ul></div>
    <div class="flow-stage"><div class="flow-canvas">${flowScene()}
      ${callout('at-source','green','turbine','impactFlowRisk','Renewables at risk',`at risk · ${n(m.captured)} kWh captured`)}
      ${callout('at-battery','blue','battery','impactFlowStored','Stored in the grid battery','stored in the grid battery')}
      ${callout('at-chargers','blue','car','impactFlowEv','Charged into EVs',`into EV batteries ≈ ${n(Math.round(m.rangeKm))} km`)}
    </div></div>
    <ol class="flow-steps" aria-label="Energy flow summary">
      <li><span>1</span><b>${n(p.atRiskMwh)} MWh</b> renewables predicted at risk</li>
      <li><span>2</span><b>${n(L.allocatedToChargersGridKwh)} kWh</b> to EV chargers first, <b>${n(L.allocatedToRealStorageKwh||0)} kWh</b> to the grid battery</li>
      <li><span>3</span><b>${n(L.batteryDeliveredKwh)} kWh</b> into EVs ≈ <b>${n(Math.round(m.rangeKm))} km</b>, <b>${n(m.stored)} kWh</b> stored</li>
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
    const x=left+slot*i+(slot-bw)/2,rec=r.capturedMwh,rem=r.atRiskMwh-rec;
    const tip=`${r.label}: ${n(r.atRiskMwh)} MWh at risk, ${n(rec*1000)} kWh captured by EVs and the grid battery, ${n(rem)} MWh not captured`;
    const act=r.horizon?`data-horizon="${r.horizon}" role="button"`:'';
    return `<g class="impact-bar ${r.selected?'is-selected':''}" ${act} ${tipAttrs(tip)}><rect class="hit" x="${left+slot*i}" y="${top}" width="${slot}" height="${bottom-top}"/><rect class="rem" x="${x}" y="${y(r.atRiskMwh)}" width="${bw}" height="${y(rec)-y(r.atRiskMwh)}" rx="${Math.min(4,bw/3)}"/><rect class="rec" x="${x}" y="${y(rec)}" width="${bw}" height="${bottom-y(rec)}" rx="${Math.min(4,bw/3)}"/>${r.tick?`<text class="impact-tick" x="${x+bw/2}" y="${bottom+17}" text-anchor="middle">${escapeHtml(r.tick)}</text>`:''}</g>`;
  }).join('');
  return `<svg class="impact-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(label)}">${yAxis(max,top,bottom,left,right,'MWh')}${bars}<line class="impact-base" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/></svg>`;
}
// Area chart of one day-replay series on its own zero-based scale, with a peak callout and a
// focusable hover target per half-hour.
function areaChart(rows,series,{width=420,height=250,sel=-1}={}){
  const left=46,right=width-10,top=34,bottom=height-30,values=rows.map(r=>r[series.field]),peak=Math.max(...values,0),max=niceMax(peak);
  const x=i=>left+(right-left)*(i/(rows.length-1||1)),y=v=>bottom-(v/max)*(bottom-top),pts=values.map((v,i)=>[x(i),y(v)]);
  const line=smoothPath(pts),slot=(right-left)/(rows.length-1||1);
  const hits=rows.map((r,i)=>`<g class="impact-pt" ${tipAttrs(`${dayPlanTime(r.targetAt)}: ${series.format(values[i])}`)}><rect class="hit" x="${x(i)-slot/2}" y="${top}" width="${slot}" height="${bottom-top}"/><line class="guide" x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${bottom}"/><circle cx="${x(i)}" cy="${y(values[i])}" r="4"/></g>`).join('');
  const ticks=rows.map((r,i)=>i%8===0?`<text class="impact-tick" x="${x(i)}" y="${bottom+17}" text-anchor="middle">${modelTime(r.targetAt)}</text>`:'').join('');
  const at=values.indexOf(peak),px=Math.min(Math.max(x(at),left+44),right-44);
  const callout=peak>0?`<g class="impact-peak" aria-hidden="true"><circle class="dot is-${series.tone}" cx="${x(at)}" cy="${y(peak)}" r="4.5"/><rect x="${px-44}" y="${y(peak)-34}" width="88" height="26" rx="7"/><text x="${px}" y="${y(peak)-22}" text-anchor="middle">${escapeHtml(series.format(peak))}</text><text class="sub" x="${px}" y="${y(peak)-12}" text-anchor="middle">peak · ${dayPlanTime(rows[at].targetAt)}</text></g>`:'';
  return `<svg class="impact-chart impact-area is-${series.tone}" viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(series.label)} per half-hour">${yAxis(max,top,bottom,left,right,series.unit)}<path class="area" d="${line} L${x(rows.length-1)} ${bottom} L${left} ${bottom}Z" fill="url(#impact-fill-${series.tone})"/><path class="line" d="${line}" pathLength="1" filter="url(#impact-glow)"/>${ticks}${sel>=0?`<line class="impact-sel" x1="${x(sel)}" x2="${x(sel)}" y1="${top}" y2="${bottom}"/><circle class="impact-sel-dot is-${series.tone}" cx="${x(sel)}" cy="${y(values[sel])}" r="5"/>`:''}<line class="impact-base" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>${hits}${callout}</svg>`;
}
function seriesSelect(){
  return `<label class="impact-select"><span class="visually-hidden">Series</span><select id="impact-time-metric">${Object.entries(IMPACT_SERIES).map(([k,m])=>`<option value="${k}" ${impactView.series===k?'selected':''}>${m.label}</option>`).join('')}</select></label>`;
}
function impactOverTime(){
  const title='<h2 id="impact-time-title">Across the day</h2>';
  if(dayPlanReady()){
    const series=IMPACT_SERIES[impactView.series],rows=impactRows(),total=dayPlan.data.totals.atRiskMwh;
    const table=`<table><caption>${escapeHtml(series.label)} per half-hour</caption><thead><tr><th>Half-hour</th><th>${escapeHtml(series.label)}</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(dayPlanTime(r.targetAt))}</td><td>${escapeHtml(series.format(r[series.field]))}</td></tr>`).join('')}</tbody></table>`;
    const sub=series.field==='atRiskMwh'
      ?`${escapeHtml(shortDate(dayPlan.data.date))}: ${n(total)} MWh at risk over the day (48 separate +30 min forecasts, past data)`
      :`If charging were planned for each half-hour of ${escapeHtml(shortDate(dayPlan.data.date))} · separate what-ifs, never added up`;
    return `<section class="dash-card impact-time" aria-labelledby="impact-time-title">
    <div class="impact-card-head"><div>${title}<p>${sub}</p></div>${seriesSelect()}</div>
    <div class="impact-chart-wrap${drawIn('time',`${dayPlan.key}|${impactView.series}`)}">${areaChart(rows,series,{sel:dayPlanIndex()})}<div class="impact-tooltip" role="status" aria-live="polite"></div></div>
    <details class="impact-data-table"><summary>View data</summary>${table}</details>
  </section>`;
  }
  if(dayPlanLoading()){drawIn('time','loading');return `<section class="dash-card impact-time" aria-labelledby="impact-time-title" aria-busy="true">
    <div class="impact-card-head"><div>${title}<p>The Dashboard's plan for each half-hour of ${escapeHtml(impactDateLabel(impactDayDate()))}</p></div></div>${impactSkeleton(48)}</section>`}
  // Day plan unavailable: the two forecasts of the selected half-hour instead.
  const rows=modelState.plan.alternatives.map(a=>({atRiskMwh:a.opportunity.forecastAtRiskMwh,capturedMwh:planImpact(a.optimized.ledger).captured/1000,
    label:`+${a.horizonMinutes} min (${modelTime(a.targetAt)})`,tick:`${modelTime(a.targetAt)} · +${a.horizonMinutes}`,horizon:a.horizonMinutes,selected:a.horizonMinutes===modelState.horizon}));
  return `<section class="dash-card impact-time" aria-labelledby="impact-time-title">
    <div class="impact-card-head"><div>${title}<p>Captured vs not captured for the two forecasts of the selected half-hour · select a bar</p></div><ul class="impact-legend"><li><i class="is-green"></i>Captured</li><li><i class="is-amber"></i>Not captured</li></ul></div>
    <div class="impact-chart-wrap${drawIn('time','targets')}">${stackedBars(rows,{label:'Captured and not captured energy per forecast'})}<div class="impact-tooltip" role="status" aria-live="polite"></div></div>
    <p class="impact-pending">The day plan for ${escapeHtml(impactDateLabel(impactDayDate()))} is unavailable. It will retry when the target changes or the page reloads.</p>
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
function impactEvents(){
  const plan=modelState.plan,chosen=plan.selectedHorizonMinutes;
  const rows=plan.alternatives.map(a=>{const L=a.optimized.ledger,m=planImpact(L),selected=a.horizonMinutes===modelState.horizon;return `<button type="button" class="impact-event ${selected?'is-selected':''}" data-horizon="${a.horizonMinutes}" aria-pressed="${selected}">
    <span class="impact-event-time"><b>${escapeHtml(modelTime(a.targetAt))} ${eventDriver(a.horizonMinutes)}</b><small>+${a.horizonMinutes} min${a.horizonMinutes===chosen?' · <em>Planned on</em>':''}</small></span>
    <span><small>At risk</small>${n(a.opportunity.forecastAtRiskMwh)} MWh</span><span class="is-blue"><small>Grid battery</small>${n(L.allocatedToRealStorageKwh||0)} kWh</span><span class="is-blue"><small>EV chargers</small>${n(L.allocatedToChargersGridKwh)} kWh</span><span class="is-green"><small>CO₂ avoided</small>${impactCo2Text(m.co2Kg)}</span></button>`}).join('');
  return `<section class="dash-card impact-events" aria-labelledby="impact-events-title">
    <div class="impact-card-head"><div><h2 id="impact-events-title">The two forecasts of this half-hour</h2><p>+30 and +60 min are two estimates of the <b>same</b> half-hour, so they are alternatives, never added together. The Dashboard plans on the most recent.</p></div></div>
    <div class="impact-event-list">${rows}</div>
  </section>`;
}

// ---------- 5. Where the energy at risk goes (the Dashboard's energy ledger) ----------
function impactWhere(alt){
  const L=alt.optimized.ledger,S=L.storage;
  const bar=(title,total,unit,parts)=>`<div class="impact-alloc"><div class="impact-alloc-head"><span>${title}</span><b>${n(total)} ${unit}</b></div><div class="impact-alloc-bar">${parts.map(([cls,v])=>`<i class="${cls}" style="flex-grow:${total>0?v/total:0}"></i>`).join('')}</div><div class="impact-alloc-key">${parts.map(([cls,v,l])=>`<span><i class="${cls}"></i>${l} <b>${n(v)} ${unit}</b></span>`).join('')}</div></div>`;
  const risk=bar('Renewable energy at risk',L.predictedAtRiskKwh,'kWh',[['is-green',L.allocatedToChargersGridKwh,'EV chargers'],['is-blue',L.allocatedToRealStorageKwh||0,'Grid battery'],['is-amber',L.unallocatedOpportunityKwh+L.notEligibleKwh,'Not captured']]);
  const battery=S?bar('Grid battery (simulated)',S.capacityKwh,'kWh',[['is-blue',S.startKwh,`Already stored (${n(S.startFraction*100)}%)`],['is-green',S.storedKwh,'Stored now'],['is-grey',Math.max(0,S.capacityKwh-S.endKwh),'Room left']]):'';
  const why=L.unallocatedReasons?.[0]?.message;
  return `<section class="dash-card impact-cumulative impact-where" aria-labelledby="impact-where-title">
    <div class="impact-card-head"><div><h2 id="impact-where-title">Where the energy at risk goes</h2><p>The Dashboard's energy ledger · ${escapeHtml(modelTime(alt.targetAt))} · +${alt.horizonMinutes} min forecast</p></div>${presetPicker()}</div>
    ${risk}${battery}${why?`<p class="impact-pending"><b>Why not more:</b> ${escapeHtml(why)}</p>`:''}
  </section>`;
}

function renderImpact(){
  const subtitle='How the simulated grid battery and EV fleet capture renewable energy that would be wasted.';
  if(modelState.loading||modelState.error)return studioShell('Battery',subtitle,()=>'');
  ensureDayPlan();
  const top=studioHeader('Battery',subtitle),alt=planAlternative();
  if(!alt)return `${top}<div class="impact-layout">${planPlaceholder('Battery plan')}</div>${provenance()}`;
  // Cards rise in only when the page (or its first data) arrives; the old page is still in the DOM here.
  const intro=!liveRender&&!document.querySelector('#app .impact-layout .impact-kpis');
  if(intro)for(const name in impactDrawn)delete impactDrawn[name];
  const p=selectedPrediction();
  return `${impactDefs()}${top}<div class="impact-layout${intro?' is-intro':''}">${impactStats(alt)}${impactFlow(p,alt)}${impactOverTime()}${impactEvents()}${impactWhere(alt)}</div>${provenance()}`;
}

// ---------- interactions ----------
document.addEventListener('click',event=>{
  const motion=event.target.closest('[data-flow-pause]');
  if(motion){impactFlowPaused=!impactFlowPaused;const card=motion.closest('.impact-flow');card.classList.toggle('is-motion-paused',impactFlowPaused);motion.setAttribute('aria-pressed',String(impactFlowPaused));motion.textContent=impactFlowPaused?'Play animation':'Pause animation';return}
});
document.addEventListener('change',event=>{
  if(event.target.id==='impact-time-metric'){impactView.series=event.target.value;render();return}
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
