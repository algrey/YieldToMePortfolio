/**
 * MKT-008 — Owner price-history CSV import, backup export, and backup
 * import ("Historical Data" section on the import page).
 *
 * Covers: `domain/market-data/price-csv.ts` (single-security CSV parsing:
 * tab/comma detection, ignored columns, malformed-row disclosure, date/price
 * validation, caps); `domain/market-data/exchange-timezone.ts` (the
 * midnight-exchange-timezone `observation_at` derivation, AEST/AEDT); `
 * domain/market-data/resolve-price-upload-security.ts` (match/no-match/
 * ambiguous over same-user evidence); `domain/market-data/price-backup-csv.ts`
 * (the self-describing backup format: format/round-trip, malformed reasons);
 * `db/repositories/price-uploads.ts` (evidence loading, natural-key
 * idempotent upsert across both ON CONFLICT targets, batch create/list/
 * delete, export query scope); `app/price-upload-service.ts` (preview/
 * confirm end-to-end, idempotent overlay, export->wipe->import-backup
 * lossless round trip, provider preservation, upload delete, cross-user
 * isolation, caps); and owner-import rows' participation in snapshot
 * valuation (the snapshot exclusion predicate excludes ONLY 'sharesight').
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEFAULT_PRICE_CSV_LIMITS,
  parsePriceCsv,
} from "../domain/market-data/price-csv.ts";
import {
  deriveMidnightObservationAtUtc,
  resolveExchangeTimezone,
} from "../domain/market-data/exchange-timezone.ts";
import { resolvePriceUploadSecurity } from "../domain/market-data/resolve-price-upload-security.ts";
import {
  DEFAULT_PRICE_BACKUP_LIMITS,
  formatPriceBackupCsv,
  parsePriceBackupCsv,
  PRICE_BACKUP_FORMAT_VERSION,
} from "../domain/market-data/price-backup-csv.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";
import {
  createPriceUploadBatch,
  loadOwnerPriceExportRows,
  loadSameUserSecurityEvidenceForTicker,
  OWNER_IMPORT_PROVIDER_ID,
  writePriceUploadObservations,
} from "../db/repositories/price-uploads.ts";
import {
  confirmBackupPriceUpload,
  confirmSinglePriceUpload,
  deleteOwnedPriceUpload,
  exportOwnerPriceHistoryCsv,
  listOwnedPriceUploads,
  previewBackupPriceUpload,
  previewSinglePriceUpload,
  type PriceUploadContext,
} from "../app/price-upload-service.ts";
import { createHistoricalSnapshotRepository } from "../db/repositories/index.ts";
import { rejectCrossSiteMutation } from "../app/mutation-request.ts";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// (1) domain/market-data/price-csv.ts
// ---------------------------------------------------------------------------

test("MKT-008 price-csv: a tab-delimited header/rows parse, ticker read from the second header column", () => {
  const result = parsePriceCsv(
    bytesOf(
      "DateTime\tFMG\r\n1998-03-12 00:00:00\t0.07852\r\n1998-03-13 00:00:00\t0.08\r\n",
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ticker, "FMG");
  assert.equal(result.delimiter, "\t");
  assert.deepEqual(
    result.rows.map((row) => [row.marketDate, row.priceDecimal]),
    [
      ["1998-03-12", "0.07852"],
      ["1998-03-13", "0.08"],
    ],
  );
  assert.equal(result.malformed.length, 0);
});

test("MKT-008 price-csv: a comma-delimited header/rows parse identically, and a bare date (no time-of-day) is accepted", () => {
  const result = parsePriceCsv(bytesOf("DateTime,FMG\n1998-03-12,0.07852\n"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.delimiter, ",");
  assert.deepEqual(result.rows, [
    { physicalRowNumber: 2, marketDate: "1998-03-12", priceDecimal: "0.07852" },
  ]);
});

test("MKT-008 price-csv: extra columns after the price column are ignored, never counted as malformed", () => {
  const result = parsePriceCsv(
    bytesOf("DateTime,FMG,Volume,Notes\n1998-03-12,0.07852,12345,ignored\n"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.malformed.length, 0);
  assert.equal(result.rows[0]?.priceDecimal, "0.07852");
});

test("MKT-008 price-csv: malformed rows are counted with a reason, never silently dropped -- invalid date, invalid price, wrong column count", () => {
  const result = parsePriceCsv(
    bytesOf(
      [
        "DateTime,FMG",
        "1998-02-30,1.00", // invalid calendar date
        "1998-03-12,-1.00", // negative price
        "1998-03-13,1e5", // exponent price
        "1998-03-14,abc", // non-decimal price
        "1998-03-15,0", // zero price (never positive)
        "onlyonecolumn",
        "1998-03-16,0.10", // valid, proves parsing continues past malformed rows
      ].join("\n") + "\n",
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.malformed.map((row) => row.reason),
    [
      "invalid_date",
      "invalid_price",
      "invalid_price",
      "invalid_price",
      "invalid_price",
      "wrong_column_count",
    ],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.marketDate, "1998-03-16");
});

test("MKT-008 price-csv: a missing/wrong header is rejected honestly, never guessed", () => {
  const noHeader = parsePriceCsv(bytesOf(""));
  assert.equal(noHeader.ok, false);
  if (!noHeader.ok) assert.equal(noHeader.code, "EMPTY_FILE");

  const wrongHeader = parsePriceCsv(bytesOf("Date,Price\n1998-03-12,1.00\n"));
  assert.equal(wrongHeader.ok, false);
  if (!wrongHeader.ok) assert.equal(wrongHeader.code, "MISSING_HEADER");
});

test("MKT-008 price-csv: caps are enforced -- oversized bytes and oversized row counts fail closed", () => {
  const oversizedBytes = parsePriceCsv(
    bytesOf("DateTime,FMG\n1998-03-12,1.00\n"),
    {
      maxBytes: 5,
      maxRows: DEFAULT_PRICE_CSV_LIMITS.maxRows,
    },
  );
  assert.equal(oversizedBytes.ok, false);
  if (!oversizedBytes.ok)
    assert.equal(oversizedBytes.code, "BYTE_LIMIT_EXCEEDED");

  const manyRows = [
    "DateTime,FMG",
    "1998-03-12,1.00",
    "1998-03-13,1.00",
    "1998-03-14,1.00",
  ].join("\n");
  const oversizedRows = parsePriceCsv(bytesOf(manyRows + "\n"), {
    maxBytes: DEFAULT_PRICE_CSV_LIMITS.maxBytes,
    maxRows: 2,
  });
  assert.equal(oversizedRows.ok, false);
  if (!oversizedRows.ok) assert.equal(oversizedRows.code, "ROW_LIMIT_EXCEEDED");
});

// ---------------------------------------------------------------------------
// (2) domain/market-data/exchange-timezone.ts
// ---------------------------------------------------------------------------

test("MKT-008 exchange-timezone: ASX resolves to Australia/Sydney; an unrecognised exchange resolves to null (never a guessed timezone)", () => {
  assert.equal(resolveExchangeTimezone("ASX"), "Australia/Sydney");
  assert.equal(resolveExchangeTimezone("asx"), "Australia/Sydney");
  assert.equal(resolveExchangeTimezone("NYSE"), null);
});

test("MKT-008 exchange-timezone: midnight Sydney in AEDT (summer, +11) derives the correct UTC instant", () => {
  // 2024-01-15 is well within AEDT (+11) -- Sydney midnight is 13:00 UTC the
  // PREVIOUS day.
  assert.equal(
    deriveMidnightObservationAtUtc("2024-01-15", "Australia/Sydney"),
    "2024-01-14T13:00:00.000Z",
  );
});

test("MKT-008 exchange-timezone: midnight Sydney in AEST (winter, +10) derives the correct UTC instant", () => {
  // 2024-07-15 is well within AEST (+10) -- Sydney midnight is 14:00 UTC the
  // previous day.
  assert.equal(
    deriveMidnightObservationAtUtc("2024-07-15", "Australia/Sydney"),
    "2024-07-14T14:00:00.000Z",
  );
});

test("MKT-008 exchange-timezone: an invalid date string fails closed (null), never a fabricated instant", () => {
  assert.equal(
    deriveMidnightObservationAtUtc("not-a-date", "Australia/Sydney"),
    null,
  );
});

// ---------------------------------------------------------------------------
// (3) domain/market-data/resolve-price-upload-security.ts
// ---------------------------------------------------------------------------

test("MKT-008 resolver: no same-user evidence at all is an honest no_match", () => {
  const result = resolvePriceUploadSecurity("ASX", []);
  assert.deepEqual(result, { outcome: "no_match" });
});

test("MKT-008 resolver: a single agreeing candidate (or one with no exchange evidence at all) matches", () => {
  const withEvidence = resolvePriceUploadSecurity("ASX", [
    { securityId: "security-a", canonicalName: "Alpha", exchangeAlias: "ASX" },
  ]);
  assert.equal(withEvidence.outcome, "matched");
  if (withEvidence.outcome === "matched")
    assert.equal(withEvidence.securityId, "security-a");

  const withoutEvidence = resolvePriceUploadSecurity("ASX", [
    { securityId: "security-a", canonicalName: "Alpha", exchangeAlias: null },
  ]);
  assert.equal(withoutEvidence.outcome, "matched");
});

// B3 fix (review, 2026-08-21): a SINGLE candidate that disagrees on exchange
// is `exchange_mismatch` (a specific, correctable "wrong setting" message),
// distinct from genuine multi-candidate `ambiguous` (no single correction to
// suggest). The prior version collapsed both into the same generic
// "ambiguous" outcome.
test("MKT-008 resolver (B3): exactly one candidate that disagrees on exchange is exchange_mismatch, naming the actually-held exchange -- not the generic ambiguous outcome", () => {
  const result = resolvePriceUploadSecurity("ASX", [
    {
      securityId: "security-a",
      canonicalName: "Alpha",
      exchangeAlias: "NASDAQ",
    },
  ]);
  assert.equal(result.outcome, "exchange_mismatch");
  if (result.outcome === "exchange_mismatch") {
    assert.equal(result.securityId, "security-a");
    assert.equal(result.canonicalName, "Alpha");
    assert.equal(result.heldExchangeAlias, "NASDAQ");
  }
});

test("MKT-008 resolver (B3): more than one distinct candidate security is genuinely ambiguous and lists every candidate -- never guessed", () => {
  const twoDistinct = resolvePriceUploadSecurity("ASX", [
    { securityId: "security-a", canonicalName: "Alpha", exchangeAlias: null },
    { securityId: "security-b", canonicalName: "Beta", exchangeAlias: null },
  ]);
  assert.equal(twoDistinct.outcome, "ambiguous");
  if (twoDistinct.outcome === "ambiguous") {
    assert.deepEqual(
      new Set(twoDistinct.candidates.map((candidate) => candidate.securityId)),
      new Set(["security-a", "security-b"]),
    );
  }

  // Two distinct candidates, one of which also disagrees on exchange --
  // STILL genuine ambiguity (more than one distinct security), not
  // exchange_mismatch (that outcome only ever fires for exactly one).
  const twoDistinctWithContradiction = resolvePriceUploadSecurity("ASX", [
    {
      securityId: "security-a",
      canonicalName: "Alpha",
      exchangeAlias: "NASDAQ",
    },
    { securityId: "security-b", canonicalName: "Beta", exchangeAlias: "ASX" },
  ]);
  assert.equal(twoDistinctWithContradiction.outcome, "ambiguous");
});

// ---------------------------------------------------------------------------
// (4) domain/market-data/price-backup-csv.ts
// ---------------------------------------------------------------------------

test("MKT-008 backup-csv: format then parse round-trips a row exactly", () => {
  const csv = formatPriceBackupCsv([
    {
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
    },
  ]);
  assert.equal(
    csv.split("\r\n")[0],
    "format_version,provider_id,source_label,provider_symbol,provider_exchange,currency_code,market_date,price_decimal,observation_at,market_timezone,interval,quality,adjustment_state,delayed_minutes",
  );
  assert.match(
    csv.split("\r\n")[1] ?? "",
    new RegExp(
      `^${PRICE_BACKUP_FORMAT_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},owner-import,`,
    ),
  );
  const parsed = parsePriceBackupCsv(bytesOf(csv));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.malformed.length, 0);
  assert.deepEqual(parsed.rows, [
    {
      physicalRowNumber: 2,
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
    },
  ]);
});

test("MKT-008 backup-csv: an unsupported format_version or an unknown provider fails that row closed, never silently accepted", () => {
  const wrongVersion = parsePriceBackupCsv(
    bytesOf(
      "format_version,provider_id,source_label,provider_symbol,provider_exchange,currency_code,market_date,price_decimal,observation_at,market_timezone,interval,quality,adjustment_state,delayed_minutes\n" +
        "some-other-version,owner-import,label,FMG,ASX,AUD,1998-03-12,0.07852,1998-03-11T13:00:00.000Z,Australia/Sydney,eod,observed,raw,\n",
    ),
  );
  assert.equal(wrongVersion.ok, true);
  if (wrongVersion.ok) {
    assert.deepEqual(
      wrongVersion.malformed.map((row) => row.reason),
      ["unsupported_format_version"],
    );
  }

  const withHeader = parsePriceBackupCsv(
    bytesOf(
      "format_version,provider_id,source_label,provider_symbol,provider_exchange,currency_code,market_date,price_decimal,observation_at,market_timezone,interval,quality,adjustment_state,delayed_minutes\n" +
        `${PRICE_BACKUP_FORMAT_VERSION},not-a-real-provider,label,FMG,ASX,AUD,1998-03-12,0.07852,1998-03-11T13:00:00.000Z,Australia/Sydney,eod,observed,raw,\n`,
    ),
  );
  assert.equal(withHeader.ok, true);
  if (withHeader.ok) {
    assert.deepEqual(
      withHeader.malformed.map((row) => row.reason),
      ["unknown_provider"],
    );
  }
});

test("MKT-008 backup-csv: caps are enforced", () => {
  const oversized = parsePriceBackupCsv(bytesOf("x".repeat(100)), {
    maxBytes: 10,
    maxRows: DEFAULT_PRICE_BACKUP_LIMITS.maxRows,
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "BYTE_LIMIT_EXCEEDED");
});

// ---------------------------------------------------------------------------
// (5) db/repositories/price-uploads.ts + app/price-upload-service.ts
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

/** Two owners, each with a portfolio and one FMG-shaped security resolved
 * via ticker+exchange+currency evidence -- the shared fixture for the
 * repository/service tests below. */
