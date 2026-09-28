# Charging optimizer and energy ledger (issues #39, #44, #50)

Turns the GridToEv +30/+60 minute forecast into a feasible, vehicle-level charging plan for a
**simulated** fleet, compares it with a baseline under identical constraints, and labels every
number by provenance. It is a deterministic calculation: no language model builds or edits plans.

Code: [`backend/fleet.py`](../backend/fleet.py) (schema, presets, availability),
[`backend/eligibility.py`](../backend/eligibility.py) (what may be claimed where),
[`backend/optimizer.py`](../backend/optimizer.py) (policies, equal-share allocation, plan and ledger checks, comparison).
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
- **A target timestamp labels the half-hour that starts at that time** (the V1 dataset contract in
  [backend/README.md](../backend/README.md)): target `T` covers `[T, T + 30 min)`. The constant is
  `optimizer.INTERVAL_LABEL`, and tests cover both settings.
- Both horizons forecast the **same** target half-hour, each from its own issue time (+60 issued
  at `T - 60`, +30 at `T - 30`). The plan starts at the earliest issue time, so the target window
  is slot 2, and fleet times are minutes from that plan start.
- Plan slot `i` covers `[start + 30i, start + 30(i+1))`. DST never applies: everything is UTC.
- The route uses the page's pinned `target`, so the plan, the Dashboard, Charging, Impact and
  Volt all describe the same half-hour.
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
| `equal-share` (**optimized**) | Share the forecast window's eligible energy **equally** between the vehicles plugged in for it, then charge the rest earliest departure first |

**Equal share (max-min fair, "water-filling").** Every vehicle plugged in for the window rises by
the same amount of grid kWh until it hits its own limit (full, or its charging rate x 0.5 h), its
site's power limit, or the forecast energy runs out. A vehicle that stops early leaves its share
to the others. Example: 30 kWh between five cars, one needing only 2 kWh and one limited to
3.7 kWh (7.4 kW): those two get 2 and 3.7 kWh, the other three get 8.1 kWh each. Because the
limits nest (vehicle, site, curtailment pool, whole opportunity), this also uses **as much of the
opportunity as the limits allow**. When a site has more such vehicles than chargers, it plugs in
the earliest departures, unless the vehicles that can take the most energy would let it use more
of the opportunity.

The objective is, in order: most forecast window energy used, then fewest vehicles missing their
requirement, then fewest unmet kWh. The optimized plan never uses less forecast energy than the
baseline (enforced). Sharing energy equally can leave one more vehicle short of its target than the
baseline does (the constrained-site preset shows this): the plan says so rather than hiding it.
This is a deterministic calculation, not a proven global optimum across all half-hours.

**Forecasts of the same half-hour.** When +30 and +60 share a target (the normal case) they are two
estimates of one window. Each gets its own plan and ledger from the same fleet, the plan follows the
most recent (+30 min) forecast (`selectionBasis: most-recent-forecast`, matching the scenario's
`recommendationBasis`), and the +60 plan is shown as the earlier estimate. If the targets ever
differ, they are alternative windows and the best plan by the objective wins (`best-plan`).
Energies are **never added**.

## Energy ledger (issue #50)

Every plan (baseline and optimized, for each forecast) has a `ledger` accounting for every kWh of
its half-hour, all measured **grid-side** (what the chargers draw):

```
predictedAtRisk         = eligibleOpportunity + notEligible
eligibleOpportunity     = allocatedToChargersGrid + allocatedToRealStorage (always 0) + unallocatedOpportunity
allocatedToChargersGrid = batteryDelivered + chargingLoss     (batteryDelivered = grid x efficiency)
```

| Field | Meaning |
|---|---|
| `predictedAtRiskKwh` | The forecast's energy at risk for the half-hour (MWh x 1000). |
| `eligibleOpportunityKwh` | The part at least one fleet site may claim (see Eligibility), scaled to P10 in conservative mode. A **conditional, modelled** value: network eligibility is unverified. |
| `notEligibleKwh`, `notEligibleReasons` | Predicted but not claimable: `constraint-not-claimable`, `no-eligible-site`, `conservative-p10`. |
| `allocatedToChargersGridKwh` | Eligible energy the plan draws into EV chargers in the window. |
| `allocatedToRealStorageKwh` | Always 0: no physical storage battery is modelled. |
| `unallocatedOpportunityKwh`, `unallocatedReasons` | Eligible energy the fleet could not take, with per-site reasons: `site-power`, `chargers`, `vehicles-full`, `no-connected-ev`, `site-not-eligible`. **Not measured grid waste.** |
| `batteryDeliveredKwh`, `chargingLossKwh` | What reaches EV batteries, and the conversion loss (disclosed, never dropped). |
| `utilizationFraction` | allocated / eligible, `null` when nothing is eligible. Never forced to 1. |
| `outcome` | `fully-allocated`, `partially-allocated`, `not-allocated` or `no-opportunity`. |

