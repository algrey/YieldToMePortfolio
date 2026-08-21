/** UI-019 — "Open in review" (Sharesight sync) lands in the wrong place.
 *
 * Owner-reported: on the import screen, after a Sharesight sync, the
 * result's "Open in review" affordance loaded the batch via
 * `loadReviewByBatchId` (`app/components/import-review.tsx`) but the
 * review rendered under `<HistoricalDataPanel />`, further down the page
 * than where the owner clicked -- "further down the page, under the
 * Import Historical Data section" in the owner's own words. There is only
 * ONE review section (BRK-005B's own header note on `loadReviewByBatchId`:
 * never a separate CSV vs. sync render target), so the fix reuses UI-012's
 * existing scroll-into-view + focus machinery (previously armed only by
 * `resumeReviewFromHistory`) from the Sharesight panel's `onOpenBatch` too.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const IMPORT_REVIEW_PATH = "../app/components/import-review.tsx";

test("UI-019: SharesightSyncPanel's onOpenBatch arms the SAME scroll-into-view request resumeReviewFromHistory arms, then reuses loadReviewByBatchId", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  const match = source.match(
    /onOpenBatch=\{\(batchId\) => \{([\s\S]*?)\n {10}\}\}/,
  );
  assert.ok(
    match,
    "expected an onOpenBatch handler body on SharesightSyncPanel",
  );
  assert.match(
    match![1]!,
    /pendingReviewScrollBatchIdRef\.current = batchId;/,
    "must arm the scroll ref with the requested batch id, exactly like resumeReviewFromHistory",
  );
  assert.match(match![1]!, /void loadReviewByBatchId\(batchId\);/);
});

test("UI-019: the review section is a SINGLE section (no separate CSV vs. Sharesight-sync render target) -- exactly one import-review-result section, and it is the one onOpenBatch/resumeReviewFromHistory both scroll to", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  const sectionMatches = [
    ...source.matchAll(/className="import-review-result"/g),
  ];
  assert.equal(sectionMatches.length, 1);
  assert.match(
    source,
    /className="import-review-result"\s*\n\s*aria-labelledby="review-title"\s*\n\s*ref=\{reviewSectionRef\}/,
  );
});

test("UI-019: the same scroll-into-view effect also moves focus to the review heading (preventScroll, so it doesn't fight the manual scroll), for keyboard/screen-reader parity with the visual scroll", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  const effectMatch = source.match(
    /if \(review && pendingReviewScrollBatchIdRef\.current === review\.batch\.id\) \{([\s\S]*?)\n {2}\}, \[review\]\);/,
  );
  assert.ok(effectMatch, "expected the scroll/focus effect");
  assert.match(
    effectMatch![1]!,
    /reviewSectionRef\.current\?\.scrollIntoView\(\{ block: "start" \}\);/,
  );
  assert.match(
    effectMatch![1]!,
    /reviewHeadingRef\.current\?\.focus\(\{ preventScroll: true \}\);/,
  );
});

test("UI-019: the review heading is a real focus target -- tabIndex={-1} so it is programmatically focusable without joining the normal Tab order, wired to reviewHeadingRef", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<h2 id="review-title" ref=\{reviewHeadingRef\} tabIndex=\{-1\}>/,
  );
  assert.match(
    source,
    /const reviewHeadingRef = useRef<HTMLHeadingElement \| null>\(null\);/,
  );
});

test("UI-019: resumeReviewFromHistory (the import-history 'Open review' path) is unchanged -- still arms the ref itself and still reuses loadReviewByBatchId, so both entry points converge on the same fixed behaviour", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  const match = source.match(
    /function resumeReviewFromHistory\(batchId: string\) \{([\s\S]*?)\n {2}\}/,
  );
  assert.ok(match, "expected resumeReviewFromHistory to still exist unchanged");
  assert.match(match![1]!, /pendingReviewScrollBatchIdRef\.current = batchId/);
  assert.match(match![1]!, /loadReviewByBatchId\(batchId\)/);
});
