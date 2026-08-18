// CALC-003: the bounded production executor for the CALC-002/LED-002B
// resumable calculation-run machinery. Before this task,
// `createOwnedProjectionRepository` (the sole writer of
// `projection_publications`) had zero non-test callers -- import commits
// and manual ledger postings correctly queued `calculation_runs` rows, but
// nothing ever claimed/advanced them, so `projection_publications` stayed
// permanently empty and every read that depends on it (`owned-holdings.ts`,
// and transitively `owned-income-projection.ts`) reported the honest but
// permanent "not yet calculated" state. This module orchestrates the
// EXISTING lease/claim/resumable-cursor machinery unchanged -- no new
// calculation logic lives here.
//
// Scope note (read before extending this module): `db/repositories/
// snapshots.ts`'s `createHistoricalSnapshotRepository` (the CALC-002
// historical-chart machinery backing the Overview *chart* via
// `loadPublishedOverview`/`snapshot_publications`) is a SEPARATE resumable
// pipeline over the SAME `calculation_runs` row shape, and it is NOT driven
// by this executor. Investigation for this task found the two pipelines'
// checkpoint columns are mutually exclusive on one row (snapshots.rebuild
// writes `processed_snapshot_count`/`processed_holding_count` as absolute
// values keyed off `range_from`/`range_to`; projections.rebuild increments
// `processed_holding_count` and drives `projection_cursor_security_id`/
// `projection_active_security_id`/`projection_output_offset`, ignoring
// range entirely since it always rebuilds the full ledger) -- and, more
// fundamentally, `claim()`/`complete()` transition a run to a terminal
// 'completed' status once, so whichever pipeline finishes a given run first
// permanently forecloses the other from ever claiming that same row. Since
// production only queues ONE run per ledger mutation/import commit today,
// this executor deliberately targets the projection/holdings pipeline that
// this task's bug report and required tests are scoped to (`owned-holdings`
// returning real quantities/basis); wiring the historical-chart pipeline
// needs its own run-queueing story (e.g. a second queued row, or a
// discriminating column) and is out of scope here -- see the dated
// ARCHITECTURE.md note this task adds.
import {
  createCalculationRunRepository,
  createOwnedProjectionRepository,
  type CalculationRunRecord,
} from "../db/repositories/index.ts";
import type { SqlClient, SqlStatement } from "../db/repositories/sql-client.ts";

// CALC-003 review round (B2 fix): wraps `client` to count every D1
// statement actually issued -- one per `get`/`all`/`run` call, and one per
// statement inside a `batch()` call. The executor's budget is spent in
// these units (real statements), not an abstract "step" count, because a
// single `projections.rebuild` chunk's cost is LINEAR in how many
// lot/allocation/holding rows it flushes (up to `maxOutputStatementsPerChunk`,
// default 20) -- a portfolio with securities that each carry many
// transactions can cost far more per chunk than a portfolio where every
// security finishes in one or two output rows. Counting the real statements
// as they happen is exact regardless of that variance, which a fixed
// per-chunk estimate cannot be.
function countingClient(client: SqlClient): {
  wrapped: SqlClient;
  count: () => number;
} {
  let statements = 0;
  const wrapped: SqlClient = {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      statements += 1;
      return client.all<T>(sql, params);
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      statements += 1;
      return client.get<T>(sql, params);
    },
    async run(sql: string, params?: readonly unknown[]) {
      statements += 1;
      return client.run(sql, params);
    },
    async batch(batchStatements: readonly SqlStatement[]) {
      statements += batchStatements.length;
      return client.batch(batchStatements);
    },
  };
  return { wrapped, count: () => statements };
}

export type CalculationExecutorContext = {
  client: SqlClient;
  /** Overridable for deterministic tests. Defaults to wall-clock time. */
  now?: () => string;
  /**
   * Overridable for deterministic tests (e.g. to simulate two different
   * workers, or the same worker resuming after its own lease expired).
   * Defaults to a fresh random id per claim.
   */
  leaseOwner?: () => string;
};

