---
name: prf-census-batch-harness-gap
description: tests/prf-002.test.ts's stageCensusClient historically didn't capture client.batch() statements into stats.calls_, so EXPLAIN/filter-based assertions silently miss any code path that uses batch(). Fixed in PRF-006, but check before trusting a census.
metadata:
  type: project
---

`tests/prf-002.test.ts`'s `stageCensusClient` wraps a `SqlClient` to record
every `all`/`get`/`run` call into `stats.calls_` (sql+params, used by the
EXPLAIN-QUERY-PLAN scan-check test and by per-test filters like
`stats.calls_.filter(call => call.sql.includes("price_observations"))`).
Before PRF-006, its `batch()` handler updated `stats.calls`/`stats.statements`
but never pushed into `stats.calls_` — so any code path that moved a query
from `client.all()` to `client.batch()` would silently vanish from every
`calls_`-driven assertion, not because the regression guard passed but
because it never saw the query. This was recorded as CALC-005's own review
follow-up (a): "the census client misses batch calls."

PRF-006 fixed the harness (pushes each batched statement's sql/params into
`calls_`, without double-counting `stats.calls`/`stats.statements`), but this
matters generally for future PRF-work in this repo: before trusting a census
number or an EXPLAIN-scan-check "all clear," check whether the code path
under test uses `client.batch()` anywhere, and confirm the harness actually
saw it (statements should show up in `stats.calls_` with the expected SQL).
`depthCensusClient` (the separate depth/critical-path harness) already
handled `batch()` correctly before this fix — only `stageCensusClient` had
the gap.

See also [[hist-001-no-batch-invariant]] for why `app/
historical-portfolio-value.ts` specifically can never exercise this path
(it's banned from calling `client.batch()` at all).
