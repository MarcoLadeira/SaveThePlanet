// Charging page: turns the shared backend scenario into one recommended EV charging action.
// Every figure comes from /api/v1/scenario so Charging and Impact always agree.
function evCount(value) {
    if (value === 0) return '0';
    return value < 1 ? '<1' : n(Math.round(value));
}
function chargingWindowText(window) {
    return `${escapeHtml(modelTime(window.startAt, true))}–${escapeHtml(modelTime(window.endAt))}`;
}
function chargingAction() {
    const s = modelState.data.scenario, ev = s.evAssumptions, w = s.recommendedWindow;
    const demo = isDemoData() ? '<span class="charging-demo-tag">Example data</span>' : '';
    if (!w) {
        const reason = s.flexibleDemandMwh === 0
            ? 'There is no flexible charging demand in this scenario. Add flexible demand to see an action.'
            : 'The model predicts no renewable energy at risk for either target, so there is nothing to recover.';
        return `<section class="dash-card charging-action is-empty" aria-label="Recommended action"><span class="dash-tile is-amber">${icon('clock', 22)}</span><div class="charging-action-copy"><p>Recommended action ${demo}</p><h2>No charging shift recommended</h2><span>${reason}</span></div></section>`;
    }
    const o = s.outcomes.find((item) => item.horizonMinutes === w.horizonMinutes);
    const selected = modelState.horizon === w.horizonMinutes;
    const control = selected
        ? `<span class="charging-action-state">${icon('check', 16)} Showing this target</span>`
        : `<button class="studio-button" type="button" data-horizon="${w.horizonMinutes}">View +${w.horizonMinutes} min target ${icon('arrow', 17)}</button>`;
    return `<section class="dash-card charging-action" aria-label="Recommended action"><span class="dash-tile is-green">${icon('bolt', 22)}</span><div class="charging-action-copy"><p>Recommended action ${demo}</p><h2>Charge EVs ${chargingWindowText(w)}</h2><span>Up to <b>${n(o.potentialRecoveryMwh)} MWh</b> of renewable energy predicted to be lost could charge about <b>${evCount(o.evChargesEquivalent)} EVs</b> (${n(ev.kwhPerCharge)} kWh each), using <b>${n(o.chargersNeeded)} chargers</b> at ${n(ev.chargerKw)} kW (${n(o.proposedPowerMw)} MW in total).</span></div>${control}</section>`;
}
function chargingForm() {
    const s = modelState.data.scenario;
    const field = (id, label, unit, value, min, max, hint) => `<div class="charging-field"><label for="${id}">${label} <span>${unit}</span></label><input id="${id}" type="number" min="${min}" max="${max}" step="any" required value="${value}"><small>${hint}</small></div>`;
    return `<form id="charging-scenario-form" class="studio-form charging-form" novalidate>
        <fieldset><legend>Charging demand</legend>
            ${field('scenario-total', 'Total demand', 'kWh', modelState.totalDemandKwh, 0, 1e9, `= ${n(s.totalDemandMwh)} MWh`)}
            ${field('scenario-flexible', 'Flexible demand', 'kWh', modelState.flexibleDemandKwh, 0, 1e9, `= ${n(s.flexibleDemandMwh)} MWh that can move in time`)}
        </fieldset>
        <fieldset><legend>EV assumptions</legend>
            ${field('scenario-kwh-per-charge', 'Energy per charge', 'kWh', modelState.kwhPerCharge, 1, 200, 'Typical top-up: 30 kWh')}
            ${field('scenario-charger-kw', 'Charger power', 'kW', modelState.chargerKw, 1, 400, 'Home 7 kW · public 22 kW')}
        </fieldset>
        <p id="scenario-validation" role="alert"></p>
        <button class="studio-button" type="submit">Apply scenario ${icon('arrow', 17)}</button>
    </form>`;
}
function chargingMethod() {
    const s = modelState.data.scenario, remaining = scenarioOutcome(selectedPrediction()).remainingDemandMwh;
    return `<details class="charging-method"><summary>How this is calculated</summary><ul>${s.methodology.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul><p>Units: kWh and MWh are energy (1 MWh = 1,000 kWh); kW and MW are charging power (1 MW = 1,000 kW). ${n(remaining)} MWh of demand remains to be scheduled outside this window.</p></details>`;
}
function renderCharging() {
    return studioShell('Charging', 'Turn predicted renewable surplus into an EV charging action.', () => {
        const p = selectedPrediction(), o = scenarioOutcome(p), ev = modelState.data.scenario.evAssumptions;
        return `${studioControls()}${chargingAction()}${statStrip([
            metric('Potential absorption', n(o.potentialRecoveryMwh), 'MWh', `Selected target +${p.horizonMinutes} min`, 'green'),
            metric('EV charges', `≈ ${evCount(o.evChargesEquivalent)}`, '', `At ${n(ev.kwhPerCharge)} kWh each`),
            metric('Chargers needed', n(o.chargersNeeded), '', `At ${n(ev.chargerKw)} kW for ${n(modelState.data.intervalMinutes)} minutes`),
            metric('Proposed power', n(o.proposedPowerMw), 'MW', o.powerLimitRespected ? `Within ${n(modelState.data.flexibleCapacityMw)} MW limit` : 'Above capacity limit', o.powerLimitRespected ? '' : 'amber'),
        ])}<div class="studio-page-grid"><section class="dash-card studio-chart-card">${cardHead('orange', 'Charging opportunity', 'Separate +30 and +60 minute alternatives')}${comparisonChart('charging')}</section><section class="dash-card studio-side-card">${cardHead('green', 'Charging assumptions', 'Shared by Charging and Impact')}${chargingForm()}${chargingMethod()}</section></div>${provenance()}`;
    });
}
function chargingFieldError(total, flexible, kwh, kw) {
    const bad = (value, min, max) => !Number.isFinite(value) || value < min || value > max;
    if (bad(total, 0, 1e9)) return ['scenario-total', 'Total demand must be between 0 and 1,000,000,000 kWh.'];
    if (bad(flexible, 0, 1e9)) return ['scenario-flexible', 'Flexible demand must be between 0 and 1,000,000,000 kWh.'];
    if (flexible > total) return ['scenario-flexible', 'Flexible demand cannot be larger than total demand.'];
    if (bad(kwh, 1, 200)) return ['scenario-kwh-per-charge', 'Energy per charge must be between 1 and 200 kWh.'];
    if (bad(kw, 1, 400)) return ['scenario-charger-kw', 'Charger power must be between 1 and 400 kW.'];
    return null;
}
document.addEventListener('submit', (event) => {
    if (event.target.id !== 'charging-scenario-form') return;
    event.preventDefault();
    const value = (id) => {
        const raw = document.getElementById(id).value;
        return raw.trim() === '' ? NaN : Number(raw);
    };
    const total = value('scenario-total'), flexible = value('scenario-flexible');
    const kwh = value('scenario-kwh-per-charge'), kw = value('scenario-charger-kw');
    event.target.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
    const error = chargingFieldError(total, flexible, kwh, kw);
    if (error) {
        const input = document.getElementById(error[0]);
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        document.getElementById('scenario-validation').textContent = error[1];
        return;
    }
    Object.assign(modelState, { totalDemandKwh: total, flexibleDemandKwh: flexible, kwhPerCharge: kwh, chargerKw: kw });
    loadModelForecast();
});
