---
name: hist-001-no-batch-invariant
description: app/historical-portfolio-value.ts is pinned to never call client.batch()/client.run() -- blocks any batch()-based rows_read optimization there.
metadata:
  type: project
---

`app/historical-portfolio-value.ts` (the HIST-001 read-time historical
valuation feature: Overview graph, Multi-Year FY-end baseline) is
architecturally pinned to be SELECT-only. Its own module header states:
"This module ONLY reads (`client.all`/`client.get`); it never calls
`client.run`/`client.batch`, so no D1 write budget is ever spent serving a
view." `tests/hist-001.test.ts` ("HIST-002: app/historical-portfolio-value.ts
writes ONLY through the dedicated portfolio-value-history repository")
asserts `doesNotMatch(source, /client\.batch\(/)` and `/client\.run\(/`
directly against the file's source text.

This means: even though D1's `batch()` can run pure SELECT statements, this
codebase treats `client.batch()` as touching D1's "write budget"/write-path
API surface as a matter of policy, and forbids it categorically in this one
read-only module — not because a specific batch of SELECTs would actually
write anything, but as a hard separation-of-concerns boundary.

**Why this matters**: PRF-005 recorded (and PRF-006 confirmed via
EXPLAIN QUERY PLAN) that `loadFacts`'s multi-window OR'd
`price_observations`/`fx_rate_observations` query (used by
`loadHistoricalPortfolioValueAtDates`, feeding `/income` and
`/income/multi-year`) drops `market_date` from its 3-column index seek once
2+ windows are OR'd together — D1's own `rows_read` metering stays
essentially unchanged even though PRF-005's fix bounded rows
RETURNED/marshalled. The obvious fix (split into one narrow per-window
statement each, sent together via `client.batch()` in ONE round trip) is
blocked by this exact invariant. Do not implement it without either (a) an
explicit Orchestrator decision to relax the rule for this one file/query
with the D1-billing rationale re-examined, or (b) a genuinely different
approach — e.g. `Promise.all` of separate `client.all()` calls (avoids
`client.batch()`, stays one "depth" wave per `depthCensusClient`'s
semantics, but spends N separate D1 subrequests per call instead of 1,
which risks the Workers subrequest-limit on Free plan at higher
`yearsBack`/security counts — a different, real trade-off, not a free win).

See also [[prf-census-batch-harness-gap]].
