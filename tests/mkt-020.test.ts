/**
 * MKT-020 — OHLCV price-CSV format variant, auto-detected by header
 * (owner-directed, close-only storage per the owner's binding ruling).
 *
 * Covers: `domain/market-data/price-csv.ts` (the OHLCV variant's exact
 * header-signature auto-detection, "24 Aug 2026"-style date parsing with
 * the full month table and honest rejection of invalid/ambiguous/mis-cased
 * forms, `$`-strip against the SHARED existing price grammar including
 * thousands-separator rejection, ignored OHLCV/Movement columns, and
 * filename-derived ticker via the established `ASX-<TICKER>.csv`
 * convention); `app/price-upload-service.ts` (the owner's verbatim sample
 * end-to-end through preview/confirm on a migrated D1-shaped schema, and
 * client/server parity -- the SAME row-validation functions the original
 * format already used, never a fork); and EFF-001 interplay (delta-upload/
 * no-data-omission/downsampling all operate on the variant's normalized
 * rows exactly as they do for the original format).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR,
  downsamplePriceCsvRows,
  filterRowsAlreadyPresent,
  parsePriceCsv,
  validateUploadedPriceCsvPayload,
} from "../domain/market-data/price-csv.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";
import {
  confirmSinglePriceUpload,
  previewSinglePriceUpload,
  type PriceUploadContext,
} from "../app/price-upload-service.ts";
import { iiDownloadFilename } from "../app/price-history-coverage-format.ts";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// The owner's sample, verbatim (TASKS.md MKT-020).
const OWNER_HEADER =
  '"Date","Open","High","Low","Close","Volume","Daily Movement","Daily Movement (Percent)"';
const OWNER_ROW =
  '"24 Aug 2026","$21.15","$21.68","$21.11","$21.44","2,420,147","0.29","1.37%"';
const OWNER_SAMPLE_CSV = `${OWNER_HEADER}\n${OWNER_ROW}\n`;

// ---------------------------------------------------------------------------
// (1) Header autodetection: both formats + unknown header.
// ---------------------------------------------------------------------------

test("MKT-020 autodetect: the exact OHLCV header signature routes to the new variant", () => {
  const result = parsePriceCsv(
    bytesOf(OWNER_SAMPLE_CSV),
    undefined,
    "ASX-FMG.csv",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticker, "FMG");
  assert.deepEqual(result.rows, [
    { physicalRowNumber: 2, marketDate: "2026-08-24", priceDecimal: "21.44" },
  ]);
  assert.equal(result.malformed.length, 0);
});

test("MKT-020 autodetect: the original DateTime,<TICKER> header is completely untouched", () => {
  const result = parsePriceCsv(bytesOf("DateTime,FMG\n1998-03-12,0.07852\n"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticker, "FMG");
  assert.equal(result.rows[0]?.marketDate, "1998-03-12");
});

test("MKT-020 autodetect: a header that merely resembles the OHLCV signature (missing a column) is NOT matched -- falls through to the original format's own honest MISSING_HEADER error", () => {
  const result = parsePriceCsv(
    bytesOf(
      '"Date","Open","High","Low","Close","Volume","Daily Movement"\n"24 Aug 2026","$21.15","$21.68","$21.11","$21.44","2,420,147","0.29"\n',
    ),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "MISSING_HEADER");
});

test("MKT-020 autodetect: a genuinely unrecognised header keeps the current honest error, unaffected by the new variant", () => {
  const result = parsePriceCsv(bytesOf("Foo,Bar\n1,2\n"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "MISSING_HEADER");
});

// Review fold A: boundary pins the reviewer flagged as silently flippable
// -- detection is an EXACT column-name-and-order signature, not a fuzzy
// match, and quoting is genuinely optional (checked AFTER the shared
// quote-stripping split), so these all deserve their own explicit pin.

test("MKT-020 autodetect (fold A): a header with the SAME 8 column names but a DIFFERENT order is not matched -- falls through to MISSING_HEADER", () => {
  const reordered =
    '"Date","Close","Open","High","Low","Volume","Daily Movement","Daily Movement (Percent)"\n' +
    '"24 Aug 2026","$21.44","$21.15","$21.68","$21.11","2,420,147","0.29","1.37%"\n';
  const result = parsePriceCsv(bytesOf(reordered));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "MISSING_HEADER");
});

test("MKT-020 autodetect (fold A): a header with an EXTRA column beyond the 8-name signature is not matched -- falls through to MISSING_HEADER", () => {
  const extraColumn =
    '"Date","Open","High","Low","Close","Volume","Daily Movement","Daily Movement (Percent)","Extra"\n' +
    '"24 Aug 2026","$21.15","$21.68","$21.11","$21.44","2,420,147","0.29","1.37%","x"\n';
  const result = parsePriceCsv(bytesOf(extraColumn));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "MISSING_HEADER");
});

test('MKT-020 autodetect (fold A): a header with a CASE-CHANGED column name ("close" not "Close") is not matched -- falls through to MISSING_HEADER', () => {
  const caseChanged =
    '"Date","Open","High","Low","close","Volume","Daily Movement","Daily Movement (Percent)"\n' +
    '"24 Aug 2026","$21.15","$21.68","$21.11","$21.44","2,420,147","0.29","1.37%"\n';
  const result = parsePriceCsv(bytesOf(caseChanged));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "MISSING_HEADER");
});

test("MKT-020 autodetect (fold A): the SAME 8 column names, UNQUOTED, are accepted -- detection runs after the shared quote-stripping split, so quoting is optional", () => {
  const unquoted =
    "Date,Open,High,Low,Close,Volume,Daily Movement,Daily Movement (Percent)\n" +
    "24 Aug 2026,$21.15,$21.68,$21.11,$21.44,2420147,0.29,1.37%\n";
  const result = parsePriceCsv(bytesOf(unquoted), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticker, "FMG");
  assert.deepEqual(result.rows, [
    { physicalRowNumber: 2, marketDate: "2026-08-24", priceDecimal: "21.44" },
  ]);
  assert.equal(result.malformed.length, 0);
});

// ---------------------------------------------------------------------------
// (2) Date parsing: all 12 month abbreviations, invalid/ambiguous forms.
// ---------------------------------------------------------------------------

const MONTH_FIXTURES: ReadonlyArray<[abbrev: string, iso: string]> = [
  ["Jan", "2026-01-05"],
  ["Feb", "2026-02-05"],
  ["Mar", "2026-03-05"],
  ["Apr", "2026-04-05"],
  ["May", "2026-05-05"],
  ["Jun", "2026-06-05"],
  ["Jul", "2026-07-05"],
  ["Aug", "2026-08-05"],
  ["Sep", "2026-09-05"],
  ["Oct", "2026-10-05"],
  ["Nov", "2026-11-05"],
  ["Dec", "2026-12-05"],
];

function ohlcvRowOf(dateText: string, close = "$10.00"): string {
  return `"${dateText}","$1.00","$1.00","$1.00","${close}","1","0.00","0.00%"`;
}

test("MKT-020 date grammar: all 12 month abbreviations parse to the correct YYYY-MM-DD", () => {
  const csv =
    OWNER_HEADER +
    "\n" +
    MONTH_FIXTURES.map(([abbrev]) => ohlcvRowOf(`5 ${abbrev} 2026`)).join(
      "\n",
    ) +
    "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.malformed.length, 0);
  assert.deepEqual(
    result.rows.map((row) => row.marketDate),
    MONTH_FIXTURES.map(([, iso]) => iso),
  );
});

test("MKT-020 date grammar: invalid/ambiguous forms are all honestly rejected as invalid_date, never silently coerced", () => {
  const invalidDates = [
    "32 Aug 2026", // no such day
    "30 Feb 2026", // no such calendar date
    "24 Xxx 2026", // unrecognised month abbreviation
    "24 Aug 26", // 2-digit year -- genuinely ambiguous, never guessed
    "24 AUG 2026", // case variant -- exact Title-case table only
    "24 aug 2026", // case variant
  ];
  const csv =
    OWNER_HEADER +
    "\n" +
    invalidDates.map((date) => ohlcvRowOf(date)).join("\n") +
    "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows.length, 0);
  assert.deepEqual(
    result.malformed.map((row) => row.reason),
    invalidDates.map(() => "invalid_date"),
  );
});

test("MKT-020 date grammar (fold A): a leading-zero day and an un-padded single-digit day both resolve to the SAME YYYY-MM-DD -- day-width is not significant", () => {
  const csv =
    OWNER_HEADER +
    "\n" +
    ohlcvRowOf("05 Aug 2026") +
    "\n" +
    ohlcvRowOf("5 Aug 2026") +
    "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.malformed.length, 0);
  assert.deepEqual(
    result.rows.map((row) => row.marketDate),
    ["2026-08-05", "2026-08-05"],
  );
});

// ---------------------------------------------------------------------------
// (3) $-strip + shared price grammar.
// ---------------------------------------------------------------------------

test("MKT-020 close grammar: leading $ is stripped and the result must satisfy the EXISTING price grammar", () => {
  const csv = OWNER_HEADER + "\n" + ohlcvRowOf("24 Aug 2026", "$21.44") + "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.priceDecimal, "21.44");
});

test("MKT-020 close grammar (fold A): a Close cell with NO leading $ is still accepted -- the $ strip is optional, the grammar check is what actually gates validity", () => {
  const csv = OWNER_HEADER + "\n" + ohlcvRowOf("24 Aug 2026", "21.44") + "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.malformed.length, 0);
  assert.equal(result.rows[0]?.priceDecimal, "21.44");
});

test("MKT-020 close grammar: $0.00 and a blank close cell both fall into the EXISTING no_data classification, never invalid_price", () => {
  const csv =
    OWNER_HEADER +
    "\n" +
    ohlcvRowOf("24 Aug 2026", "$0.00") +
    "\n" +
    ohlcvRowOf("25 Aug 2026", "") +
    "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows.length, 0);
  assert.deepEqual(
    result.malformed.map((row) => row.reason),
    ["no_data", "no_data"],
  );
});

test("MKT-020 close grammar: a thousands separator inside Close is REJECTED as invalid_price, not silently accepted (the owner's sample shows separators only in Volume)", () => {
  const csv =
    OWNER_HEADER + "\n" + ohlcvRowOf("24 Aug 2026", "$1,234.56") + "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows.length, 0);
  assert.deepEqual(
    result.malformed.map((row) => row.reason),
    ["invalid_price"],
  );
});

test("MKT-020 close grammar: garbage in Close (non-decimal) is invalid_price", () => {
  const csv = OWNER_HEADER + "\n" + ohlcvRowOf("24 Aug 2026", "$N/A") + "\n";
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.malformed.map((row) => row.reason),
    ["invalid_price"],
  );
});

// ---------------------------------------------------------------------------
// (4) Ignored columns.
// ---------------------------------------------------------------------------

test("MKT-020 ignored columns: Open/High/Low/Volume/Daily Movement/Daily Movement (Percent) never affect parsing, even when garbage", () => {
  // Close (column 5) stays valid; every OTHER column is deliberately
  // garbage -- must have no bearing on the row's outcome.
  const garbageRow =
    '"24 Aug 2026","not-a-number","also bad","","$21.44","not,a,number","-99.9","garbage%"';
  const csv = `${OWNER_HEADER}\n${garbageRow}\n`;
  const result = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.malformed.length, 0);
  assert.equal(result.rows[0]?.priceDecimal, "21.44");
});

// ---------------------------------------------------------------------------
// (5) Ticker from filename (ASX-<TICKER>.csv convention).
// ---------------------------------------------------------------------------

test("MKT-020 filename ticker: matches the ASX-<TICKER>.csv convention, case-insensitive on the ASX-/.csv parts, ticker text preserved as-written", () => {
  const csv = OWNER_SAMPLE_CSV;
  const upper = parsePriceCsv(bytesOf(csv), undefined, "ASX-BHP.csv");
  assert.equal(upper.ok, true);
  if (upper.ok) assert.equal(upper.ticker, "BHP");

  const lowerExtension = parsePriceCsv(bytesOf(csv), undefined, "ASX-bhp.CSV");
  assert.equal(lowerExtension.ok, true);
  if (lowerExtension.ok) assert.equal(lowerExtension.ticker, "bhp");
});

test("MKT-020 filename ticker: this module's own generated download filename (iiDownloadFilename) round-trips through the new variant's ticker derivation", () => {
  const filename = iiDownloadFilename("fmg");
  assert.equal(filename, "ASX-FMG.csv");
  const result = parsePriceCsv(bytesOf(OWNER_SAMPLE_CSV), undefined, filename);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.ticker, "FMG");
});

test("MKT-020 filename ticker: a missing or non-conforming filename is an honest TICKER_INVALID error, never a guessed ticker", () => {
  const noFilename = parsePriceCsv(bytesOf(OWNER_SAMPLE_CSV));
  assert.equal(noFilename.ok, false);
  if (!noFilename.ok) assert.equal(noFilename.code, "TICKER_INVALID");

  const wrongShape = parsePriceCsv(
    bytesOf(OWNER_SAMPLE_CSV),
    undefined,
    "prices-export.csv",
  );
  assert.equal(wrongShape.ok, false);
  if (!wrongShape.ok) assert.equal(wrongShape.code, "TICKER_INVALID");
});

// Review fold B: the guided MKT-018B download flow routinely produces a
// browser duplicate-download suffix (" (1)", " (2)", ...) on a re-download
// of the same ticker's export -- this is real, common owner-workflow
// output, not a hostile/unusual filename shape, so it must be tolerated.

test("MKT-020 filename ticker (fold B): a single trailing browser duplicate-download suffix is tolerated and discarded -- ASX-SHL (1).csv -> SHL", () => {
  const result = parsePriceCsv(
    bytesOf(OWNER_SAMPLE_CSV),
    undefined,
    "ASX-SHL (1).csv",
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.ticker, "SHL");
});

test("MKT-020 filename ticker (fold B): only ONE trailing suffix is tolerated -- a doubled suffix (ASX-SHL (1) (2).csv) is rejected, kept deliberately tight", () => {
  const result = parsePriceCsv(
    bytesOf(OWNER_SAMPLE_CSV),
    undefined,
    "ASX-SHL (1) (2).csv",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TICKER_INVALID");
});

test('MKT-020 filename ticker (fold B): a filename that never carried the ASX- prefix at all (a browser\'s own "download (1).csv" default) stays honestly rejected, never mistaken for a duplicate-download of an ASX ticker', () => {
  const result = parsePriceCsv(
    bytesOf(OWNER_SAMPLE_CSV),
    undefined,
    "download (1).csv",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TICKER_INVALID");
});

// ---------------------------------------------------------------------------
// (6) Owner's verbatim sample end-to-end through preview/confirm on a
// migrated DB, and client/server parity.
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

async function ownedFixture(): Promise<DatabaseSync> {
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
  return db;
}

function context(client: SqlClient, userId: string): PriceUploadContext {
  return { client, userId };
}

/** Mirrors `historical-data-panel.tsx`'s `parseSingleCsvFile` exactly --
 * runs the SAME shared parser a real browser upload would, then shapes its
 * output into the JSON payload a real upload POSTs, so this end-to-end test
 * exercises the real parser, not a hand-written stand-in. */
