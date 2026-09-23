# Product Definition

## Problem

Renewable generation can be curtailed or constrained when the electricity system cannot use or transport all available power. That creates periods where clean electricity is effectively lost.

## Product hypothesis

If we can forecast likely wasted renewable energy early enough, we can expose a practical window for flexible demand — starting with EV charging — and quantify the benefit.

## Primary user story

> As an energy/flexibility operator, I want to know when and how much renewable energy is likely to be wasted so I can schedule EV charging into the best window and understand the resulting impact.

## Core experience

### 1. Dashboard
Answer immediately:
- What is happening now?
- How much renewable energy is at risk?
- What can we recover?
- What does that mean for EV charging?

### 2. Forecast
Show:
- expected curtailment/constraint window;
- forecast recoverable energy;
- confidence;
- important model inputs/signals;
- timeline of upcoming opportunities.

### 3. Charging
Translate energy into:
- recommended charging window;
- usable MWh;
- approximate EV charging capacity;
- charging plan/status.

### 4. Impact
Show:
- renewable energy recovered;
- clean charging enabled;
- estimated avoided emissions;
- cumulative and event-level impact;
- methodology/assumptions.

## MVP boundary

The hackathon MVP should prove the complete loop:
`forecast waste → quantify recoverable energy → recommend EV charging → show impact`.

Anything that does not strengthen that loop is secondary.

## Data integrity

The UI must distinguish:
- observed values;
- model predictions;
- calculated/derived values;
- simulated demo data.

Never present simulated values as live operational measurements.
