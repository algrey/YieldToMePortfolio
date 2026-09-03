/** UI-017 — Year-row drill-through to the dividend list. Owner directive:
 * "In the income tab, under Next 12 Months and Multi-Year, when you click
 * on a year row, it should bring up a list of all dividends for that
 * year." */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseDividendListFilter,
  filterRowsForFyWindow,
  filterRowsForNext12,
  MIN_FY_ENDING_YEAR,
  type DividendListFilter,
} from "../app/dividend-list-query.ts";
import {
  fyWindowForEndingYear,
  deriveDividendHistoryForSecurity,
  computeFyDividendTotals,
  type ProviderDividendEventFact,
  type DividendReceiptFact,
  type LedgerQuantityFact,
} from "../domain/dividends/index.ts";
import type { OwnedDividendListRow } from "../app/owned-dividend-list.ts";

// DIV-014 added a `useRouter()` call to `IncomeMultiYear` (`router.refresh()`
// after the new "Save Scenario" save/delete calls), so a bare
// `renderToStaticMarkup` of it now throws "invariant expected app router to
// be mounted". Mirrors `tests/wlt-001.test.ts`'s `AppRouterContext.Provider`
// stub wrapping for `portfolio-shell.tsx` (also a `useRouter()` consumer) --
// harmless for the other components this shared helper renders, which don't
// call `useRouter` at all.
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

// ---------------------------------------------------------------------------
// Part 1: FY window/label derivation for an ending year (the `?fy=` route
// parameter's inverse of `fyWindowForDate`).
// ---------------------------------------------------------------------------

test("UI-017: fyWindowForEndingYear respects the FY start month -- a July-start FY24 window is 2023-07-01..2024-06-30, labelled FY24", () => {
  const result = fyWindowForEndingYear(2024, 7);
  assert.ok(result.ok);
  assert.deepEqual(result.window, {
    startDate: "2023-07-01",
    endDate: "2024-06-30",
  });
  assert.equal(result.label, "FY24");
  assert.equal(result.endingYear, 2024);
});

test("UI-017: fyWindowForEndingYear boundary dates -- 2024-06-30 falls in FY24, 2024-07-01 falls in FY25, for a July-start FY", () => {
  const fy24 = fyWindowForEndingYear(2024, 7);
  const fy25 = fyWindowForEndingYear(2025, 7);
  assert.ok(fy24.ok && fy25.ok);
  assert.ok(
    "2024-06-30" >= fy24.window.startDate &&
      "2024-06-30" <= fy24.window.endDate,
  );
  assert.ok(
    !(
      "2024-06-30" >= fy25.window.startDate &&
      "2024-06-30" <= fy25.window.endDate
    ),
  );
  assert.ok(
    "2024-07-01" >= fy25.window.startDate &&
      "2024-07-01" <= fy25.window.endDate,
  );
  assert.ok(
    !(
      "2024-07-01" >= fy24.window.startDate &&
      "2024-07-01" <= fy24.window.endDate
    ),
  );
});

test("UI-017: fyWindowForEndingYear for a January-start (calendar-year) FY -- ending year equals the calendar year", () => {
  const result = fyWindowForEndingYear(2026, 1);
  assert.ok(result.ok);
  assert.deepEqual(result.window, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  });
  assert.equal(result.label, "FY26");
});

test("UI-017: fyWindowForEndingYear rejects an invalid start month rather than guessing", () => {
  const result = fyWindowForEndingYear(2025, 13);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "invalid_start_month");
});

// ---------------------------------------------------------------------------
// Part 2: `?fy=`/`?window=` query parsing -- clamping, invalid fallback,
// mutual exclusivity.
// ---------------------------------------------------------------------------

test("UI-017: parseDividendListFilter accepts a valid fy and resolves its window/label", () => {
  const filter = parseDividendListFilter({ fy: "2025" }, 2026, 7);
  assert.deepEqual(filter, {
    mode: "fy",
    endingYear: 2025,
    label: "FY25",
    window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  });
});

test("UI-017: parseDividendListFilter degrades an unparseable fy to the honest all-years view, never a crash", () => {
  const filter = parseDividendListFilter({ fy: "not-a-year" }, 2026, 7);
  assert.deepEqual(filter, { mode: "all", invalidFyRequested: true });
});

test("UI-017: parseDividendListFilter degrades an out-of-range fy (below MIN_FY_ENDING_YEAR) to the honest all-years view", () => {
  const filter = parseDividendListFilter(
    { fy: String(MIN_FY_ENDING_YEAR - 1) },
    2026,
    7,
  );
  assert.deepEqual(filter, { mode: "all", invalidFyRequested: true });
});

test("UI-017: parseDividendListFilter degrades a far-future fy (beyond current+1) to the honest all-years view", () => {
  const filter = parseDividendListFilter({ fy: "2099" }, 2026, 7);
  assert.deepEqual(filter, { mode: "all", invalidFyRequested: true });
});

test("UI-017: parseDividendListFilter accepts fy exactly at the current+1 upper bound (the in-progress FY)", () => {
  const filter = parseDividendListFilter({ fy: "2027" }, 2026, 7);
  assert.equal(filter.mode, "fy");
  assert.equal(filter.mode === "fy" && filter.endingYear, 2027);
});

