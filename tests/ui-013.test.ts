/** UI-013 — Post-commit button states and one commit path per batch type.
 *
 * Owner-reported defect (2026-08-18) after the first real Sharesight commit:
 * after committing a `sharesight_sync` batch, both "Commit" and "Accept
 * Import" still showed a busy `cursor: wait`, and the owner had to click
 * Commit repeatedly to pump chunks -- unsure which button did what. See
 * TASKS.md's UI-013 entry for the full binding ruling set.
 *
 * Reviewer round 1 FAILED with four blocking findings, two of them (B1, B2)
 * defects a source-text regex test could not have caught -- the right words
 * were present in the file; the VALUES the code computed were wrong. Per the
 * reviewer's explicit ruling, the fix pulled the derivation logic itself out
 * into pure, directly-testable functions (`app/import-review-commit-state.ts`
 * -- mirrors this codebase's established `sharesight-sync-panel-helpers.ts`
 * extraction pattern for exactly this reason: `ImportReview`'s state is
 * populated entirely by internal fetch calls, so unlike
 * `ImportHistoryDetailPanel` it has no injectable prop a `renderToStaticMarkup`
 * harness could render against). Part 2 below calls those functions directly
 * with real inputs and asserts real outputs -- the same class of defect now
 * fails a function-call assertion, not a "does this text appear" check.
 * Part 5 keeps a SMALL number of source assertions, but only for wiring (the
 * JSX uses the extracted function/the right prop), never for a formula.
 *
 * Covers:
 * 1. `cursor: wait` only under `[aria-busy="true"]` (a real in-flight
 *    request); every other disabled reason is `not-allowed`.
 * 2. B1: the committed/reversed status line reports actual commit-machinery
 *    row counts, never reconciliation-intent preview counts.
 * 3. B2: `commit` state is scoped to the currently-open review's own batch
 *    before anything reads it.
 * 4. B3: `acceptImportWithContext`'s server-side loop is capped at a
 *    measured-safe 8 iterations; a `committing` batch remains reachable from
 *    import history to resume it.
 * 5. `runAcceptCommitLoop` terminates immediately on a real error (never
 *    silently retries a 409), respects an abort signal, and respects its own
 *    iteration cap.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import { acceptImportWithContext } from "../app/import-accept-service.ts";
import {
  createOwnedImportStagingRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import type {
  SharesightClient,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";
import {
  acceptLoopProgress,
  deriveCommittedStatusLine,
  isCommittedOrReversed,
  runAcceptCommitLoop,
  scopeCommitToBatch,
  type AcceptFetchResponse,
  type ReviewCommitResult,
} from "../app/import-review-commit-state.ts";

// ---------------------------------------------------------------------------
// Part 1: cursor:wait CSS assertions.
// ---------------------------------------------------------------------------

test('UI-013: .import-commit-panel > button shows cursor:wait ONLY under [aria-busy="true"], never on a plain disabled state', async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.import-commit-panel > button\[aria-busy="true"\]\s*\{[^}]*cursor:\s*wait;/,
  );
  const disabledRule = css.match(
    /\.import-commit-panel > button:disabled:not\(\[aria-busy="true"\]\)\s*\{([^}]*)\}/,
  );
  assert.ok(disabledRule, "expected the not-allowed split rule");
  assert.match(disabledRule![1]!, /cursor:\s*not-allowed;/);
  assert.doesNotMatch(disabledRule![1]!, /cursor:\s*wait;/);
});

test('UI-013: .import-reversal-button splits the same way -- cursor:wait only under [aria-busy="true"], not-allowed on a plain disabled state', async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.import-reversal-button\[aria-busy="true"\]\s*\{[^}]*cursor:\s*wait;/,
  );
  const disabledRule = css.match(
    /\.import-reversal-button:disabled:not\(\[aria-busy="true"\]\)\s*\{([^}]*)\}/,
  );
  assert.ok(disabledRule, "expected the not-allowed split rule");
  assert.match(disabledRule![1]!, /cursor:\s*not-allowed;/);
  assert.doesNotMatch(disabledRule![1]!, /cursor:\s*wait;/);
});

test('UI-013 review round follow-up: .import-accept-actions button and .dialog-actions button both get an honest wait cursor under [aria-busy="true"] (accept trigger buttons + the dialog confirm button)', async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.import-accept-actions button\[aria-busy="true"\]\s*\{[^}]*cursor:\s*wait;/,
  );
  const disabledRule = css.match(
    /\.import-accept-actions button:disabled:not\(\[aria-busy="true"\]\)\s*\{([^}]*)\}/,
  );
  assert.ok(disabledRule, "expected the not-allowed split rule");
  assert.match(disabledRule![1]!, /cursor:\s*not-allowed;/);
  assert.match(
    css,
    /\.dialog-actions button\[aria-busy="true"\]\s*\{[^}]*cursor:\s*wait;/,
  );
});

test("UI-013: purely in-flight-gated history buttons keep an unconditional cursor:wait (never split)", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const rule = css.match(
    /\.history-refresh:disabled,\s*\n\.history-commit-progress button:disabled,\s*\n\.history-load-more:disabled\s*\{([^}]*)\}/,
  );
  assert.ok(
    rule,
    "expected the pure-pending history buttons to share one rule",
  );
  assert.match(rule![1]!, /cursor:\s*wait;/);

  const resumeRule = css.match(
    /\.import-history-list li \.history-open-review:disabled,\s*\n\.import-history-resume-review button:disabled\s*\{([^}]*)\}/,
  );
  assert.ok(resumeRule, "expected .history-open-review's disabled rule");
  assert.match(resumeRule![1]!, /cursor:\s*wait;/);
});

// ---------------------------------------------------------------------------
// Part 2: pure derivation functions (app/import-review-commit-state.ts) --
// REAL function calls with REAL inputs, not source-text matching. This is
// the direct fix for the reviewer's structural complaint about round 1's
// tests: B1 and B2 were both wrong FORMULAS, which only a call with
// concrete numbers/ids can actually catch.
// ---------------------------------------------------------------------------

function commitResult(
  overrides: Partial<ReviewCommitResult> = {},
): ReviewCommitResult {
  return {
    batchId: "batch-a",
    status: "committed",
    committedRows: 0,
    skippedRows: 0,
    excludedByOwnerRows: 0,
    remainingRows: 0,
    ...overrides,
  };
}

test("UI-013 review round B2 (BLOCKING repro): scopeCommitToBatch returns null when the commit result belongs to a DIFFERENT batch than the one currently open", () => {
  const commitForBatchB = commitResult({
    batchId: "batch-b",
    status: "committed",
  });
  const openReviewIsBatchA = { id: "batch-a", status: "ready" };
  assert.equal(
    scopeCommitToBatch(commitForBatchB, openReviewIsBatchA),
    null,
    "resuming batch B's commit must never be attributed to batch A's open review",
  );
});

test("UI-013: scopeCommitToBatch passes the commit result through unchanged when the batchId matches", () => {
  const commitForBatchA = commitResult({
    batchId: "batch-a",
    status: "committing",
  });
  const openReviewIsBatchA = { id: "batch-a", status: "ready" };
  assert.equal(
    scopeCommitToBatch(commitForBatchA, openReviewIsBatchA),
    commitForBatchA,
  );
});

test("UI-013: scopeCommitToBatch returns null when there is no commit result or no open review", () => {
  assert.equal(
    scopeCommitToBatch(null, { id: "batch-a", status: "ready" }),
    null,
  );
  assert.equal(scopeCommitToBatch(commitResult(), null), null);
});

test("UI-013 review round B2 (BLOCKING repro, end-to-end): a DIFFERENT batch's committed commit result never marks THIS review as committed via isCommittedOrReversed", () => {
  const openReviewIsBatchA = { id: "batch-a", status: "ready" };
  const commitForBatchB = commitResult({
    batchId: "batch-b",
    status: "committed",
  });
  const scoped = scopeCommitToBatch(commitForBatchB, openReviewIsBatchA);
  assert.equal(
    isCommittedOrReversed(openReviewIsBatchA, scoped),
    false,
    "batch A must not read as committed just because batch B's commit result is in state",
  );
});

test("UI-013: isCommittedOrReversed is true for server-confirmed committed/reversed batch.status, or a same-session scoped commit reporting committed", () => {
  assert.equal(
    isCommittedOrReversed({ id: "b", status: "committed" }, null),
    true,
  );
  assert.equal(
    isCommittedOrReversed({ id: "b", status: "reversed" }, null),
    true,
  );
  assert.equal(
    isCommittedOrReversed(
      { id: "b", status: "ready" },
      commitResult({ batchId: "b", status: "committed" }),
    ),
    true,
  );
  assert.equal(
    isCommittedOrReversed(
      { id: "b", status: "ready" },
      commitResult({ batchId: "b", status: "committing" }),
    ),
    false,
    "a merely-committing scoped commit must not read as done",
  );
  assert.equal(
    isCommittedOrReversed({ id: "b", status: "ready" }, null),
    false,
  );
});

test("UI-013 review round B1 (BLOCKING repro): deriveCommittedStatusLine reports the ACTUAL commit result's row counts, not a differing preview-intent count -- the reviewer's exact overlap-resync scenario (5 rows of intent, 2 committed, 3 skipped)", () => {
  const line = deriveCommittedStatusLine(
    "committed",
    commitResult({
      status: "committed",
      committedRows: 2,
      skippedRows: 3,
      excludedByOwnerRows: 0,
    }),
    // A DIFFERENT set of numbers on the fallback `commitProgress` argument
    // -- proves the function prefers the live commit result over anything
    // else, and never silently blends in a "5" from somewhere else.
    {
      committedRows: 999,
      skippedRows: 999,
      excludedByOwnerRows: 999,
      remainingRows: 999,
    },
  );
  assert.match(line, /^Import committed\./);
  assert.match(
    line,
    /Committed 2 row effects; 3 rows were skipped \(0 excluded by owner\)\./,
  );
  assert.doesNotMatch(line, /5 transaction row/);
  assert.doesNotMatch(line, /999/);
});

test("UI-013 review round B1: deriveCommittedStatusLine falls back to the review's server-computed commitProgress when there is no live scoped commit result (the post-reload case)", () => {
  const line = deriveCommittedStatusLine("committed", null, {
    committedRows: 7,
    skippedRows: 1,
    excludedByOwnerRows: 1,
    remainingRows: 0,
  });
  assert.match(
    line,
    /Committed 7 row effects; 1 row was skipped \(1 excluded by owner\)\./,
  );
});

test("UI-013: deriveCommittedStatusLine renders distinct, singular-correct copy for a reversed batch", () => {
  const single = deriveCommittedStatusLine("reversed", null, {
    committedRows: 1,
    skippedRows: 1,
    excludedByOwnerRows: 0,
    remainingRows: 0,
  });
  assert.match(single, /^Import reversed\./);
  assert.match(
    single,
    /Committed 1 row effect; 1 row was skipped \(0 excluded by owner\)\./,
  );
});

test("UI-013 review round B1: acceptLoopProgress's total is the machinery's own committed+skipped+remaining, never a preview-intent count", () => {
  const progress = acceptLoopProgress(
    commitResult({ committedRows: 4, skippedRows: 1, remainingRows: 15 }),
  );
  assert.deepEqual(progress, { processed: 5, total: 20 });
});

// ---------------------------------------------------------------------------
// Part 3: runAcceptCommitLoop -- real function calls against a fake fetch,
// proving termination behaviour (409/error, abort, iteration cap) that a
// source-text test cannot verify.
// ---------------------------------------------------------------------------

function fakeAcceptResponse(
  body:
    { ok: true; commit: ReviewCommitResult } | { ok: false; message: string },
  httpOk = true,
): AcceptFetchResponse<ReviewCommitResult> {
  return { ok: httpOk, json: async () => body };
}

test("UI-013: runAcceptCommitLoop resolves immediately when the first response is already committed", async () => {
  let calls = 0;
  const outcome = await runAcceptCommitLoop<ReviewCommitResult>({
    maxIterations: 10,
    fetchAccept: async () => {
      calls += 1;
      return fakeAcceptResponse({
        ok: true,
        commit: commitResult({ status: "committed", committedRows: 2 }),
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.commit.status, "committed");
});

test("UI-013: runAcceptCommitLoop keeps looping across multiple 'committing' responses until 'committed', reporting progress each time", async () => {
  const responses: ("committing" | "committing" | "committed")[] = [
    "committing",
    "committing",
    "committed",
  ];
  let calls = 0;
  const progressed: number[] = [];
  const outcome = await runAcceptCommitLoop<ReviewCommitResult>({
    maxIterations: 10,
    fetchAccept: async () => {
      const status = responses[calls]!;
      calls += 1;
      return fakeAcceptResponse({
        ok: true,
        commit: commitResult({ status, committedRows: calls * 2 }),
      });
    },
    onProgress: (commit) => progressed.push(commit.committedRows),
  });
  assert.equal(calls, 3, "expected exactly one call per queued response");
  assert.equal(outcome.ok, true);
  assert.deepEqual(progressed, [2, 4, 6]);
});

test("UI-013 review round follow-up (verify a 409 exits the loop with the error shown): runAcceptCommitLoop stops on the FIRST non-ok response, never retries, and surfaces that exact error", async () => {
  let calls = 0;
  const outcome = await runAcceptCommitLoop<ReviewCommitResult>({
    maxIterations: 10,
    fetchAccept: async () => {
      calls += 1;
      if (calls === 1) {
        return fakeAcceptResponse({
          ok: true,
          commit: commitResult({ status: "committing", committedRows: 2 }),
        });
      }
      // A 409 -- response.ok is false; the loop must end here, not keep
      // calling fetchAccept.
      return fakeAcceptResponse(
        {
          ok: false,
          message: "This import changed while it was being accepted.",
        },
        false,
      );
    },
  });
  assert.equal(calls, 2, "must stop at the 409, never issue a third call");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(
      outcome.message,
      "This import changed while it was being accepted.",
    );
    assert.equal(outcome.aborted, undefined);
  }
});

test("UI-013: runAcceptCommitLoop stops on an application-level ok:false body too (2xx transport, ok:false payload), surfacing that message", async () => {
  const outcome = await runAcceptCommitLoop<ReviewCommitResult>({
    maxIterations: 10,
    fetchAccept: async () =>
      fakeAcceptResponse({ ok: false, message: "Import batch not found." }),
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.message, "Import batch not found.");
});

test("UI-013: runAcceptCommitLoop respects its own maxIterations cap and reports a distinct message instead of hanging forever", async () => {
  let calls = 0;
  const outcome = await runAcceptCommitLoop<ReviewCommitResult>({
    maxIterations: 4,
    fetchAccept: async () => {
      calls += 1;
      return fakeAcceptResponse({
        ok: true,
        commit: commitResult({
          status: "committing",
          committedRows: calls * 2,
        }),
      });
    },
  });
  assert.equal(
    calls,
    4,
    "must call fetchAccept exactly maxIterations times, never more",
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.message, /still committing after repeated attempts/);
  }
});

test("UI-013 review round follow-up (unmount/abort guard): runAcceptCommitLoop returns aborted:true and issues zero fetch calls when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const outcome = await runAcceptCommitLoop<ReviewCommitResult>({
    maxIterations: 10,
    signal: controller.signal,
    fetchAccept: async () => {
      calls += 1;
      return fakeAcceptResponse({ ok: true, commit: commitResult() });
    },
  });
  assert.equal(calls, 0);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.aborted, true);
});

test("UI-013 review round follow-up: runAcceptCommitLoop treats a thrown AbortError from fetchAccept itself as a clean abort, not a surfaced error", async () => {
  const outcome = await runAcceptCommitLoop<ReviewCommitResult>({
    maxIterations: 10,
    fetchAccept: async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.aborted, true);
});

// ---------------------------------------------------------------------------
// Part 4: isResumableReviewStatus (import-history-detail.tsx) -- widened for
// UI-013 review round B3c to include `committing`, WITHOUT widening
// isMutableExclusionStatus (exclusion mutations stay gated as before).
// ---------------------------------------------------------------------------

test("UI-013 review round B3c: isResumableReviewStatus accepts isMutableExclusionStatus's four statuses PLUS 'committing', and nothing else", async () => {
  const component = await readFile(
    new URL("../app/components/import-history-detail.tsx", import.meta.url),
    "utf8",
  );
  const mutableMatch = component.match(
    /export function isMutableExclusionStatus\(status: string\): boolean \{([\s\S]*?)\n\}/,
  );
  const resumableMatch = component.match(
    /export function isResumableReviewStatus\(status: string\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(mutableMatch, "expected isMutableExclusionStatus");
  assert.ok(resumableMatch, "expected an EXPORTED isResumableReviewStatus");
  const isMutableExclusionStatus = new Function(
    "status",
    mutableMatch![1]!,
  ) as (status: string) => boolean;
  const isResumableReviewStatus = new Function(
    "isMutableExclusionStatus",
    "status",
    resumableMatch![1]!,
  );

  for (const status of [
    "parsed",
    "needs_mapping",
    "invalid",
    "ready",
    "committing",
  ]) {
    assert.equal(
      isResumableReviewStatus(isMutableExclusionStatus, status),
      true,
      status,
    );
  }
  for (const status of [
    "uploaded",
    "committed",
    "reversing",
    "reversed",
    "failed",
  ]) {
    assert.equal(
      isResumableReviewStatus(isMutableExclusionStatus, status),
      false,
      status,
    );
    // Exclusion mutations must NOT widen -- committing/committed/etc. stay
    // blocked from isMutableExclusionStatus exactly as before.
    assert.equal(isMutableExclusionStatus(status), false, status);
  }
  assert.equal(
    isMutableExclusionStatus("committing"),
    false,
    "committing must stay excluded from the exclusion-mutation gate even though it is now resumable-for-review",
  );
});

// ---------------------------------------------------------------------------
// Part 5: light source-wiring assertions -- confirm the JSX actually USES
// the extracted functions/scoped values above (never a formula check; those
// live in Part 2/3 as real calls).
// ---------------------------------------------------------------------------

test("UI-013: the committed status line renders the extracted committedStatusLine value, not an inline-recomputed formula", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /\{committedStatusLine \? \(\s*\n\s*<p className="import-commit-status complete" role="status">\s*\n\s*\{committedStatusLine\}/,
  );
  assert.match(
    component,
    /const committedStatusLine =\s*\n\s*review && isCommittedOrReversed\s*\n\s*\? deriveCommittedStatusLine\(/,
  );
  assert.match(component, /review\.commitProgress \?\? EMPTY_COMMIT_PROGRESS/);
});

test("UI-013 review round B2: every read of the commit result inside the review section goes through the batch-scoped reviewCommit, never the raw commit state", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /const reviewCommit = scopeCommitToBatch\(\s*\n\s*commit,/,
  );
  // Every other occurrence of a bare `commit?.`/`commit.` read (outside the
  // accept/commit action functions themselves, which legitimately read the
  // fetch's own just-received result) must be gone -- grep the review
  // section specifically (from the "Server-issued preview" heading to the
  // history section) for a stray unscoped read.
  const sectionStart = component.indexOf(
    '<p className="eyebrow">Server-issued preview</p>',
  );
  const sectionEnd = component.indexOf('<section className="import-history"');
  assert.ok(sectionStart > -1 && sectionEnd > sectionStart);
  const section = component.slice(sectionStart, sectionEnd);
  assert.doesNotMatch(
    section,
    /[^w]commit\?\.(status|committedRows|skippedRows|excludedByOwnerRows|highWaterRow)/,
    "found an unscoped `commit.*` read inside the rendered review section -- must read `reviewCommit` instead",
  );
  assert.doesNotMatch(section, /\{commit \? \(/);
});

test("UI-013 review round B3c: the history-list-entry Open-review affordance is gated on isResumableReviewStatus, and the accept dialog/trigger buttons carry aria-busy tied to acceptPending", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /isResumableReviewStatus\(batch\.status\) \? \(\s*\n\s*<button[\s\S]*?className="history-open-review"/,
  );
  const acceptTriggerMatches = [
    ...component.matchAll(
      /onClick=\{\(event\) => openAcceptDialog\(event\)\}\s*\n\s*disabled=\{acceptDisabled\}\s*\n\s*aria-busy=\{acceptPending \|\| undefined\}/g,
    ),
  ];
  assert.equal(
    acceptTriggerMatches.length,
    2,
    "expected both the top and bottom Accept Import trigger buttons to carry aria-busy",
  );
  assert.match(
    component,
    /onClick=\{\(\) => void submitAccept\(\)\}\s*\n\s*disabled=\{acceptPending\}\s*\n\s*aria-busy=\{acceptPending \|\| undefined\}/,
  );
});

test("UI-013 review round follow-up: submitAccept creates an AbortController and the component aborts it on unmount", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /const acceptAbortControllerRef = useRef<AbortController \| null>\(null\);/,
  );
  assert.match(
    component,
    /useEffect\(\(\) => \{\s*\n\s*return \(\) => \{\s*\n\s*acceptAbortControllerRef\.current\?\.abort\(\);\s*\n\s*\};\s*\n\s*\}, \[\]\);/,
  );
  assert.match(component, /acceptAbortControllerRef\.current = controller;/);
  assert.match(
    component,
    /fetchAccept: \(\) =>\s*\n\s*fetch\(`\/api\/import\/preview\/\$\{batchId\}\/accept`, \{\s*\n\s*method: "POST",\s*\n\s*signal: controller\.signal,/,
  );
});

test("UI-013: a sharesight_sync batch never renders the legacy 'Mark import ready'/'Financial commit' panels, at ANY status; a strict-versioned-csv batch keeps the Financial commit panel and never renders Accept Import", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /const isSharesightSyncBatch = securitiesReview !== null;/,
  );
  assert.match(
    component,
    /\{!isSharesightSyncBatch &&\s*\n\s*\(review\.batch\.status === "parsed" \|\|\s*\n\s*review\.batch\.status === "needs_mapping"\)\s*\? \(/,
  );
  assert.match(
    component,
    /\{!isSharesightSyncBatch &&\s*\n\s*!isCommittedOrReversed &&\s*\n\s*\(review\.batch\.status === "ready" \|\|\s*\n\s*review\.batch\.status === "committing"\)/,
  );
  // Accept Import buttons live exclusively inside the securitiesReview
  // section (parserFormat === "sharesight_sync"), so a CSV batch never
  // reaches them.
  assert.match(
    component,
    /const securitiesReview =\s*\n\s*review && review\.batch\.parserFormat === "sharesight_sync"/,
  );
});

test("UI-013: a sharesight_sync batch's Accept Import button is NOT disabled while the batch is 'committing' -- it doubles as the resume affordance", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(/const acceptDisabled =\s*\n([\s\S]*?);\n/);
  assert.ok(match, "expected to find the acceptDisabled definition");
  assert.doesNotMatch(match![1]!, /committing/);
});

// ---------------------------------------------------------------------------
// Part 6: accept completes a multi-chunk commit (service level, real DB).
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-18', '2026-08-18', 1);
  `);
  return database;
}

function fakePortfolio(
  overrides: Partial<SharesightPortfolio> = {},
): SharesightPortfolio {
  return {
    id: "sp-1",
    name: "My SS Portfolio",
    currencyCode: "AUD",
    inceptionDate: null,
    tzName: null,
    accessLevel: null,
    financialYearEnd: null,
    cgDiscount: null,
    countryCode: null,
    ownerName: null,
    taxEntityType: null,
    ...overrides,
  };
}

function fakeTrade(overrides: Partial<SharesightTrade> = {}): SharesightTrade {
  return {
    id: "trade-1",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    instrumentCode: "IXJ",
    marketCode: "ASX",
    sharesightInstrumentId: "4242",
    instrumentName: "iShares Global Healthcare (Synthetic)",
    isin: null,
    transactionType: "buy",
    transactionDate: "2026-08-01",
    currencyCode: "AUD",
    quantityDecimal: "5",
    priceDecimal: "10",
    valueDecimal: "50",
    brokerageDecimal: null,
    brokerageCurrencyCode: null,
    exchangeRateDecimal: null,
    exchangeRatePair: null,
    state: null,
    uniqueIdentifier: null,
    paidOnDate: null,
    descriptionCode: null,
    sourceCategory: null,
    comments: null,
    ...overrides,
  };
}

function fakeSharesightClient(fixtures: {
  portfolios?: SharesightPortfolio[];
  trades?: SharesightTrade[];
  tradesResult?: SharesightResult<SharesightTrade[]>;
}): SharesightClient {
  return {
    async listPortfolios() {
      return { ok: true, value: fixtures.portfolios ?? [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return (
        fixtures.tradesResult ?? { ok: true, value: fixtures.trades ?? [] }
      );
    },
    async listPayouts() {
      return { ok: true, value: [] };
    },
  };
}

async function syncBatch(
  client: SqlClient,
  tradeCount: number,
): Promise<string> {
  const sharesightClient = fakeSharesightClient({
    portfolios: [fakePortfolio()],
    trades: Array.from({ length: tradeCount }, (_, index) => {
      const n = index + 1;
      return fakeTrade({
        id: `trade-${n}`,
        transactionDate: `2026-0${((n - 1) % 9) + 1}-01`,
        priceDecimal: String(10 + n),
        valueDecimal: String((10 + n) * 5),
      });
    }),
  });
  const linked = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-req" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(linked.ok, true);
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) throw new Error("unreachable");
  return synced.batchId;
}

test("UI-013: acceptImportWithContext drives a batch spanning multiple commit chunks (DEFAULT_CHUNK_SIZE=2 rows/call) to 'committed' in ONE accept call -- the owner never manually pumps chunks", async () => {
  const database = await migratedDatabase();
  const client: SqlClient = createSqliteSqlClient(database);
  // Five distinct trades -- five committable rows, three commit chunks at
  // the machinery's default chunk size of 2 (2 + 2 + 1), well within the
  // server loop's 8-iteration cap.
  const batchId = await syncBatch(client, 5);

  const result = await acceptImportWithContext(
    { client, userId: "user-a", requestId: "accept-req" },
    batchId,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.commit.status,
    "committed",
    "expected ONE accept call to finish a 5-row (3-chunk) batch, not leave it 'committing'",
  );
  assert.equal(result.commit.committedRows, 5);
  assert.equal(result.commit.remainingRows, 0);

  const staging = createOwnedImportStagingRepository(client);
  const rows = await staging.listRows("user-a", batchId);
  assert.equal(
    rows.filter((row) => row.commitStatus === "committed").length,
    5,
  );

  // Idempotent re-accept converges on the same committed result.
  const reAccepted = await acceptImportWithContext(
    { client, userId: "user-a", requestId: "accept-req-2" },
    batchId,
  );
  assert.equal(reAccepted.ok, true);
  if (!reAccepted.ok) return;
  assert.equal(reAccepted.commit.status, "committed");
  assert.equal(reAccepted.commit.committedRows, 5);
});

test("UI-013 review round B3 (BLOCKING correction, real behavioural cap test): a batch large enough to exceed the server's 8-iteration cap (16 rows committable in 8 chunks) stops at 'committing' after ONE accept call, with the remaining rows finished by a SECOND idempotent call", async () => {
  const database = await migratedDatabase();
  const client: SqlClient = createSqliteSqlClient(database);
  // 20 committable rows = 10 chunks of 2. The cap (8 iterations) lets the
  // first accept call finish exactly 8 chunks (16 rows), leaving 4 rows
  // ('committing', not 'committed') for a second call to pick up.
  const batchId = await syncBatch(client, 20);

  const first = await acceptImportWithContext(
    { client, userId: "user-a", requestId: "accept-req-1" },
    batchId,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(
    first.commit.status,
    "committing",
    "a batch needing more than 8 chunks must NOT silently finish inside the cap (that would mean the cap isn't actually being enforced)",
  );
  assert.equal(first.commit.committedRows, 16);
  assert.equal(first.commit.remainingRows, 4);

  const second = await acceptImportWithContext(
    { client, userId: "user-a", requestId: "accept-req-2" },
    batchId,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(
    second.commit.status,
    "committed",
    "the SAME idempotent accept call, invoked again, must resume from where the cap left off and finish the batch -- this is what closes the manual-pumping defect for a batch this large",
  );
  assert.equal(second.commit.committedRows, 20);
  assert.equal(second.commit.remainingRows, 0);
});

test("UI-013 review round B3: ACCEPT_COMMIT_LOOP_MAX_ITERATIONS is documented as a named, measured constant (8), not a magic number", async () => {
  const service = await readFile(
    new URL("../app/import-accept-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /const ACCEPT_COMMIT_LOOP_MAX_ITERATIONS = 8;/);
  assert.match(service, /iteration < ACCEPT_COMMIT_LOOP_MAX_ITERATIONS/);
});

test("UI-013 review round B4: ARCHITECTURE.md documents the accept path's bounded server loop as a dated amendment, and keeps the manual commit route's one-chunk-per-invocation invariant explicitly unchanged", async () => {
  const architecture = await readFile(
    new URL("../docs/ARCHITECTURE.md", import.meta.url),
    "utf8",
  );
  assert.match(
    architecture,
    /manual commit route \(`POST \/api\/import\/commit\/:batchId`\) keeps this invariant exactly: one chunk, one invocation\./,
  );
  assert.match(
    architecture,
    /`UI-013` review round, BLOCKING B3 correction — dated amendment to the "processes one chunk per invocation" statement above/,
  );
  assert.match(architecture, /ACCEPT_COMMIT_LOOP_MAX_ITERATIONS/);
});
