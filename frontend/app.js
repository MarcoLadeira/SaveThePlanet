const icons = {
  home:'<path d="m3 10 9-8 9 8"/><path d="M5 9v12h5v-7h4v7h5V9"/>',
  forecast:'<rect x="3" y="13" width="3" height="8"/><rect x="10.5" y="4" width="3" height="17"/><rect x="18" y="10" width="3" height="11"/>',
  car:'<path d="M5 16 6.6 7.7A2 2 0 0 1 8.5 6h7a2 2 0 0 1 1.9 1.7L19 16"/><path d="M4 11h16a2 2 0 0 1 2 2v6H2v-6a2 2 0 0 1 2-2Z"/><path d="M5 19v2M19 19v2M7 15h1M16 15h1"/>',
  leaf:'<path d="M20 3C10 3 4 6 4 15a6 6 0 0 0 6 6c9 0 12-8 10-18Z"/><path d="M3 21c4-6 9-10 15-14"/>',
  settings:'<path d="M10.3 2h3.4l.6 2.3 1.5.6 2.1-1.2 2.4 2.4-1.2 2.1.6 1.5 2.3.6v3.4l-2.3.6-.6 1.5 1.2 2.1-2.4 2.4-2.1-1.2-1.5.6-.6 2.3h-3.4l-.6-2.3-1.5-.6-2.1 1.2-2.4-2.4 1.2-2.1-.6-1.5L2 13.7v-3.4l2.3-.6.6-1.5-1.2-2.1 2.4-2.4 2.1 1.2 1.5-.6.6-2.3Z"/><circle cx="12" cy="12" r="3"/>',
  map:'<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  arrow:'<path d="M3 12h18M14 5l7 7-7 7"/>',
  check:'<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7 12 3.4 3.4L17 8.8" stroke="#fff"/>',
  battery:'<rect x="4" y="5" width="16" height="17" rx="2"/><path d="M9 2h6M8 13h8M12 9v8"/>',
  swap:'<path d="M3 7h18l-5-5M21 17H3l5 5"/>',
  turbine:'<path d="M12 13v9M7 22h10M12 13 3 17M12 13l1-11"/><circle cx="12" cy="13" r="1"/>',
  tower:'<path d="m8 3-5 19M16 3l5 19M8 3h8M6 9h12M4 16h16M5 22l14-13M19 22 5 9"/>',
  pulse:'<path d="M2 12h5l2-5 3 12 3-15 2 8h5"/>',
  pie:'<circle cx="12" cy="12" r="9"/><path d="M12 3v9h9"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 10h18"/>',
  bolt:'<path d="m13 2-8 11h6l-1 9 9-12h-6l0-8Z"/>'
};
function icon(name,size=24,extra='') {return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${extra}">${icons[name]}</svg>`}
function brand(){return '<svg class="brand-leaf" viewBox="0 0 26 30" role="img" aria-label="Renewable Energy Planner"><defs><linearGradient id="brand-leaf-fill" gradientUnits="userSpaceOnUse" x1="4.2" y1="3.5" x2="22.7" y2="18.8"><stop offset="0" stop-color="#03955f"/><stop offset=".4" stop-color="#04a36c"/><stop offset=".585" stop-color="#07ae74"/><stop offset=".59" stop-color="#1dc389"/><stop offset=".78" stop-color="#3dd89a"/><stop offset=".92" stop-color="#5ee4aa"/><stop offset="1" stop-color="#7eefc1"/></linearGradient><linearGradient id="brand-leaf-vein" gradientUnits="userSpaceOnUse" x1="1" y1="29.5" x2="24.5" y2="1"><stop offset="0" stop-color="#01452f"/><stop offset=".55" stop-color="#01452f" stop-opacity=".9"/><stop offset="1" stop-color="#01452f" stop-opacity="0"/></linearGradient></defs><path fill="url(#brand-leaf-fill)" d="M25 .5C25 10 24 17 19.5 22.5 15.5 27.5 9 29.4 1.2 29.6.1 21 0 12.5 2.3 8.2 5.6 2.4 13 .5 25 .5Z"/><path fill="url(#brand-leaf-vein)" d="M.4 29.1 24 1.2 24.4 1.6 2.1 30.3Z"/></svg>'}
const navGlyphs={
  home:'<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13 14 2.4 25 13"/><path d="M5 11.2v13.2h6.6v-8.1h4.8v8.1H23V11.2"/></svg>',
  forecast:'<svg viewBox="0 0 28 28" fill="currentColor"><rect x="2.7" y="12.3" width="5.6" height="12.1" rx="1.2"/><rect x="11.2" y="3.2" width="5.6" height="21.2" rx="1.2"/><rect x="19.7" y="10.2" width="5.6" height="14.2" rx="1.2"/></svg>',
  car:'<svg viewBox="0 0 28 28" fill="currentColor"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" d="m5 12.6 2.5-5.2c.35-.75.95-1.2 1.8-1.2h9.4c.85 0 1.45.45 1.8 1.2l2.5 5.2M1.6 11.2h2.2m20.4 0h2.2" stroke-linecap="round"/><path fill-rule="evenodd" d="M4.3 12h19.4a2.7 2.7 0 0 1 2.7 2.7v5a2.7 2.7 0 0 1-2.7 2.7H4.3a2.7 2.7 0 0 1-2.7-2.7v-5A2.7 2.7 0 0 1 4.3 12Zm2.8 3.3a1.85 1.85 0 1 0 0 3.7 1.85 1.85 0 0 0 0-3.7Zm13.8 0a1.85 1.85 0 1 0 0 3.7 1.85 1.85 0 0 0 0-3.7Zm-9.3 1.2h4.8v1.6h-4.8Z"/><path d="M4.2 21.5h4.6v3.2a1 1 0 0 1-1 1H5.2a1 1 0 0 1-1-1Zm15 0h4.6v3.2a1 1 0 0 1-1 1h-2.6a1 1 0 0 1-1-1Z"/></svg>',
  leaf:'<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 23.2C3.9 16 4.5 10.5 7.8 7.5 11 4.6 16.5 4.2 23.6 4.4c.3 7.1-.2 12.6-3.1 15.8-3 3.3-8.5 3.8-15.7 3Z"/><path d="M2.4 25.6 17.8 10.2"/></svg>',
  settings:'<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M14 3.4 15 3.7 15.8 4.9 16.4 6.2 17 6.7 17.8 6.8 19.1 6.3 20.6 6 21.5 6.5 22 7.4 21.7 8.9 21.2 10.2 21.3 11 21.8 11.6 23.1 12.2 24.3 13 24.6 14 24.3 15 23.1 15.8 21.8 16.4 21.3 17 21.2 17.8 21.7 19.1 22 20.6 21.5 21.5 20.6 22 19.1 21.7 17.8 21.2 17 21.3 16.4 21.8 15.8 23.1 15 24.3 14 24.6 13 24.3 12.2 23.1 11.6 21.8 11 21.3 10.2 21.2 8.9 21.7 7.4 22 6.5 21.5 6 20.6 6.3 19.1 6.8 17.8 6.7 17 6.2 16.4 4.9 15.8 3.7 15 3.4 14 3.7 13 4.9 12.2 6.2 11.6 6.7 11 6.8 10.2 6.3 8.9 6 7.4 6.5 6.5 7.4 6 8.9 6.3 10.2 6.8 11 6.7 11.6 6.2 12.2 4.9 13 3.7Z"/><circle cx="14" cy="14" r="2.2"/></svg>'
};
function navItem(key,label,glyph,page){const active=page===key;return `<button class="nav-item ${active?'active':''}" type="button" data-page="${key}" ${active?'aria-current="page"':''}><span class="nav-icon" aria-hidden="true">${navGlyphs[glyph]}</span><span>${label}</span></button>`}
const navItems=[['overview','Dashboard','home'],['forecast','Forecast','forecast'],['charging','Charging','car'],['impact','Impact','leaf']];
const defaults={timezone:'Europe/Dublin',uncertainty:true,cause:true,explanations:true};
let settings={...defaults};
try{settings={...defaults,...JSON.parse(localStorage.getItem('planner-preferences')||'{}')}}catch{}
let dashboardTheme='light';
try{dashboardTheme=localStorage.getItem('planner-theme')==='dark'?'dark':'light'}catch{}
let saved=true;
function pageFromHash(){const p=location.hash.slice(1).toLowerCase();return ['overview','forecast','charging','impact','settings'].includes(p)?p:'overview'}
function navigate(page){if(location.hash!==`#${page}`)location.hash=page;else render()}
function sidebar(page){return `<aside class="sidebar dash-sidebar"><div class="brand">${brand()}<span class="brand-name"><small>Renewable</small>Energy Planner<em>IRELAND</em></span></div><nav class="nav" aria-label="Main navigation">${navItems.map(([key,label,glyph])=>navItem(key,label,glyph,page)).join('')}</nav><div class="sidebar-art" aria-hidden="true"></div><p class="sidebar-slogan">Powering<br>a cleaner,<br>brighter Ireland.<i></i></p><div class="sidebar-bottom">${navItem('settings','Settings','settings',page)}</div></aside>`}
function fitDesktop(){
  const shell=document.querySelector('.app-shell');
  if(!shell)return;
  const main=shell.querySelector('main');
  let scale=Math.min(1,innerWidth/1440,innerHeight/900);
  for(let i=0;i<3;i++){
    shell.style.width=`${innerWidth/scale}px`;shell.style.height=`${innerHeight/scale}px`;
    const needed=Math.max(900,main.scrollHeight);
    scale=Math.min(scale,innerHeight/needed);
  }
  shell.style.width=`${innerWidth/scale}px`;shell.style.height=`${innerHeight/scale}px`;
  shell.style.transform=`scale(${scale})`;shell.style.transformOrigin='top left';
}
function render(){
  const page=pageFromHash();
  const app=document.getElementById('app');
  const previous=app.querySelector('.outlook-ready');
  if(previous)previous.remove();
  const view={overview:renderDashboard,forecast:renderForecast,charging:renderCharging,impact:renderImpact,settings:renderSettings}[page];
  app.innerHTML=`<div class="app-shell">${sidebar(page)}<main class="main dashboard-main" data-current-page="${page}" data-theme="${dashboardTheme}" data-cause="${settings.cause}" data-explanations="${settings.explanations}">${fallbackBanner()}${view()}</main></div>`;
  const replacement=app.querySelector('.outlook-ready');
  if(previous && replacement)replacement.replaceWith(previous);
  else if(previous)outlookTeardown();
  document.title=`${page==='overview'?'Dashboard':page[0].toUpperCase()+page.slice(1)} · Renewable Energy Planner`;
  fitDesktop();
  const outlook=app.querySelector('.outlook-ready');
  if(outlook)outlookSync(outlook);
}
document.addEventListener('click',event=>{
  const horizon=event.target.closest('[data-horizon]');
  if(horizon){modelState.horizon=Number(horizon.dataset.horizon);render();return}
  const page=event.target.closest('[data-page]');
  if(page){navigate(page.dataset.page);return}
  if(event.target.closest('[data-dashboard-theme]')){dashboardTheme=dashboardTheme==='light'?'dark':'light';try{localStorage.setItem('planner-theme',dashboardTheme)}catch{}render();return}
  const toggle=event.target.closest('[data-toggle]');
  if(toggle){settings[toggle.dataset.toggle]=!settings[toggle.dataset.toggle];saved=false;render();return}
  const action=event.target.closest('[data-action]');
  if(action?.dataset.action==='save'){try{localStorage.setItem('planner-preferences',JSON.stringify(settings))}catch{}saved=true;render()}
  if(action?.dataset.action==='reset'){settings={...defaults};saved=false;render()}
});
document.addEventListener('change',event=>{const el=event.target.closest('[data-setting]');if(!el)return;settings[el.dataset.setting]=el.value;saved=false;render()});
addEventListener('hashchange',render);addEventListener('resize',fitDesktop);render();loadModelForecast();
