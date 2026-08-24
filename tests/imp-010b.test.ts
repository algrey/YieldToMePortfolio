/**
 * IMP-010B — Client-side CSV parsing for the ledger-CSV (17-column,
 * IMP-001 strict parser -> staging) import path, applying IMP-010A's
 * binding ruling to the second of the two flagged upload paths (see
 * TASKS.md's IMP-010 entry).
 *
 * Covers: (1) a static proof `domain/imports/strict-versioned-parser.ts`
 * carries no server-only dependency, so it is safe to import directly into
 * the client bundle; (2) a static proof `app/components/import-review.tsx`
 * imports the SAME module directly (single shared implementation, never a
 * fork); (3) a static proof `app/import-actions.ts` no longer gates on
 * `YIELDTOME_WORKERS_PLAN`/`assessCsvImportUploadStart` -- the free-plan
 * gate's honest re-scope this task's critical investigation #2 required
 * (see CSV_IMPORT_SPEC.md's IMP-010B section for the write-up: nothing
 * about this path remains genuinely paid-only once the server never reads
 * a raw CSV body); (4) `app/import-request-body.ts` REUSES IMP-010A's own
 * `readJsonBody` by reference, never forking a second body-size-measuring
 * implementation; (5) a measured JSON-request-body expansion factor for
 * this path's OWN row shape (`rows: string[][]`, not price-backup's
 * named-field-object shape) and a proof `MAX_IMPORT_UPLOAD_REQUEST_BYTES`
 * covers the true worst case (saturating byte AND row-count bounds
 * simultaneously) with real headroom; (6) hostile uploaded-row-payload
 * rejection for `app/import-request-body.ts`'s shape coercers, independent
 * of whether a real browser ever ran the real parser; (7) parser parity --
 * the OLD monolithic `parseStrictVersionedCsvImport(bytes)` path and the
 * NEW split `splitStrictVersionedCsvRows` (browser) -> JSON wire ->
 * `classifyImportRows` (server) path produce byte-identical
 * `ImportParseResult`s, INCLUDING every row fingerprint, the file
 * fingerprint, and `previewVersion`-relevant header/summary fields, across
 * the normative fixture plus BOM/CRLF/multi-currency/quoted-field edge
 * cases; (8) the digest/fingerprint finding this task's critical
 * investigation #1 required: `file_sha256` hashes the RAW FILE BYTES (see
 * `db/repositories/import-staging.ts`'s `ON CONFLICT(user_id, file_sha256,
 * parser_format, parser_version)`), so the browser now computes and sends
 * it (the exact SAME SHA-256 `splitStrictVersionedCsvRows` always
 * computed), and idempotent re-upload/resume behaves identically; (9) a
 * free-plan end-to-end functional proof: the full server-side staging
 * sequence (`classifyImportRows` -> `startUpload` -> `recordParseResult`)
 * succeeds against a real migrated SQLite database with NO plan/env
 * dependency anywhere in the call path.
 *
 * Review round fixes (2026-08-25, corrects the original entry above --
 * two BLOCKING findings plus five folds): (B1) the original entry, and
 * matching comments in `strict-versioned-parser.ts`/`import-request-body.ts`/
 * `CSV_IMPORT_SPEC.md`/`ARCHITECTURE.md`, wrongly claimed the browser also
 * runs `classifyImportRows` "to build its own preview" -- it never does;
 * the browser only splits. All four sites corrected to state the ACTUAL
 * model: `classifyImportRows` is the SOLE, server-only classification
 * authority -- a STRONGER guarantee than a browser/server dual-run, since
 * there is no second execution anywhere to ever disagree with the
 * server's own. (B2, RULING) the owner's explicit goal is production on
 * the Workers FREE plan; `worker/runtime-config.ts`'s
 * `production-requires-paid-workers` gate (a whole-Worker 503) and the
 * now-dead `RuntimeConfig.csvImport` config (never read anywhere, its
 * `reason` string gone false) are retired -- see
 * `tests/runtime-config.test.ts`. (fold 1) the `byteSize` field's
 * "always has been client-trusted" comment was false -- it BECOMES
 * client-claimed here (pre-task, `file.size` was intrinsic to the real
 * transmitted `Blob`); corrected, and (fold 2) bounded above by
 * `MAX_IMPORT_UPLOAD_REQUEST_BYTES`. (fold 3) the conflated
 * "Choose a CSV file and portfolio" 400 message is split into a
 * missing-portfolio message and a malformed-payload message. (fold 4)
 * `classifyImportRows` now ALSO reconstructs the equivalent CSV text and
 * re-checks it against `maxBytes` -- row-count and per-field-length bounds
 * alone do not bound total volume. (fold 5) every size/count-limit message,
 * both client-side (`splitStrictVersionedCsvRows`) and server-side
 * (`classifyImportRows`'s own re-checks, sharing the SAME message
 * builders), now names the actual configured limit and a concrete action,
 * matching the `IMP-010A` round-2 `formatMiB` precedent.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  classifyImportRows,
  DEFAULT_IMPORT_LIMITS,
  parseStrictVersionedCsvImport,
  splitStrictVersionedCsvRows,
  SUPPORTED_IMPORT_HEADER,
  type ImportParseResult,
} from "../domain/imports/strict-versioned-parser.ts";
import {
  fileMetadataFromImportBody,
  MAX_IMPORT_UPLOAD_REQUEST_BYTES,
  rawRowsFromImportBody,
  readJsonBody as readImportJsonBody,
  supersedesBatchIdFromImportBody,
  targetPortfolioIdFromImportBody,
} from "../app/import-request-body.ts";
import { readJsonBody as readPriceJsonBody } from "../app/price-upload-request-body.ts";
import {
  createOwnedImportStagingRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";

async function sourceOf(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function loadFixture(): Promise<string> {
  return await readFile(
    new URL("../docs/Example_Portfolio.csv", import.meta.url),
    "utf8",
  );
}

function makeCsv(rows: string[]): string {
  return [SUPPORTED_IMPORT_HEADER.join(","), ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// (1) Browser-safety.
// ---------------------------------------------------------------------------

const SERVER_ONLY_IMPORT_PATTERN =
  /from\s+["'](?:node:|cloudflare:workers|\.\.?\/db\/|\.\.?\/\.\.?\/db\/)/;

test("IMP-010B browser-safety: domain/imports/strict-versioned-parser.ts has no Node/server/DB import", async () => {
  const source = await sourceOf("domain/imports/strict-versioned-parser.ts");
  assert.doesNotMatch(source, SERVER_ONLY_IMPORT_PATTERN);
});

test("IMP-010B browser-safety: app/components/import-review.tsx imports splitStrictVersionedCsvRows directly from domain/imports/strict-versioned-parser.ts (single shared implementation, never a fork)", async () => {
  const source = await sourceOf("app/components/import-review.tsx");
  assert.match(source, /splitStrictVersionedCsvRows/);
  assert.match(
    source,
    /from\s+["']\.\.\/\.\.\/domain\/imports\/strict-versioned-parser\.ts["']/,
  );
});

// ---------------------------------------------------------------------------
// (2) Plan gate re-scope: app/import-actions.ts no longer gates on
// YIELDTOME_WORKERS_PLAN -- honest per this task's critical investigation
// #2 (see CSV_IMPORT_SPEC.md's IMP-010B section for the ruling).
// ---------------------------------------------------------------------------

// Deliberately narrower than IMP-010A's own `PLAN_GATE_IMPORT_PATTERN`:
// `app/import-actions.ts` DOES legitimately import OTHER names from
// `../domain/imports` (`classifyImportRows`/`DEFAULT_IMPORT_LIMITS`), so
// "any import from that barrel" cannot be the signal here the way it was
// for the price-CSV files (which import nothing from `domain/imports` at
// all). This pins an ACTUAL IMPORT/USAGE of the gate primitives, not the
// bare identifier -- this file's own explanatory comments (and
// `import-actions.ts`'s own header comment) name
// `assessCsvImportUploadStart`/`YIELDTOME_WORKERS_PLAN` to document why
// they are NOT needed here, and a bare-substring pin would wrongly fail on
// that documentation (the same caveat IMP-010A's own pattern notes).
const PLAN_GATE_IMPORT_PATTERN =
  /import\s*\{[^}]*\bassessCsvImportUploadStart\b[^}]*\}\s*from|import\s*\(\s*["']cloudflare:workers["']\s*\)|\.YIELDTOME_WORKERS_PLAN\b/;

test("IMP-010B plan gate: app/import-actions.ts never imports assessCsvImportUploadStart or reads env.YIELDTOME_WORKERS_PLAN -- this path is plan-agnostic by construction now, matching the price-CSV precedent", async () => {
  const source = await sourceOf("app/import-actions.ts");
  assert.doesNotMatch(source, PLAN_GATE_IMPORT_PATTERN);
  // The domain-level `classifyImportRows`/`DEFAULT_IMPORT_LIMITS` import
  // (the barrel `../domain/imports`) is expected and fine -- confirm it's
  // present so this test isn't vacuously passing because the file imports
  // nothing from that module at all.
  assert.match(source, /from\s+["']\.\.\/domain\/imports["']/);
});

test("IMP-010B plan gate: app/import-request-body.ts never imports assessCsvImportUploadStart or reads env.YIELDTOME_WORKERS_PLAN", async () => {
  const source = await sourceOf("app/import-request-body.ts");
  assert.doesNotMatch(source, PLAN_GATE_IMPORT_PATTERN);
});

// ---------------------------------------------------------------------------
// (3) Shared module, never a fork: app/import-request-body.ts REUSES
// IMP-010A's own readJsonBody by reference.
// ---------------------------------------------------------------------------

test("IMP-010B: app/import-request-body.ts's readJsonBody IS app/price-upload-request-body.ts's readJsonBody (re-exported, not forked)", () => {
  assert.equal(readImportJsonBody, readPriceJsonBody);
});

// ---------------------------------------------------------------------------
// (4) Measured JSON request-body expansion factor for THIS path's row
// shape (a plain string[][], not a named-field object per row).
// ---------------------------------------------------------------------------

test("IMP-010B: MAX_IMPORT_UPLOAD_REQUEST_BYTES (24 MiB) honestly covers the true worst case -- DEFAULT_IMPORT_LIMITS.maxBytes (10 MiB) AND .maxRows (100,000) saturated SIMULTANEOUSLY -- with real headroom", () => {
  const MB = 1024 * 1024;
  const FIELDS = SUPPORTED_IMPORT_HEADER.length;
  // The row size that saturates BOTH the byte cap and the row-count cap at
  // once is the TRUE worst case for total JSON bytes: per-row JSON
  // quoting/comma overhead is roughly CONSTANT regardless of field content
  // length, so shorter rows produce a higher per-row RATIO but need MORE
  // rows to reach the same total bytes -- capped at maxRows, they can never
  // reach the full maxBytes budget. Longer rows reach maxBytes with fewer
  // rows, paying the per-row overhead fewer times. Only the row size that
  // hits both caps together maximizes the total.
  const avgRowBytes =
    DEFAULT_IMPORT_LIMITS.maxBytes / DEFAULT_IMPORT_LIMITS.maxRows;
  const overheadPerRow = FIELDS - 1 + 2; // commas + CRLF
  const perFieldChars = Math.max(
    0,
    Math.round((avgRowBytes - overheadPerRow) / FIELDS),
  );
  const fields = new Array(FIELDS).fill(0).map(() => "x".repeat(perFieldChars));
  const csvRowBytes = new TextEncoder().encode(
    fields.join(",") + "\r\n",
  ).length;
  const jsonRowBytes = new TextEncoder().encode(
    JSON.stringify(fields) + ",",
  ).length;
  const expansionFactor = jsonRowBytes / csvRowBytes;
  // Measured ~1.34x -- much smaller than IMP-010A's ~2.30x price-backup
  // figure (a named-field object per row), since a plain string array pays
  // only quote+comma overhead, not repeated field names. Asserted in a
  // band so a future field-count change re-triggers this drill.
  assert.ok(
    expansionFactor > 1.1 && expansionFactor < 1.7,
    `expansion factor drifted: ${expansionFactor}`,
  );
  const worstCaseTotalJsonBytes = jsonRowBytes * DEFAULT_IMPORT_LIMITS.maxRows;
  assert.ok(
    worstCaseTotalJsonBytes < MAX_IMPORT_UPLOAD_REQUEST_BYTES,
    `the honest worst-case JSON payload (${(worstCaseTotalJsonBytes / MB).toFixed(2)} MiB) must fit under the ${MAX_IMPORT_UPLOAD_REQUEST_BYTES / MB} MiB request ceiling`,
  );
  // Real headroom, not a knife-edge fit.
  assert.ok(worstCaseTotalJsonBytes < MAX_IMPORT_UPLOAD_REQUEST_BYTES * 0.75);
});

// ---------------------------------------------------------------------------
// (5) Hostile uploaded-row-payload rejection.
// ---------------------------------------------------------------------------

test("IMP-010B hostile payload: rawRowsFromImportBody rejects a non-array rows field, a non-array row, a non-string field, and an oversized row count", () => {
  assert.equal(
    rawRowsFromImportBody(
      { rows: "not-an-array" },
      DEFAULT_IMPORT_LIMITS.maxRows,
    ),
    null,
  );
  assert.equal(
    rawRowsFromImportBody(
      { rows: [{ not: "an array" }] },
      DEFAULT_IMPORT_LIMITS.maxRows,
    ),
    null,
  );
  assert.equal(
    rawRowsFromImportBody({ rows: [[1, 2, 3]] }, DEFAULT_IMPORT_LIMITS.maxRows),
    null,
  );
  assert.equal(
    rawRowsFromImportBody({ rows: new Array(5).fill(["a"]) }, 2),
    null,
  );
  const ok = rawRowsFromImportBody(
    { rows: [SUPPORTED_IMPORT_HEADER as unknown as string[], ["1", "ABC"]] },
    DEFAULT_IMPORT_LIMITS.maxRows,
  );
  assert.deepEqual(ok, [[...SUPPORTED_IMPORT_HEADER], ["1", "ABC"]]);
});

test("IMP-010B hostile payload: fileMetadataFromImportBody rejects a malformed fileSha256 or byteSize, and lower-cases an honest hex hash", () => {
  assert.equal(
    fileMetadataFromImportBody({ fileSha256: "not-hex", byteSize: 10 }),
    null,
  );
  assert.equal(
    fileMetadataFromImportBody({ fileSha256: "a".repeat(63), byteSize: 10 }),
    null,
  );
  assert.equal(
    fileMetadataFromImportBody({ fileSha256: "A".repeat(64), byteSize: -1 }),
    null,
  );
  assert.equal(
    fileMetadataFromImportBody({ fileSha256: "A".repeat(64), byteSize: 1.5 }),
    null,
  );
  const ok = fileMetadataFromImportBody({
    fileSha256: "A".repeat(64),
    byteSize: 42,
    filename: "sample.csv",
  });
  assert.deepEqual(ok, {
    filename: "sample.csv",
    fileSha256: "a".repeat(64),
    byteSize: 42,
  });
});

test("IMP-010B: targetPortfolioIdFromImportBody/supersedesBatchIdFromImportBody trim and default to an empty string for missing/malformed input", () => {
  assert.equal(targetPortfolioIdFromImportBody({}), "");
  assert.equal(
    targetPortfolioIdFromImportBody({ targetPortfolioId: "  portfolio-a  " }),
    "portfolio-a",
  );
  assert.equal(supersedesBatchIdFromImportBody({}), "");
  assert.equal(
    supersedesBatchIdFromImportBody({ supersedesBatchId: 12345 }),
    "",
  );
});

// ---------------------------------------------------------------------------
// (5.5) Review round fixes: byte-volume re-enforcement (fold 4), actionable
// pre-check/re-check messages (fold 5), byteSize bounded above (fold 2), and
// the split 400-message wording (fold 3).
// ---------------------------------------------------------------------------

test("IMP-010B review fold 4: classifyImportRows rejects a rows[][] payload that passes row-count AND per-field-length individually but sums to more than maxBytes -- row-count/field-length bounds alone do not bound total volume", async () => {
  const limits = { maxBytes: 1_000, maxRows: 50, maxFieldLength: 100 };
  // 50 rows (at the row cap) x 17 fields x ~40 chars/field -- each field and
  // each row individually passes both other checks, but the total (~34,000
  // bytes) is far over the 1,000-byte maxBytes cap.
  const row = new Array(17).fill("x".repeat(40));
  const rows = new Array(50).fill(row);
  const result = await classifyImportRows(rows, limits, "a".repeat(64));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "CSV_IMPORT_TOO_LARGE");
  assert.match(result.message, /1 MiB|0 MiB/); // formatMiB(1000) rounds to "0 MiB"
});

test("IMP-010B review fold 4: the byte-volume check is a LOWER BOUND -- it never rejects a payload that genuinely fits under maxBytes, even with many rows", async () => {
  // A payload well inside every bound (mirrors a real small CSV) must not
  // be rejected by the new reconstruction-based check.
  const result = await classifyImportRows(
    [SUPPORTED_IMPORT_HEADER as unknown as string[], ["1", "ABC", "Alpha"]],
    DEFAULT_IMPORT_LIMITS,
    "a".repeat(64),
  );
  assert.notEqual(
    result.ok === false && (result as { code?: string }).code,
    "CSV_IMPORT_TOO_LARGE",
  );
});

test("IMP-010B review fold 5: every size/count-limit message names the actual configured limit and a concrete action, both from the character-level split AND from classifyImportRows's own re-checks", async () => {
  // Row-limit: split phase (parseCsvText, via splitStrictVersionedCsvRows).
  const rowSplit = await splitStrictVersionedCsvRows(
    makeCsv([
      `"1","ABC","Alpha",,"ASX","Main","AUD",,,,,,,,,,`,
      `"2",,,,,,,,,,,,,,,,`,
    ]),
    { maxBytes: 10 * 1024 * 1024, maxRows: 1, maxFieldLength: 1024 },
  );
  assert.equal(rowSplit.ok, false);
  if (!rowSplit.ok) {
    assert.match(rowSplit.message, /1-row limit/);
    assert.match(rowSplit.message, /split the file/i);
  }

  // Row-limit: classifyImportRows's own defense-in-depth re-check (same
  // wording, no drift).
  const rowClassify = await classifyImportRows(
    [
      [...SUPPORTED_IMPORT_HEADER],
      [
        "1",
        "ABC",
        "Alpha",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
      [
        "2",
        "ABC",
        "Beta",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
    ],
    { maxBytes: 10 * 1024 * 1024, maxRows: 1, maxFieldLength: 1024 },
    "a".repeat(64),
  );
  assert.equal(rowClassify.ok, false);
  if (!rowClassify.ok) {
    assert.equal(rowClassify.code, "ROW_LIMIT_EXCEEDED");
    assert.match(rowClassify.message, /1-row limit/);
    assert.match(rowClassify.message, /split the file/i);
    if (!rowSplit.ok) assert.equal(rowClassify.message, rowSplit.message);
  }

  // Field-limit: names the character limit and suggests checking for
  // corruption.
  const fieldResult = await splitStrictVersionedCsvRows(
    makeCsv([`"1","ABC","${"x".repeat(32)}",,"ASX","Main","AUD",,,,,,,,,,`]),
    { maxBytes: 10 * 1024 * 1024, maxRows: 100_000, maxFieldLength: 8 },
  );
  assert.equal(fieldResult.ok, false);
  if (!fieldResult.ok) {
    assert.match(fieldResult.message, /8-character limit/);
    assert.match(fieldResult.message, /corrupted or unterminated/i);
  }

  // Decode failures: both variants name a concrete fix.
  const decodeResult = await splitStrictVersionedCsvRows(
    new TextEncoder().encode(
      makeCsv([`"1","ABC","Al pha",,"ASX","Main","AUD",,,,,,,,,,`]),
    ),
    DEFAULT_IMPORT_LIMITS,
  );
  assert.equal(decodeResult.ok, false);
  if (!decodeResult.ok) {
    assert.match(decodeResult.message, /Remove the binary content/i);
  }
});

test("IMP-010B review fold 2: fileMetadataFromImportBody rejects a byteSize claim over MAX_IMPORT_UPLOAD_REQUEST_BYTES", () => {
  assert.equal(
    fileMetadataFromImportBody({
      fileSha256: "a".repeat(64),
      byteSize: MAX_IMPORT_UPLOAD_REQUEST_BYTES + 1,
    }),
    null,
  );
  const ok = fileMetadataFromImportBody({
    fileSha256: "a".repeat(64),
    byteSize: MAX_IMPORT_UPLOAD_REQUEST_BYTES,
  });
  assert.notEqual(ok, null);
});

test("IMP-010B review fold 3: createImportPreviewAction's 400 responses distinguish a missing target portfolio from a malformed payload, rather than one conflated message", async () => {
  const source = await sourceOf("app/import-actions.ts");
  assert.match(source, /"Choose a target portfolio\."/);
  assert.match(source, /"The uploaded CSV payload was invalid or malformed\."/);
  // The old conflated message must be gone.
  assert.doesNotMatch(source, /"Choose a CSV file and portfolio\."/);
});

// ---------------------------------------------------------------------------
// (6) Parser parity: OLD monolithic path vs. NEW split (browser-split ->
// JSON wire -> server-classify) path produce byte-identical results,
// including fingerprints, across the normative fixture and edge cases.
// ---------------------------------------------------------------------------

async function assertSplitClassifyParity(source: string | Uint8Array) {
  const monolithic = await parseStrictVersionedCsvImport(source);
  const split = await splitStrictVersionedCsvRows(
    source,
    DEFAULT_IMPORT_LIMITS,
  );
  assert.equal(split.ok, true);
  if (!split.ok) return;
  // Simulate the actual browser -> server wire: JSON.stringify/parse the
  // split rows, exactly as `import-review.tsx`'s fetch body and
  // `readJsonBody`'s `JSON.parse` do.
  const wireRows = JSON.parse(JSON.stringify(split.rows)) as string[][];
  const viaWire: ImportParseResult = await classifyImportRows(
    wireRows,
    DEFAULT_IMPORT_LIMITS,
    split.fileFingerprint,
  );
  assert.deepEqual(viaWire, monolithic);
}

test("IMP-010B parity: the normative Example_Portfolio.csv fixture parses identically (including every row fingerprint and the file fingerprint) via the old monolithic path and the new split/classify/JSON-wire path", async () => {
  await assertSplitClassifyParity(await loadFixture());
});

test("IMP-010B parity: BOM + CRLF + padded header parses identically via both paths", async () => {
  const fixture = await loadFixture();
  const [header, ...body] = fixture.split("\n");
  const transformed = `﻿  ${header.trimEnd()}  \r\n${body.join("\r\n")}`;
  await assertSplitClassifyParity(transformed);
});

test("IMP-010B parity: quoted commas, embedded newlines, and multi-currency rows parse identically via both paths", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha, Beta",,"ASX","Main","AUD",,,,,,,,,,`,
    `"2","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"line 1\n=HYPERLINK(javascript:alert(1))"`,
    `"3","XYZ","Foreign",,"NYSE","Main","USD","10","5.00","0","2025-07-17 GMT+1000","09:00:00","1.4821","Buy",,,`,
  ]);
  await assertSplitClassifyParity(csv);
});

test("IMP-010B parity: a duplicate-row / cash-row / header-mismatch fixture all parse identically via both paths (proves classifyImportRows reaches the SAME failure/duplicate branches, not a simplified re-check)", async () => {
  await assertSplitClassifyParity(
    makeCsv([
      `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"dup"`,
      `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"dup"`,
      `"2","AUD=CASH",,,"","Main","AUD","150000","1","0","2025-08-01 GMT+1000","09:50:00",,"Buy",,,`,
    ]),
  );
  const badHeader: string[] = [...SUPPORTED_IMPORT_HEADER];
  badHeader[badHeader.length - 1] = "Bogus";
  await assertSplitClassifyParity(`${badHeader.join(",")}\n`);
});

test("IMP-010B parity: classifyImportRows re-derives normalized fields/issues from raw rows regardless of what a hostile payload CLAIMS -- never trusts a caller-supplied normalized/issues/fingerprint shape (there is none to trust; the function's only input is raw string[][])", async () => {
  // A hostile caller cannot even express a "claimed normalized row" through
  // this API -- classifyImportRows's signature is (rows: string[][],
  // limits, fileFingerprint), so the only way to influence the result is
  // through the SAME raw fields a genuine browser upload would send. This
  // test proves that feeding the RAW row through the real function
  // reproduces the exact classification a hand-crafted "pretend this is
  // already valid" shortcut could never bypass.
  const rows = [
    [...SUPPORTED_IMPORT_HEADER],
    [
      "1",
      "ABC",
      "Alpha",
      "",
      "ASX",
      "Main",
      "AUD",
      "abc", // hostile: non-numeric shares, must still be rejected
      "12.50",
      "0",
      "2025-07-16 GMT+1000",
      "14:35:00",
      "",
      "Buy",
      "",
      "",
      "",
    ],
  ];
  const result = await classifyImportRows(
    rows,
    DEFAULT_IMPORT_LIMITS,
    "a".repeat(64),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const row = result.rows[0];
  assert.equal(row?.kind, "unsupported");
  assert.ok(row?.issues.some((issue) => issue.code === "QUANTITY_INVALID"));
});

// ---------------------------------------------------------------------------
// (7) Digest finding: file_sha256 hashes the RAW FILE BYTES; the browser's
// splitStrictVersionedCsvRows computes exactly that hash, so re-upload
// dedupe/resume is unaffected by this task.
// ---------------------------------------------------------------------------

test("IMP-010B digest: splitStrictVersionedCsvRows's fileFingerprint is the SHA-256 of the raw source bytes -- the exact value the OLD server-side parser computed and import_batches.file_sha256 has always deduped on", async () => {
  const fixture = await loadFixture();
  const bytes = new TextEncoder().encode(fixture);
  const expected = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const split = await splitStrictVersionedCsvRows(bytes, DEFAULT_IMPORT_LIMITS);
  assert.equal(split.ok, true);
  if (!split.ok) return;
  assert.equal(split.fileFingerprint, expected);
  const monolithic = await parseStrictVersionedCsvImport(bytes);
  assert.equal(monolithic.fileFingerprint, expected);
});

// ---------------------------------------------------------------------------
// (8) Free-plan end-to-end + idempotent re-upload/resume: the full
// server-side staging sequence succeeds against a real migrated database
// with no plan/env dependency anywhere in the call path.
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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-25', '2026-08-25', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-25', '2026-08-25', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-25', '2026-08-25', 1);
  `);
  return database;
}

// This function deliberately mirrors app/import-actions.ts's
// createImportPreviewAction body (JSON-body-read step aside, which
// tests/imp-010a.test.ts already exercises against the SAME shared
// readJsonBody) rather than importing that action directly -- like every
// other import-flow test in this suite (see e.g. tests/imp-003b.test.ts),
// import-actions.ts transitively imports `next/headers` via
// getAuthenticatedSqlContext, which ERR_MODULE_NOT_FOUNDs under the plain
// Node test runner. Nothing below references YIELDTOME_WORKERS_PLAN or any
// Cloudflare Workers binding -- the whole point of this drill.
async function stageUploadJson(
  client: ReturnType<typeof createSqliteSqlClient>,
  body: Record<string, unknown>,
) {
  const targetPortfolioId = targetPortfolioIdFromImportBody(body);
  const supersedesBatchId = supersedesBatchIdFromImportBody(body);
  const fileMetadata = fileMetadataFromImportBody(body);
  const rawRows = rawRowsFromImportBody(body, DEFAULT_IMPORT_LIMITS.maxRows);
  if (!targetPortfolioId || !fileMetadata || rawRows === null) {
    throw new Error("invalid payload");
  }
  const parseResult = await classifyImportRows(
    rawRows,
    DEFAULT_IMPORT_LIMITS,
    fileMetadata.fileSha256,
  );
  const staging = createOwnedImportStagingRepository(client);
  const started = await staging.startUpload("user-a", {
    targetPortfolioId,
    supersedesBatchId: supersedesBatchId || null,
    parserFormat: "strict-versioned-csv",
    parserVersion: parseResult.parserVersion,
    filename: fileMetadata.filename,
    byteSize: fileMetadata.byteSize,
    fileSha256: fileMetadata.fileSha256,
  });
  if (!started.ok) throw new Error(started.reason);
  if (!started.reused && started.batch.status === "uploaded") {
    const recorded = await staging.recordParseResult(
      "user-a",
      started.batch.id,
      {
        expectedVersion: started.batch.version,
        parseResult,
      },
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    return { ...started, batch: recorded.batch };
  }
  return started;
}

function jsonBodyForCsv(csv: string, rows: string[][], fileSha256: string) {
  return {
    targetPortfolioId: "portfolio-a",
    supersedesBatchId: "",
    filename: "upload.csv",
    fileSha256,
    byteSize: new TextEncoder().encode(csv).length,
    rows,
  };
}

test("IMP-010B free-plan end-to-end: the full browser-split -> JSON -> server-classify -> stage sequence succeeds with no plan/env gate anywhere in the path", async () => {
  const csv = await loadFixture();
  const split = await splitStrictVersionedCsvRows(csv, DEFAULT_IMPORT_LIMITS);
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const client = createSqliteSqlClient(await migratedDatabase());
  const body = jsonBodyForCsv(
    csv,
    JSON.parse(JSON.stringify(split.rows)),
    split.fileFingerprint,
  );
  const started = await stageUploadJson(client, body);
  assert.equal(started.reused, false);
  assert.equal(started.batch.status, "parsed");
  assert.equal(started.batch.totalRows, 244);
  assert.equal(started.batch.definitionRows, 65);
  assert.equal(started.batch.transactionRows, 115);
});

test("IMP-010B idempotent re-upload + resume: re-submitting the identical browser-parsed payload dedupes onto the SAME batch (reused:true), never re-staging rows, matching the pre-IMP-010B natural-key behaviour exactly", async () => {
  const csv = await loadFixture();
  const split = await splitStrictVersionedCsvRows(csv, DEFAULT_IMPORT_LIMITS);
  assert.equal(split.ok, true);
  if (!split.ok) return;
  const client = createSqliteSqlClient(await migratedDatabase());
  const body = jsonBodyForCsv(
    csv,
    JSON.parse(JSON.stringify(split.rows)),
    split.fileFingerprint,
  );
  const first = await stageUploadJson(client, body);
  assert.equal(first.reused, false);
  const second = await stageUploadJson(client, body);
  assert.equal(second.reused, true);
  assert.equal(second.batch.id, first.batch.id);
  const staging = createOwnedImportStagingRepository(client);
  const rows = await staging.listRows("user-a", first.batch.id);
  // 244 total rows staged exactly once, not duplicated by the re-upload.
  assert.equal(rows.length, 244);
});
