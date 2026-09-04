// UI-013 review round: pure, directly-testable helpers extracted from
// `components/import-review.tsx` -- mirrors `sharesight-sync-panel-helpers.ts`'s
// extraction pattern and its own header note: this codebase's component
// tests render static markup only (`renderToStaticMarkup`), which cannot
// exercise `ImportReview`'s own stateful fetch/accept-loop logic (unlike
// `ImportHistoryDetailPanel`, it takes no injectable `review`/`commit` prop
// to render against -- its state is populated entirely by internal fetch
// calls). Two BLOCKING review findings were both formulas that a
// source-text regex test could not have caught (the right words were
// present; the VALUES they computed were wrong) -- B1 rendered
// reconciliation-intent counts as committed ledger fact, B2 let an
// unrelated batch's commit result mark THIS review as committed. Both are
// now pure functions with their own real-input/real-output tests
// (tests/ui-013.test.ts), so the same class of defect fails a direct
// function-call assertion, not merely a "does this text appear" check.

/** The commit machinery's own row-status counts for a batch -- computed
 * once, server-side, from `import_rows.commit_status`/`excluded_by_owner_at`
 * (see `app/import-preview.ts`'s `commitProgress` field and
 * `db/repositories/import-commit.ts`'s identically-shaped `summary()`
 * query) -- NEVER `preview.counts`, which is reconciliation INTENT computed
 * fresh from the current staged rows, not a record of what a past commit
 * actually did. */
export type ReviewCommitProgress = {
  committedRows: number;
  skippedRows: number;
  excludedByOwnerRows: number;
  // BRK-019 slice 1: the subset of `skippedRows` skipped because this row's
  // identity already exists committed but its value differs (see
  // `db/repositories/import-commit.ts`'s `committedRecordDiffersIssueStatement`
  // doc comment). Optional/defaulted to 0 in `rowEffectsSentence` below so
  // every pre-this-task caller/fixture that never mentions it keeps
  // compiling and rendering unchanged.
  needsDecisionRows?: number;
  remainingRows: number;
};

/** The subset of a commit-route/accept-route JSON response this module
 * needs -- mirrors `CommitResult` in `import-review.tsx` structurally
 * (kept as a separate type here so this module has no import-time
 * dependency on the component file). */
export type ReviewCommitResult = {
  batchId: string;
  status: "committing" | "committed";
  committedRows: number;
  skippedRows: number;
  excludedByOwnerRows: number;
  // BRK-019 slice 1: see `ReviewCommitProgress.needsDecisionRows`'s doc
  // comment -- same optional/defaulted scoping.
  needsDecisionRows?: number;
  remainingRows: number;
};

export type ReviewBatchSummary = { id: string; status: string };

/**
 * UI-013 review round B2 (BLOCKING repro): resuming a DIFFERENT batch's
 * interrupted commit from the import-history panel below (`onResume` ->
 * `resumeHistoryCommit` -> `setCommit(result.commit)`) overwrote the
 * `commit` state a currently-open, unrelated review was also reading --
 * that review's Accept Import buttons and commit panel silently vanished
 * behind a false "Import committed" status line. `CommitResult` already
 * carries the `batchId` it belongs to (BRK-009B); every read of `commit`
 * inside the review section MUST go through this scope check first, never
 * the raw `commit` state directly.
 */
// Generic over `T` (the caller's own, possibly richer, commit-result type --
// `import-review.tsx`'s `CommitResult` carries fields this module never
// needs, e.g. `highWaterRow`/`resumed`/`idempotent`) so the caller keeps its
// own concrete type after scoping, while this function -- and its tests --
// only ever need the minimal `{ batchId, status }` shape to do the check.
export function scopeCommitToBatch<T extends { batchId: string }>(
  commit: T | null,
  batch: ReviewBatchSummary | null,
): T | null {
  if (!commit || !batch) return null;
  return commit.batchId === batch.id ? commit : null;
}

