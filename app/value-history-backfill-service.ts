/**
 * BUG-010 part (b) -- the hourly cron's bounded `portfolio_value_history`
 * backfill (owner-reported production OUTAGE, 2026-09-01).
 *
 * WHY THIS EXISTS. `db/repositories/import-commit.ts`'s `finalize` issues a
 * ranged `DELETE FROM portfolio_value_history ... WHERE value_date >= ?`
 * from a commit's earliest trade date. An accepted Sharesight sync commits
 * the owner's FULL trade history, so that date is the earliest trade ever
 * made and the DELETE wipes essentially the whole cached series. Before
 * BUG-010 the ONLY thing that rebuilt it was the Overview read's own bounded
 * backfill -- and that read was killed at the free plan's CPU limit before
 * it could persist anything, so the site sat in a permanent Error 1102 loop
 * with no path out. Two things fix that: the read path now derives a slice
 * it can actually finish and commit (`app/historical-portfolio-value.ts`'s
 * `MAX_DERIVE_DATES_PER_READ`), and this sweep rebuilds the series without
 * needing anyone to load a page at all.
 *
 * CPU BUDGET -- VERIFIED, NOT ASSUMED (2026-09-01, against
 * <https://developers.cloudflare.com/workers/platform/limits/>): the
 * scheduled handler's CPU allowance is NOT larger than the fetch handler's
 * on this deployment's plan. Cloudflare's table reads:
 *
 *     CPU time per HTTP request   Free: 10 ms   Paid: 5 min (default 30 s)
 *     CPU time per Cron Trigger   Free: 10 ms   Paid: 30 s (< 1 hour
 *                                               interval) / 15 min (>= 1 h)
 *
 * The "cron gets materially more CPU" asymmetry is a PAID-plan property.
 * `wrangler.json` deploys production with `YIELDTOME_WORKERS_PLAN: "free"`,
 * so this sweep is sized against the SAME 10ms allowance a page render gets,
 * not a larger one.
 *
 * SIZING, from BUG-010's own measurement (not from `docs/ARCHITECTURE.md`
 * §9.2's superseded ~0.05ms/date arithmetic -- see
 * `MAX_DERIVE_DATES_PER_READ`'s comment for why that figure no longer holds):
 * a derived candidate date costs ~0.26ms of app-side CPU at the owner's real
 * scale (18 securities), of which ~0.17ms is the pure derivation.
 * `CRON_MAX_BACKFILL_DATES_PER_TICK` (20) is therefore ~5.2ms of measured
 * CPU -- about half the tick's allowance, left to the backfill because this
 * sweep runs LAST in `worker/index.ts`'s scheduled handler, after the
 * price/FX, corporate-action, Sharesight-price and calculation sweeps have
 * already had theirs.
 *
 * DURABLE PARTIAL PROGRESS. Each portfolio's slice derives and persists
 * before the sweep moves on, and `upsertStoredValueHistory` itself writes in
 * `VALUE_HISTORY_CHUNK_SIZE` batches. So even a tick that IS killed mid-sweep
 * leaves every already-committed chunk in place: the next tick starts from
 * real stored progress rather than repeating identical work. That is the
 * structural property BUG-010 was missing -- work that cannot be finished
 * must still not be lost.
 *
 * CONVERGENCE. This sweep slices the OLDEST missing candidate dates while
 * the Overview read slices the NEWEST, so the two rebuild a wiped series
 * from opposite ends and meet in the middle -- see
 * `ValueHistoryDeriveEnd`'s own comment for why that matters beyond load
 * sharing (an unresolvable run of dates at one end cannot stall the other).
 *
 * HONESTY. This sweep introduces no new formula, no new table, and no new
 * value: it calls the SAME derivation the read path calls, and a date it
 * cannot resolve is left absent, never stored as zero and never
 * interpolated between neighbours.
 */
import {
  backfillStoredValueHistoryForPortfolio,
  type ValueHistoryBackfillOutcome,
} from "./historical-portfolio-value.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";

/** Candidate dates one TICK may derive in total, across every portfolio it
 * touches -- ~5.2ms of measured app CPU against the free plan's 10ms per
 * Cron Trigger invocation (see this module's header). This is a TOTAL, not a
 * per-portfolio allowance: a per-portfolio bound would multiply the tick's
 * CPU by the portfolio count, which is exactly the unbounded shape BUG-010
 * was caused by. */
export const CRON_MAX_BACKFILL_DATES_PER_TICK = 20;

/** How many portfolios one tick will even ATTEMPT. A fully-covered
 * portfolio costs only its two cheap coverage reads and then yields its
 * share of the date budget to the next one, so this bounds the fixed
 * per-portfolio read cost of a tick, not the derivation cost (which
 * `CRON_MAX_BACKFILL_DATES_PER_TICK` already bounds globally). */
export const CRON_MAX_BACKFILL_PORTFOLIOS_PER_TICK = 3;

