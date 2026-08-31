import type { SqlClient } from "./sql-client.ts";

export type CalculationRunStatus =
  "queued" | "running" | "completed" | "failed" | "abandoned";

// CALC-004: which resumable pipeline this row belongs to -- see the
// migration 0040 doc comment on `db/schema.ts`'s `calculationRuns.pipeline`
// column for why the two pipelines cannot share one row.
export type CalculationRunPipeline = "projection" | "snapshot";

export type CalculationRunRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  rangeFrom: string;
  rangeTo: string;
  calculationVersion: number;
  reason: string;
  invalidationSource: string | null;
  pipeline: CalculationRunPipeline;
  status: CalculationRunStatus;
  attempt: number;
  // CALC-004 review-round B1 fix: see `db/schema.ts`'s `stallCount`/
  // `stallCheckpoint` doc comment. `stallCount` is the number of
  // CONSECUTIVE claims that observed the identical checkpoint fingerprint
  // as the claim before it (i.e. made zero forward progress); it resets to
  // 0 the moment any checkpoint column moves. `attempt` above must never
  // be used as a poison signal on its own -- it counts ordinary,
  // progress-making re-claims too.
  stallCount: number;
  stallCheckpoint: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  ledgerHighWaterStart: string;
  ledgerHighWaterEnd: string | null;
  marketDataCutoff: string | null;
  calendarEvidenceJson: string | null;
  processedSnapshotCount: number;
  processedHoldingCount: number;
  processedLedgerCount: number;
  projectionCursorSecurityId: string | null;
  projectionActiveSecurityId: string | null;
  projectionOutputOffset: number;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestCalculationRunInput = {
  id: string;
  portfolioId: string;
  rangeFrom: string;
  rangeTo: string;
  calculationVersion: number;
  reason: string;
  invalidationSource?: string | null;
  // Optional, defaults to "projection" -- every pre-CALC-004 caller (tests
  // and every existing queueing site's raw INSERTs) implicitly queues a
  // projection-pipeline run and never needs to say so explicitly.
  pipeline?: CalculationRunPipeline;
  ledgerHighWaterStart: string;
  marketDataCutoff?: string | null;
  calendarEvidenceJson?: string | null;
  idempotencyKey: string;
  now: string;
};

export type ClaimCalculationRunResult =
  | { ok: true; run: CalculationRunRecord }
  | { ok: false; reason: "not-claimable" };

export type CompleteCalculationRunResult =
  | { ok: true; run: CalculationRunRecord }
  | { ok: false; reason: "stale-ledger" | "not-owned" | "not-running" };

export type FailCalculationRunResult =
  { ok: true; run: CalculationRunRecord } | { ok: false; reason: "not-owned" };

export type ClaimableCalculationRunPortfolio = {
  userId: string;
  portfolioId: string;
  pipeline: CalculationRunPipeline;
};

export type RecordClaimProgressResult =
  { ok: true; stallCount: number } | { ok: false; reason: "not-owned" };

// CALC-004 review-round B1 fix: a fingerprint of every checkpoint column
// either pipeline's rebuild can advance -- `processed_snapshot_count`/
// `processed_holding_count` (both pipelines, incompatible meanings, see
// `db/schema.ts`), `processed_ledger_count`/`projection_output_offset`/
// `projection_cursor_security_id`/`projection_active_security_id`
// (projection pipeline only). Deliberately pipeline-agnostic (compares
// ALL of them regardless of which pipeline the run belongs to) so this
// stays a single shared implementation rather than a per-pipeline one.
function checkpointFingerprint(run: CalculationRunRecord): string {
  return [
    run.processedSnapshotCount,
    run.processedHoldingCount,
    run.processedLedgerCount,
    run.projectionOutputOffset,
    run.projectionCursorSecurityId ?? "",
    run.projectionActiveSecurityId ?? "",
  ].join(":");
}

