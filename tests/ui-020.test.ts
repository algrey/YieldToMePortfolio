/** UI-020 — Committed batch still says "Ready to review".
 *
 * Owner-reported: after committing ("accepting") a Sharesight batch, the
 * commit button disappears but the header still reads "Ready to review"
 * and the bottom of the section gave no confirmation.
 *
 * Root cause 1 (header): the status pill in `app/components/import-
 * review.tsx`'s "Server-issued preview" heading only ever compared
 * `review.preview.ready` -- it never checked `isCommittedOrReversed` at
 * all, so a committed/reversed batch stayed stuck on "Ready to
 * review"/"Needs resolution" forever. `review`/`commit` state itself was
 * NOT stale (`submitAccept` -> `refreshPreview()` already updates
 * `review.batch.status`, and `reviewCommit` is already scoped to this
 * batch) -- this was purely a missing label case.
 *
 * Root cause 2 (bottom): the "Review securities" section's own bottom
 * "Accept Import" button (`.import-accept-actions`, second occurrence,
 * right after the securities table) correctly disappeared once committed
 * (`!isCommittedOrReversed` gate) but nothing replaced it -- the only
 * confirmation text (`deriveCommittedStatusLine`'s `committedStatusLine`)
 * renders much further up, right under the filename/counts, easy to miss
 * once you're looking at the bottom of a long securities table.
 *
 * Fix: the header pill now reflects `isCommittedOrReversed`
 * ("Committed"/"Reversed"), and the bottom of the securities section shows
 * `committedConfirmationText` (`app/import-review-commit-state.ts`) in
 * place of the removed button -- a real, business-relevant date when this
 * batch's own `history` list entry has one, honestly omitted (never
 * fabricated) otherwise.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { committedConfirmationText } from "../app/import-review-commit-state.ts";

const IMPORT_REVIEW_PATH = "../app/components/import-review.tsx";

// ---------------------------------------------------------------------------
// Part 1: committedConfirmationText -- real-input/real-output tests for the
// formula itself (mirrors deriveCommittedStatusLine's own tests in
// tests/ui-013.test.ts), independent of React state/rendering.
// ---------------------------------------------------------------------------

test("UI-020: committedConfirmationText reports a committed batch with its real committedAt date, truncated to the business date", () => {
  const text = committedConfirmationText("committed", {
    committedAt: "2026-08-10T03:21:00.000Z",
    reversedAt: null,
  });
  assert.equal(text, "This batch was committed on 2026-08-10.");
});

test("UI-020: committedConfirmationText honestly omits the date when the history entry has not loaded yet, never fabricating one", () => {
  const text = committedConfirmationText("committed", null);
  assert.equal(text, "This batch was committed.");
});

test("UI-020: committedConfirmationText distinguishes a reversed batch, using reversedAt (not committedAt)", () => {
  const text = committedConfirmationText("reversed", {
    committedAt: "2026-08-10T03:21:00.000Z",
    reversedAt: "2026-08-12T09:00:00.000Z",
  });
  assert.equal(text, "This batch was reversed on 2026-08-12.");
});

test("UI-020: committedConfirmationText for a reversed batch with no known reversedAt yet omits the date, even if committedAt is known", () => {
  const text = committedConfirmationText("reversed", {
    committedAt: "2026-08-10T03:21:00.000Z",
    reversedAt: null,
  });
  assert.equal(text, "This batch was reversed.");
});

// ---------------------------------------------------------------------------
// Part 2: wiring -- the header pill and the bottom-of-section text actually
// use these values instead of the stale "Ready to review" label / nothing.
// ---------------------------------------------------------------------------

test("UI-020: the header status pill reflects isCommittedOrReversed ('Committed'/'Reversed'), not just review.preview.ready, so a committed/reversed batch never reads 'Ready to review' again", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  const headingMatch = source.match(
    /<h2 id="review-title"[\s\S]*?<\/span>\s*\n\s*<\/div>/,
  );
  assert.ok(headingMatch, "expected the section-heading block");
  const block = headingMatch![0]!;
  assert.match(block, /isCommittedOrReversed/);
  assert.match(block, /"Committed"/);
  assert.match(block, /"Reversed"/);
  assert.match(block, /"Ready to review"/);
  assert.match(block, /"Needs resolution"/);
  // Reversed is decided from the PERSISTED batch status only -- a live
  // same-session commit result can only ever report "committed", never
  // "reversed" (mirrors deriveCommittedStatusLine's identical distinction).
  assert.match(block, /review\.batch\.status === "reversed"/);
});

test("UI-020: the bottom of the 'Review securities' section (where the second Accept Import button sat) shows committedConfirmationText once committed/reversed, replacing the removed button rather than leaving it blank", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  // The FIRST import-accept-actions block (above the table) still just
  // hides on commit -- only the SECOND (below the table, the "bottom" the
  // owner meant) gains the replacement confirmation text.
  const accentBlocks = [
    ...source.matchAll(
      /\{!isCommittedOrReversed \? \(\s*\n\s*<div className="import-accept-actions">[\s\S]*?\n {14}\)( : null| : \()/g,
    ),
  ];
  assert.ok(
    accentBlocks.length >= 2,
    "expected two import-accept-actions gates (top and bottom of the securities table)",
  );
  assert.equal(accentBlocks[0]![1], " : null");
  assert.equal(accentBlocks[1]![1], " : (");
  assert.match(
    source,
    /committedConfirmationText\(\s*\n\s*review\.batch\.status,\s*\n\s*reviewHistoryEntry,\s*\n\s*\)/,
  );
});

test("UI-020: reviewHistoryEntry is matched by batch id from the `history` list (never the last-viewed historyDetail, which can point at a different batch)", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const reviewHistoryEntry = review\s*\n\s*\? \(history\.find\(\(batch\) => batch\.id === review\.batch\.id\) \?\? null\)\s*\n\s*: null;/,
  );
});

test("UI-020: committedConfirmationText is imported into import-review.tsx from the shared, directly-testable commit-state module (not re-implemented inline)", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /import \{[\s\S]*?committedConfirmationText[\s\S]*?\} from "\.\.\/import-review-commit-state\.ts";/,
  );
});