test("UI-017: parseDividendListFilter recognizes ?window=next12", () => {
  const filter = parseDividendListFilter({ window: "next12" }, 2026, 7);
  assert.deepEqual(filter, { mode: "next12" });
});

test("UI-017: an unrecognized ?window= value (and no fy) falls back to the plain all-years view", () => {
  const filter = parseDividendListFilter({ window: "bogus" }, 2026, 7);
  assert.deepEqual(filter, { mode: "all", invalidFyRequested: false });
});

test("UI-017: no query parameters at all renders the plain all-years view", () => {
  const filter = parseDividendListFilter({}, 2026, 7);
  assert.deepEqual(filter, { mode: "all", invalidFyRequested: false });
});

test("UI-017: fy and window=next12 are mutually exclusive -- fy wins when both are present (documented choice)", () => {
  const filter = parseDividendListFilter(
    { fy: "2025", window: "next12" },
    2026,
    7,
  );
  assert.equal(filter.mode, "fy");
  assert.equal(filter.mode === "fy" && filter.endingYear, 2025);
});

// --- Follow-up (round-1 review): strict 4-digit fy parsing -- a lenient
// Number.parseInt silently REINTERPRETS "2025abc"/"2025.9" as 2025 rather
// than rejecting the malformed input, and tolerates leading whitespace.
// Each of these must degrade to the honest fallback, not a silent guess.

for (const malformed of [
  "2025abc",
  " 2025",
  "2025.9",
  "2025 ",
  "+2025",
  "20255",
]) {
  test(`UI-017: parseDividendListFilter rejects the malformed fy "${malformed}" rather than silently reinterpreting it`, () => {
    const filter = parseDividendListFilter({ fy: malformed }, 2026, 7);
    assert.deepEqual(filter, { mode: "all", invalidFyRequested: true });
  });
}

test("UI-017: parseDividendListFilter accepts a plain well-formed 4-digit fy", () => {
  const filter = parseDividendListFilter({ fy: "2025" }, 2026, 7);
  assert.equal(filter.mode, "fy");
  assert.equal(filter.mode === "fy" && filter.endingYear, 2025);
});

// ---------------------------------------------------------------------------
// Part 3: pure row filtering.
// ---------------------------------------------------------------------------

function row(overrides: Partial<OwnedDividendListRow>): OwnedDividendListRow {
  return {
    id: overrides.id ?? "row",
    portfolioSecurityId: "psa1",
    symbol: "ALPHA",
    currencyCode: "AUD",
    paymentDate: null,
    exDate: null,
    notPaid: false,
    cashDecimal: null,
    amountUnreadable: false,
    frankingTotalDecimal: null,
    frankingDerivedZero: false,
    grossDecimal: null,
    source: "auto",
    excluded: false,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
    ...overrides,
  };
}

test("UI-017: filterRowsForFyWindow keeps only rows attributed (by payment date) inside the window (inclusive boundaries)", () => {
  const window = { startDate: "2024-07-01", endDate: "2025-06-30" };
  const rows = [
    row({ id: "in-window", paymentDate: "2025-01-15" }),
    row({ id: "on-start-boundary", paymentDate: "2024-07-01" }),
    row({ id: "on-end-boundary", paymentDate: "2025-06-30" }),
    row({ id: "before-window", paymentDate: "2024-06-30" }),
    row({ id: "after-window", paymentDate: "2025-07-01" }),
  ];
  const result = filterRowsForFyWindow(rows, window);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ["in-window", "on-start-boundary", "on-end-boundary"],
  );
  assert.equal(result.undatedRowCount, 0);
});

test("UI-017 (B1 fix): a provider-derived row with NO payment date but a real ex-date is attributed via the ex-date, mirroring computeFyDividendTotals's paymentDate ?? exDate rule -- it appears in its FY drill-through, not the 'cannot be attributed' bucket", () => {
  const window = { startDate: "2024-07-01", endDate: "2025-06-30" };
  const rows = [
    row({
      id: "ex-date-only-in-window",
      paymentDate: null,
      exDate: "2024-08-01",
    }),
    row({
      id: "ex-date-only-out-of-window",
      paymentDate: null,
      exDate: "2023-08-01",
    }),
  ];
  const result = filterRowsForFyWindow(rows, window);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ["ex-date-only-in-window"],
  );
  // Neither row is "undated" -- both have a real ex-date, just one falls
  // outside this particular window. The undated count must stay 0: it is
  // not "excluded from this FY", it genuinely belongs to a DIFFERENT one.
  assert.equal(result.undatedRowCount, 0);
});

test("UI-017 (B1 fix): only a row with NEITHER a payment date NOR an ex-date counts as undated -- never silently dropped or guessed", () => {
  const window = { startDate: "2024-07-01", endDate: "2025-06-30" };
  const rows = [
    row({ id: "known", paymentDate: "2025-01-15" }),
    row({ id: "neither-date-1", paymentDate: null, exDate: null }),
    row({ id: "neither-date-2", paymentDate: null, exDate: null }),
  ];
  const result = filterRowsForFyWindow(rows, window);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    ["known"],
  );
  assert.equal(result.undatedRowCount, 2);
});