function mapRun(row: Record<string, unknown>): CalculationRunRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    rangeFrom: String(row.range_from),
    rangeTo: String(row.range_to),
    calculationVersion: Number(row.calculation_version),
    reason: String(row.reason),
    invalidationSource:
      row.invalidation_source === null ? null : String(row.invalidation_source),
    pipeline: String(row.pipeline) as CalculationRunPipeline,
    status: String(row.status) as CalculationRunStatus,
    attempt: Number(row.attempt),
    stallCount: Number(row.stall_count),
    stallCheckpoint:
      row.stall_checkpoint === null ? null : String(row.stall_checkpoint),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : String(row.lease_expires_at),
    ledgerHighWaterStart: String(row.ledger_high_water_start),
    ledgerHighWaterEnd:
      row.ledger_high_water_end === null
        ? null
        : String(row.ledger_high_water_end),
    marketDataCutoff:
      row.market_data_cutoff === null ? null : String(row.market_data_cutoff),
    calendarEvidenceJson:
      row.calendar_evidence_json === null
        ? null
        : String(row.calendar_evidence_json),
    processedSnapshotCount: Number(row.processed_snapshot_count),
    processedHoldingCount: Number(row.processed_holding_count),
    processedLedgerCount: Number(row.processed_ledger_count),
    projectionCursorSecurityId:
      row.projection_cursor_security_id === null
        ? null
        : String(row.projection_cursor_security_id),
    projectionActiveSecurityId:
      row.projection_active_security_id === null
        ? null
        : String(row.projection_active_security_id),
    projectionOutputOffset: Number(row.projection_output_offset),
    idempotencyKey: String(row.idempotency_key),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    failureCategory:
      row.failure_category === null ? null : String(row.failure_category),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const selectRun = `
  SELECT * FROM calculation_runs
  WHERE user_id = ? AND portfolio_id = ? AND id = ?
`;

