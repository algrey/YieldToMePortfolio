// BUG-005 (owner-reported): the per-security Dividends tab
// (`app/components/security-dividends-tab.tsx`) showed "Shares at ex-date"
// and "Per share" as "Unknown" for every BRK-005 totals-mode Sharesight
// import (total cash + total franking, no recorded shares/per-share amount)
// even though the IDENTICAL division already powers the 12-month forecast's
// history-TTM fallback (`domain/dividends/forecast.ts`'s
// `deriveHistoryTrailingTwelveMonthDividend`). Fixed by extracting that
// division into `domain/dividends/history-row-derivation.ts`
// (`deriveHistoryRowDps`/`deriveHistoryRowFrankingPerShare`, moved verbatim
// from `forecast.ts`) plus a new `deriveHistoryRowDisplay` wrapper the tab's
// loader (`app/owned-security-dividends.ts`) now calls per row, exposed to
// the component as `rowDisplayById` -- never a second/parallel formula.
//
// This file covers: (1) the shared domain-level derivation directly
// (totals-mode, per-share-mode passthrough, a known-shares/unknown-rate
// edge case, and a provable history gap); (2) a PARITY pin proving the
// tab's derivation and the forecast's own `deriveHistoryRowDps` produce the
// IDENTICAL numbers on the same fixture; (3) the full loader wiring against
// a migrated D1 fixture; (4) the component's rendering of the derived
// marker text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import { loadOwnedSecurityDividendDetail } from "../app/owned-security-dividends.ts";
import {
  deriveDividendHistoryForSecurity,
  deriveHistoryRowDisplay,
  type DividendManualRecordFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/index.ts";
import { deriveHistoryRowDps } from "../domain/dividends/history-row-derivation.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";

const TODAY = "2026-08-26";

function tx(
  overrides: Partial<LedgerQuantityFact> & { id: string },
): LedgerQuantityFact {
  const localTradeDate = overrides.localTradeDate ?? "2020-01-01";
  return {
    type: "buy",
    status: "posted",
    localTradeDate,
    tradeAt: `${localTradeDate}T00:00:00Z`,
    quantityDecimal: "1",
    unitPriceDecimal: null,
    reversesTransactionId: null,
    ...overrides,
  };
}

function totalsManual(
  overrides: Partial<DividendManualRecordFact> & {
    id: string;
    paymentDate: string;
  },
): DividendManualRecordFact {
  return {
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "500",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    ...overrides,
  };
}

function perShareManual(
  overrides: Partial<DividendManualRecordFact> & {
    id: string;
    paymentDate: string;
  },
): DividendManualRecordFact {
  return {
    sharesDecimal: "10",
    dividendPerShareDecimal: "2.00",
    frankingCreditPerShareDecimal: null,
    importBatchId: null,
    ...overrides,
  };
}

function event(
  overrides: Partial<ProviderDividendEventFact> & { id: string },
): ProviderDividendEventFact {
  return {
    kind: "cash",
    status: "paid",
    exDate: "2026-03-01",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "1.00",
    supersedesEventId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Domain-level derivation (`deriveHistoryRowDisplay`).
// ---------------------------------------------------------------------------

test("BUG-005: a BRK-005 totals-mode row derives shares-at-payment-date and per-share via the SAME division the forecast uses", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-02-01",
        totalCashDecimal: "500",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
      tx({ id: "b2", localTradeDate: "2026-06-01", quantityDecimal: "100" }), // bought AFTER payment -- must not count
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.sharesDecimal, null); // recorded field stays null (BRK-005 invariant)
  assert.equal(row.dividendPerShareDecimal, null);

  const transactions: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    tx({ id: "b2", localTradeDate: "2026-06-01", quantityDecimal: "100" }),
  ];
  const display = deriveHistoryRowDisplay(row, transactions);
  assert.equal(display.sharesDecimal, "100"); // shares held AT the 2026-02-01 payment date, not today's 200
  assert.equal(display.sharesDerivedAtPayment, true);
  assert.equal(display.dividendPerShareDecimal, "5"); // 500 / 100
  assert.equal(display.dividendPerShareDerived, true);
  assert.equal(display.unresolvedReason, null);
});

test("BUG-005: a per-share-mode row is passed through unchanged -- never re-derived", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-02-01",
        sharesDecimal: "10",
        dividendPerShareDecimal: "2.00",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const row = rows[0]!;
  const display = deriveHistoryRowDisplay(row, []);
  assert.equal(display.sharesDecimal, "10");
  assert.equal(display.sharesDerivedAtPayment, false);
  assert.equal(display.dividendPerShareDecimal, "2.00");
  assert.equal(display.dividendPerShareDerived, false);
  assert.equal(display.unresolvedReason, null);
});

