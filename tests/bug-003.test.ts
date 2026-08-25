/**
 * BUG-003 (owner browser-console evidence): the Overview chart table's
 * `<th scope="row">` hydration-mismatched -- server (workerd) rendered
 * "1 June 2026" while the browser rendered "1 Jun 2026" for the SAME
 * `toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" })` call
 * with the SAME pinned `timeZone: "UTC"`. `en-AU` abbreviated month names
 * are a known CLDR quirk: some ICU/CLDR data versions abbreviate June/July
 * as "June"/"July", others as "Jun"/"Jul" -- workerd and the browser can
 * each ship a different snapshot. Locale-DATA-dependent formatting can
 * NEVER be hydration-safe in a "use client" component, even with every
 * other option (locale, timeZone) fully pinned identically both sides. A
 * prior investigation (comparing Node vs. miniflare) missed this because
 * both LOCAL dev runtimes share one ICU build; only a real browser vs.
 * workerd comparison exposed it. The fix (`app/date-display.ts`) is a
 * fixed, in-code English month-abbreviation table with zero Intl/locale-
 * data dependency.
 *
 * This is a REGRESSION PIN, generic across every "use client"-reachable
 * module (not just the two known BUG-003 sites): it statically walks each
 * "use client" module's runtime (non-type-only) import graph -- reusing
 * `tests/bug-001.test.ts`'s own walker approach (kept as an independent
 * copy here rather than importing from that test file, so each regression
 * test's detector logic stays self-contained and neither can silently
 * break the other by changing shared internals) -- and fails if any
 * reachable module renders text via `toLocaleDateString`/`toLocaleTimeString`/
 * `toLocaleString` (on ANY receiver -- a `Date`'s own `toLocaleString()`
 * also produces a locale month name by default, and `Number`/`BigInt`'s
 * `toLocaleString()` is Intl/CLDR digit-grouping under the exact same
 * skew risk, so this project treats all three method NAMES as forbidden
 * regardless of receiver type, which a source-level scan cannot resolve
 * anyway) or an `Intl.DateTimeFormat` whose options include a TEXTUAL field
 * (`month: "short"/"long"/"narrow"`, `weekday`, `dayPeriod`) -- a NUMERIC-
 * only `Intl.DateTimeFormat` (e.g. `year: "numeric", month: "2-digit",
 * day: "2-digit"` used purely to extract calendar-date parts in an explicit
 * IANA timezone) is locale-data-STABLE and stays allowed, matching this
 * task's explicit ruling to leave `domain/calculations/financial-year.ts`
 * and `domain/market-data/daily-capture-window.ts`'s timezone-math alone.
 *
 * Allowlists nothing by DEFAULT (every finding fails the test) except the
 * one explicit, individually-documented exception below -- reviewed and
 * confirmed NOT to render locale-dependent text to a browser.
 * `domain/calculations/financial-year.ts` needs no such exception: its
 * Intl.DateTimeFormat calls are numeric-only already, so the detector finds
 * zero findings there without any allowlist entry.
 *
 * KNOWN LIMITATION (documented, same class as `tests/bug-001.test.ts`'s own
 * one): this walks only STATIC `import ... from "..."`/`export ... from
 * "..."` edges, never dynamic `import("...")`, and resolves only relative
 * specifiers within this repo (bare package imports are not followed --
 * `date-fns`/etc. are expected to ship their own hydration-safe output).
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

// ---------------------------------------------------------------------------
// Import-graph walker -- an independent copy of `tests/bug-001.test.ts`'s
// own walker (see that file's header comment for the regex-vs-type-check
// design rationale). Computes the FULL client-reachable file set here
// (bug-001 only needs VIOLATIONS; this test needs every reachable file, so
// it can be source-scanned for the BUG-003 pattern class).
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
  if (braceIndex === -1) {
    return trimmed.length > 0;
  }
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
    edges.push({ specifier: match[1]!, isValue: true });
  }
  const fromPattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(fromPattern)) {
    const wholeStatementTypeOnly = Boolean(match[2]);
    const specifiers = match[3]!;
    const specifier = match[4]!;
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

async function collectClientReachableFiles(): Promise<string[]> {
  const files = await listSourceFiles(APP_DIR);
  const clientEntries: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (isClientEntryModule(source)) clientEntries.push(file);
  }
  assert.ok(
    clientEntries.length >= 10,
    `expected at least 10 "use client" modules under app/, found ${clientEntries.length} -- the detection logic itself may have regressed`,
  );

  const reachable = new Set<string>();
  async function walk(filePath: string): Promise<void> {
    if (reachable.has(filePath)) return;
    reachable.add(filePath);
    const source = await readFile(filePath, "utf8");
    for (const edge of parseImportEdges(source)) {
      if (!edge.isValue) continue;
      const resolved = resolveRelativeImport(filePath, edge.specifier);
      if (resolved) await walk(resolved);
    }
  }
  for (const entry of clientEntries) await walk(entry);
  return [...reachable];
}

// ---------------------------------------------------------------------------
// BUG-003 pattern detector.
// ---------------------------------------------------------------------------

/** Strips comments before scanning -- several doc comments in this codebase
 * (including this task's own, and `date-display.ts`'s header) deliberately
 * DESCRIBE the forbidden method names in prose, which would otherwise
 * false-positive a raw-text scan. Matches `tests/hist-001.test.ts`'s own
 * `stripComments` precedent. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Given the index of the "(" that opens an `Intl.DateTimeFormat(...)` call,
 * returns the full parenthesized argument text (balanced-paren scan -- a
 * regex alone cannot match nested braces/parens inside an options object). */
