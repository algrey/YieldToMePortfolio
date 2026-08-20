// DIV-007 (owner ruling 2026-08-20, "zero if zero"): RMD's real USD
// dividends showed franking "Unavailable" because Sharesight OMITS the
// franking field entirely on a foreign-currency (USD) payout while
// demonstrably sending an EXPLICIT `franking_credits: 0` for an unfranked
// AUD (native-currency) payout. At derivation time only (the stored fact
// stays exactly what Sharesight sent -- never rewritten), an ABSENT
// franking total on a Sharesight-imported totals-mode fact is treated as
// $0 REPORTED, an inference from that demonstrated explicit-zero behaviour,
// marked distinctly (`frankingDerivedZero`) so the UI never implies
// Sharesight itself confirmed an unfranked payout. See TASKS.md's DIV-007
// entry for the full ruling and `docs/CALCULATIONS.md` section 11 for the
// documented inference.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  computeFyDividendTotals,
  computeLifetimeDividendTotals,
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
} from "../domain/dividends/index.ts";
import { frankingDisplay } from "../app/dividend-history-prefill.ts";

function rmdShapedUsdRecord(
  overrides: Partial<DividendManualRecordFact> = {},
): DividendManualRecordFact {
  return {
    id: "rmd-usd-1",
    paymentDate: "2026-06-15",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "20.4",
    totalFrankingDecimal: null, // Sharesight omitted the field entirely
    importBatchId: "batch-rmd",
    currencyCode: "USD",
    // BRK-010's own live-confirmed reciprocal-rate evidence.
    fxRateToPortfolioDecimal: "1.539583333355785590278105",
    fxRateSource: "sharesight",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. RMD-shaped imported USD row: absent franking derives to a known $0.
// ---------------------------------------------------------------------------

test("DIV-007: an RMD-shaped imported USD row with absent franking derives $0 with distinct provenance", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-rmd",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [rmdShapedUsdRecord()],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  // Cash still converts normally (BRK-010 unaffected).
  assert.equal(
    row.cashDecimal,
    "31.407500000458026041673342", // 20.4 * 1.539583333355785590278105, exact
  );
  assert.equal(row.amountUnknown, false);
  // The headline fix: no longer null/"Unavailable".
  assert.equal(row.frankingTotalDecimal, "0");
  assert.equal(row.frankingDerivedZero, true);
  // Gross = cash + 0, and the gross-includes-franking flag is honestly true
  // (a known $0 franking figure, not an omitted one).
  assert.equal(row.grossDecimal, row.cashDecimal);
  assert.equal(row.grossIncludesFranking, true);

  // Provenance label renders the known $0 as a TOTAL (review B1: labelled
  // distinctly from a per-share figure in the same column), distinctly from
  // a real reported figure -- never "Unavailable"/"Unknown".
  assert.equal(frankingDisplay(row), "AUD 0.00 total (none reported)");
});

test("DIV-007: lifetime and FY totals count the derived $0 as a KNOWN zero, not unknown", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-rmd",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [rmdShapedUsdRecord()],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });

  const lifetime = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(lifetime.status, "ok");
  assert.equal(lifetime.receivedFrankingUnknownCount, 0);
  assert.equal(lifetime.receivedFrankingKnownDecimal, "0");
  // Gross = cash + the known (derived) $0 franking.
  assert.equal(lifetime.receivedGrossDecimal, rows[0]!.cashDecimal);

  const fy = computeFyDividendTotals(rows, [], 7);
  assert.equal(fy.ok, true);
  if (!fy.ok) return;
  assert.equal(fy.totals.length, 1);
  assert.equal(fy.totals[0]?.frankingUnknownCount, 0);
  assert.equal(fy.totals[0]?.frankingKnownDecimal, "0");
});

// ---------------------------------------------------------------------------
// 2. Owner-manual null-franking row keeps existing unknown semantics.
// ---------------------------------------------------------------------------

test("DIV-007: an owner-typed manual record with null franking stays unknown (never derived)", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-manual",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "manual-1",
        paymentDate: "2026-06-15",
        sharesDecimal: "100",
        dividendPerShareDecimal: "0.50",
        frankingCreditPerShareDecimal: null,
        importBatchId: null, // owner-typed, never Sharesight-imported
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.source, "manual");
  assert.equal(rows[0]?.franking.source, "unknown");
  assert.equal(rows[0]?.frankingTotalDecimal, null);
  assert.equal(rows[0]?.frankingDerivedZero, false);

  const lifetime = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(lifetime.receivedFrankingUnknownCount, 1);
});

