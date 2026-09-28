const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Backend output for real GridToEv responses (backend/tests/fixtures/sources, captured 28 Sep 2026).
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sources.json'), 'utf8'));

// The chart engine, the Forecast page (whose building blocks are reused) and the Wind & Solar page.
function load(day = '2026-05-10', { forecast = true, theme = 'Europe/Dublin' } = {}) {
  const context = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null },
    modelState: { capacity: 100 },
    settings: { uncertainty: true, timezone: theme },
    localStorage: { getItem: () => null, setItem() {} },
    n: (value) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value),
    escapeHtml: (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    studioHeader: (title, subtitle, actions = '') => `<header><h1>${title}</h1><span>${subtitle}</span>${actions}</header>`,
    pageFromHash: () => 'sources',
    render() {},
    queueMicrotask() {},
    fetch: async () => { throw new Error('no network in tests'); },
  });
  for (const file of ['charts3d.js', 'forecast-explorer.js', 'sources.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  context.fixture = FIXTURE;
  run(`sw.coverage = fixture.coverage; sw.info = fixture.info; sw.date = '${day}'; sw.month = '${day.slice(0, 7)}';
       sw.days['${day}|100'] = fixture.days['${day}'];
       ${forecast ? `sw.forecasts['${day}'] = fixture.forecasts['${day}'];` : ''}
       if ('${day.slice(0, 7)}' === '2026-05') sw.months['2026-05'] = fixture.month;`);
  return run;
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a recorded day shows wind, solar, total and the EV equivalent', () => {
  const run = load();
  const html = run('renderSources()');
  assert.match(html, /Wind &amp; Solar|Wind & Solar/);
  assert.match(text(html), /62\.9% of the total/);
  assert.match(text(html), /37\.1% of the total/);
  assert.match(text(html), /same total as the Forecast page/);
  assert.equal(run('dashCharts.swTotal.values().v'), 6916.993);
  assert.equal(run('Math.round(dashCharts.swCharges.values().v)'), 230566);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\[object/);
});

test('the half-hour chart stacks wind and solar and marks the window, peak and charger limit', () => {
  const run = load();
  const values = run('dashCharts.swDay.values()');
  assert.equal(values.w.length, 48);
  assert.equal(values.win, '21|8');
  assert.equal(values.peak, 21);
  assert.equal(values.cap, 50);
  const html = run('dashCharts.swDay.draw(dashCharts.swDay.values())');
  assert.equal(html.match(/class="sw-col(?: is-peak)?"/g).length, 48);
  assert.equal(html.match(/sw-col is-peak/g).length, 1);
  assert.match(html, /sw-window" style="left:43\.75%;width:16\.66/);
  assert.match(html, /charger limit 50 MWh/);
  assert.match(html, />01:00</, 'times follow the display timezone (UTC 00:00 = 01:00 Irish summer time)');
  const start = run('dashCharts.swDay.draw(dashCharts.swDay.start(dashCharts.swDay.values()))');
  assert.doesNotMatch(start.replace(/height:0\.000%/g, ''), /height:\d/, 'bars grow from the baseline');
});

test('times switch to UTC when the display timezone is UTC', () => {
  const run = load('2026-05-10', { theme: 'UTC' });
  assert.match(run('dashCharts.swDay.draw(dashCharts.swDay.values())'), />00:00</);
});

test('the best charging window card is an upper bound from min(curtailed, capacity × 0.5 h)', () => {
  const run = load();
  const html = text(run('swWindowCard(swDay())'));
  assert.match(html, /Between 11:30 and 15:30/);
  assert.match(html, /400 MWh/);
  assert.match(html, /3,799 MWh/);
  assert.match(html, /≈ 13,333\.3 charges|≈ 13,333 charges/);
  assert.match(html, /upper bound/);
  assert.match(html, /min\(curtailed in the half-hour, 100 MW × 0\.5 h\)/);
});

test('forecast vs recorded keeps the split error apart from the total error', () => {
  const run = load();
  const html = text(run('swForecastCard(swDay())'));
  assert.match(html, /Experimental/);
  assert.match(html, /79% chance of curtailment/);
  assert.match(html, /\+8\.5 pts wind/);
  assert.match(html, /−4,882 MWh \(3\.4× too low\)/);
  assert.match(html, /23:00 UTC the day before/);
  assert.match(html, /4,347 MW wind and 943 MW solar/);
  const chart = run('dashCharts.swCompare.draw(dashCharts.swCompare.values())');
  assert.match(chart, /71% wind/);
  assert.match(chart, /63% wind/);
});

