/**
 * EFF-001 — D1 write-budget efficiency for price-history CSV imports
 * (owner-directed measures 2, 3, 4, 5; measure 1 -- a holding-window
 * default -- was explicitly rejected by the owner: "I want to keep the
 * option open of having a useful database that can be shared").
 *
 * Covers: `domain/market-data/price-value-grammar.ts` (`isNoDataPriceCell`);
 * `domain/market-data/price-csv.ts` (the `no_data` malformed reason,
 * `downsamplePriceCsvRows`, `filterRowsAlreadyPresent`);
 * `db/repositories/price-uploads.ts`
 * (`loadOwnerImportPriceObservationsForSecurity`, the identical-value
 * `WHERE` guard on `writePriceUploadObservations`, and its
 * `unchangedCount`/`mappingMissingCount` distinction); `app/price-upload-service.ts`
 * (`previewSinglePriceUpload`'s delta-upload fields -- including the review
 * B1 fix, comparing VALUE not just date, so a corrected price on an
 * already-covered date is never dropped -- and `confirmSinglePriceUpload`'s
 * `unchangedCount`); `app/price-history-coverage-format.ts`
 * (`classifyPriceHistoryCoverage` is spacing-blind, confirmed both as a
 * pure-function claim and against a real sparse-history fixture); and
 * `app/price-history-chart-geometry.ts` (the UI-018 chart renders sparse
 * mixed-cadence history without error -- the documented, non-blocking gap-
 * dashing cosmetic limitation is pinned as OBSERVED behaviour, not assumed).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isNoDataPriceCell } from "../domain/market-data/price-value-grammar.ts";
import {
  DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR,
  downsamplePriceCsvRows,
  filterRowsAlreadyPresent,
  parsePriceCsv,
  type PriceCsvDataRow,
} from "../domain/market-data/price-csv.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";
import {
  createPriceUploadBatch,
  loadOwnerImportPriceObservationsForSecurity,
  OWNER_IMPORT_PROVIDER_ID,
  writePriceUploadObservations,
  type PriceUploadWriteCandidate,
} from "../db/repositories/price-uploads.ts";
import {
  confirmSinglePriceUpload,
  previewSinglePriceUpload,
  type PriceUploadContext,
} from "../app/price-upload-service.ts";
import { loadOwnedPriceHistoryCoverage } from "../app/price-history-coverage.ts";
import { classifyPriceHistoryCoverage } from "../app/price-history-coverage-format.ts";
import {
  classifyPriceHistorySegments,
  scalePriceHistoryPoints,
  type ChartInputPoint,
} from "../app/price-history-chart-geometry.ts";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// (1) domain/market-data/price-value-grammar.ts + price-csv.ts -- measure 4.
// ---------------------------------------------------------------------------

test("EFF-001 (4) isNoDataPriceCell: blank and zero forms are no-data; garbage/negative values are not", () => {
  assert.equal(isNoDataPriceCell(""), true);
  assert.equal(isNoDataPriceCell("0"), true);
  assert.equal(isNoDataPriceCell("0.00"), true);
  assert.equal(isNoDataPriceCell("0.0000"), true);
  assert.equal(isNoDataPriceCell("  "), true); // whitespace-only trims to blank
  assert.equal(isNoDataPriceCell("1.00"), false);
  assert.equal(isNoDataPriceCell("0.01"), false);
  assert.equal(isNoDataPriceCell("-1"), false);
  assert.equal(isNoDataPriceCell("abc"), false);
  assert.equal(isNoDataPriceCell("N/A"), false);
});

test("EFF-001 (4) parsePriceCsv: blank/zero price cells classify as no_data, distinct from garbage invalid_price rows", () => {
  const csv =
    "DateTime,FMG\n" +
    "2018-01-05,1.40\n" + // valid
    "2018-01-06,\n" + // blank -> no_data
    "2018-01-07,0\n" + // zero -> no_data
    "2018-01-08,0.00\n" + // zero (decimal) -> no_data
    "2018-01-09,-1\n" + // garbage (negative) -> invalid_price
    "2018-01-10,abc\n"; // garbage (non-numeric) -> invalid_price
  const parsed = parsePriceCsv(bytesOf(csv));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(
    parsed.rows.map((row) => row.marketDate),
    ["2018-01-05"],
  );
  const byReason = new Map<string, number>();
  for (const row of parsed.malformed) {
    byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
  }
  assert.equal(byReason.get("no_data"), 3);
  assert.equal(byReason.get("invalid_price"), 2);
});

// ---------------------------------------------------------------------------
// (2) domain/market-data/price-csv.ts -- measure 5, downsampling.
// ---------------------------------------------------------------------------

function rowOf(marketDate: string, priceDecimal: string): PriceCsvDataRow {
  return { physicalRowNumber: 0, marketDate, priceDecimal };
}

test("EFF-001 (5) downsamplePriceCsvRows: keeps the LAST trading observation per calendar month before the boundary, daily on/after it", () => {
  const rows = [
    rowOf("2016-01-15", "1.00"),
    rowOf("2016-01-31", "1.10"), // later date in the same month wins
    rowOf("2016-02-10", "1.20"),
    rowOf("2017-12-30", "1.30"),
    rowOf("2018-01-05", "1.40"), // on-boundary: stays
    rowOf("2018-02-01", "1.50"), // after-boundary: stays
  ];
  const result = downsamplePriceCsvRows(rows, {
    boundaryYear: DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR,
  });
  assert.equal(DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR, 2018);
  assert.deepEqual(
    result.rows.map((row) => [row.marketDate, row.priceDecimal]),
    [
      ["2016-01-31", "1.10"], // 2016-01-15 dropped -- 01-31 is later
      ["2016-02-10", "1.20"],
      ["2017-12-30", "1.30"],
      ["2018-01-05", "1.40"],
      ["2018-02-01", "1.50"],
    ],
  );
  assert.equal(result.droppedCount, 1);
});

test("EFF-001 (5) downsamplePriceCsvRows: boundary year is configurable per import", () => {
  const rows = [
    rowOf("2018-01-05", "1.40"),
    rowOf("2018-06-15", "1.45"),
    rowOf("2018-06-30", "1.46"),
    rowOf("2019-03-01", "1.50"),
  ];
  // Boundary 2020: everything above is now BEFORE the boundary, so June
  // 2018's two rows collapse to one (the later date).
  const result = downsamplePriceCsvRows(rows, { boundaryYear: 2020 });
  assert.deepEqual(
    result.rows.map((row) => row.marketDate),
    ["2018-01-05", "2018-06-30", "2019-03-01"],
  );
  assert.equal(result.droppedCount, 1);
});

test("EFF-001 (5) downsamplePriceCsvRows: a no-op (droppedCount 0) when every row is already on/after the boundary or input is empty", () => {
  const rows = [rowOf("2020-01-01", "1.00"), rowOf("2020-01-02", "1.01")];
  const result = downsamplePriceCsvRows(rows, { boundaryYear: 2018 });
  assert.deepEqual(result.rows, rows);
  assert.equal(result.droppedCount, 0);

  const empty = downsamplePriceCsvRows([], { boundaryYear: 2018 });
  assert.deepEqual(empty, { rows: [], droppedCount: 0 });
});

test("EFF-001 (5) downsamplePriceCsvRows: order-independent -- input need not be pre-sorted", () => {
  const rows = [
    rowOf("2016-01-31", "1.10"),
    rowOf("2016-01-15", "1.00"),
    rowOf("2016-02-10", "1.20"),
  ];
  const result = downsamplePriceCsvRows(rows, { boundaryYear: 2018 });
  assert.deepEqual(
    result.rows.map((row) => row.marketDate),
    ["2016-01-31", "2016-02-10"],
  );
});

// ---------------------------------------------------------------------------
// DB fixtures shared by the repository/service-level tests below.
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
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1),
           ('user-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
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

function candidateFor(
  marketDate: string,
  priceDecimal: string,
): PriceUploadWriteCandidate {
  return {
    providerId: OWNER_IMPORT_PROVIDER_ID,
    securityId: "security-a",
    providerExchange: "ASX",
    providerSymbol: "FMG",
    currencyCode: "AUD",
    marketDate,
    priceDecimal,
    observationAt: `${marketDate}T00:00:00.000Z`,
    marketTimezone: "Australia/Sydney",
    interval: "eod",
    quality: "observed",
    adjustmentState: "raw",
    delayedMinutes: null,
  };
}

// ---------------------------------------------------------------------------
// (3) db/repositories/price-uploads.ts -- measure 3, identical-value writes.
// ---------------------------------------------------------------------------

test("EFF-001 (3) writePriceUploadObservations: a re-upload with byte-identical values performs NO write at all (ingested_at untouched)", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  await createPriceUploadBatch(client, {
    id: "batch-1",
    userId: "user-a",
    sourceLabel: "x",
    format: "single",
    filename: "f.csv",
    rowCount: 1,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  const candidate = candidateFor("1998-03-12", "0.07852");

  const first = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidate],
    now: "2026-08-20T00:00:00.000Z",
  });
  assert.deepEqual(first, {
    written: 1,
    insertedCount: 1,
    unchangedCount: 0,
    mappingMissingCount: 0,
  });

  const before = db
    .prepare(
      `SELECT ingested_at, close_decimal FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { ingested_at: string; close_decimal: string };

  // Second write: SAME candidate, but a DIFFERENT `now` -- if any write
  // happened at all, `ingested_at` would move.
  const second = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidate],
    now: "2026-08-21T00:00:00.000Z",
  });
  assert.deepEqual(second, {
    written: 0,
    insertedCount: 0,
    unchangedCount: 1,
    mappingMissingCount: 0,
  });

  const after = db
    .prepare(
      `SELECT ingested_at, close_decimal FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { ingested_at: string; close_decimal: string };
  assert.deepEqual(after, before);
  assert.equal(after.ingested_at, "2026-08-20T00:00:00.000Z");
});

test("EFF-001 (3) writePriceUploadObservations: a genuinely CHANGED value still writes normally", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  await createPriceUploadBatch(client, {
    id: "batch-1",
    userId: "user-a",
    sourceLabel: "x",
    format: "single",
    filename: "f.csv",
    rowCount: 1,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidateFor("1998-03-12", "0.07852")],
    now: "2026-08-20T00:00:00.000Z",
  });
  const changed = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidateFor("1998-03-12", "0.09")],
    now: "2026-08-22T00:00:00.000Z",
  });
  assert.deepEqual(changed, {
    written: 1,
    insertedCount: 0,
    unchangedCount: 0,
    mappingMissingCount: 0,
  });
  const row = db
    .prepare(
      `SELECT ingested_at, close_decimal FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { ingested_at: string; close_decimal: string };
  assert.equal(row.close_decimal, "0.09");
  assert.equal(row.ingested_at, "2026-08-22T00:00:00.000Z");
});

test("EFF-001 (3) writePriceUploadObservations: a mixed batch writes only the row that actually differs", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  await createPriceUploadBatch(client, {
    id: "batch-1",
    userId: "user-a",
    sourceLabel: "x",
    format: "single",
    filename: "f.csv",
    rowCount: 2,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [
      candidateFor("1998-03-12", "0.07852"),
      candidateFor("1998-03-13", "0.08"),
    ],
    now: "2026-08-20T00:00:00.000Z",
  });
  const second = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [
      candidateFor("1998-03-12", "0.07852"), // unchanged
      candidateFor("1998-03-13", "0.09"), // changed
    ],
    now: "2026-08-25T00:00:00.000Z",
  });
  assert.deepEqual(second, {
    written: 1,
    insertedCount: 0,
    unchangedCount: 1,
    mappingMissingCount: 0,
  });
});

test("EFF-001 (3) writePriceUploadObservations: mappingMissingCount stays 0 in ordinary operation, distinct from unchangedCount", async () => {
  // Review fold: `unchangedCount` (the identical-value write-avoidance
  // saving) and `mappingMissingCount` (a genuine data-integrity anomaly)
  // must never be conflated. In ordinary operation the guard-create
  // statement always precedes the price statement in the SAME batch, so
  // every candidate's mapping exists by the time it matters -- this pins
  // that BOTH an insert and an unchanged-overlay report zero mapping
  // failures, i.e. the distinction never silently misclassifies a real
  // write-avoidance saving as an anomaly (or vice versa).
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  await createPriceUploadBatch(client, {
    id: "batch-1",
    userId: "user-a",
    sourceLabel: "x",
    format: "single",
    filename: "f.csv",
    rowCount: 2,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  const first = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidateFor("1998-03-12", "0.07852")],
    now: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(first.mappingMissingCount, 0);
  const second = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidateFor("1998-03-12", "0.07852")],
    now: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(second.unchangedCount, 1);
  assert.equal(second.mappingMissingCount, 0);
});

test("EFF-001 (3) confirmSinglePriceUpload end-to-end: an identical re-upload reports unchangedCount honestly", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const settings = { exchangeAlias: "ASX", currencyCode: "AUD" };
  const input = { filename: "fmg.csv", sourceLabel: "intelligent-investor" };
  const csv = "DateTime,FMG\n1998-03-12,0.07852\n1998-03-13,0.08\n";
  const payload = (() => {
    const parsed = parsePriceCsv(bytesOf(csv));
    if (!parsed.ok) throw new Error("fixture failed to parse");
    return {
      ticker: parsed.ticker,
      rows: parsed.rows.map((row) => ({
        marketDate: row.marketDate,
        priceDecimal: row.priceDecimal,
      })),
      malformedCount: parsed.malformed.length,
    };
  })();

  const first = await confirmSinglePriceUpload(
    context(client, "user-a"),
    payload,
    settings,
    input,
    () => "2026-08-20T00:00:00.000Z",
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.written, 2);
  assert.equal(first.value.unchangedCount, 0);

  const second = await confirmSinglePriceUpload(
    context(client, "user-a"),
    payload,
    settings,
    input,
    () => "2026-08-21T00:00:00.000Z",
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.written, 0);
  assert.equal(second.value.unchangedCount, 2);
  assert.equal(second.value.batch.insertedRowCount, 0);
  // Review B3 fix (comment was misleading): `batch.rowCount` is NOT "what
  // the file contained" in general -- it is the number of rows in THIS
  // CONFIRM CALL'S payload, i.e. whatever the client decided to send (in
  // real usage: post no-data-omission, post-downsample, post-delta-filter).
  // This test calls `confirmSinglePriceUpload` directly with the SAME full
  // 2-row payload both times (bypassing the browser's own delta-filtering,
  // which lives in `historical-data-panel.tsx`, not this service layer),
  // so `rowCount` here is simply "2 rows arrived" -- it is UNAFFECTED by
  // measure 3's identical-value guard, which only governs how many of
  // those arriving rows are actually WRITTEN (`written`/`unchangedCount`
  // above), never how many were sent.
  assert.equal(second.value.batch.rowCount, 2);
});

// ---------------------------------------------------------------------------
// (4) db/repositories/price-uploads.ts + app/price-upload-service.ts --
// measure 2, delta-upload.
// ---------------------------------------------------------------------------

test("EFF-001 (2) loadOwnerImportPriceObservationsForSecurity: scoped to this owner's owner-import eod rows for exactly this security, carries the price", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  await createPriceUploadBatch(client, {
    id: "batch-1",
    userId: "user-a",
    sourceLabel: "x",
    format: "single",
    filename: "f.csv",
    rowCount: 2,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [
      candidateFor("1998-03-12", "0.07852"),
      candidateFor("1998-03-13", "0.08"),
    ],
    now: "2026-08-20T00:00:00.000Z",
  });
  const observations = await loadOwnerImportPriceObservationsForSecurity(
    client,
    "user-a",
    "security-a",
  );
  assert.deepEqual(observations, [
    { marketDate: "1998-03-12", closeDecimal: "0.07852" },
    { marketDate: "1998-03-13", closeDecimal: "0.08" },
  ]);

  // A different user sees none of user-a's rows for the SAME security id.
  const otherUserObservations =
    await loadOwnerImportPriceObservationsForSecurity(
      client,
      "user-b",
      "security-a",
    );
  assert.deepEqual(otherUserObservations, []);

  // A different (never-uploaded) security has no observations.
  db.exec(
    `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
     VALUES ('security-z', 'Zeta', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01')`,
  );
  const zetaObservations = await loadOwnerImportPriceObservationsForSecurity(
    client,
    "user-a",
    "security-z",
  );
  assert.deepEqual(zetaObservations, []);
});

test("EFF-001 (2, review fold) loadOwnerImportPriceObservationsForSecurity: a hand-crafted non-eod owner-import row on the SAME date never shadows a genuine eod upload", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  await createPriceUploadBatch(client, {
    id: "batch-1",
    userId: "user-a",
    sourceLabel: "x",
    format: "single",
    filename: "f.csv",
    rowCount: 1,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidateFor("1998-03-12", "0.07852")],
    now: "2026-08-20T00:00:00.000Z",
  });
  // A hand-crafted owner-import row on the SAME date/security but a
  // DIFFERENT interval -- not something this write path ever produces
  // itself (every owner-import candidate is `interval: "eod"`), but
  // possible in principle (e.g. a future path reusing this provider id).
  // Without the `interval = 'eod'` filter this row would collide with the
  // genuine eod row above in a naive per-date map and could shadow it.
  db.exec(`
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    SELECT 'price-intraday-shadow', 'owner-import', 'user', 'user-a', 'user-a', mapping_id, 'security-a', 'intraday', '1998-03-12T04:00:00.000Z', '1998-03-12', 'Australia/Sydney', 'AUD', '9.99', 'raw', 'observed', '1998-03-12T04:00:00.000Z'
      FROM price_observations WHERE security_id = 'security-a' LIMIT 1;
  `);
  const observations = await loadOwnerImportPriceObservationsForSecurity(
    client,
    "user-a",
    "security-a",
  );
  // Only the genuine eod row is returned -- the intraday row (a different
  // natural key entirely) never appears, so it can never shadow the eod
  // price via a naive "one entry per date" read.
  assert.deepEqual(observations, [
    { marketDate: "1998-03-12", closeDecimal: "0.07852" },
  ]);
});

test("EFF-001 (2) previewSinglePriceUpload: discloses identical (date+price) duplicates and the explicit rows-to-write figure, honestly", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const settings = { exchangeAlias: "ASX", currencyCode: "AUD" };

  // Pre-existing coverage: 1998-03-12 only.
  await createPriceUploadBatch(client, {
    id: "batch-1",
    userId: "user-a",
    sourceLabel: "x",
    format: "single",
    filename: "f.csv",
    rowCount: 1,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-1",
    candidates: [candidateFor("1998-03-12", "0.07852")],
    now: "2026-08-20T00:00:00.000Z",
  });

  // Preview a file with the SAME date/price plus one NEW date.
  const csv = "DateTime,FMG\n1998-03-12,0.07852\n1998-03-13,0.08\n";
  const parsed = parsePriceCsv(bytesOf(csv));
  if (!parsed.ok) throw new Error("fixture failed to parse");
  const result = await previewSinglePriceUpload(
    context(client, "user-a"),
    {
      ticker: parsed.ticker,
      rows: parsed.rows.map((row) => ({
        marketDate: row.marketDate,
        priceDecimal: row.priceDecimal,
      })),
      malformedCount: 0,
    },
    settings,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.preview.existingObservations, [
    { marketDate: "1998-03-12", closeDecimal: "0.07852" },
  ]);
  assert.equal(result.preview.identicalCount, 1);
  assert.equal(result.preview.rowCount, 2);
  // Review B2: the explicit write-budget figure.
  assert.equal(result.preview.rowsToWriteCount, 1);
});

test("EFF-001 (2, review B1 fix) previewSinglePriceUpload + filterRowsAlreadyPresent: a CORRECTED price on an already-covered date is NEVER treated as a duplicate", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const settings = { exchangeAlias: "ASX", currencyCode: "AUD" };

  // Seed via `confirmSinglePriceUpload` itself (not `writePriceUploadObservations`
  // + a hand-built candidate) -- it derives `observation_at` from the real
  // midnight-exchange-timezone convention, the SAME derivation the
  // correction upload below will use; a hand-built candidate's naive
  // `observationAt` would land on a DIFFERENT observation_at and the two
  // uploads would never collide on the owner-import `ON CONFLICT` key at
  // all, defeating the point of this test.
  const seedCsv = "DateTime,FMG\n1998-03-12,0.07852\n";
  const seedParsed = parsePriceCsv(bytesOf(seedCsv));
  if (!seedParsed.ok) throw new Error("fixture failed to parse");
  const seeded = await confirmSinglePriceUpload(
    context(client, "user-a"),
    {
      ticker: seedParsed.ticker,
      rows: seedParsed.rows.map((row) => ({
        marketDate: row.marketDate,
        priceDecimal: row.priceDecimal,
      })),
      malformedCount: 0,
    },
    settings,
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-20T00:00:00.000Z",
  );
  assert.equal(seeded.ok, true);

  // Re-upload the SAME date but a CORRECTED price.
  const csv = "DateTime,FMG\n1998-03-12,0.09\n";
  const parsed = parsePriceCsv(bytesOf(csv));
  if (!parsed.ok) throw new Error("fixture failed to parse");
  const payload = {
    ticker: parsed.ticker,
    rows: parsed.rows.map((row) => ({
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
    })),
    malformedCount: 0,
  };
  const preview = await previewSinglePriceUpload(
    context(client, "user-a"),
    payload,
    settings,
  );
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  // NOT counted as identical/skipped -- the price differs.
  assert.equal(preview.preview.identicalCount, 0);
  assert.equal(preview.preview.rowsToWriteCount, 1);

  // Mirrors the CLIENT's own filter step (historical-data-panel.tsx) --
  // the corrected row survives filtering and is sent on confirm.
  const { rows: rowsToUpload, identicalCount } = filterRowsAlreadyPresent(
    payload.rows,
    preview.preview.existingObservations,
  );
  assert.equal(identicalCount, 0);
  assert.deepEqual(rowsToUpload, payload.rows);

  const confirmed = await confirmSinglePriceUpload(
    context(client, "user-a"),
    { ...payload, rows: rowsToUpload },
    settings,
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-21T00:00:00.000Z",
  );
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  // The correction actually WROTE (measure 3's guard only skips TRUE
  // duplicates -- a genuinely different value always converges).
  assert.equal(confirmed.value.written, 1);
  assert.equal(confirmed.value.unchangedCount, 0);
  const row = db
    .prepare(
      `SELECT close_decimal FROM price_observations WHERE security_id = 'security-a' AND market_date = '1998-03-12'`,
    )
    .get() as { close_decimal: string };
  assert.equal(row.close_decimal, "0.09");
});

// ---------------------------------------------------------------------------
// (5) app/price-history-coverage-format.ts + app/price-history-coverage.ts --
// MKT-018B's gap classification is spacing-blind; sparse (downsampled)
// pre-boundary history does not trip `partial`.
// ---------------------------------------------------------------------------

test("EFF-001 (5) classifyPriceHistoryCoverage: only compares first/last observation dates -- sparse (monthly) observationCount still classifies covered", () => {
  const classification = classifyPriceHistoryCoverage({
    observationCount: 24, // 2 years of monthly data -- NOT ~730 daily rows
    firstObservationDate: "2010-01-31",
    lastObservationDate: "2020-08-10", // within the trailing-staleness floor
    firstTransactionDate: "2011-06-01",
    isSoldOut: false,
    today: "2020-08-20",
  });
  assert.equal(classification, "covered");
});

test("EFF-001 (5) loadOwnedPriceHistoryCoverage: a security with ONLY monthly-spaced observations classifies covered, not partial", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  db.exec(`
    INSERT INTO transactions (id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at, local_trade_date, quantity_decimal, unit_price_decimal, currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, source_type, created_by_user_id, calculation_version, created_at)
    VALUES ('tx-a-buy', 'user-a', 'portfolio-a', 'membership-a', 'buy', 'posted', '2011-06-01T00:00:00Z', '2011-06-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2011-06-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-a', 'security-a', 'owner-import', 'ASX', 'FMG', '2010-01-01', 'verified');
  `);
  // 20 rows, ONE per calendar month, spanning 2010-01 through 2011-08 --
  // this is EXACTLY the shape EFF-001's measure-5 downsampling would store
  // for that span.
  const insertRows: string[] = [];
  for (let year = 2010; year <= 2011; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      if (year === 2011 && month > 8) break;
      const md = `${year}-${String(month).padStart(2, "0")}-28`;
      const id = `price-${year}-${month}`;
      insertRows.push(
        `('${id}', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-a', 'security-a', 'eod', '${md}T00:00:00.000Z', '${md}', 'Australia/Sydney', 'AUD', '1.00', 'raw', 'observed', '${md}T00:00:00.000Z')`,
      );
    }
  }
  db.exec(
    `INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
     VALUES ${insertRows.join(",")};`,
  );

  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    new Date("2011-08-20T00:00:00.000Z"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Sparse, monthly-only history: NOT flagged zero or partial in either
  // list -- `classifyPriceHistoryCoverage` never inspects the SPACING
  // between observations, only the first/last endpoints.
  assert.deepEqual(result.zero, []);
  assert.deepEqual(result.partial, []);
});

// ---------------------------------------------------------------------------
// (6) app/price-history-chart-geometry.ts -- UI-018 renders sparse history
// without error; the gap-dashing cosmetic limitation is pinned as OBSERVED
// behaviour (see docs/CSV_IMPORT_SPEC.md §15.5 for the honest write-up).
// ---------------------------------------------------------------------------

/** Mirrors `app/price-history-range.ts`'s `downsamplePriceHistoryPoints`
 * uniform-index-bucket algorithm exactly (kept local here so this test
 * stays within the pure, DB-free chart-geometry module rather than pulling
 * in that DB-touching sibling for one well-documented formula). */
