# Shared forecast and charging scenario

Overview, Forecast, Charging and Impact share one forecast and charging scenario. Settings remain UI preferences; no model retraining or vehicle scheduler is included.

## Start locally

1. Copy `.env.example` to `.env` in the SaveThePlanet root and set your API key.
   The hosted model URL is already in the example. `.env` is ignored by Git.
2. On Windows, double-click `Start-App.cmd`. It starts the backend and opens the
   browser. Python must be installed. Keep its window open while using the app.
   Alternatively run `python backend/server.py` from the repository root.
3. Open http://127.0.0.1:8080 if the browser does not open automatically.

The backend automatically loads the project-root `.env`, regardless of the current
working directory. Existing process environment variables override file values.
Restart after changing configuration. Stop any existing backend before launching
another instance. The frontend and product API share one origin, so no frontend
build, extra Python dependencies or CORS setup is needed.

```dotenv
API_PORT=8080
GRID_TO_EV_API_BASE_URL=https://gridtoev-api.onrender.com
GRID_TO_EV_API_KEY=PASTE_YOUR_API_KEY_HERE
GRID_TO_EV_TIMEOUT_SECONDS=10
```

Only the backend reads the key and sends it in `X-API-Key`. Never put a real key in
`.env.example` or browser code. Supported .env syntax: KEY=value, quoted literal
values, comments and optional `export`. Shell expansion is not performed.

For a local model instead, set `GRID_TO_EV_API_BASE_URL=http://127.0.0.1:8000`,
clear the key if unnecessary, and start GridToEv separately using its README.

## Contract and scope

The browser calls `GET /api/v1/scenario?region=Ireland&capacityMw=100&totalDemandKwh=1000&flexibleDemandKwh=500`. The original `/api/v1/forecast` endpoint remains available for capacity-only predictions.
The adapter calls GridToEv's synchronous `POST /predict/from-dataset` once per horizon, validating both
30/60-minute predictions before mapping them to product fields. All four screens use
the same response. Changing horizon selects one of those predictions locally;
Refresh forecast requests both again using the entered flexible capacity.

The response contains `generatedAt`, `source`, `dataMode`, `region`, `modelVersion`,
`intervalMinutes`, `flexibleCapacityMw`, and `predictions`. Each prediction contains
`issuedAt`, `targetAt`, `horizonMinutes`, `probability`, `risk`, energy fields
(`atRiskMwh`, `curtailmentMwh`, `constraintMwh`, `potentialRecoveryMwh`) and
`lowerMwh`, `medianMwh`, `upperMwh` (P10/P50/P90).

- `dataMode=historical-prediction`: latest means latest shared dataset time, not now.
- All energy is MWh per half-hour, including the 60-minute-ahead forecast.
- Capacity is **MW**, independent of the demo Settings page's site power limit in kW.
- Model recovery = min(predicted dispatch-down MWh, capacity MW * 0.5 hours). Product scenario recovery is additionally capped by flexible demand in MWh.
- The default 100 MW is a flexible-load scenario, not observed EV availability.
- Component shares are predicted energy shares, not explanations of model reasoning.
- Risk is event risk, not confidence; the uncertainty fields provide P10/P50/P90.
- Timestamps are returned in UTC and displayed using the UI timezone preference.
- No 24-hour extrapolation, live feed, EV schedule, or measured recovery is claimed.
- Unsupported model signals are marked unavailable.

Invalid region/capacity yields HTTP 400 with `error.code=INVALID_REQUEST`.
Connection/timeout/non-2xx failures and malformed or inconsistent model responses return HTTP 200 with a validated local demo fixture. The payload explicitly marks simulated data and the reason (see below). Invalid user input remains HTTP 400; it never triggers fallback.

### Impact day replay