async function ownedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1),
           ('user-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1),
           ('portfolio-b', 'user-b', 'B', 'B portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Fortescue', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-b', 'Beta', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'FMG', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('membership-b', 'user-b', 'portfolio-b', 'security-b', 'ZZZ', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
  `);
  return db;
}

function context(client: SqlClient, userId: string): PriceUploadContext {
  return { client, userId };
}

const SINGLE_CSV = "DateTime,FMG\n1998-03-12,0.07852\n1998-03-13,0.08\n";

test("MKT-008 evidence: loadSameUserSecurityEvidenceForTicker matches by source_symbol, filters by currency, and is cross-user isolated", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const evidenceA = await loadSameUserSecurityEvidenceForTicker(
    client,
    "user-a",
    "fmg",
    "AUD",
  );
  assert.deepEqual(evidenceA, [
    {
      securityId: "security-a",
      canonicalName: "Fortescue",
      exchangeAlias: "ASX",
    },
  ]);
  const evidenceAWrongCurrency = await loadSameUserSecurityEvidenceForTicker(
    client,
    "user-a",
    "FMG",
    "USD",
  );
  assert.deepEqual(evidenceAWrongCurrency, []);
  const evidenceBForA = await loadSameUserSecurityEvidenceForTicker(
    client,
    "user-b",
    "FMG",
    "AUD",
  );
  assert.deepEqual(evidenceBForA, []);
});

test("MKT-008 preview: a happy-path CSV matches the owner's security and reports rowCount/dateRange/samples", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const result = await previewSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    {
      exchangeAlias: "ASX",
      currencyCode: "AUD",
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.preview.ticker, "FMG");
  assert.equal(result.preview.matchedSecurityId, "security-a");
  assert.equal(result.preview.matchedName, "Fortescue");
  assert.equal(result.preview.rowCount, 2);
  assert.equal(result.preview.malformedCount, 0);
  assert.equal(result.preview.dateFrom, "1998-03-12");
  assert.equal(result.preview.dateTo, "1998-03-13");
  assert.deepEqual(result.preview.sampleFirst, {
    marketDate: "1998-03-12",
    priceDecimal: "0.07852",
  });
});

test("MKT-008 preview: no security held for the ticker is an honest error naming the ticker (never auto-created)", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const result = await previewSinglePriceUpload(
    context(client, "user-a"),
    bytesOf("DateTime,XYZ\n1998-03-12,1.00\n"),
    { exchangeAlias: "ASX", currencyCode: "AUD" },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
  assert.match(result.message, /XYZ/);
});

test("MKT-008 preview (B3): a ticker held on a DIFFERENT exchange than the settings claim gets a specific, correctable message naming the real exchange -- not the generic ambiguous wording", async () => {
  const db = await ownedFixture();
  // Point security-a's OWN exchange evidence at NASDAQ instead of the
  // fixture's default ASX -- the settings form below still claims ASX
  // (a real, supported exchange, so it clears the earlier
  // unsupported-exchange check), so the two disagree.
  db.exec(
    `UPDATE portfolio_securities SET source_exchange_alias = 'NASDAQ' WHERE id = 'membership-a'`,
  );
  const client = createSqliteSqlClient(db);
  const result = await previewSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    { exchangeAlias: "ASX", currencyCode: "AUD" },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.match(result.message, /held on NASDAQ, not ASX/);
  assert.doesNotMatch(result.message, /matches more than one security/);
});

test("MKT-008 preview: an unsupported exchange is rejected rather than guessing a timezone", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const result = await previewSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    {
      exchangeAlias: "NYSE",
      currencyCode: "AUD",
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
});

test("MKT-008 preview: ambiguous ticker evidence (two securities, no way to prefer one) is a named, listing error", async () => {
  const db = await ownedFixture();
  db.exec(`
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a2', 'Fortescue Duplicate', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a2', 'user-a', 'portfolio-a', 'security-a2', 'FMG', 'AUD', 'held', '2026-08-01', '2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const result = await previewSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    {
      exchangeAlias: "ASX",
      currencyCode: "AUD",
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
});

