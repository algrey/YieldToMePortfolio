/**
 * BUG-001 (owner-reported crash): the Capital gains sub-tab threw
 * `Module "node:crypto" has been externalized for browser compatibility.
 * Cannot access "node:crypto.randomUUID" in client code` the moment it
 * rendered in the browser. CGT-004 had added a VALUE import of
 * `buildCapitalGainsDisplayRows` from `app/owned-capital-gains.ts` into the
 * "use client" `app/components/capital-gains-screen.tsx` -- that module
 * transitively imports `db/repositories/owned-portfolios.ts`, which calls
 * `randomUUID()` from `node:crypto` at module scope-reachable code. Node
 * built-ins have no browser build, so Vite externalizes them for the
 * client bundle; the browser throws the instant the externalized binding
 * is actually referenced.
 *
 * `npm run build`'s production Rollup bundle did NOT reproduce this (tree-
 * shaking discards the unreachable `db/repositories` code from that single
 * chunk), so a bundle-grep against `dist/client` is not a reliable guard --
 * `npm run dev`'s Vite dev server serves native ESM per-module without
 * cross-module tree-shaking, so importing anything at all from a module
 * still loads that module's ENTIRE import graph in the browser, which is
 * how the owner actually hit this. This test instead statically walks each
 * "use client" module's runtime (non-type-only) import graph and fails if
 * it reaches a server-only directory (`db/`, `worker/`) or a Node/
 * Cloudflare built-in specifier -- generic across every "use client" module
 * in `app/`, not just this one file, so the next such leak fails `npm test`
 * instead of an owner's browser. Precedent: IMP-010A's
 * `SERVER_ONLY_IMPORT_PATTERN` source-scan (`tests/imp-010a.test.ts`) and
 * the MKT-018B/UI-018 splits (`app/price-history-coverage-format.ts` vs
 * `app/price-history-coverage.ts`; `app/price-history-chart-geometry.ts` vs
 * `app/owned-price-history.ts`) that this task's fix
 * (`app/capital-gains-display-format.ts` vs `app/owned-capital-gains.ts`)
 * follows exactly.
 *
 * KNOWN LIMITATION (documented, not fixed here -- reviewer-acknowledged
 * scope call): this walks only STATIC `import ... from "..."`/
 * `export ... from "..."` edges, never expression-position dynamic
 * `import("...")` calls -- several server-only `app/*-actions.ts` modules
 * (e.g. `app/portfolio-actions.ts`, `app/dividend-assumptions-actions.ts`)
 * deliberately lazy-load `db/d1-sql-client`/`cloudflare:workers` this way
 * as a code-splitting boundary, exactly the MKT-018B precedent's own
 * comment describes. That pattern is normally the SAFE direction (it keeps
 * server-only code out of a client module's synchronous graph), but it
 * also means this guard cannot see through a `import("...")` call: if a
 * "use client" module ever called `import(...)` directly on a server-only
 * path, this test would NOT catch it. The "generic" claim above is scoped
 * to the static-import leak class BUG-001 actually was; a dynamic-import
 * leak needs a different guard (or a real build/runtime probe) if it ever
 * becomes a real pattern in `app/components/`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = path.join(REPO_ROOT, "app");
const CODE_EXTENSIONS = [".ts", ".tsx"];

// Root-level directories that are server/Node/Cloudflare-only per AGENTS.md's
// repository structure (`db/` -- Drizzle schema/repositories; `worker/` --
// Cloudflare Worker entry/bindings) and must never be reachable from a
// "use client" module's RUNTIME import graph.
const FORBIDDEN_ROOT_DIRS = new Set(["db", "worker"]);
// Node/Cloudflare built-in specifiers with no browser build -- Vite
// externalizes these for a client bundle; the browser then throws the
// moment the externalized binding is actually referenced (BUG-001's exact
// crash, verbatim).
const FORBIDDEN_SPECIFIER_PATTERN = /^(?:node:|cloudflare:workers)/;

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

/**
 * ASSUMPTION (documented, matches this codebase's own convention -- e.g.
 * `app/components/capital-gains-screen.tsx`): a client entry module's
 * directive is the LITERAL first line, exactly `"use client";`, with
 * nothing before it. Only that literal first line counts -- a mere
 * MENTION of the string "use client" inside a later comment (several
 * server-only files in `app/` explain why they deliberately are NOT a
 * client module) must never count. `app/portfolio-sections.ts`,
 * `app/owned-capital-gains.ts`, `app/price-history-coverage.ts`,
 * `app/price-history-coverage-format.ts`, and this task's own
 * `app/capital-gains-display-format.ts` all contain the substring
 * "use client" in prose but are not themselves client entry modules --
 * a naive whole-file substring search over-detects them. If this
 * repository ever adopts a directive prefixed by a comment/pragma (not
 * this codebase's current convention), this detector would miss it.
 */
function isClientEntryModule(source: string): boolean {
  const firstLine = source.split("\n", 1)[0]?.trim();
  return firstLine === '"use client";' || firstLine === "'use client';";
}

type ImportEdge = { specifier: string; isValue: boolean };

