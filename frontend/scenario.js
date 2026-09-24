function scenarioOutcome(p = selectedPrediction()) {
    return modelState.data.scenario.outcomes.find(
        (o) => o.horizonMinutes === p.horizonMinutes,
    );
}
function scenarioRecovery(p) {
    return scenarioOutcome(p).potentialRecoveryMwh;
}
function scenarioPercent(value) {
    return value === null ? "N/A" : modelNumber(value * 100) + "%";
}
function scenarioProvenance() {
    const d = modelState.data;
    return `<p class="model-provenance">${isDemoData() ? "Simulated demo scenario" : "Projected scenario"} · ${isDemoData() ? "example" : "historical forecast"} issued ${escapeHtml(modelTime(d.predictions[0].issuedAt, true))} · ${escapeHtml(settings.timezone)} · model ${escapeHtml(d.modelVersion)} · scenario ${escapeHtml(d.scenario.id)}. User-entered assumptions; no measured charging.</p>`;
}
function chargingInputs() {
    return `<form id="charging-scenario-form" class="card scenario-inputs"><div><h2 class="card-title">Charging assumptions</h2><p class="metric-caption">Example defaults; edit for your scenario</p></div><label>Total demand (kWh)<input id="scenario-total" type="number" min="0" max="1000000000" step="any" required value="${modelState.totalDemandKwh}"></label><label>Flexible demand (kWh)<input id="scenario-flexible" type="number" min="0" max="1000000000" step="any" required value="${modelState.flexibleDemandKwh}"></label><button class="secondary-button" ${modelState.loading ? "disabled" : ""}>Apply scenario</button><p id="scenario-validation" role="alert"></p></form>`;
}
function scenarioComparison(impact) {
    const s = modelState.data.scenario;
    return `<section class="card scenario-comparison"><h2 class="card-title">${impact ? "Projected impact by alternative" : "Compare charging opportunities"}</h2><p class="card-subtitle">Same demand, evaluated separately at each target. Values are not added together.</p><table><thead><tr><th>Forecast target</th><th>At risk</th><th>Potential recovery</th><th>${impact ? "Remaining at risk" : "Proposed load"}</th></tr></thead><tbody>${s.outcomes.map((o) => `<tr class="${o.horizonMinutes === modelState.horizon ? "selected-outcome" : ""}"><td>${escapeHtml(modelTime(o.targetAt))} (+${o.horizonMinutes} min)${s.recommendedHorizonMinutes === o.horizonMinutes ? '<span class="scenario-best">Recommended</span>' : ""}</td><td>${modelNumber(o.atRiskMwh)} MWh</td><td class="green">${modelNumber(o.potentialRecoveryMwh)} MWh</td><td>${modelNumber(impact ? o.remainingWasteMwh : o.proposedPowerMw)} ${impact ? "MWh" : "MW"}</td></tr>`).join("")}</tbody></table><p class="metric-caption">Power limit: ${modelNumber(modelState.data.flexibleCapacityMw)} MW. Each result covers one half-hour.</p></section>`;
}
function scenarioView(page) {
    const top =
        modelHeader(page) +
        modelControls() +
        (page === "charging" ? chargingInputs() : "");
    if (modelState.loading)
        return (
            top +
            '<section class="card model-message" role="status">Calculating the shared scenario…</section>'
        );
    if (modelState.error)
        return (
            top +
            `<section class="card model-message" role="alert"><h2>Scenario unavailable</h2><p>${escapeHtml(modelState.error)}</p><button class="primary-button" id="model-retry">Try again</button></section>`
        );
    const s = modelState.data.scenario,
        o = scenarioOutcome(),
        impact = page === "impact";
    const summary = impact
        ? modelCell(
              "Energy at risk",
              modelNumber(o.atRiskMwh) + " MWh",
              isDemoData() ? "Simulated example" : "Model prediction",
              "red",
          ) +
          modelCell(
              "Potential recovery",
              modelNumber(o.potentialRecoveryMwh) + " MWh",
              "Scenario estimate",
              "green",
          ) +
          modelCell(
              "Remaining at risk",
              modelNumber(o.remainingWasteMwh) + " MWh",
          ) +
          modelCell("Recovery rate", scenarioPercent(o.recoveryRate))
        : modelCell(
              "Total demand",
              modelNumber(s.totalDemandMwh) + " MWh",
              "Scenario input",
          ) +
          modelCell(
              "Flexible demand",
              modelNumber(s.flexibleDemandMwh) + " MWh",
              "Scenario input",
          ) +
          modelCell(
              "Potential absorption",
              modelNumber(o.potentialRecoveryMwh) + " MWh",
              "Demand, power and forecast limited",
              "green",
          ) +
          modelCell(
              "Proposed power",
              modelNumber(o.proposedPowerMw) + " MW",
              o.powerLimitRespected
                  ? "Within scenario power limit"
                  : "Exceeds power limit",
          );
    const best = s.recommendedHorizonMinutes;
    const details = impact
        ? `<h2 class="card-title">Where the energy goes</h2><div class="scenario-energy-bar" style="background:${o.atRiskMwh === 0 ? "#e3eaf0" : "#ed4249"}" role="img" aria-label="${modelNumber(o.potentialRecoveryMwh)} MWh potential recovery and ${modelNumber(o.remainingWasteMwh)} MWh remaining at risk"><span style="width:${(o.recoveryRate || 0) * 100}%"></span></div>${legend(
              [
                  ["green", "Potential recovery"],
                  ["red", "Remaining at risk"],
              ],
          )}<p>${scenarioPercent(o.cleanChargingShare)} of total charging demand could use this surplus.</p><p>${modelNumber(o.remainingDemandMwh)} MWh of charging demand remains to be scheduled elsewhere.</p><button class="secondary-button" data-page="charging">Edit charging assumptions</button>`
        : `<h2 class="card-title">Suggested opportunity</h2><p>${best === null ? "No recoverable surplus for these assumptions." : `The +${best}-minute forecast offers the greatest recovery (${best === modelState.horizon ? "currently selected" : "select it to review"}). Equal recovery favours the earlier target.`}</p>${best !== null && best !== modelState.horizon ? `<button class="secondary-button" id="scenario-use-best">Use recommended horizon</button>` : ""}<p>Selected target: ${escapeHtml(modelTime(o.targetAt, true))}.</p><p>${modelNumber(o.remainingFlexibleMwh)} MWh of flexible demand remains outside this opportunity.</p><button class="secondary-button" data-page="impact">View projected impact</button>`;
    return (
        top +
        `<section class="card summary-card model-summary scenario-summary"><h2 class="card-title">Selected ${modelState.horizon}-minute scenario</h2><div class="summary-metrics">${summary}</div></section>` +
        scenarioProvenance() +
        `<div class="scenario-grid">${scenarioComparison(impact)}<section class="card scenario-details">${details}</section></div><section class="card scenario-method"><h2 class="card-title">Assumptions and limits</h2><p>${escapeHtml(s.methodology[0])}</p><p>Flexible demand is assumed available at either target, with no charging losses. Vehicle counts, commitments, missed targets, money and emissions savings are not evaluated.</p></section>`
    );
}
document.addEventListener("submit", (event) => {
    if (event.target.id !== "charging-scenario-form") return;
    event.preventDefault();
    const total = Number(document.getElementById("scenario-total").value),
        flexible = Number(document.getElementById("scenario-flexible").value);
    if (
        !Number.isFinite(total) ||
        !Number.isFinite(flexible) ||
        total < 0 ||
        flexible < 0 ||
        flexible > total
    ) {
        document.getElementById("scenario-validation").textContent =
            "Flexible demand must be between zero and total demand.";
        return;
    }
    modelState.totalDemandKwh = total;
    modelState.flexibleDemandKwh = flexible;
    loadModelForecast();
});
document.addEventListener("click", (event) => {
    if (event.target.closest("#scenario-use-best")) {
        modelState.horizon = modelState.data.scenario.recommendedHorizonMinutes;
        render();
    }
});
