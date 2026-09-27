# Frontend

Desktop UI for the renewable energy and EV charging planner. Dashboard, Forecast, Charging, Impact, and Settings share the same navigation, typography, 3D visual language, horizon controls, and light/dark appearance.

![Dashboard preview](../docs/screenshots/dashboard.png)

## Integrated local run

Configure the hosted model in the project-root `.env`, then double-click `Start-App.cmd` on Windows. Alternatively, from the SaveThePlanet root:

```powershell
python backend/server.py
```

Open http://127.0.0.1:8080. See [backend setup](../backend/README.md) for full instructions.
The backend serves the frontend and `/api/v1/scenario` on the same origin.

The four data screens use the same `/api/v1/scenario` response. `model.js` fetches
and validates it; `scenario.js` reads the backend-derived charging outcomes;
`studio.js` renders the screens with shared components; `app.js` owns navigation
and local presentation preferences. The 30- and 60-minute predictions are
historical model targets, not a live 24-hour forecast. Each result describes a
separate half-hour interval and the two outcomes must not be added together.

Charging accepts total and flexible demand in kWh; Impact displays projected
recovery and remaining energy from that same scenario. Demand inputs reset to
labelled example defaults on reload. Display settings persist in local storage;
the shared flexible-capacity input in MW is authoritative. The API does not
provide vehicle counts, commitments, actual charging or financial savings, so
the UI makes none of those claims.

The former `python -m http.server 5173` command can still serve static files, but
cannot provide the product API: the product screens will show an error there.

## Model outage demo

If GridToEv is offline or returns unusable data, the backend supplies a fixed local
example. The page footer labels results as a simulated fallback;
charging inputs and calculations still work. Settings → Model connection explains
why the model is unavailable, from `/api/v1/health`.
Click **Reload forecast** there after restarting GridToEv to return to model data.
The SaveThePlanet backend must remain running. No external assets are needed.

## Settings

Settings reads its facts from the API rather than hard-coded text: region, energy
interval and forecast targets come from the forecast response; charging inputs and
scenario ID are the values the backend actually used; *About this workspace* lists
the backend scenario methodology; *Model connection* shows `/api/v1/health` (status,
reason code and explanation, model version, response time, last check, service type,
whether an API key is set) plus the data mode and last-updated time. Timezone,
appearance and the display toggles remain local preferences.

## Charging page

`charging.js` renders the Charging page from the shared scenario:

- **Recommended action** states the charging window, recoverable MWh, EV charges and
  chargers needed in one sentence, with a button to switch to the recommended target.
  When nothing can be recovered it says why instead. Demo data is tagged "Example data".
- The target chart marks the **Recommended** horizon (also on Impact).
- **Charging assumptions** edits total and flexible demand (kWh, with the MWh
  conversion shown) and the EV assumptions (energy per charge in kWh, charger power
  in kW). Invalid values are flagged next to the field before any request is sent.
- **How this is calculated** lists the backend methodology and unit conventions.
- Impact repeats the same EV charge figure for the selected target.
