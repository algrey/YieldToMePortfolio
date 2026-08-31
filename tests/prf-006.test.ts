import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// PRF-006 (owner-directed final pass, verbatim: "Do one last pass and look
// for any more issues or optimisations across the whole site."). Two source
// pins for this task's dead/duplicate-work sweep:
//
// (1) `loadAuthenticatedWorkspace`'s `loadPublishedOverview` D1 read is gone
//     -- CALC-005 already retired the snapshot pipeline's every writer, so
//     `snapshot_publications` can never gain a row again in this codebase
//     (production confirmed 0 rows on 2026-08-31); the read always resolved
//     `null`, so `createOverviewData(null)` -- a pure, synchronous function
//     -- is computed directly instead, removing a permanently-wasted D1
//     round trip from EVERY root-page load with byte-identical output.
// (2) The portfolio-popover and navigation-drawer `href="/"` links now carry
//     `prefetch={false}`, closing PRF-004's own recorded follow-up (c):
//     these menus mount fresh, in-viewport, every time they open, so
//     vinext's auto-prefetch re-triggered a full root-page RSC fetch on
//     every open -- the same defect class PRF-004 already fixed for the
//     always-mounted topbar-brand link.

function excerptAfter(source: string, marker: string, length = 200): string {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `marker not found: ${marker}`);
  return source.slice(index, index + length);
}

// Precedent: tests/bug-003.test.ts, tests/hist-001.test.ts. Strips comments
// before JSX-tag scanning so a comment's own illustrative `<Link>` markup
// (this file has one, in UI-024's doc comment above the component) can
// never be mistaken for a real element and bridge the match across
// unrelated code.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("PRF-006: loadAuthenticatedWorkspace computes the Overview publication read as a pure createOverviewData(null) call, not a D1 read", async () => {
  const rawSource = await readFile(
    new URL("../app/authenticated-workspace.ts", import.meta.url),
    "utf8",
  );
  const source = stripComments(rawSource);
  assert.doesNotMatch(
    source,
    /\.loadPublishedOverview\(/,
    "loadPublishedOverview should no longer be called -- snapshot_publications can never gain a row (CALC-005); explanatory comments may still name it historically",
  );
  assert.doesNotMatch(
    source,
    /createHistoricalSnapshotRepository/,
    "the snapshot-repository import (and its only call site) should be removed from real code; explanatory comments may still name it historically",
  );
  assert.doesNotMatch(
    source,
    /createUnavailableOverviewData/,
    "the unreachable-on-throw fallback is removed along with the D1 read that could throw; explanatory comments may still name it historically",
  );
  const overviewBlock = excerptAfter(
    rawSource,
    "if (options.includeOverview) {",
    8000,
  );
  assert.match(overviewBlock, /const overview = createOverviewData\(null\);/);
  assert.match(
    overviewBlock,
    /const \[portfolioValueHistory, holdingsSummary\] =\s*\n?\s*await Promise\.all\(/,
  );
});

test('PRF-006: the portfolio-popover and navigation-drawer href="/" links opt out of auto-prefetch, mirroring the topbar-brand fix', async () => {
  const source = stripComments(
    await readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
  );
  // Every `href="/"` Link in the file (topbar-brand, popover, drawer x2)
  // must carry `prefetch={false}` -- each one mounts either unconditionally
  // in the always-visible header or fresh-in-viewport on menu/drawer open,
  // so vinext's auto-prefetch (skips only dynamic-path routes, never `/`)
  // would otherwise re-fetch the root page's full RSC render for free.
  // `[\s\S]*?(?<!=)>` rather than `[^>]*>`: several of these tags carry an
  // `onClick={() => ...}` arrow-function prop, whose own `=>` contains a
  // `>` that is NOT the tag's closing bracket -- the lookbehind excludes
  // only a `>` immediately preceded by `=`, so the real closing `>` (always
  // preceded by a quote, brace, or whitespace) still terminates the match.
  const hrefRootLinks = [
    ...source.matchAll(/<Link\b[\s\S]*?href="\/"[\s\S]*?(?<!=)>/g),
  ];
  assert.ok(
    hrefRootLinks.length >= 4,
    `expected at least 4 href="/" Links (topbar-brand, popover, drawer x2), found ${hrefRootLinks.length}`,
  );
  for (const [tag] of hrefRootLinks) {
    assert.match(
      tag,
      /prefetch=\{false\}/,
      `href="/" Link missing prefetch={false}: ${tag}`,
    );
  }
});