// --- B1 fix: boundary parity between the aggregation total the owner
// clicked and this filter's drill-through -- same rows, driven through
// BOTH `computeFyDividendTotals` and `filterRowsForFyWindow`, must agree
// on membership. Mirrors tests/div-001.test.ts's "B2" repro fixture (one
// receipt-backed payment-dated event plus several ex-date-only provider
// events, all in the same FY).

function fixtureEvent(
  overrides: Partial<ProviderDividendEventFact> & { id: string },
): ProviderDividendEventFact {
  return {
    kind: "cash",
    status: "paid",
    exDate: "2024-03-01",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "1.00",
    supersedesEventId: null,
    ...overrides,
  };
}

const PARITY_HOLDING_TX: LedgerQuantityFact[] = [
  {
    id: "b1",
    type: "buy",
    status: "posted",
    localTradeDate: "2023-01-01",
    tradeAt: "2023-01-01T00:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: null,
    reversesTransactionId: null,
  },
];

/** Mirrors `app/owned-dividend-list.ts`'s own DerivedDividendRow ->
 * OwnedDividendListRow field copy, so the parity check drives the SAME
 * derived rows through both functions rather than two independently
 * hand-built (and possibly silently divergent) fixtures. */
function toListRow(dRow: {
  id: string;
  portfolioSecurityId: string;
  currencyCode: string;
  paymentDate: string | null;
  exDate: string | null;
  status: string;
  cashDecimal: string | null;
  amountUnreadable?: boolean;
  frankingTotalDecimal: string | null;
  frankingDerivedZero: boolean;
  grossDecimal: string | null;
  source: string;
  excluded: boolean;
  originalCurrencyCode: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
}): OwnedDividendListRow {
  return {
    id: `${dRow.portfolioSecurityId}:${dRow.id}`,
    portfolioSecurityId: dRow.portfolioSecurityId,
    symbol: "ALPHA",
    currencyCode: dRow.currencyCode,
    paymentDate: dRow.paymentDate,
    exDate: dRow.exDate,
    notPaid: dRow.status === "declared_pending",
    cashDecimal: dRow.cashDecimal,
    amountUnreadable: dRow.amountUnreadable === true,
    frankingTotalDecimal: dRow.frankingTotalDecimal,
    frankingDerivedZero: dRow.frankingDerivedZero,
    grossDecimal: dRow.grossDecimal,
    source: dRow.source as OwnedDividendListRow["source"],
    excluded: dRow.excluded,
    originalCurrencyCode: dRow.originalCurrencyCode,
    fxRateToPortfolioDecimal: dRow.fxRateToPortfolioDecimal,
    fxRateSource: dRow.fxRateSource,
  };
}

test("UI-017 (B1 fix, boundary parity): every row computeFyDividendTotals attributes to FY24 (via paymentDate ?? exDate) also appears in filterRowsForFyWindow's FY24 drill-through -- same membership, same count", () => {
  const events: ProviderDividendEventFact[] = [
    fixtureEvent({
      id: "e1",
      exDate: "2023-08-01",
      paymentDate: null,
      grossPerShareDecimal: "50",
    }),
    fixtureEvent({
      id: "e2",
      exDate: "2023-10-01",
      paymentDate: null,
      grossPerShareDecimal: "50",
    }),
    fixtureEvent({
      id: "e3",
      exDate: "2024-01-01",
      paymentDate: null,
      grossPerShareDecimal: "50",
    }),
    // The 4th event has an actual receipt with a real payment date.
    fixtureEvent({ id: "e4", exDate: "2024-04-01", paymentDate: null }),
  ];
  const receipts: DividendReceiptFact[] = [
    {
      id: "r1",
      dividendEventId: "e4",
      sharesDecimal: "10",
      dividendPerShareDecimal: "50",
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2024-04-15",
    },
  ];
  const derivedRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords: [],
    transactions: PARITY_HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });

  const totalsResult = computeFyDividendTotals(derivedRows, [], 7);
  assert.ok(totalsResult.ok);
  const fy24Total = totalsResult.ok
    ? totalsResult.totals.find((total) => total.endingYear === 2024)
    : undefined;
  assert.ok(fy24Total, "FY24 total present");
  // Sanity: this is the SAME B2 fixture as div-001.test.ts -- all 4 rows
  // (3 ex-date-only + 1 payment-dated) attribute to FY24.
  assert.equal(fy24Total!.rowCount, 4);

  const listRows = derivedRows.map(toListRow);
  const fy24Window = fyWindowForEndingYear(2024, 7);
  assert.ok(fy24Window.ok);
  const filterResult = filterRowsForFyWindow(listRows, fy24Window.window);

  assert.equal(
    filterResult.rows.length,
    fy24Total!.rowCount,
    "the drill-through's row count must match the total's own rowCount",
  );
  assert.equal(filterResult.undatedRowCount, 0);
  // Every row is present via its ex-date-only or payment-date attribution --
  // none of the 3 provider-estimate rows is invisible in its own year.
  assert.deepEqual(
    new Set(filterResult.rows.map((r) => r.id)),
    new Set(derivedRows.map((r) => `ps1:${r.id}`)),
  );
});