/**
 * A specifier list is value-carrying (reaches the module at runtime) unless
 * EVERY binding it names is explicitly marked `type` -- mirrors this
 * codebase's own convention of marking individual type-only specifiers
 * (`type RefObject`, `type WatchlistRow`, ...) rather than relying on
 * bundler-side usage inference, so this heuristic matches what the bundler
 * actually keeps in practice.
 */
function isValueSpecifierList(specifiers: string): boolean {
  const trimmed = specifiers.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) {
    // No named-import braces at all: a bare default/namespace import
    // (`import Foo from ...`, `import * as Foo from ...`), or `export *
    // from ...`. Anything non-empty here is a value edge.
    return trimmed.length > 0;
  }
  const prefix = trimmed.slice(0, braceIndex).replace(/,\s*$/, "").trim();
  if (prefix.length > 0) return true; // default import alongside named imports
  const braceEnd = trimmed.lastIndexOf("}");
  const inner = trimmed.slice(
    braceIndex + 1,
    braceEnd === -1 ? undefined : braceEnd,
  );
  const entries = inner
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false; // `import {} from "..."` -- no bindings at all
  return entries.some((entry) => !entry.startsWith("type "));
}

/**
 * Parses `import "spec";`, `import ... from "spec";`, and
 * `export ... from "spec";` statements (both directions carry a module
 * into the bundle) and classifies each as type-only (erased at build time,
 * never followed) or value-carrying (reaches the module at runtime, always
 * followed). Deliberately regex-based, matching the existing
 * `tests/imp-010a.test.ts`/`tests/ui-003.test.ts` source-scan precedent
 * rather than a full TS parse -- this codebase's consistent Prettier
 * formatting and explicit per-specifier `type` keywords make that reliable
 * (see the two fixture-based unit tests below, which pin exactly the
 * before/after shape of this task's own fix).
 */
export function parseImportEdges(source: string): ImportEdge[] {
  const edges: ImportEdge[] = [];

  const sideEffectPattern = /^\s*import\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(sideEffectPattern)) {
    edges.push({ specifier: match[1], isValue: true });
  }

  // The specifier-blob group is bounded to `[^;]` (not `[\s\S]`, which
  // freely crosses statement terminators): a lazy `[\s\S]*?` search for the
  // next "from" keyword can walk straight through an EARLIER, unrelated
  // statement -- e.g. a preceding `export type X = { a: string };` (a type
  // ALIAS, not an export-from -- no "from" clause of its own) has no
  // semicolon-bounded "from" ahead of it, so the lazy match kept consuming
  // characters past its own terminating `;` and into the NEXT statement,
  // latching onto THAT statement's "from" clause instead -- silently
  // swallowing a real value `export {...} from "..."` re-export as if it
  // were part of the type alias's (nonexistent) specifier list, and
  // misclassifying it as type-only. That is a false NEGATIVE (a real
  // client-reachable edge goes unfollowed) -- exactly the compatibility
  // re-export this task's own fix adds in `app/owned-capital-gains.ts`
  // (`export { buildCapitalGainsDisplayRows, ... } from
  // "./capital-gains-display-format.ts";`), sitting after several
  // `export type ... = {...}` type-alias declarations in that file. `;`
  // is guaranteed to close every import/export-from statement under this
  // codebase's Prettier formatting, so bounding the blob at the nearest
  // semicolon keeps each match inside its own statement.
  const fromPattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(fromPattern)) {
    const wholeStatementTypeOnly = Boolean(match[2]);
    const specifiers = match[3];
    const specifier = match[4];
    // `import type {...} from "..."` (whole-statement) is erased at build
    // time regardless of what it names -- never a value edge.
    const isValue = !wholeStatementTypeOnly && isValueSpecifierList(specifiers);
    edges.push({ specifier, isValue });
  }

  return edges;
}

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null; // bare package specifier -- not part of this repo's source graph
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

type Violation = { entry: string; chain: string[]; reason: string };

async function collectClientReachableViolations(
  entryFile: string,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const visited = new Set<string>();

  async function walk(
    filePath: string,
    chain: readonly string[],
  ): Promise<void> {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    const relPath = path.relative(REPO_ROOT, filePath);
    const nextChain = [...chain, relPath];

    const rootDir = relPath.split(path.sep)[0];
    // The entry file itself is never under a forbidden root (it lives in
    // app/); only a module it (transitively) reaches can trip this.
    if (chain.length > 0 && FORBIDDEN_ROOT_DIRS.has(rootDir)) {
      violations.push({
        entry: entryFile,
        chain: nextChain,
        reason: `reaches server-only directory "${rootDir}/"`,
      });
      return; // no need to walk further into a known-forbidden module
    }

    const source = await readFile(filePath, "utf8");
    for (const edge of parseImportEdges(source)) {
      if (!edge.isValue) continue;
      if (FORBIDDEN_SPECIFIER_PATTERN.test(edge.specifier)) {
        violations.push({
          entry: entryFile,
          chain: [...nextChain, edge.specifier],
          reason: `imports forbidden built-in "${edge.specifier}"`,
        });
        continue;
      }
      const resolved = resolveRelativeImport(filePath, edge.specifier);
      if (resolved) await walk(resolved, nextChain);
      // Bare npm package specifiers (react, next/*, ...) are not followed --
      // dependencies are expected to ship their own browser-safe builds.
    }
  }

  await walk(entryFile, []);
  return violations;
}