function downsampleLikeChart<T>(
  points: readonly T[],
  maxPoints = 400,
): { points: T[]; bucketSize: number } {
  if (points.length <= maxPoints) return { points: [...points], bucketSize: 1 };
  const bucketSize = Math.ceil(points.length / maxPoints);
  const sampled: T[] = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const end = Math.min(start + bucketSize, points.length);
    sampled.push(points[end - 1]!);
  }
  return { points: sampled, bucketSize };
}

test("EFF-001 (5) UI-018 chart: a mixed monthly/daily (downsampled-import-shaped) series scales and classifies without error, every point plots at a finite position", () => {
  const points: ChartInputPoint[] = [];
  for (let year = 2000; year <= 2019; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      points.push({
        date: `${year}-${String(month).padStart(2, "0")}-28`,
        priceDecimal: "1.00",
      });
    }
  }
  let day = new Date(Date.UTC(2020, 0, 1));
  const end = new Date(Date.UTC(2021, 11, 31));
  while (day <= end) {
    points.push({
      date: day.toISOString().slice(0, 10),
      priceDecimal: "2.00",
    });
    day = new Date(day.getTime() + 86_400_000);
  }
  assert.equal(points.length, 971);

  const { points: downsampled, bucketSize } = downsampleLikeChart(points);
  assert.ok(bucketSize > 1, "expected the long range to trigger downsampling");

  // Renders without throwing and positions every point at a finite pixel --
  // sparse, mixed-cadence history is never a crash or an off-chart point.
  const scaled = scalePriceHistoryPoints(downsampled, {
    width: 800,
    height: 300,
    paddingX: 20,
    paddingY: 20,
  });
  assert.ok(scaled);
  assert.equal(scaled!.points.length, downsampled.length);
  for (const point of scaled!.points) {
    assert.ok(Number.isFinite(point.x));
    assert.ok(Number.isFinite(point.y));
  }

  // Documented, non-blocking cosmetic limitation (CSV_IMPORT_SPEC.md
  // §15.5): the gap floor is scaled by a SINGLE dataset-wide `bucketSize`,
  // so pre-boundary monthly segments in a long range mixing dense recent
  // daily data CAN legitimately be flagged as gaps even though they are
  // genuine, deliberately-sparse history, not a hole. Pinned as OBSERVED
  // (not merely asserted "fine") so a future cadence-aware fix has a
  // failing test to update honestly.
  const segments = classifyPriceHistorySegments(downsampled, bucketSize);
  const preBoundarySegments = segments.filter(
    (segment) => segment.points[0]!.date < "2020-01-01",
  );
  const gapSegments = preBoundarySegments.filter((segment) => segment.gap);
  assert.ok(
    gapSegments.length > 0,
    "expected at least one pre-boundary segment to be gap-flagged under today's uniform-bucketSize floor",
  );
  // Every downsampled point (both eras) is still present in SOME segment --
  // the classification never silently drops a point, only marks styling.
  const pointCountAcrossSegments = segments.reduce(
    (sum, segment) => sum + segment.points.length,
    0,
  );
  assert.ok(pointCountAcrossSegments >= downsampled.length);
});

