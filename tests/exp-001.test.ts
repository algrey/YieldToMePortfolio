/**
 * EXP-001 -- single-portfolio export/import bundle. See TASKS.md's
 * "### EXP-001" entry and `docs/BACKUP_FORMAT.md` for the format spec.
 * Expanded per the reviewer's B1-B7 findings (tombstone resurrection,
 * failed-batch retry, manual-row editability, sourceType preservation,
 * portfolio_securities restoration, deep field parity, over-cap wording).
 *
 * Fixture/context helpers duplicated from tests/div-016a.test.ts, matching
 * this codebase's established per-test-file convention (no shared
 * migratedDatabase()/fixture() module).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { createOwnedLedgerRepository } from "../db/repositories/ledger.ts";
import { createDividendManualRecordRepository } from "../db/repositories/dividends.ts";
import {
  MAX_BUNDLE_ENTITIES,
  validatePortfolioBundle,
  type PortfolioBundleV1,
} from "../domain/exports/portfolio-bundle.ts";
import {
  commitPortfolioBundleImport,
  exportPortfolioBundle,
  fingerprintBundle,
  previewPortfolioBundleImport,
  type BundleServiceContext,
} from "../app/portfolio-bundle-service.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";

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

async function fixture(): Promise<{ db: DatabaseSync; client: SqlClient }> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2),('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1),
      ('b','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01');
    INSERT INTO security_identifiers(id,security_id,scheme,value,valid_from,source) VALUES
      ('si1','s1','ticker','ALPHA','2026-08-01','owner_attested');
    -- B5: status='hidden' + display overrides + relevant-date bounds, so the
    -- restore test can prove these survive a round trip (resolveAndLink
    -- alone would leave every restored link at status='held', display
    -- fields NULL).
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,display_symbol,display_name,first_relevant_date,last_relevant_date,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','hidden','ALPHA-X','Alpha Co (hidden)','2026-01-01','2026-06-01','2026-08-01','2026-08-01');

    -- Dividend fixtures:
    -- div1 -> div2 -> div3: a 3-link imported supersession chain.
    -- div4: manual (wasImported=false) -- editability-after-restore probe.
    -- div5: imported, FX-carrying (BRK-010) -- deep field-parity probe.
    -- div6 -> div7 (head-deleted): a tombstoned ancestor (B1).
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,import_batch_id,source_reference,created_at,updated_at,version) VALUES
      ('div1','a','pa','psa1','2026-03-01','100','1.5','0.5','seed-batch','ext-1','2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z',1),
      ('div2','a','pa','psa1','2026-03-02','100','1.6','0.5','seed-batch','ext-1-b','2026-03-02T00:00:00.000Z','2026-03-02T00:00:00.000Z',1),
      ('div3','a','pa','psa1','2026-03-03','100','1.7','0.5','seed-batch','ext-1-c','2026-03-03T00:00:00.000Z','2026-03-03T00:00:00.000Z',1),
      ('div6','a','pa','psa1','2026-03-06','10','2.0',NULL,'seed-batch','ext-6','2026-03-06T00:00:00.000Z','2026-03-06T00:00:00.000Z',1),
      ('div7','a','pa','psa1','2026-03-07','10','2.1',NULL,'seed-batch','ext-6-b','2026-03-07T00:00:00.000Z','2026-03-07T00:00:00.000Z',1);
    UPDATE dividend_manual_records SET superseded_by_record_id = 'div2' WHERE id = 'div1';
    UPDATE dividend_manual_records SET superseded_by_record_id = 'div3' WHERE id = 'div2';
    UPDATE dividend_manual_records SET superseded_by_record_id = 'div7' WHERE id = 'div6';
    DELETE FROM dividend_manual_records WHERE id = 'div7';

    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,total_cash_decimal,total_franking_decimal,currency_code,fx_rate_to_portfolio_decimal,fx_rate_source,import_batch_id,source_reference,created_at,updated_at,version) VALUES
      ('div5','a','pa','psa1','2026-03-05','200.00','20.00','USD','1.35','sharesight','seed-batch','ext-fx-1','2026-03-05T00:00:00.000Z','2026-03-05T00:00:00.000Z',1);

    INSERT INTO dividend_security_assumptions(id,user_id,portfolio_id,portfolio_security_id,dividend_yield_percent_decimal,franking_percent_decimal,force_assumption,created_at,updated_at,version) VALUES
      ('assum1','a','pa','psa1','4.5','80',1,'2026-04-01T00:00:00.000Z','2026-04-01T00:00:00.000Z',1);
    INSERT INTO dividend_portfolio_assumptions(portfolio_id,user_id,value_growth_percent_decimal,created_at,updated_at,version) VALUES
      ('pa','a','3.0','2026-04-01T00:00:00.000Z','2026-04-01T00:00:00.000Z',1);
    INSERT INTO dividend_fy_overrides(id,user_id,portfolio_id,financial_year_ending_year,grossed_amount_decimal,created_at,updated_at,version) VALUES
      ('fy1','a','pa',2025,'1000','2026-04-01T00:00:00.000Z','2026-04-01T00:00:00.000Z',1);
    INSERT INTO income_whatif_scenarios(id,user_id,portfolio_id,name,capital_rows_json,reinvest_dividends,created_at,version) VALUES
      ('wf1','a','pa','Base case','[]',1,'2026-04-01T00:00:00.000Z',1);
  `);
  const client = createSqliteSqlClient(db);
  const ledger = createOwnedLedgerRepository(client);
  const post1 = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "100",
    unitPriceDecimal: "5",
    grossAmountDecimal: "500",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-01-01T00:00:00.000Z",
    localTradeDate: "2026-01-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(post1.ok, true);
  if (!post1.ok) throw new Error("fixture post1 failed");
  const reversal = await ledger.reverse(
    "a",
    "pa",
    post1.transaction.id,
    randomUUID(),
    randomUUID(),
  );
  assert.equal(reversal.ok, true);
  const post2 = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "50",
    unitPriceDecimal: "6",
    grossAmountDecimal: "300",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-02-01T00:00:00.000Z",
    localTradeDate: "2026-02-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(post2.ok, true);
  if (!post2.ok) throw new Error("fixture post2 failed");
  // B4 probe: a supersession whose successor keeps a real, non-"system"
  // sourceType ("manual" -- the owner corrected the trade by hand).
  const supersede1 = await ledger.supersede("a", "pa", post2.transaction.id, {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "55",
    unitPriceDecimal: "6",
    grossAmountDecimal: "330",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-02-02T00:00:00.000Z",
    localTradeDate: "2026-02-02",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(supersede1.ok, true);

  // div4: manual (wasImported=false) -- B3 editability probe. Created via
  // the SAME repository the manual dialog uses, matching what a real
  // owner-typed row looks like (import_batch_id stays NULL).
  const manualRecords = createDividendManualRecordRepository(client);
  const div4 = await manualRecords.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-04",
    sharesDecimal: "50",
    dividendPerShareDecimal: "1.0",
    requestId: randomUUID(),
  });
  assert.equal(div4.ok, true);

  return { db, client };
}

function ctxFor(client: SqlClient, userId: string): BundleServiceContext {
  return { client, userId, requestId: randomUUID() };
}

async function commitFor(
  client: SqlClient,
  userId: string,
  bundle: PortfolioBundleV1,
) {
  return commitPortfolioBundleImport(
    ctxFor(client, userId),
    bundle,
    "bundle.json",
    JSON.stringify(bundle).length,
  );
}

test("export reads every included table, the reversal/dividend-supersession chains, and the tombstone", async () => {
  const { client } = await fixture();
  const result = await exportPortfolioBundle(ctxFor(client, "a"), "pa");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const bundle = result.bundle;
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.portfolio.baseCurrencyCode, "AUD");
  assert.equal(bundle.securities.length, 1);
  assert.equal(bundle.transactions.length, 4); // buy, reversal, buy, supersession
  assert.equal(bundle.dividendManualRecords.length, 6); // div1,2,3,4,5,6 (div7 deleted)
  assert.equal(bundle.dividendSecurityAssumptions.length, 1);
  assert.equal(bundle.dividendSecurityAssumptions[0]?.forceAssumption, true);
  assert.ok(bundle.dividendPortfolioAssumption);
  assert.equal(bundle.dividendFyOverrides.length, 1);
  assert.equal(bundle.whatifScenarios.length, 1);

  // B5: portfolio_securities display/status fields are carried in the
  // export.
  const security = bundle.securities[0];
  assert.equal(security?.status, "hidden");
  assert.equal(security?.displaySymbol, "ALPHA-X");
  assert.equal(security?.displayName, "Alpha Co (hidden)");
  assert.equal(security?.firstRelevantDate, "2026-01-01");
  assert.equal(security?.lastRelevantDate, "2026-06-01");

  // B1: div6 is tombstoned (its successor div7 was head-deleted) -- carried
  // as an explicit flag, never as a live/normal row.
  const div6 = bundle.dividendManualRecords.find((r) => r.ref === "div6");
  assert.equal(div6?.supersededByDeletedRecord, true);
  assert.equal(div6?.supersedesRef, null);
  assert.ok(!bundle.dividendManualRecords.some((r) => r.ref === "div7"));

  // 3-link chain topology.
  const div1 = bundle.dividendManualRecords.find((r) => r.ref === "div1");
  const div2 = bundle.dividendManualRecords.find((r) => r.ref === "div2");
  const div3 = bundle.dividendManualRecords.find((r) => r.ref === "div3");
  assert.equal(div2?.supersedesRef, "div1");
  assert.equal(div3?.supersedesRef, "div2");
  assert.equal(div1?.supersededByDeletedRecord, false);

  // FX-carrying row (div5) -- deep field parity at the export layer.
  const div5 = bundle.dividendManualRecords.find((r) => r.ref === "div5");
  assert.equal(div5?.currencyCode, "USD");
  assert.equal(div5?.fxRateToPortfolioDecimal, "1.35");
  assert.equal(div5?.fxRateSource, "sharesight");
  assert.equal(div5?.totalCashDecimal, "200.00");
  assert.equal(div5?.totalFrankingDecimal, "20.00");

  // Manual row (div4) is flagged correctly.
  const div4 = bundle.dividendManualRecords.find(
    (r) => r.paymentDate === "2026-03-04",
  );
  assert.equal(div4?.wasImported, false);

  // Deep transaction field parity (not just a count).
  const supersessionRow = bundle.transactions.find(
    (tx) => tx.supersedesRef !== null,
  );
  assert.equal(supersessionRow?.quantityDecimal, "55");
  assert.equal(supersessionRow?.grossAmountDecimal, "330");
  assert.equal(supersessionRow?.sourceType, "manual");
  assert.equal(supersessionRow?.localTradeDate, "2026-02-02");

  // Cross-user probe: user "b" must not be able to export user "a"'s
  // portfolio.
  const crossUser = await exportPortfolioBundle(ctxFor(client, "b"), "pa");
  assert.equal(crossUser.ok, false);
  if (!crossUser.ok) assert.equal(crossUser.status, 404);
});

test("round trip: deep parity, chain topology, tombstone exclusion, editability, and status restoration", async () => {
  const { client } = await fixture();
  const exported = await exportPortfolioBundle(ctxFor(client, "a"), "pa");
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;

  const preview = await previewPortfolioBundleImport(
    ctxFor(client, "a"),
    bundle,
  );
  assert.equal(preview.ok, true);
  if (preview.ok) {
    assert.equal(preview.preview.baseCurrencyMismatch, false);
    assert.equal(preview.preview.idempotent, false);
    assert.equal(preview.preview.counts.transactions, 4);
  }

  const committed = await commitFor(client, "a", bundle);
  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  const newPortfolioId = committed.result.portfolioId;
  assert.notEqual(newPortfolioId, "pa");
  // The global ALPHA/AUD security already exists (created by the source
  // fixture) -- re-resolving it correctly MATCHES the shared master rather
  // than creating a duplicate (IMP-004B precedent).
  assert.equal(committed.result.securitiesCreated, 0);
  assert.equal(committed.result.securitiesMatched, 1);

  // --- B5: portfolio_securities display/status fields restored (queried
  // directly -- re-exporting would also prove it, but a direct DB read is
  // the more direct assertion of the actual fix).
  const newLink = await client.get<Record<string, unknown>>(
    "SELECT status, display_symbol, display_name, first_relevant_date, last_relevant_date FROM portfolio_securities WHERE portfolio_id = ? AND user_id = ?",
    [newPortfolioId, "a"],
  );
  assert.equal(newLink?.status, "hidden");
  assert.equal(newLink?.display_symbol, "ALPHA-X");
  assert.equal(newLink?.display_name, "Alpha Co (hidden)");
  assert.equal(newLink?.first_relevant_date, "2026-01-01");
  assert.equal(newLink?.last_relevant_date, "2026-06-01");
  const newSecurityId = String(
    (
      await client.get<{ id: string }>(
        "SELECT id FROM portfolio_securities WHERE portfolio_id = ? AND user_id = ?",
        [newPortfolioId, "a"],
      )
    )?.id,
  );

  // --- B4: the supersession successor's source_type is preserved, never
  // hardcoded to "system".
  const newSupersessionTx = await client.get<Record<string, unknown>>(
    "SELECT source_type, quantity_decimal, gross_amount_decimal, local_trade_date FROM transactions WHERE portfolio_id = ? AND user_id = ? AND supersedes_transaction_id IS NOT NULL",
    [newPortfolioId, "a"],
  );
  assert.equal(newSupersessionTx?.source_type, "manual");
  assert.equal(newSupersessionTx?.quantity_decimal, "55");
  assert.equal(newSupersessionTx?.gross_amount_decimal, "330");
  assert.equal(newSupersessionTx?.local_trade_date, "2026-02-02");
  const newReversalTx = await client.get<Record<string, unknown>>(
    "SELECT id, status FROM transactions WHERE portfolio_id = ? AND user_id = ? AND reverses_transaction_id IS NOT NULL",
    [newPortfolioId, "a"],
  );
  assert.ok(newReversalTx, "reversal row replayed");

  // --- Dividend rows: deep field parity + chain + tombstone + editability.
  const newDivRows = await client.all<Record<string, unknown>>(
    "SELECT id, payment_date, dividend_per_share_decimal, total_cash_decimal, total_franking_decimal, currency_code, fx_rate_to_portfolio_decimal, fx_rate_source, import_batch_id, superseded_by_record_id FROM dividend_manual_records WHERE portfolio_id = ? AND user_id = ?",
    [newPortfolioId, "a"],
  );
  assert.equal(newDivRows.length, 6);
  const byId = new Map(newDivRows.map((row) => [String(row.id), row]));
  const newDiv1 = newDivRows.find(
    (r) => r.dividend_per_share_decimal === "1.5",
  );
  const newDiv2 = newDivRows.find(
    (r) => r.dividend_per_share_decimal === "1.6",
  );
  const newDiv3 = newDivRows.find(
    (r) => r.dividend_per_share_decimal === "1.7",
  );
  assert.ok(newDiv1 && newDiv2 && newDiv3);
  // 3-link chain: div1 -> div2 -> div3, div3 is the live head.
  assert.equal(newDiv1?.superseded_by_record_id, newDiv2?.id);
  assert.equal(newDiv2?.superseded_by_record_id, newDiv3?.id);
  assert.equal(newDiv3?.superseded_by_record_id, null);
  assert.equal(newDiv1?.import_batch_id, newDiv2?.import_batch_id);

  // FX-carrying row (div5) -- byte-identical restore.
  const newDiv5 = newDivRows.find((r) => r.total_cash_decimal === "200.00");
  assert.equal(newDiv5?.total_franking_decimal, "20.00");
  assert.equal(newDiv5?.currency_code, "USD");
  assert.equal(newDiv5?.fx_rate_to_portfolio_decimal, "1.35");
  assert.equal(newDiv5?.fx_rate_source, "sharesight");
  assert.ok(
    newDiv5?.import_batch_id,
    "FX row stays batch-attributed (was imported)",
  );

  // B1: the tombstoned row (div6) restores to a dangling, non-existent
  // superseded_by_record_id -- never NULL (never resurrected), and it never
  // matches any OTHER row this portfolio actually has.
  const newDiv6 = newDivRows.find((r) => r.payment_date === "2026-03-06");
  assert.ok(
    newDiv6?.superseded_by_record_id,
    "tombstone pointer restored, not NULL",
  );
  assert.ok(
    !byId.has(String(newDiv6?.superseded_by_record_id)),
    "the tombstone target genuinely does not exist in this portfolio",
  );
  const manualRecords = createDividendManualRecordRepository(client);
  const liveList = await manualRecords.list("a", newPortfolioId);
  assert.ok(
    !liveList.some((r) => r.id === newDiv6?.id),
    "the tombstoned row is excluded from evidence (list()), never resurrected",
  );

  // B3: the ORIGINALLY-manual row (div4) is import_batch_id NULL and
  // genuinely editable through supersede() after restore -- proving fidelity
  // was not needlessly traded for editability.
  const newDiv4 = newDivRows.find((r) => r.payment_date === "2026-03-04");
  assert.equal(newDiv4?.import_batch_id, null);
  const editResult = await manualRecords.supersede(
    "a",
    newPortfolioId,
    String(newDiv4?.id),
    {
      dividendPerShareDecimal: "1.2",
      expectedVersion: 1,
      requestId: randomUUID(),
    },
  );
  assert.equal(
    editResult.ok,
    true,
    "a restored manual row must still be dialog-editable",
  );

  // Non-dividend facts.
  assert.equal(committed.result.counts.dividendFyOverrides, 1);
  assert.equal(committed.result.counts.whatifScenarios, 1);
  const newAssumption = await client.get<Record<string, unknown>>(
    "SELECT force_assumption, dividend_yield_percent_decimal FROM dividend_security_assumptions WHERE portfolio_id = ? AND user_id = ? AND portfolio_security_id = ?",
    [newPortfolioId, "a", newSecurityId],
  );
  assert.equal(Boolean(newAssumption?.force_assumption), true);
  assert.equal(newAssumption?.dividend_yield_percent_decimal, "4.5");

  // Idempotent re-import: same bundle, same user -> no-op, same portfolio.
  const secondCommit = await commitFor(client, "a", bundle);
  assert.equal(secondCommit.ok, true);
  if (secondCommit.ok) {
    assert.equal(secondCommit.result.idempotent, true);
    assert.equal(secondCommit.result.portfolioId, newPortfolioId);
  }
  const portfolioCountRow = await client.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM portfolios WHERE user_id = ?",
    ["a"],
  );
  // Original + one restored portfolio only -- the idempotent re-run must
  // not have created a second one.
  assert.equal(Number(portfolioCountRow?.count ?? 0), 2);

  // Cross-user probe: user "b" importing the SAME bundle content must get
  // its OWN, separate portfolio -- never treated as idempotent against
  // user "a"'s already-committed batch (the natural-key uniqueness is
  // scoped by user_id).
  const crossUserCommit = await commitFor(client, "b", bundle);
  assert.equal(crossUserCommit.ok, true);
  if (crossUserCommit.ok) {
    assert.equal(crossUserCommit.result.idempotent, false);
    assert.notEqual(crossUserCommit.result.portfolioId, newPortfolioId);
  }
  const bPortfolios = await client.all<{ user_id: string }>(
    "SELECT user_id FROM portfolios WHERE id = (SELECT target_portfolio_id FROM import_batches WHERE user_id = 'b' LIMIT 1)",
  );
  assert.ok(bPortfolios.every((row) => row.user_id === "b"));
});

test("B2: a failed/interrupted commit is retryable, not permanently bricked", async () => {
  const { client } = await fixture();
  const exported = await exportPortfolioBundle(ctxFor(client, "a"), "pa");
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;
  const fingerprint = await fingerprintBundle(bundle);

  // Simulate a previous attempt that failed partway through (a real
  // `import_batches` row for this exact bundle fingerprint, status
  // 'failed', with no destination portfolio ever recorded -- exactly what
  // `commitFailure` leaves behind before any portfolio is created, and
  // also representative of a `committing` status left by a crashed
  // request).
  const staleBatchId = randomUUID();
  await client.run(
    `INSERT INTO import_batches (
      id, user_id, parser_format, parser_version, filename, byte_size,
      file_sha256, status, created_at, updated_at
    ) VALUES (?, 'a', 'portfolio-bundle-json', '1', 'earlier.json', 10, ?, 'failed', ?, ?)`,
    [
      staleBatchId,
      fingerprint,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ],
  );

  const retried = await commitFor(client, "a", bundle);
  assert.equal(retried.ok, true, "the retry must succeed, not 409 forever");
  if (!retried.ok) return;
  assert.equal(retried.result.idempotent, false);

  // The stale batch row was REUSED (not left behind as a permanent
  // roadblock), now committed and pointing at the retry's destination
  // portfolio.
  const reusedBatch = await client.get<Record<string, unknown>>(
    "SELECT status, target_portfolio_id FROM import_batches WHERE id = ? AND user_id = 'a'",
    [staleBatchId],
  );
  assert.equal(reusedBatch?.status, "committed");
  assert.equal(reusedBatch?.target_portfolio_id, retried.result.portfolioId);

  // A second retry of the identical bundle is now idempotent (the reused
  // batch is `committed`).
  const secondRetry = await commitFor(client, "a", bundle);
  assert.equal(secondRetry.ok, true);
  if (secondRetry.ok) {
    assert.equal(secondRetry.result.idempotent, true);
    assert.equal(secondRetry.result.portfolioId, retried.result.portfolioId);
  }
});

test("transaction chain replay is correct even when createdAt ties (same millisecond) and refs sort adversarially", async () => {
  // Regression pin for a real bug this suite's own flakiness caught: a
  // plain `createdAt` sort with a ref-based tiebreak is unsafe (`created_
  // at` is millisecond-resolution; two rows can tie), and comparing random
  // UUID refs has no relation to dependency order. Here the successor's
  // ref sorts ALPHABETICALLY BEFORE its ancestor's ref, with an IDENTICAL
  // `createdAt` -- the exact adversarial shape that made the old
  // `.sort((a,b) => ... a.ref.localeCompare(b.ref))` tiebreak place the
  // supersession before the transaction it targets, failing with "A
  // supersession's original transaction was not replayed first."
  const { client } = await fixture();
  const tied = "2026-05-01T00:00:00.000Z";
  const bundle: PortfolioBundleV1 = {
    schemaVersion: 1,
    exportedAt: "2026-08-01T00:00:00.000Z",
    portfolio: {
      name: "Tie order",
      code: "TIE",
      baseCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      accountingMethod: "fifo",
      historyCompleteFrom: null,
      financialYearStartMonthAtExport: 7,
    },
    portfolioSettings: { quoteStalenessPolicy: null },
    securities: [
      {
        ref: "sec-alpha",
        sourceSymbol: "ALPHA",
        sourceExchangeAlias: null,
        sourceCurrencyCode: "AUD",
        sourceName: null,
        displaySymbol: null,
        displayName: null,
        status: "held",
        firstRelevantDate: null,
        lastRelevantDate: null,
        canonicalName: "Alpha Co",
        primaryCurrencyCode: "AUD",
        tickerIdentifier: "ALPHA",
        isinIdentifier: null,
        sharesightInstrumentId: null,
      },
    ],
    transactions: [
      {
        ref: "zzz-ancestor",
        securityRef: "sec-alpha",
        type: "buy",
        status: "superseded",
        tradeAt: tied,
        localTradeDate: "2026-05-01",
        settlementDate: null,
        quantityDecimal: "10",
        unitPriceDecimal: "1",
        currencyCode: "AUD",
        grossAmountDecimal: "10",
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        fxRateToBaseDecimal: null,
        fxRateSource: null,
        fxObservedAt: null,
        sourceType: "manual",
        sourceReference: null,
        createdAt: tied,
        reversesRef: null,
        supersedesRef: null,
      },
      {
        ref: "aaa-successor",
        securityRef: "sec-alpha",
        type: "buy",
        status: "posted",
        tradeAt: tied,
        localTradeDate: "2026-05-01",
        settlementDate: null,
        quantityDecimal: "12",
        unitPriceDecimal: "1",
        currencyCode: "AUD",
        grossAmountDecimal: "12",
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        fxRateToBaseDecimal: null,
        fxRateSource: null,
        fxObservedAt: null,
        sourceType: "manual",
        sourceReference: null,
        createdAt: tied,
        reversesRef: null,
        supersedesRef: "zzz-ancestor",
      },
    ],
    dividendManualRecords: [],
    dividendSecurityAssumptions: [],
    dividendPortfolioAssumption: null,
    dividendFyOverrides: [],
    dividendEventOverrides: [],
    dividendImportFrankingOverrides: [],
    whatifScenarios: [],
  };
  const result = await commitFor(client, "a", bundle);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const live = await client.get<{ quantity_decimal: string }>(
    "SELECT quantity_decimal FROM transactions WHERE portfolio_id = ? AND user_id = ? AND status = 'posted'",
    [result.result.portfolioId, "a"],
  );
  assert.equal(live?.quantity_decimal, "12");
});

test("commit is rejected when the bundle's base currency does not match the owner's home currency", async () => {
  const { client } = await fixture();
  const exported = await exportPortfolioBundle(ctxFor(client, "a"), "pa");
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const mismatched: PortfolioBundleV1 = {
    ...exported.bundle,
    portfolio: { ...exported.bundle.portfolio, baseCurrencyCode: "USD" },
  };
  const result = await commitFor(client, "a", mismatched);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 409);
});

test("unseen-security creation: a security absent from every table is genuinely created, not matched", async () => {
  const { client } = await fixture();
  const synthetic: PortfolioBundleV1 = {
    schemaVersion: 1,
    exportedAt: "2026-08-01T00:00:00.000Z",
    portfolio: {
      name: "Synthetic",
      code: "SYN",
      baseCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      accountingMethod: "fifo",
      historyCompleteFrom: null,
      financialYearStartMonthAtExport: 7,
    },
    portfolioSettings: { quoteStalenessPolicy: null },
    securities: [
      {
        ref: "sec-beta",
        sourceSymbol: "BETA",
        sourceExchangeAlias: null,
        sourceCurrencyCode: "AUD",
        sourceName: "Beta Co",
        displaySymbol: null,
        displayName: null,
        status: "held",
        firstRelevantDate: null,
        lastRelevantDate: null,
        canonicalName: "Beta Co",
        primaryCurrencyCode: "AUD",
        tickerIdentifier: "BETA",
        isinIdentifier: null,
        sharesightInstrumentId: null,
      },
    ],
    transactions: [],
    dividendManualRecords: [],
    dividendSecurityAssumptions: [],
    dividendPortfolioAssumption: null,
    dividendFyOverrides: [],
    dividendEventOverrides: [],
    dividendImportFrankingOverrides: [],
    whatifScenarios: [],
  };
  const result = await commitFor(client, "a", synthetic);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.securitiesCreated, 1);
    assert.equal(result.result.securitiesMatched, 0);
  }
  const created = await client.get<{ id: string }>(
    "SELECT id FROM securities WHERE primary_currency_code = 'AUD' AND canonical_name = 'Beta Co'",
  );
  assert.ok(created, "a brand-new global security row was created");
});

test("malformed and schema-version-mismatched bundles fail closed at structural validation", () => {
  assert.equal(validatePortfolioBundle(null).ok, false);
  assert.equal(validatePortfolioBundle({}).ok, false);
  assert.equal(
    validatePortfolioBundle({ schemaVersion: 2, portfolio: {} }).ok,
    false,
  );
  assert.equal(
    validatePortfolioBundle({
      schemaVersion: 1,
      exportedAt: "not-a-date",
      portfolio: {},
      portfolioSettings: {},
      securities: [],
      transactions: [],
      dividendManualRecords: [],
      dividendSecurityAssumptions: [],
      dividendPortfolioAssumption: null,
      dividendFyOverrides: [],
      dividendEventOverrides: [],
      dividendImportFrankingOverrides: [],
      whatifScenarios: [],
    }).ok,
    false,
  );
});

test("an oversized bundle (over MAX_BUNDLE_ENTITIES) is rejected with an honest, non-fabricated remedy", () => {
  const securities = Array.from(
    { length: MAX_BUNDLE_ENTITIES + 1 },
    (_, i) => ({
      ref: `sec-${i}`,
      sourceSymbol: "ALPHA",
      sourceExchangeAlias: null,
      sourceCurrencyCode: "AUD",
      sourceName: null,
      displaySymbol: null,
      displayName: null,
      status: "held",
      firstRelevantDate: null,
      lastRelevantDate: null,
      canonicalName: null,
      primaryCurrencyCode: null,
      tickerIdentifier: null,
      isinIdentifier: null,
      sharesightInstrumentId: null,
    }),
  );
  const result = validatePortfolioBundle({
    schemaVersion: 1,
    exportedAt: "2026-08-01T00:00:00Z",
    portfolio: {
      name: "A",
      code: "A",
      baseCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      accountingMethod: "fifo",
      historyCompleteFrom: null,
      financialYearStartMonthAtExport: 7,
    },
    portfolioSettings: { quoteStalenessPolicy: null },
    securities,
    transactions: [],
    dividendManualRecords: [],
    dividendSecurityAssumptions: [],
    dividendPortfolioAssumption: null,
    dividendFyOverrides: [],
    dividendEventOverrides: [],
    dividendImportFrankingOverrides: [],
    whatifScenarios: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    // B7 fix: no fabricated "split it and re-import in parts" remedy (no
    // merge path exists for this format) -- the message must state the
    // truth instead.
    assert.ok(!/split/i.test(result.message));
    assert.match(result.message, /too large|not restorable/i);
  }
});

test("a bundle whose chain refs form a cycle (or self-reference) is rejected before any DB write", async () => {
  // Reviewer round-2 finding: a hand-edited/corrupted bundle can describe a
  // supersession cycle. The transaction path already failed closed at
  // commit time, but a DIVIDEND cycle committed "successfully" while the
  // two rows superseded EACH OTHER -- both silently excluded from evidence
  // (owner income vanishing with a success message). Both graphs are now
  // rejected structurally, before the commit path touches the database.
  const { client } = await fixture();
  const exported = await exportPortfolioBundle(ctxFor(client, "a"), "pa");
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const base = exported.bundle;
  const tx = base.transactions[0];
  const div = base.dividendManualRecords[0];
  assert.ok(tx && div);

  const cyclicTransactions: PortfolioBundleV1 = {
    ...base,
    transactions: [
      { ...tx, ref: "tx-x", reversesRef: null, supersedesRef: "tx-y" },
      { ...tx, ref: "tx-y", reversesRef: null, supersedesRef: "tx-x" },
    ],
    dividendManualRecords: [],
    dividendImportFrankingOverrides: [],
  };
  const txResult = validatePortfolioBundle(cyclicTransactions);
  assert.equal(txResult.ok, false);
  if (!txResult.ok) assert.match(txResult.message, /refers back to itself/i);

  const selfReferencing: PortfolioBundleV1 = {
    ...base,
    transactions: [
      { ...tx, ref: "tx-z", reversesRef: null, supersedesRef: "tx-z" },
    ],
    dividendManualRecords: [],
    dividendImportFrankingOverrides: [],
  };
  assert.equal(validatePortfolioBundle(selfReferencing).ok, false);

  const cyclicDividends: PortfolioBundleV1 = {
    ...base,
    transactions: [],
    dividendManualRecords: [
      {
        ...div,
        ref: "div-x",
        supersedesRef: "div-y",
        supersededByDeletedRecord: false,
      },
      {
        ...div,
        ref: "div-y",
        supersedesRef: "div-x",
        supersededByDeletedRecord: false,
      },
    ],
    dividendImportFrankingOverrides: [],
  };
  const divResult = validatePortfolioBundle(cyclicDividends);
  assert.equal(divResult.ok, false);
  if (!divResult.ok) assert.match(divResult.message, /refers back to itself/i);

  // ...and the commit path rejects it too (400, no portfolio created).
  const portfoliosBefore = await client.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM portfolios WHERE user_id = ?",
    ["a"],
  );
  const commit = await commitPortfolioBundleImport(
    ctxFor(client, "a"),
    cyclicDividends,
    "cyclic.json",
    100,
  );
  assert.equal(commit.ok, false);
  if (!commit.ok) assert.equal(commit.status, 400);
  const portfoliosAfter = await client.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM portfolios WHERE user_id = ?",
    ["a"],
  );
  assert.equal(
    Number(portfoliosAfter?.count ?? 0),
    Number(portfoliosBefore?.count ?? 0),
    "a corrupt bundle must never leave a partially-created portfolio behind",
  );
});
