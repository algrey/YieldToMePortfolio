---
name: per-invocation-budget-scope
description: Moving statements out of an atomic unit does not remove them from the per-invocation budget — resize the invocation bound at the documented ceiling, not at the common path.
metadata:
  type: project
---

When a fix defers statements out of an atomic `client.batch()` into separate follow-up batches, the per-invocation bounds (`maxQueriesPerInvocation` / `maxStatementsPerInvocation`) still count every one of them. Fixing `maxStatementsPerAtomicUnit` while leaving the invocation bounds at their old value just relocates the overflow — this is exactly what failed BUG-016 review round 2.

**Why:** these constants are asserted by budget tests that run the COMMON fixture (2 trades, no dividend portfolios), so a bound sized for the common path passes its test while being wrong for any real batch. `IMPORT_REVERSAL_LIMITS` was 56 and already exceeded at 6 dividend-bearing portfolios.

**How to apply:** size and pin every per-invocation bound at the module's own documented ceiling constant (`maxAffectedPortfolios`, 25), not at the fixture that happens to exist — precedent: `tests/imp-003a.test.ts`'s exactly-25-portfolio commit test. Record the measured N-vs-count table in the constant's comment (repo precedent: CALC-004 B2's 50->60 raise). Measure by wrapping `SqlClient` and counting `all`/`get`/`run` plus batch lengths; a throwaway script that reuses a test file's first ~140 lines of fixture helpers gets the numbers in one run. See [[recorded-perf-figures-decay]].