test("UI-017: filterRowsForNext12 includes every declared/pending not-paid row regardless of its own date -- UNCAPPED, they are known future claims not a forecast", () => {
  const rows = [
    row({ id: "pending-far-future", notPaid: true, exDate: "2030-01-01" }),
    row({ id: "pending-no-date", notPaid: true, paymentDate: null }),
  ];
  const result = filterRowsForNext12(rows, "2026-08-20");
  assert.deepEqual(
    result.map((r) => r.id),
    ["pending-far-future", "pending-no-date"],
  );
});

test("UI-017: filterRowsForNext12 includes paid rows on/after the window start, excludes paid rows before it -- never a fabricated forecast row", () => {
  const rows = [
    row({ id: "paid-on-start", paymentDate: "2026-08-20" }),
    row({ id: "paid-after-start", paymentDate: "2026-09-01" }),
    row({ id: "paid-before-start", paymentDate: "2026-08-19" }),
  ];
  const result = filterRowsForNext12(rows, "2026-08-20");
  assert.deepEqual(
    result.map((r) => r.id),
    ["paid-on-start", "paid-after-start"],
  );
});

test("UI-017: filterRowsForNext12 excludes an already-paid row with no payment date (cannot be known as paid in-window)", () => {
  const rows = [row({ id: "paid-no-date", notPaid: false, paymentDate: null })];
  const result = filterRowsForNext12(rows, "2026-08-20");
  assert.deepEqual(result, []);
});

// --- Follow-up (round-1 review): the next12 PAID leg is capped at
// today+365 days; the declared/pending leg (tested above) stays uncapped.

test("UI-017: filterRowsForNext12 caps the PAID leg at exactly 365 days from the window start (inclusive)", () => {
  const rows = [
    row({ id: "paid-at-365", paymentDate: "2027-08-20" }), // 2026-08-20 + 365
    row({ id: "paid-beyond-365", paymentDate: "2027-08-21" }), // +366
  ];
  const result = filterRowsForNext12(rows, "2026-08-20");
  assert.deepEqual(
    result.map((r) => r.id),
    ["paid-at-365"],
  );
});

test("UI-017: filterRowsForNext12's 365-day paid cap does not affect a declared/pending row due even further out", () => {
  const rows = [
    row({
      id: "pending-way-out",
      notPaid: true,
      paymentDate: null,
      exDate: "2029-01-01",
    }),
    row({ id: "paid-way-out", notPaid: false, paymentDate: "2029-01-01" }),
  ];
  const result = filterRowsForNext12(rows, "2026-08-20");
  assert.deepEqual(
    result.map((r) => r.id),
    ["pending-way-out"],
  );
});

// ---------------------------------------------------------------------------
// Part 4: OwnedDividendList component rendering -- heading/counts/back-link,
// invalid-fy fallback, next12 disclosure, null-payment-date disclosure.
// ---------------------------------------------------------------------------

const baseListRow = {
  id: "row-1",
  portfolioSecurityId: "psa1",
  symbol: "ALPHA",
  currencyCode: "AUD",
  paymentDate: "2025-02-10",
  exDate: "2025-02-01",
  notPaid: false,
  cashDecimal: "10.00",
  frankingTotalDecimal: null,
  frankingDerivedZero: false,
  grossDecimal: "10.00",
  source: "auto",
  excluded: false,
  originalCurrencyCode: null,
  fxRateToPortfolioDecimal: null,
  fxRateSource: null,
};

function renderList(
  filter: DividendListFilter,
  overrides: Record<string, unknown> = {},
) {
  return renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      allYearsHref: "/portfolio/pa/income/dividends",
      today: "2026-08-13",
      rows: [baseListRow],
      truncated: false,
      totalCount: 50,
      filter,
      undatedRowCount: 0,
      ...overrides,
    },
  );
}

test("UI-017: an fy-filtered list renders the FY25 heading, the FY window, the filtered/unfiltered counts, and an 'All years' back link", () => {
  const html = renderList({
    mode: "fy",
    endingYear: 2025,
    label: "FY25",
    window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  });
  assert.match(html, /<h1>FY25 dividends<\/h1>/);
  assert.match(
    html,
    /Dividends attributed to 2024-07-01 – 2025-06-30 by payment date, or by ex-date where no payment date is recorded\./,
  );
  assert.match(html, /Showing 1 of 50 dividends across the portfolio\./);
  assert.match(
    html,
    /<a href="\/portfolio\/pa\/income\/dividends">All years<\/a>/,
  );
});

// --- Round-2 review: the fy subtitle must state the ACTUAL attribution
// rule (paymentDate ?? exDate), not a payment-date-only claim that is false
// for an ex-date-attributed row -- pinned against the same rule
// `filterRowsForFyWindow` implements.

test("UI-017 (round-2 fix): the fy subtitle names BOTH attribution paths (payment date primary, ex-date fallback) -- never a payment-date-only claim", () => {
  const html = renderList({
    mode: "fy",
    endingYear: 2025,
    label: "FY25",
    window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  });
  assert.match(
    html,
    /by payment date, or by ex-date where no payment date is recorded/,
  );
  // The old, now-false wording (silent on ex-date attribution) must be gone.
  assert.doesNotMatch(html, /Dividends with a payment date between/);
});

