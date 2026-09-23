# Overview and Forecast integration

This first slice connects Overview and Forecast only. Charging, Impact and their
settings remain the original UI demo. No model retraining or fleet scheduler is included.

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
$env:GRID_TO_EV_TIMEOUT_SECONDS = '10'
$env:API_PORT = '8080'
python backend/server.py
```

An optional `GRID_TO_EV_API_KEY` is sent as a Bearer token by the backend only.
The current GridToEv API does not require authentication.

## Contract and scope

The browser calls `GET /api/v1/forecast?region=Ireland&capacityMw=100`.
The adapter calls GridToEv's synchronous `GET /predict/latest`, validating both
30/60-minute predictions before mapping them to product fields. Both screens use
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
- Recovery = min(predicted dispatch-down MWh, capacity MW * 0.5 hours).
- The default 100 MW is a flexible-load scenario, not observed EV availability.
- Component shares are predicted energy shares, not explanations of model reasoning.
- Risk is event risk, not confidence; the uncertainty fields provide P10/P50/P90.
- Timestamps are returned in UTC and displayed using the UI timezone preference.
- No 24-hour extrapolation, live feed, EV schedule, or measured recovery is claimed.
- Unsupported model signals are marked unavailable.

Invalid region/capacity yields HTTP 400 with `error.code=INVALID_REQUEST`.
Connection/timeout/non-2xx failures yield HTTP 502 with `MODEL_UNAVAILABLE`;
malformed or inconsistent upstream data yields HTTP 502 with `INVALID_MODEL_RESPONSE`.
The UI clears old values and offers retry. Automatic demo fallback and the remaining
issue #12 endpoints are deferred; failures are never silently replaced with demo values.

## Verification

```powershell
python -m unittest discover -s backend/tests -v
node --check frontend/model.js
node --check frontend/app.js
```

Manual: inspect both screens, switch 30/60 minutes, set capacity to 0.1 MW
(100 kW, so recovery cannot exceed 0.05 MWh), stop the model and refresh to verify
the error state, restart the model and retry. Charging and Impact should still
show their original demo content.