function describeViolation(v: Violation): string {
  return `  ${path.relative(REPO_ROOT, v.entry)}: ${v.reason}\n    via ${v.chain.join(" -> ")}`;
}

// ---------------------------------------------------------------------------
// Detector unit tests: pin the exact before/after import shape of this
// task's own fix, independent of the live repo tree, so the detector's
// type-only-vs-value classification itself stays covered even if
// `app/owned-capital-gains.ts` changes shape again later.
// ---------------------------------------------------------------------------

test("BUG-001 detector: a mixed value+type named import is a value edge (the original broken shape)", () => {
  const source = `
import {
  buildCapitalGainsDisplayRows,
  type OwnedCapitalGainsHistory,
} from "../owned-capital-gains.ts";
`;
  const edges = parseImportEdges(source);
  assert.deepEqual(edges, [
    { specifier: "../owned-capital-gains.ts", isValue: true },
  ]);
});

test("BUG-001 detector: a fully type-only named import is never a value edge (this task's fix shape)", () => {
  const source = `
import type { OwnedCapitalGainsHistory } from "../owned-capital-gains.ts";
import { buildCapitalGainsDisplayRows } from "../capital-gains-display-format.ts";
`;
  const edges = parseImportEdges(source);
  assert.deepEqual(edges, [
    { specifier: "../owned-capital-gains.ts", isValue: false },
    { specifier: "../capital-gains-display-format.ts", isValue: true },
  ]);
});

test("BUG-001 detector: per-specifier `type` keyword elides only that binding, not the whole statement", () => {
  const source = `import { type RefObject, useState } from "react";`;
  assert.deepEqual(parseImportEdges(source), [
    { specifier: "react", isValue: true },
  ]);
  const allTyped = `import { type A, type B } from "./x.ts";`;
  assert.deepEqual(parseImportEdges(allTyped), [
    { specifier: "./x.ts", isValue: false },
  ]);
});

test("BUG-001 detector (reviewer B1/B2 fix): a preceding `export type X = ...` type-alias declaration does not swallow the next real export-from into a false type-only edge", () => {
  const source = `
export type SomeAlias = {
  a: string;
};
export {
  buildCapitalGainsDisplayRows,
  type CapitalGainsDisplayFyRow,
} from "./capital-gains-display-format.ts";
`;
  const edges = parseImportEdges(source);
  // The type alias itself has no "from" clause at all and must never be
  // mistaken for one; the real re-export right after it must still be
  // detected, and correctly classified as value-carrying (a bare `type`
  // declaration ahead of it must never launder a genuine value edge into
  // an unfollowed one -- the exact class of bug this fix guards against).
  assert.deepEqual(edges, [
    { specifier: "./capital-gains-display-format.ts", isValue: true },
  ]);
});

test("BUG-001 detector (reviewer B1/B2 fix): a genuine `export type {...} from` re-export is still correctly type-only, even right after an unrelated type alias", () => {
  const source = `
export type SomeAlias = {
  a: string;
};
export type { CapitalGainsDisplayFyRow } from "./capital-gains-display-format.ts";
`;
  const edges = parseImportEdges(source);
  assert.deepEqual(edges, [
    { specifier: "./capital-gains-display-format.ts", isValue: false },
  ]);
});

// ---------------------------------------------------------------------------
// The generic guard itself: every "use client" module anywhere under app/
// must have a client-bundle-safe runtime import graph -- not just
// capital-gains-screen.tsx.
// ---------------------------------------------------------------------------

test('BUG-001 guard: every "use client" module\'s runtime import graph is DB/Node/Cloudflare-free', async () => {
  const files = await listSourceFiles(APP_DIR);
  const clientEntries: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (isClientEntryModule(source)) clientEntries.push(file);
  }
  // Fails closed: if this ever finds zero "use client" modules, the
  // detection logic itself regressed (there are, as of this task, 16) --
  // silently asserting an empty violation list against an empty entry set
  // would be a guard that can never fail.
  assert.ok(
    clientEntries.length >= 10,
    `expected at least 10 "use client" modules under app/, found ${clientEntries.length}`,
  );

  const allViolations: Violation[] = [];
  for (const entry of clientEntries) {
    allViolations.push(...(await collectClientReachableViolations(entry)));
  }

  assert.deepEqual(
    allViolations,
    [],
    `client-bundle-unsafe import(s) found (this is how the BUG-001 crash happened):\n${allViolations
      .map(describeViolation)
      .join("\n")}`,
  );
});

test("BUG-001 regression: capital-gains-screen.tsx no longer reaches db/repositories/owned-portfolios.ts", async () => {
  const entry = path.join(APP_DIR, "components/capital-gains-screen.tsx");
  const violations = await collectClientReachableViolations(entry);
  assert.deepEqual(violations, []);
});
