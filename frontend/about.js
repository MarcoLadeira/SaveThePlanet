// About page (Settings → About): how SaveThePlanet works, in plain English.
// The model formulas come from GridToEV's /fitted-formulas and /formulas endpoints (via
// /api/v1/explorer/formulas), the accuracy figures from the live model information, and the
// EV example from /api/v1/about/example (backend/scenario.py), so no number here is typed by hand.
const aboutState = { formulas: null, formulasError: '', example: null, exampleError: '', model: null, loading: false };
const ABOUT_LINKS = {
  gridtoev: 'https://github.com/Carlson29/GridToEv',
  howItWorks: 'https://github.com/Carlson29/GridToEv/blob/main/docs/HOW_IT_WORKS.md',
  apiDocs: 'https://gridtoev-api.onrender.com/docs',
  eirgridSystem: 'https://cms.eirgrid.ie/sites/default/files/publications/System-Data-Qtr-Hourly-2026-V7.xlsx',
  eirgridDispatchDown: 'https://cms.eirgrid.ie/sites/default/files/publications/DD-HH-2026-V9.xlsx',
  generation: 'https://hacktheclimate.io/samples/generation.csv',
  load: 'https://hacktheclimate.io/samples/load.csv',
  prices: 'https://hacktheclimate.io/samples/prices.csv',
  scenario: 'https://github.com/MarcoLadeira/SaveThePlanet/blob/main/backend/scenario.py',
  optimiser: 'https://github.com/MarcoLadeira/SaveThePlanet/issues/44',
};

async function aboutLoad() {
  if (aboutState.loading || (aboutState.formulas && aboutState.example)) return;
  aboutState.loading = true;
  const get = async (path) => {
    const response = await fetch(path);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'Unavailable right now.');
    return body;
  };
  await Promise.all([
    get('/api/v1/explorer/formulas').then((body) => { aboutState.formulas = body; }, (error) => { aboutState.formulasError = error.message; }),
    get('/api/v1/about/example').then((body) => { aboutState.example = body; }, (error) => { aboutState.exampleError = error.message; }),
    get('/api/v1/explorer/short-term').then((body) => { aboutState.model = body.model; }, () => {}),
  ]);
  aboutState.loading = false;
  if (pageFromHash() === 'about') render();
}