// ---------------------------------------------------------------------------
// 3. Imported AUD row with an EXPLICIT "0" -- unchanged, was never unknown.
// ---------------------------------------------------------------------------

test("DIV-007: an imported AUD row with an explicit '0' franking total is unaffected -- was never unknown, stays a real reported zero", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-aud",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "aud-zero-1",
        paymentDate: "2026-05-01",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "48",
        totalFrankingDecimal: "0", // Sharesight's own explicit zero
        importBatchId: "batch-aud",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.frankingTotalDecimal, "0");
  // Distinctly NOT a DIV-007 inference -- a real Sharesight-reported figure.
  assert.equal(rows[0]?.frankingDerivedZero, false);
  assert.equal(frankingDisplay(rows[0]!), "AUD 0.00 total");

  const lifetime = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(lifetime.receivedFrankingUnknownCount, 0);
});

// ---------------------------------------------------------------------------
// 4 & 5. BRK-010's nonzero-foreign-franking unverified-currency guard is
// untouched, and coexists with DIV-007's absent-franking derivation within
// the SAME derivation call.
// ---------------------------------------------------------------------------

test("DIV-007: the BRK-010 nonzero-foreign-franking guard stays unknown, unaffected, and coexists with an absent-franking row derived in the SAME call", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-both",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      rmdShapedUsdRecord({ id: "absent-row" }), // absent -- DIV-007 derives $0
      {
        id: "nonzero-foreign-row",
        paymentDate: "2026-07-01",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "10",
        totalFrankingDecimal: "3.21", // present, nonzero, foreign -- BRK-010 guard
        importBatchId: "batch-nonzero",
        currencyCode: "USD",
        fxRateToPortfolioDecimal: "2",
        fxRateSource: "sharesight",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 2);

  const absent = rows.find((row) => row.id === "imported:absent-row");
  assert.equal(absent?.frankingTotalDecimal, "0");
  assert.equal(absent?.frankingDerivedZero, true);

  const nonzero = rows.find((row) => row.id === "imported:nonzero-foreign-row");
  assert.equal(nonzero?.cashDecimal, "20"); // cash conversion unaffected
  assert.equal(
    nonzero?.frankingTotalDecimal,
    null,
    "BRK-010's unverified-nonzero-foreign guard must stay untouched",
  );
  assert.equal(nonzero?.frankingDerivedZero, false);
});

// ---------------------------------------------------------------------------
// Review round 1, F2: negative controls the reviewer had to probe by hand.
// ---------------------------------------------------------------------------

test("DIV-007 F2(a): a totals-mode imported fact whose CURRENCY CONVERSION fails closed stays fully unknown -- never a lone derived $0 beside an unavailable cash amount", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-bad-rate",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      rmdShapedUsdRecord({
        id: "bad-rate-1",
        // Malformed -- write-time validation already rejects this shape
        // going forward, but a legacy/direct-DB-write row is not otherwise
        // guarded (mirrors the existing F3 read-time-isolation coverage).
        fxRateToPortfolioDecimal: "not-a-decimal",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.cashDecimal, null, "cash conversion itself fails closed");
  assert.equal(row.amountUnknown, true);
  assert.equal(
    row.frankingTotalDecimal,
    null,
    "franking must stay unknown, never derived, when the row's own cash is unavailable",
  );
  assert.equal(row.frankingDerivedZero, false);
});

test("DIV-007 F2(b): a CSV-imported PER-SHARE fact (not totals-mode) with a null per-share franking credit stays unknown -- only a totals-mode fact ever qualifies for derivation", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-csv-per-share",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "csv-per-share-1",
        paymentDate: "2026-06-15",
        sharesDecimal: "100", // per-share fact -- IMP-006 CSV import shape
        dividendPerShareDecimal: "0.75",
        frankingCreditPerShareDecimal: null,
        importBatchId: "batch-csv", // imported tier, but NOT totals-mode
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.source, "imported");
  assert.equal(rows[0]?.franking.source, "unknown");
  assert.equal(rows[0]?.frankingTotalDecimal, null);
  assert.equal(rows[0]?.frankingDerivedZero, false);
});

