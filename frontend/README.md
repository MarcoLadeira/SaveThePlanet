# Frontend

Vanilla HTML/CSS/JS desktop UI with Overview, Forecast, Charging, Impact and Settings.

## Integrated local run

Start the GridToEv model API on port 8000, then from the SaveThePlanet root:

```powershell
python backend/server.py
```

Open http://127.0.0.1:8080. See [backend setup](../backend/README.md) for full instructions.
The backend serves the frontend and `/api/v1/scenario` on the same origin.

All four product screens use real model predictions from the latest historical dataset
issue time. They share a 30/60-minute horizon selection and explicit flexible-load
capacity scenario in MW. `model.js` handles fetching and these views; `app.js`
retains navigation and settings. `scenario.js` renders Charging and Impact using backend-derived results. Charts use the two actual
forecast points rather than extrapolating a day of forecasts.

Charging accepts total and flexible demand in kWh; Impact displays projected recovery and remaining energy from that same scenario. Each horizon is an alternative, not an additive schedule. Demand inputs reset to example defaults on reload. Settings remain in-memory UI preferences; the shared scenario power input in MW is authoritative.

The former `python -m http.server 5173` command can still serve static files, but
cannot provide the product API: the product screens will show an error there.

## Model outage demo

If GridToEv is offline or returns unusable data, the backend supplies a fixed local
example. All pages show an amber **Demo fallback — simulated data** banner;
charging inputs and calculations still work. The label cannot be disabled through
Settings. Click **Retry model** after restarting GridToEv to return to model data.
The SaveThePlanet backend must remain running. No external assets are needed.
