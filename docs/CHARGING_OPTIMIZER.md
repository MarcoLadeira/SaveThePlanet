# Charging optimizer (issue #39)

Turns the GridToEv +30/+60 minute forecast into a feasible, vehicle-level charging plan for a
**simulated** fleet, compares it with a baseline under identical constraints, and labels every
number by provenance. It is a deterministic calculation: no language model builds or edits plans.

Code: [`backend/fleet.py`](../backend/fleet.py) (schema, presets, availability),
[`backend/eligibility.py`](../backend/eligibility.py) (what may be claimed where),
[`backend/optimizer.py`](../backend/optimizer.py) (policies, checker, comparison).
Fixture: [`data/fleets/presets-v1.json`](../data/fleets/presets-v1.json).
Tests: [`backend/tests/test_optimizer.py`](../backend/tests/test_optimizer.py).

## MVP vs later

| MVP (this issue) | Later (needs external inputs) |
|---|---|
| Simulated fleets from a versioned fixture or the request body | Real telemetry, arrivals and state of charge |
| Historical replayed forecast, or labelled demo fallback | Validated live forecast from GridToEv's as-of pipeline |
| Hypothetical site eligibility flags | Network map / operator confirmation of deliverability |
| Plans as recommendations | Charger actuation (e.g. OCPP) |
| Projected window energy | Measured recovery and verified CO2 |

## Time and interval semantics

- Everything is UTC in the backend. The UI converts using its timezone setting.
- **A target timestamp labels the half-hour that ends at that time.** GridToEv uses "the latest
  completed dispatch-down interval" at the issue time as a feature and attaches every label to a
  strictly later target, which fits end-labelling. So target `T` covers `[T - 30 min, T)`: the +30
  window starts at the issue time and the +60 window starts 30 minutes after it. This is inferred
  from the GridToEv README, not confirmed by its authors; it is the single constant
  `optimizer.INTERVAL_LABEL`, and tests cover both settings.
- Plan slot `i` covers `[issue + 30i, issue + 30(i+1))`. Fleet times are minutes relative to the
  issue time, so a fixture can be replayed against any historical forecast and DST never applies.
- A vehicle is only scheduled in whole half-hours it is plugged in for: arrival rounds **up**,
  departure rounds **down**. Charging before the issue time is outside the plan.
- Plans run to the last departure, at most 48 half-hours.

## Units

- kW x 0.5 h = kWh per slot; kWh / 1000 = MWh; forecast MWh x 1000 = kWh.
- Grid energy is what chargers draw. Battery energy = grid energy x `chargingEfficiency`.
  `requiredKwh` is battery energy.
- A vehicle's rate is `min(vehicle maxKw, site chargerKw)`, as constant power for the half-hour.

## Fleet schema (`fleet/v1`)

```json
{
  "chargingEfficiency": 0.9,
  "sites": [{"id": "depot", "name": "Fleet depot", "region": "IE", "hypotheticalConstraintZone": true,
             "chargers": 6, "chargerKw": 22, "sitePowerKw": 100}],
  "vehicles": [{"id": "EV-01", "site": "depot", "arriveMin": -60, "departMin": 240,
                "requiredKwh": 30, "maxKw": 22}]
}
```

IDs are opaque labels, never personal data. Limits: 1-20 sites, up to 200 vehicles, efficiency in
(0, 1]. Presets: `depot-and-retail` (18 EVs, 2 sites) and `constrained-site` (12 EVs, 3 chargers,
22 kW, where deadlines cannot all be met).

## Hard constraints

Checked on every plan by `check_plan()`. A plan that fails is never returned: the route answers
HTTP 500 `OPTIMIZER_FAILED`.

1. No charging outside a vehicle's plugged-in half-hours.
2. Energy per vehicle and slot is non-negative and at most `rate x 0.5 h`.
3. Total grid energy per vehicle is at most `requiredKwh / efficiency`.
4. Vehicles charging at a site in a slot never outnumber its chargers.
5. Site energy per slot is at most `sitePowerKw x 0.5 h`.
6. Energy claimed against the forecast window is at most the eligible forecast energy (see below).

## Eligibility

Kept separate from the scheduler so real network data can replace it. Nothing is ever `eligible`
in the MVP:

| Component | Site | Status |
|---|---|---|
| Curtailment (system-wide) | Irish site | `conditional`: could in principle absorb it; not operator-confirmed |
| Constraint (location-specific) | `hypotheticalConstraintZone: true` | `conditional`, explicitly hypothetical |
| Constraint | Other Irish site | `unknown`: not claimed |
| Either | Outside Ireland | `ineligible` |

Energy charged in the window at a site is only **claimed** against the components it may use.
Constraint energy is attributed to zone sites first, then curtailment covers the rest. Charging
that is not claimed still happens and still counts towards meeting deadlines.

## Uncertainty