/** Defensive ceiling on the portfolio listing itself (the established
 * `MAX_INVALIDATION_PORTFOLIOS`/`MAX_SECURITIES` fail-closed pattern) -- a
 * single-owner deployment has a handful; this only bounds the rotation set. */
const MAX_LISTED_PORTFOLIOS = 500;

export type ValueHistoryBackfillSweepSummary = {
  /** Active portfolios this tick actually examined. */
  portfoliosConsidered: number;
  /** Portfolios whose slice persisted at least one new row this tick. */
  portfoliosAdvanced: number;
  /** Candidate dates derived this tick, across every portfolio. Never more
   * than the tick's date budget. */
  datesDerived: number;
  /** Rows written. Lower than `datesDerived` when a derived date could not
   * be resolved -- such a date is never stored (never fabricated). */
  rowsPersisted: number;
  /** Portfolios this tick examined that STILL have missing candidate dates
   * -- nonzero means a rebuild is in progress, which is expected and honest
   * while a wiped series catches up. */
  portfoliosPending: number;
  /** Portfolios whose slice threw (an in-flight account purge's
   * `RAISE(ABORT)` purge-lock trigger is the known, legitimate case). The
   * sweep continues with the next portfolio rather than failing the tick. */
  portfoliosFailed: number;
};

export type ValueHistoryBackfillSweepOptions = {
  maxDatesPerTick?: number;
  maxPortfoliosPerTick?: number;
  now?: Date;
};

type PortfolioRow = { id: unknown; user_id: unknown };

/**
 * One bounded tick. Every portfolio-scoped call below is constrained by the
 * `user_id` stored on the `portfolios` row itself -- the authoritative
 * owner column, never a client-supplied id (the same rule
 * `buildValueHistoryInvalidationStatementsForSecurities` follows for the
 * background price writers).
 */
export async function sweepValueHistoryBackfill(
  deps: Readonly<{ client: SqlClient }>,
  options: ValueHistoryBackfillSweepOptions = {},
): Promise<ValueHistoryBackfillSweepSummary> {
  const { client } = deps;
  const now = options.now ?? new Date();
  const maxDates = options.maxDatesPerTick ?? CRON_MAX_BACKFILL_DATES_PER_TICK;
  const maxPortfolios =
    options.maxPortfoliosPerTick ?? CRON_MAX_BACKFILL_PORTFOLIOS_PER_TICK;

  const summary: ValueHistoryBackfillSweepSummary = {
    portfoliosConsidered: 0,
    portfoliosAdvanced: 0,
    datesDerived: 0,
    rowsPersisted: 0,
    portfoliosPending: 0,
    portfoliosFailed: 0,
  };
  if (maxDates <= 0 || maxPortfolios <= 0) return summary;

  const rows = await client.all<PortfolioRow>(
    `SELECT id, user_id FROM portfolios WHERE status = 'active'
     ORDER BY id LIMIT ?`,
    [MAX_LISTED_PORTFOLIOS],
  );
  const portfolios = rows
    .map((row) =>
      typeof row.id === "string" && typeof row.user_id === "string"
        ? { portfolioId: row.id, userId: row.user_id }
        : null,
    )
    .filter(
      (row): row is { portfolioId: string; userId: string } => row !== null,
    );
  if (portfolios.length === 0) return summary;

  // Stateless round-robin: a deployment with more portfolios than one tick
  // can attempt must not let the first few by id starve the rest forever.
  // The tick's own hour is the rotation, so the choice is deterministic
  // (testable by passing `now`) and needs no cursor table.
  const rotation =
    ((Math.floor(now.getTime() / 3_600_000) % portfolios.length) +
      portfolios.length) %
    portfolios.length;

  let datesRemaining = maxDates;
  for (
    let offset = 0;
    offset < portfolios.length &&
    summary.portfoliosConsidered < maxPortfolios &&
    datesRemaining > 0;
    offset += 1
  ) {
    const { portfolioId, userId } =
      portfolios[(rotation + offset) % portfolios.length]!;
    summary.portfoliosConsidered += 1;
    let outcome: ValueHistoryBackfillOutcome | null;
    try {
      outcome = await backfillStoredValueHistoryForPortfolio(
        client,
        userId,
        portfolioId,
        datesRemaining,
        now,
      );
    } catch {
      // A purge-locked (or otherwise failing) portfolio must not take the
      // whole tick down with it -- the remaining portfolios still get their
      // slice, and this one is retried next tick.
      summary.portfoliosFailed += 1;
      continue;
    }
    if (!outcome) continue;
    summary.datesDerived += outcome.datesDerived;
    summary.rowsPersisted += outcome.rowsPersisted;
    if (outcome.rowsPersisted > 0) summary.portfoliosAdvanced += 1;
    if (outcome.backfillPending) summary.portfoliosPending += 1;
    datesRemaining -= outcome.datesDerived;
  }

  return summary;
}