test("UI-017 (B1 fix): the fy-filtered list discloses a portfolio-wide count of UNDATED rows (neither payment date nor ex-date), naming that it is not specific to the requested year", () => {
  const html = renderList(
    {
      mode: "fy",
      endingYear: 2025,
      label: "FY25",
      window: { startDate: "2024-07-01", endDate: "2025-06-30" },
    },
    { undatedRowCount: 3 },
  );
  assert.match(
    html,
    /3 undated dividends across the portfolio not shown in any financial-year view/,
  );
  assert.match(
    html,
    /A dividend with neither a payment date nor an ex-date cannot be attributed to any financial year -- this count is portfolio-wide, not specific to FY25\./,
  );
});

test("UI-017: the fy-filtered list renders no undated-row disclosure when the count is zero", () => {
  const html = renderList({
    mode: "fy",
    endingYear: 2025,
    label: "FY25",
    window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  });
  assert.doesNotMatch(html, /undated dividend/);
});

test("UI-017: an invalid fy request falls back to the honest all-years view with a visible note, never a crash", () => {
  const html = renderList({ mode: "all", invalidFyRequested: true });
  assert.match(html, /<h1>All dividends<\/h1>/);
  assert.match(html, /Requested financial year unavailable/);
  assert.match(
    html,
    /The requested financial year could not be shown, so every year is shown instead\./,
  );
});

test("UI-017: the plain all-years view (no filter, or the pre-UI-017 default) renders no fallback banner and no 'All years' link", () => {
  const html = renderList({ mode: "all", invalidFyRequested: false });
  assert.doesNotMatch(html, /Requested financial year unavailable/);
  assert.doesNotMatch(html, />All years</);
});

test("UI-017: the default filter prop (omitted entirely) keeps pre-UI-017 callers rendering the plain all-dividends view", () => {
  const html = renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      today: "2026-08-13",
      rows: [baseListRow],
      truncated: false,
      totalCount: 1,
    },
  );
  assert.match(html, /<h1>All dividends<\/h1>/);
});

test("UI-017: the next12-filtered list renders its heading and states plainly it shows known payments/declarations only, never a forecast", () => {
  const html = renderList({ mode: "next12" });
  assert.match(html, /<h1>Known dividends in the next 12 months<\/h1>/);
  assert.match(
    html,
    /This shows only dividends that are already known as of 2026-08-13 --\s*declared but not yet paid \(shown whatever their date\), or paid\s*between 2026-08-13 and 2027-08-13\. It\s*is not a forecast of future income\./,
  );
});

// --- Round-2 review: the next12 subtitle must state the ACTUAL paid-leg
// cap (today .. today+365) rather than an unbounded "on or after today"
// claim that overclaims what the now-capped filter actually returns --
// pinned against the same NEXT12_PAID_WINDOW_DAYS the filter uses.

test("UI-017 (round-2 fix): the next12 subtitle names the capped paid-date range and says declared/pending rows show whatever their date", () => {
  const html = renderList({ mode: "next12" });
  assert.match(html, /paid\s*between 2026-08-13 and 2027-08-13/);
  assert.match(html, /declared but not yet paid \(shown whatever their date\)/);
  // The old, now-inaccurate wording (unbounded "on or after") must be gone.
  assert.doesNotMatch(html, /paid on or after/);
});

test("UI-017 (B3b fix): a truncated fy/next12-filtered list states the REAL mechanics (the cap applies portfolio-wide, before filtering) instead of the misleading 'most recent {filteredCount} of {total}' figure", () => {
  const html = renderList(
    { mode: "next12" },
    { truncated: true, totalCount: 9999 },
  );
  // The old, misleading wording (filtered-row-count vs whole-portfolio
  // total, numbers unrelated to each other) must be gone.
  assert.doesNotMatch(html, /Showing the most recent 1 of 9,999 dividends/);
  assert.match(html, /This portfolio has more than 2,000 dividends/);
  assert.match(
    html,
    /Only the most recent 2,000 are loaded, portfolio-wide -- an older financial year shown here may be missing some of its rows\./,
  );
});

test("UI-017: a truncated ALL-years (unfiltered) list keeps the original 'most recent N of total' wording -- only filtered views get the mechanics caveat", () => {
  const html = renderList(
    { mode: "all", invalidFyRequested: false },
    { truncated: true, totalCount: 9999 },
  );
  assert.match(html, /Showing the most recent 1 of 9,999 dividends/);
  assert.doesNotMatch(html, /This portfolio has more than/);
});

// --- B3a fix: filter-aware empty states -- never the portfolio-wide "yet"
// copy when a filter narrowed the view to genuinely zero rows.

test("UI-017 (B3a fix): an fy-filtered view with zero matching rows states the year, not the portfolio-wide 'yet' copy", () => {
  const html = renderList(
    {
      mode: "fy",
      endingYear: 2027,
      label: "FY27",
      window: { startDate: "2026-07-01", endDate: "2027-06-30" },
    },
    { rows: [] },
  );
  assert.match(html, /No dividends recorded in FY27\./);
  assert.doesNotMatch(html, /No dividends found across this portfolio yet\./);
});

test("UI-017 (B3a fix): a next12-filtered view with zero matching rows states the window, not the portfolio-wide 'yet' copy", () => {
  const html = renderList({ mode: "next12" }, { rows: [] });
  assert.match(html, /No known dividends in this window\./);
  assert.doesNotMatch(html, /No dividends found across this portfolio yet\./);
});