Values are rounded to 1 Wh (3 decimals of kWh); derived fields are computed from the rounded
values, so the published numbers balance exactly. `check_ledger()` verifies every equation (and
that eligible never exceeds predicted) on every plan; a plan that fails is never returned (HTTP 500
`OPTIMIZER_FAILED`).

The optimized plan also lists `opportunityAllocations`: each vehicle's slice of the window energy
(`gridKwh`, `batteryKwh`, `lossKwh`). They are rounded with the largest-remainder method, so each
column adds up exactly to the ledger.

Worked examples (tested in `EnergyLedgerTests`, 90% efficiency unless stated):

| Case | Allocated (grid) | Unallocated | Into batteries | Loss |
|---|---|---|---|---|
| 10 kWh eligible, room for all of it | 10 | 0 | 9 | 1 |
| 10 kWh eligible, 16 kW site limit (8 kWh per half-hour) | 8 | 2 (`site-power`) | 7.2 | 0.8 |
| 10 kWh at risk, no eligible site | 0 | 0 (10 not eligible) | 0 | 0 |
| 10 kWh eligible, no car plugged in / all full | 0 | 10 | 0 | 0 |
| 60 kWh, 60 cars each needing 1 kWh (100% efficiency) | 60 (1 each) | 0 | 60 | 0 |
| 60 kWh, 60 cars each needing 1 kWh | 60 (1 each) | 0 | 54 (0.9 each) | 6 |
| 60 kWh, 70 cars each needing 1 kWh (100% efficiency) | 60 (~0.857 each) | 0 | 60 | 0 |

## API

`GET /api/v1/charging/presets` returns the fixture.

`POST /api/v1/charging/optimize`

```json
{"preset": "depot-and-retail", "uncertainty": "expected", "capacityMw": 100, "target": "2026-01-31T23:00:00Z"}
```