`GET /api/v1/impact/day?date=YYYY-MM-DD&capacityMw=100&totalDemandKwh=1000&flexibleDemandKwh=500`
powers the Impact page's "Impact over time" and "Cumulative impact" charts and KPI sparklines
(the page omits `date`, so it always shows the live forecast day; it also requests the day before
for the day-over-day change). It calls
GridToEv `POST /predict/window/from-dataset` once (24 h of +30-minute forecasts, ~15 s upstream,
then cached per date and capacity). A background prefetch of neighbouring days exists but is off
(`PREFETCH_DAYS = 0`) because the Impact page follows the live forecast day without a date picker;
concurrent requests for the same day still share one upstream call. `GET /dataset/info` supplies the valid range
(currently 2026-01-02 to 2026-01-31; the last day is partial). `date` defaults to the day the
+30/+60 forecast is issued on (the day before `GRID_TO_EV_ISSUE_TIMESTAMP`), so every card shows one day.

The response has `date`, `range{min,max}`, `intervals[]` (`targetAt`, `atRiskMwh`,
`potentialRecoveryMwh`, `remainingWasteMwh`, `avoidedEmissionsTco2`, `evRangeKm`), `totals`,
`assumptions` and `methodology`. Intervals are consecutive, non-overlapping half-hours, so unlike
the +30/+60 alternatives they may be summed; this assumes the entered flexible demand is available
again in every half-hour (stated in `methodology`). Week/month/year views are not offered: the V1
dataset covers one month and replays at most 24 h per call.

Errors: invalid input or a date outside the dataset → HTTP 400 (`INVALID_REQUEST`,
`DATE_OUT_OF_RANGE`); model unreachable or invalid → HTTP 502. There is no demo fallback for the
day replay; the page keeps showing the two-target view instead.

## Verification

```powershell
python -m unittest discover -s backend/tests -v
node --check frontend/model.js
node --check frontend/app.js
```

Manual: inspect all four screens, switch 30/60 minutes, set capacity to 0.1 MW
(100 kW, so recovery cannot exceed 0.05 MWh), stop the model and refresh to verify
the simulated fallback footer label, restart the model and click Reload forecast in Settings. Charging and Impact should
show the same scenario recovery as Overview.

## Shared scenario

`scenario.py` adds a `scenario` object to the normalized forecast. It contains a
stable ID, input demand in kWh/MWh, `dataMode=derived-scenario`, methodology and
one outcome for each forecast horizon. The ID identifies the inputs and forecast,
not a persisted record. Inputs remain in browser memory until reload.

Example starting assumptions: 1000 kWh total demand, 500 kWh flexible demand and
100 MW available flexible power. Change demand on Charging, or power on any
product screen. These are illustrative inputs, not measurements. The Settings
page's demo site limit is not applied; the shared capacity control is authoritative.

Each outcome exposes potential recovery, remaining at-risk energy, recovery rate,
clean charging share, remaining demand, remaining flexible demand, proposed power
and power-limit compliance. All quantities are backend calculations.

- Recovery = min(forecast surplus, flexible demand / 1000, MW * 0.5).
- Remaining at risk = forecast surplus - recovery.
- Recovery rate = recovery / forecast surplus (null for zero surplus).
- Clean charging share = recovery / total demand (null for zero demand).
- Remaining demand is demand outside this opportunity, not a missed charge target.
- Each horizon is an **alternative** use of the same demand. Do not sum outcomes.
- Recommend greatest recovery, breaking ties in favour of the earlier horizon;
  no positive recovery means no recommendation.
- Assume flexible demand is available at either target and no charging losses.

Demand must be finite, nonnegative and no greater than 1 billion kWh; flexible
demand cannot exceed total demand. Invalid input returns HTTP 400 before calling
the model. Missing vehicle availability, deadlines and baseline charging schedules
mean commitments, missed targets and EV counts are explicitly unavailable. No
financial/emissions estimate or actual charging execution is included.

## EV charging translation (Charging page)

