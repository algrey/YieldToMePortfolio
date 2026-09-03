/**
 * BUG-021 — a malformed dividend amount already stored (written before
 * BUG-014's write-time bound, or by any direct-DB path that bound does not
 * gate) crashed `/income` and the security Dividends tab for the WHOLE
 * security: `domain/dividends/history.ts`'s `computeCashGrossOrTotals` and
 * `domain/dividends/history-row-derivation.ts`'s `deriveHistoryRowDps`
 * re-parse a stored `dividend_manual_records` amount with `parseDecimal`
 * with no isolation, so one over-bound or non-canonical value threw
 * uncaught out of `deriveDividendHistoryForSecurity`.
 *
 * Fixed with a read-time pre-pass, `sanitizeManualRecordAmounts`, mirroring
 * BRK-010 F3's per-record FX isolation precedent: an unreadable field is
 * nulled (never fabricated as "0"), `amountUnreadable` is set so a
 * consumer can render "amount unavailable — needs correction" instead of
 * the generic missing-data label, and the rest of the security's rows are
 * completely unaffected.
 *
 * CORRECTION ROUND (F1, BLOCKING): round 1 above nulled an unreadable field
 * but did not record WHICH field was unreadable anywhere a later pre-pass
 * could see -- `deriveAbsentImportedFranking`'s DIV-007 inference read the
 * now-nulled `totalFrankingDecimal` on an imported totals-mode record and
 * could not tell "Sharesight genuinely sent nothing" from "this app could
 * not read what was stored", so it derived a KNOWN "$0.00 (none reported)"
 * for an unreadable franking figure -- exactly the fabricated zero round 1's
 * own text claimed never to happen. The same nulling also let
 * `resolveImportedRecordCurrency`'s B2 unverified-nonzero-foreign guard fall
 * through to its normal success path for an unreadable `totalCashDecimal`,
 * setting `convertedToSecurityCurrency: true` even though nothing was
 * converted. Fixed with a per-field `unreadableFields` marker set on the
 * fact, read by both functions to keep "unreadable" and "genuinely absent"
 * distinct even after both become `null`; a new `frankingUnreadable` row
 * flag renders "Franking unavailable — needs correction". Folded in: an
 * unreadable `frankingOverrideTotalDecimal` (BRK-011) is sanitized the same
 * way (never a throw, never a derived zero); its two writers now also
 * enforce `isWithinReadPathDecimalBounds` (see tests/brk-011.test.ts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import test from "node:test";
import {
  computeLifetimeDividendTotals,
  deriveDividendHistoryForSecurity,
  isReadableStoredDecimal,
  type DividendManualRecordFact,
} from "../domain/dividends/index.ts";

// ---------------------------------------------------------------------------
// Part 1: the pure classifier.
// ---------------------------------------------------------------------------

test("BUG-021: isReadableStoredDecimal accepts an ordinary canonical decimal", () => {
  assert.equal(isReadableStoredDecimal("150.25"), true);
  assert.equal(isReadableStoredDecimal("0"), true);
  assert.equal(isReadableStoredDecimal("-12.5"), true);
});

test("BUG-021: isReadableStoredDecimal rejects a value with more fractional digits than DECIMAL_LIMITS.inputScale (24)", () => {
  const ninetySevenFractionalDigits = `1.${"1".repeat(97)}`;
  assert.equal(isReadableStoredDecimal(ninetySevenFractionalDigits), false);
  // Exactly at the boundary is still readable.
  assert.equal(isReadableStoredDecimal(`1.${"1".repeat(24)}`), true);
});

test("BUG-021: isReadableStoredDecimal rejects a non-canonical value (trailing whitespace, leading zero, negative zero)", () => {
  assert.equal(isReadableStoredDecimal("2.50 "), false);
  assert.equal(isReadableStoredDecimal(" 2.50"), false);
  assert.equal(isReadableStoredDecimal("007"), false);
  assert.equal(isReadableStoredDecimal("-0"), false);
});

test("BUG-021: isReadableStoredDecimal rejects a value with more total digits than DECIMAL_LIMITS.inputDigits (64)", () => {
  assert.equal(isReadableStoredDecimal("1".repeat(65)), false);
  assert.equal(isReadableStoredDecimal("1".repeat(64)), true);
});

// ---------------------------------------------------------------------------
// Part 2: per-record isolation through deriveDividendHistoryForSecurity.
// Mirrors tests/brk-010.test.ts's "F3 read-time isolation" test structure
// (a good record and a bad record, both standalone imported-tier rows).
// ---------------------------------------------------------------------------

function goodImportedRecord(
  id: string,
  paymentDate: string,
): DividendManualRecordFact {
  return {
    id,
    paymentDate,
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
  };
}

test("BUG-021: a stored total with 97 fractional digits isolates -- the record renders unavailable, the sibling record and its totals are unaffected", () => {
  const good = goodImportedRecord("good-1", "2026-08-05");
  const bad: DividendManualRecordFact = {
    id: "bad-1",
    paymentDate: "2026-09-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    // 97 fractional digits -- one of BUG-014's own two reproduction shapes.
    totalCashDecimal: `250.${"1".repeat(97)}`,
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-a",
      securityCurrencyCode: "AUD",
      portfolioBaseCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [good, bad],
      transactions: [],
      defaultFrankingPercentDecimal: null,
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(
    rows.length,
    2,
    "both records still produce a row -- never aborted",
  );
  const goodRow = rows.find((row) => row.id === "imported:good-1");
  const badRow = rows.find((row) => row.id === "imported:bad-1");
  assert.equal(goodRow?.cashDecimal, "100", "sibling record's cash unaffected");
  assert.equal(goodRow?.amountUnknown, false);
  assert.equal(goodRow?.amountUnreadable ?? false, false);

  assert.equal(badRow?.cashDecimal, null, "never fabricated as 0");
  assert.equal(badRow?.amountUnknown, true);
  assert.equal(badRow?.amountUnreadable, true);
  assert.equal(
    badRow?.paymentDate,
    "2026-09-05",
    "the row still appears, with its date",
  );

  // One structured warning naming the record id -- never the amount.
  assert.equal(warnMock.mock.calls.length, 1);
  const [message, detail] = warnMock.mock.calls[0]!.arguments as [
    string,
    { recordId: string; fields: string[] },
  ];
  assert.match(message, /unreadable/);
  assert.equal(detail.recordId, "bad-1");
  assert.ok(detail.fields.includes("totalCashDecimal"));
  const loggedText = JSON.stringify([message, detail]);
  assert.doesNotMatch(
    loggedText,
    /250\.1{5}/,
    "the malformed amount itself must never appear in the log",
  );

  // Totals: the unreadable record is excluded and disclosed, not silently
  // dropped or understated.
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.status, "ok");
  if (totals.status !== "ok") return;
  assert.equal(totals.unknownAmountCount, 1);
  assert.equal(totals.receivedCashDecimal, "100");
});

test('BUG-021: a stored total "2.50 " (trailing space, non-canonical) isolates the same way', () => {
  const good = goodImportedRecord("good-2", "2026-08-05");
  const bad: DividendManualRecordFact = {
    id: "bad-2",
    paymentDate: "2026-09-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "2.50 ",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-b",
      securityCurrencyCode: "AUD",
      portfolioBaseCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [good, bad],
      transactions: [],
      defaultFrankingPercentDecimal: null,
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 2);
  const goodRow = rows.find((row) => row.id === "imported:good-2");
  const badRow = rows.find((row) => row.id === "imported:bad-2");
  assert.equal(goodRow?.cashDecimal, "100");
  assert.equal(badRow?.cashDecimal, null);
  assert.equal(badRow?.amountUnknown, true);
  assert.equal(badRow?.amountUnreadable, true);

  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.status, "ok");
  if (totals.status !== "ok") return;
  assert.equal(totals.unknownAmountCount, 1);
  assert.equal(totals.receivedCashDecimal, "100");
});

test("BUG-021: an unreadable franking-only field does not mislabel a perfectly readable cash amount as unreadable", () => {
  const record: DividendManualRecordFact = {
    id: "franking-bad-1",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.50",
    // Non-canonical (trailing space) -- readable cash, unreadable franking.
    frankingCreditPerShareDecimal: "0.30 ",
    totalCashDecimal: null,
    totalFrankingDecimal: null,
    importBatchId: null,
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
      defaultFrankingPercentDecimal: null,
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(
    row.cashDecimal,
    "15",
    "cash still computes -- shares x per-share, unaffected",
  );
  assert.equal(row.amountUnknown, false);
  assert.equal(
    row.amountUnreadable ?? false,
    false,
    "the cash amount itself is fine -- only franking was corrupt",
  );
  assert.equal(warnMock.mock.calls.length, 1);
});

test("BUG-021: FX isolation (BRK-010 F3) is unaffected -- an unreadable amount and a malformed FX rate on two different records isolate independently", () => {
  const goodFx: DividendManualRecordFact = {
    id: "fx-good",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5",
    fxRateSource: "sharesight",
  };
  const badFx: DividendManualRecordFact = {
    id: "fx-bad",
    paymentDate: "2026-08-06",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "200",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "not-a-decimal",
    fxRateSource: "sharesight",
  };
  const badAmount: DividendManualRecordFact = {
    id: "amount-bad",
    paymentDate: "2026-08-07",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "2.50 ",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-d",
      securityCurrencyCode: "AUD",
      portfolioBaseCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [goodFx, badFx, badAmount],
      transactions: [],
      defaultFrankingPercentDecimal: null,
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 3, "no record's row is ever dropped");
  const goodFxRow = rows.find((row) => row.id === "imported:fx-good");
  const badFxRow = rows.find((row) => row.id === "imported:fx-bad");
  const badAmountRow = rows.find((row) => row.id === "imported:amount-bad");
  assert.equal(goodFxRow?.cashDecimal, "150"); // converted, unaffected
  assert.equal(badFxRow?.cashDecimal, null); // BRK-010 F3 degrades this record's conversion
  assert.equal(
    badFxRow?.amountUnreadable ?? false,
    false,
    "FX degradation is not amount-unreadable",
  );
  assert.equal(badAmountRow?.cashDecimal, null);
  assert.equal(badAmountRow?.amountUnreadable, true);
});

// ---------------------------------------------------------------------------
// Correction round (F1, BLOCKING): the imported-tier pre-passes that run
// AFTER sanitizeManualRecordAmounts must not treat an unreadable nulled
// value as if it were genuinely absent.
// ---------------------------------------------------------------------------

test("BUG-021 correction round (F1): an unreadable stored totalFrankingDecimal on an imported totals-mode record is disclosed as frankingUnreadable, never derived to a fabricated '$0.00 (none reported)' -- reproduced with an importBatchId record and a totalCashDecimal, the tier round 1's own franking test never touched", () => {
  const record: DividendManualRecordFact = {
    id: "franking-total-bad",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    // Non-canonical (trailing space) -- unreadable, not absent.
    totalFrankingDecimal: "97." + "1".repeat(97),
    importBatchId: "batch-a",
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-e",
      securityCurrencyCode: "AUD",
      portfolioBaseCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      defaultFrankingPercentDecimal: null,
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.cashDecimal, "100", "the readable cash total is intact");
  assert.equal(row.amountUnknown, false);
  assert.equal(row.amountUnreadable ?? false, false);
  assert.equal(
    row.frankingTotalDecimal,
    null,
    "never a fabricated derived total",
  );
  assert.equal(
    row.frankingDerivedZero,
    false,
    "must not be mistaken for DIV-007's absent-field inference",
  );
  assert.equal(row.frankingUnreadable, true);

  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.status, "ok");
  if (totals.status !== "ok") return;
  assert.equal(totals.receivedCashDecimal, "100");
  assert.equal(
    totals.receivedFrankingUnknownCount,
    1,
    "excluded from franking sums, disclosed, never silently zeroed",
  );
});

test("BUG-021 correction round (F1/B2): an unreadable totalCashDecimal on a FOREIGN, otherwise-achievable-conversion imported record keeps the pre-round-1 conservative outcome -- never marked as converted", () => {
  const record: DividendManualRecordFact = {
    id: "cash-bad-foreign",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    // 97 fractional digits -- unreadable.
    totalCashDecimal: `250.${"1".repeat(97)}`,
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5",
    fxRateSource: "sharesight",
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-f",
      securityCurrencyCode: "AUD",
      portfolioBaseCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [record],
      transactions: [],
      defaultFrankingPercentDecimal: null,
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.cashDecimal, null);
  assert.equal(row.amountUnreadable, true);
  // The B2 guard's conservative pre-fix outcome: nothing was converted, so
  // no conversion provenance is claimed -- the row's own (foreign) currency
  // displays honestly instead of a misleading "converted from USD" note
  // beside an unavailable amount.
  assert.equal(
    row.originalCurrencyCode,
    null,
    "must not claim a conversion that never happened",
  );
  assert.equal(row.currencyCode, "USD", "the record's true currency shows");
  assert.equal(row.fxRateToPortfolioDecimal, null);
});

test("BUG-021 correction round (fold-in 1): an unreadable owner franking-currency override (BRK-011) is treated as no override -- absent with disclosure, never a throw and never a fabricated zero", () => {
  const overrideBadAbsentStored: DividendManualRecordFact = {
    id: "override-bad-absent",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    frankingOverrideTotalDecimal: `1.${"1".repeat(97)}`,
  };
  const overrideBadGoodStored: DividendManualRecordFact = {
    id: "override-bad-good-stored",
    paymentDate: "2026-08-06",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    // A genuine, readable Sharesight-reported figure...
    totalFrankingDecimal: "5",
    importBatchId: "batch-a",
    // ...but the owner's override on top of it is unreadable.
    frankingOverrideTotalDecimal: "1".repeat(65),
  };

  const warnMock = mock.method(console, "warn", () => {});
  let rows;
  try {
    rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps-g",
      securityCurrencyCode: "AUD",
      portfolioBaseCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [overrideBadAbsentStored, overrideBadGoodStored],
      transactions: [],
      defaultFrankingPercentDecimal: null,
      today: "2026-09-19",
    });
  } finally {
    warnMock.mock.restore();
  }

  assert.equal(rows.length, 2, "no throw -- both records still produce a row");
  const absentRow = rows.find(
    (row) => row.id === "imported:override-bad-absent",
  );
  const goodStoredRow = rows.find(
    (row) => row.id === "imported:override-bad-good-stored",
  );

  // The override could not be read AND nothing else was stored: absent,
  // disclosed, never a fabricated zero.
  assert.equal(absentRow?.cashDecimal, "100");
  assert.equal(absentRow?.frankingTotalDecimal, null);
  assert.equal(absentRow?.frankingDerivedZero, false);
  assert.equal(absentRow?.frankingUnreadable, true);

  // The override could not be read, but the record's OWN stored figure was
  // fine -- the real reported value must still surface, not "unreadable".
  assert.equal(goodStoredRow?.cashDecimal, "100");
  assert.equal(goodStoredRow?.frankingTotalDecimal, "5");
  assert.equal(goodStoredRow?.frankingDerivedZero, false);
  assert.equal(
    goodStoredRow?.frankingUnreadable ?? false,
    false,
    "a bad override must not shadow a perfectly good stored figure",
  );
});

// ---------------------------------------------------------------------------
// Part 3: rendered markup on the security Dividends tab and the /income
// dividends list -- the affected row still appears, with its date, and a
// non-color status text distinct from the generic "Unavailable"/"not paid".
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

const unreadableSecurityRow = {
  id: "imported:bad-1",
  portfolioSecurityId: "psa1",
  dividendEventId: null,
  kind: "cash",
  currencyCode: "AUD",
  exDate: null,
  paymentDate: "2026-09-05",
  sharesDecimal: null,
  dividendPerShareDecimal: null,
  cashDecimal: null,
  franking: { source: "unknown", perShareDecimal: null },
  frankingTotalDecimal: null,
  grossDecimal: null,
  grossIncludesFranking: false,
  status: "ex_date_passed",
  source: "imported",
  excluded: false,
  amountUnknown: true,
  amountUnreadable: true,
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

const okSecurityRow = {
  ...unreadableSecurityRow,
  id: "imported:good-1",
  paymentDate: "2026-08-05",
  cashDecimal: "100",
  grossDecimal: "100",
  amountUnknown: false,
  amountUnreadable: false,
};

test("BUG-021: the security Dividends tab renders an unreadable-amount row with its date and the distinct 'needs correction' status, and never drops the sibling row", () => {
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
      rows: [okSecurityRow, unreadableSecurityRow],
      filteredArtifactCount: 0,
      lifetimeTotals: {
        currencyCode: "AUD",
        status: "ok",
        rowCount: 2,
        excludedCount: 0,
        unknownAmountCount: 1,
        receivedCashDecimal: "100",
        receivedFrankingKnownDecimal: null,
        receivedFrankingUnknownCount: 0,
        receivedGrossDecimal: "100",
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
    },
  );
  assert.match(
    html,
    /2026-09-05/,
    "the unreadable row still shows its own date",
  );
  assert.match(html, /Amount unavailable — needs correction/);
  assert.match(html, /class="dividend-status-unreadable"/);
  assert.match(html, />needs correction</);
  // Never a fabricated "0.00" for the unreadable row.
  assert.doesNotMatch(html, /\$0\.00/);
  // The sibling row's real amount still renders.
  assert.match(html, /\$100\.00/);
  assert.match(
    html,
    /1 with an unknown amount, excluded from totals\./,
    "totals disclose the excluded record rather than silently understating",
  );
});

test("BUG-021: the /income dividends list renders the same unreadable-amount row with its date and 'needs correction' status", () => {
  const html = renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      baseCurrencyCode: "AUD",
      today: "2026-09-19",
      rows: [
        {
          id: "psa1:imported:good-1",
          portfolioSecurityId: "psa1",
          symbol: "ALPHA",
          currencyCode: "AUD",
          paymentDate: "2026-08-05",
          exDate: null,
          notPaid: false,
          cashDecimal: "100",
          amountUnreadable: false,
          frankingTotalDecimal: null,
          frankingDerivedZero: false,
          grossDecimal: "100",
          source: "imported",
          excluded: false,
          originalCurrencyCode: null,
          fxRateToPortfolioDecimal: null,
          fxRateSource: null,
        },
        {
          id: "psa1:imported:bad-1",
          portfolioSecurityId: "psa1",
          symbol: "ALPHA",
          currencyCode: "AUD",
          paymentDate: "2026-09-05",
          exDate: null,
          notPaid: false,
          cashDecimal: null,
          amountUnreadable: true,
          frankingTotalDecimal: null,
          frankingDerivedZero: false,
          grossDecimal: null,
          source: "imported",
          excluded: false,
          originalCurrencyCode: null,
          fxRateToPortfolioDecimal: null,
          fxRateSource: null,
        },
      ],
      truncated: false,
      totalCount: 2,
    },
  );
  assert.match(html, /2026-09-05/);
  assert.match(html, /Amount unavailable — needs correction/);
  assert.match(html, /class="dividend-status-unreadable"/);
  assert.match(html, />needs correction</);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /\$100\.00/);
});

// ---------------------------------------------------------------------------
// Correction round (c): a row whose franking (not cash) is unreadable
// renders "Franking unavailable — needs correction" on both surfaces, and
// the cash figure itself renders normally (unaffected).
// ---------------------------------------------------------------------------

const frankingUnreadableSecurityRow = {
  ...okSecurityRow,
  id: "imported:franking-bad-1",
  paymentDate: "2026-09-05",
  frankingUnreadable: true,
};

test("BUG-021 correction round: the security Dividends tab renders a franking-only-unreadable row's franking cell as 'Franking unavailable — needs correction', while its cash figure renders normally", () => {
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
      rows: [frankingUnreadableSecurityRow],
      filteredArtifactCount: 0,
      lifetimeTotals: {
        currencyCode: "AUD",
        status: "ok",
        rowCount: 1,
        excludedCount: 0,
        unknownAmountCount: 0,
        receivedCashDecimal: "100",
        receivedFrankingKnownDecimal: null,
        receivedFrankingUnknownCount: 1,
        receivedGrossDecimal: "100",
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
    },
  );
  assert.match(html, /Franking unavailable — needs correction/);
  // The cash figure itself is fine and must not read as unavailable.
  assert.match(html, /\$100\.00/);
  assert.doesNotMatch(html, /Amount unavailable — needs correction/);
});

test("BUG-021 correction round: the /income dividends list renders a franking-only-unreadable row's franking cell as 'Franking unavailable — needs correction', while its cash figure renders normally", () => {
  const html = renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      baseCurrencyCode: "AUD",
      today: "2026-09-19",
      rows: [
        {
          id: "psa1:imported:franking-bad-1",
          portfolioSecurityId: "psa1",
          symbol: "ALPHA",
          currencyCode: "AUD",
          paymentDate: "2026-09-05",
          exDate: null,
          notPaid: false,
          cashDecimal: "100",
          amountUnreadable: false,
          frankingTotalDecimal: null,
          frankingDerivedZero: false,
          frankingUnreadable: true,
          grossDecimal: "100",
          source: "imported",
          excluded: false,
          originalCurrencyCode: null,
          fxRateToPortfolioDecimal: null,
          fxRateSource: null,
        },
      ],
      truncated: false,
      totalCount: 1,
    },
  );
  assert.match(html, /Franking unavailable — needs correction/);
  assert.match(html, /\$100\.00/);
  assert.doesNotMatch(html, /Amount unavailable — needs correction/);
});

// ---------------------------------------------------------------------------
// Correction round (F2): `docs/CALCULATIONS.md`'s ops-note diagnostic query
// undercounted -- `LENGTH(col) - INSTR(col, '.')` is NOT 0 for a dot-less
// value (INSTR returns 0, so the expression is the value's FULL length),
// so a canonical 25-64-digit dot-less integer was wrongly counted as
// unreadable. Pinned directly against the doc's own SQL (source-pin
// convention, mirroring tests/imp-003b.test.ts) so a future edit that
// reintroduces the bug fails this test.
// ---------------------------------------------------------------------------

test("BUG-021 correction round (F2): the CALCULATIONS.md ops-note query counts a canonical dot-less 30-digit integer as READABLE, not a false positive", async () => {
  const doc = await readFile(
    new URL("../docs/CALCULATIONS.md", import.meta.url),
    "utf8",
  );
  const marker = "Ops note (read-only";
  const markerIndex = doc.indexOf(marker);
  assert.ok(markerIndex >= 0, "the ops-note section must still exist");
  const fenceStart = doc.indexOf("```sql", markerIndex);
  assert.ok(fenceStart >= 0);
  const fenceBodyStart = doc.indexOf("\n", fenceStart) + 1;
  const fenceEnd = doc.indexOf("```", fenceBodyStart);
  const sql = doc.slice(fenceBodyStart, fenceEnd);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE dividend_manual_records (
      user_id TEXT,
      shares_decimal TEXT,
      dividend_per_share_decimal TEXT,
      franking_credit_per_share_decimal TEXT,
      total_cash_decimal TEXT,
      total_franking_decimal TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO dividend_manual_records (user_id, shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal, total_cash_decimal, total_franking_decimal) VALUES (?, NULL, NULL, NULL, NULL, NULL)`,
  );
  // Canonical dot-less 30-digit integer -- the false-positive shape.
  insert.run("dotless-30");
  db.exec(
    `UPDATE dividend_manual_records SET shares_decimal = '${"1".repeat(30)}' WHERE user_id = 'dotless-30'`,
  );
  // Ordinary canonical value.
  db.exec(
    `INSERT INTO dividend_manual_records (user_id, shares_decimal) VALUES ('canonical', '150.25')`,
  );
  // 97 fractional digits -- must still be counted.
  db.exec(
    `INSERT INTO dividend_manual_records (user_id, shares_decimal) VALUES ('over-scale', '1.${"1".repeat(97)}')`,
  );
  // 65 total digits -- must still be counted.
  db.exec(
    `INSERT INTO dividend_manual_records (user_id, shares_decimal) VALUES ('over-digits', '${"1".repeat(65)}')`,
  );

  const rows = db.prepare(sql).all() as {
    user_id: string;
    unreadable_amount_count: number;
  }[];
  const byUser = new Map(
    rows.map((row) => [row.user_id, row.unreadable_amount_count]),
  );

  assert.equal(
    byUser.get("dotless-30"),
    undefined,
    "a canonical dot-less 30-digit integer must not be counted as unreadable",
  );
  assert.equal(byUser.get("canonical"), undefined);
  assert.equal(byUser.get("over-scale"), 1);
  assert.equal(byUser.get("over-digits"), 1);
});