export function createCalculationRunRepository(sql: SqlClient) {
  async function get(
    userId: string,
    portfolioId: string,
    runId: string,
  ): Promise<CalculationRunRecord | null> {
    const row = await sql.get<Record<string, unknown>>(selectRun, [
      userId,
      portfolioId,
      runId,
    ]);
    return row ? mapRun(row) : null;
  }

  return {
    get,
    async request(
      userId: string,
      input: RequestCalculationRunInput,
    ): Promise<CalculationRunRecord> {
      await sql.run(
        `
          INSERT INTO calculation_runs (
            id, user_id, portfolio_id, range_from, range_to,
            calculation_version, reason, invalidation_source, pipeline,
            status, attempt,
            ledger_high_water_start, idempotency_key, created_at, updated_at
            , market_data_cutoff, calendar_evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, portfolio_id, calculation_version, idempotency_key)
          DO NOTHING
        `,
        [
          input.id,
          userId,
          input.portfolioId,
          input.rangeFrom,
          input.rangeTo,
          input.calculationVersion,
          input.reason,
          input.invalidationSource ?? null,
          input.pipeline ?? "projection",
          input.ledgerHighWaterStart,
          input.idempotencyKey,
          input.now,
          input.now,
          input.marketDataCutoff ?? input.now,
          input.calendarEvidenceJson ?? null,
        ],
      );

      const run = await get(userId, input.portfolioId, input.id);
      if (run) {
        return run;
      }

      const existing = await sql.get<Record<string, unknown>>(
        `
          SELECT * FROM calculation_runs
          WHERE user_id = ? AND portfolio_id = ?
            AND calculation_version = ? AND idempotency_key = ?
        `,
        [
          userId,
          input.portfolioId,
          input.calculationVersion,
          input.idempotencyKey,
        ],
      );
      if (!existing) {
        throw new Error("calculation_run_insert_not_visible");
      }
      return mapRun(existing);
    },

    async claim(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      leaseExpiresAt: string,
      now: string,
    ): Promise<ClaimCalculationRunResult> {
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET status = 'running', attempt = attempt + 1,
              lease_owner = ?, lease_expires_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE user_id = ? AND portfolio_id = ? AND id = ?
            AND (
              status = 'queued'
              OR (status = 'running' AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= ?)
            )
        `,
        [leaseOwner, leaseExpiresAt, now, now, userId, portfolioId, runId, now],
      );
      if (result.changes !== 1) {
        return { ok: false, reason: "not-claimable" };
      }

      const run = await get(userId, portfolioId, runId);
      return run ? { ok: true, run } : { ok: false, reason: "not-claimable" };
    },

    async complete(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      currentLedgerHighWater: string,
      now: string,
      processedSnapshotCount: number,
      processedHoldingCount: number,
    ): Promise<CompleteCalculationRunResult> {
      const existing = await get(userId, portfolioId, runId);
      if (!existing || existing.leaseOwner !== leaseOwner) {
        return { ok: false, reason: "not-owned" };
      }
      if (existing.status !== "running") {
        return { ok: false, reason: "not-running" };
      }
      if (existing.leaseExpiresAt === null || existing.leaseExpiresAt <= now) {
        return { ok: false, reason: "not-owned" };
      }
      if (existing.ledgerHighWaterStart !== currentLedgerHighWater) {
        return { ok: false, reason: "stale-ledger" };
      }

      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET status = 'completed', ledger_high_water_end = ?,
              processed_snapshot_count = ?, processed_holding_count = ?,
              completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?
          WHERE user_id = ? AND portfolio_id = ? AND id = ?
            AND status = 'running' AND lease_owner = ?
            AND lease_expires_at > ?
            AND ledger_high_water_start = ?
        `,
        [
          currentLedgerHighWater,
          processedSnapshotCount,
          processedHoldingCount,
          now,
          now,
          userId,
          portfolioId,
          runId,
          leaseOwner,
          now,
          currentLedgerHighWater,
        ],
      );
      if (result.changes !== 1) {
        return { ok: false, reason: "stale-ledger" };
      }

      const run = await get(userId, portfolioId, runId);
      return run ? { ok: true, run } : { ok: false, reason: "not-running" };
    },

    // CALC-003: the oldest claimable (queued, or running with an expired
    // lease) run for one user/portfolio -- the executor's coalescing model
    // relies on processing these oldest-first (see
    // `app/calculation-executor-service.ts`'s doc comment and `hasNewerRun`
    // below, which is what actually decides supersession -- NOT a
    // recomputed "current ledger high water", per the CALC-003 review round
    // that found comparing against `MAX(trade_at)` gives false positives
    // for a reversal of a non-latest transaction or a backdated post).
    async nextClaimable(
      userId: string,
      portfolioId: string,
      pipeline: CalculationRunPipeline,
      now: string,
    ): Promise<CalculationRunRecord | null> {
      const row = await sql.get<Record<string, unknown>>(
        `
          SELECT * FROM calculation_runs
          WHERE user_id = ? AND portfolio_id = ? AND pipeline = ?
            AND (
              status = 'queued'
              OR (status = 'running' AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= ?)
            )
          ORDER BY created_at ASC, id ASC LIMIT 1
        `,
        [userId, portfolioId, pipeline, now],
      );
      return row ? mapRun(row) : null;
    },

    // CALC-003 (review-round B1 fix): is there a STRICTLY newer
    // `calculation_runs` row for this user/portfolio, of ANY status (not
    // just currently claimable ones)? This is the executor's sole
    // supersession signal -- a run whose own `(created_at, id)` is not the
    // latest for its portfolio has, by construction, already been
    // overtaken by whatever later ledger mutation/import queued the newer
    // row, regardless of that newer row's current processing status
    // (queued, still running under another worker's live lease, or already
    // completed/failed). Comparing against calculation_runs' own insertion
    // order rather than the transactions table's `trade_at` ordering is
    // deliberate: `trade_at` does not move for a reversal of a non-latest
    // transaction or a backdated post, which previously produced false-
    // positive "superseded" failures even though nothing else was queued.
    // Checking ANY status (not only claimable ones) closes the race a
    // claimable-only check would leave open: a newer run that raced ahead
    // and already published while this run's lease was still held elsewhere
    // must still be recognised as newer once this run resumes, so a stale
    // resume can never overwrite a fresher publication.
    //
    // CALC-004: scoped by `pipeline` -- a commit today queues ONE row per
    // pipeline (see `db/repositories/snapshots.ts`'s `resolveSnapshotRunRange`/
    // `computeSnapshotRunRange` and their callers in `ledger.ts`/
    // `import-commit.ts`), and
    // without this scope the snapshot row (inserted after the projection
    // row for the same commit) would look like a "newer run" to the
    // projection row's own coalescing check and vice versa, permanently
    // superseding a healthy sibling pipeline's run that was never actually
    // superseded by anything in ITS OWN pipeline. This is the core
    // structural risk this task's tests probe.
    async hasNewerRun(
      userId: string,
      portfolioId: string,
      pipeline: CalculationRunPipeline,
      createdAt: string,
      runId: string,
    ): Promise<boolean> {
      const row = await sql.get<{ marker: number }>(
        `
          SELECT 1 AS marker FROM calculation_runs
          WHERE user_id = ? AND portfolio_id = ? AND pipeline = ?
            AND (created_at > ? OR (created_at = ? AND id > ?))
          LIMIT 1
        `,
        [userId, portfolioId, pipeline, createdAt, createdAt, runId],
      );
      return row !== undefined;
    },

    // CALC-003: terminates a run this caller currently holds the lease on.
    // Used for two distinct cases the executor must tell apart (see its doc
    // comment): a run superseded by a newer ledger high-water mark
    // (`failureCategory: "superseded_by_newer_run"`), and a run whose
    // rebuild step returned a genuine structural failure (invalid decimal/
    // scale, oversell, an oversized per-security event count) that retrying
    // the identical computation could never fix. Never called for
    // transient failures (`not_owned`, `atomic_failure`) -- those are left
    // `running` so the existing lease-expiry machinery retries them.
    async fail(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      now: string,
      failureCategory: string,
    ): Promise<FailCalculationRunResult> {
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET status = 'failed', failure_category = ?,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE user_id = ? AND portfolio_id = ? AND id = ?
            AND status = 'running' AND lease_owner = ?
        `,
        [failureCategory, now, userId, portfolioId, runId, leaseOwner],
      );
      if (result.changes !== 1) return { ok: false, reason: "not-owned" };

      const run = await get(userId, portfolioId, runId);
      return run ? { ok: true, run } : { ok: false, reason: "not-owned" };
    },

    // CALC-003 review-round B4 fix: `db/repositories/market-data.ts` queues
    // `manual_override` runs with `ledger_high_water_start = ''` (no
    // triggering ledger transaction to anchor to). `projections.rebuild`'s
    // own staleness guard compares the run's STORED `ledger_high_water_start`
    // against the caller's `currentLedgerHighWater` input -- passing a
    // resolved real value as the input while the STORED column stays ''
    // would make every rebuild/publish call for this run fail closed
    // (stale_ledger), never mismatch-tolerant. This persists a resolved,
    // REAL transaction id into the row itself (guarded on the column still
    // being '' and this caller owning the lease, so a normal run's real
    // value can never be overwritten) so every subsequent read/compare
    // (including `projection_publications.ledger_high_water`, which must
    // never carry '' -- `owned-holdings.ts`/`owned-capital-gains.ts` both
    // reject an empty value) is internally consistent.
    async resolveEmptyHighWater(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      highWater: string,
      now: string,
    ): Promise<boolean> {
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET ledger_high_water_start = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND portfolio_id = ?
            AND status = 'running' AND lease_owner = ?
            AND ledger_high_water_start = ''
        `,
        [highWater, now, runId, userId, portfolioId, leaseOwner],
      );
      return result.changes === 1;
    },

    // CALC-004 review-round B1 fix: called once per claim (after the
    // supersession check, before any rebuild call) with the run record AS
    // CLAIMED -- its checkpoint columns reflect whatever they were left at
    // by the run's PREVIOUS advance, before this invocation does any work
    // of its own. Compares that against `stall_checkpoint` (the
    // fingerprint recorded at the run's PREVIOUS claim): identical means
    // the previous claim made ZERO forward progress (a genuine transient-
    // failure loop, never a healthy resumption -- see
    // `checkpointFingerprint`'s doc comment for why every checkpoint
    // column either pipeline can move is covered), so `stall_count`
    // increments; any movement resets it to 0. The executor terminates a
    // run once `stall_count` crosses its threshold -- this method only
    // measures and persists, it never decides to fail the run itself.
    async recordClaimProgress(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      claimedRun: CalculationRunRecord,
      now: string,
    ): Promise<RecordClaimProgressResult> {
      const fingerprint = checkpointFingerprint(claimedRun);
      const stallCount =
        claimedRun.stallCheckpoint === fingerprint
          ? claimedRun.stallCount + 1
          : 0;
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET stall_count = ?, stall_checkpoint = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND portfolio_id = ?
            AND status = 'running' AND lease_owner = ?
        `,
        [stallCount, fingerprint, now, runId, userId, portfolioId, leaseOwner],
      );
      if (result.changes !== 1) return { ok: false, reason: "not-owned" };
      return { ok: true, stallCount };
    },

    // CALC-003 review-round B5a fix: a real committed batch/accept can queue
    // one `ledger_mutation` run PER committed row (100+ for a realistic
    // import) in addition to the aggregate `import_commit` run -- claiming
    // and failing each individually (`nextClaimable` + `claim` + `fail`,
    // ~5-6 statements each) burns the entire post-commit statement budget
    // on bookkeeping before the executor ever reaches the one run that can
    // actually complete. This does the SAME "supersede everything not the
    // latest-created row" decision `hasNewerRun` makes per-claim, but as
    // ONE bulk UPDATE covering every `queued` row at once (a `running` row
    // is never touched here -- it may be actively leased elsewhere; the
    // per-claim `hasNewerRun` check remains the correctness backstop for
    // that rarer case). Returns the number of runs superseded.
    // CALC-004: scoped by `pipeline` on BOTH the outer stale-candidate row
    // and the `newer` subquery -- see `hasNewerRun`'s doc comment for why a
    // cross-pipeline row must never count as "newer" here either.
    async supersedeStaleQueuedRuns(
      userId: string,
      portfolioId: string,
      pipeline: CalculationRunPipeline,
      now: string,
    ): Promise<number> {
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET status = 'failed', failure_category = 'superseded_by_newer_run',
              updated_at = ?
          WHERE user_id = ? AND portfolio_id = ? AND pipeline = ?
            AND status = 'queued'
            AND EXISTS (
              SELECT 1 FROM calculation_runs newer
              WHERE newer.user_id = calculation_runs.user_id
                AND newer.portfolio_id = calculation_runs.portfolio_id
                AND newer.pipeline = calculation_runs.pipeline
                AND (
                  newer.created_at > calculation_runs.created_at
                  OR (newer.created_at = calculation_runs.created_at
                      AND newer.id > calculation_runs.id)
                )
            )
        `,
        [now, userId, portfolioId, pipeline],
      );
      return result.changes;
    },

    // CALC-003 review-round B5b fix: releases (without abandoning) a run
    // this caller holds the lease on, by moving `lease_expires_at` to
    // `now` -- `nextClaimable`/`claim`'s own "running AND lease expired"
    // branch then treats it as immediately claimable, rather than the
    // caller (or a later trigger) having to wait out the remainder of
    // `LEASE_DURATION_MS`. Every persisted cursor field (`processed_*`,
    // `projection_cursor_security_id`, `projection_active_security_id`,
    // `projection_output_offset`) is untouched -- this is purely a lease
    // release, not a reset, matching the existing resumable machinery's own
    // "abandoned lease" resume path exactly (only reachable sooner).
    async releaseLease(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      now: string,
    ): Promise<boolean> {
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND portfolio_id = ?
            AND status = 'running' AND lease_owner = ?
        `,
        [now, now, runId, userId, portfolioId, leaseOwner],
      );
      return result.changes === 1;
    },

    // CALC-003 cron backstop (trigger 3): discovers which (user, portfolio)
    // pairs have claimable work WITHOUT reading any other owner-scoped
    // table -- the sweep then advances each pair through the same
    // per-user-scoped repositories the request-path triggers use (no
    // ownership widening beyond this bookkeeping-only discovery query).
    // Oldest-pending-work-first, matching `nextClaimable`'s ordering.
    // CALC-004: groups by `pipeline` too, since each pipeline is advanced
    // through its own separate `advanceCalculationRuns` call (see
    // `app/calculation-executor-service.ts`'s `sweepCalculationRuns`) --
    // otherwise a (user, portfolio) pair with claimable work in only ONE
    // pipeline would still spend a sweep slot advancing the other,
    // untouched pipeline for no reason.
    async listClaimablePortfolios(
      now: string,
      limit: number,
    ): Promise<ClaimableCalculationRunPortfolio[]> {
      const rows = await sql.all<Record<string, unknown>>(
        `
          SELECT user_id, portfolio_id, pipeline, MIN(created_at) AS oldest
          FROM calculation_runs
          WHERE status = 'queued'
            OR (status = 'running' AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= ?)
          GROUP BY user_id, portfolio_id, pipeline
          ORDER BY oldest ASC
          LIMIT ?
        `,
        [now, limit],
      );
      return rows.map((row) => ({
        userId: String(row.user_id),
        portfolioId: String(row.portfolio_id),
        pipeline: String(row.pipeline) as CalculationRunPipeline,
      }));
    },

    // CALC-005: bulk-terminates EVERY queued/running row for one PIPELINE,
    // across all users/portfolios, regardless of lease state -- the
    // mechanism the retired snapshot pipeline's cron-sweep cleanup uses
    // (`app/calculation-executor-service.ts`'s `sweepCalculationRuns`) to
    // drive production's stuck run and queued residue to a terminal state
    // without a manual migration touching run rows as data. Unlike
    // `supersedeStaleQueuedRuns` (which only supersedes a row this SAME
    // portfolio/pipeline has a genuinely NEWER sibling for), this has no
    // "newer row" precondition: once a pipeline is retired, EVERY one of
    // its queued/running rows is stale by definition, not just the ones a
    // later commit happened to overtake -- including a `running` row whose
    // lease has not yet expired, since no code path will ever renew or
    // complete that lease again. Bookkeeping-only (touches only
    // `calculation_runs`' own status/lease columns, no other owner-scoped
    // table), matching `listClaimablePortfolios`'s existing precedent for a
    // global, non-user-scoped maintenance query over this table -- see that
    // method's doc comment for why this does not widen the ownership
    // boundary. Uses the pre-existing 'abandoned' status (already a valid
    // `calculation_runs_status_check` value -- see `db/schema.ts` -- never
    // previously written by any code path) rather than 'failed', since
    // nothing about these runs failed: the pipeline itself was retired out
    // from under them. Returns the number of rows terminated.
    async terminatePipeline(
      pipeline: CalculationRunPipeline,
      now: string,
    ): Promise<number> {
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET status = 'abandoned', failure_category = 'pipeline_retired',
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE pipeline = ? AND status IN ('queued', 'running')
        `,
        [now, pipeline],
      );
      return result.changes;
    },
  };
}