test("MKT-008 confirm: writes owner-import price_observations with the midnight-Sydney observation_at and guard-creates the provider mapping", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const result = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-20T00:00:00.000Z",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.written, 2);
  assert.equal(result.value.batch.rowCount, 2);
  assert.equal(result.value.batch.sourceLabel, "intelligent-investor");
  assert.equal(result.value.batch.format, "single");

  const rows = db
    .prepare(
      `SELECT provider_id, access_scope, scope_user_id, security_id, market_date, close_decimal, observation_at, market_timezone, interval, quality, adjustment_state, upload_batch_id
       FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all() as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.provider_id, OWNER_IMPORT_PROVIDER_ID);
  assert.equal(rows[0]!.access_scope, "user");
  assert.equal(rows[0]!.scope_user_id, "user-a");
  assert.equal(rows[0]!.market_date, "1998-03-12");
  assert.equal(rows[0]!.close_decimal, "0.07852");
  // 1998-03-12 is AEDT (+11) -- midnight Sydney is 13:00 UTC the previous day.
  assert.equal(rows[0]!.observation_at, "1998-03-11T13:00:00.000Z");
  assert.equal(rows[0]!.interval, "eod");
  assert.equal(rows[0]!.quality, "observed");
  assert.equal(rows[0]!.adjustment_state, "raw");
  assert.equal(rows[0]!.upload_batch_id, result.value.batch.id);

  const mapping = db
    .prepare(
      `SELECT provider_exchange, provider_symbol, status FROM security_provider_mappings
       WHERE provider_id = ? AND security_id = 'security-a'`,
    )
    .get(OWNER_IMPORT_PROVIDER_ID) as Record<string, unknown>;
  assert.equal(mapping.provider_exchange, "ASX");
  assert.equal(mapping.provider_symbol, "FMG");
  assert.equal(mapping.status, "candidate");
});

test("MKT-008 confirm: malformed rows are counted on the batch, never silently dropped", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const result = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(
      "DateTime,FMG\n1998-03-12,0.07852\n1998-02-30,1.00\n1998-03-14,-1\n",
    ),
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-20T00:00:00.000Z",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.written, 1);
  assert.equal(result.value.batch.rowCount, 1);
  assert.equal(result.value.batch.malformedRowCount, 2);
});

test("MKT-008 idempotent overlay: importing the SAME file twice (same fixed now) leaves byte-identical price_observations for that security, attribution staying with the batch that CREATED the rows", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const settings = { exchangeAlias: "ASX", currencyCode: "AUD" };
  const input = { filename: "fmg.csv", sourceLabel: "intelligent-investor" };
  const now = () => "2026-08-20T00:00:00.000Z";
  const first = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    settings,
    input,
    now,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const beforeRows = db
    .prepare(
      `SELECT id, market_date, close_decimal, observation_at FROM price_observations
       WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all();

  const second = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    settings,
    input,
    now,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.notEqual(second.value.batch.id, first.value.batch.id);

  const afterRows = db
    .prepare(
      `SELECT id, market_date, close_decimal, observation_at FROM price_observations
       WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all();
  // Same row ids (true upsert, never a duplicate insert), same values --
  // "byte-identical table state" on every financial-fact column.
  assert.deepEqual(afterRows, beforeRows);

  const totalCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM price_observations WHERE security_id = 'security-a'`,
      )
      .get() as {
      n: number;
    }
  ).n;
  assert.equal(totalCount, 2);

  // B1 fix: attribution stays with the batch that CREATED each row -- the
  // second (overlaying) confirm never reassigns it, even though it wrote
  // fresh (identical) values into the SAME rows.
  const attributedBatch = (
    db
      .prepare(
        `SELECT DISTINCT upload_batch_id FROM price_observations WHERE security_id = 'security-a'`,
      )
      .all() as { upload_batch_id: string }[]
  ).map((row) => row.upload_batch_id);
  assert.deepEqual(attributedBatch, [first.value.batch.id]);

  // `row_count` (2, both rows the file contained) and `inserted_row_count`
  // differ for the SECOND confirm -- it wrote 2 rows total but created 0 of
  // them (both already existed from the first confirm).
  assert.equal(first.value.batch.insertedRowCount, 2);
  assert.equal(second.value.batch.rowCount, 2);
  assert.equal(second.value.batch.insertedRowCount, 0);
});

