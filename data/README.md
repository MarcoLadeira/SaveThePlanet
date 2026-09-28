# Data

Store only safe, lightweight data assets in Git.

Document every dataset with:
- source;
- licence/usage notes;
- fields and units;
- geography;
- time resolution;
- whether values are observed, derived or simulated.

Do not commit private, licensed-restricted or very large raw datasets.

## Datasets

- `fleets/presets-v1.json`: **simulated** EV fleets for the charging optimizer (fleet/v1 schema).
  Hand-written for the demo; no real vehicles, drivers or chargers. Times are minutes relative to
  the forecast issue time; energy in kWh, power in kW; 30-minute resolution; region Ireland.
