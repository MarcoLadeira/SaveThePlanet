# Business and environmental impact (Impact page)

The Impact page (`#business`, labelled **Impact** in the navigation after EV) answers one question for a
charging business: *who saves and who earns when our AI finds cheaper energy?* Its headline figures,
"where the € goes", the two profit bridges, the what-if calculator and the energy proof are the
discount-window business case ([below](#discount-windows-who-saves-who-earns-issue-56)); the depot's
waterfall, the normal / basic smart / AI comparison and the depot investment details follow the method
described first.

Code: [`backend/business.py`](../backend/business.py) (simulation, money, CO2, annual projection),
[`backend/offers.py`](../backend/offers.py) (discount windows, settlement, profit, calculator, demo bookings),
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
| Charging plan | Three rule sets in `business.plan_night` (below), each plan verified by the energy bridge's `optimizer.check_plan` | simulation |
| Calculator feasibility | Jerry's energy bridge (`optimizer.run_policy`) plans the EVs on the example site | simulation |
| Prices, software and setup costs | Example values (below) | illustrative |
| CO2 | Flat grid average, `scenario.GRID_INTENSITY_T_PER_MWH` (0.25 t/MWh), the same factor the Battery page uses | estimated |

Jerry's energy bridge (`backend/optimizer.py`, issue #50) is the team's single definition of a feasible
plan, and this page uses it twice:

- **Every strategy's plan must pass the bridge's `check_plan()`** (plug-in hours, charger rate and count,
  site power, never overfilling a van). A plan that fails is a bug: the calculation stops and the page
  shows its error state rather than an infeasible plan.
- **The calculator's EV count is planned by the bridge** (`run_policy`, below), so extra EVs only count
  while the example site's chargers and connection can take them.

The three strategies themselves are this page's own week-long simulation: the bridge plans one forecast
half-hour at a time and has no no-look-ahead week to replay.

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

## Depot what-if (API only)

The page's calculator is now the discount-window one; this depot estimate stays available on the API.

```
energy per day  = what the energy bridge can deliver overnight to N EVs at the example site
                  (each needs the depot's average 40.6 kWh from the grid; 20 × 11 kW chargers, 180 kW)
yearly savings  = energy per day × share shifted × price difference × operating days − yearly cost
payback         = one-off cost ÷ yearly savings × 12
```

The EV count therefore **genuinely affects feasibility**: up to about 56 EVs everything fits; beyond
that the 180 kW connection is full overnight, fewer EVs charge fully and the savings stop growing. The
answer's `feasibility` says how many EVs fit and what limited them, and the page shows it as a site
check. The bridge plans at most 200 vehicles; by then the site is long full, so more EVs add nothing.

The share shifted and the price difference are the user's assumptions, so the result stays
**illustrative**. The defaults reproduce the depot (the price difference is derived from the simulation,
to five decimals), so the calculator starts where the page does, within a euro of the waterfall. Every
input changes the result (tested). Inputs are validated in the browser for feedback and again on the
server, which is authoritative.

## Discount windows: who saves, who earns (issue #56)

The top of the Impact page is the business case for **discount windows** at a participating public
charger: drivers join for free, book a 07:00-09:00 or 17:00-19:00 window, arrive and plug in. Our AI
serves the booking from surplus renewable energy it stored earlier, and **only the extra saving over
basic smart charging** is shared: 50% to the driver as a discount, 25% to the charging operator, 25% to
us as a performance commission. It is a separate, optional scenario in
[`backend/offers.py`](../backend/offers.py) (`discount-windows/v1`), run on the same replayed nights as
the depot; none of the depot figures above depend on it. Tests:
[`backend/tests/test_offers.py`](../backend/tests/test_offers.py),
[`frontend/tests/offers.test.js`](../frontend/tests/offers.test.js) and the Impact page tests.

### Commuter windows are not cheap windows

07:00-09:00 and 17:00-19:00 suit commuters; they are not periods of spare or cheap energy. 17:00-19:00
is Ireland's peak ([SEAI](https://www.seai.ie/plan-your-energy-journey/for-your-home/smart-living/smart-meters-and-tariffs)),
cheap half-hours on dynamic tariffs move ([CRU](https://www.cru.ie/consumer-information/billing/dynamic-price-tariffs-for-electricity/)),
and curtailment is often outside both windows and partly local
([EirGrid](https://www.eirgrid.ie/news/eirgrid-statement-renewable-integration-and-dispatch-down)). So a
window is offered **only** when surplus is already stored and every check passes; otherwise the EV page
says *"No discounted window right now — next opportunity: …"* and normal charging stays open. Load is
never moved into the peak to keep a marketing promise. In the replay, mornings are never discounted:
off-peak grid energy (EUR 0.205/kWh) is cheaper than stored surplus (about EUR 0.24/kWh all-in).

### The comparable baseline and the eligible pool

Every amount is per delivered session, pre-VAT, avoidable costs only:

```
basic smart cost   = cheapest tariff half-hours inside the session's own window that still deliver it
                     at the charger's rate (a 20 kWh session at 11 kW needs almost all of 17:00-19:00,
                     so it pays the EUR 0.34 peak; mornings mix night and day: EUR 0.205)
AI all-in cost     = stored energy price / discharge efficiency + battery wear + network charges
                     + extra site/session costs
stored energy price= (tariff − surplus credit) / charge efficiency, for energy bought while curtailment
                     was observed
eligible pool      = max(0, basic smart cost − AI all-in cost) × kWh, in whole cents
```

With the illustrative prices, surplus bought at night costs EUR 0.08/kWh, so the delivered cost is
0.08 / 0.92 / 0.92 + 0.08 wear + 0.04 network + 0.025 session ≈ **EUR 0.24/kWh** against the EUR 0.34 peak.
Energy is never called free, and surplus coinciding with a window adds nothing: normal charging would
get the same low price, so there is no extra saving to share (the energy proof shows it as 0 kWh).

### The split, profit and break-even

```
driver     = half the pool (the odd cent goes to the driver)
us         = a quarter of the pool, rounded down (our commission, paid by the operator)
operator   = the rest; driver + operator + us = pool exactly

our operating profit     = commission − our per-session cost × sessions − our monthly overhead
operator's extra profit  = its 25% − its remaining monthly programme costs
break-even (operator)    = ceil(operator costs ÷ operator share per session)
break-even (us)          = ceil(our overhead ÷ (commission − our cost) per session); never, if ≤ 0
```

Costs already inside the pool (energy, losses, wear, network, session) are never subtracted again.

**Worked examples** (tested exactly in `SettlementTests`):

| | Amount |
|---|---:|
| One session: 20 kWh, EUR 0.34 basic smart, EUR 0.24 AI all-in | pool **EUR 2.00** |
| Driver discount / operator / our commission | **EUR 1.00 / 0.50 / 0.50** |
| Our contribution after EUR 0.10 per-session cost | EUR 0.40 |
| A month: 400 sessions × 20 kWh × EUR 0.10 | pool **EUR 800** |
| Drivers | EUR 400 |
| Operator: EUR 200 − EUR 100 programme costs | **EUR 100** profit |
| Us: EUR 200 − EUR 40 per-session − EUR 120 overhead | **EUR 40** operating profit |
| Break-even | operator **200**, us **300** sessions a month |
| No eligible spare energy | no commission; operator −EUR 100, us −EUR 120 a month |

The page's KPIs come from the replay, not from this example: in the simulated week the hub sells 94
sessions (6 of 7 evenings, no mornings), which projects to 403 sessions a month, EUR 810 of extra savings,
EUR 407 for drivers, EUR 101.50 operator profit and EUR 41.20 operating profit for us from EUR 201.50 gross
commission. The month is the replayed sessions per day × 30, scaled like the depot by how often
curtailment happens over a full year when that is known.

### The offer gate (every window, 30 minutes before it starts)

A window is offered only when all of these hold, using only what is known then:

1. **Supply**: settled surplus is already stored. Energy bought on a forecast that turned out wrong
   (no observed curtailment) is conventional grid energy: it is sold at the normal price and never offered.
2. **Economics**: the saving, rounded down to 0.1 cent/kWh, is positive and our per-session cost is
   covered, so both businesses have a non-negative unit contribution. If the +30 minute forecast calls
   surplus in the window itself, the saving is judged as if normal charging got the surplus price too.
3. **Physics**: sessions = min(assumed demand, what the site fits, battery power, stored energy).

Once locked, the driver's price is honoured. If the window turns out cheaper for normal charging after
all, the settled pool is smaller: our commission is cut first to what is left after the driver, and the
operator carries the rest as a recorded **shortfall**. Cancelled or failed sessions pay nothing to anyone.
Only the +30 minute forecast is used; a +60 estimate of the same half-hour is never added (tested).

### Physical limits

The hub has the depot's hardware: 20 × 11 kW chargers and a 180 kW connection. An 11 kW charger delivers
at most **22 kWh** in a two-hour window, so a 40 kWh charge cannot fit. The energy bridge
(`optimizer.run_policy` + `check_plan`) plans each window: it fits **16** sessions of 20 kWh (so at most
960 a month across both windows); the calculator counts no more than that and says why.

The **battery is hypothetical** (not built, never shown as working storage): 700 kWh, 180 kW,
92% charge and 92% discharge efficiency (85% round trip), EUR 0.08/kWh wear. It fills only while the
forecast calls surplus and the price could clear a EUR 0.02/kWh saving at the peak; its charge carries
from one night to the next. `optimizer.py` still models real storage as 0.

### Prices and provenance

| Item | Value | Status |
|---|---|---|
| Tariff and surplus credit | the depot's: night 0.16, day 0.26, peak 0.34, surplus credit 0.08 EUR/kWh | illustrative |
| Public price (everyone, no booking) | EUR 0.49/kWh | illustrative |
| Network charges on stored energy, session costs | EUR 0.04 and 0.025/kWh | illustrative |
| Operator programme costs | EUR 100/month | illustrative |
| Our costs | EUR 0.10/session, EUR 120/month | illustrative |
| Demand | 20 drivers want each evening, 10 each morning | assumed |
| Forecasts, curtailment | GridToEv +30 min replay, observed EirGrid | historical (or simulated when the model is down) |
| Surplus credit deliverability | curtailment is system-wide; not confirmed with the system operator | conditional |

All money is **ex VAT**; the driver's receipt adds VAT at the applicable rate to both prices. Without real
settlement data the page says *projected revenue* and *simulated profit*, never money earned.

### Drivers and the EV page

The EV page's **Discount windows** card is a demo: *Join free* stores a random id on the server
(`backend/.cache/discount-window-bookings.json`), not an account; there is no reservation or payment.
Joining is optional: anyone can charge at the public price without it, and prices are shown before
charging ([AFIR Article 5](https://eur-lex.europa.eu/eli/reg/2023/1804/oj/eng)). A member steps through
the replayed days, sees both windows, picks 10/15/20/22 kWh (each priced by the server) and reserves.
Booking the same window again changes the kWh, never adds a second fee; offers carry the scenario id, so
an offer from an older replay is refused as changed or expired. A member's demo booking is not added to
the Impact figures.

### Before quoting any of this: pilot validation

- Replace the illustrative tariff, public price and costs with the operator's contract and quotes.
- Confirm network deliverability of surplus to the site with the system operator (currently conditional).
- Size and price a real battery (or drop the stored route); until then evening offers are hypothetical.
- Measure real bookings, arrivals and no-shows instead of assumed demand.
- Settle real sessions against metered data; only then can the page show earned money.

## API

### `GET /api/v1/business/impact[?refresh=1]`

The first request starts the calculation in the background (the server also starts it at launch, at
prefetch priority, through the shared replay gate). While it runs:

```
HTTP 202  {"version": "business-impact/v1", "status": "preparing",
           "progress": {"done": 3, "total": 10, "stage": "Replaying historical forecasts"}}
```

`total` is one step per evaluation day replayed, then `Checking a full year of observed curtailment`
(the seasonal adjustment), then `Scoring three charging strategies` (which also builds the discount
windows). The page turns these into a three-step checklist with a progress bar and the replay's time left.

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

### `GET /api/v1/business/offers/estimate?sessions=&kwhPerSession=&savingEurPerKwh=[&operatorFixedEur=&platformVariableEur=&platformFixedEur=]`

The Impact page's what-if calculator. Sessions 0-100,000 (whole), kWh 1-100, saving EUR 0-1/kWh; omitted
costs use the defaults above. `200 {"month": {...split, operator, platform, yearly}, "capacity": {"sessionsPerWindow",
"maxPerMonth", "requested", "counted", "capped", "limit"}, "noSpareEnergy"}` or `400` with `fields`.

### `GET /api/v1/business/offers?member=` and `POST /api/v1/business/offers`

The EV page card. GET returns `202` while the week is replayed, then the offers of the replay (each with
its status, reason, next opportunity, locked prices and server-priced `quotes`) and the demo member's
bookings. POST `{"member", "action": "join" | "leave" | "book" | "cancel", "offerId", "kwh"}` returns the
member, or `409 OFFER_UNAVAILABLE` with a message for the driver.

The discount-window section of `GET /api/v1/business/impact` is `discountWindows`: `kpis`, `month`, `scenarios`
(`expected`, `evaluationWeek`, `noSurplus`, `example`), `calculator`, `offers`, `ledger` (settled sessions and
euros, `balanced`), `energy` (sources, battery, calls, network) and the labelled assumptions.

### `GET /api/v1/business/estimate?evs=&shiftablePct=&priceDiffEurPerKwh=&operatingDays=[&implementationEur=&annualEur=]`

| Input | Range |
|---|---|
| `evs` | whole number, 1-10,000 |
| `shiftablePct` | 0-100 (% of daily charging) |
| `priceDiffEurPerKwh` | 0-1 |
| `operatingDays` | whole number, 1-366 |
| `implementationEur`, `annualEur` (optional) | 0-10,000,000 and 0-1,000,000 |

`200 {"illustrative": true, "kwhPerEvDay", "shiftedKwhPerYear", "grossSavingsEur", "annualCostsEur", "yearlySavingsEur", "implementationEur", "paybackMonths", "paybackStatus": "months" | "not-achieved" | "no-investment", "feasibility": {"checkedBy", "site", "evs", "evsPlanned", "vehiclesMet", "deliverableKwhPerDay", "requiredKwhPerDay", "deliverableShare", "limitedBy": null | "site-power" | "chargers" | "plug-in-hours"}, "effects", "note"}`,
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
- The calculator checks feasibility on the example site only (20 chargers, 180 kW); a real site needs its
  own chargers and connection entered or planned.
