/**
 * BUG-022 -- `db/repositories/dividends.ts`'s owner-facing manual-entry
 * (`create()`) and correction (`supersede()`) writers bounded their five
 * `dividend_manual_records` amount columns at FORM only
 * (`isPositiveDecimalString`/`isNonNegativeDecimalString`), never at SIZE.
 * BUG-014 already bounded the import-commit writer
 * (`buildDividendManualRecordImportInsertStatements`) at the read path's own
 * `parseDecimal` limits (`isWithinReadPathDecimalBounds`,
 * `DECIMAL_LIMITS.inputScale`/`inputDigits` = 24/64) after a 30-fractional-
 * digit Sharesight total committed cleanly and then crashed `/income`
 * forever -- this task closes the SAME hole at the two writers BUG-014
 * explicitly left open (its own final review: "the bundle-restore path
 * shares the bounded builder only on its `wasImported` branch -- its other
 * branch goes through `create()` and is covered by BUG-022").
 *
 * `validateManualRecordAmounts`/`resolveSupersedeAmounts` now apply the same
 * `isWithinReadPathDecimalBounds` bound `create()`/`supersede()` share, so
 * this file also covers the bundle-restore `create()` branch
 * (`app/portfolio-bundle-service.ts:~774`/`~1980`) without needing to touch
 * that file at all -- it calls the same repository function.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import {
  buildDividendManualRecordImportInsertStatements,
  createDividendManualRecordRepository,
} from "../db/repositories/dividends.ts";
import {
  saveDividendEntryWithContext,
  type DividendActionContext,
} from "../app/dividend-assumptions-actions.ts";
import {
  createImportReconciliationPreview,
  type ImportPreviewPortfolio,
  type ImportPreviewSecurityCandidate,
  type ImportReconciliationRow,
} from "../domain/imports/reconciliation.ts";
import type { NormalizedImportRow } from "../domain/imports/strict-versioned-parser.ts";

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

async function fixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa1','buy','posted','2026-01-01T00:00:00Z','2026-01-01','100','5','AUD','500','0','0','manual','a',1,'2026-01-01');
  `);
  return db;
}

function contextFor(
  client: ReturnType<typeof createSqliteSqlClient>,
  userId: string,
): DividendActionContext {
  return { client, userId, requestId: "req-1" };
}

// `DECIMAL_LIMITS.inputScale` is 24 -- 25 fractional digits exceeds
// `parseDecimal`'s bound while remaining a syntactically well-formed decimal
// string (`isPositiveDecimalString`/`isNonNegativeDecimalString` both accept
// it -- form only, not size).
const OVER_SCALE_25DP = `0.${"1".repeat(25)}`;
// Exactly `DECIMAL_LIMITS.inputScale` (24) -- must be ACCEPTED (no
// over-tightening).
const IN_BOUND_24DP = `0.${"1".repeat(24)}`;
// `DECIMAL_LIMITS.inputDigits` is 64 total digits -- 65 digits with NO
// decimal point (scale 0, well within the 24-scale bound) isolates the
// DIGIT-COUNT half of the bound from the SCALE half: this value would pass
// every scale-only check yet still overflow `parseDecimal`'s digit limit at
// read time. TASKS.md's BUG-022 entry calls this half "currently unpinned".
const OVER_DIGITS_65 = `1${"0".repeat(64)}`;

// ---------------------------------------------------------------------------
// Writer 1: `create()` (owner-facing manual entry AND the bundle-restore
// non-`wasImported` branch, which calls this same repository function).
// ---------------------------------------------------------------------------

test("BUG-022 create() per-share mode: an in-bound (24dp) dividendPerShareDecimal is accepted", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const result = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: IN_BOUND_24DP,
    frankingCreditPerShareDecimal: null,
    requestId: "req-create-inbound",
  });
  assert.equal(result.ok, true);
});

test("BUG-022 create() per-share mode: a 25-fractional-digit dividendPerShareDecimal is rejected (invalid_input), not persisted", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const result = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: OVER_SCALE_25DP,
    frankingCreditPerShareDecimal: null,
    requestId: "req-create-overscale",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_input");
  const count = db
    .prepare(
      `SELECT COUNT(*) as count FROM dividend_manual_records WHERE user_id = 'a'`,
    )
    .get() as { count: number };
  assert.equal(count.count, 0, "nothing malformed is ever persisted");
});

test("BUG-022 create() per-share mode: a 65-total-digit sharesDecimal (scale 0, past DECIMAL_LIMITS.inputDigits) is rejected -- the digit-count half of the bound, distinct from scale", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const result = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: OVER_DIGITS_65,
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    requestId: "req-create-overdigits",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_input");
});

test("BUG-022 create() totals mode: a 25-fractional-digit totalCashDecimal is rejected, and a 65-total-digit totalFrankingDecimal is rejected -- neither is persisted", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);

  const overScaleCash = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    totalCashDecimal: OVER_SCALE_25DP,
    totalFrankingDecimal: null,
    requestId: "req-create-totals-overscale",
  });
  assert.equal(overScaleCash.ok, false);
  if (overScaleCash.ok) return;
  assert.equal(overScaleCash.reason, "invalid_input");

  const overDigitsFranking = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    totalCashDecimal: "10.00",
    totalFrankingDecimal: OVER_DIGITS_65,
    requestId: "req-create-totals-overdigits-franking",
  });
  assert.equal(overDigitsFranking.ok, false);
  if (overDigitsFranking.ok) return;
  assert.equal(overDigitsFranking.reason, "invalid_input");

  const count = db
    .prepare(
      `SELECT COUNT(*) as count FROM dividend_manual_records WHERE user_id = 'a'`,
    )
    .get() as { count: number };
  assert.equal(count.count, 0, "nothing malformed is ever persisted");
});

// ---------------------------------------------------------------------------
// Writer 2: `supersede()` (the DIV-016 correction/edit path).
// ---------------------------------------------------------------------------

async function createInBoundRecord(
  client: ReturnType<typeof createSqliteSqlClient>,
): Promise<{ id: string; version: number }> {
  const repository = createDividendManualRecordRepository(client);
  const created = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    requestId: "req-seed",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("expected the seed record to be created");
  return { id: created.record.id, version: created.record.version };
}

test("BUG-022 supersede() per-share mode: an in-bound (24dp) correction is accepted", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const seed = await createInBoundRecord(client);
  const result = await repository.supersede("a", "pa", seed.id, {
    dividendPerShareDecimal: IN_BOUND_24DP,
    expectedVersion: seed.version,
    requestId: "req-supersede-inbound",
  });
  assert.equal(result.ok, true);
});

test("BUG-022 supersede() per-share mode: a 25-fractional-digit correction is rejected (invalid_input), the original stays un-superseded", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const seed = await createInBoundRecord(client);
  const result = await repository.supersede("a", "pa", seed.id, {
    dividendPerShareDecimal: OVER_SCALE_25DP,
    expectedVersion: seed.version,
    requestId: "req-supersede-overscale",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_input");
  const original = await repository.get("a", "pa", seed.id);
  assert.equal(
    original?.supersededByRecordId,
    null,
    "a rejected correction must never mark the original superseded",
  );
});

test("BUG-022 supersede() totals mode: a 65-total-digit totalCashDecimal is rejected -- the digit-count half of the bound", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const seed = await createInBoundRecord(client);
  const result = await repository.supersede("a", "pa", seed.id, {
    totalCashDecimal: OVER_DIGITS_65,
    expectedVersion: seed.version,
    requestId: "req-supersede-totals-overdigits",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_input");
});

// ---------------------------------------------------------------------------
// Form-error render: the owner-facing action layer
// (`saveDividendEntryWithContext`) must surface a FIELD-SPECIFIC, honest
// message rather than the generic repository fallback ("The dividend record
// could not be saved.") -- checked here rather than the repository directly.
// ---------------------------------------------------------------------------

test("BUG-022 form error: an over-scale totalCashDecimal in the owner-facing save action renders a field-specific error naming 'Total cash', not the generic 'could not be saved' fallback", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const result = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: OVER_SCALE_25DP,
    totalFrankingDecimal: null,
    amountMode: "totals",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.match(result.message, /Total cash/);
  assert.match(result.message, /64 digits/);
  assert.doesNotMatch(result.message, /could not be saved/);
});

test("BUG-022 form error: an over-scale dividendPerShareDecimal in the owner-facing save action names 'Dividend per share'", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const result = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: OVER_SCALE_25DP,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    amountMode: "per_share",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.match(result.message, /Dividend per share/);
});

// ---------------------------------------------------------------------------
// FX digit bound: `fx_rate_to_portfolio_decimal` had a SCALE bound
// (`MAX_FX_RATE_DECIMAL_SCALE` = 24) but no total-digit bound -- a
// 65-digit whole-number rate (scale 0) satisfied the scale check yet still
// overflows `parseDecimal`'s `DECIMAL_LIMITS.inputDigits` (64) at read
// time.
// ---------------------------------------------------------------------------

test("BUG-022 FX digit bound: a 65-digit fxRateToPortfolioDecimal (scale 0, within the 24-scale limit) is rejected by buildDividendManualRecordImportInsertStatements", () => {
  const overDigitsRate = {
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "ps-a",
    paymentDate: "2026-08-05",
    totalCashDecimal: "10",
    importBatchId: "batch-a",
    sourceReference: "import-fingerprint:row-a",
    requestId: "req-a",
    now: "2026-08-19T00:00:00.000Z",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: OVER_DIGITS_65,
    fxRateSource: "sharesight" as const,
  };
  const result =
    buildDividendManualRecordImportInsertStatements(overDigitsRate);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_input");

  // A rate within BOTH bounds (well under 64 digits, well under 24dp scale)
  // is still accepted -- no over-tightening.
  const inBoundRate = { ...overDigitsRate, fxRateToPortfolioDecimal: "1.5" };
  const accepted = buildDividendManualRecordImportInsertStatements(inBoundRate);
  assert.equal(accepted.ok, true);
});

// ---------------------------------------------------------------------------
// Preview warnings: an over-scale franking value in a STAGED row today
// stages silently, reaches `ready`, and only fails at commit with the
// generic `mapping_incomplete` copy -- these two drills add the missing
// preview-time disclosure (`DIVIDEND_RECONCILIATION_ROW_FRANKING_AMOUNT_UNAVAILABLE`).
// ---------------------------------------------------------------------------

const PORTFOLIOS: ImportPreviewPortfolio[] = [
  {
    id: "portfolio-1",
    name: "Main",
    homeCurrencyCode: "AUD",
    historyCompleteFrom: "2020-01-01",
  },
];

const SECURITY_CANDIDATES: ImportPreviewSecurityCandidate[] = [
  {
    id: "membership-1",
    portfolioId: "portfolio-1",
    sourceSymbol: "ABC",
    sourceExchangeAlias: null,
    sourceCurrencyCode: "AUD",
    securityId: "security-1",
  },
];

function dividendRowWithFranking(input: {
  rowId: string;
  totalFrankingDecimal?: string | null;
  frankingPerShare?: string | null;
  sharesOwned?: string | null;
}): ImportReconciliationRow {
  const paymentDate = "2026-08-05";
  const normalized: NormalizedImportRow = {
    id: input.rowId,
    symbol: "ABC",
    name: null,
    displaySymbol: null,
    exchange: null,
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: input.sharesOwned ?? "5",
    costPerShare: "0.50",
    commission: null,
    transactionDate: paymentDate,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "dividend",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `${paymentDate}T00:00:00Z`,
    localTradeDate: paymentDate,
    cashEvent: null,
    frankingPerShare: input.frankingPerShare ?? null,
    totalCashDecimal: null,
    totalFrankingDecimal: input.totalFrankingDecimal ?? null,
  };
  return {
    id: input.rowId,
    physicalRowNumber: 2,
    rowClass: "transaction",
    normalized,
    fingerprint: `fp-${input.rowId}`,
  };
}

test("BUG-022 preview warning: a staged dividend row with an over-scale totalFrankingDecimal warns DIVIDEND_RECONCILIATION_ROW_FRANKING_AMOUNT_UNAVAILABLE and never blocks readiness", () => {
  const row = dividendRowWithFranking({
    rowId: "row-franking-total-overscale",
    totalFrankingDecimal: OVER_SCALE_25DP,
  });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
  });
  const warning = preview.issues.find(
    (issue) =>
      issue.code === "DIVIDEND_RECONCILIATION_ROW_FRANKING_AMOUNT_UNAVAILABLE",
  );
  assert.ok(warning, "expected a visible franking warning, not a silent drop");
  assert.equal(warning!.severity, "warning");
  assert.equal(warning!.rowId, "row-franking-total-overscale");
  assert.equal(
    preview.ready,
    true,
    "an unparseable franking amount is advisory, never blocking",
  );
});

test("BUG-022 preview warning: a staged dividend row with an over-scale per-share frankingPerShare warns DIVIDEND_RECONCILIATION_ROW_FRANKING_AMOUNT_UNAVAILABLE", () => {
  const row = dividendRowWithFranking({
    rowId: "row-franking-pershare-overscale",
    frankingPerShare: OVER_SCALE_25DP,
    sharesOwned: "5",
  });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
  });
  const warning = preview.issues.find(
    (issue) =>
      issue.code === "DIVIDEND_RECONCILIATION_ROW_FRANKING_AMOUNT_UNAVAILABLE",
  );
  assert.ok(
    warning,
    "expected a visible franking warning for the per-share shape too",
  );
  assert.equal(warning!.rowId, "row-franking-pershare-overscale");
});

test("BUG-022 preview warning: a staged dividend row that simply never reports franking (both fields null) raises NO franking warning -- the pre-existing, silent, expected case is unchanged", () => {
  const row = dividendRowWithFranking({ rowId: "row-no-franking" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
  });
  assert.equal(
    preview.issues.find(
      (issue) =>
        issue.code ===
        "DIVIDEND_RECONCILIATION_ROW_FRANKING_AMOUNT_UNAVAILABLE",
    ),
    undefined,
    "genuinely missing franking data is not malformed data",
  );
});
