# Architecture

## Target hackathon architecture

```text
Energy / weather / grid data
          │
          ▼
   Data ingestion layer
          │
          ▼
 AI forecasting / scoring
          │
          ▼
 Backend API + domain logic
          │
    ┌─────┴───────────┐
    ▼                 ▼
Frontend          Impact calculations
Dashboard         + EV translation
Forecast
Charging
Impact
```

## Suggested boundaries

### frontend/
Presentation, charts, user interaction and demo states.

### backend/
API endpoints, application orchestration, validation, configuration and the contract between UI/data/model layers.

### ai/
Feature preparation, forecasting experiments, inference logic, evaluation and model notes.

### data/
Schemas, public/synthetic samples and source documentation. Large/private/raw datasets should stay out of Git.

## Design goals

- Replaceable model implementation.
- Thin, explicit API contracts.
- Deterministic demo fallback if a live dependency fails.
- Clear provenance for displayed values.
- No secrets in source control.
- Easy local startup.

## Reliability strategy

For the final demo, retain a known-good sample scenario so the core story still works if an external API or network dependency fails.