function ohlcvPayloadOf(
  text: string,
  filename: string,
): {
  ticker: string;
  rows: Array<{ marketDate: string; priceDecimal: string }>;
  malformedCount: number;
} {
  const parsed = parsePriceCsv(bytesOf(text), undefined, filename);
  if (!parsed.ok) {
    throw new Error(`test fixture CSV failed to parse: ${parsed.message}`);
  }
  return {
    ticker: parsed.ticker,
    rows: parsed.rows.map((row) => ({
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
    })),
    malformedCount: parsed.malformed.length,
  };
}

test("MKT-020 end-to-end: the owner's VERBATIM sample previews and confirms against a migrated DB, matching the held FMG security", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const payload = ohlcvPayloadOf(OWNER_SAMPLE_CSV, "ASX-FMG.csv");
  assert.equal(payload.ticker, "FMG");
  assert.deepEqual(payload.rows, [
    { marketDate: "2026-08-24", priceDecimal: "21.44" },
  ]);

  const preview = await previewSinglePriceUpload(
    context(client, "user-a"),
    payload,
    { exchangeAlias: "ASX", currencyCode: "AUD" },
  );
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.preview.matchedSecurityId, "security-a");
  assert.equal(preview.preview.matchedName, "Fortescue");
  assert.equal(preview.preview.rowCount, 1);
  assert.equal(preview.preview.malformedCount, 0);
  assert.equal(preview.preview.dateFrom, "2026-08-24");

  const confirmed = await confirmSinglePriceUpload(
    context(client, "user-a"),
    payload,
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "ASX-FMG.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-25T00:00:00.000Z",
  );
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  assert.equal(confirmed.value.written, 1);

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal FROM price_observations WHERE security_id = 'security-a'`,
    )
    .all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.market_date, "2026-08-24");
  assert.equal(rows[0]!.close_decimal, "21.44");
});

test("MKT-020 parity: the server's untrusted-payload re-validator accepts OHLCV-derived rows through the SAME shared validation the original format uses -- no fork", () => {
  const payload = ohlcvPayloadOf(OWNER_SAMPLE_CSV, "ASX-FMG.csv");
  const revalidated = validateUploadedPriceCsvPayload(payload);
  assert.equal(revalidated.ok, true);
  if (!revalidated.ok) return;
  assert.equal(revalidated.ticker, "FMG");
  assert.deepEqual(revalidated.rows, [
    { physicalRowNumber: 2, marketDate: "2026-08-24", priceDecimal: "21.44" },
  ]);
  assert.equal(revalidated.malformed.length, 0);
});

test("MKT-020 parity: a hostile payload claiming an OHLCV-shaped ticker but a malformed row is rejected row-by-row, exactly as the original format's hostile payloads are", () => {
  const revalidated = validateUploadedPriceCsvPayload({
    ticker: "FMG",
    rows: [
      { marketDate: "2026-08-24", priceDecimal: "21.44" },
      { marketDate: "2026-08-25", priceDecimal: "1,234.56" }, // thousands separator, hostile
      { marketDate: "not-a-date", priceDecimal: "1.00" },
    ],
  });
  assert.equal(revalidated.ok, true);
  if (!revalidated.ok) return;
  assert.equal(revalidated.rows.length, 1);
  assert.deepEqual(
    revalidated.malformed.map((row) => row.reason),
    ["invalid_price", "invalid_date"],
  );
});

// ---------------------------------------------------------------------------
// (7) EFF-001 interplay: delta-upload / no-data omission / downsampling all
// operate on the OHLCV variant's normalized rows exactly as before, since
// none of them re-parse or care about the source CSV's original shape.
// ---------------------------------------------------------------------------

test("MKT-020 x EFF-001: no-data rows are already excluded from `rows` before downsample/delta-filter ever run (same as the original format)", () => {
  const csv =
    OWNER_HEADER +
    "\n" +
    ohlcvRowOf("24 Aug 2026", "$21.44") +
    "\n" +
    ohlcvRowOf("25 Aug 2026", "$0.00") + // no_data
    "\n";
  const parsed = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.rows.length, 1);
  assert.equal(
    parsed.malformed.filter((row) => row.reason === "no_data").length,
    1,
  );
});

test("MKT-020 x EFF-001: downsamplePriceCsvRows keeps one row per pre-boundary month and every on/after-boundary row, over OHLCV-parsed rows", () => {
  const rows = [
    { dateText: "5 Jan 2010" },
    { dateText: "20 Jan 2010" }, // same month as above -- later wins
    { dateText: "5 Feb 2010" },
    { dateText: `5 Jan ${DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR}` },
    { dateText: `6 Jan ${DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR}` }, // on/after boundary -- both kept
  ];
  const csv =
    OWNER_HEADER +
    "\n" +
    rows.map((row) => ohlcvRowOf(row.dateText, "$5.00")).join("\n") +
    "\n";
  const parsed = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const downsampled = downsamplePriceCsvRows(parsed.rows, {
    boundaryYear: DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR,
  });
  assert.deepEqual(
    downsampled.rows.map((row) => row.marketDate),
    [
      "2010-01-20",
      "2010-02-05",
      `${DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR}-01-05`,
      `${DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR}-01-06`,
    ],
  );
  assert.equal(downsampled.droppedCount, 1);
});

test("MKT-020 x EFF-001: filterRowsAlreadyPresent drops exact (date, price) duplicates but keeps a CORRECTED price for an already-covered date, over OHLCV-parsed rows", () => {
  const csv =
    OWNER_HEADER +
    "\n" +
    ohlcvRowOf("24 Aug 2026", "$21.44") +
    "\n" +
    ohlcvRowOf("25 Aug 2026", "$22.00") +
    "\n";
  const parsed = parsePriceCsv(bytesOf(csv), undefined, "ASX-FMG.csv");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const existing = [
    { marketDate: "2026-08-24", closeDecimal: "21.44" }, // identical -- dropped
    { marketDate: "2026-08-25", closeDecimal: "21.90" }, // corrected price -- kept
  ];
  const filtered = filterRowsAlreadyPresent(parsed.rows, existing);
  assert.equal(filtered.identicalCount, 1);
  assert.deepEqual(
    filtered.rows.map((row) => row.marketDate),
    ["2026-08-25"],
  );
});
