// About page (Settings → About): how SaveThePlanet works, in four plain-English steps.
// Every formula below is the one the backend uses (backend/scenario.py). The worked example
// and the assumptions are fetched from /api/v1/about/example, which runs those same functions,
// and the model facts come from the live model information (/api/v1/explorer/short-term),
// so nothing on this page is typed in by hand and allowed to drift.
const aboutState = { example: null, exampleError: '', model: null, modelError: '', loading: false };
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
  if (aboutState.loading || (aboutState.example && aboutState.model)) return;
  aboutState.loading = true;
  const get = async (path) => {
    const response = await fetch(path);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'Unavailable right now.');
    return body;
  };
  await Promise.all([
    get('/api/v1/about/example').then((body) => { aboutState.example = body; }, (error) => { aboutState.exampleError = error.message; }),
    get('/api/v1/explorer/short-term').then((body) => { aboutState.model = body.model; }, (error) => { aboutState.modelError = error.message; }),
  ]);
  aboutState.loading = false;
  if (pageFromHash() === 'about') render();
}

const aboutLink = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}<span class="sr-only"> (opens in a new tab)</span></a>`;
const aboutNum = (value, digits = 1) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: digits }).format(value);
function aboutFormula(lines) {
  return `<div class="about-formula" role="math">${lines.map((line) => `<p>${line}</p>`).join('')}</div>`;
}
function aboutTerm(term, meaning) { return `<dt>${term}</dt><dd>${meaning}</dd>`; }

// What the pages are showing right now: never call a historical replay "live".
function aboutDataStatus() {
  const d = modelState.data;
  if (!d) return '<p class="about-status">Loading what the pages are showing…</p>';
  if (d.dataMode === 'simulated') return '<p class="about-status is-demo"><b>Right now:</b> an <b>offline example</b> (simulated data), because the forecast model could not be reached. It is not a real forecast.</p>';
  return `<p class="about-status"><b>Right now:</b> a <b>historical dataset prediction</b> — the GridToEV model re-run for ${escapeHtml(modelTime(d.predictions[0].targetAt, true))} using archived January 2026 data. It is <b>not live</b>.</p>`;
}

function aboutModelFacts() {
  const m = aboutState.model;
  if (!m) return `<p class="about-note">${aboutState.modelError ? `Model details are unavailable right now (${escapeHtml(aboutState.modelError)}).` : 'Loading model details…'}</p>`;
  const t = m.test || {};
  return `<ul class="about-facts">
      <li><span>Model version</span><b>GridToEV V1 ${escapeHtml(m.version)}</b></li>
      <li><span>Forecast step</span><b>one half-hour, made 30 or 60 minutes ahead</b></li>
      <li><span>Typical error on unseen data</span><b>${aboutNum(t.maeMwh)} MWh per half-hour</b><small>Over ${aboutNum(t.rows, 0)} half-hours the model never trained on. A simple “same as the last half-hour” guess was off by ${aboutNum(t.latestObservationMaeMwh)} MWh.</small></li>
      <li><span>How often reality fell in the “likely range”</span><b>${Math.round((t.intervalCoverage || 0) * 100)}% of the time</b><small>The aim is 80%. The likely range (called P10–P90) is where the model expects the true value 8 times out of 10.</small></li>
    </ul>
    <p class="about-note">Accuracy details: ${aboutLink(ABOUT_LINKS.howItWorks, 'how GridToEV is trained and tested')} · ${aboutLink(ABOUT_LINKS.apiDocs, 'GridToEV API documentation')}</p>`;
}

function aboutExample() {
  const e = aboutState.example;
  if (!e) return `<p class="about-note">${aboutState.exampleError ? `The worked example is unavailable right now (${escapeHtml(aboutState.exampleError)}).` : 'Loading the worked example…'}</p>`;
  const i = e.inputs, s = e.steps, a = e.assumptions;
  const limit = s.potentialRecoveryMwh === s.flexibleDemandMwh ? 'your flexible EV demand' : s.potentialRecoveryMwh === s.capacityEnergyMwh ? 'the charging capacity' : 'the energy at risk';
  return `<section class="about-example" aria-labelledby="about-example-title">
      <h2 id="about-example-title">A worked example <small>(illustrative numbers, not a real forecast)</small></h2>
      <p>Imagine one half-hour where the model predicts <b>${aboutNum(i.curtailmentMwh)} MWh</b> of curtailment and <b>${aboutNum(i.constraintMwh)} MWh</b> of constraints. You have <b>${aboutNum(i.flexibleDemandKwh, 0)} kWh</b> of EV charging that can move in time, and <b>${aboutNum(i.flexibleCapacityMw, 0)} MW</b> of chargers.</p>
      <ol class="about-example-steps">
        <li><span>Energy at risk</span><code>${aboutNum(i.curtailmentMwh)} + ${aboutNum(i.constraintMwh)} = <b>${aboutNum(s.atRiskMwh)} MWh</b></code></li>
        <li><span>Potential energy</span><code>min(${aboutNum(s.atRiskMwh)}, ${aboutNum(i.flexibleDemandKwh, 0)} ÷ 1,000, ${aboutNum(i.flexibleCapacityMw, 0)} × 0.5) = min(${aboutNum(s.atRiskMwh)}, ${aboutNum(s.flexibleDemandMwh)}, ${aboutNum(s.capacityEnergyMwh)}) = <b>${aboutNum(s.potentialRecoveryMwh)} MWh</b></code><small>The smallest number wins: here the limit is ${limit}.</small></li>
        <li><span>In EV terms</span><code>${aboutNum(s.potentialRecoveryMwh)} × 1,000 = <b>${aboutNum(s.potentialKwh, 0)} kWh</b> → ${aboutNum(s.potentialKwh, 0)} ÷ ${aboutNum(a.kwhPerCharge, 0)} ≈ <b>${aboutNum(s.chargingSessionsEquivalent)} charging sessions’ worth</b></code></li>
      </ol>
      <p class="about-note">So even in the best case, <b>${aboutNum(s.remainingAtRiskMwh)} MWh</b> would still be wasted. These are the same calculations the app uses (${aboutLink(ABOUT_LINKS.scenario, 'backend/scenario.py')}).</p>
    </section>`;
}

function aboutAssumptions() {
  const e = aboutState.example;
  if (!e) return '';
  const a = e.assumptions, s = e.steps;
  return `<details class="about-assumptions">
      <summary>Assumptions &amp; sources</summary>
      <ul>
        <li><b>${aboutNum(a.kwhPerCharge, 0)} kWh per charge</b> — a typical top-up session, used for “charging sessions’ worth”.</li>
        <li><b>${aboutNum(a.chargingEfficiency * 100, 0)}% charging efficiency</b> — no energy is assumed lost while charging. Real charging loses some.</li>
        <li><b>${aboutNum(a.chargerKw, 0)} kW per charger</b> — a public AC charger, used on the Charging page for the fewest chargers that could take the energy in half an hour.</li>
        <li><b>CO₂ avoided (estimate)</b> = potential MWh × ${aboutNum(a.gridIntensityTco2PerMwh, 2)} tonnes per MWh, a rough Irish grid average. In the example: ${aboutNum(s.avoidedEmissionsTco2, 3)} t.</li>
        <li><b>Driving range (estimate)</b> = potential kWh ÷ ${aboutNum(a.evKwhPerKm, 2)} kWh per km, a typical car. In the example: ${aboutNum(s.evRangeKm, 0)} km.</li>
        <li><b>Limits:</b> the short-term model learned from one month (January 2026), and its test days contained no curtailment examples. Every figure is a projection, not measured charging or measured savings.</li>
      </ul>
      <p>Sources: ${aboutLink(ABOUT_LINKS.gridtoev, 'GridToEV repository')} · ${aboutLink(ABOUT_LINKS.howItWorks, 'How GridToEV works')} · ${aboutLink(ABOUT_LINKS.apiDocs, 'API documentation')} · ${aboutLink(ABOUT_LINKS.scenario, 'our calculation code')}</p>
    </details>`;
}

function renderAbout() {
  queueMicrotask(aboutLoad);
  const step = (n, title, body) => `<li class="dash-card about-step"><h2><span class="about-num" aria-hidden="true">${n}</span>${title}</h2>${body}</li>`;
  return `${studioHeader('About', 'How SaveThePlanet works, in about a minute.')}
  <div class="about-page">
    <button type="button" class="about-back" data-page="settings">${icon('arrow', 16, 'about-back-icon')}Back to Settings</button>
    <section class="dash-card about-intro">
      <p><b>SaveThePlanet</b> uses an AI forecast to spot renewable electricity — mostly wind — that Ireland’s grid may have to switch off, and estimates how much of it electric-car charging could use instead.</p>
      ${aboutDataStatus()}
    </section>
    <ol class="about-steps">
      ${step(1, 'Where our data comes from', `
        <p>The forecasting model, called <b>GridToEV</b>, learned from public Irish electricity records for <b>January 2026</b>:</p>
        <ul class="about-sources">
          <li>${aboutLink(ABOUT_LINKS.eirgridSystem, 'EirGrid system data')} — wind, solar, demand and cables to Britain, every 15 minutes.</li>
          <li>${aboutLink(ABOUT_LINKS.eirgridDispatchDown, 'EirGrid dispatch-down report')} — how much wind and solar power was actually switched off, every half-hour.</li>
          <li>Hack the Climate samples from ENTSO-E (the European grid operators’ data platform): ${aboutLink(ABOUT_LINKS.generation, 'generation by fuel')}, ${aboutLink(ABOUT_LINKS.load, 'electricity demand')} and ${aboutLink(ABOUT_LINKS.prices, 'prices')}.</li>
        </ul>
        <p><b>How it reaches you:</b> our server asks the GridToEV model for its forecasts (the access key stays on our server), checks the numbers, and passes them to this page. See ${aboutLink(ABOUT_LINKS.gridtoev, 'the GridToEV project')}.</p>
        <p><b>Is it live?</b> No. The model re-runs its predictions on that archived January 2026 data — a <b>historical replay</b>. If the model can’t be reached you see a clearly labelled <b>offline example</b> instead. Nothing here forecasts today.</p>`)}
      ${step(2, 'How we predict wasted energy', `
        <p>Sometimes there is more wind or solar power than the grid can take, so the grid operator turns some of it down. This is called <b>dispatch-down</b>, and it has two causes:</p>
        <dl class="about-terms">
          ${aboutTerm('Curtailment', 'The whole island has too much renewable power at once, so some is turned down to keep the system stable.')}
          ${aboutTerm('Constraints', 'One part of the network is full — like a traffic jam on one road — so power there can’t get out.')}
        </dl>
        ${aboutFormula(['<b>Predicted energy at risk</b> (MWh) = predicted curtailment (MWh) + predicted constraints (MWh)'])}
        <p class="about-note">MWh (megawatt-hour) is an amount of energy: 1 MWh = 1,000 kWh.</p>
        <p>The model forecasts one half-hour at a time, made either <b>30 or 60 minutes ahead</b>. These are two forecasts of the <b>same</b> half-hour — like two weather forecasts for the same afternoon made at different times — so they are <b>never added together</b>.</p>
        ${aboutModelFacts()}`)}
      ${step(3, 'How much might be usable', `
        ${aboutFormula(['<b>Potential energy</b> (MWh) = min(', '&nbsp;&nbsp;predicted energy at risk (MWh),', '&nbsp;&nbsp;flexible EV demand (kWh) ÷ 1,000,', '&nbsp;&nbsp;charging capacity (MW) × 0.5 hours )'])}
        <p><b>min(…)</b> means “take the smallest of the three”, like a chain that is only as strong as its weakest link:</p>
        <ul class="about-parts">
          <li><b>Energy at risk</b> — you can’t use more wasted energy than there is.</li>
          <li><b>Flexible EV demand</b> — only charging that can move in time counts. Dividing kWh by 1,000 turns it into MWh.</li>
          <li><b>Charging capacity × 0.5 hours</b> — chargers can only draw so much power in one half-hour. For example, 100 MW for half an hour is 50 MWh.</li>
        </ul>
        <p class="about-warning"><b>This is a potential upper bound</b> — the most that could be used if chargers were connected in the right place at the right time. It is <b>not</b> energy that was actually saved. Location, local grid limits, whether cars are plugged in, charging speed and reaction time can all reduce it.</p>`)}
      ${step(4, 'How it becomes EV charging', `
        ${aboutFormula(['<b>Potential EV energy</b> (kWh) = potential energy (MWh) × 1,000', `<b>Charging sessions’ worth</b> = potential EV energy (kWh) ÷ ${aboutNum(aboutState.example?.assumptions.kwhPerCharge ?? 30, 0)} kWh per charge`])}
        <p>We assume a typical top-up of ${aboutNum(aboutState.example?.assumptions.kwhPerCharge ?? 30, 0)} kWh and <b>100% charging efficiency</b> (no energy lost while charging).</p>
        <p>“Charging sessions’ worth” is an <b>energy comparison</b> — for example, “500 kWh is about as much energy as 17 typical top-ups”. It is <b>not</b> a count of real cars that were scheduled or charged.</p>
        <p class="about-note">A scheduler that checks when cars arrive and leave, and each charger’s limits, is being built (${aboutLink(ABOUT_LINKS.optimiser, 'issue #44')}). It is <b>not part of this app yet</b>.</p>`)}
    </ol>
    ${aboutExample()}
    ${aboutAssumptions()}
  </div>`;
}