test("BUG-005: a row with a known recorded share count but a genuinely unknown per-share amount keeps its REAL share count, never fabricates Unknown for a fact that IS known", () => {
  // A malformed/defensive provider event whose amount is null -- the row's
  // own sharesDecimal is still derived from the ledger at ex-date (a known
  // fact), only the per-share rate is genuinely unresolvable.
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2026-01-01", quantityDecimal: "10" }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [event({ id: "e1", grossPerShareDecimal: null })],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const row = rows[0]!;
  assert.equal(row.sharesDecimal, "10"); // a real, known fact
  assert.equal(row.dividendPerShareDecimal, null);
  assert.equal(row.cashDecimal, null);

  const display = deriveHistoryRowDisplay(row, HOLDING_TX);
  assert.equal(display.sharesDecimal, "10"); // preserved, not nulled out
  assert.equal(display.sharesDerivedAtPayment, false); // it was RECORDED, not derived at payment date
  assert.equal(display.dividendPerShareDecimal, null);
  assert.equal(display.unresolvedReason, "unknown_amount");
});

test("BUG-005: a totals-mode row whose ledger PROVES a history gap (a sell with no prior buy) stays an honest Unknown -- never a fabricated or divide-by-zero value", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-02-01",
        totalCashDecimal: "500",
      }),
    ],
    // No buy at all before the payment date -- a sell recorded against
    // nothing proves the ledger is missing an earlier buy.
    transactions: [
      tx({
        id: "s1",
        type: "sell",
        localTradeDate: "2026-01-01",
        quantityDecimal: "50", // "sell" quantities are stored positive -- deriveSharesHeldAtDate negates them
      }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const row = rows[0]!;
  const transactions: LedgerQuantityFact[] = [
    tx({
      id: "s1",
      type: "sell",
      localTradeDate: "2026-01-01",
      quantityDecimal: "50",
    }),
  ];
  const display = deriveHistoryRowDisplay(row, transactions);
  assert.equal(display.sharesDecimal, null);
  assert.equal(display.sharesDerivedAtPayment, false);
  assert.equal(display.dividendPerShareDecimal, null);
  assert.equal(display.dividendPerShareDerived, false);
  assert.equal(display.unresolvedReason, "history_gap");
});

// ---------------------------------------------------------------------------
// 2. Parity: the tab's derivation and the forecast's own per-row division
//    must produce the IDENTICAL numbers on the same fixture -- proving there
//    is exactly one implementation, not two that happen to agree today.
// ---------------------------------------------------------------------------

test("BUG-005 parity: deriveHistoryRowDisplay's derived per-share rate and shares-at-payment-date exactly match deriveHistoryRowDps -- the same function the forecast's history-TTM fallback calls", () => {
  const transactions: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2019-06-01", quantityDecimal: "333" }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2020-11-13",
        totalCashDecimal: "1439.99",
      }),
    ],
    transactions,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const row = rows[0]!;

  const display = deriveHistoryRowDisplay(row, transactions);
  const forecastLegResult = deriveHistoryRowDps(row, transactions);

  assert.equal(forecastLegResult.ok, true);
  if (!forecastLegResult.ok) throw new Error("unreachable");
  assert.equal(display.dividendPerShareDecimal, forecastLegResult.dpsDecimal);
  assert.equal(display.sharesDecimal, forecastLegResult.sharesAtPaymentDecimal);
  // Fixture-exact: 1439.99 / 333, rounded to the shared 24dp scale.
  assert.equal(display.sharesDecimal, "333");
  assert.equal(display.dividendPerShareDecimal, "4.324294294294294294294294");
});

