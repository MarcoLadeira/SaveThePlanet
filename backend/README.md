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

## Verification

```powershell
python -m unittest discover -s backend/tests -v
node --check frontend/model.js
node --check frontend/app.js
```

Manual: inspect all four screens, switch 30/60 minutes, set capacity to 0.1 MW
(100 kW, so recovery cannot exceed 0.05 MWh), stop the model and refresh to verify
the simulated fallback banner, restart the model and click Retry model. Charging and Impact should
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
The UI shows a permanent amber banner on every page while fallback is active;
Settings cannot suppress it. Refresh forecast / Retry model always tries the
model again, clearing the banner on success. There is no background retry timer.

The fixture has fixed timestamps, probabilities and energy values (0.35 and
0.80 MWh), not random data or a cached successful request. The same input produces
the same predictions, recovery values and scenario ID. Only `generatedAt` changes.
User capacity and charging demand are preserved and validated in fallback mode.

Default upstream socket timeout: 3 seconds; configurable in the range (0, 10]
seconds. The browser request timeout is 15 seconds. This fallback protects against
model outages; the local SaveThePlanet backend must still be running.

Rehearsal: start only `python backend/server.py` with GridToEv stopped, open the
app, check the banner on each page and edit charging demand. Start GridToEv and
click Retry model; the banner disappears and the entered assumptions remain.

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
the health codes above are the finer-grained explanation. The fallback banner shows
the health message, and Settings → Model connection shows the full status with a
**Check connection** button (active probe) and **Reload forecast**.
