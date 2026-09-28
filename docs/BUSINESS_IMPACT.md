# Business and environmental impact (Impact page)

The Impact page (`#business`, labelled **Impact** in the navigation after EV) answers one question for a
fleet operator: *what could smarter EV charging save?* It shows four headline figures, where the money
comes from, whether the AI beats a simple rule, a what-if calculator and the investment case.

Code: [`backend/business.py`](../backend/business.py) (simulation, money, CO2, annual projection, calculator),
routes in [`backend/server.py`](../backend/server.py), page in [`frontend/business.js`](../frontend/business.js)
and [`frontend/business.css`](../frontend/business.css).
Tests: [`backend/tests/test_business.py`](../backend/tests/test_business.py),
[`frontend/tests/business.test.js`](../frontend/tests/business.test.js).

Everything on the page is a **simulation on historical data with illustrative prices**. Nothing is a
measured saving, and the page says so in its header chip, card footnotes and footer.

## Where the numbers come from

| Step | Source | Status |
|---|---|---|
| Surplus renewable energy forecast | Carlson's GridToEv V1 model: the **+30 minute** forecast of each half-hour, replayed from its historical dataset (`explorer.short_term_day`) | historical prediction |
| What actually happened | Observed EirGrid curtailment for the same half-hours (`/actuals/v1/window`) | historical observation |
| How often surplus happens over a year | GridToEv's daily curtailment dataset: observed curtailment days over the latest 365 days | historical observation |
| Fleet, chargers, site limit | Simulated depot (below) | simulated |
| Charging plan | Three rule sets in `business.plan_night` (below) | simulation |
| Prices, software and setup costs | Example values (below) | illustrative |
| CO2 | Flat grid average, `scenario.GRID_INTENSITY_T_PER_MWH` (0.25 t/MWh), the same factor the Battery page uses | estimated |

Jerry's energy-bridge optimiser (issue #50, PRs #52 and #54) is not merged yet, so this page does not
use it. `business.py` keeps the same physical rules (whole plugged-in half-hours, charger count, site
power limit, 90% charging efficiency with the loss counted, never overfilling a van) and is written so
its AI strategy can be replaced by the bridge's allocation once that lands.

## Evaluation period

The latest run of consecutive dataset days (up to 8, giving 7 nights) whose half-hours mostly (90%+) have
a +30 minute forecast. It is chosen **by position in the dataset only**, never by how much surplus the
days had, so it is not a cherry-picked windy week. Days that fail to load are left out and listed in
`coverage.failedDays`; a night needs both of its days.

A night runs from 12:00 UTC to 12:00 the next day (48 half-hours). Everything is UTC, which is Irish
time in winter.

## The simulated depot (`FLEET`, `example-depot/v1`)

20 vans plug in between 17:00 and 19:30 and leave between 06:00 and 07:30. Each needs 28-45 kWh in its
battery per night (a fixed pattern, so every strategy and every run sees exactly the same fleet).
20 chargers of 11 kW, a 180 kW site limit and 90% charging efficiency: the grid supplies battery
energy / 0.9, and the difference is reported as `lossKwh`.

## Three strategies on identical conditions

| Strategy | Rule |
|---|---|
| **Normal charging** | Charge at full power as soon as a van plugs in. |
| **Basic smart charging** | Wait for the cheapest tariff hours, then charge; start earlier only when a van would otherwise miss its departure. No forecast. |
| **Our AI charging** | Uses the GridToEv +30 minute forecast. In a half-hour where the forecast curtailment covers the site's whole draw and the discounted price beats every later price, charge at full power. Otherwise wait inside the cheap hours while keeping a 25% capacity reserve, so every van still finishes; outside them it follows the basic rule's guard. |

When the site limit binds, energy goes first to what each van *must* take to finish on time, then to
what it would like, earliest departure first. Plans that leave a van short are reported
(`requirements.met`, `unmetKwh`), never hidden.

**No look-ahead.** Each decision for a half-hour is made 30 minutes before it starts and can only read
forecasts issued by then (`ForecastView.get(target, now)` returns nothing issued later). Observed
outcomes never reach `plan_night`; they are used afterwards, by `score_night`, to work out cost, CO2 and
surplus. Tests check that late-issued forecasts are invisible, that changing later forecasts never
changes earlier decisions, and that changing the observations never changes a plan.

The +30 and +60 minute forecasts of one half-hour are two estimates of the same thing: only +30 is used
and they are never added.