// ---------------------------------------------------------------------------
// 3. Full loader wiring against a migrated D1 fixture (mirrors UI-006C's own
//    `tests/ui-006c.test.ts` fixture pattern).
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
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01');
    -- BRK-005 totals-mode imported row: total cash + total franking only.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,import_batch_id,total_cash_decimal,total_franking_decimal,created_at,updated_at,version) VALUES
      ('m1','a','pa','psa1','2026-02-01',NULL,NULL,NULL,'batch-a','500',NULL,'2026-08-01','2026-08-01',1);
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa1','buy','posted','2025-01-01T00:00:00Z','2025-01-01','100','5','AUD','500','0','0','manual','a',1,'2025-01-01'),
      ('tx2','a','pa','psa1','buy','posted','2026-06-01T00:00:00Z','2026-06-01','100','5','AUD','500','0','0','manual','a',1,'2026-06-01');
  `);
  return db;
}

test("BUG-005: loadOwnedSecurityDividendDetail exposes rowDisplayById with the derived shares/per-share for a totals-mode manual row", async () => {
  const db = await fixture();
  const client: SqlClient = createSqliteSqlClient(db);
  const detail = await loadOwnedSecurityDividendDetail(
    client,
    "a",
    "pa",
    "psa1",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(detail.rows.length, 1);
  const row = detail.rows[0]!;
  assert.equal(row.sharesDecimal, null);
  assert.equal(row.dividendPerShareDecimal, null);

  const display = detail.rowDisplayById[row.id];
  assert.ok(display);
  assert.equal(display!.sharesDecimal, "100"); // shares held at 2026-02-01, not the current 200
  assert.equal(display!.sharesDerivedAtPayment, true);
  assert.equal(display!.dividendPerShareDecimal, "5");
  assert.equal(display!.dividendPerShareDerived, true);
});

// ---------------------------------------------------------------------------
// 4. Component rendering.
// ---------------------------------------------------------------------------

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
  const routerStub = {
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
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

const totalsModeRow = {
  id: "manual:m1",
  portfolioSecurityId: "psa1",
  dividendEventId: null,
  kind: "cash",
  currencyCode: "AUD",
  exDate: null,
  paymentDate: "2026-02-01",
  sharesDecimal: null,
  dividendPerShareDecimal: null,
  cashDecimal: "500",
  franking: { source: "unknown", perShareDecimal: null },
  frankingTotalDecimal: null,
  grossDecimal: "500",
  grossIncludesFranking: false,
  status: "ex_date_passed",
  source: "manual",
  excluded: false,
  amountUnknown: false,
  providerGrossPerShareDecimal: null,
  dominatedReceipt: null,
  dominatedImported: null,
  additionalReceiptsCount: 0,
  additionalImportedCount: 0,
  originalCurrencyCode: null,
  fxRateToPortfolioDecimal: null,
  fxRateSource: null,
  frankingDerivedZero: false,
  frankingCurrencySource: null,
};

const baseTabProps = {
  portfolioId: "pa",
  portfolioSecurityId: "psa1",
  symbol: "ALPHA",
  currencyCode: "AUD",
  baseCurrencyCode: "AUD",
  today: "2026-08-13",
  rows: [totalsModeRow],
  filteredArtifactCount: 0,
  lifetimeTotals: {
    currencyCode: "AUD",
    status: "ok",
    rowCount: 1,
    excludedCount: 0,
    unknownAmountCount: 0,
    receivedCashDecimal: "500",
    receivedFrankingKnownDecimal: "0",
    receivedFrankingUnknownCount: 1,
    receivedGrossDecimal: "500",
    pendingCashDecimal: "0",
    pendingFrankingKnownDecimal: "0",
    pendingFrankingUnknownCount: 0,
    pendingGrossDecimal: "0",
    pendingCount: 0,
  },
  overridesByEventId: {},
  manualRecordsById: {},
  assumptions: {
    dividendYieldPercentDecimal: null,
    frankingPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    version: null,
  },
  portfolioAssumptions: {
    valueGrowthPercentDecimal: null,
    portfolioDividendGrowthPercentDecimal: null,
    version: null,
  },
  subtitle: "Alpha Fixture · XASX · AUD",
};

test("BUG-005: the tab renders the derived shares/per-share figures plus a compact 'derived at payment date' marker for a totals-mode row, when rowDisplayById is supplied", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      ...baseTabProps,
      rowDisplayById: {
        "manual:m1": {
          sharesDecimal: "100",
          sharesDerivedAtPayment: true,
          dividendPerShareDecimal: "5",
          dividendPerShareDerived: true,
          unresolvedReason: null,
        },
      },
    },
  );
  assert.match(html, /100/); // derived shares figure
  assert.match(html, /dividend-derived-note/);
  assert.match(html, /derived at payment date/);
  // Only the Shares/Per-share cells are fixed by this task -- the Franking
  // column's own "Unknown" (a separate, untouched concern for this
  // totals-mode-with-no-franking-fact fixture) is expected to remain, so
  // this checks the SPECIFIC cells rather than asserting "Unknown" is
  // absent from the whole page.
  const sharesCellMatch = html.match(
    /<td class="numeric">([^<]*)<br\/><span class="dividend-derived-note">derived at payment date/,
  );
  assert.ok(sharesCellMatch);
  assert.equal(sharesCellMatch![1], "100");
  const perShareCellMatch = html.match(
    /<td class="numeric">([^<]*)<br\/><span class="dividend-derived-note">derived: total/,
  );
  assert.ok(perShareCellMatch);
  assert.notEqual(perShareCellMatch![1], "Unknown");
});

test("BUG-005 regression: without rowDisplayById, a totals-mode row still renders the pre-fix honest 'Unknown' (never a runtime crash, never a fabricated value) -- proves the optional prop default is safe for every pre-existing caller/fixture", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps, // no rowDisplayById at all
  );
  assert.match(html, />Unknown</);
  assert.doesNotMatch(html, /dividend-derived-note/);
});
