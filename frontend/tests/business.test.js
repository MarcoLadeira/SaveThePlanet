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
  assert.match(draw(run, 'bzCo2'), /is-text">No reduction</, 'an increase is not printed as a negative reduction');
  assert.match(draw(run, 'bzSavings'), /−€1,200/);
  const kpis = run('bzKpiRow(bz.result)');
  assert.match(kpis, /costs more than basic smart charging here/);
  assert.match(kpis, /estimated · 0\.7 t more than normal charging/);
  assert.match(kpis, /Estimated CO2: no reduction, 0\.7 tonnes a year more than normal charging/);
  assert.match(kpis, /net savings are not positive/);
  run('bz.result.kpis.co2ReductionT = 0');
  assert.match(run('bzKpiRow(bz.result)'), /estimated · same as normal charging/);
});

test('comparison: every strategy on one metric, basic against normal and our AI against basic', () => {
  const run = load(), r = ready(run);
  run('bz.metric = "money"');
  let v = run('dashCharts.bzCompare.values()');
  assert.deepEqual(v.rows.map((row) => row.text), r.strategies.map((s) => `€${new Intl.NumberFormat('en-IE').format(s.annual.costEur)}`));
  // €57,485 → €28,415 → €25,662: the AI's chip is what it adds on top of the simple rule.
  assert.deepEqual({ ...v.deltas.basic }, { text: '−51% vs normal', tone: 'good' });
  assert.deepEqual({ ...v.deltas.ai }, { text: '−10% vs basic', tone: 'good' });
  run('bz.metric = "co2"');
  v = run('dashCharts.bzCompare.values()');
  assert.ok(v.rows.every((row) => / t$/.test(row.text) && /\.\d t$/.test(row.text)), 'tonnes with one decimal');
  run('bz.metric = "renewable"');
  v = run('dashCharts.bzCompare.values()');
  const ai = r.strategies.find((s) => s.id === 'ai');
  assert.equal(v.rows.find((row) => row.id === 'ai').w, ai.annual.renewableShare, 'a share is drawn out of 100%');
  assert.match(v.rows[0].text, /^\d+%$/);
  assert.equal(v.deltas.basic.text, '+27 pts vs normal');
  assert.equal(v.deltas.ai.text, '+16 pts vs basic');
  const html = draw(run, 'bzCompare');
  assert.equal(html.match(/van-nights on time/g).length, 3);
  assert.equal(html.match(/class="bz-cmp-delta /g).length, 2, 'no chip on normal charging, the reference');
  assert.match(html, /bz-cmp-delta is-basic is-good[^>]*>\+27 pts vs normal/);
  assert.doesNotMatch(html, /NaN|undefined/);
  // Small changes keep a decimal; none at all reads "same as".
  assert.equal(run('bzDelta("money", 99.6, 100, "basic").text'), '−0.4% vs basic');
  assert.deepEqual({ ...run('bzDelta("money", 100, 100, "basic")') }, { text: 'same as basic', tone: 'same' });
  const start = run('dashCharts.bzCompare.draw(dashCharts.bzCompare.start(dashCharts.bzCompare.values()))');
  assert.match(start, /bz-cmp-delta[^>]*style="opacity:0.00"/, 'chips fade in as the bars land');
});

test('a worse AI result is flagged, and missed charging requirements are shown', () => {
  const run = load(), r = copy();
  const ai = r.strategies.find((s) => s.id === 'ai');
  ai.annual.co2T = r.strategies[0].annual.co2T * 1.1;
  ai.requirements = { met: 137, total: 140, unmetKwh: 12.4, allMet: false };
  ready(run, r);
  run('bz.metric = "co2"');
  assert.equal(run('dashCharts.bzCompare.values().deltas.ai.tone'), 'bad');
  const html = draw(run, 'bzCompare');
  assert.match(html, /bz-cmp-delta is-ai is-bad[^>]*>\+53% vs basic/);
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
  const run = load({ fetch: () => response(202, { status: 'preparing', progress: { done: 3, total: 10, stage: 'Replaying historical forecasts' } }) });
  assert.match(run('bzScenario()'), /bz-chip is-busy/);
  run('bz.status = "loading"');
  assert.match(run('renderBusiness()'), /Loading<\/span>[\s\S]*bz-layout is-loading is-waiting/, 'placeholders wait a moment before showing');
  await run('bzLoad()');
  assert.equal(run('bz.status'), 'preparing');
  let html = run('renderBusiness()');
  assert.match(html, /Preparing · 4 of 10/);
  assert.match(html, /bz-layout is-loading" aria-busy="true"/, 'a known wait shows the placeholders at once');
  assert.match(html, /<li class="is-active" data-state="active">[\s\S]*Replay a week of GridToEv forecasts<\/b><small>day 4 of 8</);
  assert.equal(html.match(/data-state="pending"/g).length, 2);
  assert.match(html, /aria-valuenow="35"/);
  assert.match(html, /bz-progress-meta" aria-hidden="true">35%</);
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
  assert.match(html, /bz-layout is-ready is-intro/, 'the results rise in when they first appear');
  assert.doesNotMatch(html, /aria-busy/);
  for (const text of ['<h1>Impact</h1>', 'See what smarter EV charging could save.', 'Projected annual savings', 'Estimated CO₂ reduction',
    'Additional AI savings', 'Investment payback', 'Where does the money come from?', 'Is our AI making a difference?',
    'What if my company used this?', 'View investment details', '>Money<', '>CO₂<', '>Renewable energy<']) {
    assert.ok(html.includes(text), text);
  }
});

test('loading steps follow the build: each day replayed, the observed year, then the scoring', () => {
  const run = load();
  const steps = (p) => JSON.parse(run(`JSON.stringify(bzLoadingSteps(${JSON.stringify(p)}))`));
  const states = (p) => steps(p).map((s) => s.state).join(' ');
  assert.equal(states({ done: 0, total: 0, stage: 'Starting' }), 'active pending pending');
  assert.equal(steps({ done: 0, total: 0 })[0].detail, 'starting');
  assert.equal(states({ done: 7, total: 10 }), 'active pending pending');
  assert.equal(steps({ done: 7, total: 10 })[0].detail, 'day 8 of 8');
  assert.equal(states({ done: 8, total: 10 }), 'done active pending');
  assert.equal(steps({ done: 8, total: 10 })[0].detail, '8 days replayed');
  assert.equal(states({ done: 9, total: 10 }), 'done done active');
  assert.equal(states(null), 'active pending pending');
});

test('time left is estimated for the replay, at the pace of the days seen so far', () => {
  const run = load();
  const eta = (p, since, now) => run(`bzEta(${JSON.stringify(p)}, ${JSON.stringify(since)}, ${now})`);
  assert.equal(eta({ done: 2, total: 10 }, { at: 0, done: 2 }, 5000), '', 'nothing until a day has finished');
  assert.equal(eta({ done: 4, total: 10 }, { at: 0, done: 2 }, 8000), 'about 20 s left', '4 s a day, 4 days to go');
  assert.equal(eta({ done: 4, total: 10 }, { at: 0, done: 2 }, 60000), 'about 2 min left');
  assert.equal(eta({ done: 7, total: 10 }, { at: 0, done: 2 }, 7000), 'a few seconds left');
  assert.equal(eta({ done: 8, total: 10 }, { at: 0, done: 2 }, 7000), '', 'the observed year and the scoring take their own time');
  run.set('bz.progressSince', { at: 0, done: 2, total: 10 });
  const steps = JSON.parse(run('JSON.stringify(bzLoadingSteps({ done: 4, total: 10 }, 8000))'));
  assert.equal(steps[0].detail, 'day 5 of 8 · about 20 s left');
  run.set('bz.progressSince', null);
  run.set('bz.progress', { done: 3, total: 10 }); run('bz.status = "preparing"; bzTrackProgress(1000)');
  assert.deepEqual({ ...run('bz.progressSince') }, { at: 1000, done: 3, total: 10 });
  run.set('bz.progress', { done: 5, total: 10 }); run('bzTrackProgress(5000)');
  assert.equal(run('bz.progressSince.at'), 1000, 'the first sighting is kept');
  run.set('bz.progress', { done: 0, total: 10 }); run('bzTrackProgress(6000)');
  assert.equal(run('bz.progressSince.at'), 6000, 'a build that starts again starts the estimate again');
  run('bz.status = "ready"; bzTrackProgress(7000)');
  assert.equal(run('bz.progressSince'), null);
});

test('polls while preparing update the loading card in place instead of re-rendering', async () => {
  let done = 3;
  const run = load({ fetch: () => response(202, { status: 'preparing', progress: { done: done++, total: 10, stage: 'Replaying historical forecasts' } }) });
  await run('bzLoad()');
  run('clearTimeout(bz.timer); bz.timer = null');
  const before = run.renders.length;
  assert.ok(before > 0);
  run('var painted = 0; bzProgressPaint = () => { painted++; return true; }');
  await run('bzLoad()');
  run('clearTimeout(bz.timer); bz.timer = null');
  assert.equal(run.renders.length, before, 'no full re-render between polls');
  assert.equal(run('painted'), 2, 'the card is updated as the poll starts and when it answers');
  assert.equal(run('bz.progress.done'), 4);
  run('bzProgressPaint = () => false');
  await run('bzLoad()');
  run('clearTimeout(bz.timer); bz.timer = null');
  assert.ok(run.renders.length > before, 'without a card on screen the page renders');
});

test('the entrance plays once: a re-render of the results leaves the cards still', () => {
  const run = load(); ready(run);
  assert.match(run('renderBusiness()'), /bz-scenario is-intro[\s\S]*bz-layout is-ready is-intro[\s\S]*bz-provenance is-intro/);
  run('document.querySelector = (selector) => (selector.includes(".bz-layout.is-ready") ? {} : null)');
  const again = run('renderBusiness()');
  assert.doesNotMatch(again, /is-intro/);
  run('document.querySelector = () => null; var liveRender = true');
  assert.doesNotMatch(run('renderBusiness()'), /is-intro/, 'live model updates never replay it');
});

test('the calculator starts from the depot: its default estimate matches the waterfall', () => {
  const r = copy(), d = r.calculator.defaults;
  // estimate(): EVs × kWh per EV per day (unrounded 36.5 / 0.9) × share × price × days, in whole euros.
  const gross = Math.round(d.evs * (36.5 / 0.9) * (d.shiftablePct / 100) * d.priceDiffEurPerKwh * d.operatingDays);
  assert.ok(Math.abs(gross - r.financials.grossSavingsEur) <= 1, `${gross} vs ${r.financials.grossSavingsEur}`);
  const run = load(); ready(run);
  assert.match(run('bzCalcCard(bz.result)'), /Estimated yearly savings<i class="bz-out-spin" aria-hidden="true"><\/i>/, 'a spinner shows while an estimate updates');
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
