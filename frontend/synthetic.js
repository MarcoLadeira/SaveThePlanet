// Synthetic V1 scenarios. The server varies the model's own example raw-input request
// and sends it to /predict/v1/from-raw. Results live only in this panel: they are never
// stored, charted, fed to Volt or merged into the shared historical forecast.
const SYNTH_LABEL = 'Synthetic scenario — not a forecast of today’s actual grid conditions.';
const synth = { open: false, scenario: 'ordinary', horizon: 30, loading: false, error: '', result: null, token: 0, returnFocus: null };
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
function synthRoot() {
  let root = document.getElementById('synthetic-root');
  if (!root) { root = document.createElement('div'); root.id = 'synthetic-root'; document.body.appendChild(root); }
  return root;
}
function synthNumber(value, digits = 1) {
  return new Intl.NumberFormat('en-IE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
function synthUtc(stamp, withDate = false) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', ...(withDate ? { day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(stamp)) + ' UTC';
}
function synthLabel(extra = '') { return `<p class="synth-label ${extra}" role="note"><b>Synthetic</b>${SYNTH_LABEL}</p>`; }
function synthSegment(name, options, value) {
  return `<div class="synth-segment" role="group" aria-label="${name}">${options.map(([key, text]) => `<button type="button" data-synth-${name}="${key}" class="${String(value) === String(key) ? 'active' : ''}" aria-pressed="${String(value) === String(key)}">${text}</button>`).join('')}</div>`;
}

function synthResult() {
  const r = synth.result;
  if (!r) return synth.loading ? '<div class="synth-empty"><span class="studio-spinner"></span>Generating a synthetic scenario and asking the model…</div>' : '';
  const p = r.prediction, inputs = r.inputs;
  const rows = synthSignals.map(([key, name, unit, digits]) => {
    const [low, high] = inputs.historyRanges[key];
    return `<tr><th>${name}</th><td>${synthNumber(low, digits)}–${synthNumber(high, digits)} <small>${unit}</small></td><td>${synthNumber(inputs.current[key], digits)} <small>${unit}</small></td></tr>`;
  }).join('');
  return `<section class="synth-result ${synth.loading ? 'is-loading' : ''}" aria-live="polite">
    <div class="synth-result-head">
      <div class="synth-figure"><span>${escapeHtml(r.scenarioLabel)} · +${p.horizonMinutes} min</span><strong>${synthNumber(p.atRiskMwh)}<small> MWh</small></strong><em>predicted dispatch-down for ${escapeHtml(synthUtc(p.targetAt, true))}</em></div>
      ${synthLabel('is-beside')}
    </div>
    <div class="synth-metrics">
      <div><span>Event probability</span><b>${synthNumber(p.probability * 100)}%</b></div>
      <div><span>Risk</span><b class="synth-risk is-${escapeHtml(p.risk)}">${escapeHtml(p.risk)}</b></div>
      <div><span>P10–P90</span><b>${synthNumber(p.lowerMwh)}–${synthNumber(p.upperMwh)} MWh</b></div>
      <div><span>Constraint / curtailment</span><b>${synthNumber(p.constraintMwh)} / ${synthNumber(p.curtailmentMwh)} MWh</b></div>
      <div><span>Synthetic issue → target</span><b>${escapeHtml(synthUtc(p.issuedAt))} → ${escapeHtml(synthUtc(p.targetAt))}</b></div>
    </div>
    <h3>Generated inputs</h3>
    <table class="synth-inputs"><thead><tr><th>Signal</th><th>48 history rows (${escapeHtml(synthUtc(inputs.historyFrom, true))} – ${escapeHtml(synthUtc(inputs.historyTo))})</th><th>Current</th></tr></thead><tbody>${rows}</tbody></table>
    <ul class="synth-notes">${r.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}${r.inputNotice ? `<li>Model: ${escapeHtml(r.inputNotice)}</li>` : ''}<li>Not saved, not charted and not used by the dashboard, Volt or any other page.</li></ul>
    <details class="synth-json"><summary>Generated request JSON (${inputs.historyRows} history rows)</summary><pre>${escapeHtml(JSON.stringify(r.request, null, 1))}</pre></details>
  </section>`;
}

function synthRender() {
  const root = synthRoot();
  root.dataset.theme = typeof dashboardTheme === 'string' ? dashboardTheme : 'light';
  if (!synth.open) { root.innerHTML = ''; return; }
  const jsonOpen = root.querySelector('.synth-json')?.open;
  root.innerHTML = `<div class="synth-backdrop" data-synth-close></div>
  <div class="synth-dialog" role="dialog" aria-modal="true" aria-labelledby="synth-title" tabindex="-1">
    <header class="synth-head"><div><h2 id="synth-title">Synthetic V1 scenario</h2><p>The model’s own example raw-input request, randomly varied on every click and sent to <code>/predict/v1/from-raw</code>.</p></div><button type="button" class="synth-close" data-synth-close aria-label="Close">×</button></header>
    ${synthLabel('is-banner')}
    <div class="synth-controls">
      <label>Scenario ${synthSegment('scenario', [['ordinary', 'Ordinary'], ['high-curtailment', 'High curtailment']], synth.scenario)}</label>
      <label>Horizon ${synthSegment('horizon', [[30, '+30 min'], [60, '+60 min']], synth.horizon)}</label>
      <button type="button" class="studio-button synth-generate" data-synth-generate ${synth.loading ? 'disabled' : ''}>${synth.loading ? 'Generating…' : 'Generate new scenario'} ${icon('arrow', 17)}</button>
    </div>
    ${synth.error ? `<p class="synth-error" role="alert">${escapeHtml(synth.error)}</p>` : ''}
    ${synthResult()}
  </div>`;
  if (jsonOpen) root.querySelector('.synth-json')?.setAttribute('open', '');
}

async function synthGenerate() {
  const token = ++synth.token;
  synth.loading = true; synth.error = ''; synthRender();
  try {
    const response = await fetch('/api/v1/synthetic-v1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ horizon: synth.horizon, scenario: synth.scenario, capacityMw: modelState.capacity }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'The synthetic scenario could not be generated.');
    if (!body.synthetic || body.label !== SYNTH_LABEL) throw new Error('The server did not label this result as synthetic.');
    if (token === synth.token) synth.result = body;
  } catch (error) {
    if (token === synth.token) synth.error = error.message;
  }
  if (token === synth.token) { synth.loading = false; synthRender(); }
}

function synthOpen(trigger) {
  synth.open = true; synth.returnFocus = trigger; synthRender();
  document.querySelector('.synth-dialog')?.focus();
  if (!synth.result && !synth.loading) synthGenerate();
}
function synthClose() {
  synth.open = false; synth.result = null; synth.error = ''; synth.token++; synth.loading = false; // nothing is kept
  synthRender();
  synth.returnFocus?.focus?.();
}

document.addEventListener('click', (event) => {
  const t = event.target;
  const opener = t.closest('[data-synth-open]');
  if (opener) { synthOpen(opener); return; }
  if (!synth.open || !t.closest('#synthetic-root')) return;
  if (t.closest('[data-synth-close]')) { synthClose(); return; }
  let el;
  if ((el = t.closest('[data-synth-scenario]'))) { synth.scenario = el.dataset.synthScenario; synthGenerate(); return; }
  if ((el = t.closest('[data-synth-horizon]'))) { synth.horizon = Number(el.dataset.synthHorizon); synthGenerate(); return; }
  if (t.closest('[data-synth-generate]')) synthGenerate();
});
document.addEventListener('keydown', (event) => { if (synth.open && event.key === 'Escape') synthClose(); });