`/api/v1/scenario` also accepts `kwhPerCharge` (1-200, default 30) and `chargerKw`
(1-400, default 22). They are illustrative assumptions, not vehicle data.
`scenario.evAssumptions` echoes the values used; they are part of the scenario ID.

Each outcome adds two separate, conditional readings of the same potential recovery:

- `evChargesEquivalent` = recovered kWh / kWh per charge. An energy comparison only:
  it does not claim those sessions fit in the half-hour.
- `minConcurrentPorts` = ceil(recovered kWh / (charger kW x 0.5 h)): the fewest ports that
  could draw the energy within the half-hour at continuous rated power, with a vehicle
  accepting power on every port and 100% efficiency. `portKwhLimit` (charger kW x 0.5 h)
  and `kwhPerPort` show what each port would deliver.

Example: 0.5 MWh = 500 kWh is about 16.7 x 30 kWh charge equivalents. Drawing it in
30 minutes needs at least 46 x 22 kW ports running together, each delivering at most
11 kWh (about 10.9 kWh here), or 143 x 7 kW ports. These are upper-bound estimates:
connected vehicles, available ports, onboard charger limits, losses and local grid
deliverability are not modelled. No charging time window is claimed, because whether a
target time labels the start or the end of its half-hour is not yet confirmed.

Day replay intervals (`/api/v1/impact/day`) also carry the model `probability`, used by
the Charging page's "Best half-hours to charge" ranking.

## Automatic demo fallback

No setup or model connection is required for fallback. Every request first tries
GridToEv; on connection failure, timeout, non-2xx, truncated response, malformed
JSON or invalid forecast fields it uses `demo.py`. Both product routes return the
same normalized contract, and Charging/Impact use the usual scenario calculator.

Fallback provenance:

```json
{
  "source": "local-demo-fixture",
  "dataMode": "simulated",
  "modelVersion": "demo-fixture-v1",
  "fallback": {"active": true, "reason": "MODEL_UNAVAILABLE"}
}
```

The alternative reason is `INVALID_MODEL_RESPONSE`. Derived scenario data also
has `dataMode=simulated` and carries the fixture source. A successful model call
returns `fallback.active=false` with a null reason and normal model provenance.
The UI labels fallback results in the page footer ("Simulated fallback").
Refresh forecast / Reload forecast always tries the
model again. There is no background retry timer.

The fixture has fixed timestamps, probabilities and energy values (0.35 and
0.80 MWh), not random data or a cached successful request. The same input produces
the same predictions, recovery values and scenario ID. Only `generatedAt` changes.
User capacity and charging demand are preserved and validated in fallback mode.

Default upstream socket timeout: 3 seconds; configurable in the range (0, 10]
seconds. The browser request timeout is 15 seconds. This fallback protects against
model outages; the local SaveThePlanet backend must still be running.

Rehearsal: start only `python backend/server.py` with GridToEv stopped, open the
app, check the "Simulated fallback" footer and edit charging demand. Start GridToEv and
click Reload forecast in Settings; the footer switches to model data and the entered assumptions remain.

## Health endpoint

`GET /api/v1/health` explains *why* the model is or is not being used. By default it
probes the model with the same call the forecast uses (1 MW, both horizons) and
always returns HTTP 200 while the backend itself is running.
`GET /api/v1/health?probe=false` returns the outcome of the most recent model call
without contacting the model; the UI uses this after every forecast load.

```json
{
  "status": "degraded",
  "mode": "fallback",
  "fallbackAvailable": true,
  "backend": {"status": "ok"},
  "model": {
    "state": "down",
    "checkedAt": "2026-09-25T13:08:15Z",
    "latencyMs": 2,
    "modelVersion": null,
    "error": {"code": "MODEL_CONNECTION_REFUSED", "message": "Nothing is listening at the model address…",
              "httpStatus": null, "detail": null},
    "target": "local",
    "apiKeyConfigured": false,
    "timeoutSeconds": 3.0
  }
}
```