function extractBalancedParens(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

const TEXTUAL_INTL_OPTION_PATTERN =
  /\bmonth\s*:\s*["'](?:short|long|narrow)["']|\bweekday\s*:|\bdayPeriod\s*:/;

type Finding = { pattern: string; excerpt: string };

/**
 * Scans one already-comment-stripped source string for the BUG-003 pattern
 * class. Returns every finding (not just the first), so a single violating
 * file reports all its offending sites at once.
 */
function findBug003Patterns(source: string): Finding[] {
  const findings: Finding[] = [];

  for (const methodName of [
    "toLocaleDateString",
    "toLocaleTimeString",
    "toLocaleString",
  ]) {
    const pattern = new RegExp(`\\.${methodName}\\s*\\(`, "g");
    for (const match of source.matchAll(pattern)) {
      const start = Math.max(0, match.index! - 20);
      findings.push({
        pattern: methodName,
        excerpt: source.slice(start, match.index! + 40).replace(/\s+/g, " "),
      });
    }
  }

  const intlCallPattern = /Intl\.DateTimeFormat\s*\(/g;
  for (const match of source.matchAll(intlCallPattern)) {
    const openIndex = match.index! + match[0].length - 1;
    const args = extractBalancedParens(source, openIndex);
    if (TEXTUAL_INTL_OPTION_PATTERN.test(args)) {
      findings.push({
        pattern: "Intl.DateTimeFormat (textual field)",
        excerpt: args.replace(/\s+/g, " ").slice(0, 120),
      });
    }
  }

  return findings;
}

/**
 * Files individually reviewed and confirmed NOT to render locale-dependent
 * text to a browser -- each entry documents WHY it is safe despite matching
 * the raw pattern scan. Empty by default (per this task's "allowlist
 * nothing initially" instruction); only this one exists today. (An earlier
 * draft also defensively listed `domain/calculations/financial-year.ts`,
 * which has zero actual findings -- removed on review: a blanket exemption
 * for a file the detector does not even flag blinds the guard against a
 * REAL future regression in that client-reachable file, for no benefit.)
 */
const FILE_EXCEPTIONS: ReadonlyArray<{
  relativePath: string;
  reason: string;
}> = [
  {
    relativePath: "domain/market-data/daily-capture-window.ts",
    reason:
      'resolveDailyCaptureWindowStatus\'s Intl.DateTimeFormat call includes weekday: "short", which DOES match the textual-field pattern. The exemption holds not because that field goes unused, but because of what its ONE client-reachable caller actually consumes: app/price-history-chart-geometry.ts (positionTodayPointsByObservedTime) reads only status.localMinutesOfDay -- numeric, locale-data-stable -- and never status.isWeekday, so the weekday text itself never reaches that call site at all. Separately, the call is pinned to locale "en-CA" (not the runtime default), so even the isWeekday gate elsewhere in this module (which DOES compare the weekday string against the fixed English Set(["Sat","Sun"])) is never exposed to a default-locale runtime\'s CLDR skew. This is the one documented exception to the \'allowlist nothing\' default.',
  },
];

test('BUG-003 guard: no "use client"-reachable module renders text via toLocaleDateString/toLocaleTimeString/toLocaleString, or an Intl.DateTimeFormat with a textual field, outside the one documented exception', async () => {
  const reachableFiles = await collectClientReachableFiles();
  assert.ok(
    reachableFiles.length >= 20,
    `expected a substantial client-reachable file set, found ${reachableFiles.length} -- the walker itself may have regressed`,
  );

  const exceptionPaths = new Set(
    FILE_EXCEPTIONS.map((exception) => exception.relativePath),
  );

  const violations: { file: string; findings: Finding[] }[] = [];
  for (const filePath of reachableFiles) {
    const relativePath = path.relative(REPO_ROOT, filePath);
    if (exceptionPaths.has(relativePath)) continue;
    const source = stripComments(await readFile(filePath, "utf8"));
    const findings = findBug003Patterns(source);
    if (findings.length > 0) violations.push({ file: relativePath, findings });
  }

  assert.deepEqual(
    violations,
    [],
    `locale-data-dependent date/number text formatting found (this is how the BUG-003 hydration mismatch happened -- convert to app/date-display.ts, or a fixed non-Intl formatter, or add a reviewed, documented FILE_EXCEPTIONS entry):\n${violations
      .map(
        (v) =>
          `  ${v.file}:\n${v.findings.map((f) => `    [${f.pattern}] ...${f.excerpt}...`).join("\n")}`,
      )
      .join("\n")}`,
  );
});

test("BUG-003 guard: every FILE_EXCEPTIONS entry still exists and is still reachable (an exception for a file that no longer exists/no longer matters is dead documentation, not a real exception)", async () => {
  const reachableFiles = await collectClientReachableFiles();
  const reachableRelative = new Set(
    reachableFiles.map((f) => path.relative(REPO_ROOT, f)),
  );
  for (const exception of FILE_EXCEPTIONS) {
    assert.ok(
      existsSync(path.join(REPO_ROOT, exception.relativePath)),
      `FILE_EXCEPTIONS entry "${exception.relativePath}" no longer exists -- remove the stale exception`,
    );
    assert.ok(
      reachableRelative.has(exception.relativePath),
      `FILE_EXCEPTIONS entry "${exception.relativePath}" is no longer "use client"-reachable -- remove the stale exception`,
    );
  }
});

// ---------------------------------------------------------------------------
// Detector unit tests: pin the exact shapes the scanner must catch/allow,
// independent of the live repo tree.
// ---------------------------------------------------------------------------

test("BUG-003 detector: Date#toLocaleDateString is always a finding", () => {
  const source = `new Date().toLocaleDateString("en-AU", { month: "short" });`;
  const findings = findBug003Patterns(source);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.pattern, "toLocaleDateString");
});

test("BUG-003 detector: bare Date#toLocaleString is a finding (default full date+time is textual)", () => {
  const findings = findBug003Patterns(`someDate.toLocaleString();`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.pattern, "toLocaleString");
});

test("BUG-003 detector: Number#toLocaleString is a finding (Intl/CLDR digit grouping, same skew risk)", () => {
  const findings = findBug003Patterns(`amount.toLocaleString("en-AU");`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.pattern, "toLocaleString");
});

test('BUG-003 detector: Intl.DateTimeFormat with month: "short" is a finding', () => {
  const findings = findBug003Patterns(
    `new Intl.DateTimeFormat("en-AU", { month: "short", timeZone: "UTC" }).format(d);`,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.pattern, "Intl.DateTimeFormat (textual field)");
});

test("BUG-003 detector: Intl.DateTimeFormat with weekday is a finding", () => {
  const findings = findBug003Patterns(
    `new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short" }).formatToParts(d);`,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.pattern, "Intl.DateTimeFormat (textual field)");
});

test("BUG-003 detector: Intl.DateTimeFormat with dayPeriod is a finding", () => {
  const findings = findBug003Patterns(
    `new Intl.DateTimeFormat("en-AU", { timeZone: tz, dayPeriod: "short", hour: "numeric" }).format(d);`,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.pattern, "Intl.DateTimeFormat (textual field)");
});

test("BUG-003 detector: a NUMERIC-only Intl.DateTimeFormat (year/month/day/hour/minute, hour12) is NOT a finding", () => {
  const findings = findBug003Patterns(
    `new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);`,
  );
  assert.deepEqual(findings, []);
});

test("BUG-003 detector: Intl.DateTimeFormat with only a bare timeZone option (validity probe) is NOT a finding", () => {
  const findings = findBug003Patterns(
    `new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();`,
  );
  assert.deepEqual(findings, []);
});

test('BUG-003 detector: month: "numeric" is NOT a finding (only short/long/narrow are textual)', () => {
  const findings = findBug003Patterns(
    `new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "numeric" }).formatToParts(d);`,
  );
  assert.deepEqual(findings, []);
});

test("BUG-003 detector: a comment merely DESCRIBING toLocaleDateString/Intl.DateTimeFormat in prose is not a finding once comments are stripped", () => {
  const source = `
// This module deliberately never calls toLocaleDateString or
// new Intl.DateTimeFormat("en-AU", { month: "short" }) -- see date-display.ts.
export function formatDate(date: string): string {
  return date;
}
`;
  const findings = findBug003Patterns(stripComments(source));
  assert.deepEqual(findings, []);
});