/** True once the review's own batch is actually done -- server-confirmed
 * `committed`/`reversed` (reachable after a reload), OR a same-session
 * commit result FOR THIS batch reporting `committed` (CSV's
 * `commitImport()` deliberately never refreshes `review.batch.status`, see
 * its own comment in `import-review.tsx`, so `review.batch.status` alone
 * would miss a same-session CSV commit). `scopedCommit` must already be
 * batch-scoped via `scopeCommitToBatch` -- this function trusts its caller
 * on that, it does not re-check batchId itself. */
export function isCommittedOrReversed(
  batch: ReviewBatchSummary,
  scopedCommit: ReviewCommitResult | null,
): boolean {
  return (
    batch.status === "committed" ||
    batch.status === "reversed" ||
    scopedCommit?.status === "committed"
  );
}

function rowEffectsSentence(effects: {
  committedRows: number;
  skippedRows: number;
  excludedByOwnerRows: number;
  needsDecisionRows?: number;
}): string {
  const needsDecisionRows = effects.needsDecisionRows ?? 0;
  // BRK-019 slice 1: named alongside the pre-existing "excluded by owner"
  // parenthetical only when non-zero, so the pre-this-task sentence stays
  // byte-for-byte identical whenever no row was skipped for this reason
  // (every pre-this-task caller/fixture, which never supplies the field at
  // all).
  const skippedDetail =
    needsDecisionRows > 0
      ? `(${effects.excludedByOwnerRows} excluded by owner; ${needsDecisionRows} need${needsDecisionRows === 1 ? "s" : ""} a decision)`
      : `(${effects.excludedByOwnerRows} excluded by owner)`;
  return (
    `Committed ${effects.committedRows} row effect${effects.committedRows === 1 ? "" : "s"}; ` +
    `${effects.skippedRows} row${effects.skippedRows === 1 ? "" : "s"} ` +
    `${effects.skippedRows === 1 ? "was" : "were"} skipped ` +
    `${skippedDetail}.`
  );
}

/**
 * UI-013 review round B1 (BLOCKING repro): a re-sync that overlapped an
 * already-committed batch showed "5 transaction rows" (the CURRENT
 * preview's reconciliation intent) when only 2 rows had actually committed
 * and 3 were skipped as duplicates -- and the prior "Committed N row
 * effects; M skipped (X excluded)" receipt this replaced was deleted
 * outright, a regression. This restores that exact accuracy bar, sourced
 * from real commit machinery counts only: prefers a same-session
 * `scopedCommit` result (the freshest, most specific source -- this exact
 * accept/commit action's own response) and falls back to the review's
 * server-computed `commitProgress` (accurate after a reload, when no live
 * commit result exists for this batch -- see `app/import-preview.ts`).
 * Never `preview.counts`.
 */
export function deriveCommittedStatusLine(
  batchStatus: string,
  scopedCommit: ReviewCommitResult | null,
  commitProgress: ReviewCommitProgress,
): string {
  const effects = scopedCommit ?? commitProgress;
  const sentence = rowEffectsSentence(effects);
  return batchStatus === "reversed"
    ? `Import reversed. ${sentence} See import history for details.`
    : `Import committed. ${sentence} See import history for details.`;
}

/** The minimal shape `committedConfirmationText` needs from a history-list
 * entry (`HistoryBatch` in `import-review.tsx`) -- kept structural here, same
 * reasoning as `ReviewBatchSummary` above, so this module has no import-time
 * dependency on the component file. */
export type CommittedHistoryEntry = {
  committedAt: string | null;
  reversedAt: string | null;
};

/**
 * UI-020 (owner-reported): after committing/accepting a Sharesight batch,
 * the header status pill kept reading "Ready to review" and the bottom of
 * the "Review securities" section (where the now-hidden "Accept Import"
 * button used to sit) gave no confirmation at all. This is that
 * confirmation's text -- a real, business-relevant date when this batch's
 * own history-list entry has one, honestly omitted (never fabricated) when
 * it has not loaded yet. `historyEntry` must already be scoped to THIS
 * batch by its caller (matched by id in the `history` list, never the
 * last-viewed `historyDetail` -- see `import-review.tsx`'s own header note
 * on `reviewHistoryEntry`, the same cross-batch staleness class
 * `scopeCommitToBatch` guards against for `commit`).
 */
