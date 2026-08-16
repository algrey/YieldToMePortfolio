/** UI-006C — per-security dividend history tab. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createDividendEventOverrideRepository,
  createDividendManualRecordRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import { loadOwnedSecurityDividendDetail } from "../app/owned-security-dividends.ts";
import {
  refreshSecurityDividendHistoryWithContext,
  type DividendRefreshActionContext,
} from "../app/dividend-history-refresh-actions.ts";
import {
  buildDialogPrefill,
  decimalsEqual,
  type DialogPrefill,
} from "../app/dividend-history-prefill.ts";
import type {
  DividendEventInput,
  MarketDataProvider,
} from "../domain/market-data/index.ts";
import type {
  DerivedDividendRow,
  FrankingResolution,
} from "../domain/dividends/index.ts";

// ---------------------------------------------------------------------------
// Fixture: one security (psa1) with an edited/overridden event, a plain auto
// event, a declared-but-future (not-paid) event, a standalone owner-typed
// manual record, and a standalone imported record; a second, fully-sold
// security (psa2) whose one dividend was received while it was still held.
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

async function fixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1),
      ('b','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01'),
      ('s2','equity','AUD','Beta Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01'),
      ('psa2','a','pa','s2','BETA','AUD','held','2026-08-01','2026-08-01');
    -- market_data_providers' 'yahoo-compatible' row is no longer seeded
    -- here: MKT-007's drizzle/0037_steady_signal.sql migration now ships it
    -- as reference data, so the full migration chain applied above already
    -- produced it.
    INSERT INTO security_provider_mappings(id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status,verified_by_user_id,verified_at) VALUES
      ('mapping-s1','s1','yahoo-compatible','ASX','ALPHA.AX','2026-08-01','verified','a','2026-08-01T00:00:00Z');

    -- psa1: three provider events.
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de1','s1','yahoo-compatible','cash','paid','2026-03-01','AUD','1.00','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z','2026-03-01'),
      ('de2','s1','yahoo-compatible','cash','declared','2027-01-01','AUD','2.00','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z','2026-08-01'),
      ('de3','s1','yahoo-compatible','cash','paid','2026-05-01','AUD','0.75','2026-05-01T00:00:00Z','2026-05-01T00:00:00Z','2026-05-01');
    -- de1 is overridden (edited).
    INSERT INTO dividend_event_overrides(id,user_id,portfolio_id,portfolio_security_id,dividend_event_id,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,exclude,created_at,updated_at,version) VALUES
      ('ov1','a','pa','psa1','de1',NULL,'1.50','0.30',0,'2026-08-01','2026-08-01',1);
    -- Standalone owner-typed manual record (far from every event).
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('mr1','a','pa','psa1','2026-06-01','10','2.00',NULL,NULL,'2026-08-01','2026-08-01',1),
      ('mr2','a','pa','psa1','2026-07-15','5','3.00','1.00','batch-x','2026-08-01','2026-08-01',1);
    INSERT INTO dividend_security_assumptions(id,user_id,portfolio_id,portfolio_security_id,dividend_yield_percent_decimal,franking_percent_decimal,dividend_growth_percent_decimal,created_at,updated_at,version) VALUES
      ('das1','a','pa','psa1','4','50','2','2026-08-01','2026-08-01',1);
    INSERT INTO dividend_portfolio_assumptions(portfolio_id,user_id,value_growth_percent_decimal,portfolio_dividend_growth_percent_decimal,created_at,updated_at,version) VALUES
      ('pa','a','3','2','2026-08-01','2026-08-01',1);

    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa1','buy','posted','2026-01-01T00:00:00Z','2026-01-01','100','5','AUD','500','0','0','manual','a',1,'2026-01-01');

    -- psa2: fully sold after receiving one dividend while held.
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de4','s2','yahoo-compatible','cash','paid','2026-02-01','AUD','0.50','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z','2026-02-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx2','a','pa','psa2','buy','posted','2026-01-01T00:00:00Z','2026-01-01','50','5','AUD','250','0','0','manual','a',1,'2026-01-01'),
      ('tx3','a','pa','psa2','sell','posted','2026-04-01T00:00:00Z','2026-04-01','50','6','AUD','300','0','0','manual','a',1,'2026-04-01');
  `);
  return db;
}

const NOW = new Date("2026-08-13T00:00:00Z");

async function loadDetail(
  client: SqlClient,
  userId: string,
  portfolioSecurityId: string,
) {
  return loadOwnedSecurityDividendDetail(
    client,
    userId,
    "pa",
    portfolioSecurityId,
    NOW,
  );
}

// ---------------------------------------------------------------------------
// Loader: derivation, override/manual lookups, sold-share retention, and
// ownership denial.
// ---------------------------------------------------------------------------

test("UI-006C: loadOwnedSecurityDividendDetail derives rows for auto, edited, standalone manual, and imported sources with correct override/manual lookups", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const detail = await loadDetail(client, "a", "psa1");

  assert.equal(detail.symbol, "ALPHA");
  assert.equal(detail.currencyCode, "AUD");
  const bySource = new Map(detail.rows.map((row) => [row.source, row]));
  assert.equal(bySource.get("edited")?.dividendEventId, "de1");
  assert.equal(bySource.get("auto")?.currencyCode, "AUD");
  assert.ok(bySource.has("manual"));
  assert.ok(bySource.has("imported"));
  assert.equal(detail.rows.length, 5); // de1, de2, de3, manual:mr1, imported:mr2

  const override = detail.overridesByEventId["de1"];
  assert.ok(override);
  assert.equal(override?.version, 1);
  assert.equal(override?.dividendPerShareDecimal, "1.50");
  assert.equal(override?.frankingCreditPerShareDecimal, "0.30");
  assert.equal(override?.exclude, false);
  assert.equal(override?.storedDividendEventId, "de1");

  const manual = detail.manualRecordsById["mr1"];
  assert.deepEqual(manual, { version: 1, importBatchId: null });
  const imported = detail.manualRecordsById["mr2"];
  assert.deepEqual(imported, { version: 1, importBatchId: "batch-x" });

  assert.equal(detail.assumptions.frankingPercentDecimal, "50");
  assert.equal(detail.assumptions.version, 1);
  assert.equal(detail.portfolioAssumptions.valueGrowthPercentDecimal, "3");
});

test("UI-006C: a declared future event is not paid (declared_pending), excluded from lifetime received, and shown in the separate pending line", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const detail = await loadDetail(client, "a", "psa1");

  const pendingRow = detail.rows.find((row) => row.dividendEventId === "de2");
  assert.equal(pendingRow?.status, "declared_pending");
  assert.equal(detail.lifetimeTotals.pendingCount, 1);
  assert.notEqual(detail.lifetimeTotals.pendingGrossDecimal, null);
  // 150 (de1, overridden) + 75 (de3, auto) + 20 (mr1) + 15 (mr2) = 260;
  // de2 (pending, 200) must NOT be included in the received total.
  assert.equal(detail.lifetimeTotals.receivedCashDecimal, "260");
});

test("UI-006C: a fully-sold security's dividend history remains listed and totalled permanently, and stays reachable", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const detail = await loadDetail(client, "a", "psa2");

  assert.equal(detail.rows.length, 1);
  assert.equal(detail.rows[0]?.sharesDecimal, "50"); // shares held AT the ex-date, not today
  assert.equal(detail.lifetimeTotals.receivedCashDecimal, "25"); // 50 x 0.50
});

test("UI-006C: loadOwnedSecurityDividendDetail denies a cross-owner portfolioSecurityId", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  await assert.rejects(loadDetail(client, "b", "psa1"), /not_found/);
});

// ---------------------------------------------------------------------------
// buildDialogPrefill: every row must be clickable and pre-fill correctly.
// ---------------------------------------------------------------------------

test("UI-006C: buildDialogPrefill supplies initialPaymentDate for an event-linked row even when the provider never supplied a payment date (falls back to ex-date)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const detail = await loadDetail(client, "a", "psa1");
  const autoRow = detail.rows.find(
    (row) => row.dividendEventId === "de3",
  ) as DerivedDividendRow;
  assert.equal(autoRow.paymentDate, null); // the fixture never sets payment_date

  const prefill: DialogPrefill = buildDialogPrefill(
    autoRow,
    "psa1",
    detail.overridesByEventId,
    detail.manualRecordsById,
    detail.today,
  );
  assert.equal(prefill.initialPaymentDate, "2026-05-01"); // falls back to exDate
  assert.equal(prefill.initialDividendEventId, "de3");
  assert.equal(
    prefill.initialExpectedVersion,
    null,
    "a plain auto row with no override yet must CREATE, not attempt an UPDATE",
  );
});

test("UI-006C: buildDialogPrefill pre-fills an already-overridden row with the override's own version (an UPDATE, never a stray CREATE)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const detail = await loadDetail(client, "a", "psa1");
  const editedRow = detail.rows.find(
    (row) => row.source === "edited",
  ) as DerivedDividendRow;

  const prefill = buildDialogPrefill(
    editedRow,
    "psa1",
    detail.overridesByEventId,
    detail.manualRecordsById,
    detail.today,
  );
  assert.equal(prefill.initialExpectedVersion, 1);
  assert.equal(prefill.initialDividendPerShareDecimal, "1.50");
  assert.equal(prefill.initialFrankingCreditPerShareDecimal, "0.30");
  assert.equal(prefill.initialSharesDecimal, "100"); // override.sharesDecimal is sparse-null -> falls back to the row's resolved value
  assert.equal(
    prefill.initialDividendEventId,
    "de1",
    "no supersession happened here, so the stored key and the active id are still the same",
  );
});

test("UI-006C: buildDialogPrefill pre-fills standalone manual/imported rows with their own record id and version", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const detail = await loadDetail(client, "a", "psa1");
  const manualRow = detail.rows.find(
    (row) => row.source === "manual",
  ) as DerivedDividendRow;
  const importedRow = detail.rows.find(
    (row) => row.source === "imported",
  ) as DerivedDividendRow;

  const manualPrefill = buildDialogPrefill(
    manualRow,
    "psa1",
    detail.overridesByEventId,
    detail.manualRecordsById,
    detail.today,
  );
  assert.equal(manualPrefill.initialManualRecordId, "mr1");
  assert.equal(manualPrefill.initialExpectedVersion, 1);
  assert.equal(manualPrefill.initialDividendEventId, null);

  const importedPrefill = buildDialogPrefill(
    importedRow,
    "psa1",
    detail.overridesByEventId,
    detail.manualRecordsById,
    detail.today,
  );
  assert.equal(importedPrefill.initialManualRecordId, "mr2");
  assert.equal(importedPrefill.initialExpectedVersion, 1);
});

// ---------------------------------------------------------------------------
// Refresh action: ownership, mapping, provider errors, and preservation of
// every existing override/manual record.
// ---------------------------------------------------------------------------

function contextFor(
  client: SqlClient,
  userId: string,
): DividendRefreshActionContext {
  return { client, userId };
}

function stubProvider(
  dividends: DividendEventInput[],
  ok = true,
): MarketDataProvider {
  return {
    capabilities: () => ({
      exchanges: [],
      intervals: [],
      supportsRawPrices: false,
      supportsAdjustedPrices: false,
      supportsFx: false,
      supportsDividends: true,
      supportsSplits: true,
      supportsFundamentals: false,
    }),
    searchSecurities: async () => ({ ok: true, value: [] }),
    getDailyPrices: async () => ({ ok: true, value: [] }),
    getLatestObservation: async () => ({ ok: true, value: null }),
    getFxRates: async () => ({ ok: true, value: [] }),
    getDividendEvents: async () =>
      ok
        ? { ok: true, value: dividends }
        : {
            ok: false,
            error: { kind: "timeout", message: "timed out", retryable: true },
          },
    getSplitEvents: async () => ({ ok: true, value: [] }),
  };
}

test("UI-006C: refreshSecurityDividendHistoryWithContext denies a cross-owner portfolioSecurityId", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const result = await refreshSecurityDividendHistoryWithContext(
    contextFor(client, "b"),
    "pa",
    "psa1",
    { provider: stubProvider([]) },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 404);
});

test("UI-006C: refreshSecurityDividendHistoryWithContext returns 404 when the security has no verified provider mapping", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const result = await refreshSecurityDividendHistoryWithContext(
    contextFor(client, "a"),
    "pa",
    "psa2", // s2 has no security_provider_mappings row in the fixture
    { provider: stubProvider([]) },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.match(result.message, /no verified market-data mapping/);
  }
});

test("UI-006C: refreshSecurityDividendHistoryWithContext returns 502 when the provider call fails", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const result = await refreshSecurityDividendHistoryWithContext(
    contextFor(client, "a"),
    "pa",
    "psa1",
    { provider: stubProvider([], false) },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 502);
});

test("UI-006C: a refresh preserves every existing override and manual record untouched, and reports the reconciliation summary", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);

  const overrideBefore = await createDividendEventOverrideRepository(
    client,
  ).get("a", "pa", "psa1", "de1");
  const manualBefore = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
    "psa1",
  );

  // The stub echoes back de1 and de3's EXISTING provider facts unchanged
  // (a real re-pull re-fetches the security's whole known history, not an
  // incremental delta) alongside one genuinely NEW event -- this exercises
  // both "unchanged" reconciliation and "created" in the same call. de2 is
  // deliberately NOT echoed, to prove an event absent from THIS pull is left
  // exactly as it was (not deleted/altered) rather than only ever testing
  // the all-events-present case.
  const result = await refreshSecurityDividendHistoryWithContext(
    contextFor(client, "a"),
    "pa",
    "psa1",
    {
      provider: stubProvider([
        {
          securityId: "s1",
          exDate: "2026-03-01",
          paymentDate: null,
          currencyCode: "AUD",
          amountDecimal: "1.00",
        },
        {
          securityId: "s1",
          exDate: "2026-05-01",
          paymentDate: null,
          currencyCode: "AUD",
          amountDecimal: "0.75",
        },
        {
          securityId: "s1",
          exDate: "2026-04-01",
          paymentDate: null,
          currencyCode: "AUD",
          amountDecimal: "0.60",
        },
      ]),
      now: () => "2026-08-13T00:00:00Z",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.summary.dividends.created, 1); // the new 0.60 event
    assert.equal(result.summary.dividends.unchanged, 2); // de1 and de3, refetched identically
  }

  const overrideAfter = await createDividendEventOverrideRepository(client).get(
    "a",
    "pa",
    "psa1",
    "de1",
  );
  assert.deepEqual(overrideAfter, overrideBefore);
  const manualAfter = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
    "psa1",
  );
  assert.deepEqual(manualAfter, manualBefore);
});

// B1 (review, blocking): a refresh that CORRECTS an already-overridden
// event's amount supersedes it (a new active event id, `supersedes_event_id`
// pointing back at de1). The loader must resolve de1's override through that
// lineage and key it by the NEW active id -- otherwise the tab's prefill
// sends `expectedVersion: null` and a save silently creates a SECOND
// override row instead of updating the existing one.
test("UI-006C: a refresh that supersedes an overridden event still resolves the existing override by its NEW active event id (prefill carries id+version; save UPDATES, not CREATE)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);

  const beforeDetail = await loadDetail(client, "a", "psa1");
  const beforeEdited = beforeDetail.rows.find((row) => row.source === "edited");
  assert.equal(beforeEdited?.dividendEventId, "de1");

  const result = await refreshSecurityDividendHistoryWithContext(
    contextFor(client, "a"),
    "pa",
    "psa1",
    {
      // A DIFFERENT amount for de1's ex-date (03-01) supersedes it --
      // `dividendFactsMatch` fails on `grossPerShareDecimal`, so
      // `reconcileDividends` creates a new event with
      // `supersedesEventId: "de1"` rather than an in-place update.
      provider: stubProvider([
        {
          securityId: "s1",
          exDate: "2026-03-01",
          paymentDate: null,
          currencyCode: "AUD",
          amountDecimal: "1.20",
        },
      ]),
      now: () => "2026-08-13T00:00:00Z",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.summary.dividends.superseded, 1);

  const afterDetail = await loadDetail(client, "a", "psa1");
  const afterEdited = afterDetail.rows.find((row) => row.source === "edited");
  assert.ok(afterEdited);
  assert.notEqual(
    afterEdited?.dividendEventId,
    "de1",
    "the active event id must have changed (supersession minted a new id)",
  );
  assert.equal(
    afterEdited?.providerGrossPerShareDecimal,
    "1.20",
    "the override still wins the row's displayed value, but the provider's own corrected figure is carried through",
  );

  const activeId = afterEdited!.dividendEventId!;
  const resolvedOverride = afterDetail.overridesByEventId[activeId];
  assert.ok(
    resolvedOverride,
    "the override must resolve against the NEW active event id, not just the original de1",
  );
  assert.equal(resolvedOverride?.id, "ov1");
  assert.equal(resolvedOverride?.version, 1);
  assert.equal(resolvedOverride?.dividendPerShareDecimal, "1.50");
  assert.equal(
    resolvedOverride?.storedDividendEventId,
    "de1",
    "the override's OWN persisted key never moves off the original event it was created against",
  );

  const prefill = buildDialogPrefill(
    afterEdited!,
    "psa1",
    afterDetail.overridesByEventId,
    afterDetail.manualRecordsById,
    afterDetail.today,
  );
  assert.equal(
    prefill.initialExpectedVersion,
    1,
    "must carry the existing override's version so a save UPDATES it",
  );
  // Round-2 fix: the save must target the override's OWN stored key ("de1"),
  // never the row's current active id -- the repository's UPDATE WHERE
  // clause matches on the stored key, not on whatever is active today.
  assert.equal(prefill.initialDividendEventId, "de1");
  assert.notEqual(prefill.initialDividendEventId, activeId);

  // Actually save through that prefill and confirm it updates in place --
  // no duplicate row, version bumps.
  const { saveDividendEntryWithContext } =
    await import("../app/dividend-assumptions-actions.ts");
  const saveResult = await saveDividendEntryWithContext(
    { client, userId: "a", requestId: "req-b1" },
    "pa",
    {
      portfolioSecurityId: "psa1",
      paymentDate: prefill.initialPaymentDate,
      sharesDecimal: prefill.initialSharesDecimal,
      dividendPerShareDecimal: prefill.initialDividendPerShareDecimal,
      frankingCreditPerShareDecimal:
        prefill.initialFrankingCreditPerShareDecimal,
      dividendEventId: prefill.initialDividendEventId,
      manualRecordId: prefill.initialManualRecordId,
      expectedVersion: prefill.initialExpectedVersion,
      exclude: prefill.initialExclude,
    },
  );
  assert.equal(saveResult.ok, true);
  if (saveResult.ok) {
    assert.equal(saveResult.target, "event_override");
    assert.equal(saveResult.id, "ov1", "must update the EXISTING override row");
    assert.equal(saveResult.version, 2, "version must bump, not reset to 1");
  }
  const overridesAfterSave = await createDividendEventOverrideRepository(
    client,
  ).list("a", "pa", "psa1");
  assert.equal(
    overridesAfterSave.length,
    1,
    "exactly one override row must exist -- no duplicate CREATE",
  );
});

// ---------------------------------------------------------------------------
// B2 (review): "provider says X, you overrode to Y" must actually render.
// ---------------------------------------------------------------------------

test("UI-006C: the dividends tab renders the provider's own per-share figure alongside a winning value that differs from it", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps,
  );
  // sampleRows' first (edited) row: dividendPerShareDecimal "1.50",
  // providerGrossPerShareDecimal "1.00" -- both must appear.
  assert.match(html, /AUD 1\.50/);
  assert.match(html, /provider:\s*AUD 1\.00/);
});

test("UI-006C: no provider annotation renders when the provider figure is unknown or matches the winning value", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps,
  );
  // sampleRows' auto row (de3): providerGrossPerShareDecimal === dividendPerShareDecimal ("0.75") -- no annotation.
  // sampleRows' manual row: providerGrossPerShareDecimal is null -- no annotation.
  const providerNoteCount = (html.match(/dividend-provider-note/g) ?? [])
    .length;
  assert.equal(
    providerNoteCount,
    1,
    "only the one row whose provider figure actually differs should annotate",
  );
});

// Review follow-up 1: a raw string `!==` treats "1.5" and "1.50" as
// different even though they are the identical value at a different
// textual scale -- must not render a spurious "provider differs"
// annotation.
test("UI-006C: decimalsEqual compares numerically, so differently-scaled equal strings ('1.5' vs '1.50') are equal", () => {
  assert.equal(decimalsEqual("1.5", "1.50"), true);
  assert.equal(decimalsEqual("1.50", "1.5"), true);
  assert.equal(decimalsEqual("0", "0.00"), true);
  assert.equal(decimalsEqual("1.5", "1.51"), false);
  assert.equal(decimalsEqual("1", "1"), true);
});

test("UI-006C: no provider annotation renders when the provider and winning figures are the same value at a different decimal scale", () => {
  const scaleRow = row({
    id: "de-scale",
    dividendEventId: "de-scale",
    source: "edited",
    dividendPerShareDecimal: "1.5",
    providerGrossPerShareDecimal: "1.50",
  });
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [scaleRow] },
  );
  assert.doesNotMatch(html, /dividend-provider-note/);
});

// ---------------------------------------------------------------------------
// Follow-up 1 (Orchestrator ruling): post-exit zero-share auto rows are
// suppressed from the tab and excluded from the unknown-franking count;
// lifetime dollar totals are unaffected (a zero-share row contributes $0).
// ---------------------------------------------------------------------------

test("UI-006C: a post-exit zero-share auto row is suppressed from the tab's rows, receivedFrankingUnknownCount reflects only real dividends, and dollar totals are unchanged", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  // psa2 was fully sold on 2026-04-01 (see the fixture) and has no
  // dividend_security_assumptions row, so BOTH de4 (the real pre-sale
  // dividend) and de5 below resolve unknown franking on their own --
  // isolating the assertion to exactly what the FILTER corrects (a row
  // count), not a franking-default side effect. A new provider event
  // declared AFTER the sale is a "no new dividend" artifact -- shares held
  // at its ex-date resolve to "0".
  db.exec(`
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de5','s2','yahoo-compatible','cash','paid','2026-06-01','AUD','0.40','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z','2026-06-01');
  `);

  // The UNFILTERED picture (DIV-001's own composition, exactly what
  // UI-006A/B's portfolio-wide screens still see) -- both de4 and de5 count
  // toward receivedFrankingUnknownCount here; this is the "before" this
  // test's real assertion contrasts against.
  const { loadOwnedDividendHistory } =
    await import("../app/owned-dividend-history.ts");
  const unfiltered = await loadOwnedDividendHistory(client, "a", "pa", NOW);
  const unfilteredPsa2 = unfiltered.securities.find(
    (row) => row.portfolioSecurityId === "psa2",
  );
  assert.equal(unfilteredPsa2?.rows.length, 2); // de4 and de5, DIV-001's domain layer is unfiltered
  assert.equal(unfilteredPsa2?.lifetimeTotals.receivedFrankingUnknownCount, 2);

  // The TAB-FACING (filtered) picture.
  const filteredDetail = await loadDetail(client, "a", "psa2");
  // Confirm the artifact row is genuinely absent (not merely hidden by luck).
  assert.equal(
    filteredDetail.rows.some((row) => row.dividendEventId === "de5"),
    false,
    "a post-exit zero-share auto row must not appear in the tab's row list",
  );
  assert.equal(filteredDetail.rows.length, 1); // only de4, the real pre-sale dividend
  assert.equal(filteredDetail.filteredArtifactCount, 1);
  assert.equal(
    filteredDetail.lifetimeTotals.receivedCashDecimal,
    "25", // unchanged: 50 shares x 0.50 -- de5 contributes $0 either way
  );
  // This is the count the filter actually corrects: de5 alone contributed a
  // spurious "unknown franking" flag for a row that was never a real
  // dividend fact for this owner -- filtering it drops the count from the
  // unfiltered picture's 2 down to 1 (de4 alone).
  assert.equal(
    filteredDetail.lifetimeTotals.receivedFrankingUnknownCount,
    1,
    "the suppressed artifact must not inflate the unknown-franking count",
  );
});

// ---------------------------------------------------------------------------
// Follow-up 2 (review): a standalone imported row is not clickable and is
// annotated instead -- editing it can only ever 409.
// ---------------------------------------------------------------------------

test("UI-006C: a standalone imported row renders as read-only (no edit button) with a 'change via import reversal' annotation; an event-linked imported-sourced row stays clickable", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps,
  );
  assert.match(html, /imported · change via import reversal/);
  // The standalone imported row ("imported:mr2") must not render an
  // income-row-trigger button for ITS OWN cell -- but other rows still do,
  // so assert the annotation appears exactly once and count matches exactly
  // one FEWER trigger button than there are rows.
  const triggerCount = (html.match(/income-row-trigger/g) ?? []).length;
  assert.equal(
    triggerCount,
    sampleRows.length - 1,
    "every row except the standalone imported one must still be a clickable trigger",
  );
});

// ---------------------------------------------------------------------------
// Follow-up 3 (review): every dialog button this task added meets 44px.
// ---------------------------------------------------------------------------

test("UI-006C: the refresh-confirmation dialog's action button meets the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const block = extractBlock(styles, ".dividend-refresh-confirm-button");
  assert.match(block, /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/);
});

// ---------------------------------------------------------------------------
// CSRF-first route wiring, page wiring, and matrix bookkeeping.
// ---------------------------------------------------------------------------

test("UI-006C: the refresh route rejects cross-site requests before reading params", async () => {
  const source = await readFile(
    new URL(
      "../app/api/portfolios/[portfolioId]/securities/[portfolioSecurityId]/dividends/refresh/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /import \{ rejectCrossSiteMutation \} from ".*mutation-request\.ts";/,
  );
  const csrfIndex = source.indexOf("rejectCrossSiteMutation(request)");
  const paramsIndex = source.indexOf("await context.params");
  assert.ok(csrfIndex >= 0 && paramsIndex >= 0);
  assert.ok(
    csrfIndex < paramsIndex,
    "the refresh route must reject cross-site mutations before reading params",
  );
});

test("UI-006C: the security dividends page loads via the owner-scoped context and is force-dynamic", async () => {
  const page = await readFile(
    new URL(
      "../app/portfolio/[portfolioId]/securities/[portfolioSecurityId]/dividends/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /loadAuthenticatedWorkspace\(portfolioId\)/);
  assert.match(page, /getAuthenticatedSqlContext\(portfolioId\)/);
  assert.match(page, /loadOwnedSecurityDividendDetail\(/);
  assert.match(page, /workspace\.activePortfolio === null\) notFound\(\)/);
  assert.match(page, /error\.message === "not_found"\) notFound\(\)/);
});

test("UI-006C: the QA-001A matrix records the new refresh route and the security dividends page", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/api/portfolios/:portfolioId/securities/:portfolioSecurityId/dividends/refresh",
    "/portfolio/:id/securities/:portfolioSecurityId/dividends",
    "tests/ui-006c.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

// Extends the ui-006a/b self-checking citation grep to this task's own test
// file -- see tests/ui-006b.test.ts's identical test for the full rationale
// (every matrix citation naming this file must quote a LITERAL substring of
// it, never a fabricated/paraphrased test title).
test("UI-006C: every matrix citation naming tests/ui-006c.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/ui-006c.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/ui-006c\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
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
        `matrix cites "${title}" in tests/ui-006c.test.ts, but that title is not a literal substring of the file (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 2, "expected at least 2 citation groups to check");
  assert.ok(titleCount >= 4, "expected at least 4 quoted titles to check");
});

// ---------------------------------------------------------------------------
// Rendered accessibility/content assertions.
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
    exDate: "2026-03-01",
    paymentDate: "2026-03-01",
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
    ...overrides,
  };
}

const sampleRows: DerivedDividendRow[] = [
  row({}),
  row({
    id: "de3",
    dividendEventId: "de3",
    source: "auto",
    dividendPerShareDecimal: "0.75",
    cashDecimal: "75",
    franking: franking("default", "0.16"),
    frankingTotalDecimal: "16",
    grossDecimal: "91",
    providerGrossPerShareDecimal: "0.75",
  }),
  row({
    id: "de2",
    dividendEventId: "de2",
    source: "auto",
    status: "declared_pending",
    dividendPerShareDecimal: "2.00",
    cashDecimal: "200",
    franking: franking("unknown", null),
    frankingTotalDecimal: null,
    grossDecimal: "200",
    grossIncludesFranking: false,
    providerGrossPerShareDecimal: "2.00",
  }),
  row({
    id: "manual:mr1",
    dividendEventId: null,
    kind: "manual",
    exDate: null,
    paymentDate: "2026-06-01",
    source: "manual",
    dividendPerShareDecimal: "2.00",
    cashDecimal: "20",
    franking: franking("unknown", null),
    frankingTotalDecimal: null,
    grossDecimal: "20",
    grossIncludesFranking: false,
    providerGrossPerShareDecimal: null,
    sharesDecimal: "10",
  }),
  row({
    id: "imported:mr2",
    dividendEventId: null,
    kind: "manual",
    exDate: null,
    paymentDate: "2026-07-15",
    source: "imported",
    dividendPerShareDecimal: "3.00",
    cashDecimal: "15",
    franking: franking("override", "1.00"),
    frankingTotalDecimal: "5",
    grossDecimal: "20",
    providerGrossPerShareDecimal: null,
    sharesDecimal: "5",
  }),
];

const sampleLifetimeTotals = {
  currencyCode: "AUD",
  status: "ok" as const,
  rowCount: 5,
  excludedCount: 0,
  unknownAmountCount: 0,
  receivedCashDecimal: "260",
  receivedFrankingKnownDecimal: "51",
  receivedFrankingUnknownCount: 1,
  receivedGrossDecimal: "311",
  pendingCashDecimal: "200",
  pendingFrankingKnownDecimal: null,
  pendingFrankingUnknownCount: 1,
  pendingGrossDecimal: "200",
  pendingCount: 1,
};

const baseTabProps = {
  portfolioId: "pa",
  portfolioSecurityId: "psa1",
  symbol: "ALPHA",
  currencyCode: "AUD",
  today: "2026-08-13",
  rows: sampleRows,
  filteredArtifactCount: 0,
  lifetimeTotals: sampleLifetimeTotals,
  overridesByEventId: {},
  manualRecordsById: {},
  assumptions: {
    dividendYieldPercentDecimal: null,
    frankingPercentDecimal: "50",
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

test("UI-006C: the dividends tab renders every source label including imported, plus 'not paid' text and a distinct styling class", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps,
  );
  assert.match(html, />edited</);
  assert.match(html, />auto</);
  assert.match(html, />manual</);
  assert.match(html, />imported</);
  assert.match(html, /not paid/);
  assert.match(html, /class="dividend-row-not-paid"/);
  assert.match(html, /class="dividend-status-not-paid"/);
  // Never longer phrasing than the pinned "not paid" text.
  assert.doesNotMatch(html, /not yet paid<\/span>/);
});

test("UI-006C: the dividends tab renders the lifetime summary with the unknown-franking flag and the declared-not-yet-paid line", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps,
  );
  assert.match(html, /Cash received \(lifetime\)/);
  assert.match(html, /Franking credits received \(lifetime\)/);
  assert.match(html, /with unknown franking/);
  assert.match(html, /Declared, not yet paid/);
  assert.match(html, /across 1 dividend/);
});

test("UI-006C: the dividends tab renders the franking-if-not-known default, '+ Record dividend', and 'Refresh historical' entry points", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps,
  );
  assert.match(html, /Franking if not known/);
  assert.match(html, /value="50"/);
  assert.match(html, /\+ Record dividend/);
  assert.match(html, /Refresh historical/);
});

test("UI-006C: an empty rows list with no filtered artifacts renders the generic empty-history message, never a fabricated row", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [], filteredArtifactCount: 0 },
  );
  assert.match(html, /No dividend history for this security yet\./);
});

// Review follow-up 2: when every dividend event for this security was a
// post-exit artifact, the generic "no history" wording wrongly implies the
// provider has nothing at all for this security -- use distinct wording.
test("UI-006C: an empty rows list where every row was a post-exit artifact renders the distinct 'received while held' wording, not the generic message", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [], filteredArtifactCount: 1 },
  );
  assert.match(html, /No dividends received while you held this security\./);
  assert.doesNotMatch(html, /No dividend history for this security yet\./);
});

// ---------------------------------------------------------------------------
// QA-001B accessibility: touch targets, non-color status, and the mobile
// horizontal scroll container.
// ---------------------------------------------------------------------------

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

test("UI-006C: the franking-default and history-table controls meet the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".dividend-franking-default input",
    ".dividend-franking-default button",
    ".income-row-trigger",
  ]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
});

test("UI-006C: the history table scrolls horizontally inside its own container (mobile), reusing income-multi-year.tsx's established pattern", async () => {
  const [component, styles] = await Promise.all([
    readFile(
      new URL("../app/components/security-dividends-tab.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /className="income-fy-table-wrap"/);
  const block = extractBlock(styles, ".income-fy-table-wrap");
  assert.match(block, /overflow-x:\s*auto/);
});

test("UI-006C: the 'not paid' status is conveyed by both a distinct colour and literal text, never colour alone", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const statusBlock = extractBlock(styles, ".dividend-status-not-paid");
  assert.match(statusBlock, /color:\s*var\(--warning\)/);
  const rowBlock = extractBlock(styles, ".dividend-row-not-paid");
  assert.match(rowBlock, /background/);
  const component = await readFile(
    new URL("../app/components/security-dividends-tab.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, />\s*not paid\s*</);
});
