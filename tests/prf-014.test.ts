/**
 * PRF-014 step 1 -- `app/components/portfolio-shell.tsx` (5,000+ lines,
 * "use client", the root of every authenticated page) used to statically
 * import RUNTIME values (`historyBars`, `overviewRows`,
 * `portfolioPrototypes`) from `../prototype-data` -- 447 lines of
 * preview/demo fixture data -- so every production client bundle shipped
 * it, even though none of it is reachable outside the
 * `/portfolio/preview/*` fixture routes: every real caller
 * (`app/page.tsx`, `app/portfolio/[portfolioId]/[section]/page.tsx`, and
 * its `[holdingId]` sibling) always passes either `ownedWorkspace` or
 * `portfolioPrototypesOverride`, never neither.
 *
 * Fix: the shell now imports only TYPES from `../prototype-data` (erased
 * at build time, so the module's runtime values -- and Rollup can no
 * longer see a live reference forcing it into the client chunk) and the
 * preview route (`app/portfolio/[portfolioId]/[section]/page.tsx`, a
 * Server Component) imports `historyBars` itself and threads it down as
 * a `historyBarsOverride` prop; `portfolioPrototypes`/`overviewRows`'s
 * fallback uses were unreachable dead code (see the fallback removed at
 * `portfolioPrototypesOverride ?? portfolioPrototypes`) and are replaced
 * with an empty-array fallback / a derivation from `portfolios` instead.
 *
 * This is a SOURCE pin (matches `tests/bug-001.test.ts`'s own documented
 * reasoning for why a `dist/client` bundle-grep is not a reliable guard --
 * Rollup's tree-shaking behaviour for a reachable-but-dead runtime
 * reference is not a stable contract to pin a test against): it parses the
 * shell's own `import ... from "../prototype-data"` statement(s) and fails
 * if any specifier is not `type`-only. A regression that reintroduces a
 * runtime import (even just one symbol) fails this test immediately,
 * before a build/bundle-inspection step would be needed to notice.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SHELL_PATH = fileURLToPath(
  new URL("../app/components/portfolio-shell.tsx", import.meta.url),
);
const PREVIEW_SECTION_PAGE_PATH = fileURLToPath(
  new URL("../app/portfolio/[portfolioId]/[section]/page.tsx", import.meta.url),
);

/**
 * Extracts every `import ... from "<specifier>"` statement's specifier
 * blob (the part between `import` and `from`) whose module specifier is
 * `../prototype-data`. Bounded at the nearest `;` so a match never walks
 * into a following, unrelated statement (see `tests/bug-001.test.ts`'s
 * `fromPattern` for the same reasoning applied more generally).
 */
function prototypeDataImportSpecifierBlobs(source: string): string[] {
  const pattern =
    /(?:^|\n)\s*import\s+([^;]*?)\s*from\s+["']\.\.\/prototype-data(?:\.ts)?["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

/**
 * True if every binding in a `{ ... }` named-import list is explicitly
 * marked `type` (or the whole specifier is `type { ... }`). Mirrors this
 * codebase's convention of marking individual type-only specifiers rather
 * than relying on bundler-side usage inference (see `tests/bug-001.test.ts`'s
 * `isValueSpecifierList`, which this narrows to the one import this test
 * cares about).
 */
function isTypeOnlySpecifierBlob(blob: string): boolean {
  const trimmed = blob.trim();
  if (trimmed.startsWith("type ") || trimmed.startsWith("type{")) {
    return true; // whole-statement `import type {...}`
  }
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1) {
    return false; // default/namespace import -- always value-carrying
  }
  const prefix = trimmed.slice(0, braceStart).trim();
  if (prefix.length > 0) return false; // default import alongside named imports
  const entries = trimmed
    .slice(braceStart + 1, braceEnd)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.every((entry) => entry.startsWith("type "));
}

test("portfolio-shell.tsx imports only types from ../prototype-data (no fixture runtime value ships in the client bundle)", async () => {
  const source = await readFile(SHELL_PATH, "utf8");
  const blobs = prototypeDataImportSpecifierBlobs(source);
  assert.ok(
    blobs.length > 0,
    "expected at least one import from ../prototype-data in portfolio-shell.tsx -- if this file no longer imports it at all, update/remove this test",
  );
  for (const blob of blobs) {
    assert.ok(
      isTypeOnlySpecifierBlob(blob),
      `expected a type-only import from ../prototype-data, got specifier list: ${blob}`,
    );
  }
});

test("portfolio-shell.tsx no longer imports the raw portfolioPrototypes/overviewRows fixtures as a fallback", async () => {
  const source = await readFile(SHELL_PATH, "utf8");
  // The two dead-fallback call sites this task removed
  // (`portfolioPrototypesOverride ?? portfolioPrototypes` and the
  // `portfolioPrototypesOverride ? ... : overviewRows` ternary) are the
  // only places a bare (non-`Override`) reference to these names could
  // reappear as a runtime value; assert neither pattern is back.
  assert.doesNotMatch(
    source,
    /\?\?\s*portfolioPrototypes\b/,
    "expected no `?? portfolioPrototypes` fallback (reintroduces the fixture as a runtime import)",
  );
  assert.doesNotMatch(
    source,
    /:\s*overviewRows\b/,
    "expected no `: overviewRows` fallback (reintroduces the fixture as a runtime import)",
  );
});

test("the preview section route still supplies real history-chart bars to the shell (render stays identical)", async () => {
  const source = await readFile(PREVIEW_SECTION_PAGE_PATH, "utf8");
  assert.match(
    source,
    /import\s*\{\s*historyBars\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/prototype-data["']/,
    "expected the preview section page (a Server Component) to import the real historyBars fixture value",
  );
  assert.match(
    source,
    /historyBarsOverride=\{historyBars\}/,
    "expected the preview section page to thread historyBars into <PortfolioShell historyBarsOverride={historyBars} .../>",
  );
});
