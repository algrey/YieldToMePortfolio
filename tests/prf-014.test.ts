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
 *
 * Step-1 correction round adds two more layers, closing the acceptance
 * gap the source pin above deliberately leaves open (it only covers the
 * ONE file this task actually touched):
 *
 * 1. A generalised SOURCE guard (below): duplicates `tests/bug-001.test.ts`'s
 *    "use client" walker (its own module is not imported, so this file
 *    never re-registers BUG-001's tests as a side effect) and asserts that
 *    no "use client" module anywhere under `app/` -- not just
 *    `portfolio-shell.tsx` -- reaches `app/prototype-data.ts` via a
 *    value-carrying (runtime) import, directly or transitively.
 * 2. A BUILD-OUTPUT pin (below, in the shape of
 *    `tests/security-headers.test.ts`'s `dist/client` scan, which already
 *    runs under `npm test` since that script builds first): asserts that
 *    none of the fixture-only strings this task's own `docs/ARCHITECTURE.md`
 *    §9.12 measurement relies on appear in any production client asset.
 *    This does not contradict the SOURCE-pin reasoning above (a bundle-grep
 *    cannot prove ABSENCE of a reachable-but-dead reference in general,
 *    since tree-shaking is not a stable contract) -- it is a secondary,
 *    outcome-level check on top of the source guards, not a replacement
 *    for either.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = path.join(REPO_ROOT, "app");
const CLIENT_DIST_DIR = path.join(REPO_ROOT, "dist", "client");
const CODE_EXTENSIONS = [".ts", ".tsx"];

const SHELL_PATH = fileURLToPath(
  new URL("../app/components/portfolio-shell.tsx", import.meta.url),
);
const PREVIEW_SECTION_PAGE_PATH = fileURLToPath(
  new URL("../app/portfolio/[portfolioId]/[section]/page.tsx", import.meta.url),
);
const PROTOTYPE_DATA_PATH = fileURLToPath(
  new URL("../app/prototype-data.ts", import.meta.url),
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

// ---------------------------------------------------------------------------
// Generalised source guard: no "use client" module anywhere under app/ --
// not just portfolio-shell.tsx -- may reach app/prototype-data.ts via a
// value-carrying import. Deliberately duplicates (rather than imports)
// tests/bug-001.test.ts's own "use client" walker helpers: importing that
// module here would re-execute its top-level `test(...)` registrations as
// a side effect of this file's own import graph.
// ---------------------------------------------------------------------------

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(full)));
    } else if (CODE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function isClientEntryModule(source: string): boolean {
  const firstLine = source.split("\n", 1)[0]?.trim();
  return firstLine === '"use client";' || firstLine === "'use client';";
}

type ImportEdge = { specifier: string; isValue: boolean };

function isValueSpecifierList(specifiers: string): boolean {
  const trimmed = specifiers.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) return trimmed.length > 0;
  const prefix = trimmed.slice(0, braceIndex).replace(/,\s*$/, "").trim();
  if (prefix.length > 0) return true;
  const braceEnd = trimmed.lastIndexOf("}");
  const inner = trimmed.slice(
    braceIndex + 1,
    braceEnd === -1 ? undefined : braceEnd,
  );
  const entries = inner
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;
  return entries.some((entry) => !entry.startsWith("type "));
}

function parseImportEdges(source: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const sideEffectPattern = /^\s*import\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(sideEffectPattern)) {
    edges.push({ specifier: match[1], isValue: true });
  }
  const fromPattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(fromPattern)) {
    const wholeStatementTypeOnly = Boolean(match[2]);
    const specifiers = match[3];
    const specifier = match[4];
    const isValue = !wholeStatementTypeOnly && isValueSpecifierList(specifiers);
    edges.push({ specifier, isValue });
  }
  return edges;
}

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function collectPrototypeDataViolations(
  entryFile: string,
): Promise<string[]> {
  const violations: string[] = [];
  const visited = new Set<string>();

  async function walk(
    filePath: string,
    chain: readonly string[],
  ): Promise<void> {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    const nextChain = [...chain, path.relative(REPO_ROOT, filePath)];

    const source = await readFile(filePath, "utf8");
    for (const edge of parseImportEdges(source)) {
      if (!edge.isValue) continue;
      const resolved = resolveRelativeImport(filePath, edge.specifier);
      if (resolved === PROTOTYPE_DATA_PATH) {
        violations.push(
          `${path.relative(REPO_ROOT, entryFile)} reaches prototype-data.ts via ${[...nextChain, edge.specifier].join(" -> ")}`,
        );
        continue;
      }
      if (resolved) await walk(resolved, nextChain);
    }
  }

  await walk(entryFile, []);
  return violations;
}

test('PRF-014 generalised guard: no "use client" module under app/ value-imports prototype-data.ts (directly or transitively)', async () => {
  const files = await listSourceFiles(APP_DIR);
  const clientEntries: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (isClientEntryModule(source)) clientEntries.push(file);
  }
  // Fails closed, matching tests/bug-001.test.ts's own precedent: an empty
  // entry set would make this guard vacuously pass.
  assert.ok(
    clientEntries.length >= 10,
    `expected at least 10 "use client" modules under app/, found ${clientEntries.length}`,
  );

  const allViolations: string[] = [];
  for (const entry of clientEntries) {
    allViolations.push(...(await collectPrototypeDataViolations(entry)));
  }

  assert.deepEqual(
    allViolations,
    [],
    `"use client" module(s) reach prototype-data.ts at runtime (ships the fixture to the production client bundle):\n${allViolations.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// Build-output pin: the source guards above prove the fixture is not
// REACHABLE from a client module; this proves it is not actually PRESENT
// in the production client assets either, for the specific fixture-only
// strings docs/ARCHITECTURE.md §9.12 measures. In the shape of
// tests/security-headers.test.ts's "client output contains no Cloudflare
// Access configuration" test, which already scans dist/client/ under
// `npm test` (that script builds first).
// ---------------------------------------------------------------------------

async function listDistClientFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    files.push(
      ...(entry.isDirectory() ? await listDistClientFiles(full) : [full]),
    );
  }
  return files;
}

// Distinctive fixture-only strings from app/prototype-data.ts (each also
// appears nowhere else in the codebase -- see docs/ARCHITECTURE.md §9.12's
// measurement, which relies on the first of these).
const PROTOTYPE_DATA_FIXTURE_STRINGS = [
  "1,266,663.50",
  "Aus Super",
  "A$428,912.40",
];

test("PRF-014 build-output guard: no production client asset contains a prototype-data fixture string", async () => {
  const files = await listDistClientFiles(CLIENT_DIST_DIR);
  assert.ok(
    files.length > 0,
    `expected at least one file under ${CLIENT_DIST_DIR} -- run \`npm run build\` first`,
  );
  const contents = await Promise.all(
    files.map((file) => readFile(file, "utf8")),
  );
  const joined = contents.join("\n");

  for (const fixtureString of PROTOTYPE_DATA_FIXTURE_STRINGS) {
    assert.ok(
      !joined.includes(fixtureString),
      `expected no dist/client asset to contain the prototype-data fixture string ${JSON.stringify(fixtureString)}`,
    );
  }
});
