/** UI-038 — Back control on the Import Review page (owner-reported orphan).
 * `/import` is opened from the top bar's "+" menu, which is available on
 * every primary tab, so the control reuses UI-037's `HistoryBackControl`
 * (history back for an unmodified primary click when the tab has history;
 * a real fallback href — the workspace overview `/` — for direct/no-JS/
 * new-tab arrivals). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("UI-038: the import review screen and the workspace-unavailable degraded state render HistoryBackControl with the workspace-overview fallback", async () => {
  const [review, page] = await Promise.all([
    readFile(
      new URL("../app/components/import-review.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/import/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(
    review,
    /<HistoryBackControl fallbackHref="\/" label="Back" \/>/,
  );
  // UI-049: the zero-portfolio degraded state was removed -- a fresh
  // installation with no portfolios now renders `ImportReview` itself
  // (whose own back control is asserted above), not a page-level dead end.
  // Only the workspace-unavailable branch's back control remains here.
  const pageControls =
    page.match(/<HistoryBackControl fallbackHref="\/" label="Back" \/>/g) ?? [];
  assert.equal(pageControls.length, 1);
});