test("MKT-008 delete: removes exactly the upload's own rows and the batch row, owner-scoped; re-importing the same file restores identical facts", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const settings = { exchangeAlias: "ASX", currencyCode: "AUD" };
  const input = { filename: "fmg.csv", sourceLabel: "intelligent-investor" };
  const now = () => "2026-08-20T00:00:00.000Z";
  const confirmed = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    settings,
    input,
    now,
  );
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const beforeRows = db
    .prepare(
      `SELECT market_date, close_decimal, observation_at FROM price_observations
       WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all();

  // Cross-user delete is denied.
  const deniedForOtherUser = await deleteOwnedPriceUpload(
    context(client, "user-b"),
    confirmed.value.batch.id,
  );
  assert.equal(deniedForOtherUser.ok, false);

  const deleted = await deleteOwnedPriceUpload(
    context(client, "user-a"),
    confirmed.value.batch.id,
  );
  assert.equal(deleted.ok, true);
  if (deleted.ok) assert.equal(deleted.deletedObservations, 2);

  const afterDelete = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { n: number };
  assert.equal(afterDelete.n, 0);
  const batchGone = db
    .prepare(`SELECT COUNT(*) AS n FROM price_upload_batches WHERE id = ?`)
    .get(confirmed.value.batch.id) as { n: number };
  assert.equal(batchGone.n, 0);

  const restored = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    settings,
    input,
    now,
  );
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  const afterRestore = db
    .prepare(
      `SELECT market_date, close_decimal, observation_at FROM price_observations
       WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all();
  assert.deepEqual(afterRestore, beforeRows);
});

// ---------------------------------------------------------------------------
// B1 drills (review, BLOCKING, 2026-08-21): attribution is stamped on
// INSERT only, never reassigned by an overlay -- these are the reviewer's
// own two repro shapes, pinned as tests.
// ---------------------------------------------------------------------------

