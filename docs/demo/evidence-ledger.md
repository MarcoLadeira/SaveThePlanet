# Evidence ledger · every number in the deck (issue #70)

Checked on `main` at `b054f43` (29 Sep 2026). "Deterministic" means the backend computes it from fixed
inputs, whatever the model returns, so it is the same on every machine. Nothing in the deck comes from a
model run; numbers you read off the recordings are listed at the end and must be written down when you record.

| ID | Shown as | Value | Status | Where it comes from |
| --- | --- | --- | --- | --- |
| E1 | Slide 1 hook | 11.2% of wind + solar dispatched down, H1 2026 (wind alone 13.2%) | External, cited | [EirGrid statement on renewable integration and dispatch-down, 28 Jul 2026](https://www.eirgrid.ie/news/eirgrid-statement-renewable-integration-and-dispatch-down); reported the same day by [RTÉ](https://www.rte.ie/news/2026/0728/1585436-wind-energy-electricity-grid/). Open the EirGrid page once before presenting: our build machine could not reach it, and the figures were confirmed through two independent search results. |
| E2 | Slide 2 | Dispatch-down covers surplus, system security and local network constraints | External, cited | Same EirGrid statement; [EirGrid constraint-group overview](https://cms.eirgrid.ie/wind-dispatch-tool-constraint-group-overview-0). |
| E3 | Slide 3 | Predict → prove → decide → share | Working prototype | `backend/server.py` (GridToEv `/predict/from-dataset`), `backend/optimizer.py`, `backend/offers.py`, `frontend/*`. |
| E4 | Slide 4 | +30-minute forecasts; historical dataset predictions, not live forecasts | Working prototype, historical replay | `backend/server.py` (target selection comment), `backend/targets.py` (targets chosen from predictions only, never outcomes). |
| E5 | Slides 4, 6 | No look-ahead: offers locked 30 min before a window; +60 forecasts never added to +30 | Working prototype, tested | `offers._forecast_30`, `offers._lock`; `backend/tests/test_offers.py`. |
| E6 | Slide 5 | 20 × 11 kW chargers, 180 kW connection | Simulated example site | `business.FLEET`. |
| E7 | Slide 5 | 22 kWh max per charger in 2 h; 16 sessions of 20 kWh per window | Deterministic | `offers.max_session_kwh()` = 22, `offers.site_session_cap(20)` = 16 (energy-bridge plan). |
| E8 | Slides 5, 9 | Battery 700 kWh, 180 kW, 92% × 92% (85% round trip), wear €0.04/kWh | **Hypothetical**, not built | `offers.BATTERY`. `optimizer.py` models real storage as 0. |
| E9 | Slide 6 | Tariff: night €0.16, day €0.26, peak €0.34, surplus credit €0.08/kWh | Illustrative | `business.TARIFF`. Ex VAT. |
| E10 | Slide 6 | AI all-in €0.1995/kWh; smart charging €0.34 (evening), €0.26 (evening with surplus forecast), €0.205 (morning); savings €0.14 / €0.06 / €0.005 | Deterministic | `offers.delivered_cost(0.08 / 0.92)`, `offers.basic_smart_price`. Morning windows get reason `too-small` (the saving can't cover the €0.10 platform cost per session). |
| E11 | Slide 7 | €2.00 pool → €1.00 / €0.50 / €0.50; −€0.10 cost → €0.40 contribution | Deterministic, tested to the cent | `offers.settle_session(20, 0.34, 0.24)`; issue #56 worked example; `SettlementTests`. |
| E12 | Slide 8 | 400 × 20 kWh × €0.10 = €800; drivers €400; operator €200 − €100 = **+€100** (break-even 200); SaveThePlanet €200 − €40 − €120 = **+€40** (break-even 300) | Illustrative pilot assumptions, deterministic, tested | `offers.monthly(400, 20, 0.10)`; the Impact page's "400 sessions" preset. If the replay caps the preset, the card says so; say "the replay found room for N of them". |
| E13 | Slide 8 | About 13 sessions an evening vs 16 the site fits | Arithmetic | 400 ÷ 30 days; E7. |
| E14 | Slide 9 | 8,000 kWh delivered; ≈9,450 kWh drawn into storage; ≈1,450 kWh (15%) lost | Arithmetic on E8, E12 | 8,000 ÷ (0.92 × 0.92) = 9,452. |
| E15 | Slide 9 | ≈2 t CO₂ a month per site (≈24 t a year) | **Estimate**, not verified | `business.GRID_KG_PER_KWH` = 0.25 (the app's flat factor) × 8,000 kWh. Assumes the stored surplus would otherwise have been dispatched down. |
| E16 | Slide 10 | 100 sites a year: €480k drivers, €120k operators, €48k SaveThePlanet, ≈2,400 t CO₂ | Illustrative, capacity-capped | E12 and E15 × 100 sites × 12 months. Not a forecast or pipeline. |
| E17 | Slide 11 | 406 automated tests (340 backend incl. 8 hosted-model checks, 66 frontend) | Measured | `python -m unittest discover -s backend/tests`; `node --test frontend/tests/*.test.js`; CI on every PR. |

## Read off the recordings (fill in when you record)

These depend on the GridToEv model and the chosen replay day, so they are **not** on the slides. Say them
only if they are on screen.

| What | Value | Clip / time |
| --- | --- | --- |
| Frozen replay day and half-hour | | CLIP 1–3 |
| Forecast energy at risk at that half-hour (MWh, +30 min) | | CLIP 2 |
| Observed curtailment at that half-hour (MWh) | | CLIP 2 |
| Fleet energy charged on renewables (kWh) | | CLIP 3 |
| Evening offer shown on the Rewards card: price, discount, split | | CLIP 4 |
