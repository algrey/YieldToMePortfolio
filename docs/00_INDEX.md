# YieldToMe documentation index

Status: consolidated foundation set  
Date: 2026-07-28  
Last reorganised: 2026-08-10 (source evidence moved into `source-evidence/`; index extended to cover operational and preview evidence added since the original consolidation)

## Normative documents

Read these in order:

1. `CONSOLIDATED_PRODUCT_SPEC.md` — confirmed/inferred requirements, assumptions, uncertainties, screens, workflows, and all product states.
2. `REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — stable requirement IDs and testable outcomes.
3. `ARCHITECTURE.md` — Cloudflare/Vinext design, authentication, isolation, providers, history, offline, and operations.
4. `DATA_MODEL.md` — proposed D1 entities, constraints, indexes, invariants, and migration rules.
5. `MARKET_DATA_STRATEGY.md` — technical provider comparison, chosen first integration, abstraction, caching, and lifecycle.
6. `CALCULATIONS.md` — decimal, FX, FIFO, value, movement, history, returns, and dividends.
7. `CSV_IMPORT_SPEC.md` — exact 17-column format, row grammar, mapping, validation, idempotency, and reversal.
8. `IMPLEMENTATION_PLAN.md` — phase gates, dependencies, traceability, risks, and release strategy.
9. Root `TASKS.md` — session-sized executable backlog grouped by workstream, with dependency fields defining execution order.
10. Root `AGENTS.md` — engineering rules and definition of done.

When a source note and a normative document differ, the normative set governs implementation. Record any intentional decision change in the relevant normative document and `AGENTS.md` decision log.

## Preserved source evidence

- `source-evidence/01_SCREEN_INVENTORY_AND_NAVIGATION.md`
- `source-evidence/02_DATA_MODEL_AND_CSV.md`
- `source-evidence/03_CALCULATIONS_AND_INTERFACE.md`
- `source-evidence/04_VIDEO_UNKNOWNS_AND_REBUILD_PLAN.md`
- `source-evidence/YieldToMe_Visual_Style_Guide.md`
- `Example_Portfolio.csv` — kept in `docs/` (not `source-evidence/`) because it is an active fixture read at runtime by `app/preview-portfolio-fixture.ts` and by `tests/imports.test.ts`, not only a historical reference.

These files capture observations, inferences, and earlier proposals from the reference app. Preserve them for traceability. They are not themselves an implementation backlog.

## Prototype review evidence

- `UI_SPEC.md` — provisional typography, density, spacing, responsive, state, interaction, and mobile-information rules for owner review. It is not approved production UI guidance until its status is updated after feedback.
- `ui-captures/` — 390 px principal-screen renders plus 320 px, 430 px, and desktop Holdings breakpoint evidence.

## Operational runbooks and evidence

- `OPS-002_BACKUP_RESTORE_RUNBOOK.md` — backup/restore procedure and non-production restore discipline.
- `OPS-002_DRILL_RECORD_2026-08-03.md` — dated record of the OPS-002 restore drill (RPO/RTO, verification results).
- `OPS-003B_VERIFIED_DELETION_RUNBOOK.md` — verified account-deletion/offboarding runbook.
- `QA-001A_SECURITY_MATRIX.md` — route/repository ownership matrix, Access-token failure matrix, CSRF/header/CSP review, dependency audit, and manual threat checklist.
- `QA-001B_ACCESSIBILITY_AUDIT.md` — accessibility/responsive automated evidence, fixed defects, and the named owner-run manual checklist folded into QA-002.
- `QA-002_RELEASE_READINESS.md` — release-readiness record: dependency completeness, automated quality gate, preview route/mutation smoke, supplied-CSV/calculation reconciliation, restore/deletion drills, redacted observability evidence, owner-run checklist, and the go/no-go decision.

## Preview deployment evidence

- `PREVIEW_DEPLOYMENT.md` — how the read-only fixture preview (`VSL-006`) is built, run, and reviewed.
- `PREVIEW_EVIDENCE.json` — capture manifest (routes, fixture assertions, screenshot paths, smoke results) for the preview deployment.
- `preview-evidence/` — 320/390/430 px screenshots of the preview overview/holdings/detail routes referenced by `PREVIEW_EVIDENCE.json`.

This evidence is distinct from `UI_SPEC.md` and `ui-captures/` above: `ui-captures/` documents the earlier static-prototype review (`UI-PROT-001`), while `preview-evidence/` documents the later deployed read-only fixture preview (`VSL-006`). Neither supersedes the other; both remain current evidence for their respective tasks.

## Reference-content rule

The screenshots/video and example CSV are independent reference fixtures. Their portfolio names, transactions, quantities, prices, and totals are not expected to match and must never be reconciled against each other or treated as contradictory product evidence. The visual references define layout/workflow examples; the supplied 17-column CSV is the complete supported import contract.