`status` is `ok` (model live) or `degraded` (fallback, or not checked yet with
`probe=false`). `mode` is `live`, `fallback` or `unknown`. `modelVersion` keeps the last
version seen from a successful call. `detail` is the upstream FastAPI `detail`
message or the validation error, when there is one. The base URL and API key are
never returned; only whether the model is `local` or `hosted` and whether a key is set.

| `error.code` | Meaning |
| --- | --- |
| `MODEL_CONNECTION_REFUSED` | Nothing is listening at the configured address. |
| `MODEL_DNS_FAILURE` | Host name could not be resolved (URL typo or no internet). |
| `MODEL_TIMEOUT` | No answer within the timeout, e.g. a sleeping hosted service waking up. |
| `MODEL_TLS_ERROR` | HTTPS handshake failed. |
| `MODEL_UNREACHABLE` | Other network failure (proxy, firewall, reset connection). |
| `MODEL_INCOMPLETE_RESPONSE` | Connection closed mid-response. |
| `MODEL_AUTH_FAILED` | HTTP 401/403: API key missing or rejected. |
| `MODEL_ENDPOINT_NOT_FOUND` | HTTP 404: wrong base URL or model without `/predict/from-dataset`. |
| `MODEL_REJECTED_REQUEST` | HTTP 400/422: the model refused the request (see `detail`, e.g. issue timestamp outside the dataset). |
| `MODEL_RATE_LIMITED` | HTTP 429. |
| `MODEL_SERVER_ERROR` | HTTP 5xx from the model service. |
| `MODEL_HTTP_ERROR` | Any other non-2xx status. |
| `INVALID_MODEL_RESPONSE` | The model answered but the forecast failed validation (see `detail`). |

The forecast `fallback.reason` stays `MODEL_UNAVAILABLE` or `INVALID_MODEL_RESPONSE`;
the health codes above are the finer-grained explanation. Settings → Model connection
shows the health message and the full status with a
**Check connection** button (active probe) and **Reload forecast**.

## Forecast page explorer

The Forecast page explores both GridToEv models on targets taken from each model's
own dataset. `explorer.py` proxies the model (the API key never reaches the
browser), validates that every requested date/time is in the dataset before
calling it, and pairs each prediction with the observed EirGrid actual.

| Route | Model call(s) |
| --- | --- |
| `GET /api/v1/explorer/daily` | V2 `/model-info/daily-curtailment` + `/dataset/daily-curtailment/coverage` (cached 10 min) |
| `GET /api/v1/explorer/daily/predict?date=YYYY-MM-DD` | V2 `/predict/curtailment/day` + `/actuals/daily-curtailment` |
| `GET /api/v1/explorer/daily/week?date=YYYY-MM-DD` | `/predict/curtailment/day` for the date and the 6 days after it (shifted back near the dataset end) + one `/actuals/daily-curtailment/window` call for all 7 actuals |
| `GET /api/v1/explorer/short-term` | V1 `/model-info` + `/dataset/info` + `/dataset/available-times` (cached 10 min) |
| `GET /api/v1/explorer/short-term/predict?target=…Z&capacityMw=100` | V1 `/predict/from-dataset` at +30 (issued target-30 min) and +60 (issued target-60 min) + `/actuals/v1/batch` for the target |
| `GET /api/v1/explorer/short-term/day?date=YYYY-MM-DD&horizon=30` | V1 `/predict/window/from-dataset` for one horizon, per gap-free run, sequentially (one retry on timeout/5xx) |
| `GET /api/v1/explorer/short-term/observed?date=YYYY-MM-DD` | One `/actuals/v1/window` call: the day's 48 observed half-hours (~0.3 s), drawn before the ~13 s forecast replay arrives |