- `expected`: the point forecast (`atRiskMwh`, split into curtailment and constraint).
- `conservative`: both components scaled down to the P10 quantity. P10 is a model estimate, not
  a guaranteed minimum (see GridToEv's purged benchmark for its calibration limits).
- The dispatch-down **event probability** is reported beside the plan and never multiplied in.

## Policies and objective

| Policy | Rule |
|---|---|
| `arrival-order` (**baseline**) | Chronologically, first come first served, charge at full rate on arrival |
| `deadline-first` | Chronologically, earliest departure first |
| `opportunity-first` | Fill the forecast window first (most urgent, then fastest vehicles, capped by eligible energy), then earliest departure first |

All three run under the same constraints and are checked. The **optimized plan** is the best by a
lexicographic objective:

1. fewest vehicles missing their requirement,
2. fewest unmet kWh,
3. most energy claimed in the forecast window,
4. tie-break: opportunity-first, deadline-first, arrival-order.

The baseline is a candidate, so the optimized plan is never worse than it, and an honest "no
improvement" is possible. This is a deterministic heuristic, not a proven optimum. It needs no
external dependencies and runs in milliseconds for 200 vehicles x 48 slots, so no timeout or
solver fallback is needed. An LP/MILP solver (e.g. OR-Tools) can replace the policies behind the
same interface later.

**Alternatives.** +30 and +60 are planned separately from the same starting fleet, and one is
selected by the same objective (earlier window on ties). Their energies are **never added**.

## API

`GET /api/v1/charging/presets` returns the fixture.

`POST /api/v1/charging/optimize`

```json
{"preset": "depot-and-retail", "uncertainty": "expected", "capacityMw": 100}
```

or `{"fleet": {...fleet/v1...}}` instead of `preset`. The forecast always comes from the server's
own cached forecast (shared with the other pages and Volt). A forecast sent by the browser is
ignored.

The response has these top-level keys:

- `id`: hash of the inputs.
- `solver`: `id`, `kind` and `elapsedMs`.
- `fleet`: `fixture`, `provenance: simulated`, and the sites with their claim statuses.
- `forecast`: `issuedAt`, `modelVersion`, `dataMode` and `fallback`.
- `dataMode`: `simulated-fleet-on-historical-forecast`, or `simulated` when the forecast fell back to demo data.
- `selectedHorizonMinutes` and `selectionReason`.
- `alternatives`, each with:
  - `window`: UTC start/end and slot.
  - `opportunity`: available kWh, P10/P90 and event probability.
  - `baseline`, `optimized` and `candidates`.
  - `improvement`: kWh, percent (`null` when the baseline is 0), share of the opportunity, and `improved`.
- `assumptions` and `limitations`.

Each plan summary has these fields:

- `status`: `all-met`, `partial` or `empty`.
- Energy totals: `requiredKwh`, `deliveredKwh`, `gridKwh` and `unmetKwh`.
- Vehicle counts: `vehiclesMet` and `vehiclesMissed`.
- `window`: `chargedKwh`, `claimedKwh`, `claimedByComponent`, and `limitedBy` per site (`site-power`, `chargers`, `vehicles`, `forecast-window`).
- `bindingLimits`.
- `siteLoad`: kW and chargers in use per site and slot.
- `vehicles`, each with a per-slot `schedule` and a `limitingReason` when unmet (`deadline`, `chargers`, `site-power`, `not-connected`, `rate`).

Errors: HTTP 400 `INVALID_REQUEST` with a readable message for bad fleets, presets, modes,
capacity or JSON. A model outage does not fail the route: it uses the labelled demo forecast,
exactly like `/api/v1/scenario`.

## Measured demo comparison (demo fallback forecast, expected mode)

| Preset | Window | Baseline in window | Optimized in window | Vehicles missed (base -> opt) |
|---|---|---|---|---|
| depot-and-retail | +30 | 65 kWh | 65 kWh | 0 -> 0 (no improvement: both sites at their power limit) |
| depot-and-retail | +60 | 61.3 kWh | 65 kWh | 0 -> 0 (**+3.7 kWh, +6%**) |
| constrained-site | +30/+60 | 11 kWh | 11 kWh | 9 -> 9 (no improvement: 22 kW site limit) |

These are simulation outputs from `optimizer.optimize`, not measured recovery. Rerun them against
the hosted model before quoting them.

## Wording rules for the UI and Volt

- "Planned in the forecast window" / "projected", never "recovered" or "saved".
- Always show that the fleet is simulated and whether the forecast is historical or a demo fallback.
- Show constraint claims as hypothetical, with the reason from `fleet.sites[].claims`.
- Volt may explain `selectionReason`, `limitedBy`, `limitingReason` and `assumptions`. It never
  invents vehicles, certainty or verified impact.

## Not done yet

- Charging page UI, Dashboard "Your next move", Impact labels and Volt intents that use this route.
- Historical backtest across many issue times (issue section 6), using the Forecast explorer's
  prediction-vs-observed data without hindsight in plan selection.
- Confirming the interval label with GridToEv.
