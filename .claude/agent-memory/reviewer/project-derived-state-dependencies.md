---
name: project-derived-state-dependencies
description: Which source tables each derived cache/publication in YieldToMe actually consumes (portfolio_value_history, projection_publications) and which surfaces read live - the map needed to judge invalidation-widening diffs
metadata:
  type: project
---

Verified 2026-09-01 while reviewing PRF-007. Use this before accepting (or
rejecting) any diff that widens an invalidation/requeue trigger: the question
is always "can the newly-included write actually change the cached output?"

**`portfolio_value_history` (HIST-002 cache, read by the Overview graph ONLY)**
is a function of `transactions` (via `domain/dividends/shares-held.ts`'s
`buildSharesHeldTimeline`), `price_observations` and FX observations. It does
NOT consume `dividend_manual_records` / `dividend_events` — cash is explicitly
out of scope in `domain/snapshots/historical-portfolio-value.ts`'s header. So a
dividend-only write can never make a stored row wrong. Multi-Year's
`loadHistoricalPortfolioValueAtDates` never reads or writes this table at all.

**`projection_publications` / the `projection` calculation-run pipeline**
(`db/repositories/projections.ts`) is ledger-only — zero references to
dividends. `ledger_high_water_start`/`_end` are self-consistency tokens
compared only against each other and the run's own input, never resolved back
to a real `transactions.id` at read time, so a fabricated value fails OPEN, not
closed.

**`/income` reads dividends LIVE.** `app/owned-income-projection.ts` →
`app/owned-dividend-history.ts` → `createDividendManualRecordRepository(client)
.list(...)` plus a `dividend_events` query, concurrently with
`loadOwnedHoldings`. A newly committed receipt is visible on the next render
with no calculation run involved.

**Why:** PRF-007's premise was that a dividend-only import commit left
`/income` stale because no `projection` run was queued. The queueing gap is
real, but the map above says it cannot be the cause of the owner's reported
stale `/income`, and the value-history DELETE the fix now issues for dividend
dates deletes rows that were provably still correct.

**The shape the fix landed in (PRF-007 `77b8d40`, accepted).** When one UNION
branch must drive an invalidation and the other must not, tag a nullable
per-branch column (`t.local_trade_date AS trade_effective_date` /
`NULL AS trade_effective_date`), aggregate it separately
(`MIN(combined.trade_effective_date) AS trade_range_from` — SQLite's `MIN`
ignores NULLs, so a mixed commit still gets the trade date), and filter the
NULL rows out of the DELETE while leaving the combined `range_from`/`range_to`
for the queued run. Adds zero bound parameters and does not perturb the outer
`GROUP BY`/`LIMIT` overflow guard.

**How to apply:** when a task says "X must invalidate/requeue on the same terms
as Y", check that X is actually an input to the derived output before treating
the widening as correctness-required; conservative extra invalidation is a real
cost on the free plan (see [[project-free-plan-constraints]] and
[[project-snapshot-pipeline-retired]]).