- Daily selectable dates: the V2 historical dataset (2024-04-01 to 2026-08-30).
- Short-term selection is by **target** half-hour: a target is selectable when its +30 or +60
  minute issue time is in the V1 dataset (January 2026). A 00:00 target therefore stays on its
  own day even though its forecasts were issued the previous evening.
  `/dataset/available-times` returns at most the latest 1000. Earlier half-hours are only
  accepted without extra calls when `available_issue_timestamp_count` proves there is no
  gap among them; otherwise each is confirmed by replaying it through the window route,
  whose `first_missing_issue_timestamp_utc` pinpoints gaps. The info response reports
  `dataset.verification` = `listed`, `count` or `replay`.
- A horizon whose target row is outside the dataset (for example +60 min from the
  final issue time) is omitted instead of failing the request.
- Invalid input → 400, target outside the dataset → 404 `NOT_IN_DATASET`, model
  failure → 502 with the same `error.code` values as the health endpoint.
  There is no demo fallback here: the page shows the error and a retry button.
- The day replay is aligned by **target** time: the 00:00 target comes from the 23:30 (+30) or
  23:00 (+60) issue the previous day. Targets without a dataset issue time are left out;
  `observed` still lists all 48 half-hours.
- The P10-P90 band stays ~5 MWh wide even when the prediction is 0 because the model widens
  every interval by `prediction_interval_adjustment_mwh` (5.44 MWh).
- Hosted-route smoke test: `GRID_TO_EV_SMOKE=1 python -m unittest backend/tests/test_hosted_smoke.py -v`
  calls every upstream route above on the real service (about a minute). CI runs it in
  `.github/workflows/tests.yml` when the `GRID_TO_EV_API_KEY` repository secret is set; the unit
  tests and frontend checks run on every pull request.
- Explorer calls allow up to 60 s, because a full-day replay can take ~15 s on the hosted service.

## Wind & Solar page (issue #65)

Opened from the Forecast header (`#sources`). `sources.py` wraps GridToEv's wind/solar routes;
the API key stays on the server and every derived number (peak, best charging window, errors,
EV equivalents) is computed here, once.

| Route | Model call(s) | Cache |
| --- | --- | --- |
| `GET /api/v1/sources/coverage` | `/actuals/curtailment/sources/coverage`, plus up to 14 recorded days to find the latest day with curtailment (`suggestedDay`) | 10 min |
| `GET /api/v1/sources/day?date=YYYY-MM-DD&capacityMw=100` | `/actuals/curtailment/sources?include_half_hours=true`: the recorded day, its peak, solar hours, best charging window and EV equivalent | published days forever, `pending`/`missing` 10 min |
| `GET /api/v1/sources/forecast?date=YYYY-MM-DD` | `POST /predict/curtailment/sources/day` (experimental split) + the recorded day + model info: the split, forecast minus recorded, and the formula worked backwards to the wind:solar potential ratio | successes forever, failures never |
| `GET /api/v1/sources/info` | `/model-info/curtailment/sources`: formula, fitted `a`/`b`, constants, capacity rule, fresh-confirmation progress, provisional accuracy, limitations | 10 min |
| `GET /api/v1/sources/month?month=YYYY-MM` | the recorded route for each day of the month, 6 at a time, sharing the per-day cache | per day |

- Days run from the archive start (2021-01-01; wind only before April 2023) to today (UTC).
  Days after the archive have no recorded figures yet but can still have a forecast.
- The forecast is optional: it answers 200 with `status` `ok`, `not_forecastable` (the model's 422
  reason, e.g. before 2024-04-01) or `unavailable` (503/timeout). It is a separate route because a
  cold forecast takes ~7 s upstream against ~0.6 s for a recorded day.
- A `null` from the API stays `null` (unknown), never 0. A published day without 48 half-hours is
  a 502; a date outside the range is a 404 `NOT_IN_DATASET`; bad input is a 400.