test("UI-017: the unfiltered all-years empty state keeps its original portfolio-wide copy", () => {
  const html = renderList(
    { mode: "all", invalidFyRequested: false },
    { rows: [] },
  );
  assert.match(html, /No dividends found across this portfolio yet\./);
});

// ---------------------------------------------------------------------------
// Part 5: link wiring on the three surfaces -- income-landing.tsx (recent-FY
// rows + Next 12 Months section), income-multi-year.tsx (year rows,
// including the current-FY row), and the route page itself.
// ---------------------------------------------------------------------------

const landingProjectionBase = {
  status: "ok",
  baseCurrencyCode: "AUD",
  today: "2026-08-13",
  currentPortfolioValueDecimal: "10000.00",
  portfolioValueStatus: "available",
  portfolioValueCoverage: null,
  assumptionGrid: [],
  aggregateYield: {
    status: "ok",
    effectiveYieldPercentDecimal: "4.5",
    effectiveFrankingMixPercentDecimal: "1.5",
    includedValueDecimal: "10000.00",
    includedCount: 2,
    excluded: [],
    method: "value-weighted average of every held security's resolved yield",
  },
  portfolioValueGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  portfolioDividendGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  multiYear: { ok: false, reason: "portfolio_value_unavailable" },
  multiYearBaselineInput: null,
  currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  pastFinancialYears: {
    ok: true,
    rows: [
      {
        endingYear: 2025,
        label: "FY25",
        window: { startDate: "2024-07-01", endDate: "2025-06-30" },
        dividendSource: "actual",
        dividendGrossDecimal: "550.00",
        dividendCashDecimal: "440.00",
        dividendFrankingKnownDecimal: "110.00",
        dividendFrankingIncomplete: false,
        includedSecurityCount: 2,
        excludedSecurities: [],
        method:
          "sum of each security's own precedence-resolved FY total (actual)",
      },
    ],
  },
  breakdown: {
    status: "ok",
    currencyCode: "AUD",
    totalGrossDecimal: "600.00",
    totalCashDecimal: "480.00",
    totalFrankingKnownDecimal: "120.00",
    totalFrankingIncomplete: false,
    averagePerMonthDecimal: "50.00",
    averagePerWeekDecimal: "11.54",
    incomePercentOfValueDecimal: "6.00",
    incomePercentOfValueStatus: "available",
    includedSecurityCount: 2,
    excludedSecurities: [],
    method:
      "sum of every held security's 12-month baseline forecast (gross, includes franking credits)",
  },
};

const landingProps = {
  projection: landingProjectionBase,
  portfolioId: "portfolio-a",
  multiYearHref: "/portfolio/portfolio-a/income/multi-year",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
};

function renderLanding(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    { ...landingProps, ...overrides },
  );
}

test("UI-017: the Income landing's 'Recent financial years' row is a real, keyboard-accessible link to ?fy=<endingYear>", () => {
  const html = renderLanding();
  assert.match(
    html,
    /<a class="income-fy-row-link" href="\/portfolio\/portfolio-a\/income\/dividends\?fy=2025">FY25<\/a>/,
  );
});

test("UI-017: a partial-coverage recent-FY row still wraps the FULL label (including the '· partial' marker) in one link", () => {
  const html = renderLanding({
    projection: {
      ...landingProjectionBase,
      pastFinancialYears: {
        ok: true,
        rows: [
          {
            ...landingProjectionBase.pastFinancialYears.rows[0],
            excludedSecurities: [
              {
                portfolioSecurityId: "sec-1",
                symbol: "ABC",
                reason: "foreign_currency",
              },
            ],
          },
        ],
      },
    },
  });
  assert.match(
    html,
    /<a class="income-fy-row-link" href="\/portfolio\/portfolio-a\/income\/dividends\?fy=2025">FY25<span class="unavailable"> · partial<\/span><\/a>/,
  );
});

test("UI-017: the Next 12 Months section links to ?window=next12 with plain-language copy naming what it shows", () => {
  const html = renderLanding();
  assert.match(
    html,
    /<a class="income-next12-link" href="\/portfolio\/portfolio-a\/income\/dividends\?window=next12">View known dividends in this window<\/a>/,
  );
});

const pastFinancialYearRows = [
  {
    endingYear: 2025,
    label: "FY25",
    window: { startDate: "2024-07-01", endDate: "2025-06-30" },
    dividendSource: "actual",
    dividendGrossDecimal: "550.00",
    dividendCashDecimal: "440.00",
    dividendFrankingKnownDecimal: "110.00",
    dividendFrankingIncomplete: false,
    includedSecurityCount: 2,
    excludedSecurities: [],
    portfolioValueDecimal: "9500.00",
    valueStatus: "available",
    effectiveYieldPercentDecimal: "5.79",
    method: "sum of each security's own precedence-resolved FY total (actual)",
  },
];

