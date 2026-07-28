# YieldToMe documentation index

Status: consolidated foundation set  
Date: 2026-07-28

## Normative documents

Read these in order:

1. `CONSOLIDATED_PRODUCT_SPEC.md` — confirmed/inferred requirements, assumptions, uncertainties, screens, workflows, and all product states.
2. `REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — stable requirement IDs and testable outcomes.
3. `ARCHITECTURE.md` — Cloudflare/Vinext design, authentication, isolation, providers, history, offline, and operations.
4. `DATA_MODEL.md` — proposed D1 entities, constraints, indexes, invariants, and migration rules.
5. `MARKET_DATA_STRATEGY.md` — provider comparison, licensing/cost gate, chosen first integration, abstraction, caching, and lifecycle.
6. `CALCULATIONS.md` — decimal, FX, FIFO, value, movement, history, returns, and dividends.
7. `CSV_IMPORT_SPEC.md` — exact 17-column format, row grammar, mapping, validation, idempotency, and reversal.
8. `IMPLEMENTATION_PLAN.md` — phase gates, dependencies, traceability, risks, and release strategy.
9. Root `TASKS.md` — session-sized executable backlog.
10. Root `AGENTS.md` — engineering rules and definition of done.

When a source note and a normative document differ, the normative set governs implementation. Record any intentional decision change in the relevant normative document and `AGENTS.md` decision log.

## Preserved source evidence

- `01_SCREEN_INVENTORY_AND_NAVIGATION.md`
- `02_DATA_MODEL_AND_CSV.md`
- `03_CALCULATIONS_AND_INTERFACE.md`
- `04_VIDEO_UNKNOWNS_AND_REBUILD_PLAN.md`
- `YieldToMe_Visual_Style_Guide.md`
- `Example_Portfolio.csv`

These files capture observations, inferences, and earlier proposals from the reference app. Preserve them for traceability. They are not themselves an implementation backlog.

## Reference-content rule

The screenshots/video and example CSV are independent reference fixtures. Their portfolio names, transactions, quantities, prices, and totals are not expected to match and must never be reconciled against each other or treated as contradictory product evidence. The visual references define layout/workflow examples; the supplied 17-column CSV is the complete supported import contract.