## Money

Illustrative business time-of-use tariff (`TARIFF`, `example-business-tou/v1`, UTC):
night 23:00-08:00 **EUR 0.16/kWh**, peak 17:00-19:00 **EUR 0.34/kWh**, day otherwise **EUR 0.26/kWh**, and a
**EUR 0.08/kWh surplus discount** on energy used while renewable output is being curtailed (standing for a
dynamic tariff or flexibility payment). Not a supplier quote.

Per night and strategy: `cost = Σ grid kWh × price − surplus kWh × discount`.

## Surplus renewable energy and CO2

A forecast is not recovered energy. A half-hour's charging counts as **surplus renewable energy** only
where *observed* curtailment coincided with it, capped by the charging itself:
`surplus = min(grid kWh, observed curtailment kWh)`. Only curtailment (system-wide) is counted;
location-specific constraint energy is never claimed, and whether a real site could absorb curtailed
energy (network deliverability) is **not verified**. Half-hours without an observation are paid for but
never credited (`unscoredKwh`).

`CO2 = (grid kWh − surplus kWh) × 0.25 kg/kWh`, treating surplus energy as renewable output that would
otherwise have been switched off. The **estimated CO2 reduction** compares normal charging with our AI
charging on the same vans and nights. It can be negative, for example when evening surplus meets
normal charging and the cheaper plan waits for the night; the page then says so.

## A year, not one week

`annual = average night × operating days (260)`. The part that depends on surplus energy (the discount
and the surplus kWh) is scaled by a **seasonal factor**:
`share of days with curtailment over the latest 365 observed days ÷ the same share over the evaluation days`.
A windy winter week is therefore not taken as a typical week. If the daily dataset is unavailable, or the
evaluation days had no curtailment days, no factor is applied and the page says "not adjusted for the
season".

**Scenarios.** Two extremes are computed as well: *no surplus at all* (factor 0) and *every week as good
as the evaluation week* (factor ≥ 1). **Conservative** and **optimistic** are the lower and higher of the
two by net savings, and each carries its `basis`, because surplus does not always favour the AI.

## Financials, waterfall and KPIs

All in whole euros, derived from the same rounded parts so every view agrees to the euro:

```
baseline = normal charging cost             (waterfall step 1, comparison "Normal charging")
timing   = normal − basic                   ("Smarter timing")
ai       = basic − AI                       ("AI forecast"; KPI "Additional AI savings")
running  = yearly software cost             ("Software costs", example EUR 2,400)
final    = baseline − timing − ai + running ("With our AI")
net      = baseline − final                 (KPI "Projected annual savings")
payback  = implementation ÷ net × 12        (KPI "Investment payback"; "not achieved" when net ≤ 0)
ROI      = 5 × net − implementation         (5-year net return; example implementation EUR 15,000)
```

Multi-site scaling multiplies one site's figures; each site still needs its own charger and grid check.

## What-if calculator

`yearly savings = EVs × grid kWh per EV per day × share shifted × price difference × operating days`,
minus the optional yearly cost, with payback from the optional one-off cost. Grid kWh per EV per day
(40.6) comes from the simulated depot. The defaults reproduce the depot (the price difference is derived
from the simulation), so the calculator starts where the page does.

It is **illustrative**: charger and site limits are not checked, so savings grow in proportion to the
number of EVs. Every input changes the result (tested). Inputs are validated in the browser for
feedback and again on the server, which is authoritative.

## API

### `GET /api/v1/business/impact[?refresh=1]`

The first request starts the calculation in the background (the server also starts it at launch, at
prefetch priority, through the shared replay gate). While it runs:

```
HTTP 202  {"version": "business-impact/v1", "status": "preparing",
           "progress": {"done": 3, "total": 9, "stage": "Replaying historical forecasts"}}
```

Then `HTTP 200` with the result below, cached for the life of the server (the dataset is fixed).
`refresh=1` retries after a failure or a simulated fallback; a real result is kept. An unexpected error
is `HTTP 500 {"error": {"code": "IMPACT_FAILED", ...}}`. If GridToEv is unreachable the result is a
**labelled simulated example** (`dataMode: "simulated"`, `fallback.active: true`, fixed example weather);
if the dataset has no usable nights it is `{"status": "empty", "message": ...}`.

Top-level fields of a ready result:

| Field | Meaning |
|---|---|
| `version`, `status`, `scenarioId`, `generatedAt` | Contract version, `ready`, a hash of every input (fleet, tariff, costs, days, model, nights) |
| `dataMode`, `source`, `modelVersion`, `fallback` | `historical-replay` or `simulated`; the upstream model version; why a fallback was used |
| `provenance` | `forecasts`, `outcomes`, `fleet`, `prices`, `costs`, `emissions`: what each input is |
| `coverage` | Plugged-in half-hours, missing forecasts and observations (counted, never filled in), failed days |
| `company` | The simulated depot (`FLEET`) plus `kwhPerEvDay` |
| `period` | `from`, `to`, `nights`, `nightDates`, `operatingDays`, and how the period was selected |
| `tariff`, `costs` | The illustrative assumptions used |
| `kpis` | `annualSavingsEur`, `co2ReductionT`, `aiSavingsEur`, `paybackMonths`, `paybackStatus` |
| `financials` | Everything in the equations above, plus `roiYears`, `roiNetEur`, `roiPct` |
| `waterfall` | Five steps `{id, label, kind: total or delta, valueEur}` |
| `strategies[]` | Per strategy: `annual` (`costEur`, `co2T`, `surplusKwh`, `gridKwh`, `renewableShare`), `period` (evaluation-week totals incl. `batteryKwh`, `lossKwh`, `peakKw`, `unscoredKwh`) and `requirements` (`met`, `total`, `unmetKwh`, `allMet`) |
| `forecastCalls` | Half-hours the AI saw a surplus forecast: `right`, `falseAlarms`, `missed`, `unknown`, `noForecast` |
| `nights[]` | Per night and strategy: cost, surplus kWh, vans on time |
| `seasonal` | The factor, both event rates, the year's dates, or why it is unavailable |
| `scenarios` | `conservative`, `expected`, `optimistic`, each with its `basis` and surplus factor |
| `scaling[]` | 1, 5, 10 and 25 sites |
| `calculator` | `kwhPerEvDay` and the default inputs |
| `emissions`, `methodology`, `limitations` | Method statements shown in the page's tooltips |

Example strategy (historical replay against a local mock of GridToEv, not hosted data):

```json
{"id": "ai", "label": "Our AI charging",
 "annual": {"costEur": 25185, "co2T": 26.02, "surplusKwh": 106636, "gridKwh": 210724, "renewableShare": 0.506},
 "period": {"nights": 7, "gridKwh": 5673.3, "batteryKwh": 5106.0, "lossKwh": 567.3, "costEur": 648.53,
            "absorbedKwh": 3240.0, "co2Kg": 608.3, "unscoredKwh": 0.0, "peakKw": 180.0},
 "requirements": {"met": 140, "total": 140, "unmetKwh": 0.0, "allMet": true}}
```

### `GET /api/v1/business/estimate?evs=&shiftablePct=&priceDiffEurPerKwh=&operatingDays=[&implementationEur=&annualEur=]`

| Input | Range |
|---|---|
| `evs` | whole number, 1-10,000 |
| `shiftablePct` | 0-100 (% of daily charging) |
| `priceDiffEurPerKwh` | 0-1 |
| `operatingDays` | whole number, 1-366 |
| `implementationEur`, `annualEur` (optional) | 0-10,000,000 and 0-1,000,000 |

`200 {"illustrative": true, "kwhPerEvDay", "shiftedKwhPerYear", "grossSavingsEur", "annualCostsEur", "yearlySavingsEur", "implementationEur", "paybackMonths", "paybackStatus": "months" | "not-achieved" | "no-investment", "effects", "note"}`,
or `400 {"error": {"code": "INVALID_REQUEST", "fields": {"evs": "Number of EVs must be between 1 and 10,000."}}}`.

The page only lets the newest request update the screen, for both routes.

## Limitations

- A simulation on historical data: the fleet, tariff and costs are examples, not a customer or a quote.
- Forecasts are historical replays, not live predictions. Re-run against the hosted GridToEv service
  before quoting figures; the figures in PR screenshots come from a local mock of its API.
- Network deliverability of curtailed energy to a real site is not verified.
- Emissions use a flat grid average, not a marginal emission factor per half-hour.
- The AI strategy is a transparent rule set on one forecast horizon, not a proven optimum; it can do no
  better than the basic rule when surplus lasts all night, and worse when the forecast misses surplus.
- The calculator does not check charger or site limits.
