# Frontend

Vanilla HTML/CSS/JS desktop UI with Overview, Forecast, Charging, Impact and Settings.

## Integrated local run

Start the GridToEv model API on port 8000, then from the SaveThePlanet root:

```powershell
python backend/server.py
```

Open http://127.0.0.1:8080. See [backend setup](../backend/README.md) for full instructions.
The backend serves the frontend and `/api/v1/forecast` on the same origin.

Overview and Forecast use real model predictions from the latest historical dataset
issue time. They share a 30/60-minute horizon selection and explicit flexible-load
capacity scenario in MW. `model.js` handles fetching and these views; `app.js`
retains navigation, settings and the other demo screens. Charts use the two actual
forecast points rather than extrapolating a day of forecasts.

Charging and Impact remain hard-coded demo screens. Settings are in-memory UI
preferences; charging rules do not control the model's flexible-load scenario.

The former `python -m http.server 5173` command can still serve static files, but
cannot provide the product API: Overview and Forecast will show an error there.
