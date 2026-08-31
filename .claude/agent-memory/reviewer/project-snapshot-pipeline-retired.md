---
name: project-snapshot-pipeline-retired
description: CALC-005 (2026-08-31) retired the persisted snapshot calculation pipeline; what is now dead code, what must never be re-added, and the CALC-005 task-ID/requirement-ID collision
metadata:
  type: project
---

The persisted `snapshot`-pipeline (`portfolio_daily_snapshots` /
`snapshot_publications`, CALC-003/CALC-004) is RETIRED as of commit
`eaae6f8` (2026-08-31), documented in `docs/ARCHITECTURE.md` §9.3.

**Why:** production had one snapshot run permanently `running`; the Overview
loader's read-time self-heal re-claimed it on every root page load
(measured: 84 D1 calls / 160 statements per load, now 26/26), pushing the
free-plan account to 8.5M D1 row-reads/24h against a 5M/day allowance and
producing error-1102 CPU kills. Nothing read the pipeline's output —
HIST-001/HIST-002 read-time derivation already served every surface.

**How to apply when reviewing later work:**

- Nothing may queue a `snapshot`-pipeline `calculation_runs` row again
  (`db/repositories/ledger.ts`, `import-commit.ts`). `sweepCalculationRuns`
  calls `terminatePipeline("snapshot", now)` — a GLOBAL, non-user-scoped
  bulk UPDATE to `status='abandoned'`, `failure_category='pipeline_retired'`
  — reachable only from the cron `scheduled()` handler, never a request.
- `db/repositories/snapshots.ts`'s rebuild machinery, `computeSnapshotRunRange`,
  `resolveSnapshotRunRange` and `loadPublishedOverview` are deliberately
  left in place and unreachable. A diff that starts calling them again is a
  regression, not a fix.
- `app/authenticated-workspace.ts`'s overview branch must only READ
  `loadPublishedOverview`; there is no test pinning that file's source, so
  a re-added self-heal would pass CI (`tests/prf-002.test.ts` mirrors the
  loader body rather than calling it — see [[review-recurring-issues]] #3).
- `CALC-005` is BOTH a `TASKS.md` task ID (the snapshot requeue gap) and a
  stable requirement ID in `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md`
  ("CALC-005 — Daily movement"). Related: `CALC-006 — Portfolio history`
  still carries acceptance bullets describing the now-unreachable pipeline
  (staged run identity, atomic publication switch, pinned calendar
  evidence). That doc was never updated for HIST-001/HIST-002 either.