or `{"fleet": {...fleet/v1...}}` instead of `preset`. `target` is the page's pinned half-hour
(optional; validated like Volt's). The forecast always comes from the server's
own cached forecast (shared with the other pages and Volt). A forecast sent by the browser is
ignored.

The response has these top-level keys:

- `id`: hash of the inputs (the scenario ID for this plan).
- `status`: e.g. `simulation on historical forecast; network eligibility unverified`.
- `networkEligibility`: always `unverified` in the MVP. `unit`: `kWh`. `intervalId`: `<window start>/PT30M`.
- `ledger` and `baselineLedger`: the selected window's optimized and baseline ledgers.
- `solver`: `id`, `kind` and `elapsedMs`.
- `fleet`: `fixture`, `provenance: simulated`, and the sites with their claim statuses.
- `forecast`: `planStartAt`, `targetAt`, `pinnedTarget`, `horizonMinutes`, `issuedAt`, `modelVersion`,
  `dataMode`, `fallback` and `stale`. A page should discard a plan whose `pinnedTarget`/`targetAt`
  no longer matches the half-hour it is showing.
- `dataMode`: `simulated-fleet-on-historical-forecast`, or `simulated` when the forecast fell back to demo data.
- `selectedHorizonMinutes`, `selectionReason`, `selectionBasis` and `sharedTarget`.
- `alternatives`, each with:
  - `window`: UTC start/end, `intervalId` and slot.
  - `opportunity`: available and eligible kWh, P10/P90 and event probability.
  - `baseline` and `optimized` plan summaries.
  - `improvement`: kWh, percent (`null` when the baseline is 0), share of the opportunity, and `improved`.
- `assumptions` and `limitations`.

Each plan summary has these fields:

- `status`: `all-met`, `partial` or `empty`.
- `ledger` (above) and, for the optimized plan, `opportunityAllocations`.
- Energy totals: `requiredKwh`, `deliveredKwh`, `gridKwh` and `unmetKwh`.
- Vehicle counts: `vehiclesMet` and `vehiclesMissed`.
- `window`: `chargedKwh`, `claimedKwh`, `claimedByComponent`, and `limitedBy` per site.
- `bindingLimits`.
- `siteLoad`: kW and chargers in use per site and slot.
- `vehicles`, each with a per-slot `schedule` and a `limitingReason` when unmet (`deadline`, `chargers`, `site-power`, `not-connected`, `rate`).

Errors: HTTP 400 `INVALID_REQUEST` with a readable message for bad fleets, presets, modes,
capacity or JSON; HTTP 502 `INVALID_MODEL_RESPONSE` if the forecast is inconsistent (negative or
non-finite MWh, components that do not add up, a target not one horizon after its issue time). A
model outage does not fail the route: it uses the labelled demo forecast, exactly like
`/api/v1/scenario`.

### Example for the pages (demo fallback forecast, `depot-and-retail`, trimmed)

```json
{
  "id": "084554a45f68",
  "dataMode": "simulated",
  "status": "simulation on demo forecast; network eligibility unverified",
  "networkEligibility": "unverified",
  "unit": "kWh",
  "intervalId": "2026-01-31T13:00:00+00:00/PT30M",
  "selectedHorizonMinutes": 30,
  "forecast": {"targetAt": "2026-01-31T13:00:00+00:00", "horizonMinutes": 30, "issuedAt": "2026-01-31T12:30:00+00:00",
               "modelVersion": "demo-fixture-v1", "dataMode": "simulated", "fallback": {"active": true, "reason": "MODEL_UNAVAILABLE"}},
  "ledger": {
    "version": "energy-ledger/v1", "unit": "kWh", "boundary": "grid-side",
    "predictedAtRiskKwh": 350.0, "eligibleOpportunityKwh": 350.0, "notEligibleKwh": 0.0, "notEligibleReasons": [],
    "allocatedToChargersGridKwh": 65.0, "allocatedToRealStorageKwh": 0.0, "unallocatedOpportunityKwh": 285.0,
    "unallocatedReasons": [
      {"site": "depot", "code": "site-power", "message": "Fleet depot (hypothetical): at its 100 kW site limit."},
      {"site": "retail", "code": "site-power", "message": "Retail car park (hypothetical): at its 30 kW site limit."}
    ],
    "batteryDeliveredKwh": 58.5, "chargingLossKwh": 6.5, "chargingEfficiency": 0.9,
    "utilizationFraction": 0.185714, "outcome": "partially-allocated"
  },
  "alternatives": [{"optimized": {"opportunityAllocations": [
    {"vehicle": "EV-01", "site": "depot", "gridKwh": 8.334, "batteryKwh": 7.5, "lossKwh": 0.834},
    {"vehicle": "EV-04", "site": "depot", "gridKwh": 8.333, "batteryKwh": 7.5, "lossKwh": 0.833},
    {"vehicle": "EV-11", "site": "retail", "gridKwh": 3.7, "batteryKwh": 3.33, "lossKwh": 0.37},
    {"vehicle": "EV-12", "site": "retail", "gridKwh": 3.8, "batteryKwh": 3.42, "lossKwh": 0.38}
  ]}}]
}
```

The depot's 100 kW limit (50 kWh per half-hour) is shared equally by the six vehicles on its
chargers (8.333 kWh each; two rows carry the extra Wh so the column adds up to exactly 50). The
retail car park's 30 kW (15 kWh) goes to four cars: two are limited to 3.7 kWh by 7.4 kW
charging, so the other two share the remaining 7.6 kWh (3.8 each). Show the story as `forecast opportunity -> allocated to EV chargers (grid kWh)
-> into EV batteries (after the disclosed loss)`, straight from these fields; do not recompute it
in the browser. Re-run against the hosted model before quoting real figures.

## Measured demo comparison (demo fallback forecast, expected mode)

| Preset | Window | Baseline in window | Optimized in window | Vehicles missed (base -> opt) |
|---|---|---|---|---|
| depot-and-retail | +30 / +60 | 60.8 kWh | 65 kWh | 0 -> 0 (+4.2 kWh; both sites then at their power limit) |
| constrained-site | +30 / +60 | 11 kWh | 11 kWh | 9 -> 10 (no gain possible at the 22 kW site limit; sharing leaves one more car short) |

These are simulation outputs from `optimizer.optimize`, not measured recovery.

## Wording rules for the UI and Volt

- "Planned in the forecast window" / "projected", never "recovered" or "saved".
- Always show that the fleet is simulated and whether the forecast is historical or a demo fallback.
- Show constraint claims as hypothetical, with the reason from `fleet.sites[].claims`.
- Say whether a figure is grid-side kWh (into chargers) or battery kWh (after losses). Unallocated
  energy is "forecast energy this fleet could not take", never "wasted" or "lost".
- Show `utilizationFraction` as it is: never round a partial allocation up to 100%.
- Volt may explain `selectionReason`, `limitedBy`, `limitingReason`, the ledger and `assumptions`.
  It never invents vehicles, certainty or verified impact.

## Not done yet

- Charging page UI, Dashboard "Your next move" and Impact labels that use this route (the pages
  should render the ledger fields above, not re-implement the allocation).
- Historical backtest across many issue times (issue section 6), using the Forecast explorer's
  prediction-vs-observed data without hindsight in plan selection.
