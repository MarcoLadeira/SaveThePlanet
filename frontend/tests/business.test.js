const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// An example result straight from backend/business.py (simulated_result), so the page is tested
// against the real contract rather than a hand-written copy.
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'business-impact.json'), 'utf8'));
const copy = () => JSON.parse(JSON.stringify(FIXTURE));

// Loads the chart engine and the Impact page into one sandbox; `fetch` is controlled by each test.
function load({ fetch, hash = 'business' } = {}) {
  const renders = [];
  const context = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], activeElement: null },
    localStorage: { getItem: () => null, setItem() {} },
    modelState: {}, settings: {},
    n: (value) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value),
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    studioHeader: (title, subtitle, actions = '') => `<header><h1>${title}</h1><span>${subtitle}</span>${actions}</header>`,
    pageFromHash: () => hash,
    render: () => renders.push(1),
    fetch: fetch || (() => new Promise(() => {})),
    setTimeout, clearTimeout, queueMicrotask, AbortController, URLSearchParams, Promise,
  });
  for (const file of ['charts3d.js', 'business.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  run.renders = renders;
  run.set = (name, value) => { context.__value = value; vm.runInContext(`${name} = __value`, context); };
  return run;
}
const ready = (run, result = copy()) => { run.set('bz.result', result); run('bz.status = "ready"'); return result; };
const draw = (run, chart) => run(`dashCharts.${chart}.draw(dashCharts.${chart}.values())`);
const response = (status, body) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('waterfall steps run from normal charging to the final cost and match the savings KPI', () => {
  const run = load(), r = ready(run);
  const steps = JSON.parse(run('JSON.stringify(bzSteps(bz.result))'));
  assert.deepEqual(steps.map((s) => s.id), ['baseline', 'timing', 'ai', 'running', 'final']);
  for (let i = 1; i < steps.length - 1; i++) assert.equal(steps[i].from, steps[i - 1].to, 'deltas continue from the running total');
  assert.equal(steps[3].to, steps[4].value, 'the running total ends at the final cost');
  assert.equal(steps[0].value - steps[4].value, r.kpis.annualSavingsEur, 'baseline minus final is the savings KPI');
  assert.equal(-steps[2].value, r.kpis.aiSavingsEur, 'the AI step is the additional AI savings KPI');
  const html = draw(run, 'bzWaterfall');
  assert.equal(html.match(/class="bz-wf-col /g).length, 5);
  assert.match(html, /bz-wf-col is-down/);
  assert.match(html, /bz-wf-col is-up/);
  assert.match(html, />−€29,070</, 'negative steps use a true minus sign');
  assert.match(html, />\+€2,400</);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('a positive AI step is drawn as a cost increase with its own explanation', () => {
  const run = load(), r = copy();
  r.waterfall[2].valueEur = 420; // the forecast-led plan cost more than the rule
  ready(run, r);
  const html = draw(run, 'bzWaterfall');
  assert.equal(html.match(/bz-wf-col is-up/g).length, 2);
  assert.match(html, /cost more than the simple rule/);
});

test('bars grow from nothing on the first frame', () => {
  const run = load(); ready(run);
  const start = run('dashCharts.bzWaterfall.draw(dashCharts.bzWaterfall.start(dashCharts.bzWaterfall.values()))');
  for (const h of start.match(/height:([\d.]+)%/g)) assert.ok(parseFloat(h.slice(7)) <= 0.6, h);
});

test('KPI figures come straight from the backend result', () => {
  const run = load(), r = ready(run);
  assert.equal(run('dashCharts.bzSavings.values().v'), r.kpis.annualSavingsEur);
  assert.equal(run('dashCharts.bzCo2.values().v'), r.kpis.co2ReductionT);
  assert.equal(run('dashCharts.bzAi.values().v'), r.kpis.aiSavingsEur);
  assert.match(draw(run, 'bzSavings'), /€29,423<small>\/year/);
  assert.match(draw(run, 'bzCo2'), /22\.7<small>t CO₂\/year/);
  assert.match(draw(run, 'bzPayback'), />6\.1<small>months/);
});

test('payback is "not achieved" and negative outcomes keep their sign', () => {
  const run = load(), r = copy();
  Object.assign(r.kpis, { annualSavingsEur: -1200, aiSavingsEur: -420, co2ReductionT: -0.71, paybackMonths: null, paybackStatus: 'not-achieved' });
  ready(run, r);
  assert.match(draw(run, 'bzPayback'), /Not achieved/);
  assert.match(draw(run, 'bzAi'), /−€420/);
  assert.match(draw(run, 'bzCo2'), /−0\.7<small>/);
  assert.match(draw(run, 'bzSavings'), /−€1,200/);
  const kpis = run('bzKpiRow(bz.result)');
  assert.match(kpis, /costs more than basic smart charging here/);
  assert.match(kpis, /more than normal charging/);
  assert.match(kpis, /net savings are not positive/);
});

test('comparison: every strategy on one metric, with units, scale and the AI change', () => {
  const run = load(), r = ready(run);
  run('bz.metric = "money"');
  let v = run('dashCharts.bzCompare.values()');
  assert.deepEqual(v.rows.map((row) => row.text), r.strategies.map((s) => `€${new Intl.NumberFormat('en-IE').format(s.annual.costEur)}`));
  assert.equal(v.tone, 'good');
  assert.match(v.delta, /^−\d+% vs normal$/);
  run('bz.metric = "co2"');
  v = run('dashCharts.bzCompare.values()');
  assert.ok(v.rows.every((row) => / t$/.test(row.text) && /\.\d t$/.test(row.text)), 'tonnes with one decimal');
  run('bz.metric = "renewable"');
  v = run('dashCharts.bzCompare.values()');
  const ai = r.strategies.find((s) => s.id === 'ai');
  assert.equal(v.rows.find((row) => row.id === 'ai').w, ai.annual.renewableShare, 'a share is drawn out of 100%');
  assert.match(v.rows[0].text, /^\d+%$/);
  assert.match(v.delta, /pts vs normal$/);
  const html = draw(run, 'bzCompare');
  assert.equal(html.match(/van-nights on time/g).length, 3);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('a worse AI result is flagged, and missed charging requirements are shown', () => {
  const run = load(), r = copy();
  const ai = r.strategies.find((s) => s.id === 'ai');
  ai.annual.co2T = r.strategies[0].annual.co2T * 1.1;
  ai.requirements = { met: 137, total: 140, unmetKwh: 12.4, allMet: false };
  ready(run, r);
  run('bz.metric = "co2"');
  assert.equal(run('dashCharts.bzCompare.values().tone'), 'bad');
  const html = draw(run, 'bzCompare');
  assert.match(html, /bz-cmp-delta is-bad/);
  assert.match(html, /3 of 140 van-nights short · 12 kWh/);
});

test('calculator input validation mirrors the server limits', () => {
  const run = load();
  const check = (raw, advanced = false) => JSON.parse(run(`JSON.stringify(bzValidate(${JSON.stringify(raw)}, ${advanced}))`));
  const good = { evs: '20', shiftablePct: '96.8', priceDiffEurPerKwh: '0.119', operatingDays: '260' };
  assert.deepEqual(check(good).errors, {});
  assert.deepEqual(check(good).values, { evs: 20, shiftablePct: 96.8, priceDiffEurPerKwh: 0.119, operatingDays: 260 });
  assert.equal(check({ ...good, evs: '12.5' }).errors.evs, 'Whole number');
  assert.equal(check({ ...good, evs: '0' }).errors.evs, '1–10,000');
  assert.equal(check({ ...good, shiftablePct: '120' }).errors.shiftablePct, '0–100');
  assert.equal(check({ ...good, priceDiffEurPerKwh: 'abc' }).errors.priceDiffEurPerKwh, 'Not a number');
  assert.equal(check({ ...good, priceDiffEurPerKwh: '-0.1' }).errors.priceDiffEurPerKwh, '0–1');
  assert.equal(check({ ...good, operatingDays: '' }).errors.operatingDays, 'Required');
  assert.equal(check({ ...good, evs: '1,000' }).values.evs, 1000, 'thousands separators are accepted');
  assert.deepEqual(check(good).values.implementationEur, undefined, 'costs are ignored until added');
  assert.equal(check({ ...good, implementationEur: '', annualEur: '2400' }, true).values.annualEur, 2400);
  assert.equal(check({ ...good, implementationEur: '-5' }, true).errors.implementationEur, '0–10,000,000');
});

test('only the newest impact request may update the page', async () => {
  const pending = [];
  const run = load({ fetch: () => new Promise((resolve) => pending.push(resolve)) });
  run('bzLoad()'); run('bzLoad()');
  assert.equal(pending.length, 2);
  const newer = copy(), older = copy();
  older.kpis.annualSavingsEur = 1;
  pending[1](await response(200, newer));
  await flush();
  pending[0](await response(200, older));
  await flush();
  assert.equal(run('bz.status'), 'ready');
  assert.equal(run('bz.result.kpis.annualSavingsEur'), newer.kpis.annualSavingsEur, 'the late, older answer is ignored');
  for (const resolve of pending.slice(2)) resolve(await response(200, { yearlySavingsEur: 1 })); // the calculator's first estimate
  await flush();
});

test('an older calculator answer never replaces a newer one', async () => {
  const pending = [];
  const run = load({ fetch: () => new Promise((resolve) => pending.push(resolve)) });
  run.set('bz.calc.values', { evs: '20', shiftablePct: '50', priceDiffEurPerKwh: '0.1', operatingDays: '200' });
  run('bzEstimate()'); run('bz.calc.values.evs = "40"'); run('bzEstimate()');
  pending[1](await response(200, { yearlySavingsEur: 400 }));
  await flush();
  pending[0](await response(200, { yearlySavingsEur: 200 }));
  await flush();
  assert.equal(run('bz.calc.result.yearlySavingsEur'), 400);
  assert.equal(run('bz.calc.pending'), false);
});

test('server field errors are shown on the calculator', async () => {
  const run = load({ fetch: () => response(400, { error: { code: 'INVALID_REQUEST', message: 'Check the highlighted inputs.', fields: { evs: 'Number of EVs must be between 1 and 10,000.' } } }) });
  run.set('bz.calc.values', { evs: '20', shiftablePct: '50', priceDiffEurPerKwh: '0.1', operatingDays: '200' });
  await run('bzEstimate()');
  assert.match(run('bz.calc.errors.evs'), /between 1 and 10,000/);
  assert.match(run('bzCalcDetail()'), /Fix the highlighted field/);
  assert.match(run('bzField("evs")'), /Check value<\/em>/, 'long server messages are shortened in the field');
});

test('the calculator shows the energy bridge site check, and warns when EVs do not fit', () => {
  const run = load();
  const site = { chargers: 20, chargerKw: 11, sitePowerKw: 180 };
  const answer = (feasibility) => ({ shiftedKwhPerYear: 1000, grossSavingsEur: 100, annualCostsEur: 0, implementationEur: 0, paybackStatus: 'no-investment', feasibility });
  run.set('bz.calc.result', answer({ evs: 20, vehiclesMet: 20, limitedBy: null, site }));
  assert.match(run('bzCalcDetail()'), /Site check<\/span><b>all 20 EVs fit/);
  run.set('bz.calc.result', answer({ evs: 100, vehiclesMet: 54, limitedBy: 'site-power', site }));
  const warn = run('bzCalcDetail()');
  assert.match(warn, /class="is-warn"[^>]*180 kW connection is full overnight[^>]*><span>Site check<\/span><b>54 of 100 EVs fit/);
});

test('preparing, failed, empty and ready states render the right content', async () => {
  const run = load({ fetch: () => response(202, { status: 'preparing', progress: { done: 3, total: 9, stage: 'Replaying historical forecasts' } }) });
  await run('bzLoad()');
  assert.equal(run('bz.status'), 'preparing');
  let html = run('renderBusiness()');
  assert.match(html, /Preparing · 4 of 9/);
  assert.match(html, /step 4 of 9/);
  assert.match(html, /aria-busy="true"/);
  run('clearTimeout(bz.timer); bz.timer = null');

  run('bz.status = "failed"; bz.error = "The impact calculation failed. Try again."; bz.result = null');
  html = run('renderBusiness()');
  assert.match(html, /role="alert"/);
  assert.match(html, /data-bz-retry="load"/);

  run.set('bz.result', { status: 'empty', message: 'No complete night.' });
  run('bz.status = "empty"');
  assert.match(run('renderBusiness()'), /Nothing to evaluate yet[\s\S]*No complete night\./);

  ready(run);
  html = run('renderBusiness()');
  for (const text of ['<h1>Impact</h1>', 'See what smarter EV charging could save.', 'Projected annual savings', 'Estimated CO₂ reduction',
    'Additional AI savings', 'Investment payback', 'Where does the money come from?', 'Is our AI making a difference?',
    'What if my company used this?', 'View investment details', '>Money<', '>CO₂<', '>Renewable energy<']) {
    assert.ok(html.includes(text), text);
  }
});

test('simulated data is labelled everywhere it could be mistaken for real data', () => {
  const run = load(); ready(run);
  const html = run('renderBusiness()');
  assert.match(html, /Simulated data · retry model/);
  assert.match(html, /Example week/);
  assert.doesNotMatch(run('bzScenario()'), /24–31 Jan/, 'no real-looking dates for fixed example weather');
  assert.match(html, /Simulated example \(GridToEv unavailable\)/);
  const real = copy();
  Object.assign(real, { dataMode: 'historical-replay', fallback: { active: false, reason: null } });
  ready(run, real);
  assert.match(run('bzScenario()'), /Historical replay/);
  assert.match(run('bzScenario()'), /24–31 Jan 2026/);
});

test('investment details show ROI, the scenarios and multi-site scaling from the result', () => {
  const run = load(), r = ready(run);
  run('bz.details = true');
  const html = run('bzInvestCard(bz.result)');
  assert.match(html, /5-year net return/);
  assert.ok(html.includes(`€${new Intl.NumberFormat('en-IE').format(r.financials.roiNetEur)}`));
  for (const label of ['Conservative', 'Expected', 'Optimistic', '25 sites']) assert.ok(html.includes(label), label);
  assert.match(html, /Hide details/);
  run('bz.details = false');
  const closed = run('bzInvestCard(bz.result)');
  assert.match(closed, /View investment details/);
  assert.match(closed, /aria-expanded="false"/);
});

test('the Impact page sits after EV in the navigation and has its own route', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const nav = app.match(/const navItems=(\[.*?\]);/)[1];
  const order = [...nav.matchAll(/\['(\w+)','([^']+)'/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['overview:Dashboard', 'forecast:Forecast', 'impact:Battery', 'charging:EV', 'business:Impact']);
  assert.match(app, /\['overview','forecast','charging','impact','business','settings'\]\.includes\(p\)/);
  assert.match(app, /business:renderBusiness/);
  assert.match(app, /business:'Impact'/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('business.js') > html.indexOf('charts3d.js') && html.indexOf('business.js') < html.indexOf('app.js'));
  assert.match(html, /business\.css\?v=/);
});
