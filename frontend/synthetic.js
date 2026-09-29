// Synthetic V1 scenarios. The server varies the model's own example raw-input request and
// sends it to /predict/v1/from-raw. Results live only in this dialog: they are never stored,
// charted, fed to Volt or merged into the shared historical forecast.
//
// Accessibility (review P1.6): a native <dialog> opened with showModal() gives focus
// containment, an inert background and Esc to close. The dialog is built once; updates only
// replace the status text and the result region, never the control that has focus. Focus goes
// to the heading on open and back to the opening button on close.
const SYNTH_LABEL = 'Synthetic scenario — not a forecast of today’s actual grid conditions.';
const synth = { open: false, scenario: 'ordinary', horizon: 30, issueTime: 'example', loading: false, token: 0, result: null, returnFocus: null };
const synthSignals = [
  ['eirgrid_ie_wind_generation_mw', 'Ireland wind', 'MW', 0],
  ['eirgrid_ie_demand_mw', 'Ireland demand', 'MW', 0],
  ['entsoe_price_eur_mwh', 'Electricity price', '€/MWh', 1],
  ['eirgrid_snsp_ratio', 'SNSP', 'ratio', 2],
  ['eirgrid_all_island_oversupply_mw', 'All-island oversupply', 'MW', 0],
  ['observed_dispatch_down_mwh', 'Observed past dispatch-down', 'MWh', 1],
];

function synthButton() {
  return `<button type="button" class="synth-open" data-synth-open aria-haspopup="dialog">${icon('pulse', 17)}<span>Synthetic V1 scenario</span></button>`;
}
function synthNumber(value, digits = 1) {
  return new Intl.NumberFormat('en-IE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
function synthUtc(stamp, withDate = false) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', ...(withDate ? { day: 'numeric', month: 'short', year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(stamp)) + ' UTC';
}
function synthRadios(name, legend, options, value) {
  return `<fieldset class="synth-group"><legend>${legend}</legend>${options.map(([key, text]) => `<label><input type="radio" name="synth-${name}" value="${key}" ${String(value) === String(key) ? 'checked' : ''}><span>${text}</span></label>`).join('')}</fieldset>`;
}

// Built once and reused, so focus and control state survive every update.
function synthDialog() {
  let dialog = document.getElementById('synth-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'synth-dialog';
  dialog.className = 'synth-dialog';
  dialog.setAttribute('aria-labelledby', 'synth-title');
  dialog.setAttribute('aria-describedby', 'synth-purpose');
  dialog.innerHTML = `
    <header class="synth-head"><div><h2 id="synth-title" tabindex="-1">Synthetic V1 scenario</h2>
      <p id="synth-purpose">A synthetic API demonstration and stress test: the model’s own January 2026 example raw-input request, randomly varied on every run and sent to <code>/predict/v1/from-raw</code>. Structurally valid, not realistic current telemetry.</p></div>
      <button type="button" class="synth-close" data-synth-close aria-label="Close synthetic scenario">×</button></header>
    <p class="synth-label is-banner"><b>Synthetic</b>${SYNTH_LABEL}</p>
    <form class="synth-controls" data-synth-form>
      ${synthRadios('scenario', 'Scenario', [['ordinary', 'Ordinary'], ['high-curtailment', 'High curtailment (labelled)']], synth.scenario)}
      ${synthRadios('horizon', 'Horizon', [[30, '+30 min'], [60, '+60 min']], synth.horizon)}
      ${synthRadios('issueTime', 'Issue time', [['example', 'Example date (31 Jan 2026 22:30 UTC)'], ['current', 'Current UTC half-hour']], synth.issueTime)}
      <button type="submit" class="studio-button synth-generate" data-synth-generate>Generate new scenario ${icon('arrow', 17)}</button>
    </form>
    <p class="synth-status" id="synth-status" role="status" aria-live="polite"></p>
    <p class="synth-error" id="synth-error" role="alert" hidden></p>
    <div class="synth-result-region" id="synth-result"></div>`;
  document.body.appendChild(dialog);
  // Clean up directly on every way out (button, backdrop, Esc via the synchronous 'cancel'
  // event); 'close' is a backstop. synthClose() is idempotent.
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); synthClose(); });
  dialog.addEventListener('close', synthClose);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) synthClose(); }); // backdrop
  dialog.querySelector('[data-synth-close]').addEventListener('click', synthClose);
  dialog.querySelector('[data-synth-form]').addEventListener('submit', (event) => { event.preventDefault(); synthGenerate(); });
  dialog.querySelector('[data-synth-form]').addEventListener('change', (event) => {
    const input = event.target;
    if (input.name === 'synth-scenario') synth.scenario = input.value;
    if (input.name === 'synth-horizon') synth.horizon = Number(input.value);
    if (input.name === 'synth-issueTime') synth.issueTime = input.value;
    synthGenerate();
  });
  return dialog;
}