test("DIV-007 F2(c): a derived $0 survives into dominatedImported when an owner-typed manual record wins the same event", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-dominated",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [
      {
        id: "ev1",
        kind: "cash",
        status: "paid",
        exDate: "2026-06-01",
        paymentDate: "2026-06-10",
        currencyCode: "AUD",
        grossPerShareDecimal: "1.00",
        supersedesEventId: null,
      },
    ],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "owner-manual-1",
        paymentDate: "2026-06-12", // within window of the event's own date
        sharesDecimal: "50",
        dividendPerShareDecimal: "0.80",
        frankingCreditPerShareDecimal: null,
        importBatchId: null, // owner-typed -- wins over the imported tier
      },
      rmdShapedUsdRecord({
        id: "dominated-imported-1",
        paymentDate: "2026-06-08", // also within window of the same event
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.source, "manual"); // owner-typed manual wins the row
  assert.ok(
    row.dominatedImported,
    "the imported fact must be disclosed, not dropped",
  );
  assert.equal(row.dominatedImported?.totalFrankingDecimal, "0");
  assert.equal(row.dominatedImported?.frankingDerivedZero, true);
});

// ---------------------------------------------------------------------------
// Rendered component assertions (all-dividends list + per-security tab).
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
  withRouterStub = false,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = withRouterStub
    ? `
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
  `
    : `
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

test("DIV-007: the all-dividends list renders '$0.00' with a 'none reported' note for a derived-zero row, never 'Unavailable'", () => {
  const html = renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      landingHref: "/portfolio/pa/income",
      today: "2026-08-19",
      truncated: false,
      totalCount: 1,
      rows: [
        {
          id: "ps-rmd:imported:rmd-usd-1",
          portfolioSecurityId: "ps-rmd",
          symbol: "RMD",
          currencyCode: "AUD",
          paymentDate: "2026-06-15",
          exDate: null,
          notPaid: false,
          cashDecimal: "31.41",
          frankingTotalDecimal: "0",
          frankingDerivedZero: true,
          grossDecimal: "31.41",
          source: "imported",
          excluded: false,
          originalCurrencyCode: "USD",
          fxRateToPortfolioDecimal: "1.539583",
          fxRateSource: "sharesight",
        },
      ],
    },
  );
  assert.doesNotMatch(html, /Unavailable/);
  assert.match(html, /AUD\s*0\.00/);
  assert.match(html, /none reported/);
});

test("DIV-007 F2(d): the per-security tab's Franking/share column renders a totals-mode figure with the ' total' unit suffix, and 'none reported' only on the derived-zero row", () => {
  function totalsRow(
    overrides: Partial<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      id: "row-1",
      portfolioSecurityId: "psa1",
      dividendEventId: null,
      kind: "manual",
      currencyCode: "AUD",
      exDate: null,
      paymentDate: "2026-06-15",
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      cashDecimal: "48.00",
      franking: { source: "unknown", perShareDecimal: null },
      frankingTotalDecimal: null,
      grossDecimal: "48.00",
      grossIncludesFranking: false,
      status: "ex_date_passed",
      source: "imported",
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
      ...overrides,
    };
  }

  const derivedZeroRow = totalsRow({
    id: "row-derived-zero",
    frankingTotalDecimal: "0",
    frankingDerivedZero: true,
  });
  const reportedPositiveRow = totalsRow({
    id: "row-reported-positive",
    paymentDate: "2026-05-01",
    cashDecimal: "40.00",
    frankingTotalDecimal: "16.00",
    grossDecimal: "56.00",
    grossIncludesFranking: true,
  });

  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      portfolioId: "pa",
      portfolioSecurityId: "psa1",
      symbol: "RMD",
      currencyCode: "AUD",
      today: "2026-08-19",
      rows: [derivedZeroRow, reportedPositiveRow],
      filteredArtifactCount: 0,
      lifetimeTotals: {
        currencyCode: "AUD",
        status: "ok",
        rowCount: 2,
        excludedCount: 0,
        unknownAmountCount: 0,
        receivedCashDecimal: "88.00",
        receivedFrankingKnownDecimal: "16.00",
        receivedFrankingUnknownCount: 0,
        receivedGrossDecimal: "104.00",
        pendingCashDecimal: null,
        pendingFrankingKnownDecimal: null,
        pendingFrankingUnknownCount: 0,
        pendingGrossDecimal: null,
        pendingCount: 0,
      },
      overridesByEventId: {},
      manualRecordsById: {},
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
    },
    true, // needs the router stub (SecurityDividendsTab is "use client", calls useRouter)
  );
  // The derived-zero row: a TOTAL (never mistaken for a per-share credit),
  // and honestly marked "none reported" -- an inference, not a Sharesight-
  // confirmed unfranked payout.
  assert.match(html, /AUD 0\.00 total \(none reported\)/);
  // The reported positive row: a real TOTAL, never suffixed "none reported".
  assert.match(html, /AUD 16\.00 total(?! \(none reported\))/);
  assert.doesNotMatch(html, /total total/);
});