test('the forecast panel loads on its own and never blocks the recorded figures', () => {
  const run = load('2026-05-10', { forecast: false });
  assert.equal(run('swDay().forecast.status'), 'loading');
  const html = run('renderSources()');
  assert.match(text(html), /Asking the model/);
  assert.match(text(html), /Between 11:30 and 15:30/);
});

test('a forecast that cannot be reached shows a retry, not an error page', () => {
  const run = load('2026-05-10', { forecast: false });
  run(`sw.forecastErrors['2026-05-10'] = 'down'`);
  const html = run('swForecastCard(swDay())');
  assert.match(html, /data-sw-retry="forecast"/);
  assert.match(text(html), /recorded figures above are unaffected/);
});

test('a day with nothing curtailed never shows a 0% / 0% split', () => {
  const run = load('2026-01-31');
  const html = text(run('renderSources()'));
  assert.match(html, /nothing curtailed/);
  assert.doesNotMatch(html, /0% of the total|0\.0% of the total/);
  assert.match(html, /expected a small amount \(21% chance/);
  assert.match(run('dashCharts.swCompare.draw(dashCharts.swCompare.values())'), /nothing was curtailed \(0 MWh\)/);
  assert.match(run('dashCharts.swDay.draw(dashCharts.swDay.values())'), /Nothing was curtailed on this day/);
});

test('a wind-only day says solar is unknown, never zero', () => {
  const run = load('2022-06-01');
  const html = text(run('renderSources()'));
  assert.match(html, /not published before Apr 2023: unknown, not zero/);
  assert.match(html, /unknown without solar/);
  assert.match(html, /The wind\/solar forecast starts on 1 April 2024/);
  assert.equal(run('dashCharts.swSolar.values().none'), '1', 'solar shows —, not 0');
});

test('a day EirGrid has not published shows the forecast alone', () => {
  const run = load('2026-09-15');
  const html = text(run('renderSources()'));
  assert.match(html, /Not yet recorded/);
  assert.match(html, /EirGrid figure pending/);
  assert.match(html, /Awaiting EirGrid’s figures/);
  assert.match(html, /5,989 MWh predicted/);
  assert.match(run('dashCharts.swCompare.draw(dashCharts.swCompare.values())'), /not recorded by EirGrid yet/);
});

test('the method dropdowns read every number from the model info', () => {
  const run = load();
  const html = run('swMethodCard(swDay())');
  assert.match(html, /−0\.0063 \+ 0\.6319 × x/);
  assert.match(text(html), /about 4\.3× as much potential wind energy as solar/);
  assert.match(text(html), /2,034\.7 × 0\.7138 = 1,452\.5 MWh wind/);
  assert.match(text(html), /0 of 60 fresh days/);
  assert.match(text(html), /1,784 MWh/);
  assert.match(text(html), /2% better/);
  assert.match(text(html), /9% better/);
  assert.equal(html.match(/class="sw-drop /g).length, 8);
  assert.match(html, /<code class="sw-code">p_wind = 1 \/ \(1 \+ exp/);
});

test('the month heat-map covers every day and highlights the selected one', () => {
  const run = load();
  const html = run('swMonthCard()');
  assert.equal(html.match(/data-sw-day="2026-05-/g).length, 31);
  assert.equal(html.match(/is-selected/g).length, 1);
  // The fixture month has one real day (10 May); the other days are stubbed as zero.
  assert.match(text(html), /6,917 MWh curtailed on 1 of 31 recorded days/);
  assert.match(text(html), /37% solar/);
  assert.match(html, /data-sw-day="2026-05-10"[^>]*--level:1\.000/);
});

test('the page is reached from the Forecast header only and keeps Forecast highlighted', () => {
  const forecast = fs.readFileSync(path.join(__dirname, '..', 'forecast-explorer.js'), 'utf8');
  assert.equal(forecast.match(/data-page=\\?"sources\\?"/g).length, 1);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /page==='sources'\?'forecast'/);
  assert.match(app, /sources:renderSources/);
  assert.doesNotMatch(app.match(/const navItems=(\[.*?\]);/)[1], /sources/, 'no new navigation item');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('sources.js') > html.indexOf('forecast-explorer.js') && html.indexOf('sources.js') < html.indexOf('app.js'));
});
