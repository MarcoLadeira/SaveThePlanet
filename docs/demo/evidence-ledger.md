# Evidence ledger · every number in the deck (issue #70)

Checked on `main` (29 Sep 2026). The two charts are drawn from real data files in `docs/demo/data/`,
copied from files already committed by the team. "Deterministic" means the backend computes it from fixed
inputs, the same on every machine. Numbers read off the screen recordings are listed at the end.

| ID | Slide | Value | Status | Where it comes from |
| --- | --- | --- | --- | --- |
| E1 | 1 | 11.2% of wind + solar dispatched down, January to June 2026 (wind alone 13.2%) | External, cited | [EirGrid statement on renewable integration and dispatch-down, 28 Jul 2026](https://www.eirgrid.ie/news/eirgrid-statement-renewable-integration-and-dispatch-down); reported the same day by [RTÉ](https://www.rte.ie/news/2026/0728/1585436-wind-energy-electricity-grid/). Open the EirGrid page once before presenting (our build machine couldn't reach it; two independent search results confirmed the figures). |
| E2 | 2 | Sunday 10 May 2026: 6,917 MWh curtailed (wind 4,353, solar 2,564), from about 08:00 to 17:30 Irish time; 345,000 = 6,917 MWh ÷ 20 kWh | **Recorded**, real | `data/recorded-2026-05-10.json`, copied from `backend/tests/fixtures/sources/recorded-2026-05-10.json`: GridToEv's `/sources/day` response built from EirGrid's half-hourly dispatch-down workbooks (curtailment rows, Ireland). Timestamps are UTC; Irish summer time is UTC+1. Evening peak 17:00–19:00: SEAI, cited in issue #56. |
| E3 | 3, 4 | The four checks: surplus soon, site limits, cheaper than smart charging, the split | Working prototype | `backend/server.py` (GridToEv forecasts), `backend/optimizer.py`, `backend/offers.py`. |
| E4 | 4, 6 | Historical replay, not live forecasts; targets chosen from predictions only | Working prototype | `backend/server.py`, `backend/targets.py`. |
| E5 | 5 | 1,434 half-hours of +30-minute predictions, 2–31 Jan 2026; 59,532 MWh expected at risk over the month; 16,941 MWh on 11 January | **Model predictions**, real | `data/forecast-2026-01-plus30.json`, copied from `backend/.cache/v1-plus30-index-1.1.0-1434.json` (GridToEv V1 model 1.1.0, committed by the team). Six half-hours have no prediction (blank). Predictions, not outcomes. |
| E6 | 6 | No look-ahead: offers locked 30 min before a window; +60 forecasts never added to +30 | Working prototype, tested | `offers._forecast_30`, `offers._lock`; `backend/tests/test_offers.py`. |
| E7 | 7 | 18 cars; 10 chargers: 6 × 22 kW at a depot (100 kW limit), 4 × 11 kW at a car park (30 kW limit) | Simulated fleet | `data/fleets/presets-v1.json`, preset `depot-and-retail`, the EV page's default (`server.DAY_PLAN_PRESET`). Each car has its own arrival, departure and energy need. |
| E8 | 7 | The plan never goes over a site's power or charger count, or a car's charging rate | Working prototype, tested | `optimizer.check_plan` (hard constraints); the EV page's day plan uses the same optimizer (`backend/dayplan.py`). |
| E9 | 8, 11 | Example public hub: 40 × 22 kW chargers, 600 kW; battery 2,000 kWh, 500 kW, 92% × 92% (85% round trip), wear €0.04/kWh | Simulated hub, **hypothetical** battery | `offers.HUB`, `offers.BATTERY`. `optimizer.py` models real storage as 0. |
| E10 | 8 | Tariff: night €0.16, day €0.26, peak €0.34, surplus credit €0.08/kWh | Illustrative | `business.TARIFF`, ex VAT. |
| E11 | 8 | All-in €0.1995/kWh; smart charging €0.34 (evening peak), €0.26 (surplus live), €0.16 (morning); evening savings €0.14 and €0.06 | Deterministic | `offers.delivered_cost(0.08 / 0.92)`, `offers.basic_smart_price` (a 22 kW charger fits 20 kWh inside 07:00–08:00 at the night rate, so mornings get reason `not-cheaper`). |
| E12 | 10 | €2.00 pool → €1.00 driver, €0.50 operator, €0.50 SaveThePlanet | Deterministic, tested | `offers.settle_session(20, 0.34, 0.24)`; issue #56 worked example. |
| E13 | 10 | 400 × 20 kWh × €0.10 = €800: drivers €400; operator €200 − €100 = +€100 (break-even 200); SaveThePlanet €200 − €40 − €120 = +€40 (break-even 300) | Illustrative pilot, deterministic, tested | `offers.monthly(400, 20, 0.10)`; the Impact page's "400 sessions" preset. €0.10 sits between the evening savings in E11. |
| E14 | 11 | 8,000 kWh into cars; ≈9,450 kWh stored; ≈1,450 kWh (15%) lost | Arithmetic on E9, E13 | 8,000 ÷ (0.92 × 0.92) = 9,452. |
| E15 | 11 | ≈2 t CO₂ a month per site | **Estimate**, not verified | 8,000 kWh × `business.GRID_KG_PER_KWH` (0.25). Assumes the stored surplus would otherwise have been dispatched down. |
| E16 | 12 | Per site a year: drivers €4,800, operators €1,200, CO₂ 24 t; ×10 and ×100 | Illustrative, capacity-capped | E13 and E15 × 12 months × sites. Not a forecast or a pipeline. |
| E17 | 13 | 420 automated tests (349 backend incl. 8 hosted-model checks, 71 frontend) | Measured | `python -m unittest discover -s backend/tests`; `node --test frontend/tests/*.test.js`; CI on every PR. |

## Read off the recordings (fill in when you record)

These depend on the GridToEv model and the replay day you pick, so they are not on the slides. Say them only
if they are on screen.

| What | Value | Recording |
| --- | --- | --- |
| Replay day and half-hour used on every page | | 1–3 |
| Forecast at that half-hour (MWh at risk, +30 min) | | 2 |
| EirGrid's recorded curtailment at that half-hour | | 2 |
| Fleet energy charged on renewables (kWh) | | 3 |
| Evening offer on the Rewards card: price, discount, split | | 4 |
