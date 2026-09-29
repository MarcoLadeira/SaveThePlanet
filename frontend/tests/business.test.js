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

test('waterfall steps run from normal charging to the final cost and match the depot figures', () => {
  const run = load(), r = ready(run);
  const steps = JSON.parse(run('JSON.stringify(bzSteps(bz.result))'));
  assert.deepEqual(steps.map((s) => s.id), ['baseline', 'timing', 'ai', 'running', 'final']);
  for (let i = 1; i < steps.length - 1; i++) assert.equal(steps[i].from, steps[i - 1].to, 'deltas continue from the running total');
  assert.equal(steps[3].to, steps[4].value, 'the running total ends at the final cost');
  assert.equal(steps[0].value - steps[4].value, r.kpis.annualSavingsEur, 'baseline minus final is the depot savings');
  assert.equal(-steps[2].value, r.kpis.aiSavingsEur, 'the AI step is the depot AI saving');
  const html = draw(run, 'bzWaterfall');
  assert.equal(html.match(/class="bz-wf-col /g).length, 5);
  assert.match(html, /bz-wf-col is-down/);
  assert.match(html, /bz-wf-col is-up/);
  assert.match(html, />−€29\.1k</, 'bar labels are compact and use a true minus sign');
  assert.match(html, />\+€2\.4k</);
  assert.match(html, /aria-label="Smarter timing: −€29,070 a year/, 'the full value is read out');
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

test('KPI figures come straight from the backend business case', () => {
  const run = load(), r = ready(run), k = r.discountWindows.kpis;
  assert.equal(run('dashCharts.bzExtra.values().v'), k.aiExtraSavingsEur);
  assert.equal(run('dashCharts.bzDrivers.values().v'), k.driversSavedEur);
  assert.equal(run('dashCharts.bzOperator.values().v'), k.operatorProfitEur);
  assert.equal(run('dashCharts.bzPlatform.values().v'), k.platformProfitEur);
  assert.match(draw(run, 'bzExtra'), /€1,132<small>\/month/);
  assert.match(draw(run, 'bzPlatform'), /€122<small>\/month/);
  const kpis = run('bzKpiRow(bz.result)');
  for (const text of ['Extra savings from our AI', 'vs basic smart charging', 'Drivers saved', 'Charging operator profit', 'SaveThePlanet operating profit', 'from €282.10 gross commission']) {
    assert.ok(kpis.includes(text), text);
  }
});

test('a loss is never coloured as profit, and zero is neutral', () => {
  const run = load(), r = copy();
  Object.assign(r.discountWindows.kpis, { platformProfitEur: -120, operatorProfitEur: 0 });
  ready(run, r);
  assert.match(draw(run, 'bzPlatform'), /−€120/);
  const kpis = run('bzKpiRow(bz.result)');
  assert.match(kpis, /bz-kpi is-loss"[\s\S]*SaveThePlanet operating profit/);
  assert.match(kpis, /bz-kpi is-zero"[\s\S]*Charging operator profit/);
  assert.equal(run('bzTone(41.2)'), 'profit');
  assert.equal(run('bzTone(-0.01)'), 'loss');
  assert.equal(run('bzTone(0.001)'), 'zero');
});

test('where the € goes: one 50/25/25 bar and two profit bridges, all from the ledger', () => {
  const run = load(), r = ready(run), m = r.discountWindows.month;
  const v = JSON.parse(run('JSON.stringify(dashCharts.bzSplit.values())'));
  assert.deepEqual(v.amounts, [568.23, 282.1, 282.1]);
  assert.equal(v.pool, m.poolEur);
  assert.ok(Math.abs(v.w.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'the parts fill the bar');
  const bar = draw(run, 'bzSplit');
  assert.match(bar, /<b>€1,132\.43<\/b><span>extra AI savings a month<\/span>/);
  assert.match(bar, /<span>Drivers<\/span> €568<\/b>[\s\S]*<span>Operator<\/span> €282<\/b>[\s\S]*<span>SaveThePlanet<\/span> €282<\/b>/, 'the bar names its parts: no legend to read');
  const card = run('bzSplitCard(bz.result)');
  assert.match(card, /Where the € goes[\s\S]*split 50 \/ 25 \/ 25/);
  // Our bridge: commission, costs, profit. The parts add up on screen.
  assert.match(card, /Commission<\/span><b>€282\.10[\s\S]*Per-session costs<\/span><b>−€40\.30[\s\S]*Overhead<\/span><b>−€120\.00[\s\S]*is-profit"><span>Operating profit<\/span><b>€121\.80/);
  assert.match(card, /25% share<\/span><b>€282\.10[\s\S]*Programme costs<\/span><b>−€100\.00[\s\S]*Extra profit<\/span><b>€182\.10/);
  assert.equal(Math.round((m.platform.grossEur - m.platform.variableEur - m.platform.fixedEur) * 100), Math.round(m.platform.profitEur * 100), 'the bridge adds up to the cent');
  assert.match(card, /Breaks even at 200 sessions · <span class="is-profit">€1,462<\/span> a year[\s\S]*Breaks even at 143 sessions · <span class="is-profit">€2,185<\/span> a year/);
});

test('where the € goes with no eligible savings: empty bar, no commission, both losses', () => {
  const run = load(), r = copy();
  r.discountWindows.month = r.discountWindows.scenarios.noSurplus.month;
  ready(run, r);
  assert.match(draw(run, 'bzSplit'), /No eligible extra savings: nothing to share, no commission/);
  const card = run('bzSplitCard(bz.result)');
  assert.match(card, /is-loss"><span>Operating profit<\/span><b>−€120\.00/);
  assert.match(card, /is-loss"><span>Extra profit<\/span><b>−€100\.00/);
  assert.match(card, /Never breaks even/);
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
  assert.doesNotMatch(html, /on time</, 'when every van made it, the card says so once instead of on every row');
  assert.match(run('bzCompareCard(bz.result)'), /no look-ahead · all 140 van-nights on time/);
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
  const check = (raw) => JSON.parse(run(`JSON.stringify(bzValidate(${JSON.stringify(raw)}))`));
  const good = { sessions: '400', kwhPerSession: '20', savingEurPerKwh: '0.1', operatorFixedEur: '100', platformVariableEur: '0.1', platformFixedEur: '120' };
  assert.deepEqual(check(good).errors, {});
  assert.deepEqual(check(good).values, { sessions: 400, kwhPerSession: 20, savingEurPerKwh: 0.1, operatorFixedEur: 100, platformVariableEur: 0.1, platformFixedEur: 120 });
  assert.equal(check({ ...good, sessions: '12.5' }).errors.sessions, 'Whole number');
  assert.equal(check({ ...good, sessions: '-1' }).errors.sessions, '0–100,000');
  assert.equal(check({ ...good, savingEurPerKwh: 'abc' }).errors.savingEurPerKwh, 'Not a number');
  assert.equal(check({ ...good, kwhPerSession: '0' }).errors.kwhPerSession, '1–100');
  assert.equal(check({ ...good, platformFixedEur: '' }).errors.platformFixedEur, 'Required');
  assert.equal(check({ ...good, sessions: '1,000' }).values.sessions, 1000, 'thousands separators are accepted');
});

test('presets fill the calculator from the backend scenarios', async () => {
  const asked = [];
  const run = load({ fetch: (url) => { asked.push(url); return new Promise(() => {}); } });
  const r = ready(run);
  run('bzPreset("example")');
  assert.deepEqual(JSON.parse(run('JSON.stringify(bz.calc.values)')), { sessions: '400', kwhPerSession: '20', savingEurPerKwh: '0.1', operatorFixedEur: '100', platformVariableEur: '0.1', platformFixedEur: '120' });
  assert.equal(run('bzActivePreset()'), 'example');
  assert.match(asked.at(-1), /\/api\/v1\/business\/offers\/estimate\?sessions=400&kwhPerSession=20&savingEurPerKwh=0\.1/);
  run('bzPreset("noSurplus")');
  assert.equal(run('bz.calc.values.sessions'), '0');
  run('bzPreset("expected")');
  assert.equal(run('bz.calc.values.sessions'), String(r.discountWindows.kpis.sessions), 'the replay preset reproduces the KPIs');
  run('bz.calc.values.sessions = "401"');
  assert.equal(run('bzActivePreset()'), '');
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
  for (const resolve of pending.slice(2)) resolve(await response(200, { month: { platform: { profitEur: 1 } } })); // the calculator's first estimate
  await flush();
});

test('an older calculator answer never replaces a newer one', async () => {
  const pending = [];
  const run = load({ fetch: () => new Promise((resolve) => pending.push(resolve)) });
  run.set('bz.calc.values', { sessions: '400', kwhPerSession: '20', savingEurPerKwh: '0.1', operatorFixedEur: '100', platformVariableEur: '0.1', platformFixedEur: '120' });
  const answer = (profit) => ({ month: { platform: { profitEur: profit } } });
  run('bzEstimate()'); run('bz.calc.values.sessions = "500"'); run('bzEstimate()');
  pending[1](await response(200, answer(80)));
  await flush();
  pending[0](await response(200, answer(40)));
  await flush();
  assert.equal(run('bz.calc.result.month.platform.profitEur'), 80);
  assert.equal(run('bz.calc.pending'), false);
});

test('server field errors are shown on the what-if', async () => {
  const run = load({ fetch: () => response(400, { error: { code: 'INVALID_REQUEST', message: 'Check the highlighted inputs.', fields: { sessions: 'Qualifying sessions per month must be between 0 and 100,000.' } } }) });
  ready(run);
  run.set('bz.calc.values', { sessions: '400', kwhPerSession: '20', savingEurPerKwh: '0.1', operatorFixedEur: '100', platformVariableEur: '0.1', platformFixedEur: '120' });
  await run('bzEstimate()');
  assert.match(run('bz.calc.errors.sessions'), /between 0 and 100,000/);
  assert.match(run('bzWhatIf()'), /Fix the highlighted field to update the split/);
  assert.match(run('bzSplitCard(bz.result)'), /bz-split-card is-stale/, 'the last good split dims until the inputs are fixed');
  assert.match(run('bzField("sessions")'), /Check value<\/em>/, 'long server messages are shortened in the field');
});

test('the what-if drives the split and both bridges, with the cap and the no-spare-energy case', () => {
  const run = load(); ready(run);
  const month = (platform, operator) => ({ poolEur: 800, driversEur: 400, sessions: 400,
    operator: { retainedEur: 200, fixedEur: 100, profitEur: operator, breakEvenSessions: 200 },
    platform: { grossEur: 200, variableEur: 40, fixedEur: 120, profitEur: platform, breakEvenSessions: 300 },
    yearly: { platformProfitEur: platform * 12, operatorProfitEur: operator * 12 } });
  run.set('bz.calc.result', { month: month(40, 100), capacity: { requested: 400, counted: 400, limitedBy: null, limit: null }, noSpareEnergy: false });
  assert.equal(run('dashCharts.bzSplit.values().pool'), 800, 'the bar follows the what-if, not the replay');
  let html = run('bzWhatIf()');
  assert.match(html, /Commission<\/span><b>€200\.00[\s\S]*Operating profit<\/span><b>€40\.00/);
  assert.match(html, /Breaks even at 300 sessions · <span class="is-profit">€480<\/span> a year/);
  assert.match(html, /Breaks even at 200 sessions · <span class="is-profit">€1,200<\/span> a year/);
  assert.doesNotMatch(html, /sessions counted|No spare energy/);
  run.set('bz.calc.result', { month: month(-120, -100), capacity: { requested: 900, counted: 368, limitedBy: 'windows', limit: 'the replay found about 23 windows a month worth offering, at most 16 sessions of 20 kWh each.' }, noSpareEnergy: false });
  html = run('bzWhatIf()');
  assert.match(html, /is-warn[\s\S]*368 of 900 sessions counted: the replay found about 23 windows a month worth offering/);
  assert.match(html, /is-loss"><span>Extra profit<\/span><b>−€100\.00/);
  run.set('bz.calc.result', { month: month(-120, -100), capacity: { requested: 10, counted: 0, limitedBy: 'session-kwh', limit: 'An 11 kW charger delivers at most 22 kWh in a two-hour window.' }, noSpareEnergy: true });
  assert.match(run('bzWhatIf()'), /is-warn[\s\S]*An 11 kW charger delivers at most 22 kWh/);
  assert.doesNotMatch(run('bzWhatIf()'), /sessions counted/);
  run.set('bz.calc.result', { month: month(-120, -100), capacity: { requested: 0, counted: 0, limitedBy: null, limit: null }, noSpareEnergy: true });
  assert.match(run('bzWhatIf()'), /No spare energy: no discount and no commission, while both businesses still carry their fixed costs/);
});

test('energy proof stays apart from the money and labels what is hypothetical or conditional', () => {
  const run = load(), r = ready(run), e = r.discountWindows.energy;
  const html = run('bzEnergyCard(bz.result)');
  assert.match(html, /Energy proof/);
  assert.match(html, new RegExp(`${new Intl.NumberFormat('en-IE').format(Math.round(e.qualifyingKwh))} kWh</b><span>qualifying`));
  for (const text of ['Stored surplus', 'Direct surplus', 'Conventional grid', 'Hypothetical battery', 'Conditional · not verified', 'never offered', '% round trip', 'offers on 6/7 evenings, 0/7 mornings']) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /€/, 'no money in the energy card');
});

test('preparing, failed, empty and ready states render the right content', async () => {
  const run = load({ fetch: () => response(202, { status: 'preparing', progress: { done: 3, total: 10, stage: 'Replaying historical forecasts' } }) });
  run('bz.status = "loading"');
  assert.match(run('renderBusiness()'), /Loading<\/span>[\s\S]*bz-layout is-loading is-earn is-waiting/, 'placeholders wait a moment before showing');
  await run('bzLoad()');
  assert.equal(run('bz.status'), 'preparing');
  let html = run('renderBusiness()');
  assert.match(html, /Preparing · 4 of 10/);
  assert.match(html, /bz-layout is-loading is-earn" aria-busy="true"/, 'a known wait shows the placeholders at once');
  assert.match(html, /data-bz-view="depot"/, 'the views can be switched while loading');
  assert.match(html, /<li class="is-active" data-state="active">[\s\S]*Replay a week of GridToEv forecasts<\/b><small>day 4 of 8</);
  assert.equal(html.match(/data-state="pending"/g).length, 2);
  assert.match(html, /aria-valuenow="35"/);
  assert.match(html, /bz-progress-meta" aria-hidden="true">35%</);
  run('bz.view = "depot"');
  assert.match(run('renderBusiness()'), /bz-layout is-loading is-depot"[\s\S]*bz-card bz-money bz-progress/, 'the depot view loads in its own shape');
  run('bz.view = "earn"');
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
  assert.match(html, /bz-layout is-ready is-earn is-intro/, 'the results rise in when they first appear');
  assert.doesNotMatch(html, /aria-busy/);
  // Who earns: the business case, and nothing of the depot's yearly story.
  for (const text of ['<h1>Impact</h1>', 'Who saves and who earns from our AI.', '>Who earns<', '>Depot savings<', 'Extra savings from our AI', 'Drivers saved',
    'Charging operator profit', 'SaveThePlanet operating profit', 'Where the € goes', 'Energy proof', '>Replay<', '>400 sessions<', '>No spare energy<']) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /Where does the money come from|Is our AI making a difference|What if…\?/);
  assert.doesNotMatch(html, /Money earned/);
  assert.match(html, /SaveThePlanet Rewards · /, 'the programme is named as in issue #56');
  run('bz.view = "depot"');
  html = run('renderBusiness()');
  for (const text of ['Where does the money come from?', 'Is our AI making a difference?', 'Investment case', '>Money<', '>CO₂<', '>Renewable energy<']) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /Where the € goes|Energy proof|bz-kpis/, 'one story per view');
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
  assert.equal(steps({ done: 9, total: 10 })[2].label, 'Score the week and split the savings');
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
  assert.equal(JSON.parse(run('JSON.stringify(bzLoadingSteps({ done: 4, total: 10 }, 8000))'))[0].detail, 'day 5 of 8 · about 20 s left');
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

test('the entrance plays once per view, and a re-render while it plays continues it', () => {
  const run = load(); ready(run);
  assert.match(run('renderBusiness()'), /bz-scenario is-intro"\s[\s\S]*bz-layout is-ready is-earn is-intro"\s>[\s\S]*bz-provenance is-intro"/);
  run('document.querySelector = (selector) => (selector.includes(".bz-layout.is-ready.is-earn") ? {} : null)');
  run('bz.introAt = Date.now() - 300');
  assert.match(run('renderBusiness()'), /bz-layout is-ready is-earn is-intro" style="--bz-t:-3\d\dms">/, 'resumed 300 ms in');
  run('bz.introAt = Date.now() - 2000');
  assert.doesNotMatch(run('renderBusiness()'), /is-intro/, 'after the entrance the cards stay still');
  run('bz.view = "depot"');
  assert.match(run('renderBusiness()'), /bz-layout is-ready is-depot is-intro/, 'switching view brings the new cards in');
  run('bz.view = "earn"; bz.introAt = Date.now() - 2000');
  run('document.querySelector = () => null; var liveRender = true');
  assert.doesNotMatch(run('renderBusiness()'), /is-intro/, 'a live model update never starts it');
});

test('the what-if shows a spinner and dims while a new answer is on its way', () => {
  const run = load(); ready(run);
  const idle = run('bzSplitCard(bz.result)');
  assert.match(idle, /<span class="bz-updating" aria-hidden="true"><i class="bz-out-spin motion-loop"><\/i>Updating<\/span>/);
  assert.doesNotMatch(idle, /bz-split-card is-pending/);
  run('bz.calc.pending = true');
  assert.match(run('bzSplitCard(bz.result)'), /bz-split-card is-pending/);
});

test('loading motion keeps running through live model refreshes', () => {
  const run = load();
  run('bz.status = "preparing"');
  run.set('bz.progress', { done: 3, total: 10 });
  const html = run('renderBusiness()');
  for (const loop of ['bz-spin motion-loop', 'bz-progress-icon motion-loop', '<b class="motion-loop"></b>', 'bz-skel motion-loop']) assert.ok(html.includes(loop), loop);
  assert.match(run('bzScenario()'), /bz-chip is-busy"><i class="motion-loop"><\/i>/);
});

test('simulated data and projections are labelled everywhere they could be mistaken for real data', () => {
  const run = load(); ready(run);
  let html = run('renderBusiness()');
  assert.match(html, /Simulated data · retry model/);
  assert.match(html, /Example week/);
  assert.doesNotMatch(run('bzScenario()'), /24–31 Jan/, 'no real-looking dates for fixed example weather');
  // The KPI row's label sits right above it (issue #56: "Illustrative replay"; here, simulated data).
  assert.match(html, /bz-views-label">[\s\S]*SaveThePlanet Rewards · illustrative example · projected revenue, simulated profit · ex VAT/);
  assert.match(html, /Simulated example \(GridToEv unavailable\): fixed weather · hypothetical battery · illustrative prices, costs and demand · network access not verified/);
  run('bz.view = "depot"');
  assert.match(run('renderBusiness()'), /Simulated example · 20 simulated vans · illustrative tariff/);
  run('bz.view = "earn"');
  const real = copy();
  Object.assign(real, { dataMode: 'historical-replay', fallback: { active: false, reason: null } });
  ready(run, real);
  html = run('renderBusiness()');
  assert.match(run('bzScenario()'), /7 nights · GridToEv [\w.-]+ replay/);
  assert.match(run('bzScenario()'), /24–31 Jan 2026/);
  assert.match(html, /SaveThePlanet Rewards · illustrative replay · projected revenue, simulated profit · ex VAT/);
  assert.doesNotMatch(html, /Money earned/);
});

test('the depot view shows the waterfall, the comparison and the investment case together', () => {
  const run = load(), r = ready(run);
  run('bz.view = "depot"');
  const html = run('renderBusiness()');
  assert.match(html, /bz-layout is-ready is-depot/);
  assert.match(html, /Setup pays back in 6\.1 months/);
  assert.match(html, /5-year net return/);
  assert.ok(html.includes(`€${new Intl.NumberFormat('en-IE').format(r.financials.roiNetEur)}`));
  for (const label of ['Where does the money come from?', 'Is our AI making a difference?', 'Investment case', 'Conservative', 'Expected', 'Optimistic', '25 sites']) {
    assert.ok(html.includes(label), label);
  }
  assert.doesNotMatch(html, /data-bz-details|Hide details/, 'no toggle: the investment case is always there');
});

test('the Impact page sits after EV in the navigation and has its own route', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const nav = app.match(/const navItems=(\[.*?\]);/)[1];
  const order = [...nav.matchAll(/\['(\w+)','([^']+)'/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['overview:Dashboard', 'forecast:Forecast', 'impact:Battery', 'charging:EV', 'business:Impact']);
  // 'about' (Settings → About, issue #48) and 'sources' (Forecast → Wind & Solar, issue #65) have routes but no navigation item.
  assert.match(app, /\['overview','forecast','charging','impact','business','settings','about','sources'\]\.includes\(p\)/);
  assert.match(app, /business:renderBusiness/);
  assert.match(app, /business:'Impact'/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('business.js') > html.indexOf('charts3d.js') && html.indexOf('business.js') < html.indexOf('app.js'));
  assert.match(html, /business\.css\?v=/);
});