function synthResultHtml(r) {
  const p = r.prediction, inputs = r.inputs;
  const rows = synthSignals.map(([key, name, unit, digits]) => {
    const [low, high] = inputs.historyRanges[key];
    return `<tr><th scope="row">${name}</th><td>${synthNumber(low, digits)}–${synthNumber(high, digits)} <small>${unit}</small></td><td>${synthNumber(inputs.current[key], digits)} <small>${unit}</small></td></tr>`;
  }).join('');
  return `<section class="synth-result" aria-labelledby="synth-result-title">
    <div class="synth-result-head">
      <div class="synth-figure"><h3 id="synth-result-title">${escapeHtml(r.scenarioLabel)} · +${p.horizonMinutes} min</h3><strong>${synthNumber(p.atRiskMwh)}<small> MWh</small></strong><em>predicted dispatch-down for the synthetic target ${escapeHtml(synthUtc(p.targetAt, true))}</em></div>
      <p class="synth-label is-beside"><b>Synthetic</b>${SYNTH_LABEL}</p>
    </div>
    <dl class="synth-metrics">
      <div><dt>Event probability</dt><dd>${synthNumber(p.probability * 100)}%</dd></div>
      <div><dt>Risk</dt><dd class="synth-risk is-${escapeHtml(p.risk)}">${escapeHtml(p.risk)}</dd></div>
      <div><dt>P10–P90</dt><dd>${synthNumber(p.lowerMwh)}–${synthNumber(p.upperMwh)} MWh</dd></div>
      <div><dt>Constraint / curtailment</dt><dd>${synthNumber(p.constraintMwh)} / ${synthNumber(p.curtailmentMwh)} MWh</dd></div>
      <div><dt>Synthetic issue → target</dt><dd>${escapeHtml(synthUtc(p.issuedAt))} → ${escapeHtml(synthUtc(p.targetAt))}</dd></div>
    </dl>
    <table class="synth-inputs"><caption>Generated inputs</caption><thead><tr><th scope="col">Signal</th><th scope="col">48 history rows (${escapeHtml(synthUtc(inputs.historyFrom, true))} – ${escapeHtml(synthUtc(inputs.historyTo))})</th><th scope="col">Current</th></tr></thead><tbody>${rows}</tbody></table>
    <h3 class="synth-notes-title">Limits of this demonstration</h3>
    <ul class="synth-notes"><li>${escapeHtml(r.purpose)}</li><li>${escapeHtml(r.plausibilityLimit)}</li>${r.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}${r.inputNotice ? `<li>Model: ${escapeHtml(r.inputNotice)}</li>` : ''}<li>Schema checked against the API’s own OpenAPI document${r.apiVersion ? ` (API ${escapeHtml(r.apiVersion)})` : ''}; model ${escapeHtml(r.modelVersion || '—')}.</li><li>Not saved, not charted and not used by the dashboard, Volt or any other page.</li></ul>
    <details class="synth-json"><summary>Generated request JSON (${inputs.historyRows} history rows)</summary><pre>${escapeHtml(JSON.stringify(r.request, null, 1))}</pre></details>
  </section>`;
}

// Updates only the status, error and result regions; the form and its focus are left alone.
function synthUpdate(error = '') {
  const dialog = synthDialog();
  dialog.dataset.theme = typeof dashboardTheme === 'string' ? dashboardTheme : 'light';
  const button = dialog.querySelector('[data-synth-generate]');
  button.setAttribute('aria-disabled', String(synth.loading)); // not `disabled`: that would drop focus
  button.classList.toggle('is-busy', synth.loading);
  const status = dialog.querySelector('#synth-status');
  const p = synth.result?.prediction;
  status.textContent = synth.loading ? 'Generating a synthetic scenario and asking the model…'
    : p ? `Synthetic result ready: ${synthNumber(p.atRiskMwh)} MWh predicted dispatch-down at +${p.horizonMinutes} minutes. ${SYNTH_LABEL}` : '';
  const alert = dialog.querySelector('#synth-error');
  alert.hidden = !error;
  alert.textContent = error;
  const region = dialog.querySelector('#synth-result');
  region.classList.toggle('is-loading', synth.loading);
  if (!synth.loading) {
    const jsonOpen = region.querySelector('.synth-json')?.open;
    region.innerHTML = synth.result ? synthResultHtml(synth.result) : '';
    if (jsonOpen) region.querySelector('.synth-json')?.setAttribute('open', '');
  }
}

async function synthGenerate() {
  const token = ++synth.token; // a newer choice replaces any pending one
  synth.loading = true; synthUpdate();
  let error = '';
  try {
    const response = await fetch('/api/v1/synthetic-v1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ horizon: synth.horizon, scenario: synth.scenario, issueTime: synth.issueTime, capacityMw: modelState.capacity }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'The synthetic scenario could not be generated.');
    if (!body.synthetic || body.label !== SYNTH_LABEL) throw new Error('The server did not label this result as synthetic.');
    if (token === synth.token) synth.result = body;
  } catch (failure) {
    error = failure.message;
  }
  if (token === synth.token) { synth.loading = false; synthUpdate(error); }
}

function synthOpen(trigger) {
  const dialog = synthDialog();
  synth.returnFocus = trigger;
  synth.open = true;
  synthUpdate();
  dialog.showModal();
  dialog.querySelector('#synth-title').focus(); // a stable heading, announced with the dialog
  if (!synth.result && !synth.loading) synthGenerate();
}
function synthClose() {
  const dialog = synthDialog();
  if (dialog.open) dialog.close();
  if (!synth.open) return;
  synth.open = false;
  synth.token++; synth.loading = false; synth.result = null; // nothing is kept
  synthUpdate();
  synth.returnFocus?.focus?.();
}

document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-synth-open]');
  if (opener) synthOpen(opener);
});