export type AdvanceCalculationRunsInput = {
  userId: string;
  portfolioId: string;
  /**
   * Maximum number of real D1 statements (see `countingClient` above) this
   * invocation may spend across claim/fail/rebuild calls combined -- NOT a
   * "step" count. CALC-003's first review round measured a fixed ~9
   * statements/chunk assumption against a portfolio where every security
   * finished in one chunk; the reviewer's own repro against a 30-security x
   * 40-transaction-per-security portfolio (many lots per security, so a
   * single security's output spans MULTIPLE `maxOutputStatementsPerChunk`-
   * capped chunks, each re-paying `buildSecurity`'s full per-security ledger
   * read) measured 992 statements at a nominal "budget 50 steps" -- 2-3x the
   * assumed cost, because per-chunk cost is LINEAR in output rows (up to 20
   * lot/allocation/holding inserts + 1 checkpoint UPDATE + getRun +
   * nextSecurityId + the ledger SELECT + 3 parallel `counts()` SELECTs ~= 27
   * statements/chunk at the cap, not a flat ~9). Budgeting the REAL
   * statement count via `countingClient` makes this exact regardless of
   * portfolio shape -- see the measured numbers on the exported
   * `*_CALCULATION_BUDGET` constants below (re-measured against both a
   * single-output-row-per-security shape and a many-lots-per-security shape
   * after this fix). Callers should pick a budget with comfortable headroom
   * under D1's documented-as-inference ~1000-statement-per-invocation
   * assumption (see `docs/DATA_MODEL.md`'s identical disclosure for
   * `persistParsedResult`, and `docs/ARCHITECTURE.md`'s UI-013 amendment for
   * the precedent of measuring rather than guessing this kind of cap).
   */
  budget: number;
};

export type AdvanceCalculationRunsResult = {
  /** Runs successfully claimed (lease acquired) this invocation. */
  advanced: number;
  /** Runs that reached `completed` and published this invocation. */
  completed: number;
  /**
   * Portfolios whose `projection_publications` row changed this
   * invocation. Equal to `completed` today (one completed run always
   * publishes exactly once) -- kept as a distinct field in case a future
   * change lets one invocation republish the same portfolio more than
   * once.
   */
  publicationsUpdated: number;
  /**
   * True when a calculation run for this user/portfolio is still `queued`
   * or `running` (whether or not it is claimable THIS instant) after this
   * invocation ends -- a caller can use this to decide whether to show a
   * "Calculating..." state or schedule a retry.
   */
  remaining: boolean;
};

// A conservative fixed lease duration -- long enough that a normal chunk
// step (a handful of D1 round trips) never races its own expiry, short
// enough that an abandoned/crashed invocation's run becomes reclaimable by
// the next request-time or cron trigger promptly rather than being stuck
// for the run's full attempt.
const LEASE_DURATION_MS = 5 * 60 * 1000;

// Budgets, in real D1 statements (see `AdvanceCalculationRunsInput.budget`'s
// doc comment for the CALC-003 review-round B2 finding this replaces a
// flat "~9 statements/chunk" assumption with). These caps are the
// reviewer's prescribed ceilings, each comfortably under D1's documented-
// as-inference ~1000-statement-per-invocation assumption even at the
// worst-case ~27 statements/chunk (a security whose output hits the
// `maxOutputStatementsPerChunk` cap every chunk).
//
// Trigger 1 (post-commit/accept, `app/import-commit-actions.ts` and
// `app/import-accept-service.ts`): synchronous in the owner's own request,
// generous enough to finish a typical portfolio outright.
export const POST_COMMIT_CALCULATION_BUDGET = 450;
// Trigger 2 (read-time, `app/owned-holdings.ts`): smaller since it runs
// inline on a page read; a portfolio too large to finish within it still
// makes real progress, and the next read (or trigger 1/3) continues from
// the persisted cursor.
export const READ_TIME_CALCULATION_BUDGET = 150;
// Trigger 3 (cron backstop, `worker/scheduled-refresh.ts`): per portfolio,
// up to 10 portfolios per sweep -- a background job, not latency-sensitive
// to a single request, but still bounded so one scheduled invocation
// cannot run unboundedly long.
export const CRON_CALCULATION_BUDGET_PER_PORTFOLIO = 500;
export const CRON_MAX_PORTFOLIOS_PER_SWEEP = 10;

