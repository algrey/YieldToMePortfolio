/**
 * BUG-023 — `sanitizeManualRecordAmounts` marks an unreadable per-share
 * franking credit (`frankingCreditPerShareDecimal`) with the
 * `"frankingPerShare"` `unreadableFields` marker, but no consumer read it:
 * `resolveOwnerFact` passed the (now-nulled) value straight through to
 * `resolveFrankingPerShare` as `overrideFrankingPerShare`, which cannot
 * distinguish "no per-share credit was ever entered" from "one was entered
 * but is unreadable" -- both reach it as `null`. With a security-level
 * default franking assumption on file, the default tier fired and silently
 * derived a KNOWN franking figure from a value this app could not actually
 * read: byte-identical to a genuinely absent value, but the underlying fact
 * is corrupt, not absent, and the derived figure inflated gross and
 * flowed into `receivedFrankingKnownDecimal` with no disclosure.
 *
 * Fixed by extending BUG-021's `frankingUnreadable` disclosure to the
 * per-share case: `resolveOwnerFact` now also reports
 * `frankingPerShareUnreadable`, and every franking-per-share derivation
 * site (`resolveFrankingPerShareRespectingUnreadable`) forces the
 * resolution to `"unknown"` -- never calling `resolveFrankingPerShare` at
 * all -- when that flag is set, so the default tier can never fire.
 *
 * Verified, and confirmed already safe (no change needed): the `"shares"`
 * and `"perShare"` markers cannot let any consumer substitute a default or
 * derived number. `computeCashGrossOrTotals` requires BOTH
 * `dividendPerShareDecimal` and `sharesDecimal` non-null to compute a cash
 * figure at all, so nulling either one (by either marker) simply falls
 * through to the "totally unknown" branch -- `cashDecimal`/
 * `frankingTotalDecimal`/`grossDecimal` all `null`, disclosed via the
 * pre-existing `amountUnreadable` flag. `resolveFrankingPerShare`'s own
 * default tier already requires a non-null `dividendPerShareDecimal` to
 * gross up, so an unreadable `"perShare"` field blocks the default tier on
 * its own, with no additional guard needed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mock } from "node:test";
import test from "node:test";
import {
  computeLifetimeDividendTotals,
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/index.ts";
import { frankingDisplay } from "../app/dividend-history-prefill.ts";

const NINETY_SEVEN_DIGITS = "1".repeat(97);

function event(
  overrides: Partial<ProviderDividendEventFact> & { id: string },
): ProviderDividendEventFact {
  return {
    kind: "cash",
    status: "paid",
    exDate: "2026-08-01",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "1.00",
    supersedesEventId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 1: the core repro, across every code path that derives a per-share
// franking resolution -- the event-anchored main loop, and both eventless
// (Round B) `pushEventlessRow` branches (manual-only, imported-only).
// ---------------------------------------------------------------------------

test("BUG-023: an event-anchored manual record with an unreadable per-share franking credit never takes the default assumption -- disclosed as frankingUnreadable, franking stays unknown, gross equals cash", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2026-08-01" }),
  ];
  const record: DividendManualRecordFact = {
    id: "m1",
    paymentDate: "2026-08-04", // within PROXIMITY_WINDOW_DAYS of e1's exDate
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.50",
    // 97 fractional digits -- unreadable, not absent.
    frankingCreditPerShareDecimal: `0.${NINETY_SEVEN_DIGITS}`,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: null,
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-a",
      securityCurrencyCode: "AUD",
      events,
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      // A real default assumption on file -- the exact condition that let
      // the default tier silently fire for a corrupt (not absent) value.
      defaultFrankingPercentDecimal: "50",
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.source, "manual");
  assert.equal(row.cashDecimal, "15", "cash still computes -- unaffected");
  assert.equal(row.amountUnknown, false);
  assert.equal(
    row.amountUnreadable ?? false,
    false,
    "the cash amount itself is fine -- only the franking credit was corrupt",
  );
  assert.equal(
    row.franking.source,
    "unknown",
    "must never silently substitute the default assumption for an unreadable value",
  );
  assert.equal(row.franking.perShareDecimal, null);
  assert.equal(row.frankingTotalDecimal, null);
  assert.equal(row.frankingUnreadable, true);
  assert.equal(
    row.grossDecimal,
    row.cashDecimal,
    "gross equals cash when franking is unknown (grossIncludesFranking: false)",
  );
  assert.equal(row.grossIncludesFranking, false);

  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.status, "ok");
  if (totals.status !== "ok") return;
  assert.equal(totals.receivedCashDecimal, "15");
  assert.equal(
    totals.receivedFrankingKnownDecimal,
    "0",
    "never inflated by a default-derived figure",
  );
  assert.equal(totals.receivedFrankingUnknownCount, 1);
});

test("BUG-023: an eventless standalone manual record (no provider event) with an unreadable per-share franking credit has the identical outcome", () => {
  const record: DividendManualRecordFact = {
    id: "m2",
    paymentDate: "2026-08-04",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.50",
    frankingCreditPerShareDecimal: `0.${NINETY_SEVEN_DIGITS}`,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: null,
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-b",
      securityCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      defaultFrankingPercentDecimal: "50",
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.cashDecimal, "15");
  assert.equal(row.franking.source, "unknown");
  assert.equal(row.frankingTotalDecimal, null);
  assert.equal(row.frankingUnreadable, true);
  assert.equal(row.grossDecimal, "15");
});

test("BUG-023: an eventless standalone IMPORTED (CSV) per-share record with an unreadable per-share franking credit has the identical outcome", () => {
  const record: DividendManualRecordFact = {
    id: "i1",
    paymentDate: "2026-08-04",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.50",
    frankingCreditPerShareDecimal: `0.${NINETY_SEVEN_DIGITS}`,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-c",
      securityCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      defaultFrankingPercentDecimal: "50",
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.source, "imported");
  assert.equal(row.cashDecimal, "15");
  assert.equal(row.franking.source, "unknown");
  assert.equal(row.frankingTotalDecimal, null);
  assert.equal(row.frankingUnreadable, true);
  assert.equal(row.grossDecimal, "15");
});

// ---------------------------------------------------------------------------
// Part 2: guard -- a genuinely absent (never entered) per-share franking
// credit is completely unaffected and still takes the default assumption,
// exactly as before this fix (mirrors DIV-007's absent-vs-unreadable
// distinction for the per-share case).
// ---------------------------------------------------------------------------

test("BUG-023 guard: a genuinely absent (never entered) per-share franking credit still takes the default assumption, unaffected by this fix", () => {
  const record: DividendManualRecordFact = {
    id: "m3",
    paymentDate: "2026-08-04",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.50",
    frankingCreditPerShareDecimal: null, // never entered -- genuinely absent
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: null,
  };

  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-d",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [record],
    transactions: [],
    defaultFrankingPercentDecimal: "50",
    today: "2026-09-19",
  });

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(
    row.franking.source,
    "default",
    "an absent value must still take the default -- only UNREADABLE values are blocked",
  );
  assert.equal(row.frankingUnreadable ?? false, false);
  assert.ok(row.frankingTotalDecimal !== null);
});

// ---------------------------------------------------------------------------
// Part 3: verification (not a fix -- confirms no change was needed) that
// the "shares" and "perShare" markers cannot let any consumer substitute a
// default or derived number either.
// ---------------------------------------------------------------------------

test('BUG-023 verification: an unreadable sharesDecimal ("shares" marker) never derives/defaults a share count -- the row\'s cash and gross stay genuinely unknown', () => {
  const record: DividendManualRecordFact = {
    id: "m4",
    paymentDate: "2026-08-04",
    // 65 total digits -- unreadable, not absent.
    sharesDecimal: "1".repeat(65),
    dividendPerShareDecimal: "1.50",
    frankingCreditPerShareDecimal: "0.30", // readable, irrelevant to this check
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: null,
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-e",
      securityCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      defaultFrankingPercentDecimal: "50",
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.sharesDecimal, null, "never fabricated/derived");
  assert.equal(row.cashDecimal, null, "never fabricated as 0");
  assert.equal(row.amountUnknown, true);
  assert.equal(row.amountUnreadable, true);
  assert.equal(
    row.frankingTotalDecimal,
    null,
    "no cash baseline means no franking total either -- never a lone franking figure beside an unavailable amount",
  );
});

test('BUG-023 verification: an unreadable dividendPerShareDecimal ("perShare" marker) blocks the default franking tier on its own -- resolveFrankingPerShare already requires a known per-share amount to gross up', () => {
  const record: DividendManualRecordFact = {
    id: "m5",
    paymentDate: "2026-08-04",
    sharesDecimal: "10",
    // 97 fractional digits -- unreadable, not absent.
    dividendPerShareDecimal: `1.${NINETY_SEVEN_DIGITS}`,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: null,
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-f",
      securityCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      defaultFrankingPercentDecimal: "50",
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.dividendPerShareDecimal, null, "never fabricated/derived");
  assert.equal(row.cashDecimal, null);
  assert.equal(row.amountUnknown, true);
  assert.equal(row.amountUnreadable, true);
  assert.equal(
    row.franking.source,
    "unknown",
    "the default tier cannot gross up an unknown per-share amount",
  );
  assert.equal(row.frankingTotalDecimal, null);
});

// ---------------------------------------------------------------------------
// Part 4: rendered markup -- both surfaces render the distinct "Franking
// unavailable — needs correction" copy for a PER-SHARE row (never "Unknown"
// or a fabricated franking figure), mirroring BUG-021's identical rendering
// tests for the TOTALS-mode case.
// ---------------------------------------------------------------------------

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
    import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
    const routerStub = {
      push() {},
      replace() {},
      back() {},
      forward() {},
      refresh() {},
      prefetch() {},
    };
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

// A PER-SHARE row (`dividendPerShareDecimal !== null`) whose franking credit
// is unreadable -- BEFORE this fix, `frankingDisplay` took the per-share
// branch (`row.dividendPerShareDecimal !== null`) straight to `frankingCell`,
// which renders a plain "Unknown" for `franking.source === "unknown"` with
// no way to tell "never entered" from "unreadable" apart.
const perShareFrankingUnreadableRow = {
  id: "manual:m1",
  portfolioSecurityId: "psa1",
  dividendEventId: null,
  kind: "manual",
  currencyCode: "AUD",
  exDate: null,
  paymentDate: "2026-08-04",
  sharesDecimal: "10",
  dividendPerShareDecimal: "1.50",
  cashDecimal: "15",
  franking: { source: "unknown", perShareDecimal: null },
  frankingTotalDecimal: null,
  grossDecimal: "15",
  grossIncludesFranking: false,
  status: "ex_date_passed",
  source: "manual",
  excluded: false,
  amountUnknown: false,
  amountUnreadable: false,
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
  frankingUnreadable: true,
};

test("BUG-023: frankingDisplay (security Dividends tab's franking cell) renders 'Franking unavailable — needs correction' for a PER-SHARE row, not 'Unknown'", () => {
  const text = frankingDisplay(perShareFrankingUnreadableRow as never, "AUD");
  assert.equal(text, "Franking unavailable — needs correction");
});

test("BUG-023: the security Dividends tab renders the per-share franking-unreadable row's franking cell as 'Franking unavailable — needs correction', while its cash figure renders normally", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      portfolioId: "pa",
      portfolioSecurityId: "psa1",
      symbol: "ALPHA",
      currencyCode: "AUD",
      baseCurrencyCode: "AUD",
      today: "2026-09-19",
      rows: [perShareFrankingUnreadableRow],
      filteredArtifactCount: 0,
      lifetimeTotals: {
        currencyCode: "AUD",
        status: "ok",
        rowCount: 1,
        excludedCount: 0,
        unknownAmountCount: 0,
        receivedCashDecimal: "15",
        receivedFrankingKnownDecimal: "0",
        receivedFrankingUnknownCount: 1,
        receivedGrossDecimal: "15",
        pendingCashDecimal: null,
        pendingFrankingKnownDecimal: null,
        pendingFrankingUnknownCount: 0,
        pendingGrossDecimal: null,
        pendingCount: 0,
      },
      overridesByEventId: {},
      manualRecordsById: {},
      frankingOverridesByManualRecordId: {},
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
      subtitle: "Alpha Fixture · XASX · AUD",
    },
  );
  assert.match(html, /Franking unavailable — needs correction/);
  assert.match(html, /\$15\.00/, "the cash figure renders normally");
  assert.doesNotMatch(
    html,
    />Unknown</,
    "must never fall back to the generic 'Unknown' label for a corrupt (not absent) value",
  );
});

test("BUG-023: the /income dividends list renders the per-share franking-unreadable row's franking cell as 'Franking unavailable — needs correction', while its cash figure renders normally", () => {
  // Full pipeline, not a hand-built fixture: derives the actual row through
  // `deriveDividendHistoryForSecurity` (identical to the standalone-manual
  // repro above) so this test also fails pre-fix if the DOMAIN layer ever
  // regresses, not only if `owned-dividend-list.tsx`'s own markup changes.
  const record: DividendManualRecordFact = {
    id: "m2",
    paymentDate: "2026-08-04",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.50",
    frankingCreditPerShareDecimal: `0.${NINETY_SEVEN_DIGITS}`,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: null,
  };
  const warnMock = mock.method(console, "warn", () => {});
  let derivedRow;
  try {
    const rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-b",
      securityCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      defaultFrankingPercentDecimal: "50",
      today: "2026-09-19",
    });
    derivedRow = rows[0]!;
  } finally {
    warnMock.mock.restore();
  }

  const html = renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      baseCurrencyCode: "AUD",
      today: "2026-09-19",
      rows: [
        {
          id: `psa1:${derivedRow.id}`,
          portfolioSecurityId: "psa1",
          symbol: "ALPHA",
          currencyCode: derivedRow.currencyCode,
          paymentDate: derivedRow.paymentDate,
          exDate: derivedRow.exDate,
          notPaid: derivedRow.status === "declared_pending",
          cashDecimal: derivedRow.cashDecimal,
          amountUnreadable: derivedRow.amountUnreadable ?? false,
          frankingTotalDecimal: derivedRow.frankingTotalDecimal,
          frankingDerivedZero: derivedRow.frankingDerivedZero,
          frankingUnreadable: derivedRow.frankingUnreadable ?? false,
          grossDecimal: derivedRow.grossDecimal,
          source: derivedRow.source,
          excluded: derivedRow.excluded,
          originalCurrencyCode: derivedRow.originalCurrencyCode,
          fxRateToPortfolioDecimal: derivedRow.fxRateToPortfolioDecimal,
          fxRateSource: derivedRow.fxRateSource,
        },
      ],
      truncated: false,
      totalCount: 1,
    },
  );
  assert.match(html, /Franking unavailable — needs correction/);
  assert.match(html, /\$15\.00/);
  assert.doesNotMatch(html, /Amount unavailable — needs correction/);
});