const currentFinancialYearRow = {
  endingYear: 2026,
  label: "FY26",
  window: { startDate: "2025-07-01", endDate: "2026-06-30" },
  dividendSource: "fy_to_date",
  dividendGrossDecimal: "300.00",
  dividendCashDecimal: "240.00",
  dividendFrankingKnownDecimal: "60.00",
  dividendFrankingIncomplete: false,
  includedSecurityCount: 2,
  excludedSecurities: [],
  portfolioValueDecimal: "10000.00",
  valueStatus: "available",
  effectiveYieldPercentDecimal: "3.00",
  method: "financial-year-to-date total (not a full-year figure)",
};

const multiYearAssumptions = {
  currentPortfolioValueDecimal: "10000.00",
  currentPortfolioValueStatus: "available",
  // DIV-011: the reused per-security forecast sum (the SAME base
  // computeIncomeBreakdown's Next-12-months headline uses).
  baseForecastGrossDecimal: "600.00",
  baseForecastCashDecimal: "480.00",
  baseYieldIncludesPartialTtm: false,
  baseForecastFrankingIncomplete: false,
  baseExcludedSecurityCount: 0,
  valueGrowthPercentDecimal: "5",
  valueGrowthSource: "portfolio_assumption",
  dividendGrowthPercentDecimal: "0",
  dividendGrowthSource: "none",
};

// DIV-011: year 1's `endingYear` (2026) IS the current FY -- it merges with
// `currentFinancialYearRow` (same endingYear, 2026) onto ONE row, so it DOES
// link out (real underlying dividend rows: actuals received so far).
// Year 2 (FY27) is genuinely FUTURE -- the B2 ruling below still applies to
// it: a projection is a forecast, never a dividend row, so it never links.
const baselineMultiYear = {
  ok: true,
  rows: [
    {
      yearIndex: 1,
      endingYear: 2026,
      label: "FY26",
      valueDecimal: "10000.00", // UNGROWN -- year 1 is the current value (DIV-011)
      yieldPercentDecimal: "6",
      grossDividendDecimal: "600.00",
      cashDividendDecimal: "480.00",
      frankingCreditDecimal: "120.00",
      method: "compounded",
    },
    {
      yearIndex: 2,
      endingYear: 2027,
      label: "FY27",
      valueDecimal: "10500.00",
      yieldPercentDecimal: "5.71",
      grossDividendDecimal: "600.00",
      cashDividendDecimal: "480.00",
      frankingCreditDecimal: "120.00",
      method: "compounded",
    },
    {
      // A further-out projected row whose ending year is unknown -- never a
      // link.
      yearIndex: 3,
      endingYear: null,
      label: "Year 3",
      valueDecimal: "11000.00",
      yieldPercentDecimal: "6.00",
      grossDividendDecimal: "660.00",
      cashDividendDecimal: "528.00",
      frankingCreditDecimal: "132.00",
      method: "compounded",
    },
  ],
  assumptions: multiYearAssumptions,
};

const populatedMultiYearProps = {
  // UI-022: the Income sub-tab hrefs are derived from `portfolioId` inside
  // the shared `IncomeNav`, so the screen no longer takes per-tab hrefs.
  portfolioId: "portfolio-a",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
  baseCurrencyCode: "AUD",
  pastFinancialYears: { ok: true, rows: pastFinancialYearRows },
  currentFinancialYear: { ok: true, row: currentFinancialYearRow },
  multiYear: baselineMultiYear,
  multiYearBaselineInput: {
    assumptions: multiYearAssumptions,
    yearsForward: 3,
    // DIV-011: `startEndingYear + 1` is year 1's own ending year, now the
    // CURRENT FY (2026) -- see `MultiYearProjectionInput.startEndingYear`.
    startEndingYear: 2025,
  },
  portfolioValueGrowthPercentDecimal: "5",
  portfolioDividendGrowthPercentDecimal: "0",
  yearsBack: 2,
  yearsForward: 3,
};

function renderMultiYear(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "IncomeMultiYear",
    "../app/components/income-multi-year.tsx",
    { ...populatedMultiYearProps, ...overrides },
  );
}

test("UI-017: the multi-year sub-page's past-FY row keeps its existing detail button AND adds a real 'View dividends' link to ?fy=<endingYear>", () => {
  const html = renderMultiYear();
  // The pre-existing row-detail trigger is untouched (UI-006A literal markup).
  assert.match(
    html,
    /<button type="button" class="income-row-trigger">FY25<\/button>/,
  );
  assert.match(
    html,
    /<a class="income-fy-year-link" href="\/portfolio\/portfolio-a\/income\/dividends\?fy=2025">View dividends<\/a>/,
  );
});

test("UI-017/DIV-011: the multi-year sub-page's current-FY row (now MERGED onto its own forward-forecast row -- the old separate '(to date)' row is gone) also links to ?fy=<endingYear>", () => {
  const html = renderMultiYear();
  assert.doesNotMatch(html, /FY26 \(to date\)/);
  assert.match(
    html,
    /<button type="button" class="income-row-trigger">FY26 \(projected\)<\/button>\s*<a class="income-fy-year-link" href="\/portfolio\/portfolio-a\/income\/dividends\?fy=2026">View dividends<\/a>/,
  );
});