export function committedConfirmationText(
  batchStatus: string,
  historyEntry: CommittedHistoryEntry | null,
): string {
  const reversed = batchStatus === "reversed";
  const at = reversed ? historyEntry?.reversedAt : historyEntry?.committedAt;
  const dateSuffix = at ? ` on ${at.slice(0, 10)}` : "";
  return reversed
    ? `This batch was reversed${dateSuffix}.`
    : `This batch was committed${dateSuffix}.`;
}

/** The real "N of M rows" denominator for the accept loop's progress text
 * -- `processed` (committed + skipped so far) out of `total` (processed +
 * still-`staged`), both derived from the commit machinery's OWN response
 * fields (`ReviewCommitResult`), never `preview.counts.transactionCreates
 * + dividendCreates` (reconciliation intent, which can diverge from what
 * actually gets processed once duplicates/skips are discovered mid-commit). */
export function acceptLoopProgress(commit: ReviewCommitResult): {
  processed: number;
  total: number;
} {
  const processed = commit.committedRows + commit.skippedRows;
  return { processed, total: processed + commit.remainingRows };
}

/** Minimal shape `runAcceptCommitLoop` needs from a fetch `Response` --
 * kept structural (not the DOM `Response` type) so a test can hand it a
 * plain object with no Fetch API polyfill. Generic over `T` (the caller's
 * own commit-result type, e.g. `import-review.tsx`'s richer `CommitResult`)
 * for the same reason as `scopeCommitToBatch` above -- the caller's real
 * fetch response flows through untouched (a real `Response`'s `.json()`
 * returns `Promise<any>`, structurally compatible with any `T`). */
export type AcceptFetchResponse<T extends ReviewCommitResult> = {
  ok: boolean;
  json(): Promise<{ ok: true; commit: T } | { ok: false; message: string }>;
};

export type AcceptLoopOutcome<T extends ReviewCommitResult> =
  { ok: true; commit: T } | { ok: false; message: string; aborted?: boolean };

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * UI-013 review round B3 (BLOCKING): a single accept POST can return with
 * the batch still `committing` (the server's own bounded per-invocation
 * commit-chunk cap -- `app/import-accept-service.ts`'s
 * `ACCEPT_COMMIT_LOOP_MAX_ITERATIONS`). This is the CLIENT'S continuation
 * layer for a batch large enough to exceed that server cap: it re-POSTs
 * the identical idempotent accept request (safe -- deterministic
 * `accept:<batchId>` commit idempotency key, resumes from
 * `commit_high_water_row`) until `committed`, a real error (INCLUDING a
 * 409 -- `!response.ok` ends the loop immediately with that error
 * surfaced, never silently retried), the abort signal fires, or
 * `maxIterations` is reached. Extracted as a pure(ish) function (its only
 * side effect is the supplied `fetchAccept`/`onProgress` callbacks) so this
 * exact termination behaviour has its own real-input/real-output test,
 * independent of React state or a render harness.
 */
export async function runAcceptCommitLoop<
  T extends ReviewCommitResult,
>(options: {
  maxIterations: number;
  signal?: AbortSignal;
  fetchAccept: () => Promise<AcceptFetchResponse<T>>;
  onProgress?: (commit: T) => void;
}): Promise<AcceptLoopOutcome<T>> {
  let latest: T | null = null;
  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    if (options.signal?.aborted) {
      return {
        ok: false,
        message: "This request was cancelled.",
        aborted: true,
      };
    }
    let response: AcceptFetchResponse<T>;
    try {
      response = await options.fetchAccept();
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          message: "This request was cancelled.",
          aborted: true,
        };
      }
      throw error;
    }
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      return {
        ok: false,
        message:
          result.ok === false
            ? result.message
            : "This import could not be accepted.",
      };
    }
    latest = result.commit;
    options.onProgress?.(result.commit);
    if (result.commit.status === "committed") {
      return { ok: true, commit: result.commit };
    }
  }
  return {
    ok: false,
    message: latest
      ? "This import is still committing after repeated attempts. Reopen the review or use “Resume this commit” from import history to continue."
      : "This import could not be accepted.",
  };
}