// ---------------------------------------------------------------------------
// (7) app/components/historical-data-panel.tsx -- preview render pins for
// measures 2/4/5's new disclosure lines. Mirrors `tests/mkt-008.test.ts`'s
// `renderComponent` shell-out (this codebase has no interactive DOM
// harness; `SinglePreviewSummary` is a pure, explicit-props presentational
// component precisely so this static render pin is possible).
// ---------------------------------------------------------------------------

const PANEL_PATH = "../app/components/historical-data-panel.tsx";

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(createElement(${componentName}, props)),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

const BASE_PREVIEW = {
  ticker: "FMG",
  exchangeAlias: "ASX",
  currencyCode: "AUD",
  matchedSecurityId: "security-a",
  matchedName: "Fortescue",
  rowCount: 2,
  malformedCount: 0,
  dateFrom: "2018-01-05",
  dateTo: "2018-02-01",
  sampleFirst: { marketDate: "2018-01-05", priceDecimal: "1.40" },
  sampleLast: { marketDate: "2018-02-01", priceDecimal: "1.50" },
  existingObservations: [],
  identicalCount: 0,
  rowsToWriteCount: 2,
  noDataOmittedCount: 0,
  downsampleApplied: false,
  downsampleBoundaryYear: 2018,
  preDownsampleRowCount: 2,
};

