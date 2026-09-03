/**
 * BRK-011 — Foreign-currency dividend franking valuation.
 *
 * BRK-010 deliberately left franking credits on foreign-currency payouts
 * UNKNOWN at read time (their currency denomination on the Sharesight wire
 * is unverified). The owner's BINDING resolution cascade, in priority
 * order: (1) a Sharesight-supplied AUD franking figure, (2) an automatic
 * payment-date FX conversion reusing BRK-010's stored rate, (3) an
 * owner-entered manual conversion.
 *
 * PREREQUISITE EVIDENCE (`scripts/sharesight-franking-fx-spike.mjs`, live
 * run against the owner's real Sharesight account, 2026-08-21, routed
 * through the sealed `createSharesightClient` -- see
 * `domain/sharesight/client.ts`'s spike-only `getPayoutsRaw`): all 10 of
 * the owner's real foreign-currency (USD) payouts carry NO franking-shaped
 * field at all on the wire (`franked_amount`/`unfranked_amount`/
 * `franking_credits`/`tax_credit`/`resident_withholding_tax` all absent),
 * but every one of them is UNFRANKED -- an absent field on an unfranked
 * payout proves nothing about a franked one. The spike therefore ALSO
 * checked the documentation-derived `tax_credit` field (third-party
 * `markcatley/sharesight.rs`, "Always returned in the portfolio currency")
 * against all 61 of the owner's franked NATIVE (AUD) payouts (DIV-007's
 * established franked/unfranked split) and found it present on ZERO of
 * them either. Tier 1 is therefore UNCONFIRMED, not disproven: this is
 * real evidence the field never populates on this account's wire, but the
 * specific foreign-AND-franked combination remains untested (the owner's
 * data has no such payout), so it stops short of proof. Tier 2's
 * own-currency-denomination question stays separately, genuinely
 * INCONCLUSIVE for the simpler reason that no franked foreign payout
 * exists to test at all -- see `docs/ARCHITECTURE.md` §8.2's dated notes.
 * Per the owner's own ruling ("the evidence step may be INCONCLUSIVE --
 * record that honestly and fall through"), only tier 3 (owner-entered
 * override) is implemented; this suite covers that tier's happy path,
 * precedence over BRK-010's guard and DIV-007's derivation, provenance
 * labelling, and the unknown-when-unresolved fallback -- see
 * `docs/CALCULATIONS.md` section 11.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACCOUNT_PURGE_CONFIRMATION,
  createDividendImportFrankingOverrideRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";
import { completedExport, finishPurge, fixture } from "./fixtures/ops-003.ts";
import {
  deriveDividendHistoryForSecurity,
  type DerivedDividendRow,
  type DividendManualRecordFact,
  type FrankingResolution,
} from "../domain/dividends/index.ts";
import { saveDividendFrankingOverrideWithContext } from "../app/dividend-assumptions-actions.ts";
import { loadOwnedSecurityDividendDetail } from "../app/owned-security-dividends.ts";
import {
  frankingDisplay,
  shouldOfferFrankingOverride,
} from "../app/dividend-history-prefill.ts";

// ---------------------------------------------------------------------------
// scripts/sharesight-franking-fx-spike.mjs: fail-closed no-credentials path
// (BRK-011 review finding B1) -- mirrors tests/brk-008.test.ts's identical
// precedent for the other Sharesight spikes: run the script with no
// credentials available and confirm it fails closed, exit 1, with a clear
// message, before attempting any network call.
// ---------------------------------------------------------------------------

const spikeScriptPath = fileURLToPath(
  new URL("../scripts/sharesight-franking-fx-spike.mjs", import.meta.url),
);

function runSpikeWithoutCredentials(devVarsPath: string) {
  const env = { ...process.env };
  delete env.SHARESIGHT_CLIENT_ID;
  delete env.SHARESIGHT_CLIENT_SECRET;
  env.SHARESIGHT_DEV_VARS_PATH = devVarsPath;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", spikeScriptPath],
    { encoding: "utf8", env },
  );
}

test("BRK-011: the franking-fx spike exits 1 with a clear message when no credentials are configured (no .dev.vars file at all)", () => {
  const result = runSpikeWithoutCredentials(
    join(tmpdir(), "yieldtome-brk-011-nonexistent", ".dev.vars"),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing Sharesight credentials/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_ID/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_SECRET/);
  // Never attempted a request -- no token/portfolio output on stdout.
  assert.doesNotMatch(result.stdout, /acquire token/);
});

test("BRK-011: the franking-fx spike exits 1 with a clear message when .dev.vars exists but has no Sharesight keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldtome-brk-011-"));
  try {
    const devVarsPath = join(dir, ".dev.vars");
    await writeFile(
      devVarsPath,
      "CLOUDFLARE_ACCESS_ISSUER=http://127.0.0.1:8799\n# a comment\n\n",
    );
    const result = runSpikeWithoutCredentials(devVarsPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing Sharesight credentials/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Migration + schema shape.
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files)
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  return db;
}

async function ownedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2),('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney','2026-08-01','2026-08-01',1),
      ('b','AUD','Australia/Sydney','2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES('s','equity','AUD','RMD','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','RMD','AUD','held','2026-08-01','2026-08-01'),
      ('psb','b','pb','s','RMD','AUD','held','2026-08-01','2026-08-01');
    -- Owner-typed (per-share) row -- never eligible for an override.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,created_at,updated_at,version) VALUES
      ('owner-typed-a','a','pa','psa','2026-05-01','1','1','2026-05-01','2026-05-01',1);
    -- Imported (Sharesight) totals-mode, foreign-currency (USD) row -- the
    -- BRK-010/BRK-011 target shape.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,total_cash_decimal,total_franking_decimal,import_batch_id,currency_code,fx_rate_to_portfolio_decimal,fx_rate_source,created_at,updated_at,version) VALUES
      ('imported-a','a','pa','psa','2026-06-15',20.4,NULL,'batch-a','USD','1.5','sharesight','2026-06-15','2026-06-15',1),
      ('imported-b','b','pb','psb','2026-06-15',20.4,NULL,'batch-b','USD','1.5','sharesight','2026-06-15','2026-06-15',1);
  `);
  return db;
}

test("BRK-011: migration creates dividend_import_franking_overrides with its unique/index shape and all three purge-lock triggers", async () => {
  const db = await migratedDatabase();
  const indexNames = db
    .prepare("PRAGMA index_list('dividend_import_franking_overrides')")
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  assert.deepEqual(indexNames, [
    "dividend_import_franking_overrides_id_user_portfolio_unique",
    "dividend_import_franking_overrides_owner_portfolio_security_idx",
    "dividend_import_franking_overrides_target_unique",
  ]);
  const triggerNames = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='dividend_import_franking_overrides' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggerNames, [
    "account_purge_lock_dividend_import_franking_overrides_delete",
    "account_purge_lock_dividend_import_franking_overrides_insert",
    "account_purge_lock_dividend_import_franking_overrides_update",
  ]);
});

test("BRK-011: the target-unique index rejects a second override for the same (owner, portfolio, imported record)", async () => {
  const db = await ownedFixture();
  db.exec(
    "INSERT INTO dividend_import_franking_overrides(id,user_id,portfolio_id,portfolio_security_id,dividend_manual_record_id,franking_total_decimal,created_at,updated_at,version) VALUES('x','a','pa','psa','imported-a','1','2026-08-01','2026-08-01',1)",
  );
  assert.throws(() => {
    db.exec(
      "INSERT INTO dividend_import_franking_overrides(id,user_id,portfolio_id,portfolio_security_id,dividend_manual_record_id,franking_total_decimal,created_at,updated_at,version) VALUES('y','a','pa','psa','imported-a','2','2026-08-01','2026-08-01',1)",
    );
  }, /UNIQUE constraint failed/);
});

// ---------------------------------------------------------------------------
// Repository: ownership, imported-row precondition, validation, versioning.
// ---------------------------------------------------------------------------

test("BRK-011 repository: save() creates an override against an owned IMPORTED record", async () => {
  const db = await ownedFixture();
  const repo = createDividendImportFrankingOverrideRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "5.25",
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.override.version, 1);
  assert.equal(created.override.frankingTotalDecimal, "5.25");
  const fetched = await repo.get("a", "pa", "imported-a");
  assert.equal(fetched?.frankingTotalDecimal, "5.25");
});

test("BRK-011 repository: save() rejects an owner-typed (non-imported) manual record as not_found", async () => {
  const db = await ownedFixture();
  const repo = createDividendImportFrankingOverrideRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const result = await repo.save("a", "pa", "psa", "owner-typed-a", {
    frankingTotalDecimal: "5.25",
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_found");
});

test("BRK-011 repository: save() rejects a cross-owner imported record as not_found -- never trusts a client-supplied id", async () => {
  const db = await ownedFixture();
  const repo = createDividendImportFrankingOverrideRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const result = await repo.save("b", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "5.25",
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_found");
});

test("BRK-011 repository: save() rejects a negative franking amount", async () => {
  const db = await ownedFixture();
  const repo = createDividendImportFrankingOverrideRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const result = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "-1",
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_input");
});

test("BUG-021 correction round: save() rejects a franking override over DECIMAL_LIMITS (25 fractional digits, or 65 total digits) rather than writing a value /income cannot later read", async () => {
  const db = await ownedFixture();
  const repo = createDividendImportFrankingOverrideRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const overScale = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: `1.${"1".repeat(25)}`,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(overScale.ok, false);
  if (!overScale.ok) assert.equal(overScale.reason, "invalid_input");

  const overDigits = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "1".repeat(65),
    expectedVersion: null,
    requestId: "r2",
  });
  assert.equal(overDigits.ok, false);
  if (!overDigits.ok) assert.equal(overDigits.reason, "invalid_input");

  // Exactly at the boundary still succeeds.
  const atBoundary = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: `1.${"1".repeat(24)}`,
    expectedVersion: null,
    requestId: "r3",
  });
  assert.equal(atBoundary.ok, true);
});

test("BRK-011 repository: a duplicate create is a version_conflict; a version-guarded update succeeds and a stale version is rejected", async () => {
  const db = await ownedFixture();
  const repo = createDividendImportFrankingOverrideRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "5.25",
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const duplicate = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "9.99",
    expectedVersion: null,
    requestId: "r2",
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, "version_conflict");

  const updated = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "6.00",
    expectedVersion: created.override.version,
    requestId: "r3",
  });
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.override.version, 2);
    assert.equal(updated.override.frankingTotalDecimal, "6.00");
  }

  const stale = await repo.save("a", "pa", "psa", "imported-a", {
    frankingTotalDecimal: "7.00",
    expectedVersion: created.override.version, // stale: already advanced to 2
    requestId: "r4",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "version_conflict");
});

// ---------------------------------------------------------------------------
// Action layer (WithContext): ownership isolation at the request boundary.
// ---------------------------------------------------------------------------

test("BRK-011 action: saveDividendFrankingOverrideWithContext denies a cross-owner portfolioSecurityId/record and validates input", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const context = { client, userId: "a", requestId: "r1" };

  const missingFields = await saveDividendFrankingOverrideWithContext(
    context,
    "pa",
    { frankingTotalDecimal: "1" },
  );
  assert.equal(missingFields.ok, false);
  if (!missingFields.ok) assert.equal(missingFields.status, 400);

  const badAmount = await saveDividendFrankingOverrideWithContext(
    context,
    "pa",
    {
      portfolioSecurityId: "psa",
      dividendManualRecordId: "imported-a",
      frankingTotalDecimal: "not-a-number",
      expectedVersion: null,
    },
  );
  assert.equal(badAmount.ok, false);
  if (!badAmount.ok) assert.equal(badAmount.status, 400);

  const crossOwner = await saveDividendFrankingOverrideWithContext(
    context,
    "pb",
    {
      portfolioSecurityId: "psb",
      dividendManualRecordId: "imported-b",
      frankingTotalDecimal: "5",
      expectedVersion: null,
    },
  );
  assert.equal(crossOwner.ok, false);
  if (!crossOwner.ok) assert.equal(crossOwner.status, 404);

  const ok = await saveDividendFrankingOverrideWithContext(context, "pa", {
    portfolioSecurityId: "psa",
    dividendManualRecordId: "imported-a",
    frankingTotalDecimal: "5",
    expectedVersion: null,
  });
  assert.equal(ok.ok, true);
});

test("BUG-021 correction round: saveDividendFrankingOverrideWithContext rejects an over-bound franking amount with a field message before it ever reaches the repository", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);
  const context = { client, userId: "a", requestId: "r1" };

  const overScale = await saveDividendFrankingOverrideWithContext(
    context,
    "pa",
    {
      portfolioSecurityId: "psa",
      dividendManualRecordId: "imported-a",
      frankingTotalDecimal: `1.${"1".repeat(25)}`,
      expectedVersion: null,
    },
  );
  assert.equal(overScale.ok, false);
  if (!overScale.ok) {
    assert.equal(overScale.status, 400);
    assert.match(overScale.message, /24 decimal places/);
  }

  const overDigits = await saveDividendFrankingOverrideWithContext(
    context,
    "pa",
    {
      portfolioSecurityId: "psa",
      dividendManualRecordId: "imported-a",
      frankingTotalDecimal: "1".repeat(65),
      expectedVersion: null,
    },
  );
  assert.equal(overDigits.ok, false);
  if (!overDigits.ok) assert.equal(overDigits.status, 400);
});

// ---------------------------------------------------------------------------
// Domain layer: precedence over BRK-010's guard / DIV-007's derivation,
// provenance, and the unresolved-stays-unknown fallback.
// ---------------------------------------------------------------------------

function foreignImportedRecord(
  overrides: Partial<DividendManualRecordFact> = {},
): DividendManualRecordFact {
  return {
    id: "imported-1",
    paymentDate: "2026-06-15",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "20.4",
    totalFrankingDecimal: null,
    importBatchId: "batch-1",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5",
    fxRateSource: "sharesight",
    ...overrides,
  };
}

test("BRK-011: an owner override resolves a foreign row's franking, taking precedence over DIV-007's absent-value derivation, with owner_manual provenance", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-a",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      foreignImportedRecord({ frankingOverrideTotalDecimal: "3.50" }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.frankingTotalDecimal, "3.50");
  assert.equal(row.frankingCurrencySource, "owner_manual");
  assert.equal(
    row.frankingDerivedZero,
    false,
    "must not ALSO read as DIV-007's inference",
  );
  assert.equal(
    row.cashDecimal,
    "30.6",
    "cash conversion (20.4 USD * 1.5 rate) is unaffected by the franking override",
  );
});

test("BRK-011: an owner override on a NONZERO-foreign row takes precedence over BRK-010's unverified-currency guard, which would otherwise null it", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-b",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      foreignImportedRecord({
        id: "imported-2",
        totalFrankingDecimal: "3.21", // present, nonzero, foreign -- BRK-010 guard would null this
        frankingOverrideTotalDecimal: "4.00", // owner's deliberate resolution wins instead
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.frankingTotalDecimal, "4.00");
  assert.equal(rows[0]?.frankingCurrencySource, "owner_manual");
});

test("BRK-011: with no override, BRK-010's guard and DIV-007's derivation behave exactly as before (legacy rows unchanged)", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-c",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      foreignImportedRecord({ id: "absent-row" }), // no override, absent franking -> DIV-007 $0
      foreignImportedRecord({
        id: "nonzero-row",
        totalFrankingDecimal: "3.21", // no override, present nonzero -> BRK-010 guard nulls it
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  const absent = rows.find((row) => row.id === "imported:absent-row");
  assert.equal(absent?.frankingTotalDecimal, "0");
  assert.equal(absent?.frankingDerivedZero, true);
  assert.equal(absent?.frankingCurrencySource, null);

  const nonzero = rows.find((row) => row.id === "imported:nonzero-row");
  assert.equal(nonzero?.frankingTotalDecimal, null, "still genuinely unknown");
  assert.equal(nonzero?.frankingCurrencySource, null);
});

test("BRK-011: an override survives into dominatedImported when a higher tier (owner-typed manual record) wins the same row", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-d",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "owner-typed-1",
        paymentDate: "2026-06-16", // within DIV-004/DIV-005's proximity window of the imported row
        sharesDecimal: "10",
        dividendPerShareDecimal: "1",
        frankingCreditPerShareDecimal: null,
        importBatchId: null,
      },
      foreignImportedRecord({
        id: "imported-dominated",
        paymentDate: "2026-06-15",
        frankingOverrideTotalDecimal: "3.50",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.source, "manual");
  assert.equal(row.dominatedImported?.frankingCurrencySource, "owner_manual");
  assert.equal(row.dominatedImported?.totalFrankingDecimal, "3.50");
});

// ---------------------------------------------------------------------------
// OPS-003 export/purge coverage, extending the shared fixture (see
// tests/fixtures/ops-003.ts's BRK-011 seed rows).
// ---------------------------------------------------------------------------

test("BRK-011: purge-lock trigger fires for dividend_import_franking_overrides while a purge job is active; the other owner is unaffected", async () => {
  const db = await fixture();
  const { repo } = await completedExport(db);
  const started = await repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(started.ok, true);
  assert.throws(
    () =>
      db.exec(
        "UPDATE dividend_import_franking_overrides SET franking_total_decimal='9' WHERE id='difoa'",
      ),
    /account_purge_source_locked/,
  );
  db.exec(
    "UPDATE dividend_import_franking_overrides SET franking_total_decimal='9' WHERE id='difob'",
  );
  assert.equal(
    db
      .prepare(
        "SELECT franking_total_decimal FROM dividend_import_franking_overrides WHERE id='difob'",
      )
      .get()?.franking_total_decimal,
    "9",
  );
});

test("BRK-011: purge deletes dividend_import_franking_overrides for the purged user only; the other owner's row survives", async () => {
  const db = await fixture();
  await completedExport(db);
  const result = await finishPurge(db);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "purged");
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM dividend_import_franking_overrides WHERE user_id='a'",
      )
      .get()?.n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM dividend_import_franking_overrides WHERE user_id='b'",
      )
      .get()?.n,
    1,
  );
});

// ---------------------------------------------------------------------------
// QA-001A matrix coverage.
// ---------------------------------------------------------------------------

test("BRK-011: the QA-001A matrix records the new dividend-franking-override route", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  assert.ok(
    matrix.includes("/api/portfolios/:portfolioId/dividend-franking-override"),
  );
  assert.ok(matrix.includes("tests/brk-011.test.ts"));
});

test("BRK-011: every matrix citation naming tests/brk-011.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, selfSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/brk-011.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/brk-011\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      const title = quoted.slice(1, -1);
      assert.ok(
        selfSource.includes(title),
        `matrix cites "${title}" in tests/brk-011.test.ts, but that title is not a literal substring of this file's source`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least one citation group to check");
});

// ---------------------------------------------------------------------------
// UI: the override entry point actually renders on the Dividends tab.
// ---------------------------------------------------------------------------

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

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
    ${ROUTER_STUB_IMPORT}
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(${componentName}, props),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

function franking(
  source: "override" | "default" | "unknown",
  value: string | null,
): FrankingResolution {
  if (source === "unknown") return { source: "unknown", perShareDecimal: null };
  return { source, perShareDecimal: value as string };
}

function row(overrides: Partial<DerivedDividendRow>): DerivedDividendRow {
  return {
    id: "de1",
    portfolioSecurityId: "psa1",
    dividendEventId: "de1",
    kind: "cash",
    currencyCode: "AUD",
    exDate: "2026-06-01",
    paymentDate: "2026-06-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "1.50",
    cashDecimal: "150",
    franking: franking("override", "0.30"),
    frankingTotalDecimal: "30",
    grossDecimal: "180",
    grossIncludesFranking: true,
    status: "ex_date_passed",
    source: "edited",
    excluded: false,
    amountUnknown: false,
    providerGrossPerShareDecimal: "1.00",
    dominatedReceipt: null,
    dominatedImported: null,
    additionalReceiptsCount: 0,
    additionalImportedCount: 0,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
    frankingDerivedZero: false,
    frankingCurrencySource: null,
    ...overrides,
  };
}

const sampleLifetimeTotals = {
  currencyCode: "AUD",
  status: "ok" as const,
  rowCount: 1,
  excludedCount: 0,
  unknownAmountCount: 0,
  receivedCashDecimal: "150",
  receivedFrankingKnownDecimal: "30",
  receivedFrankingUnknownCount: 0,
  receivedGrossDecimal: "180",
  pendingCashDecimal: null,
  pendingFrankingKnownDecimal: null,
  pendingFrankingUnknownCount: 0,
  pendingGrossDecimal: null,
  pendingCount: 0,
};

const baseTabProps = {
  portfolioId: "pa",
  portfolioSecurityId: "psa1",
  symbol: "RMD",
  currencyCode: "AUD",
  today: "2026-08-19",
  filteredArtifactCount: 0,
  lifetimeTotals: sampleLifetimeTotals,
  overridesByEventId: {},
  manualRecordsById: {},
  frankingOverridesByManualRecordId: {},
  assumptions: {
    dividendYieldPercentDecimal: null,
    frankingPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    version: 1,
  },
  portfolioAssumptions: {
    valueGrowthPercentDecimal: null,
    portfolioDividendGrowthPercentDecimal: null,
    version: null,
  },
  holdingsHref: "/portfolio/pa/holdings",
};

// B3 (review finding): `currencyCode` here is deliberately DIFFERENT from
// `baseTabProps.currencyCode` ("AUD", the security's own currency) --
// mirroring BRK-010 case C, a degraded/unconverted foreign payout whose row
// displays its TRUE payout currency (USD), not the security's. The override
// form must name/save in THIS currency (`row.currencyCode`), never the
// security-currency prop, or the owner would be told to enter a figure in
// the wrong money.
const unresolvedForeignImportedRow = row({
  id: "imported:rec-1",
  dividendEventId: null,
  source: "imported",
  currencyCode: "USD",
  franking: { source: "unknown", perShareDecimal: null },
  frankingTotalDecimal: null,
  frankingCurrencySource: null,
  dividendPerShareDecimal: null,
  sharesDecimal: null,
  cashDecimal: "20.4",
  grossDecimal: "20.4",
  grossIncludesFranking: false,
  paymentDate: "2026-06-15",
});

test("BRK-011 UI: an unresolved foreign-currency imported row offers 'Enter franking', with the payment date already shown on the row", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [unresolvedForeignImportedRow] },
  );
  assert.match(html, /Enter franking/);
  assert.match(html, /2026-06-15/);
});

// The instructions/payment-date copy inside the toggled-open inline form is
// only reachable via a click event `renderToStaticMarkup` cannot simulate
// (the form is genuinely `{isOpen ? ... : null}`, mirroring
// `RecordDividendDialog`'s own `{recordDialogOpen ? ... : null}` gate) --
// verified by direct source inspection instead, the same technique the
// CSRF-gate checks above already use for handler source.
//
// B3 (review finding, money mislabel): the source must reference
// `row.currencyCode` in BOTH copy locations -- the instructions sentence
// AND the input label -- never the security-currency `currencyCode` prop,
// which can legitimately differ from what a degraded/unconverted (BRK-010
// case C) row actually displays and saves in.
test("BRK-011 UI: the inline override form's instructions name the exchange rate at the payment date and the ROW's own currency (not the security-currency prop)", async () => {
  const source = await readFile(
    new URL("../app/components/security-dividends-tab.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /exchange\s+rate\s+on\s+the\s+payment\s+date/);
  assert.match(
    source,
    /Enter\s+the\s+franking\s+credit\s+in\s+\{row\.currencyCode\}/,
  );
  assert.match(source, /Franking credit \(\{row\.currencyCode\}\)/);
  assert.match(source, /row\.paymentDate \?\? "unknown"/);
});

test("BRK-011 UI: a row with an EXISTING owner override offers 'Edit entered franking' instead", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      ...baseTabProps,
      rows: [unresolvedForeignImportedRow],
      frankingOverridesByManualRecordId: {
        "rec-1": { id: "ov-1", version: 1, frankingTotalDecimal: "3.50" },
      },
    },
  );
  assert.match(html, /Edit entered franking/);
  assert.doesNotMatch(html, />Enter franking</);
});

test("BRK-011 UI: a normal (non-imported) row never offers the franking-override entry point", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [row({})] },
  );
  assert.doesNotMatch(html, /Enter franking/);
  assert.doesNotMatch(html, /Edit entered franking/);
});

test("BRK-011 UI: a resolved imported row (known franking, no override) does not offer the entry point", () => {
  const resolved = row({
    id: "imported:rec-2",
    dividendEventId: null,
    source: "imported",
    franking: { source: "unknown", perShareDecimal: null },
    frankingTotalDecimal: "0",
    frankingDerivedZero: true,
    frankingCurrencySource: null,
    dividendPerShareDecimal: null,
    sharesDecimal: null,
  });
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [resolved] },
  );
  assert.doesNotMatch(html, /Enter franking/);
});

// ---------------------------------------------------------------------------
// F1 (review follow-up, silent no-effect override): a row whose CASH
// conversion itself failed closed (`amountUnknown: true`) must never offer
// the franking-override entry point -- `resolveImportedRecordCurrency`
// unconditionally nulls `totalFrankingDecimal` on that path REGARDLESS of
// an owner override, so saving one there would have no visible effect,
// forever.
// ---------------------------------------------------------------------------

const cashConversionFailedRow = row({
  id: "imported:rec-3",
  dividendEventId: null,
  source: "imported",
  currencyCode: "USD",
  franking: { source: "unknown", perShareDecimal: null },
  frankingTotalDecimal: null,
  frankingCurrencySource: null,
  dividendPerShareDecimal: null,
  sharesDecimal: null,
  cashDecimal: null,
  grossDecimal: null,
  grossIncludesFranking: false,
  amountUnknown: true, // the fail-closed signal this fix keys on
  paymentDate: "2026-06-15",
});

test("BRK-011 F1: shouldOfferFrankingOverride is false for a row whose cash conversion itself failed closed, even though franking also reads null", () => {
  assert.equal(shouldOfferFrankingOverride(cashConversionFailedRow), false);
  // Sanity: the identical row shape WOULD have been offered before this
  // fix -- confirms the assertion above is actually exercising the new
  // `amountUnknown` gate, not some other disqualifying condition.
  assert.equal(
    shouldOfferFrankingOverride({
      ...cashConversionFailedRow,
      amountUnknown: false,
    }),
    true,
  );
});

test("BRK-011 F1 UI: a row whose cash conversion failed closed never renders the franking-override entry point", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [cashConversionFailedRow] },
  );
  assert.doesNotMatch(html, /Enter franking/);
  assert.doesNotMatch(html, /Edit entered franking/);
});

// ---------------------------------------------------------------------------
// F2 (review follow-up, styling + save-outcome): the new
// `.dividend-franking-override-*` classes are styled in app/globals.css,
// and a real save through the action layer produces the refreshed
// "(owner-entered)" label -- the UI-014 precedent for what "save outcome"
// means for a re-derived, server-driven display string (see
// tests/ui-014.test.ts's "root cause regression, real DB-backed path" test
// for the identical technique: act through the real action, then re-derive
// through the real read service, and assert on the FRESH state).
// ---------------------------------------------------------------------------

test("BRK-011 F2: app/globals.css styles every new .dividend-franking-override-* class this task introduced", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const className of [
    ".dividend-franking-override-toggle",
    ".dividend-franking-override-form",
    ".dividend-franking-override-instructions",
  ]) {
    assert.ok(css.includes(className), `expected ${className} to be styled`);
  }
});

test("BRK-011 F2: saving a franking override through the real action/repository produces the refreshed '(owner-entered)' display label on the next read", async () => {
  const db = await ownedFixture();
  const client = createSqliteSqlClient(db);

  const before = await loadOwnedSecurityDividendDetail(
    client,
    "a",
    "pa",
    "psa",
    new Date("2026-08-19T00:00:00Z"),
  );
  const beforeRow = before.rows.find((r) => r.id === "imported:imported-a");
  assert.ok(beforeRow, "expected the imported row to appear before the save");
  // Before the override: "imported-a"'s raw franking total is ABSENT
  // (Sharesight omitted the field), so DIV-007's inference reports a
  // derived, distinctly-labelled $0 -- not "Unknown" (that would require a
  // PRESENT-but-nonzero-and-unverified figure, BRK-010's separate guard).
  assert.equal(beforeRow!.frankingDerivedZero, true);
  assert.equal(
    frankingDisplay(beforeRow!, "AUD"),
    "$0.00 total (none reported)",
  );

  const saved = await saveDividendFrankingOverrideWithContext(
    { client, userId: "a", requestId: "r1" },
    "pa",
    {
      portfolioSecurityId: "psa",
      dividendManualRecordId: "imported-a",
      frankingTotalDecimal: "3.50",
      expectedVersion: null,
    },
  );
  assert.equal(saved.ok, true);

  const after = await loadOwnedSecurityDividendDetail(
    client,
    "a",
    "pa",
    "psa",
    new Date("2026-08-19T00:00:00Z"),
  );
  const afterRow = after.rows.find((r) => r.id === "imported:imported-a");
  assert.ok(
    afterRow,
    "expected the imported row to still appear after the save",
  );
  assert.equal(afterRow!.frankingCurrencySource, "owner_manual");
  assert.match(frankingDisplay(afterRow!, "AUD"), /\(owner-entered\)/);
});
