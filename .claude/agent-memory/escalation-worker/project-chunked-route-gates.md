---
name: chunked-route-gates
description: Gate in-request calculation-run advancement on the TERMINAL status, and address the work by PORTFOLIO -- a chunked route's own run ids never cover the whole batch.
metadata:
  type: project
---

Two rules, both learned the hard way on the same route (`app/import-reversal-service.ts`, BUG-016 rounds 3 and 4).

1. **Gate on the repository result's TERMINAL status, never on `rebuildJobIds.length > 0` alone.** Reversal/commit/accept all chunk (`maxChunkSize` is 2 for reversal -- a 226-row batch is 113 invocations) and each non-final invocation returns its own freshly queued ids. Gating on the id list alone runs a full FIFO rebuild plus publish on every chunk against a ledger still mid-mutation. Measured on a 3-invocation reversal: 75/72/65 D1 statements ungated vs 46/45/65 gated, identical end state (the intermediate runs land `failed` with `failure_category = 'superseded_by_newer_run'` -- expected, not a defect).

2. **Address the advancement by PORTFOLIO, not by run id, on any CHUNKED route.** `advanceCalculationRunsForCommit` resolves portfolios from the ids you hand it, so the finalizing invocation only ever advances the portfolios ITS OWN chunk touched -- and a RESUMED finalizing invocation reverses nothing, returns zero ids, and advances nothing at all. Round 3 shipped a comment (and a spec sentence) asserting "earlier chunks' rows are not stranded"; it was FALSE, and a 2-portfolio drill proved it (5 rows left `queued`). The fix is a bounded, owner-scoped query for the BATCH's affected portfolios plus `advanceCalculationRunsForPortfolios`. Commit/accept are the exception: their `rebuildJobIds` already cover every portfolio their `finalize` touched, so they legitimately stay id-addressed.

**Why:** a chunk's own ids are a statement about that chunk, never about the batch. Any reasoning of the form "the finalizing call will pick up what earlier chunks queued" needs a multi-portfolio drill before it is written down -- the single-portfolio fixture is blind to it, and both a code comment and a normative doc carried the false claim for a whole review round.

**How to apply:** when wiring or reviewing a CALC-003 trigger-1 call site, check BOTH the terminal-status gate and what the advanced set is derived from; test any "nothing is stranded" claim with a fixture whose earlier chunk fully drains a portfolio. See [[recorded-perf-figures-decay]] and [[import-rows-query-plan-hint]].