test("EFF-001 render: SinglePreviewSummary discloses identical-duplicate, no-data, downsample, and the explicit rows-to-write figure honestly", () => {
  const html = renderComponent("SinglePreviewSummary", PANEL_PATH, {
    preview: {
      ...BASE_PREVIEW,
      identicalCount: 3,
      rowsToWriteCount: 5,
      noDataOmittedCount: 2,
      downsampleApplied: true,
      preDownsampleRowCount: 8,
    },
  });
  assert.match(html, /3 identical row\(s\) already present -- skipped\./);
  assert.match(html, /2 no-data row\(s\) omitted \(blank or zero price\)\./);
  assert.match(
    html,
    /Daily from 2018-01-01; monthly \(last trading day of the month\) before -- 2 row\(s\) instead of 8\./,
  );
  // Review B2: the explicit write-budget statement always renders.
  assert.match(html, /5 row\(s\) will be written\./);
});

test("EFF-001 render: SinglePreviewSummary omits the identical/no-data/downsample disclosure lines when nothing was skipped/omitted/downsampled, but always states rows-to-write", () => {
  const html = renderComponent("SinglePreviewSummary", PANEL_PATH, {
    preview: BASE_PREVIEW,
  });
  assert.doesNotMatch(html, /identical row\(s\) already present/);
  assert.doesNotMatch(html, /no-data row\(s\) omitted/);
  assert.doesNotMatch(html, /Daily from/);
  // Review B2: the explicit write-budget statement is UNCONDITIONAL.
  assert.match(html, /2 row\(s\) will be written\./);
});
