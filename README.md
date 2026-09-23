# Hack the Climate 2026 — AI Energy Recovery Project

> Working repository. The final product name has intentionally **not** been chosen yet.

## Mission

Build an AI-powered system that identifies renewable electricity likely to be lost through **curtailment and grid constraints**, quantifies the recoverable energy, and turns that insight into an actionable EV-charging opportunity.

**Core flow**

`Grid & renewable data → AI forecast → recoverable energy → EV charging recommendation → measurable climate impact`

## What we are building

The hackathon prototype is organised around four product areas:

- **Dashboard** — a clear live overview of renewable generation, predicted wasted energy, recovered opportunity and EV charging impact.
- **Forecast** — AI predictions for upcoming curtailment/constraint windows, confidence and the signals driving the forecast.
- **Charging** — translates recoverable energy into practical EV charging capacity and recommended charging windows.
- **Impact** — demonstrates why the intervention matters: clean energy recovered, EV charging enabled and emissions impact.

## Why it matters

Renewable electricity can be available but unusable because the grid cannot always move or absorb it where and when it is generated. Our prototype focuses on forecasting those windows early enough to make the energy useful instead of simply reporting the waste after it happens.

## Repository structure

```text
.
├── frontend/              # Product UI
├── backend/               # APIs, orchestration and application services
├── ai/                    # Forecasting / optimisation experiments and model code
├── data/                  # Data notes, schemas and non-sensitive sample data
├── docs/                  # Architecture, product, demo and decision docs
└── .github/               # CI and collaboration templates
```

## Hackathon principles

1. **Demo first** — every feature should strengthen the end-to-end story.
2. **One clear outcome** — show how AI converts forecasted wasted renewable energy into EV charging value.
3. **Real data where possible** — clearly mark simulated or derived values.
4. **Explain the AI** — predictions should expose confidence and key inputs, not act as a black box.
5. **Keep the UI simple** — the audience should understand the problem and result in seconds.
6. **Never commit secrets** — use `.env` locally and document variables in `.env.example`.

## Getting started

The implementation stack is still intentionally open while the team finalises the fastest hackathon architecture.

1. Clone the repository.
2. Create a branch from `develop`.
3. Work inside the relevant top-level area.
4. Keep PRs small and linked to an issue.
5. Update setup instructions as soon as the stack is locked.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the team workflow and [docs/PRODUCT.md](docs/PRODUCT.md) for the current product definition.

## Branching

- `main` — demo-ready / stable
- `develop` — integration branch
- `feature/<short-name>` — feature work
- `fix/<short-name>` — fixes

## Current status

**Hackathon foundation / pre-build.** Product direction is defined; implementation tasks are tracked in GitHub Issues.

## Team

Team members will be added here once GitHub usernames and responsibilities are confirmed.

---

Built for **Hack the Climate 2026**.