- Best charging window: up to 8 consecutive half-hours maximising Σ min(curtailed, capacity × 0.5 h);
  ties go to the most curtailed energy, then the shortest run, then the earliest. An upper bound,
  not energy saved.
- Tests (`tests/test_sources.py`) run on real responses saved in `tests/fixtures/sources`.

## Impact page: business and environmental impact

`GET /api/v1/business/impact` and `GET /api/v1/business/estimate` (`business.py`), plus the discount-window
business case in `offers.py` (`GET /api/v1/business/offers[/estimate]`, `POST /api/v1/business/offers`; see
docs/BUSINESS_IMPACT.md). Three charging
strategies (normal, basic smart and AI) charge the same simulated depot fleet over the latest week of
V1 +30 minute replays, with no look-ahead, and are scored against observed curtailment for money
(illustrative tariff), estimated CO2 and surplus renewable energy. The year is scaled by how often
curtailment happened over a full observed year (V2 daily dataset). The first request returns HTTP 202
with progress while the week is replayed (the server also starts this at launch, at prefetch priority);
the result is then cached. A model outage gives a labelled simulated example. Every plan passes the
energy bridge's `optimizer.check_plan`, and the calculator plans its EVs on the example site with
`optimizer.run_policy`. Full contract, methodology and limitations:
[docs/BUSINESS_IMPACT.md](../docs/BUSINESS_IMPACT.md).

## Dashboard V1 target and synthetic scenarios

**Historical dataset prediction.** The shared forecast (Dashboard, Charging, Impact, Volt)
asks `POST /predict/from-dataset` for one target half-hour of the V1 dataset, with each
horizon issued from its own time, so both are *forecast vintages of the same half-hour*
(e.g. for 23:00: +30 min issued 22:30, +60 min issued 22:00). The target timestamp labels
the **start** of the half-hour ("the half-hour beginning 30 or 60 minutes after issue"),
so target 23:00 is the window 23:00–23:30. The pages label it as a historical dataset
prediction, not a live forecast.

**How the target is chosen** (`targets.py`, predictions only, never observed outcomes):

- `predicted` (default): sample dataset targets uniformly at random and keep the first the
  model predicts to have at least 20 MWh at both horizons (up to 10 tries; otherwise the
  highest prediction, and the header says the threshold was not met).
- `unfiltered`: one uniformly random dataset target, whatever its prediction.

Every response carries a `selection` record (mode, attempts, `metThreshold`,
`usesObservedOutcomes: false`, plain-language `note`) that the header chip, provenance
line and Volt use. A chosen half-hour is deliberately not typical, and the pages say so.

**One pinned target.** `GET /api/v1/scenario?selection=predicted|unfiltered` without
`target` picks a new target; the page pins it (`frontend/pinning.js`) and sends `&target=`
back, so live refreshes, Charging, Impact and Volt stay on it. The pin only moves on a
real, fresh forecast. During a model outage a pinned target gets its **own** last real
forecast for up to 30 minutes, marked `stale` (for every reader, including Volt), and
never another target's. With nothing real, the demo data is an explicitly labelled
"Offline example (simulated)" that records the `requestedTarget` it stands in for and keeps
its own unrelated time. `GRID_TO_EV_TARGET_TIMESTAMP` (default 2026-01-31T23:00Z) is only
the health probe's target.

**Recommendation.** When both outcomes share a target, the scenario plans on the most
recent (+30 min) forecast (`recommendationBasis: most-recent-forecast`) rather than the
larger of two estimates of one half-hour. Distinct targets keep the greatest-recovery rule.
Recovery is an **upper bound**: it assumes flexible load is connected where and when the
dispatch-down happens; location, local grid constraints, fleet connection, charging power
and response time can all reduce it.

**Replay admission control** (`gate.py`). Window replays (Forecast day replays, Impact day
replays and prefetches, issue-time verification) share one server-wide gate:

- one upstream replay at a time;
- identical requests share one call across clients;
- on-screen work runs before prefetches;
- a newer request from the same viewer (`client`, `seq`) drops that viewer's older
  queued work (HTTP 409);
- waits are bounded at 45 s (HTTP 503 + `Retry-After`; the page backs off and retries).

Measured on the hosted model: two viewers on different days took 13.8 s and 28.0 s
(previously ~39 s each when overlapping); superseded requests were dropped in 0.1 s.

**Page roles.** Each page has one visual job:

| Page | Job |
| --- | --- |
| Dashboard | Risk of the selected half-hour, with its two vintages |
| Forecast | Estimate vintages against observations, with uncertainty |
| Charging | Conditional absorption under EV capacity limits (#26) |
| Impact | Projected balance over time (#23) |

**Synthetic V1 scenario** (Dashboard header button). `POST /api/v1/synthetic-v1`
`{"horizon": 30|60, "scenario": "ordinary"|"high-curtailment", "issueTime": "example"|"current", "capacityMw": 100}`.
A synthetic API demonstration and stress test, not realistic current telemetry.

- It starts from the complete example request in the model's `GET /openapi.json`
  (`paths["/predict/v1/from-raw"].post.requestBody.content["application/json"].example`,
  cached for an hour). The example is checked against the document's own
  `V1RawCurrentObservation` / `V1RawHistoryObservation` schemas and the fields the
  generator relies on. On any drift nothing is sent (502 `EXAMPLE_SCHEMA_DRIFT`).
- Numeric inputs vary to 90–110% of the example (example zeros stay zero).
- The five history signals stay within January 2026 demo bounds (Ireland wind 190–3,220 MW,
  demand 3,650–5,465 MW, price €85–203/MWh, SNSP 0.31–0.70, oversupply 0 MW), which win over
  90–110%. These are demo bounds, not verified ranges for today.
- Observed past dispatch-down is 0, or 10–230 MWh for the labelled high-curtailment
  scenario (invented, not derived from the other inputs).
- There are 48 consecutive history rows before the issue time. The issue time defaults to
  the example's own disclosed date (31 Jan 2026 22:30 UTC); `current` uses the current UTC
  half-hour, but the values are still January's.
- Values stay coherent: availability ≥ generation, all-island ≥ Ireland, recomputed ratios
  in 0–1, only API-signed fields (price, interconnector flows) negative, and each :30 price
  copies the preceding :00. Availability timestamps are ≤ issue time and are synthetic
  metadata, not proof of publication.
- `synthetic.check_request` verifies these **structural** invariants before sending; it
  does not establish seasonal or physical feasibility.
- Results are labelled "Synthetic scenario — not a forecast of today's actual grid
  conditions." and are never cached, stored, charted or passed to Volt. The panel is a
  native modal `<dialog>` (focus contained, restored to the opener on close).

**Consistency evidence.** Run `node scripts/capture-consistency.mjs` (needs the server and
Chrome) to drive one headless session across Dashboard → Charging → Impact → Volt. It
saves screenshots and a `summary.json` of the pinned target each view shows to
`docs/screenshots/pr40/`.

## Charging optimizer and energy ledger

`POST /api/v1/charging/optimize` with `{"preset": "depot-and-retail"}` (or a `fleet/v1` object
under `fleet`) returns baseline and optimized vehicle-level plans for the +30 and +60 minute
forecasts of the pinned half-hour, never added together. The optimized plan shares the window's
eligible forecast energy equally between the plugged-in vehicles (max-min fair) and every plan
carries a server-checked `ledger`: eligible = allocated to chargers + real storage (0) +
unallocated, and allocated = delivered into batteries + charging loss. `GET /api/v1/charging/presets`
lists the simulated fleets. Fleets are simulated and network eligibility is unverified; window
energy is projected, not measured. See [docs/CHARGING_OPTIMIZER.md](../docs/CHARGING_OPTIMIZER.md).