test("MKT-008 B1 drill (a): a Sharesight-accreted row overlaid by a backup import, then that backup deleted, SURVIVES with the backup's overlaid value", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);

  // Sharesight's OWN accretion write, direct insert mirroring
  // sharesight-price-refresh.ts's shape -- upload_batch_id is NULL, never
  // attributed to any upload; this observation cannot be re-fetched (no
  // historical backfill, MARKET_DATA_STRATEGY §17).
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'FMG', '2026-01-01', 'candidate');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES ('price-sharesight-a', 'sharesight', 'user', 'user-a', 'user-a', 'mapping-sharesight-a', 'security-a', 'delayed', '2026-08-20T09:00:00Z', '2026-08-20', '+10:00', 'AUD', '19.42', 'raw', 'observed', '2026-08-20T09:01:00Z');
  `);

  const backupCsv =
    [
      "format_version,provider_id,source_label,provider_symbol,provider_exchange,currency_code,market_date,price_decimal,observation_at,market_timezone,interval,quality,adjustment_state,delayed_minutes",
      `${PRICE_BACKUP_FORMAT_VERSION},sharesight,backup-reimport,FMG,ASX,AUD,2026-08-20,20.50,2026-08-20T09:30:00.000Z,+10:00,delayed,observed,raw,`,
    ].join("\n") + "\n";

  const restored = await confirmBackupPriceUpload(
    context(client, "user-a"),
    bytesOf(backupCsv),
    { filename: "backup.csv" },
    () => "2026-08-21T00:00:00.000Z",
  );
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.value.written, 1);
  // Overlay only -- this backup CREATED nothing (the row already existed).
  assert.equal(restored.value.batch.insertedRowCount, 0);

  const overlaid = db
    .prepare(
      `SELECT close_decimal, upload_batch_id FROM price_observations WHERE id = 'price-sharesight-a'`,
    )
    .get() as Record<string, unknown>;
  assert.equal(overlaid.close_decimal, "20.50");
  // Attribution stays NULL -- this backup never CREATED the row, only
  // overlaid it.
  assert.equal(overlaid.upload_batch_id, null);

  const deleted = await deleteOwnedPriceUpload(
    context(client, "user-a"),
    restored.value.batch.id,
  );
  assert.equal(deleted.ok, true);
  if (deleted.ok) assert.equal(deleted.deletedObservations, 0);

  const survivor = db
    .prepare(
      `SELECT close_decimal FROM price_observations WHERE id = 'price-sharesight-a'`,
    )
    .get() as Record<string, unknown> | undefined;
  assert.ok(
    survivor,
    "the Sharesight row must survive deleting the overlaying backup",
  );
  // Honest: the overlaid VALUE is not reverted -- only attribution is
  // correct. This is documented, not a bug.
  assert.equal(survivor!.close_decimal, "20.50");
});

test("MKT-008 B1 drill (b): import A, overlay B, delete B -- A's rows are intact including the overlaid date (carrying B's value); B's own new date is gone", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const settings = { exchangeAlias: "ASX", currencyCode: "AUD" };
  const now = () => "2026-08-20T00:00:00.000Z";

  const uploadA = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf("DateTime,FMG\n1998-03-12,0.07852\n1998-03-13,0.08\n"),
    settings,
    { filename: "a.csv", sourceLabel: "upload-a" },
    now,
  );
  assert.equal(uploadA.ok, true);
  if (!uploadA.ok) return;
  assert.equal(uploadA.value.batch.insertedRowCount, 2);

  // B overlays 1998-03-13 (A's date, different price) and creates a brand
  // new 1998-03-14.
  const uploadB = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf("DateTime,FMG\n1998-03-13,0.09\n1998-03-14,0.10\n"),
    settings,
    { filename: "b.csv", sourceLabel: "upload-b" },
    now,
  );
  assert.equal(uploadB.ok, true);
  if (!uploadB.ok) return;
  assert.equal(uploadB.value.written, 2);
  // Only 1998-03-14 is newly created by B -- 1998-03-13 already existed.
  assert.equal(uploadB.value.batch.insertedRowCount, 1);

  const deleted = await deleteOwnedPriceUpload(
    context(client, "user-a"),
    uploadB.value.batch.id,
  );
  assert.equal(deleted.ok, true);
  // Exactly the ONE row B created (1998-03-14) is removed.
  if (deleted.ok) assert.equal(deleted.deletedObservations, 1);

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal, upload_batch_id FROM price_observations
       WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => row.market_date),
    ["1998-03-12", "1998-03-13"],
  );
  // 1998-03-12: never touched by B.
  assert.equal(rows[0]!.close_decimal, "0.07852");
  assert.equal(rows[0]!.upload_batch_id, uploadA.value.batch.id);
  // 1998-03-13: still attributed to A (never reassigned to B), but carries
  // B's overlaid value -- not reverted by B's deletion.
  assert.equal(rows[1]!.close_decimal, "0.09");
  assert.equal(rows[1]!.upload_batch_id, uploadA.value.batch.id);
});

test("MKT-008 backup preview: a per-reason malformed breakdown and B3's exchange-mismatch bucket are both surfaced (never a single opaque count)", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const header =
    "format_version,provider_id,source_label,provider_symbol,provider_exchange,currency_code,market_date,price_decimal,observation_at,market_timezone,interval,quality,adjustment_state,delayed_minutes";
  const rows = [
    // Valid, matched row.
    `${PRICE_BACKUP_FORMAT_VERSION},owner-import,intelligent-investor,FMG,ASX,AUD,1998-03-12,0.07852,1998-03-11T13:00:00.000Z,Australia/Sydney,eod,observed,raw,`,
    // Malformed: bad price.
    `${PRICE_BACKUP_FORMAT_VERSION},owner-import,intelligent-investor,FMG,ASX,AUD,1998-03-13,-1,1998-03-12T13:00:00.000Z,Australia/Sydney,eod,observed,raw,`,
    // Malformed: unknown provider.
    `${PRICE_BACKUP_FORMAT_VERSION},not-a-real-provider,intelligent-investor,FMG,ASX,AUD,1998-03-14,1.00,1998-03-13T13:00:00.000Z,Australia/Sydney,eod,observed,raw,`,
    // Well-formed row, but the ticker is held on a different exchange.
    `${PRICE_BACKUP_FORMAT_VERSION},owner-import,intelligent-investor,FMG,NASDAQ,AUD,1998-03-15,1.00,1998-03-14T13:00:00.000Z,Australia/Sydney,eod,observed,raw,`,
  ];
  const csv = [header, ...rows].join("\n") + "\n";
  const preview = await previewBackupPriceUpload(
    context(client, "user-a"),
    bytesOf(csv),
  );
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.preview.malformedCount, 2);
  assert.deepEqual(preview.preview.malformedByReason, {
    invalid_price: 1,
    unknown_provider: 1,
  });
  assert.equal(preview.preview.exchangeMismatchSymbols.length, 1);
  assert.match(
    preview.preview.exchangeMismatchSymbols[0]!,
    /held on ASX, not NASDAQ/,
  );
  assert.equal(preview.preview.rowCount, 1);
});

test("MKT-008 export -> wipe -> import-backup: a full round trip is lossless and preserves each row's ORIGINAL provider (never relabelled)", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);

  // An owner-import row (via the normal write path).
  const confirmed = await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-20T00:00:00.000Z",
  );
  assert.equal(confirmed.ok, true);

  // A Sharesight-sourced row for the SAME owner's security, inserted
  // directly (mirrors `sharesight-price-refresh.ts`'s own write shape) --
  // proves the export/reimport round trip handles more than one provider
  // and preserves each row's own provider on the way back in.
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'FMG', '2026-01-01', 'candidate');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES ('price-sharesight-a', 'sharesight', 'user', 'user-a', 'user-a', 'mapping-sharesight-a', 'security-a', 'delayed', '2026-08-20T09:00:00Z', '2026-08-20', '+10:00', 'AUD', '19.42', 'raw', 'observed', '2026-08-20T09:01:00Z');
  `);

  const beforeWipe = db
    .prepare(
      `SELECT provider_id, security_id, market_date, close_decimal, observation_at, currency_code, interval, quality, adjustment_state
       FROM price_observations WHERE access_scope = 'user' AND scope_user_id = 'user-a'
       ORDER BY provider_id, market_date`,
    )
    .all();
  assert.equal(beforeWipe.length, 3);

  const csv = await exportOwnerPriceHistoryCsv(context(client, "user-a"));
  assert.match(csv, /owner-import/);
  assert.match(csv, /sharesight/);

  // Wipe -- simulate data loss.
  db.exec(
    `DELETE FROM price_observations WHERE access_scope = 'user' AND scope_user_id = 'user-a';`,
  );
  const afterWipe = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE scope_user_id = 'user-a'`,
    )
    .get() as { n: number };
  assert.equal(afterWipe.n, 0);

  const backupPreview = await previewBackupPriceUpload(
    context(client, "user-a"),
    bytesOf(csv),
  );
  assert.equal(backupPreview.ok, true);
  if (backupPreview.ok) {
    assert.equal(backupPreview.preview.rowCount, 3);
    assert.equal(backupPreview.preview.malformedCount, 0);
    assert.equal(backupPreview.preview.unresolvedRowCount, 0);
  }

  const restored = await confirmBackupPriceUpload(
    context(client, "user-a"),
    bytesOf(csv),
    { filename: "backup.csv" },
    () => "2026-08-21T00:00:00.000Z",
  );
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.value.written, 3);
  assert.equal(restored.value.unresolvedRowCount, 0);

  const afterRestore = db
    .prepare(
      `SELECT provider_id, security_id, market_date, close_decimal, observation_at, currency_code, interval, quality, adjustment_state
       FROM price_observations WHERE access_scope = 'user' AND scope_user_id = 'user-a'
       ORDER BY provider_id, market_date`,
    )
    .all();
  assert.deepEqual(afterRestore, beforeWipe);

  // Provider preservation: the Sharesight row re-imports as provider
  // 'sharesight', never relabelled 'owner-import'.
  const sharesightRow = (
    afterRestore as { provider_id: string; close_decimal: string }[]
  ).find((row) => row.provider_id === "sharesight");
  assert.ok(sharesightRow);
  assert.equal(sharesightRow!.close_decimal, "19.42");
});

test("MKT-008 export scope: only the owner's own user-scoped rows export -- never another owner's, never deployment-scoped rows", async () => {
  const db = await ownedFixture();
  db.exec(`
    INSERT INTO market_data_providers (id, code, name, status, capabilities_json, rate_limit_json)
      VALUES ('yahoo-fixture', 'yahoo-fixture', 'Fixture', 'enabled', '{}', '{}');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-deployment-a', 'security-a', 'yahoo-fixture', 'ASX', 'FMG', '2026-01-01', 'verified');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES ('price-deployment-a', 'yahoo-fixture', 'deployment', NULL, 'deployment', 'mapping-deployment-a', 'security-a', 'eod', '2026-08-20T06:00:00Z', '2026-08-20', 'UTC', 'AUD', '20.00', 'raw', 'observed', '2026-08-20T06:05:00Z');
  `);
  const client = createSqliteSqlClient(db);
  await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-20T00:00:00.000Z",
  );
  const rowsForA = await loadOwnerPriceExportRows(client, "user-a");
  assert.equal(rowsForA.length, 2);
  assert.ok(rowsForA.every((row) => row.providerId === "owner-import"));
  const rowsForB = await loadOwnerPriceExportRows(client, "user-b");
  assert.deepEqual(rowsForB, []);
});

test("MKT-008 listing: past uploads are owner-scoped and never leak across owners", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  await confirmSinglePriceUpload(
    context(client, "user-a"),
    bytesOf(SINGLE_CSV),
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "fmg.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-20T00:00:00.000Z",
  );
  const forA = await listOwnedPriceUploads(context(client, "user-a"));
  assert.equal(forA.length, 1);
  const forB = await listOwnedPriceUploads(context(client, "user-b"));
  assert.deepEqual(forB, []);
});

test("MKT-008 listing (follow-up, review 2026-08-21): the crash-window shape -- a batch whose stored inserted_row_count is still 0 but already has attributed price_observations rows -- lists the REAL live count, not the stale stored value", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);

  // Simulate a crash between `writePriceUploadObservations` and the
  // follow-up `updatePriceUploadBatchInsertedCount` call: the batch row
  // exists with `inserted_row_count = 0` (its INSERT-time default), but two
  // price_observations rows already carry its id (the write itself
  // completed).
  await createPriceUploadBatch(client, {
    id: "batch-crash-window",
    userId: "user-a",
    sourceLabel: "intelligent-investor",
    format: "single",
    filename: "fmg.csv",
    rowCount: 2,
    malformedRowCount: 0,
    now: "2026-08-20T00:00:00.000Z",
  });
  const { insertedCount } = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-crash-window",
    candidates: [
      {
        providerId: OWNER_IMPORT_PROVIDER_ID,
        securityId: "security-a",
        providerExchange: "ASX",
        providerSymbol: "FMG",
        currencyCode: "AUD",
        marketDate: "1998-03-12",
        priceDecimal: "0.07852",
        observationAt: "1998-03-11T13:00:00.000Z",
        marketTimezone: "Australia/Sydney",
        interval: "eod",
        quality: "observed",
        adjustmentState: "raw",
        delayedMinutes: null,
      },
      {
        providerId: OWNER_IMPORT_PROVIDER_ID,
        securityId: "security-a",
        providerExchange: "ASX",
        providerSymbol: "FMG",
        currencyCode: "AUD",
        marketDate: "1998-03-13",
        priceDecimal: "0.08",
        observationAt: "1998-03-12T13:00:00.000Z",
        marketTimezone: "Australia/Sydney",
        interval: "eod",
        quality: "observed",
        adjustmentState: "raw",
        delayedMinutes: null,
      },
    ],
    now: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(insertedCount, 2);
  // Deliberately DO NOT call updatePriceUploadBatchInsertedCount -- the
  // stored column is left at its INSERT-time default of 0, reproducing the
  // crash window.
  const storedColumn = db
    .prepare(
      `SELECT inserted_row_count FROM price_upload_batches WHERE id = 'batch-crash-window'`,
    )
    .get() as { inserted_row_count: number };
  assert.equal(storedColumn.inserted_row_count, 0);

  const listed = await listOwnedPriceUploads(context(client, "user-a"));
  const batch = listed.find((item) => item.id === "batch-crash-window");
  assert.ok(batch, "expected the crash-window batch to still be listed");
  // The LIVE count (2 attributed rows), not the stale stored 0 -- this is
  // exactly the number the delete dialog/list must show, since it is
  // exactly what a delete would actually remove.
  assert.equal(batch!.insertedRowCount, 2);
  // Rendered through the SAME component the real delete dialog uses (not a
  // direct import -- this file executes under plain `node --test`, which
  // cannot parse the component module's JSX; `renderComponent` below
  // shells out through `tsx`, mirroring every other render test in this
  // file).
  const dialogHtml = renderComponent("DeleteUploadDialogBody", PANEL_PATH, {
    batch,
  });
  assert.match(
    dialogHtml,
    /Removes the 2 observations this upload created\. Prices it changed on rows created elsewhere are not reverted\./,
  );
});

test("MKT-008 write path: chunking (>25 candidates) writes every row correctly across multiple batch() calls", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    providerId: OWNER_IMPORT_PROVIDER_ID,
    securityId: "security-a",
    providerExchange: "ASX",
    providerSymbol: "FMG",
    currencyCode: "AUD",
    marketDate: `2020-01-${String((index % 28) + 1).padStart(2, "0")}`,
    priceDecimal: "1.00",
    observationAt: `2020-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    marketTimezone: "Australia/Sydney",
    interval: "eod" as const,
    quality: "observed" as const,
    adjustmentState: "raw" as const,
    delayedMinutes: null,
  }));
  const result = await writePriceUploadObservations(client, {
    userId: "user-a",
    uploadBatchId: "batch-chunk-test",
    candidates,
    now: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(result.written, 30);
});

