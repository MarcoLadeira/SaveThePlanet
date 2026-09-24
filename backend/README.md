# Shared forecast and charging scenario

Overview, Forecast, Charging and Impact share one forecast and charging scenario. Settings remain UI preferences; no model retraining or vehicle scheduler is included.

## Start locally

1. Start GridToEv in its repository using its installed Python environment:

   ```powershell
   cd C:\Users\jerry\source\repos\GridToEv
   .\.venv\Scripts\python.exe -m uvicorn gridtoev.api:app --app-dir src --host 127.0.0.1 --port 8000
   ```

2. In another terminal, from SaveThePlanet:

   ```powershell
   python backend/server.py
   ```

3. Open http://127.0.0.1:8080. This server hosts both the frontend and product API;
   no frontend build, extra Python dependencies, or CORS setup is needed.
   Do not use the standalone port-5173 static server for the integrated screens.

Configuration uses process environment variables (a `.env` file is not auto-loaded):

```powershell
$env:GRID_TO_EV_API_BASE_URL = 'http://127.0.0.1:8000'
$env:GRID_TO_EV_TIMEOUT_SECONDS = '3'
$env:API_PORT = '8080'
python backend/server.py
```

An optional `GRID_TO_EV_API_KEY` is sent as a Bearer token by the backend only.
The current GridToEv API does not require authentication.

## Contract and scope

The browser calls `GET /api/v1/scenario?region=Ireland&capacityMw=100&totalDemandKwh=1000&flexibleDemandKwh=500`. The original `/api/v1/forecast` endpoint remains available for capacity-only predictions.
The adapter calls GridToEv's synchronous `GET /predict/latest`, validating both
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
A missing health endpoint and other remaining issue #12 work are separate tasks.