async function hasPendingRun(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<boolean> {
  const row = await client.get<{ marker: number }>(
    `SELECT 1 AS marker FROM calculation_runs
     WHERE user_id = ? AND portfolio_id = ? AND status IN ('queued', 'running')
     LIMIT 1`,
    [userId, portfolioId],
  );
  return row !== undefined;
}

// CALC-003 review-round B4 fix: a REAL fallback high-water for a run that
// was queued with no ledger transaction of its own to anchor to (today,
// only `manual_override` runs -- `ledger_high_water_start = ''`, see
// `db/repositories/market-data.ts`). Ordered by `created_at` (INSERTION
// order), never `trade_at` -- the B1 review-round finding applies equally
// here: a backdated/reversal transaction's `trade_at` is not a reliable
// "current" signal, but the order rows were actually written in is.
async function currentTransactionHighWater(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<string | null> {
  const row = await client.get<{ id: string }>(
    `SELECT id FROM transactions
     WHERE user_id = ? AND portfolio_id = ? AND status IN ('posted', 'reversed')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId, portfolioId],
  );
  return row ? String(row.id) : null;
}

/**
 * Claims and advances calculation runs for one user/portfolio within a
 * bounded D1 STATEMENT budget (see `AdvanceCalculationRunsInput.budget`'s
 * doc comment), publishing to `projection_publications` via the existing
 * `createOwnedProjectionRepository` machinery when a run completes. Never
 * throws for ordinary claim contention/staleness/transient failures -- see
 * the per-reason handling below.
 */
export async function advanceCalculationRuns(
  context: CalculationExecutorContext,
  input: AdvanceCalculationRunsInput,
): Promise<AdvanceCalculationRunsResult> {
  const now = context.now ?? (() => new Date().toISOString());
  const nextLeaseOwner = context.leaseOwner ?? (() => crypto.randomUUID());
  const budget = Number.isFinite(input.budget)
    ? Math.max(0, Math.floor(input.budget))
    : 0;
  const { wrapped, count } = countingClient(context.client);
  const runs = createCalculationRunRepository(wrapped);
  const projections = createOwnedProjectionRepository(wrapped);

  let advanced = 0;
  let completed = 0;

  // Advances exactly one claimed run, anchored to `highWater` (see the
  // B4-fix resolution below), as far as the remaining statement budget
  // allows. Returns whether the invocation should keep looking for more
  // claimable runs afterwards.
  async function advanceOneRun(
    run: CalculationRunRecord,
    owner: string,
    highWater: string,
  ): Promise<{ keepGoing: boolean }> {
    while (count() < budget) {
      const result = await projections.rebuild(input.userId, {
        portfolioId: input.portfolioId,
        calculationRunId: run.id,
        leaseOwner: owner,
        currentLedgerHighWater: highWater,
        now: now(),
      });
      if (!result.ok) {
        if (
          result.reason === "not_owned" ||
          result.reason === "not_found" ||
          result.reason === "atomic_failure" ||
          // CALC-003 review-round B5c fix: `stale_ledger`/`not_running`
          // from `projections.rebuild`/`publish` are NOT proof this run's
          // own computation is poisoned -- they signal a lease-expiry race
          // (this invocation's lease lapsed between chunks, or another
          // worker's completion/claim landed concurrently) or an already-
          // completed idempotent re-check. Marking the run terminally
          // `failed` here would strand a healthy, resumable run until an
          // unrelated future mutation happens to queue a fresh one. Treat
          // them exactly like the other transient reasons: leave the row
          // untouched (its lease will expire, or it is already claimable)
          // for a later trigger to pick back up.
          result.reason === "stale_ledger" ||
          result.reason === "not_running"
        ) {
          return { keepGoing: false };
        }
        // A genuinely poisoned run (bad decimal/scale, an oversell the
        // ledger should never have allowed, or a runaway per-security
        // event count) cannot succeed by retrying the identical
        // computation -- fail it explicitly so it stops consuming future
        // invocations' budget. A later ledger mutation/import queues a
        // fresh run that supersedes it. (Can overshoot the statement
        // budget by this call's own cost -- an accepted, bounded overshoot
        // rather than leaving the run stuck `running`; every exported
        // budget keeps comfortable headroom under D1's ~1000 ceiling.)
        await runs.fail(
          input.userId,
          input.portfolioId,
          run.id,
          owner,
          now(),
          result.reason,
        );
        return { keepGoing: true };
      }
      if (result.completed) {
        completed += 1;
        return { keepGoing: true };
      }
    }
    // CALC-003 review-round B5b fix: budget exhausted mid-run -- release
    // the lease (persisted cursor fields untouched) instead of leaving it
    // held for the remainder of `LEASE_DURATION_MS`, so the very next
    // trigger (read-time or otherwise) can claim and continue immediately
    // rather than seeing a 6-statement no-op for minutes.
    await runs.releaseLease(
      input.userId,
      input.portfolioId,
      run.id,
      owner,
      now(),
    );
    return { keepGoing: false };
  }

  // CALC-003 review-round B5a fix: a realistic committed batch/accept can
  // leave 100+ stale `queued` `ledger_mutation` runs behind (one per
  // committed row) alongside the one run that matters. Superseding them
  // ONE AT A TIME via claim+hasNewerRun+fail (~5-6 statements each) burns
  // the entire budget on bookkeeping before ever reaching the real run.
  // This bulk-supersedes every stale queued run for the portfolio in ONE
  // statement, before the claim loop even starts -- `hasNewerRun` remains
  // the correctness backstop below for a `running` row this bulk pass
  // deliberately does not touch (it may be actively leased elsewhere).
  await runs.supersedeStaleQueuedRuns(input.userId, input.portfolioId, now());

  let keepGoing = true;
  while (keepGoing && count() < budget) {
    const nowIso = now();
    const candidate = await runs.nextClaimable(
      input.userId,
      input.portfolioId,
      nowIso,
    );
    if (!candidate) break;

    const owner = nextLeaseOwner();
    const leaseExpiresAt = new Date(
      Date.parse(nowIso) + LEASE_DURATION_MS,
    ).toISOString();
    const claimed = await runs.claim(
      input.userId,
      input.portfolioId,
      candidate.id,
      owner,
      leaseExpiresAt,
      nowIso,
    );
    if (!claimed.ok) continue; // lost a race; try the next candidate.
    advanced += 1;
    const run = claimed.run;

    // Coalescing (review-round B1 fix): fail fast ONLY when a genuinely
    // newer run already exists for this portfolio -- see `hasNewerRun`'s
    // doc comment (`db/repositories/calculation-runs.ts`) for why this
    // replaces a recomputed "current ledger high water" comparison, which
    // gave false positives for a reversal of a non-latest transaction or a
    // backdated post.
    const superseded = await runs.hasNewerRun(
      input.userId,
      input.portfolioId,
      run.createdAt,
      run.id,
    );
    if (superseded) {
      await runs.fail(
        input.userId,
        input.portfolioId,
        run.id,
        owner,
        now(),
        "superseded_by_newer_run",
      );
      continue;
    }

    // CALC-003 review-round B4 fix: a run queued with no ledger
    // transaction of its own (`ledgerHighWaterStart === ''`, today only
    // `manual_override`) needs a REAL high-water resolved and persisted
    // before advancing -- see `resolveEmptyHighWater`'s doc comment
    // (`db/repositories/calculation-runs.ts`) for why passing a resolved
    // value as `rebuild`'s input WITHOUT also persisting it into the row
    // would make every rebuild/publish call for this run fail closed.
    let highWater = run.ledgerHighWaterStart;
    if (!highWater) {
      const resolved = await currentTransactionHighWater(
        wrapped,
        input.userId,
        input.portfolioId,
      );
      if (resolved) {
        await runs.resolveEmptyHighWater(
          input.userId,
          input.portfolioId,
          run.id,
          owner,
          resolved,
          now(),
        );
        highWater = resolved;
      }
      // else: this portfolio genuinely has zero transactions -- leave
      // `highWater` as '' (self-consistent with the untouched stored
      // value). `loadOwnedHoldings`/`owned-capital-gains`'s own zero-
      // holdings/zero-disposal short-circuits mean that published '' is
      // never actually read through the path that would reject it.
    }

    const outcome = await advanceOneRun(run, owner, highWater);
    keepGoing = outcome.keepGoing;
  }

  return {
    advanced,
    completed,
    publicationsUpdated: completed,
    remaining: await hasPendingRun(
      context.client,
      input.userId,
      input.portfolioId,
    ),
  };
}

/**
 * Trigger 1 helper (post-commit/accept): resolves the distinct portfolios
 * touched by a just-finished import commit's `rebuildJobIds`
 * (`ImportCommitSuccess.rebuildJobIds`, `db/repositories/import-commit.ts`)
 * and advances each within `budget`. Owner-scoped by construction (the
 * lookup is filtered by `userId`, matching every other owned-repository
 * query in this codebase) -- a batch can never cause another user's
 * portfolio to be advanced.
 */
export async function advanceCalculationRunsForCommit(
  context: CalculationExecutorContext,
  input: {
    userId: string;
    calculationRunIds: readonly string[];
    budget: number;
  },
): Promise<AdvanceCalculationRunsResult[]> {
  if (input.calculationRunIds.length === 0) return [];
  const placeholders = input.calculationRunIds.map(() => "?").join(",");
  const rows = await context.client.all<{ portfolio_id: string }>(
    `SELECT DISTINCT portfolio_id FROM calculation_runs
     WHERE user_id = ? AND id IN (${placeholders})`,
    [input.userId, ...input.calculationRunIds],
  );
  const results: AdvanceCalculationRunsResult[] = [];
  for (const row of rows) {
    results.push(
      await advanceCalculationRuns(context, {
        userId: input.userId,
        portfolioId: String(row.portfolio_id),
        budget: input.budget,
      }),
    );
  }
  return results;
}

/**
 * Trigger 3 helper (cron backstop): a bounded, oldest-pending-work-first
 * sweep across ALL users' claimable calculation runs. Discovery
 * (`listClaimablePortfolios`) is a bookkeeping-only query over
 * `calculation_runs` itself (ids and ownership columns, no financial data);
 * every actual advance is then delegated to the SAME per-user-scoped
 * `advanceCalculationRuns` the request-path triggers use, so no ownership
 * check is ever widened.
 */
export async function sweepCalculationRuns(
  context: CalculationExecutorContext,
  input: { maxPortfolios: number; budgetPerPortfolio: number },
): Promise<{
  portfoliosSwept: number;
  advanced: number;
  completed: number;
}> {
  const now = context.now ?? (() => new Date().toISOString());
  const runs = createCalculationRunRepository(context.client);
  const portfolios = await runs.listClaimablePortfolios(
    now(),
    Math.max(0, Math.floor(input.maxPortfolios)),
  );
  let advanced = 0;
  let completed = 0;
  for (const portfolio of portfolios) {
    const result = await advanceCalculationRuns(context, {
      userId: portfolio.userId,
      portfolioId: portfolio.portfolioId,
      budget: input.budgetPerPortfolio,
    });
    advanced += result.advanced;
    completed += result.completed;
  }
  return { portfoliosSwept: portfolios.length, advanced, completed };
}
