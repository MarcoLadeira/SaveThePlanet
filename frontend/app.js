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
  bolt:'<path d="m13 2-8 11h6l-1 9 9-12h-6l0-8Z"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9ZM10 21h4"/>'
};
function icon(name,size=24,extra='') {return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${extra}">${icons[name]}</svg>`}
function brand(){return '<svg viewBox="0 0 52 60" aria-label="Renewable Energy Planner"><path fill="#078c58" d="M45 4C22 5 7 12 6 32c-.4 9 5 15 13 15C38 47 45 27 45 4Z"/><path fill="none" stroke="#fff" stroke-width="1.6" d="M5 55C13 38 23 26 39 15"/></svg>'}
const navItems=[['overview','Dashboard','home'],['forecast','Forecast','forecast'],['charging','Charging','car'],['impact','Impact','leaf']];
const defaults={timezone:'Europe/Dublin',uncertainty:true,cause:true,explanations:true};
let settings={...defaults};
try{settings={...defaults,...JSON.parse(localStorage.getItem('planner-preferences')||'{}')}}catch{}
let dashboardTheme='light';
try{dashboardTheme=localStorage.getItem('planner-theme')==='dark'?'dark':'light'}catch{}
let saved=true;
function pageFromHash(){const p=location.hash.slice(1).toLowerCase();return ['overview','forecast','charging','impact','settings'].includes(p)?p:'overview'}
function navigate(page){if(location.hash!==`#${page}`)location.hash=page;else render()}
function sidebar(page){return `<aside class="sidebar dash-sidebar"><div class="brand">${brand()}<span class="brand-name"><small>Renewable</small>Energy Planner<em>IRELAND</em></span></div><nav class="nav" aria-label="Main navigation">${navItems.map(([key,label,glyph])=>`<button class="nav-item ${page===key?'active':''}" type="button" data-page="${key}" ${page===key?'aria-current="page"':''}>${icon(glyph,28,'nav-icon')}<span>${label}</span></button>`).join('')}</nav><div class="sidebar-art" aria-hidden="true"></div><p class="sidebar-slogan">Powering<br>a cleaner,<br>brighter Ireland.<i></i></p><div class="sidebar-bottom"><button class="nav-item ${page==='settings'?'active':''}" type="button" data-page="settings" ${page==='settings'?'aria-current="page"':''}>${icon('settings',28,'nav-icon')}<span>Settings</span></button></div></aside>`}
function fitDesktop(){const shell=document.querySelector('.app-shell');if(!shell)return;const main=shell.querySelector('main');let scale=Math.min(1,innerWidth/1440,innerHeight/900);for(let i=0;i<3;i++){shell.style.width=`${innerWidth/scale}px`;shell.style.height=`${innerHeight/scale}px`;const needed=Math.max(900,main.scrollHeight);scale=Math.min(scale,innerHeight/needed)}shell.style.width=`${innerWidth/scale}px`;shell.style.height=`${innerHeight/scale}px`;shell.style.transform=`scale(${scale})`;shell.style.transformOrigin='top left'}
function render(){const page=pageFromHash();const view={overview:renderDashboard,forecast:renderForecast,charging:renderCharging,impact:renderImpact,settings:renderSettings}[page];document.getElementById('app').innerHTML=`<div class="app-shell">${sidebar(page)}<main class="main dashboard-main" data-current-page="${page}" data-theme="${dashboardTheme}" data-cause="${settings.cause}" data-explanations="${settings.explanations}">${fallbackBanner()}${view()}</main></div>`;document.title=`${page==='overview'?'Dashboard':page[0].toUpperCase()+page.slice(1)} · Renewable Energy Planner`;fitDesktop()}
document.addEventListener('click',event=>{const page=event.target.closest('[data-page]');if(page){navigate(page.dataset.page);return}if(event.target.closest('[data-dashboard-theme]')){dashboardTheme=dashboardTheme==='light'?'dark':'light';try{localStorage.setItem('planner-theme',dashboardTheme)}catch{}render();return}const toggle=event.target.closest('[data-toggle]');if(toggle){settings[toggle.dataset.toggle]=!settings[toggle.dataset.toggle];saved=false;render();return}const action=event.target.closest('[data-action]');if(action?.dataset.action==='save'){try{localStorage.setItem('planner-preferences',JSON.stringify(settings))}catch{}saved=true;render()}if(action?.dataset.action==='reset'){settings={...defaults};saved=false;render()}});
document.addEventListener('change',event=>{const el=event.target.closest('[data-setting]');if(!el)return;settings[el.dataset.setting]=el.value;saved=false;render()});
addEventListener('hashchange',render);addEventListener('resize',fitDesktop);render();loadModelForecast();