const aboutLink = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}<span class="sr-only"> (opens in a new tab)</span></a>`;
const aboutNum = (value, digits = 1) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: digits }).format(value).replace('-', '−');
const aboutPct = (value) => `${Math.round(value * 100)}%`;
// "tree₁ + … + tree₁₈₀": the sum of every tree's answer, written the way a person would read it.
const aboutSub = (n) => String(n).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[d]);
const aboutTrees = (e) => `tree${aboutSub(1)} + … + tree${aboutSub(e.trees)}`;
const aboutStart = (e) => (Math.abs(e.start) < 0.005 ? '0' : aboutNum(e.start, 2));

// One formula: what it answers, the formula itself, and what it means in everyday words.
function aboutFormula(title, formula, meaning) {
  return `<li class="about-f"><h4>${title}</h4><p class="about-eq" role="math">${formula}</p><p>${meaning}</p></li>`;
}

// What the pages are showing right now: never call a historical replay "live".
function aboutDataStatus() {
  const d = modelState.data;
  if (!d) return '<p class="about-status">Loading what the pages are showing…</p>';
  if (d.dataMode === 'simulated') return '<p class="about-status is-demo"><b>Right now:</b> an <b>offline example</b>, because the forecast model could not be reached. It is not a real forecast.</p>';
  return `<p class="about-status"><b>Right now:</b> a <b>historical prediction</b> for ${escapeHtml(modelTime(d.predictions[0].targetAt, true))}, re-run on archived January 2026 data. It is <b>not live</b>.</p>`;
}

function aboutExact(model) {
  return `<details class="about-exact"><summary>Exact formulas from the API</summary>
    <ul>${model.estimators.map((e) => `<li><b>${escapeHtml(e.id)}</b><code>${escapeHtml(e.formula)}</code></li>`).join('')}</ul></details>`;
}

function aboutPending() {
  return `<p class="about-note">${aboutState.formulasError ? `The formulas are unavailable right now (${escapeHtml(aboutState.formulasError)}).` : 'Loading the formulas from the model…'}</p>`;
}

function aboutShortTermModel() {
  const m = aboutState.formulas?.shortTerm;
  const head = `<header><h3>Half-hour forecast</h3><span class="about-tag">V1${m ? ` · ${escapeHtml(m.version)}` : ''}</span></header>`;
  if (!m) return `<article class="dash-card about-model">${head}${aboutPending()}</article>`;
  const e = Object.fromEntries(m.estimators.map((item) => [item.id, item]));
  const p = m.parameters, alpha = p.dispatch_trend_alpha_by_horizon || {}, risk = p.risk_level_cutoffs || {};
  const shares = p.default_component_shares || {}, widen = p.prediction_interval_adjustment_mwh;
  const mlOff = Object.values(p.dispatch_regression_ml_weight_by_horizon || {}).every((w) => w === 0);
  const t = aboutState.model?.test;
  const example = 20 + alpha[30] * (20 - 10);
  return `<article class="dash-card about-model">${head}
    <p class="about-predicts"><b>Predicts:</b> how much wind and solar power (MWh) the grid will switch off in <b>one half-hour</b>, <b>30 or 60 minutes ahead</b>. It reads ${m.inputs} grid measurements known at that moment: wind, demand, prices, power flows to Britain and recent switch-offs.</p>
    <ol class="about-fs">
      ${aboutFormula('1 · Chance of a switch-off',
        `chance = sigmoid(${aboutStart(e.event_classifier)} + ${aboutTrees(e.event_classifier)})`,
        `${e.event_classifier.trees} decision trees each add or subtract a little evidence. Sigmoid turns the total into a chance from 0% to 100%. The dashboard shows <b>high risk</b> at ${aboutPct(risk.high)} or more and <b>medium</b> at ${aboutPct(risk.medium)} or more.`)}
      ${aboutFormula('2 · Amount switched off (MWh)',
        `amount = latest + α × (latest − previous) &nbsp;<small>(never below 0)</small><br><small>α = ${aboutNum(alpha[30], 3)} at 30 min · ${aboutNum(alpha[60], 3)} at 60 min</small>`,
        `Start from the last measured half-hour and continue its recent trend a little. <i>Example:</i> 20 MWh now and 10 MWh before gives 20 + ${aboutNum(alpha[30], 3)} × 10 = <b>${aboutNum(example, 2)} MWh</b>.${mlOff ? ' A tree model for this amount exists but currently has weight 0, so this trend is the number you see.' : ''}`)}
      ${aboutFormula('3 · Split into the two causes',
        `curtailment = amount × C ÷ (C + K)<br>constraints = amount − curtailment<br><small>C = e^(${aboutStart(e.curtailment_regressor)} + ${aboutTrees(e.curtailment_regressor)}) · K = e^(${aboutStart(e.constraint_regressor)} + ${aboutTrees(e.constraint_regressor)})</small>`,
        `Two more tree models guess each cause (e^ keeps the guesses positive). They only share out the amount, so the two parts always add up to it. If both guess 0, the usual split is used: ${aboutPct(shares.curtailment)} curtailment, ${aboutPct(shares.constraint)} constraints.`)}
      ${aboutFormula('4 · Likely range (P10–P90)',
        `low = latest + (${aboutStart(e.dispatch_down_quantile_p10)} + ${aboutTrees(e.dispatch_down_quantile_p10)}) − ${aboutNum(widen, 2)}<br>high = latest + (${aboutStart(e.dispatch_down_quantile_p90)} + ${aboutTrees(e.dispatch_down_quantile_p90)}) + ${aboutNum(widen, 2)}`,
        `Two tree models predict a cautious and a generous change from the latest half-hour. Each end is pushed out by ${aboutNum(widen, 2)} MWh, so the range should hold the real value about 8 times in 10.`)}
    </ol>
    ${t ? `<p class="about-note"><b>Accuracy:</b> on ${aboutNum(t.rows, 0)} half-hours it never trained on, it was off by ${t.maeMwh.toFixed(1)} MWh on average, against ${t.latestObservationMaeMwh.toFixed(1)} MWh for simply repeating the last half-hour. The range held the real value ${aboutPct(t.intervalCoverage)} of the time (target 80%). ${aboutLink(ABOUT_LINKS.howItWorks, 'How it was tested')}</p>` : ''}
    ${aboutExact(m)}
  </article>`;
}

function aboutDailyModel() {
  const m = aboutState.formulas?.daily;
  const head = `<header><h3>Daily forecast</h3><span class="about-tag">V2${m ? ` · ${escapeHtml(m.version)}` : ''}</span></header>`;
  if (!m) return `<article class="dash-card about-model">${head}${aboutPending()}</article>`;
  const e = Object.fromEntries(m.estimators.map((item) => [item.id, item]));
  return `<article class="dash-card about-model">${head}
    <p class="about-predicts"><b>Predicts:</b> the <b>total curtailment (MWh) over a whole day</b> (midnight to midnight UTC), from the day-ahead weather forecast. It reads ${m.inputs} inputs: wind, sunshine and temperature in four regions of Ireland, plus the time of year and whether it is a weekend.</p>
    <ol class="about-fs">
      ${aboutFormula('1 · Chance of curtailment that day',
        `chance = sigmoid(${aboutStart(e.event_model)} + ${aboutTrees(e.event_model)})`,
        `${e.event_model.trees} decision trees weigh up the weather. Sigmoid turns their total into a chance from 0% to 100%.`)}
      ${aboutFormula('2 · Amount, if it happens (MWh)',
        `amount = (${aboutTrees(e.amount_model)}) ÷ ${e.amount_model.trees}`,
        `${e.amount_model.trees} trees, trained only on days that had curtailment, each make a guess. The model takes their average.`)}
      ${aboutFormula('3 · Predicted curtailment (MWh)',
        'predicted = chance × amount',
        '<i>Example:</i> a 60% chance of a 200 MWh day gives 0.6 × 200 = <b>120 MWh</b>. An unlikely day gives a small number, even if it could have been a big one.')}
    </ol>
    <p class="about-note">This model is experimental. It covers curtailment only (no constraints) and gives no likely range.</p>
    ${aboutExact(m)}
  </article>`;
}

function aboutEvSection() {
  const e = aboutState.example;
  const perCharge = e?.assumptions.kwhPerCharge ?? 30;
  const worked = e ? (() => {
    const i = e.inputs, s = e.steps;
    const limit = s.potentialRecoveryMwh === s.flexibleDemandMwh ? 'the charging that can wait' : s.potentialRecoveryMwh === s.capacityEnergyMwh ? 'the chargers’ capacity' : 'the spare power itself';
    return `<p class="about-worked"><b>Worked example</b> <small>(made-up numbers)</small><br>
      ${aboutNum(i.curtailmentMwh)} + ${aboutNum(i.constraintMwh)} = <b>${aboutNum(s.atRiskMwh)} MWh</b> at risk →
      min(${aboutNum(s.atRiskMwh)}, ${aboutNum(i.flexibleDemandKwh, 0)} ÷ 1,000, ${aboutNum(i.flexibleCapacityMw, 0)} × 0.5) = <b>${aboutNum(s.potentialRecoveryMwh)} MWh</b> →
      <b>${aboutNum(s.potentialKwh, 0)} kWh</b> → ${aboutNum(s.potentialKwh, 0)} ÷ ${aboutNum(perCharge, 0)} ≈ <b>${aboutNum(s.chargingSessionsEquivalent)} charges</b>.
      Here the limit is ${limit}, so ${aboutNum(s.remainingAtRiskMwh)} MWh would still be wasted.</p>`;
  })() : `<p class="about-note">${aboutState.exampleError ? `The worked example is unavailable (${escapeHtml(aboutState.exampleError)}).` : 'Loading the worked example…'}</p>`;
  return `<section class="dash-card about-ev" aria-labelledby="about-ev-title">
    <h2 id="about-ev-title">From forecast to EV charging <small>(our app’s own maths, using the half-hour forecast)</small></h2>
    <ol class="about-fs about-fs-row">
      ${aboutFormula('Energy at risk (MWh)', 'at risk = curtailment + constraints',
        'Everything the grid is expected to switch off in that half-hour. The 30- and 60-minute forecasts are two guesses about the <b>same</b> half-hour, so they are never added together.')}
      ${aboutFormula('Usable by EVs (MWh)', 'usable = min(at risk, flexible kWh ÷ 1,000, chargers MW × 0.5 h)',
        '“min” means the smallest of the three wins: the spare power, the charging that can wait, or what the chargers can draw in half an hour. It is an <b>upper limit</b>, not energy actually saved.')}
      ${aboutFormula('In charging terms', `kWh = MWh × 1,000<br>charges = kWh ÷ ${aboutNum(perCharge, 0)}`,
        `One charge is a typical ${aboutNum(perCharge, 0)} kWh top-up, with no energy lost. It compares amounts of energy. It is <b>not</b> a count of real cars booked in; a charging scheduler is ${aboutLink(ABOUT_LINKS.optimiser, 'still being built')}.`)}
    </ol>
    ${worked}
  </section>`;
}

function aboutSources() {
  const a = aboutState.example?.assumptions;
  return `<details class="about-assumptions">
    <summary>Data sources &amp; assumptions</summary>
    <p><b>Data (historical, January 2026, not live):</b> ${aboutLink(ABOUT_LINKS.eirgridSystem, 'EirGrid system data')} (every 15 min) · ${aboutLink(ABOUT_LINKS.eirgridDispatchDown, 'EirGrid dispatch-down report')} (every 30 min) · ENTSO-E samples via Hack the Climate: ${aboutLink(ABOUT_LINKS.generation, 'generation')}, ${aboutLink(ABOUT_LINKS.load, 'demand')}, ${aboutLink(ABOUT_LINKS.prices, 'prices')}.</p>
    <p><b>How it reaches you:</b> our server asks the ${aboutLink(ABOUT_LINKS.gridtoev, 'GridToEV')} model (${aboutLink(ABOUT_LINKS.apiDocs, 'API docs')}); its access key never leaves our server.</p>
    ${a ? `<p><b>Estimates on other pages:</b> CO₂ avoided = usable MWh × ${aboutNum(a.gridIntensityTco2PerMwh, 2)} t per MWh (a rough Irish grid average) · driving range = kWh ÷ ${aboutNum(a.evKwhPerKm, 2)} kWh per km · chargers are ${aboutNum(a.chargerKw, 0)} kW.</p>` : ''}
    <p><b>Limits:</b> the models learned from about one month of data, and the half-hour model’s test days had no curtailment. Every figure is a projection. Our calculations: ${aboutLink(ABOUT_LINKS.scenario, 'backend/scenario.py')}.</p>
  </details>`;
}

function renderAbout() {
  queueMicrotask(aboutLoad);
  return `${studioHeader('About', 'How SaveThePlanet works.')}
  <div class="about-page">
    <button type="button" class="about-back" data-page="settings">${icon('arrow', 16, 'about-back-icon')}Back to Settings</button>
    <section class="dash-card about-intro">
      <p><b>SaveThePlanet</b> predicts when Ireland’s grid will have to <b>switch off</b> wind and solar power it can’t use, and works out how much of it electric cars could charge with instead.</p>
      <dl class="about-words">
        <div><dt>MWh</dt><dd>an amount of energy. 1 MWh = 1,000 kWh, about 33 car top-ups.</dd></div>
        <div><dt>Curtailment</dt><dd>too much green power on the whole island, so some is switched off.</dd></div>
        <div><dt>Constraints</dt><dd>one part of the network is full, like a jammed road, so local power can’t get out.</dd></div>
        <div><dt>Decision tree</dt><dd>a flowchart of yes/no questions (“Is wind above 2,000 MW?”) ending in a number. The models add up many of them.</dd></div>
      </dl>
      ${aboutDataStatus()}
    </section>
    <h2 class="about-section-title">The two forecasting models</h2>
    <div class="about-models">${aboutShortTermModel()}${aboutDailyModel()}</div>
    ${aboutEvSection()}
    ${aboutSources()}
  </div>`;
}
