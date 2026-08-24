/**
 * IMP-010A — Client-side CSV parsing for the MKT-008 price-CSV path so
 * imports fit the Cloudflare free plan (owner directive: "Change the
 * project so the CSV processing is done in browser, then uploaded as rows
 * to the database.").
 *
 * Covers what `tests/mkt-008.test.ts`/`tests/mkt-018c.test.ts` (both
 * updated in this task to call the service layer with browser-parsed
 * payloads instead of raw bytes) do not: (1) a static proof the two pure
 * parsers this task moves into the browser bundle
 * (`domain/market-data/price-csv.ts`, `price-backup-csv.ts`, plus the
 * `text-encoding.ts`/`price-value-grammar.ts` modules they depend on) carry
 * NO server-only dependency; (2) a static proof the price-CSV action/service
 * layer never gates on `YIELDTOME_WORKERS_PLAN` (the "free plan" requirement
 * is trivially satisfied because there is no plan branch to fail on --
 * unlike the ledger-CSV path `app/import-actions.ts` gates via
 * `assessCsvImportUploadStart`, which this path never calls); (3) hostile
 * uploaded-row-payload rejection for both formats' server-side
 * re-validators (`validateUploadedPriceCsvPayload`/
 * `validateUploadedPriceBackupPayload`), independent of whether a real
 * browser ever ran the real parser; (4) parser parity -- the SAME fixture
 * bytes, parsed once, produce IDENTICAL normalized rows whether read
 * straight off the parser or round-tripped through JSON (simulating the
 * browser-to-server wire); (5) the digest/fingerprint finding this task's
 * binding ruling required investigating -- there is no file-level digest
 * for this path today (idempotency has always been the natural-key upsert
 * in `db/repositories/price-uploads.ts`), so there is no digest semantics
 * to preserve.
 *
 * Round-2 review fixes (BLOCKING, 2026-08-25): (B1) `MAX_BACKUP_REQUEST_BYTES`
 * raised 24 MiB -> 64 MiB (the unchanged 24 MiB ceiling silently rejected any
 * backup export over ~10.35 MiB once measured against the ~2.30x JSON
 * expansion factor -- a real disaster-recovery regression) and
 * `DEFAULT_PRICE_BACKUP_LIMITS.maxRows` corrected 500,000 -> 130,000 (the
 * documented figure was arithmetically unreachable); (B2) the request-body
 * size defence moved from a `content-length`-header-only check (bypassable
 * via chunked transfer, which carries no such header) to a MEASURED byte
 * length checked before `JSON.parse`, and `priceDecimal`/`sourceLabel` gained
 * explicit length bounds. Tests below cover both.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEFAULT_PRICE_CSV_LIMITS,
  parsePriceCsv,
  validateUploadedPriceCsvPayload,
  validateUploadedPriceCsvRow,
  validateUploadedPriceCsvTicker,
} from "../domain/market-data/price-csv.ts";
import {
  DEFAULT_PRICE_BACKUP_LIMITS,
  MAX_SOURCE_LABEL_LENGTH,
  parsePriceBackupCsv,
  PRICE_BACKUP_FORMAT_VERSION,
  sanitizeUploadedMalformedByReason,
  validateUploadedPriceBackupPayload,
  validateUploadedPriceBackupRow,
} from "../domain/market-data/price-backup-csv.ts";
import {
  isPositiveDecimal,
  isValidMarketDate,
} from "../domain/market-data/price-value-grammar.ts";
import { DECIMAL_LIMITS } from "../domain/calculations/decimal.ts";
import {
  confirmSinglePriceUpload,
  type PriceUploadContext,
} from "../app/price-upload-service.ts";
import {
  MAX_BACKUP_REQUEST_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  readJsonBody,
} from "../app/price-upload-request-body.ts";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// (1) Browser-safety: the parsers this task moves into the client bundle
// carry no Node/server/DB dependency.
// ---------------------------------------------------------------------------

const SERVER_ONLY_IMPORT_PATTERN =
  /from\s+["'](?:node:|cloudflare:workers|\.\.?\/db\/|\.\.?\/\.\.?\/db\/)/;

async function sourceOf(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("IMP-010A browser-safety: domain/market-data/price-csv.ts has no Node/server/DB import", async () => {
  const source = await sourceOf("domain/market-data/price-csv.ts");
  assert.doesNotMatch(source, SERVER_ONLY_IMPORT_PATTERN);
});

test("IMP-010A browser-safety: domain/market-data/price-backup-csv.ts has no Node/server/DB import", async () => {
  const source = await sourceOf("domain/market-data/price-backup-csv.ts");
  assert.doesNotMatch(source, SERVER_ONLY_IMPORT_PATTERN);
});

test("IMP-010A browser-safety: domain/market-data/text-encoding.ts has no Node/server/DB import", async () => {
  const source = await sourceOf("domain/market-data/text-encoding.ts");
  assert.doesNotMatch(source, SERVER_ONLY_IMPORT_PATTERN);
});

test("IMP-010A browser-safety: domain/market-data/price-value-grammar.ts has no Node/server/DB import", async () => {
  const source = await sourceOf("domain/market-data/price-value-grammar.ts");
  assert.doesNotMatch(source, SERVER_ONLY_IMPORT_PATTERN);
});

test("IMP-010A browser-safety: historical-data-panel.tsx imports the parsers directly from domain/market-data/ (single shared implementation, never a fork)", async () => {
  const source = await sourceOf("app/components/historical-data-panel.tsx");
  assert.match(
    source,
    /from\s+["']\.\.\/\.\.\/domain\/market-data\/price-csv\.ts["']/,
  );
  assert.match(
    source,
    /from\s+["']\.\.\/\.\.\/domain\/market-data\/price-backup-csv\.ts["']/,
  );
});

// ---------------------------------------------------------------------------
// (2) Plan gate: the price-CSV path has no YIELDTOME_WORKERS_PLAN branch --
// unlike the ledger-CSV path, there is nothing to lift for "free" to work.
// ---------------------------------------------------------------------------

// The two patterns below deliberately look for an ACTUAL reference (an
// `import ... from` line, or a `.YIELDTOME_WORKERS_PLAN`/`import(...)`
// usage) rather than the bare identifier -- this file's own explanatory
// comments name `assessCsvImportUploadStart`/`YIELDTOME_WORKERS_PLAN` (to
// document why they are NOT needed here), and a bare-substring pin would
// wrongly fail on its own documentation.
//
// Review F4 fix (2026-08-25): the module-path alternative must also catch
// the BARREL specifier (`../domain/imports/index.ts` or the bare
// `../domain/imports`, both real forms used elsewhere in this codebase --
// see `app/import-actions.ts` vs. `app/sharesight-sync-service.ts`) that
// re-exports `assessCsvImportUploadStart`, not only a direct import from
// `strict-versioned-parser.ts` -- a future edit routing through the barrel
// would otherwise slip past this pin undetected.
const PLAN_GATE_IMPORT_PATTERN =
  /import\s*\{[^}]*\}\s*from\s+["'][^"']*domain\/imports(?:\/(?:index\.ts|strict-versioned-parser\.ts))?["']|import\s*\(\s*["']cloudflare:workers["']\s*\)|\.YIELDTOME_WORKERS_PLAN\b/;

test("IMP-010A plan gate: app/price-upload-actions.ts never IMPORTS assessCsvImportUploadStart or reads env.YIELDTOME_WORKERS_PLAN -- this path is plan-agnostic by construction, so it already works under the free plan", async () => {
  const source = await sourceOf("app/price-upload-actions.ts");
  assert.doesNotMatch(source, PLAN_GATE_IMPORT_PATTERN);
});

test("IMP-010A plan gate: app/price-upload-service.ts never IMPORTS assessCsvImportUploadStart or reads env.YIELDTOME_WORKERS_PLAN", async () => {
  const source = await sourceOf("app/price-upload-service.ts");
  assert.doesNotMatch(source, PLAN_GATE_IMPORT_PATTERN);
});

test("IMP-010A plan gate: app/price-upload-request-body.ts never IMPORTS assessCsvImportUploadStart or reads env.YIELDTOME_WORKERS_PLAN", async () => {
  const source = await sourceOf("app/price-upload-request-body.ts");
  assert.doesNotMatch(source, PLAN_GATE_IMPORT_PATTERN);
});

// ---------------------------------------------------------------------------
// (2.5) Review round-2 B1/B2 fixes: request-body size is MEASURED (never
// header-trusted), and the backup-request ceiling honestly covers the
// client-side file cap at the measured JSON expansion factor.
// ---------------------------------------------------------------------------

function jsonRequestOf(
  bodyText: string,
  headers?: Record<string, string>,
): Request {
  // Node's `Request` never auto-computes a `content-length` header for a
  // plain string body (verified: `new Request(url, {method, body}).headers
  // .get("content-length")` is `null`) -- this IS the chunked-transfer
  // shape the review's B2 finding describes (no length header at all), so
  // no header is supplied unless the test explicitly passes one.
  return new Request(
    "https://example.test/api/market-data/price-uploads/preview",
    {
      method: "POST",
      body: bodyText,
      headers,
    },
  );
}

test("IMP-010A review B2 drill: a request with NO content-length header (the chunked-transfer shape) and an oversized body is still rejected 413 -- the real measured byte length is checked, not the (absent) header", async () => {
  const hugeBody = JSON.stringify({
    ticker: "FMG",
    rows: [{ marketDate: "2020-01-01", priceDecimal: "1.00" }],
    padding: "x".repeat(MAX_UPLOAD_REQUEST_BYTES + 1024),
  });
  const request = jsonRequestOf(hugeBody);
  assert.equal(request.headers.get("content-length"), null);
  const result = await readJsonBody(request, MAX_UPLOAD_REQUEST_BYTES);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 413);
});

test("IMP-010A review B2 drill: a content-length header that LIES (declares small, body is actually huge) is still rejected -- the header is never trusted as sufficient on its own", async () => {
  const hugeBody = JSON.stringify({
    ticker: "FMG",
    rows: [],
    padding: "x".repeat(MAX_UPLOAD_REQUEST_BYTES + 1024),
  });
  const request = jsonRequestOf(hugeBody, { "content-length": "10" });
  const result = await readJsonBody(request, MAX_UPLOAD_REQUEST_BYTES);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 413);
});

test("IMP-010A review B2: an honestly-sized request under the ceiling is accepted and its JSON body is returned", async () => {
  const body = JSON.stringify({ ticker: "FMG", rows: [] });
  const request = jsonRequestOf(body);
  const result = await readJsonBody(request, MAX_UPLOAD_REQUEST_BYTES);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.ticker, "FMG");
});

test("IMP-010A review B1: MAX_BACKUP_REQUEST_BYTES (64 MiB) honestly covers the 20 MiB client-side backup file cap at the measured ~2.30x JSON expansion factor, with real headroom", () => {
  const MB = 1024 * 1024;
  const typicalCsvRow =
    "yieldtome-price-backup-v1,owner-import,intelligent-investor,FMG,ASX,AUD,1998-03-12,0.07852,1998-03-11T13:00:00.000Z,Australia/Sydney,eod,observed,raw,\r\n";
  const typicalJsonRow =
    JSON.stringify({
      providerId: "owner-import",
      sourceLabel: "intelligent-investor",
      providerSymbol: "FMG",
      providerExchange: "ASX",
      currencyCode: "AUD",
      marketDate: "1998-03-12",
      priceDecimal: "0.07852",
      observationAt: "1998-03-11T13:00:00.000Z",
      marketTimezone: "Australia/Sydney",
      interval: "eod",
      quality: "observed",
      adjustmentState: "raw",
      delayedMinutes: null,
    }) + ",";
  const csvRowBytes = new TextEncoder().encode(typicalCsvRow).length;
  const jsonRowBytes = new TextEncoder().encode(typicalJsonRow).length;
  const expansionFactor = jsonRowBytes / csvRowBytes;
  // Measured expansion is ~2.30x -- assert it stays in a tight band so a
  // future field change to either format re-triggers this drill rather
  // than silently drifting the "64 MiB covers 20 MiB" claim.
  assert.ok(
    expansionFactor > 2.0 && expansionFactor < 2.6,
    `expansion factor drifted: ${expansionFactor}`,
  );
  const maxRowsFromClientFileCap = Math.floor(
    DEFAULT_PRICE_BACKUP_LIMITS.maxBytes / csvRowBytes,
  );
  const bytesNeededForThatManyRowsAsJson =
    maxRowsFromClientFileCap * jsonRowBytes;
  assert.ok(
    bytesNeededForThatManyRowsAsJson < MAX_BACKUP_REQUEST_BYTES,
    `a real ${DEFAULT_PRICE_BACKUP_LIMITS.maxBytes / MB} MiB backup file's JSON payload (${(bytesNeededForThatManyRowsAsJson / MB).toFixed(1)} MiB) must fit under the ${MAX_BACKUP_REQUEST_BYTES / MB} MiB request ceiling`,
  );
  // And the corrected row-count cap itself must be genuinely reachable:
  // fewer rows than a real 20 MiB file could ever contain (never a
  // decorative unreachable number), and its own JSON encoding must fit the
  // server ceiling even at every row's worst-case bounded field lengths.
  assert.ok(DEFAULT_PRICE_BACKUP_LIMITS.maxRows < maxRowsFromClientFileCap);
  const worstCaseRow =
    JSON.stringify({
      providerId: "owner-import",
      sourceLabel: "x".repeat(MAX_SOURCE_LABEL_LENGTH),
      providerSymbol: "ABCDEFGHIJ",
      providerExchange: "ABCDEFGHIJ",
      currencyCode: "AUD",
      marketDate: "1998-03-12",
      priceDecimal: "1".repeat(DECIMAL_LIMITS.inputDigits),
      observationAt: "1998-03-11T13:00:00.000Z",
      marketTimezone: "Australia/Sydney",
      interval: "delayed",
      quality: "stale_candidate",
      adjustmentState: "total_return_adjusted",
      delayedMinutes: 999999,
    }) + ",";
  const worstCaseRowBytes = new TextEncoder().encode(worstCaseRow).length;
  assert.ok(
    DEFAULT_PRICE_BACKUP_LIMITS.maxRows * worstCaseRowBytes <
      MAX_BACKUP_REQUEST_BYTES,
    "the corrected row cap must fit the server ceiling even in the worst (fully bounded-length) case",
  );
});

test("IMP-010A review B2 drill (huge decimal): a 500,001-digit priceDecimal (the reviewer's exact repro) is rejected by the shared grammar, not silently accepted", () => {
  const hugeDecimal = "1".repeat(500_001);
  assert.equal(isPositiveDecimal(hugeDecimal), false);

  const singleRowResult = validateUploadedPriceCsvRow(2, {
    marketDate: "2020-01-01",
    priceDecimal: hugeDecimal,
  });
  assert.equal(singleRowResult.ok, false);
  if (!singleRowResult.ok)
    assert.equal(singleRowResult.reason, "invalid_price");

  const backupRowResult = validateUploadedPriceBackupRow(2, {
    providerId: "owner-import",
    sourceLabel: "intelligent-investor",
    providerSymbol: "FMG",
    providerExchange: "ASX",
    currencyCode: "AUD",
    marketDate: "2020-01-01",
    priceDecimal: hugeDecimal,
    observationAt: "2020-01-01T00:00:00.000Z",
    marketTimezone: "Australia/Sydney",
    interval: "eod",
    quality: "observed",
    adjustmentState: "raw",
    delayedMinutes: null,
  });
  assert.equal(backupRowResult.ok, false);
  if (!backupRowResult.ok)
    assert.equal(backupRowResult.reason, "invalid_price");

  // A decimal at EXACTLY the DECIMAL_LIMITS.inputDigits boundary is still
  // valid (the cap is inclusive, matching `domain/calculations/decimal.ts`'s
  // own `> DECIMAL_LIMITS.inputDigits` rejection convention).
  assert.equal(isPositiveDecimal("1".repeat(DECIMAL_LIMITS.inputDigits)), true);
  assert.equal(
    isPositiveDecimal("1".repeat(DECIMAL_LIMITS.inputDigits + 1)),
    false,
  );
});

test("IMP-010A review B2: a backup row's sourceLabel over MAX_SOURCE_LABEL_LENGTH is truncated (display-only field, never rejects the row), matching app/price-upload-service.ts's sanitizeSourceLabel convention", () => {
  const overLong = "x".repeat(MAX_SOURCE_LABEL_LENGTH + 500);
  const result = validateUploadedPriceBackupRow(2, {
    providerId: "owner-import",
    sourceLabel: overLong,
    providerSymbol: "FMG",
    providerExchange: "ASX",
    currencyCode: "AUD",
    marketDate: "2020-01-01",
    priceDecimal: "1.00",
    observationAt: "2020-01-01T00:00:00.000Z",
    marketTimezone: "Australia/Sydney",
    interval: "eod",
    quality: "observed",
    adjustmentState: "raw",
    delayedMinutes: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.sourceLabel.length, MAX_SOURCE_LABEL_LENGTH);
  assert.equal(result.row.sourceLabel, "x".repeat(MAX_SOURCE_LABEL_LENGTH));
});

test("IMP-010A review B1: parsePriceBackupCsv's row/byte-limit-exceeded messages are actionable -- they name the actual configured limit, not a generic sentence", () => {
  const byteResult = parsePriceBackupCsv(bytesOf("x".repeat(100)), {
    maxBytes: 10,
    maxRows: 100,
  });
  assert.equal(byteResult.ok, false);
  if (!byteResult.ok) {
    assert.match(byteResult.message, /MiB size limit/);
    assert.match(byteResult.message, /Split the backup/);
  }

  const header =
    "format_version,provider_id,source_label,provider_symbol,provider_exchange,currency_code,market_date,price_decimal,observation_at,market_timezone,interval,quality,adjustment_state,delayed_minutes";
  const rows = Array.from(
    { length: 3 },
    (_, i) =>
      `${PRICE_BACKUP_FORMAT_VERSION},owner-import,intelligent-investor,FMG,ASX,AUD,2020-01-0${i + 1},1.00,2020-01-0${i + 1}T00:00:00.000Z,Australia/Sydney,eod,observed,raw,`,
  );
  const csv = [header, ...rows].join("\n") + "\n";
  const rowResult = parsePriceBackupCsv(bytesOf(csv), {
    maxBytes: 20 * 1024 * 1024,
    maxRows: 2,
  });
  assert.equal(rowResult.ok, false);
  if (!rowResult.ok) {
    assert.match(rowResult.message, /2-row limit/);
    assert.match(rowResult.message, /Split the backup/);
  }
});

// ---------------------------------------------------------------------------
// (3) Hostile uploaded-row payloads are rejected server-side, independent
// of whether a real browser ran the real parser.
// ---------------------------------------------------------------------------

test("IMP-010A hostile payload (single): a non-object payload is rejected", () => {
  const result = validateUploadedPriceCsvPayload("not an object");
  assert.equal(result.ok, false);
});

test("IMP-010A hostile payload (single): a missing/invalid ticker is rejected", () => {
  assert.equal(
    validateUploadedPriceCsvPayload({ ticker: 12345, rows: [] }).ok,
    false,
  );
  assert.equal(
    validateUploadedPriceCsvPayload({
      ticker: "<script>alert(1)</script>",
      rows: [],
    }).ok,
    false,
  );
  assert.equal(validateUploadedPriceCsvTicker("FMG"), "FMG");
  assert.equal(validateUploadedPriceCsvTicker("toolongtickerxx"), null);
  assert.equal(validateUploadedPriceCsvTicker(42), null);
});

test("IMP-010A hostile payload (single): rows must be an array", () => {
  const result = validateUploadedPriceCsvPayload({
    ticker: "FMG",
    rows: "DateTime,FMG\n1998-03-12,0.07852\n",
  });
  assert.equal(result.ok, false);
});

test("IMP-010A hostile payload (single): row count over the configured budget is rejected before per-row validation runs", () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    marketDate: `2020-01-0${i + 1}`,
    priceDecimal: "1.00",
  }));
  const result = validateUploadedPriceCsvPayload(
    { ticker: "FMG", rows },
    { maxBytes: 2 * 1024 * 1024, maxRows: 2 },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /row limit/);
});

test("IMP-010A hostile payload (single): wrong field types, a non-decimal price, and an invalid date are each rejected as their own malformed reason -- valid rows among them still parse", () => {
  const result = validateUploadedPriceCsvPayload({
    ticker: "FMG",
    rows: [
      { marketDate: "2020-01-01", priceDecimal: "12.34" }, // valid
      { marketDate: "2020-01-02", priceDecimal: 12.34 }, // wrong type (number, not string)
      { marketDate: 20200103, priceDecimal: "12.34" }, // wrong type (number, not string)
      { marketDate: "2020-01-04 00:00:00", priceDecimal: "12.34" }, // time suffix never allowed post-normalization
      { marketDate: "2020-02-30", priceDecimal: "12.34" }, // not a real calendar date
      { marketDate: "2020-01-06", priceDecimal: "-5" }, // not positive
      { marketDate: "2020-01-07", priceDecimal: "0" }, // zero is never a valid price
      { marketDate: "2020-01-08", priceDecimal: "abc" }, // not decimal grammar
      "not an object", // wrong shape entirely
      null,
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticker, "FMG");
  assert.deepEqual(result.rows, [
    { physicalRowNumber: 2, marketDate: "2020-01-01", priceDecimal: "12.34" },
  ]);
  assert.equal(result.malformed.length, 9);
  const reasons = result.malformed.map((row) => row.reason);
  assert.ok(reasons.includes("wrong_column_count"));
  assert.ok(reasons.includes("invalid_date"));
  assert.ok(reasons.includes("invalid_price"));
});

test("IMP-010A hostile payload (single): validateUploadedPriceCsvRow rejects an array/null candidate as wrong_column_count", () => {
  assert.equal(validateUploadedPriceCsvRow(2, []).ok, false);
  assert.equal(validateUploadedPriceCsvRow(2, null).ok, false);
  assert.equal(validateUploadedPriceCsvRow(2, "x").ok, false);
});

test("IMP-010A hostile payload (backup): a non-object payload, non-array rows, and an over-budget row count are each rejected", () => {
  assert.equal(validateUploadedPriceBackupPayload("nope").ok, false);
  assert.equal(validateUploadedPriceBackupPayload({ rows: "nope" }).ok, false);
  const rows = Array.from({ length: 3 }, () => ({}));
  const result = validateUploadedPriceBackupPayload(
    { rows },
    { maxBytes: 20 * 1024 * 1024, maxRows: 2 },
  );
  assert.equal(result.ok, false);
});

test("IMP-010A hostile payload (backup): every field is independently re-validated -- wrong types, unknown provider, invalid currency/date/price/instant, bad enum values, and bad delayedMinutes are each their own malformed reason", () => {
  const validRow = {
    providerId: "owner-import",
    sourceLabel: "intelligent-investor",
    providerSymbol: "FMG",
    providerExchange: "ASX",
    currencyCode: "AUD",
    marketDate: "2020-01-01",
    priceDecimal: "12.34",
    observationAt: "2019-12-31T13:00:00.000Z",
    marketTimezone: "Australia/Sydney",
    interval: "eod",
    quality: "observed",
    adjustmentState: "raw",
    delayedMinutes: null,
  };
  const cases: Array<[Partial<typeof validRow>, string]> = [
    [{ providerId: "not-a-real-provider" }, "unknown_provider"],
    [{ providerSymbol: "" }, "invalid_symbol_or_exchange"],
    [{ currencyCode: "AUDX" }, "invalid_currency"],
    [{ marketDate: "not-a-date" }, "invalid_date"],
    [{ priceDecimal: "-1" }, "invalid_price"],
    [{ observationAt: "not-an-instant" }, "invalid_observation_at"],
    [{ interval: "hourly" }, "invalid_quote_metadata"],
    [{ quality: "guessed" }, "invalid_quote_metadata"],
    [{ adjustmentState: "unknown" }, "invalid_quote_metadata"],
    [{ marketTimezone: "" }, "invalid_quote_metadata"],
  ];
  for (const [override, expectedReason] of cases) {
    const result = validateUploadedPriceBackupRow(2, {
      ...validRow,
      ...override,
    });
    assert.equal(
      result.ok,
      false,
      `expected ${JSON.stringify(override)} to fail`,
    );
    if (result.ok) continue;
    assert.equal(result.reason, expectedReason, JSON.stringify(override));
  }
  // Wrong TYPE (not just wrong value) on a string field.
  assert.equal(
    validateUploadedPriceBackupRow(2, { ...validRow, currencyCode: 36 }).ok,
    false,
  );
  // delayedMinutes: negative, non-integer, and wrong type are each rejected;
  // null and a valid non-negative integer are both accepted.
  assert.equal(
    validateUploadedPriceBackupRow(2, { ...validRow, delayedMinutes: -1 }).ok,
    false,
  );
  assert.equal(
    validateUploadedPriceBackupRow(2, { ...validRow, delayedMinutes: 1.5 }).ok,
    false,
  );
  assert.equal(
    validateUploadedPriceBackupRow(2, { ...validRow, delayedMinutes: "15" }).ok,
    false,
  );
  const okWithDelay = validateUploadedPriceBackupRow(2, {
    ...validRow,
    delayedMinutes: 15,
  });
  assert.equal(okWithDelay.ok, true);
  if (okWithDelay.ok) assert.equal(okWithDelay.row.delayedMinutes, 15);
  const okNoDelay = validateUploadedPriceBackupRow(2, validRow);
  assert.equal(okNoDelay.ok, true);
});

test("IMP-010A hostile payload (backup): sanitizeUploadedMalformedByReason drops unrecognised keys and non-negative-integer values, keeps the rest", () => {
  assert.deepEqual(sanitizeUploadedMalformedByReason("nope"), {});
  assert.deepEqual(sanitizeUploadedMalformedByReason(null), {});
  assert.deepEqual(
    sanitizeUploadedMalformedByReason({
      invalid_price: 3,
      unknown_provider: -1, // negative dropped
      invalid_date: 1.5, // non-integer dropped
      not_a_real_reason: 99, // unrecognised key dropped
      invalid_currency: "2", // wrong type dropped
    }),
    { invalid_price: 3 },
  );
});

// ---------------------------------------------------------------------------
// (4) Parser parity: the SAME fixture bytes normalize IDENTICALLY whether
// read straight off the parser or round-tripped through JSON (simulating
// the browser POSTing to the server).
// ---------------------------------------------------------------------------

const OWNER_FIXTURE_CSV =
  '"DateTime","FMG","divFlag"\n"1998-03-12 00:00:00",0.07852,,\n"1998-03-13 00:00:00",0.08,,\n';

test("IMP-010A parser parity (single, RFC-4180 fixture): direct parse vs JSON-round-tripped-then-server-revalidated produce identical ticker and rows", () => {
  const direct = parsePriceCsv(bytesOf(OWNER_FIXTURE_CSV));
  assert.equal(direct.ok, true);
  if (!direct.ok) return;

  const clientPayload = {
    ticker: direct.ticker,
    rows: direct.rows.map((row) => ({
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
    })),
  };
  // Simulate the wire: JSON.stringify then JSON.parse, exactly what a real
  // fetch POST + `request.json()` round trip does.
  const overWire = JSON.parse(JSON.stringify(clientPayload)) as unknown;
  const revalidated = validateUploadedPriceCsvPayload(
    overWire,
    DEFAULT_PRICE_CSV_LIMITS,
  );
  assert.equal(revalidated.ok, true);
  if (!revalidated.ok) return;
  assert.equal(revalidated.ticker, direct.ticker);
  assert.deepEqual(
    revalidated.rows.map((row) => ({
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
    })),
    direct.rows.map((row) => ({
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
    })),
  );
  assert.equal(revalidated.malformed.length, 0);
});

const UTF16_FIXTURE_UNITS = [
  ...[..."DateTime,FMG\n1998-03-12,0.07852\n"].map((char) =>
    char.charCodeAt(0),
  ),
];

function utf16leBytesOf(units: number[]): Uint8Array {
  const bytes = new Uint8Array(units.length * 2 + 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  units.forEach((unit, index) => {
    bytes[2 + index * 2] = unit & 0xff;
    bytes[2 + index * 2 + 1] = (unit >> 8) & 0xff;
  });
  return bytes;
}

test("IMP-010A parser parity (single, UTF-16LE-with-BOM fixture): direct parse vs JSON round trip stay identical", () => {
  const direct = parsePriceCsv(utf16leBytesOf(UTF16_FIXTURE_UNITS));
  assert.equal(direct.ok, true);
  if (!direct.ok) return;
  const overWire = JSON.parse(
    JSON.stringify({
      ticker: direct.ticker,
      rows: direct.rows.map((row) => ({
        marketDate: row.marketDate,
        priceDecimal: row.priceDecimal,
      })),
    }),
  ) as unknown;
  const revalidated = validateUploadedPriceCsvPayload(overWire);
  assert.equal(revalidated.ok, true);
  if (!revalidated.ok) return;
  assert.deepEqual(revalidated.rows, [
    { physicalRowNumber: 2, marketDate: "1998-03-12", priceDecimal: "0.07852" },
  ]);
});

test("IMP-010A parser parity (backup): direct parse vs JSON round trip stay identical, including malformed-reason classification", () => {
  const header =
    "format_version,provider_id,source_label,provider_symbol,provider_exchange,currency_code,market_date,price_decimal,observation_at,market_timezone,interval,quality,adjustment_state,delayed_minutes";
  const rows = [
    `${PRICE_BACKUP_FORMAT_VERSION},owner-import,intelligent-investor,FMG,ASX,AUD,1998-03-12,0.07852,1998-03-11T13:00:00.000Z,Australia/Sydney,eod,observed,raw,`,
    `${PRICE_BACKUP_FORMAT_VERSION},owner-import,intelligent-investor,FMG,ASX,AUD,1998-03-13,-1,1998-03-12T13:00:00.000Z,Australia/Sydney,eod,observed,raw,`,
  ];
  const csv = [header, ...rows].join("\n") + "\n";
  const direct = parsePriceBackupCsv(bytesOf(csv));
  assert.equal(direct.ok, true);
  if (!direct.ok) return;
  assert.equal(direct.rows.length, 1);
  assert.equal(direct.malformed.length, 1);
  assert.equal(direct.malformed[0]!.reason, "invalid_price");

  const clientPayload = {
    rows: direct.rows.map((row) => ({
      providerId: row.providerId,
      sourceLabel: row.sourceLabel,
      providerSymbol: row.providerSymbol,
      providerExchange: row.providerExchange,
      currencyCode: row.currencyCode,
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
      observationAt: row.observationAt,
      marketTimezone: row.marketTimezone,
      interval: row.interval,
      quality: row.quality,
      adjustmentState: row.adjustmentState,
      delayedMinutes: row.delayedMinutes,
    })),
  };
  const overWire = JSON.parse(JSON.stringify(clientPayload)) as unknown;
  const revalidated = validateUploadedPriceBackupPayload(
    overWire,
    DEFAULT_PRICE_BACKUP_LIMITS,
  );
  assert.equal(revalidated.ok, true);
  if (!revalidated.ok) return;
  assert.equal(revalidated.rows.length, 1);
  assert.equal(revalidated.rows[0]!.marketDate, "1998-03-12");
  assert.equal(revalidated.malformed.length, 0);
});

// ---------------------------------------------------------------------------
// (5) Digest/idempotency finding: no file-level digest exists for this path
// today (verified by reading `db/repositories/price-uploads.ts`) -- pinned
// here at the DB level so a future change that starts writing one is a
// visible, deliberate decision, not an accidental drift from this task's
// documented finding.
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

test("IMP-010A digest finding: owner-import price_observations rows carry NO payload_sha256 -- idempotency for this path is the natural-key upsert, never a file-level content hash, so IMP-010A's browser-parse move preserves re-upload dedup by construction", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Fortescue', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'FMG', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const context: PriceUploadContext = { client, userId: "user-a" };
  const result = await confirmSinglePriceUpload(
    context,
    {
      ticker: "FMG",
      rows: [{ marketDate: "1998-03-12", priceDecimal: "0.07852" }],
    },
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-25T00:00:00.000Z",
  );
  assert.equal(result.ok, true);
  const row = db
    .prepare(
      `SELECT payload_sha256 FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { payload_sha256: string | null };
  assert.equal(row.payload_sha256, null);
});

// ---------------------------------------------------------------------------
// Sanity: the shared grammar module both formats now import from.
// ---------------------------------------------------------------------------

test("IMP-010A shared grammar: isPositiveDecimal/isValidMarketDate reject the expected hostile shapes", () => {
  assert.equal(isPositiveDecimal("12.34"), true);
  assert.equal(isPositiveDecimal("0"), false);
  assert.equal(isPositiveDecimal("-1"), false);
  assert.equal(isPositiveDecimal("01"), false);
  assert.equal(isPositiveDecimal("abc"), false);
  assert.equal(isValidMarketDate("2020-01-01"), true);
  assert.equal(isValidMarketDate("2020-02-30"), false);
  assert.equal(isValidMarketDate("2020-01-01 00:00:00"), false);
  assert.equal(isValidMarketDate("not-a-date"), false);
});
