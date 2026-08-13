/** DB-005 — corporate-action event and dividend-receipt schema. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ACCOUNT_PURGE_CONFIRMATION,
  createDividendAssumptionsRepository,
  createDividendEventOverrideRepository,
  createDividendEventRepository,
  createDividendFyOverrideRepository,
  createDividendManualRecordRepository,
  createDividendReceiptRepository,
  createSplitEventRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";
import { completedExport, finishPurge, fixture } from "./fixtures/ops-003.ts";

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

/** Minimal owned fixture: user 'a'/'b', one portfolio/security/holding each. */
async function ownedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','AUD','Shared Co','2026-08-01','2026-08-01'),
      ('s2','equity','AUD','Other Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01'),
      ('psb','b','pb','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de','s','p','cash','paid','2026-07-01','AUD','1','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','2026-07-01'),
      ('de2','s2','p','cash','paid','2026-07-01','AUD','1','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','2026-07-01');
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Constraint rejections
// ---------------------------------------------------------------------------

test("dividend_events rejects a bad kind/status enum and requires an amount for paid/declared status", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES('s','equity','AUD','Co','2026-08-01','2026-08-01');
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
  `);
  assert.throws(() => {
    db.exec(
      "INSERT INTO dividend_events(id,security_id,provider_id,kind,status,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES('bad','s','p','bogus','paid','AUD','1','2026-07-01','2026-07-01','2026-07-01')",
    );
  }, /CHECK constraint failed|dividend_events_kind_check/);
  assert.throws(() => {
    db.exec(
      "INSERT INTO dividend_events(id,security_id,provider_id,kind,status,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES('bad2','s','p','cash','bogus','AUD','1','2026-07-01','2026-07-01','2026-07-01')",
    );
  }, /CHECK constraint failed|dividend_events_status_check/);
  assert.throws(() => {
    db.exec(
      "INSERT INTO dividend_events(id,security_id,provider_id,kind,status,currency_code,observed_at,ingested_at,created_at) VALUES('bad3','s','p','cash','paid','AUD','2026-07-01','2026-07-01','2026-07-01')",
    );
  }, /CHECK constraint failed|dividend_events_amount_check/);
  // A 'declared' or 'paid' event with a gross amount is fine.
  db.exec(
    "INSERT INTO dividend_events(id,security_id,provider_id,kind,status,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES('ok','s','p','cash','declared','AUD','0.5','2026-07-01','2026-07-01','2026-07-01')",
  );
});

test("dividend_receipts CHECK constraint forbids any status other than 'actual' -- an estimate can never be stored as a receipt", async () => {
  const db = await ownedFixture();
  assert.throws(() => {
    db.exec(
      "INSERT INTO dividend_receipts(id,user_id,portfolio_id,portfolio_security_id,dividend_event_id,shares_decimal,dividend_per_share_decimal,currency_code,payment_date,status,source,created_at,updated_at,version) VALUES('r','a','pa','psa','de','1','1','AUD','2026-07-15','estimated','manual','2026-07-15','2026-07-15',1)",
    );
  }, /CHECK constraint failed|dividend_receipts_status_check/);
});

test("dividend_receipts rejects a cross-owner composite reference (holding belongs to a different owner/portfolio)", async () => {
  const db = await ownedFixture();
  assert.throws(() => {
    db.exec(
      "INSERT INTO dividend_receipts(id,user_id,portfolio_id,portfolio_security_id,dividend_event_id,shares_decimal,dividend_per_share_decimal,currency_code,payment_date,status,source,created_at,updated_at,version) VALUES('r','a','pa','psb','de','1','1','AUD','2026-07-15','actual','manual','2026-07-15','2026-07-15',1)",
    );
  }, /FOREIGN KEY constraint failed/);
});

// ---------------------------------------------------------------------------
// dividend_events / split_events revision-supersession (repository level)
// ---------------------------------------------------------------------------

test("recording a corrected dividend event supersedes the prior row without an in-place rewrite", async () => {
  const db = await ownedFixture();
  const repo = createDividendEventRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const original = await repo.get("de");
  assert.ok(original);
  const result = await repo.recordEvent({
    securityId: "s",
    providerId: "p",
    kind: "cash",
    status: "paid",
    exDate: "2026-07-01",
    currencyCode: "AUD",
    grossPerShareDecimal: "1.25",
    observedAt: "2026-08-01T00:00:00Z",
    ingestedAt: "2026-08-01T00:00:00Z",
    supersedesEventId: "de",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.supersedesEventId, "de");
  assert.equal(result.event.grossPerShareDecimal, "1.25");
  const superseded = await repo.get("de");
  assert.equal(superseded?.status, "superseded");
  // The original row's own facts are untouched -- only its status moved.
  assert.equal(
    superseded?.grossPerShareDecimal,
    original?.grossPerShareDecimal,
  );
  assert.equal(superseded?.exDate, original?.exDate);
  assert.equal(superseded?.createdAt, original?.createdAt);
  const forSecurity = await repo.listForSecurity("s");
  assert.equal(forSecurity.length, 2);
});

test("recording a dividend event supersession against an already-superseded or foreign-security event is rejected", async () => {
  const db = await ownedFixture();
  const repo = createDividendEventRepository(createSqliteSqlClient(db));
  const wrongSecurity = await repo.recordEvent({
    securityId: "s2",
    providerId: "p",
    kind: "cash",
    status: "paid",
    currencyCode: "AUD",
    grossPerShareDecimal: "1",
    observedAt: "2026-08-01T00:00:00Z",
    ingestedAt: "2026-08-01T00:00:00Z",
    supersedesEventId: "de",
  });
  assert.equal(wrongSecurity.ok, false);
  if (!wrongSecurity.ok) assert.equal(wrongSecurity.reason, "conflict");
  const first = await repo.recordEvent({
    securityId: "s",
    providerId: "p",
    kind: "cash",
    status: "paid",
    currencyCode: "AUD",
    grossPerShareDecimal: "2",
    observedAt: "2026-08-01T00:00:00Z",
    ingestedAt: "2026-08-01T00:00:00Z",
    supersedesEventId: "de",
  });
  assert.equal(first.ok, true);
  const second = await repo.recordEvent({
    securityId: "s",
    providerId: "p",
    kind: "cash",
    status: "paid",
    currencyCode: "AUD",
    grossPerShareDecimal: "3",
    observedAt: "2026-08-01T00:00:00Z",
    ingestedAt: "2026-08-01T00:00:00Z",
    supersedesEventId: "de",
  });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "conflict");
});

test("recording a split event validates positive numerator/denominator and supersedes atomically", async () => {
  const db = await ownedFixture();
  const repo = createSplitEventRepository(createSqliteSqlClient(db));
  const invalid = await repo.recordEvent({
    securityId: "s",
    providerId: "p",
    exDate: "2026-06-01",
    effectiveDate: "2026-06-02",
    numeratorDecimal: "0",
    denominatorDecimal: "1",
    status: "effective",
    observedAt: "2026-06-01T00:00:00Z",
    ingestedAt: "2026-06-01T00:00:00Z",
  });
  assert.equal(invalid.ok, false);
  const first = await repo.recordEvent({
    securityId: "s",
    providerId: "p",
    exDate: "2026-06-01",
    effectiveDate: "2026-06-02",
    numeratorDecimal: "2",
    denominatorDecimal: "1",
    status: "declared",
    observedAt: "2026-06-01T00:00:00Z",
    ingestedAt: "2026-06-01T00:00:00Z",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const corrected = await repo.recordEvent({
    securityId: "s",
    providerId: "p",
    exDate: "2026-06-01",
    effectiveDate: "2026-06-02",
    numeratorDecimal: "3",
    denominatorDecimal: "1",
    status: "effective",
    observedAt: "2026-06-05T00:00:00Z",
    ingestedAt: "2026-06-05T00:00:00Z",
    supersedesEventId: first.event.id,
  });
  assert.equal(corrected.ok, true);
  const priorRow = await repo.get(first.event.id);
  assert.equal(priorRow?.status, "superseded");
  assert.equal(priorRow?.numeratorDecimal, "2");
});

// ---------------------------------------------------------------------------
// dividend_receipts: ownership and estimated-vs-actual (repository level)
// ---------------------------------------------------------------------------

test("dividend receipts are owner/portfolio scoped: create, cross-user denial, version-guarded update/delete", async () => {
  const db = await ownedFixture();
  const repo = createDividendReceiptRepository(createSqliteSqlClient(db));
  const created = await repo.create("a", "pa", {
    portfolioSecurityId: "psa",
    dividendEventId: "de",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.50",
    frankingPerShareDecimal: null,
    currencyCode: "AUD",
    paymentDate: "2026-07-15",
    source: "manual",
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // The event belongs to security 's2', not this holding's security 's'.
  const mismatched = await repo.create("a", "pa", {
    portfolioSecurityId: "psa",
    dividendEventId: "de2",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
    currencyCode: "AUD",
    paymentDate: "2026-07-15",
    source: "manual",
    requestId: "r2",
  });
  assert.equal(mismatched.ok, false);
  // Cross-user read/update/delete must behave as not_found, never leak.
  assert.equal(await repo.get("b", "pb", created.receipt.id), null);
  const crossUpdate = await repo.update("b", "pb", created.receipt.id, {
    sharesDecimal: "999",
    expectedVersion: 1,
    requestId: "r3",
  });
  assert.equal(crossUpdate.ok, false);
  if (!crossUpdate.ok) assert.equal(crossUpdate.reason, "not_found");
  const staleUpdate = await repo.update("a", "pa", created.receipt.id, {
    sharesDecimal: "20",
    expectedVersion: 99,
    requestId: "r4",
  });
  assert.equal(staleUpdate.ok, false);
  if (!staleUpdate.ok) assert.equal(staleUpdate.reason, "version_conflict");
  const okUpdate = await repo.update("a", "pa", created.receipt.id, {
    sharesDecimal: "20",
    expectedVersion: 1,
    requestId: "r5",
  });
  assert.equal(okUpdate.ok, true);
  if (okUpdate.ok) assert.equal(okUpdate.receipt.sharesDecimal, "20");
  const crossDelete = await repo.remove("b", "pb", created.receipt.id, 2, "r6");
  assert.equal(crossDelete.ok, false);
  const deleted = await repo.remove("a", "pa", created.receipt.id, 2, "r7");
  assert.equal(deleted.ok, true);
  assert.equal(await repo.get("a", "pa", created.receipt.id), null);
});

test("dividend receipt input validation rejects non-positive shares/rate and negative franking", async () => {
  const db = await ownedFixture();
  const repo = createDividendReceiptRepository(createSqliteSqlClient(db));
  for (const bad of [
    { sharesDecimal: "0" },
    { sharesDecimal: "-1" },
    { dividendPerShareDecimal: "0" },
    { frankingPerShareDecimal: "-0.1" },
  ]) {
    const result = await repo.create("a", "pa", {
      portfolioSecurityId: "psa",
      dividendEventId: "de",
      sharesDecimal: "10",
      dividendPerShareDecimal: "0.5",
      currencyCode: "AUD",
      paymentDate: "2026-07-15",
      source: "manual",
      requestId: "bad",
      ...bad,
    });
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Assumptions / FY overrides / event overrides / manual records: upsert +
// version-guard + ownership behavior (one representative pass each).
// ---------------------------------------------------------------------------

test("dividend security and portfolio assumptions are versioned, owner-scoped, and NULL means 'fall back to provider'", async () => {
  const db = await ownedFixture();
  const repo = createDividendAssumptionsRepository(createSqliteSqlClient(db));
  const created = await repo.saveSecurityAssumptions("a", "pa", "psa", {
    dividendYieldPercentDecimal: "4.5",
    frankingPercentDecimal: "100",
    dividendGrowthPercentDecimal: null,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  // Creating again while a row already exists must fail (conflict), not
  // silently duplicate.
  const duplicate = await repo.saveSecurityAssumptions("a", "pa", "psa", {
    dividendYieldPercentDecimal: "5",
    frankingPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    expectedVersion: null,
    requestId: "r2",
  });
  assert.equal(duplicate.ok, false);
  if (!created.ok) return;
  // Full replace with an explicit null clears a field back to "unknown".
  const cleared = await repo.saveSecurityAssumptions("a", "pa", "psa", {
    dividendYieldPercentDecimal: null,
    frankingPercentDecimal: "100",
    dividendGrowthPercentDecimal: "2",
    expectedVersion: created.assumptions.version,
    requestId: "r3",
  });
  assert.equal(cleared.ok, true);
  if (cleared.ok) {
    assert.equal(cleared.assumptions.dividendYieldPercentDecimal, null);
    assert.equal(cleared.assumptions.dividendGrowthPercentDecimal, "2");
  }
  // Cross-owner: user b cannot see or touch a's assumptions row.
  assert.equal(await repo.getSecurityAssumptions("b", "pb", "psa"), null);

  const portfolioCreated = await repo.savePortfolioAssumptions("a", "pa", {
    valueGrowthPercentDecimal: "6",
    portfolioDividendGrowthPercentDecimal: "-1.5",
    expectedVersion: null,
    requestId: "r4",
  });
  assert.equal(portfolioCreated.ok, true);
  if (portfolioCreated.ok)
    assert.equal(
      portfolioCreated.assumptions.portfolioDividendGrowthPercentDecimal,
      "-1.5",
    );
});

test("dividend FY override is upserted per financial year and version-guarded", async () => {
  const db = await ownedFixture();
  const repo = createDividendFyOverrideRepository(createSqliteSqlClient(db));
  const created = await repo.save("a", "pa", 2026, {
    grossedAmountDecimal: "1000",
    frankingAmountDecimal: "300",
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  const staleUpdate = await repo.save("a", "pa", 2026, {
    grossedAmountDecimal: "1100",
    frankingAmountDecimal: "300",
    expectedVersion: 99,
    requestId: "r2",
  });
  assert.equal(staleUpdate.ok, false);
  if (!staleUpdate.ok) assert.equal(staleUpdate.reason, "version_conflict");
  const crossUser = await repo.get("b", "pb", 2026);
  assert.equal(crossUser, null);
  const removed = await repo.remove("a", "pa", 2026, 1, "r3");
  assert.equal(removed.ok, true);
});

test("dividend event override is sparse (nullable fields), keyed to one event per holding, and supports exclude", async () => {
  const db = await ownedFixture();
  const repo = createDividendEventOverrideRepository(createSqliteSqlClient(db));
  const created = await repo.save("a", "pa", "psa", "de", {
    sharesDecimal: null,
    dividendPerShareDecimal: "0.6",
    frankingCreditPerShareDecimal: null,
    exclude: false,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  const duplicate = await repo.save("a", "pa", "psa", "de", {
    sharesDecimal: "1",
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    exclude: false,
    expectedVersion: null,
    requestId: "r2",
  });
  assert.equal(duplicate.ok, false);
  if (!created.ok) return;
  const excluded = await repo.save("a", "pa", "psa", "de", {
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    exclude: true,
    expectedVersion: created.override.version,
    requestId: "r3",
  });
  assert.equal(excluded.ok, true);
  if (excluded.ok) {
    assert.equal(excluded.override.exclude, true);
    assert.equal(excluded.override.dividendPerShareDecimal, null);
  }
  // Mismatched event/security combination is rejected up front.
  const mismatched = await repo.save("a", "pa", "psa", "de2", {
    sharesDecimal: null,
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    exclude: false,
    expectedVersion: null,
    requestId: "r4",
  });
  assert.equal(mismatched.ok, false);
});

test("manual dividend records are owner-CRUD without any provider event link", async () => {
  const db = await ownedFixture();
  const repo = createDividendManualRecordRepository(createSqliteSqlClient(db));
  const created = await repo.create("a", "pa", {
    portfolioSecurityId: "psa",
    paymentDate: "2026-05-01",
    sharesDecimal: "5",
    dividendPerShareDecimal: "0.2",
    frankingCreditPerShareDecimal: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(await repo.get("b", "pb", created.record.id), null);
  const updated = await repo.update("a", "pa", created.record.id, {
    sharesDecimal: "6",
    expectedVersion: created.record.version,
    requestId: "r2",
  });
  assert.equal(updated.ok, true);
  const removed = await repo.remove(
    "a",
    "pa",
    created.record.id,
    updated.ok ? updated.record.version : 1,
    "r3",
  );
  assert.equal(removed.ok, true);
});

// ---------------------------------------------------------------------------
// Account purge/export integration (OPS-003): purge-lock triggers fire on
// every new owner table; the export/purge walk covers them; shared
// dividend_events/split_events are treated like `securities` (never purged).
// ---------------------------------------------------------------------------

test("purge-lock triggers fire for every new owner table while a purge job is active", async () => {
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
      db.exec("UPDATE dividend_receipts SET shares_decimal='9' WHERE id='dra'"),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE dividend_security_assumptions SET dividend_yield_percent_decimal='9' WHERE id='dsaa'",
      ),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE dividend_portfolio_assumptions SET value_growth_percent_decimal='9' WHERE portfolio_id='pa'",
      ),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE dividend_fy_overrides SET grossed_amount_decimal='9' WHERE id='dfoa'",
      ),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec("UPDATE dividend_event_overrides SET exclude=1 WHERE id='deoa'"),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE dividend_manual_records SET shares_decimal='9' WHERE id='dmra'",
      ),
    /account_purge_source_locked/,
  );
  // The other owner ('b') is unaffected by 'a's purge lock.
  db.exec("UPDATE dividend_receipts SET shares_decimal='9' WHERE id='drb'");
  assert.equal(
    db
      .prepare("SELECT shares_decimal FROM dividend_receipts WHERE id='drb'")
      .get()?.shares_decimal,
    "9",
  );
  // Shared, non-owner-data tables are never purge-locked, exactly like
  // `securities`.
  db.exec(
    "UPDATE dividend_events SET status='cancelled' WHERE id='de' AND status='paid'",
  );
  db.exec("UPDATE split_events SET status='cancelled' WHERE id='se'");
});

test("purge deletes the new owner tables for the purged user only; shared dividend/split events and the other owner survive", async () => {
  const db = await fixture();
  await completedExport(db);
  const result = await finishPurge(db);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "purged");
  for (const table of [
    "dividend_receipts",
    "dividend_security_assumptions",
    "dividend_portfolio_assumptions",
    "dividend_fy_overrides",
    "dividend_event_overrides",
    "dividend_manual_records",
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE user_id='a'`).get()
        ?.n,
      0,
      table,
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE user_id='b'`).get()
        ?.n,
      1,
      table,
    );
  }
  // Shared provider facts are untouched by any owner's purge (`fixture()`
  // seeds exactly one dividend_events and one split_events row).
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM dividend_events").get()?.n,
    1,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM split_events").get()?.n, 1);
});

// ---------------------------------------------------------------------------
// Review round: B1, B2, B3-adjacent follow-ups (born-superseded rejection,
// export-content coverage).
// ---------------------------------------------------------------------------

test("dividend portfolio assumptions duplicate-create is rejected as version_conflict, not a silent lost update reported as success", async () => {
  const db = await ownedFixture();
  const repo = createDividendAssumptionsRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.savePortfolioAssumptions("a", "pa", {
    valueGrowthPercentDecimal: "6",
    portfolioDividendGrowthPercentDecimal: null,
    expectedVersion: null,
    requestId: "create-1",
  });
  assert.equal(created.ok, true);
  // Reviewer probe: create "6", duplicate-create "10" -> the duplicate must
  // report failure (never the stale "6" reported as if the "10" succeeded),
  // and must not record a second create audit row.
  const duplicate = await repo.savePortfolioAssumptions("a", "pa", {
    valueGrowthPercentDecimal: "10",
    portfolioDividendGrowthPercentDecimal: null,
    expectedVersion: null,
    requestId: "create-2",
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, "version_conflict");
  const after = await repo.getPortfolioAssumptions("a", "pa");
  assert.equal(after?.valueGrowthPercentDecimal, "6");
  assert.equal(after?.version, 1);
  const auditCount = db
    .prepare(
      "SELECT COUNT(*) n FROM audit_events WHERE action='dividend.assumptions.portfolio.create' AND target_id='pa'",
    )
    .get() as { n: number };
  assert.equal(auditCount.n, 1);
});

test("dividend receipt partial update preserves franking on a shares-only edit; explicit null still clears it", async () => {
  const db = await ownedFixture();
  const repo = createDividendReceiptRepository(createSqliteSqlClient(db));
  const created = await repo.create("a", "pa", {
    portfolioSecurityId: "psa",
    dividendEventId: "de",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
    frankingPerShareDecimal: "0.3",
    currencyCode: "AUD",
    paymentDate: "2026-07-15",
    source: "manual",
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const sharesOnly = await repo.update("a", "pa", created.receipt.id, {
    sharesDecimal: "20",
    expectedVersion: created.receipt.version,
    requestId: "r2",
  });
  assert.equal(sharesOnly.ok, true);
  if (sharesOnly.ok) {
    assert.equal(sharesOnly.receipt.sharesDecimal, "20");
    assert.equal(sharesOnly.receipt.frankingPerShareDecimal, "0.3");
  }
  const cleared = sharesOnly.ok
    ? await repo.update("a", "pa", created.receipt.id, {
        frankingPerShareDecimal: null,
        expectedVersion: sharesOnly.receipt.version,
        requestId: "r3",
      })
    : null;
  assert.equal(cleared?.ok, true);
  if (cleared?.ok) assert.equal(cleared.receipt.frankingPerShareDecimal, null);
});

test("manual dividend record partial update preserves franking on a shares-only edit; explicit null still clears it", async () => {
  const db = await ownedFixture();
  const repo = createDividendManualRecordRepository(createSqliteSqlClient(db));
  const created = await repo.create("a", "pa", {
    portfolioSecurityId: "psa",
    paymentDate: "2026-05-01",
    sharesDecimal: "5",
    dividendPerShareDecimal: "0.2",
    frankingCreditPerShareDecimal: "0.06",
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const sharesOnly = await repo.update("a", "pa", created.record.id, {
    sharesDecimal: "6",
    expectedVersion: created.record.version,
    requestId: "r2",
  });
  assert.equal(sharesOnly.ok, true);
  if (sharesOnly.ok) {
    assert.equal(sharesOnly.record.sharesDecimal, "6");
    assert.equal(sharesOnly.record.frankingCreditPerShareDecimal, "0.06");
  }
  const cleared = sharesOnly.ok
    ? await repo.update("a", "pa", created.record.id, {
        frankingCreditPerShareDecimal: null,
        expectedVersion: sharesOnly.record.version,
        requestId: "r3",
      })
    : null;
  assert.equal(cleared?.ok, true);
  if (cleared?.ok)
    assert.equal(cleared.record.frankingCreditPerShareDecimal, null);
});

test("dividend event override partial update preserves franking (and other sparse fields) on a shares-only edit; explicit null still clears it", async () => {
  const db = await ownedFixture();
  const repo = createDividendEventOverrideRepository(createSqliteSqlClient(db));
  const created = await repo.save("a", "pa", "psa", "de", {
    sharesDecimal: "1",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: "0.15",
    exclude: false,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // Shares-only partial update: every other sparse field is omitted.
  const sharesOnly = await repo.save("a", "pa", "psa", "de", {
    sharesDecimal: "2",
    expectedVersion: created.override.version,
    requestId: "r2",
  });
  assert.equal(sharesOnly.ok, true);
  if (sharesOnly.ok) {
    assert.equal(sharesOnly.override.sharesDecimal, "2");
    assert.equal(sharesOnly.override.dividendPerShareDecimal, "0.5");
    assert.equal(sharesOnly.override.frankingCreditPerShareDecimal, "0.15");
    assert.equal(sharesOnly.override.exclude, false);
  }
  const cleared = sharesOnly.ok
    ? await repo.save("a", "pa", "psa", "de", {
        frankingCreditPerShareDecimal: null,
        expectedVersion: sharesOnly.override.version,
        requestId: "r3",
      })
    : null;
  assert.equal(cleared?.ok, true);
  if (cleared?.ok) {
    assert.equal(cleared.override.frankingCreditPerShareDecimal, null);
    // Fields omitted from this call remain exactly as they were.
    assert.equal(cleared.override.sharesDecimal, "2");
    assert.equal(cleared.override.dividendPerShareDecimal, "0.5");
  }
});

test("a dividend/split event can never be inserted already superseded -- supersession only via the correction path", async () => {
  const db = await ownedFixture();
  const dividendRepo = createDividendEventRepository(createSqliteSqlClient(db));
  const bornSuperseded = await dividendRepo.recordEvent({
    securityId: "s",
    providerId: "p",
    kind: "cash",
    status: "superseded",
    currencyCode: "AUD",
    grossPerShareDecimal: "1",
    observedAt: "2026-08-01T00:00:00Z",
    ingestedAt: "2026-08-01T00:00:00Z",
  });
  assert.equal(bornSuperseded.ok, false);
  if (!bornSuperseded.ok) assert.equal(bornSuperseded.reason, "invalid_input");

  const splitRepo = createSplitEventRepository(createSqliteSqlClient(db));
  const bornSupersededSplit = await splitRepo.recordEvent({
    securityId: "s",
    providerId: "p",
    exDate: "2026-06-01",
    effectiveDate: "2026-06-02",
    numeratorDecimal: "2",
    denominatorDecimal: "1",
    status: "superseded",
    observedAt: "2026-06-01T00:00:00Z",
    ingestedAt: "2026-06-01T00:00:00Z",
  });
  assert.equal(bornSupersededSplit.ok, false);
  if (!bornSupersededSplit.ok)
    assert.equal(bornSupersededSplit.reason, "invalid_input");
});

test("account export captures the owner's row from all six new dividend owner tables", async () => {
  const db = await fixture();
  const { job } = await completedExport(db);
  for (const table of [
    "dividend_receipts",
    "dividend_security_assumptions",
    "dividend_portfolio_assumptions",
    "dividend_fy_overrides",
    "dividend_event_overrides",
    "dividend_manual_records",
  ]) {
    const manifestRow = db
      .prepare(
        "SELECT classification, source_row_count, captured_row_count FROM account_export_manifest WHERE export_job_id=? AND table_name=?",
      )
      .get(job.id, table) as
      | {
          classification: string;
          source_row_count: number;
          captured_row_count: number;
        }
      | undefined;
    assert.ok(manifestRow, `manifest row for ${table}`);
    assert.equal(manifestRow?.classification, "owned", table);
    assert.equal(manifestRow?.source_row_count, 1, table);
    assert.equal(manifestRow?.captured_row_count, 1, table);
    const chunk = db
      .prepare(
        "SELECT payload_json FROM account_export_chunks WHERE export_job_id=? AND table_name=? AND row_count>0",
      )
      .get(job.id, table) as { payload_json: string } | undefined;
    assert.ok(chunk, `captured chunk payload for ${table}`);
    assert.equal(chunk?.payload_json.includes('"user_id":"a"'), true, table);
  }
});