// ---------------------------------------------------------------------------
// (6) Snapshot participation: owner-import rows feed historical valuation
// (the snapshot exclusion predicate excludes ONLY provider 'sharesight').
// ---------------------------------------------------------------------------

test("MKT-008 snapshot participation: an owner-import EOD price_observations row IS selected for historical snapshot valuation", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active) VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version) VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, history_complete_from, status, created_at, updated_at, version)
      VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', '2026-08-01', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO exchanges (id, mic, name, country_code, timezone, default_currency_code, calendar_code, is_active)
      VALUES ('exchange-a', 'XASX', 'Fixture exchange', 'AU', 'Australia/Sydney', 'AUD', 'fixture', 1);
    INSERT INTO securities (id, asset_type, exchange_id, primary_currency_code, canonical_name, status, created_at, updated_at)
      VALUES ('security-a', 'equity', 'exchange-a', 'AUD', 'Example', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-owner-import-a', 'security-a', '${OWNER_IMPORT_PROVIDER_ID}', 'XASX', 'ABC', '2026-01-01', 'candidate');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
      VALUES ('holding-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO transactions (id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at, local_trade_date, quantity_decimal, unit_price_decimal, currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, fx_rate_to_base_decimal, source_type, created_by_user_id, calculation_version, created_at)
      VALUES ('trade-a', 'user-a', 'portfolio-a', 'holding-a', 'buy', 'posted', '2026-08-01T01:00:00Z', '2026-08-01', '10', '10', 'AUD', '100', '0', '0', '1', 'manual', 'user-a', 1, '2026-08-01');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES ('price-owner-import-a', '${OWNER_IMPORT_PROVIDER_ID}', 'user', 'user-a', 'user-a', 'mapping-owner-import-a', 'security-a', 'eod', '2026-08-01T08:00:00Z', '2026-08-01', 'UTC', 'AUD', '20', 'raw', 'observed', '2026-08-01T09:00:00Z');
  `);
  const sql = createSqliteSqlClient(db);
  const repository = createHistoricalSnapshotRepository(sql, {
    maxHoldingRowsPerChunk: 1,
    calendarEvidence: {
      version: 2 as const,
      calendars: [
        {
          exchangeId: "exchange-a",
          mic: "XASX",
          calendarCode: "fixture",
          timezone: "Australia/Sydney",
          validFrom: "2026-01-01",
          validTo: "2026-12-31",
          source: "fixture",
          revision: "2026-08-01",
          sessions: [
            {
              sessionId: "XASX-2026-08-01",
              marketDate: "2026-08-01",
              openAt: "2026-08-01T00:00:00Z",
              closeAt: "2026-08-01T06:00:00Z",
            },
          ],
        },
      ],
    },
  });
  const run = await repository.request("user-a", {
    id: "run-owner-import",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-01",
    calculationVersion: 1,
    reason: "historical_rebuild",
    ledgerHighWaterStart: "trade-a",
    marketDataCutoff: "2026-08-03T00:00:00Z",
    idempotencyKey: "history-owner-import",
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(
    (
      await repository.claim(
        "user-a",
        "portfolio-a",
        run.id,
        "worker-a",
        "2026-08-03T01:00:00Z",
        "2026-08-03T00:01:00Z",
      )
    ).ok,
    true,
  );
  const rebuilt = await repository.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: run.id,
    leaseOwner: "worker-a",
    currentLedgerHighWater: "trade-a",
    now: "2026-08-03T00:02:00Z",
  });
  assert.equal(rebuilt.ok && rebuilt.status, "completed");
  const series = await repository.loadSeries(
    "user-a",
    "portfolio-a",
    "2026-08-01",
    "2026-08-01",
    1,
  );
  assert.ok(series);
  // 10 shares * owner-import's close_decimal '20' = 200 -- the ONLY price
  // source in this fixture is the owner-import row, so this total is only
  // reachable if it participated in selection.
  assert.deepEqual(
    series?.points.map((point) => point.totalValueDecimal),
    ["200"],
  );
});

// ---------------------------------------------------------------------------
// (7) B2 fix (review, 2026-08-21): rendered markup, `brk-005b.test.ts`'s
// `renderComponent` pattern -- each testable state is an explicit prop on a
// small presentational component (`SinglePreviewSummary`,
// `BackupPreviewSummary`, `PriceUploadList`, `DeleteUploadDialogBody`), so a
// static `renderToStaticMarkup` pass reaches it directly, exactly like
// `SharesightSyncPanel` takes `link` as a controlled prop.
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

test("MKT-008 render: HistoricalDataPanel's default render shows the section heading, settings controls, and every sub-section heading", () => {
  const html = renderComponent("HistoricalDataPanel", PANEL_PATH, {});
  assert.match(html, /Price history import/);
  assert.match(html, />Exchange</);
  assert.match(html, />Currency</);
  assert.match(html, /Import single security/);
  assert.match(html, /Import backup/);
  assert.match(html, />Export</);
  assert.match(html, /Past uploads/);
  assert.match(html, /Loading past uploads…/);
});

test("MKT-008 render: SinglePreviewSummary shows the matched security, counts, and the overwrite consequence sentence", () => {
  const html = renderComponent("SinglePreviewSummary", PANEL_PATH, {
    preview: {
      ticker: "FMG",
      exchangeAlias: "ASX",
      currencyCode: "AUD",
      matchedSecurityId: "security-a",
      matchedName: "Fortescue",
      rowCount: 2,
      malformedCount: 1,
      dateFrom: "1998-03-12",
      dateTo: "1998-03-13",
      sampleFirst: { marketDate: "1998-03-12", priceDecimal: "0.07852" },
      sampleLast: { marketDate: "1998-03-13", priceDecimal: "0.08" },
    },
  });
  assert.match(html, /FMG/);
  assert.match(html, /Fortescue/);
  assert.match(html, /2 valid row\(s\)/);
  assert.match(html, /1 malformed row\(s\) will be skipped/);
  assert.match(html, /Confirming will write these observations for Fortescue/);
});

test("MKT-008 render: BackupPreviewSummary shows per-provider counts, the malformed-reason breakdown, and the exchange-mismatch bucket separately from ambiguous", () => {
  const html = renderComponent("BackupPreviewSummary", PANEL_PATH, {
    preview: {
      rowCount: 3,
      malformedCount: 2,
      malformedByReason: { invalid_price: 1, unknown_provider: 1 },
      unresolvedRowCount: 1,
      perProvider: [
        { providerId: "owner-import", securityCount: 1, rowCount: 2 },
        { providerId: "sharesight", securityCount: 1, rowCount: 1 },
      ],
      unresolvedSymbols: ["ZZZ (ASX)"],
      ambiguousSymbols: ["DEF (ASX)"],
      exchangeMismatchSymbols: ["FMG: held on ASX, not NASDAQ"],
    },
  });
  assert.match(html, /3 row\(s\) ready to restore/);
  assert.match(html, /2 malformed row\(s\) will be skipped/);
  assert.match(html, /1 invalid price/);
  assert.match(html, /1 unknown provider/);
  assert.match(html, /owner-import: 1 security\(ies\), 2 row\(s\)/);
  assert.match(html, /sharesight: 1 security\(ies\), 1 row\(s\)/);
  assert.match(html, /ZZZ \(ASX\)/);
  assert.match(html, /FMG: held on ASX, not NASDAQ/);
  assert.match(html, /DEF \(ASX\)/);
  assert.match(html, /Confirming will overwrite any existing observation/);
});

test("MKT-008 render (B1): DeleteUploadDialogBody quotes the corrected consequence copy naming the real inserted-row count, never the ledger-reversal-style wording", () => {
  const html = renderComponent("DeleteUploadDialogBody", PANEL_PATH, {
    batch: {
      id: "batch-a",
      sourceLabel: "intelligent-investor",
      format: "single",
      filename: "fmg.csv",
      rowCount: 5,
      insertedRowCount: 3,
      malformedRowCount: 0,
      createdAt: "2026-08-20T00:00:00.000Z",
    },
  });
  assert.match(html, /Delete this upload/);
  assert.match(
    html,
    /Removes the 3 observations this upload created\. Prices it changed on rows created elsewhere are not reverted\./,
  );
  assert.doesNotMatch(
    html,
    /removes every price observation this upload wrote/i,
  );
});

test("MKT-008 render: PriceUploadList renders the honest 'No uploads yet.' empty state, the loading state, and a populated row with the created-vs-total label when they differ", () => {
  const loading = renderComponent("PriceUploadList", PANEL_PATH, {
    batches: null,
    batchesError: null,
    deletePending: null,
    onDeleteClick: () => {},
  });
  assert.match(loading, /Loading past uploads…/);

  const empty = renderComponent("PriceUploadList", PANEL_PATH, {
    batches: [],
    batchesError: null,
    deletePending: null,
    onDeleteClick: () => {},
  });
  assert.match(empty, /No uploads yet\./);

  const populated = renderComponent("PriceUploadList", PANEL_PATH, {
    batches: [
      {
        id: "batch-a",
        sourceLabel: "intelligent-investor",
        format: "single",
        filename: "fmg.csv",
        rowCount: 5,
        insertedRowCount: 3,
        malformedRowCount: 1,
        createdAt: "2026-08-20T00:00:00.000Z",
      },
      {
        id: "batch-b",
        sourceLabel: "intelligent-investor",
        format: "single",
        filename: "abc.csv",
        rowCount: 2,
        insertedRowCount: 2,
        malformedRowCount: 0,
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    ],
    batchesError: null,
    deletePending: null,
    onDeleteClick: () => {},
  });
  assert.match(populated, /fmg\.csv/);
  // Differ (5 total, 3 created) -- both numbers shown.
  assert.match(populated, /5 row\(s\) \(3 created, 2 overlaid existing rows\)/);
  // Equal (2 total, 2 created) -- the simple form, no parenthetical.
  assert.match(
    populated,
    /abc\.csv \(single, intelligent-investor\) — 2 row\(s\) · /,
  );
});

// ---------------------------------------------------------------------------
// (8) CSRF + QA-001A matrix self-check.
// ---------------------------------------------------------------------------

test("MKT-008: every mutating price-upload route calls rejectCrossSiteMutation before any other work", () => {
  const urls = [
    "https://app.example/api/market-data/price-uploads/preview",
    "https://app.example/api/market-data/price-uploads/confirm",
    "https://app.example/api/market-data/price-uploads/backup/preview",
    "https://app.example/api/market-data/price-uploads/backup/confirm",
    "https://app.example/api/market-data/price-uploads/batch-a",
  ];
  for (const url of urls) {
    const response = rejectCrossSiteMutation(
      new Request(url, {
        method: url.endsWith("/batch-a") ? "DELETE" : "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    assert.equal(response?.status, 403);
    assert.equal(response?.headers.get("cache-control"), "private, no-store");
  }
});

test("MKT-008: the QA-001A matrix records every new price-upload route", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/api/market-data/price-uploads/preview",
    "/api/market-data/price-uploads/confirm",
    "/api/market-data/price-uploads/backup/preview",
    "/api/market-data/price-uploads/backup/confirm",
    "/api/market-data/price-uploads/export",
    "/api/market-data/price-uploads/:batchId",
    "tests/mkt-008.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("MKT-008: every matrix citation naming tests/mkt-008.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/mkt-008.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/mkt-008\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/mkt-008.test.ts, but that title is not a literal substring of the file's source (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 1, "expected at least 1 quoted title to check");
});
