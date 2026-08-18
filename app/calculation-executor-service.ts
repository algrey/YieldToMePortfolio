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
// CALC-004 update: this module now drives BOTH resumable pipelines that
// share the `calculation_runs` row shape -- `projection` (holdings/lots/
// allocations, `db/repositories/projections.ts`, backing `owned-
// holdings.ts`) and `snapshot` (the Overview daily-history chart,
// `db/repositories/snapshots.ts`, backing `loadPublishedOverview`).
// Investigation for CALC-003 found the two pipelines' checkpoint columns
// are mutually exclusive on one row (snapshots.rebuild writes
// `processed_snapshot_count`/`processed_holding_count` as absolute values
// keyed off `range_from`/`range_to`; projections.rebuild increments
// `processed_holding_count` and drives `projection_cursor_security_id`/
// `projection_active_security_id`/`projection_output_offset`, ignoring
// range entirely since it always rebuilds the full ledger) -- and, more
// fundamentally, `claim()`/`complete()` transition a run to a terminal
// 'completed' status once, so whichever pipeline finishes a given run first
// permanently forecloses the other from ever claiming that same row.
//
// CALC-004 architecture decision: rather than inventing a "phase" column
// and reset logic to run both pipelines sequentially on one row (rejected
// -- see below), every queueing site (`db/repositories/ledger.ts`,
// `import-commit.ts`) now inserts ONE `calculation_runs` row per pipeline
// per triggering event, discriminated by the `pipeline` column (migration
// 0040). This module's coalescing queries (`nextClaimable`, `hasNewerRun`,
// `supersedeStaleQueuedRuns`, `listClaimablePortfolios`) are all scoped by
// `pipeline` in `db/repositories/calculation-runs.ts`, so a newer run in
// one pipeline can never supersede, or be mistaken for progress on, an
// in-progress run in the other -- each pipeline is claimed, advanced,
// coalesced, and published entirely independently, reusing 100% of the
// existing lease/claim/resumable-cursor/coalescing machinery per pipeline.
//
// Rejected alternative: sequential two-phase execution within one row
// (projection phase then snapshot phase before a single `complete()`).
// Rejected because the two rebuild functions' optimistic-concurrency
// guards are keyed on the checkpoint columns actually being in the shape
// each expects (see above) -- running snapshot after projection on the SAME
// row would require resetting `processed_holding_count` (and leaving
// `projection_cursor_security_id`/`projection_active_security_id`/
// `projection_output_offset` inert) between phases, PLUS a new column to
// track which phase a resumed/interrupted run was in (status only has
// queued/running/completed/failed/abandoned -- no phase indicator).  That
// is strictly MORE new state and higher blast radius (both rebuild
// functions' internals would need phase-awareness) than one discriminator
// column, for no benefit the separate-rows model doesn't already give.
import {
  createCalculationRunRepository,
  createHistoricalSnapshotRepository,
  createOwnedProjectionRepository,
  type CalculationRunPipeline,
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
   * Which pipeline to advance -- see this module's doc comment. Optional,
   * defaults to "projection" so every pre-CALC-004 caller (`tests/
   * calc-003.test.ts`, `app/owned-holdings.ts`'s trigger 2) keeps its
   * existing, correct behavior unchanged without needing to say so.
   */
  pipeline?: CalculationRunPipeline;
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
   * Portfolios whose `projection_publications`/`snapshot_publications` row
   * changed this invocation. Equal to `completed` today (one completed run
   * always publishes exactly once) -- kept as a distinct field in case a
   * future change lets one invocation republish the same portfolio more
   * than once.
   */
  publicationsUpdated: number;
  /**
   * True when a calculation run for this user/portfolio/pipeline is still
   * `queued` or `running` (whether or not it is claimable THIS instant)
   * after this invocation ends -- a caller can use this to decide whether
   * to show a "Calculating..." state or schedule a retry.
   */
  remaining: boolean;
};

// A conservative fixed lease duration -- long enough that a normal chunk
// step (a handful of D1 round trips) never races its own expiry, short
// enough that an abandoned/crashed invocation's run becomes reclaimable by
// the next request-time or cron trigger promptly rather than being stuck
// for the run's full attempt.
const LEASE_DURATION_MS = 5 * 60 * 1000;

// CALC-004 follow-up (a), carried from CALC-003's completion note, FIXED in
// review round B1: a run that transient-fails on EVERY claim (lease-
// contention/race that never lands, or any other bug that makes
// `rebuild()` return a transient reason before making forward progress)
// would otherwise be re-claimed by every future trigger forever -- a small
// fixed statement cost each time, but ALSO blocking `nextClaimable`
// (oldest-first) from ever reaching a different, healthy run queued later
// for the same portfolio/pipeline.
//
// The FIRST version of this backstop counted `attempt` (incremented on
// every `claim()`), which is WRONG: `attempt` also increments on ordinary,
// expected budget-exhaustion re-claims that make real forward progress --
// and the snapshot pipeline is DESIGNED to need many of those. A owner
// with several years of history (measured: ~20 statements/day at 1
// security, growing with security count and date-range length) can need
// on the order of a hundred read-time-budget claims to fully backfill a
// multi-year chart (a 3,659-day range at the measured ~20 statements/day
// baseline is ~146 claims at the 150-statement read-time budget alone).
// The original `attempt > 20` threshold would have terminated that
// entirely healthy run as "poisoned" long before it ever finished,
// permanently stranding the Overview in the unavailable state and wasting
// every statement already spent on the partial rebuild each time a fresh
// run was queued and hit the same wall. Reviewer-caught (B1), fixed here.
//
// The correct signal is `stall_count` (`db/repositories/calculation-
// runs.ts`'s `recordClaimProgress`): the number of CONSECUTIVE claims that
// observed the IDENTICAL checkpoint fingerprint as the claim before them,
// i.e. made ZERO forward progress. A healthy multi-claim run's checkpoint
// moves every single successful claim (every chunk write updates it), so
// `stall_count` never grows past 0 for it regardless of how many claims it
// needs. Only a genuinely stuck run -- one that keeps getting claimed and
// immediately hitting a transient failure before ever writing a checkpoint
// update -- accumulates consecutive stalls. `MAX_STALL_CLAIMS = 5` bounds a
// poisoned run to a small, finite number of wasted claims (never
// permanently starving a fresh, later-queued run for the same
// portfolio/pipeline) while comfortably tolerating the rare legitimate
// transient race (a one-off lease-expiry/lost-race blip resets to 0 the
// very next time real work happens, well before 5 in a row). Marked
// `failed` with an honest, distinct category so it is never confused with
// a genuine computation defect or a supersession.
const MAX_STALL_CLAIMS = 5;

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
// CALC-004: the snapshot pipeline's post-commit budget, spent in the SAME
// synchronous request immediately after the projection budget above (see
// `advanceCalculationRunsForCommit`). Deliberately smaller than the
// projection budget: `snapshots.rebuild` re-runs `loadFacts` (7 COUNT +
// 7 SELECT = 14 statements) on EVERY chunk call, even chunks that only
// continue holdings within the same date, so its fixed per-chunk overhead
// is far higher than the projection pipeline's; a full multi-year daily
// history cannot realistically complete synchronously regardless of
// budget. This budget only needs to make bounded, honest partial progress
// -- the read-time trigger on the Overview page and the cron sweep make up
// the rest, exactly like a large projection rebuild already relies on
// those same two triggers. Combined with the projection budget above
// (450 + 300 = 750), one commit's total synchronous statement spend stays
// comfortably under D1's ~1000-statement-per-invocation ceiling even with
// each call's documented one-call overshoot allowance.
export const POST_COMMIT_SNAPSHOT_CALCULATION_BUDGET = 300;
// Trigger 2 (read-time, `app/owned-holdings.ts`): smaller since it runs
// inline on a page read; a portfolio too large to finish within it still
// makes real progress, and the next read (or trigger 1/3) continues from
// the persisted cursor.
export const READ_TIME_CALCULATION_BUDGET = 150;
// CALC-004: the Overview page's read-time self-heal budget
// (`app/authenticated-workspace.ts`, `app/owned-income-projection.ts`) --
// same rationale as `READ_TIME_CALCULATION_BUDGET`, sized for the snapshot
// pipeline's higher per-chunk fixed cost (see
// `POST_COMMIT_SNAPSHOT_CALCULATION_BUDGET`'s comment). Kept equal to the
// projection read-time budget: both are bounded, best-effort progress on a
// synchronous page read, not a completion guarantee.
export const READ_TIME_SNAPSHOT_CALCULATION_BUDGET = 150;
// Trigger 3 (cron backstop, `worker/scheduled-refresh.ts`): per (user,
// portfolio, pipeline) work unit, up to `CRON_MAX_PORTFOLIOS_PER_SWEEP`
// units per sweep -- a background job, not latency-sensitive to a single
// request, but still bounded so one scheduled invocation cannot run
// unboundedly long. CALC-004: `listClaimablePortfolios` now yields one row
// per (user, portfolio, pipeline) with claimable work, so a portfolio
// needing both pipelines advanced can consume two of the per-sweep units --
// deliberate, since each pipeline is genuinely independent work reusing the
// same per-portfolio budget below.
export const CRON_CALCULATION_BUDGET_PER_PORTFOLIO = 500;
export const CRON_MAX_PORTFOLIOS_PER_SWEEP = 10;

async function hasPendingRun(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  pipeline: CalculationRunPipeline,
): Promise<boolean> {
  const row = await client.get<{ marker: number }>(
    `SELECT 1 AS marker FROM calculation_runs
     WHERE user_id = ? AND portfolio_id = ? AND pipeline = ?
       AND status IN ('queued', 'running')
     LIMIT 1`,
    [userId, portfolioId, pipeline],
  );
  return row !== undefined;
}

// CALC-003 review-round B4 fix: a REAL fallback high-water for a run that
// was queued with no ledger transaction of its own to anchor to (today,
// only `manual_override` runs -- `ledger_high_water_start = ''`, see
// `db/repositories/market-data.ts`). Ordered by `created_at` (INSERTION
// order), never `trade_at` -- the B1 review-round finding applies equally
// here: a backdated/reversal transaction's `trade_at` is not a reliable
// "current" signal, but the order rows were actually written in is. Shared
// unchanged by both pipelines -- it resolves a real transaction id, which
// is a pipeline-agnostic concept.
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

// CALC-004: normalizes one rebuild-step outcome, regardless of which
// pipeline's rebuild function produced it, so `advanceOneRun`'s budget
// loop/fail/release logic can stay a single shared implementation instead
// of being duplicated per pipeline.
type RebuildStepOutcome =
  | { ok: true; completed: boolean }
  | { ok: false; transient: boolean; failureCategory: string };

type RebuildStep = (
  run: CalculationRunRecord,
  owner: string,
  highWater: string,
) => Promise<RebuildStepOutcome>;

/**
 * Claims and advances calculation runs for one user/portfolio/pipeline
 * within a bounded D1 STATEMENT budget (see
 * `AdvanceCalculationRunsInput.budget`'s doc comment), publishing to
 * `projection_publications`/`snapshot_publications` (per `pipeline`) via
 * the existing repository machinery when a run completes. Never throws for
 * ordinary claim contention/staleness/transient failures -- see the
 * per-reason handling below.
 */
export async function advanceCalculationRuns(
  context: CalculationExecutorContext,
  input: AdvanceCalculationRunsInput,
): Promise<AdvanceCalculationRunsResult> {
  const now = context.now ?? (() => new Date().toISOString());
  const nextLeaseOwner = context.leaseOwner ?? (() => crypto.randomUUID());
  const pipeline: CalculationRunPipeline = input.pipeline ?? "projection";
  const budget = Number.isFinite(input.budget)
    ? Math.max(0, Math.floor(input.budget))
    : 0;
  const { wrapped, count } = countingClient(context.client);
  const runs = createCalculationRunRepository(wrapped);
  const projections = createOwnedProjectionRepository(wrapped);
  const snapshots = createHistoricalSnapshotRepository(wrapped);

  let advanced = 0;
  let completed = 0;

  const step: RebuildStep =
    pipeline === "projection"
      ? async (run, owner, highWater) => {
          const result = await projections.rebuild(input.userId, {
            portfolioId: input.portfolioId,
            calculationRunId: run.id,
            leaseOwner: owner,
            currentLedgerHighWater: highWater,
            now: now(),
          });
          if (!result.ok) {
            const transient =
              result.reason === "not_owned" ||
              result.reason === "not_found" ||
              result.reason === "atomic_failure" ||
              // CALC-003 review-round B5c fix: `stale_ledger`/`not_running`
              // are NOT proof this run's own computation is poisoned -- they
              // signal a lease-expiry race or an already-completed
              // idempotent re-check. See the original CALC-003 doc comment
              // this replaces for the full rationale.
              result.reason === "stale_ledger" ||
              result.reason === "not_running";
            return { ok: false, transient, failureCategory: result.reason };
          }
          return { ok: true, completed: result.completed };
        }
      : async (run, owner, highWater) => {
          const result = await snapshots.rebuild(input.userId, {
            portfolioId: input.portfolioId,
            calculationRunId: run.id,
            leaseOwner: owner,
            currentLedgerHighWater: highWater,
            now: now(),
          });
          if (!result.ok) {
            // `not-owned`/`stale-ledger` are the snapshot pipeline's exact
            // analogues of the projection pipeline's `not_owned`/
            // `stale_ledger` transient reasons above (a lease-race or an
            // already-completed idempotent re-check, never proof of a
            // poisoned computation). `invalid-run` (no dates in the
            // requested range) and `build-failed` (a domain-level rebuild
            // failure -- bad decimal/scale, an invalid coverage/decimal
            // invariant) cannot succeed by retrying the identical
            // computation, so they fail the run terminally exactly like the
            // projection pipeline's structural failures do.
            const transient =
              result.reason === "not-owned" || result.reason === "stale-ledger";
            return {
              ok: false,
              transient,
              failureCategory: result.reason.replace(/-/g, "_"),
            };
          }
          return { ok: true, completed: result.status === "completed" };
        };

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
      const result = await step(run, owner, highWater);
      if (!result.ok) {
        if (result.transient) {
          return { keepGoing: false };
        }
        // A genuinely poisoned run cannot succeed by retrying the identical
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
          result.failureCategory,
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
  // This bulk-supersedes every stale queued run for the portfolio+pipeline
  // in ONE statement, before the claim loop even starts -- `hasNewerRun`
  // remains the correctness backstop below for a `running` row this bulk
  // pass deliberately does not touch (it may be actively leased elsewhere).
  await runs.supersedeStaleQueuedRuns(
    input.userId,
    input.portfolioId,
    pipeline,
    now(),
  );

  let keepGoing = true;
  while (keepGoing && count() < budget) {
    const nowIso = now();
    const candidate = await runs.nextClaimable(
      input.userId,
      input.portfolioId,
      pipeline,
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
    // newer run already exists for this portfolio+pipeline -- see
    // `hasNewerRun`'s doc comment (`db/repositories/calculation-runs.ts`)
    // for why this replaces a recomputed "current ledger high water"
    // comparison, which gave false positives for a reversal of a
    // non-latest transaction or a backdated post.
    const superseded = await runs.hasNewerRun(
      input.userId,
      input.portfolioId,
      pipeline,
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

    // CALC-004 follow-up (a) backstop, FIXED in review round B1 -- see
    // `MAX_STALL_CLAIMS`'s doc comment for why this measures CONSECUTIVE
    // zero-progress claims (`stall_count`) rather than the raw `attempt`
    // count, which also increments on ordinary, expected multi-claim
    // resumption. Checked after the supersession check so an about-to-be-
    // superseded run is always failed for that more specific, meaningful
    // reason instead.
    const progress = await runs.recordClaimProgress(
      input.userId,
      input.portfolioId,
      run.id,
      owner,
      run,
      now(),
    );
    if (!progress.ok) continue; // lost the lease to a race; try the next candidate.
    if (progress.stallCount >= MAX_STALL_CLAIMS) {
      await runs.fail(
        input.userId,
        input.portfolioId,
        run.id,
        owner,
        now(),
        "stall_limit_exceeded",
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
    // Pipeline-agnostic: both `projections.rebuild` and `snapshots.rebuild`
    // apply the identical stored-vs-input self-consistency check.
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
      // holdings/zero-disposal short-circuits (and the snapshot pipeline's
      // own zero-holding coverage handling) mean that published '' is
      // never actually read through a path that would reject it.
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
      pipeline,
    ),
  };
}

/**
 * Trigger 1 helper (post-commit/accept): resolves the distinct portfolios
 * touched by a just-finished import commit's `rebuildJobIds`
 * (`ImportCommitSuccess.rebuildJobIds`, `db/repositories/import-commit.ts`)
 * and advances EACH PIPELINE for each within its own budget. Owner-scoped
 * by construction (the lookup is filtered by `userId`, matching every other
 * owned-repository query in this codebase) -- a batch can never cause
 * another user's portfolio to be advanced.
 *
 * CALC-004: `rebuildJobIds` now contains ids from BOTH pipelines (a commit
 * queues one row per pipeline per affected portfolio -- see
 * `db/repositories/import-commit.ts`'s `finalize`), but this only needs the
 * DISTINCT portfolio ids from it; every distinct portfolio then gets both
 * its projection and snapshot pipelines advanced explicitly, regardless of
 * which pipeline's id happened to appear in `rebuildJobIds` (existing
 * callers -- `app/import-commit-actions.ts`, `app/import-accept-service.ts`
 * -- are unchanged and automatically gain the snapshot-pipeline advance).
 */
export async function advanceCalculationRunsForCommit(
  context: CalculationExecutorContext,
  input: {
    userId: string;
    calculationRunIds: readonly string[];
    budget: number;
    /**
     * Snapshot-pipeline budget for the same request. Defaults to
     * `POST_COMMIT_SNAPSHOT_CALCULATION_BUDGET` -- override only for tests
     * that need a specific measured value.
     */
    snapshotBudget?: number;
  },
): Promise<AdvanceCalculationRunsResult[]> {
  if (input.calculationRunIds.length === 0) return [];
  const placeholders = input.calculationRunIds.map(() => "?").join(",");
  const rows = await context.client.all<{ portfolio_id: string }>(
    `SELECT DISTINCT portfolio_id FROM calculation_runs
     WHERE user_id = ? AND id IN (${placeholders})`,
    [input.userId, ...input.calculationRunIds],
  );
  const snapshotBudget =
    input.snapshotBudget ?? POST_COMMIT_SNAPSHOT_CALCULATION_BUDGET;
  const results: AdvanceCalculationRunsResult[] = [];
  for (const row of rows) {
    const portfolioId = String(row.portfolio_id);
    results.push(
      await advanceCalculationRuns(context, {
        userId: input.userId,
        portfolioId,
        pipeline: "projection",
        budget: input.budget,
      }),
    );
    results.push(
      await advanceCalculationRuns(context, {
        userId: input.userId,
        portfolioId,
        pipeline: "snapshot",
        budget: snapshotBudget,
      }),
    );
  }
  return results;
}

/**
 * Trigger 3 helper (cron backstop): a bounded, oldest-pending-work-first
 * sweep across ALL users' claimable calculation runs, across BOTH
 * pipelines. Discovery (`listClaimablePortfolios`) is a bookkeeping-only
 * query over `calculation_runs` itself (ids and ownership columns, no
 * financial data), now grouped by `(user_id, portfolio_id, pipeline)`;
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
      pipeline: portfolio.pipeline,
      budget: input.budgetPerPortfolio,
    });
    advanced += result.advanced;
    completed += result.completed;
  }
  return { portfoliosSwept: portfolios.length, advanced, completed };
}