test("UI-017 (B2 RULING): a genuinely FUTURE projected row is NEVER linked, even when it has a perfectly resolvable ending year -- a projection is a forecast, not a dividend row (DIV-011: this is now year 2 -- year 1, the current FY, is the one deliberate exception, see the test above)", () => {
  const html = renderMultiYear();
  // FY27 (yearIndex 2, endingYear 2027) is a genuinely FUTURE row in this
  // fixture (see baselineMultiYear) -- the parser would otherwise accept
  // ?fy=2027, so this specifically exercises the "the link would have
  // worked" case, not just an out-of-range one.
  const fy27RowMatch = html.match(
    /<button type="button" class="income-row-trigger">FY27 \(projected\)<\/button>([\s\S]{0,80})<\/th>/,
  );
  assert.ok(fy27RowMatch, "expected to find the FY27 projected row");
  assert.doesNotMatch(fy27RowMatch![1], /income-fy-year-link/);
  assert.doesNotMatch(html, /\?fy=2027/);
});

// DIV-012 flips this pin's fixture wiring honestly: the component no longer
// reads the `multiYear` prop for forward rows whenever `multiYearBaselineInput`
// is present (it always live-recomputes from the baseline + the what-if
// inputs instead -- see income-multi-year.tsx). This test needs an
// ARBITRARY hand-crafted 4th row the real domain projector wouldn't
// organically produce from a `yearsForward: 3` baseline, so it forces the
// fallback path (`multiYearBaselineInput: null`) that still renders the raw
// `multiYear` prop directly -- exercising the identical `mapProjectedRow`/
// `dividendsHref` logic under test either way.
test("UI-017 (B2 RULING): a further-out projected row (current+3, which the parser WOULD reject) also renders no link and no href", () => {
  const html = renderMultiYear({
    multiYearBaselineInput: null,
    multiYear: {
      ok: true,
      rows: [
        ...baselineMultiYear.rows,
        {
          yearIndex: 4,
          endingYear: 2029,
          label: "FY29",
          valueDecimal: "11000.00",
          yieldPercentDecimal: "6.00",
          grossDividendDecimal: "660.00",
          cashDividendDecimal: "528.00",
          frankingCreditDecimal: "132.00",
          method: "compounded",
        },
      ],
      assumptions: multiYearAssumptions,
    },
  });
  const fy29RowMatch = html.match(
    /<button type="button" class="income-row-trigger">FY29 \(projected\)<\/button>([\s\S]{0,80})<\/th>/,
  );
  assert.ok(fy29RowMatch, "expected to find the FY29 projected row");
  assert.doesNotMatch(fy29RowMatch![1], /income-fy-year-link/);
  assert.doesNotMatch(html, /\?fy=2029/);
});

// DIV-012 flips this pin's fixture wiring honestly (same rationale as the
// FY29 test above): `baselineMultiYear`'s hand-crafted "Year 3" row (a null
// `endingYear`) is the DEFAULT `multiYear` prop, but the real domain
// projector always resolves a concrete `endingYear` when `startEndingYear`
// is set (as this fixture's `multiYearBaselineInput` is), so the live
// recompute path would never organically produce a null-ending-year row to
// exercise. Force the fallback path so the raw hand-crafted `multiYear` prop
// is what renders.
test("UI-017: a projected row with NO resolvable ending year renders no dividends link either (never a broken/guessed href)", () => {
  const html = renderMultiYear({ multiYearBaselineInput: null });
  const yearThreeRowMatch = html.match(
    /<button type="button" class="income-row-trigger">Year 3 \(projected\)<\/button>([\s\S]{0,60})<\/th>/,
  );
  assert.ok(yearThreeRowMatch, "expected to find the 'Year 3' row");
  assert.doesNotMatch(yearThreeRowMatch![1], /income-fy-year-link/);
});

test("UI-017: the multi-year page threads a real dividendsHref prop through to the component", async () => {
  const source = await readFile(
    new URL(
      "../app/portfolio/[portfolioId]/income/multi-year/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /dividendsHref=\{`\/portfolio\/\$\{portfolioId\}\/income\/dividends`\}/,
  );
});

test("UI-017: the dividends page source parses fy/window search params and applies the pure filters before rendering", async () => {
  const source = await readFile(
    new URL(
      "../app/portfolio/[portfolioId]/income/dividends/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /searchParams: Promise<\{ fy\?: string; window\?: string \}>/,
  );
  assert.match(source, /parseDividendListFilter\(/);
  assert.match(source, /filterRowsForFyWindow\(/);
  assert.match(source, /filterRowsForNext12\(/);
});

// ---------------------------------------------------------------------------
// Part 6: accessibility -- the new links declare the 44px CSS-pixel
// touch-target minimum (QA-001B pattern).
// ---------------------------------------------------------------------------

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

test("UI-017: the year-row and next-12-months drill-through links meet the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".income-fy-row-link",
    ".income-fy-year-link",
    ".income-next12-link",
  ]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
});

// ---------------------------------------------------------------------------
// Part 7: QA-001A matrix + self-check.
// ---------------------------------------------------------------------------

test("UI-017: the QA-001A matrix mentions the server-parsed fy/window params", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "?fy=<endingYear>",
    "?window=next12",
    "parseDividendListFilter",
    "tests/ui-017.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("UI-017: every matrix citation naming tests/ui-017.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/ui-017.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/ui-017\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
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
        `matrix cites "${title}" in tests/ui-017.test.ts, but that title is not a literal substring of the file's source (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 1, "expected at least 1 quoted title to check");
});
