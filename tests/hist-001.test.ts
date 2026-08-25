/**
 * HIST-001 -- Historical portfolio value: compute, graph, and fix the
 * Multi-Year baseline (owner-directed, 2026-08-25 after the 18-file price
 * history import: "I don't think we are calculating historical portfolio
 * values... Let get this working").
 *
 * See `docs/ARCHITECTURE.md` §9.1 for the full investigation/root-cause
 * writeup and the read-time-derivation-vs-persisted-pipeline decision this
 * task made, and `docs/CALCULATIONS.md`'s HIST-001 subsection (under
 * "Historical values and snapshots") for the valuation rule pinned below.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { deriveCashBalanceAtDate } from "../domain/dividends/shares-held.ts";
import {
  computeHistoricalPortfolioValueAtDate,
  computeHistoricalPortfolioValueSeries,
  type HistoricalValueCashFact,
  type HistoricalValueSecurityFact,
} from "../domain/snapshots/historical-portfolio-value.ts";
import {
  loadHistoricalPortfolioValueAtDates,
  loadHistoricalPortfolioValueSeries,
} from "../app/historical-portfolio-value.ts";
import { loadOwnedIncomeProjection } from "../app/owned-income-projection.ts";
import { projectMultiYearIncome } from "../domain/dividends/projection.ts";

// ---------------------------------------------------------------------------
// Part 1: `deriveCashBalanceAtDate` (domain/dividends/shares-held.ts)
// ---------------------------------------------------------------------------

test("HIST-001: deriveCashBalanceAtDate sums posted entries up to and including the date, excludes reversed/reversing pairs, ignores future entries", () => {
  const entries = [
    {
      id: "e1",
      localDate: "2024-01-01",
      signedAmountDecimal: "100",
      status: "posted" as const,
      reversesEntryId: null,
    },
    {
      id: "e2",
      localDate: "2024-02-01",
      signedAmountDecimal: "-30",
      status: "posted" as const,
      reversesEntryId: null,
    },
    // A reversed original + its reversal record: net zero effect, on ANY date.
    {
      id: "e3",
      localDate: "2024-03-01",
      signedAmountDecimal: "500",
      status: "reversed" as const,
      reversesEntryId: null,
    },
    {
      id: "e4",
      localDate: "2024-03-01",
      signedAmountDecimal: "-500",
      status: "posted" as const,
      reversesEntryId: "e3",
    },
    // Future entry: never counted for a past `asOfDate`.
    {
      id: "e5",
      localDate: "2024-06-01",
      signedAmountDecimal: "1000",
      status: "posted" as const,
      reversesEntryId: null,
    },
  ];
  assert.equal(deriveCashBalanceAtDate(entries, "2024-01-15"), "100");
  assert.equal(deriveCashBalanceAtDate(entries, "2024-02-01"), "70");
  // e3/e4 (reversed pair) net to nothing on any date; e5 (1000, dated
  // 2024-06-01) IS on-or-before 2024-12-31, so it counts: 70 + 1000.
  assert.equal(deriveCashBalanceAtDate(entries, "2024-12-31"), "1070");
  // Just before e5's date: e5 not yet counted.
  assert.equal(deriveCashBalanceAtDate(entries, "2024-05-31"), "70");
});

test('HIST-001: deriveCashBalanceAtDate returns "0" for no entries, never a null/undefined sentinel', () => {
  assert.equal(deriveCashBalanceAtDate([], "2024-01-01"), "0");
});

// ---------------------------------------------------------------------------
// Part 2: pure `computeHistoricalPortfolioValueAtDate`/`...Series`
// (domain/snapshots/historical-portfolio-value.ts) -- no DB.
// ---------------------------------------------------------------------------

function security(
  overrides: Partial<HistoricalValueSecurityFact>,
): HistoricalValueSecurityFact {
  return {
    portfolioSecurityId: "ps-1",
    currencyCode: "AUD",
    transactions: [],
    priceObservations: [],
    ...overrides,
  };
}

function priceObservation(marketDate: string, closeDecimal: string) {
  return {
    kind: "price" as const,
    providerId: "owner-import",
    providerRevisionId: null,
    mappingId: "m",
    securityId: "sec-1",
    scope: { kind: "deployment" as const, userId: null },
    interval: "eod" as const,
    observationAt: `${marketDate}T04:00:00.000Z`,
    marketDate,
    marketTimezone: "Australia/Sydney",
    currencyCode: "AUD",
    closeDecimal,
    previousCloseDecimal: null,
    adjustmentState: "raw" as const,
    adjustmentFactor: null,
    quality: "observed" as const,
    delayedMinutes: null,
    ingestedAt: `${marketDate}T14:00:01.000Z`,
    payloadSha256: null,
  };
}

test("HIST-001: computeHistoricalPortfolioValueAtDate -- exact-date pricing, no interpolation across a sparse (monthly) gap", () => {
  const buyTx = {
    id: "tx1",
    type: "buy",
    status: "posted" as const,
    localTradeDate: "2016-01-01",
    tradeAt: "2016-01-01T00:00:00Z",
    quantityDecimal: "100",
    unitPriceDecimal: null,
    reversesTransactionId: null,
  };
  const facts: HistoricalValueSecurityFact[] = [
    security({
      transactions: [buyTx],
      priceObservations: [
        priceObservation("2016-01-31", "1.00"),
        // Next observation is TWO MONTHS later (sparse pre-2018 monthly
        // history) -- 2016-02-15 has NO observation at all.
        priceObservation("2016-03-31", "1.20"),
      ],
    }),
  ];
  const onObservationDate = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: [],
    fxObservations: [],
    date: "2016-01-31",
  });
  assert.equal(onObservationDate.valueDecimal, "100");
  assert.equal(onObservationDate.completeness, "complete");

  // A date strictly between the two monthly observations: NEVER
  // interpolated -- the security held that day has no EXACT-date price, so
  // the point is a genuine gap (null), not a guessed mid-point value.
  const betweenObservations = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: [],
    fxObservations: [],
    date: "2016-02-15",
  });
  assert.equal(betweenObservations.valueDecimal, null);
  assert.equal(betweenObservations.completeness, "partial");
  assert.equal(betweenObservations.heldSecurityCount, 1);
  assert.equal(betweenObservations.pricedSecurityCount, 0);
});

test("HIST-001: computeHistoricalPortfolioValueAtDate -- a sold-out security contributes nothing (and no gap) once fully exited", () => {
  const facts: HistoricalValueSecurityFact[] = [
    security({
      transactions: [
        {
          id: "buy1",
          type: "buy",
          status: "posted",
          localTradeDate: "2020-01-01",
          tradeAt: "2020-01-01T00:00:00Z",
          quantityDecimal: "100",
          unitPriceDecimal: null,
          reversesTransactionId: null,
        },
        {
          id: "sell1",
          type: "sell",
          status: "posted",
          localTradeDate: "2020-06-01",
          tradeAt: "2020-06-01T00:00:00Z",
          quantityDecimal: "100",
          unitPriceDecimal: null,
          reversesTransactionId: null,
        },
      ],
      // Deliberately NO price observation on 2020-07-01 -- if the sold-out
      // exclusion were broken, this would show as a false gap instead of a
      // clean "nothing held, nothing to price" complete zero.
      priceObservations: [],
    }),
  ];
  const point = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: [],
    fxObservations: [],
    date: "2020-07-01",
  });
  assert.equal(point.heldSecurityCount, 0);
  assert.equal(point.pricedSecurityCount, 0);
  // Nothing held, nothing missing -- a real fact ("held nothing that day"),
  // not a gap. `valueDecimal` is null only because there is genuinely
  // nothing to sum (no cash either in this fixture); `completeness` stays
  // "complete" since nothing was EXCLUDED.
  assert.equal(point.valueDecimal, null);
  assert.equal(point.completeness, "complete");
});

test("HIST-001: computeHistoricalPortfolioValueAtDate -- FX-converted foreign holding + base-currency cash sum honestly; missing FX degrades to partial, never a silent zero or a wrong-currency number", () => {
  const usdSecurity = security({
    portfolioSecurityId: "ps-usd",
    currencyCode: "USD",
    transactions: [
      {
        id: "buy-usd",
        type: "buy",
        status: "posted",
        localTradeDate: "2022-01-01",
        tradeAt: "2022-01-01T00:00:00Z",
        quantityDecimal: "10",
        unitPriceDecimal: null,
        reversesTransactionId: null,
      },
    ],
    priceObservations: [
      { ...priceObservation("2022-06-01", "50.00"), currencyCode: "USD" },
    ],
  });
  const cash: HistoricalValueCashFact[] = [
    {
      cashAccountId: "ca",
      currencyCode: "AUD",
      entries: [
        {
          id: "e1",
          localDate: "2022-01-01",
          signedAmountDecimal: "200",
          status: "posted",
          reversesEntryId: null,
        },
      ],
    },
  ];
  const fx = [
    {
      kind: "fx" as const,
      providerId: "owner-import",
      providerRevisionId: null,
      scope: { kind: "deployment" as const, userId: null },
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: "USD",
      rateDecimal: "1.5", // 1 AUD = 1.5 USD, i.e. 1 USD = 0.6667 AUD-ish per resolveFxRate's own convention
      interval: "eod" as const,
      observedAt: "2022-06-01T04:00:00.000Z",
      marketDate: "2022-06-01",
      quality: "observed" as const,
      delayedMinutes: null,
      ingestedAt: "2022-06-01T14:00:01.000Z",
      payloadSha256: null,
    },
  ];

  const withFx = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: [usdSecurity],
    cashAccounts: cash,
    fxObservations: fx,
    date: "2022-06-01",
  });
  assert.equal(withFx.completeness, "complete");
  assert.notEqual(withFx.valueDecimal, null);
  // 200 AUD cash is definitely part of the total (never dropped just
  // because a DIFFERENT component needed FX).
  assert.ok(
    Number(withFx.valueDecimal) > 200,
    `expected the AUD cash to be included in the total, got ${withFx.valueDecimal}`,
  );

  // Same date, but with NO fx_rate_observations at all: the USD security
  // cannot convert -- the point must degrade to partial (cash-only total),
  // never silently drop to zero or fabricate a conversion.
  const withoutFx = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: [usdSecurity],
    cashAccounts: cash,
    fxObservations: [],
    date: "2022-06-01",
  });
  assert.equal(withoutFx.completeness, "partial");
  assert.equal(withoutFx.valueDecimal, "200");
  assert.equal(withoutFx.pricedSecurityCount, 0);
});

test("HIST-001: computeHistoricalPortfolioValueSeries maps computeHistoricalPortfolioValueAtDate over every requested date, ascending, one point per date", () => {
  const facts: HistoricalValueSecurityFact[] = [
    security({
      transactions: [
        {
          id: "buy1",
          type: "buy",
          status: "posted",
          localTradeDate: "2020-01-01",
          tradeAt: "2020-01-01T00:00:00Z",
          quantityDecimal: "10",
          unitPriceDecimal: null,
          reversesTransactionId: null,
        },
      ],
      priceObservations: [
        priceObservation("2020-01-01", "1.00"),
        priceObservation("2020-02-01", "2.00"),
      ],
    }),
  ];
  const series = computeHistoricalPortfolioValueSeries({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    dates: ["2020-01-01", "2020-01-15", "2020-02-01"],
    securities: facts,
    cashAccounts: [],
    fxObservations: [],
  });
  assert.deepEqual(
    series.map((point) => [point.date, point.valueDecimal]),
    [
      ["2020-01-01", "10"],
      ["2020-01-15", null],
      ["2020-02-01", "20"],
    ],
  );
});

test("HIST-001 review B2a: a Sharesight-provider price observation is used exactly like any other provider -- the sibling persisted-pipeline's EOD-only exclusion does NOT apply here", () => {
  const facts: HistoricalValueSecurityFact[] = [
    security({
      transactions: [
        {
          id: "buy1",
          type: "buy",
          status: "posted",
          localTradeDate: "2026-01-01",
          tradeAt: "2026-01-01T00:00:00Z",
          quantityDecimal: "100",
          unitPriceDecimal: null,
          reversesTransactionId: null,
        },
      ],
      // ONLY a sharesight-provider row exists for this date -- an
      // owner-import-only scope (the old, wrong exclusion) would see
      // nothing and report a gap.
      priceObservations: [
        {
          ...priceObservation("2026-06-01", "12.00"),
          providerId: "sharesight",
        },
      ],
    }),
  ];
  const point = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: [],
    fxObservations: [],
    date: "2026-06-01",
  });
  assert.equal(point.valueDecimal, "1200");
  assert.equal(point.completeness, "complete");
});

test("HIST-001 review B3 ruling: FY-end valuation with priceToleranceDays=7 uses the last observation ON OR BEFORE the date within the bounded lookback; beyond 7 days stays an honest gap", () => {
  const facts: HistoricalValueSecurityFact[] = [
    security({
      transactions: [
        {
          id: "buy1",
          type: "buy",
          status: "posted",
          localTradeDate: "2020-01-01",
          tradeAt: "2020-01-01T00:00:00Z",
          quantityDecimal: "10",
          unitPriceDecimal: null,
          reversesTransactionId: null,
        },
      ],
      // Last trading day before the 2023-06-30 FY end is 2023-06-27 (a
      // Tuesday -- 30 Jun 2023 was a Friday, so this is a plausible "the
      // FY end landed on a weekend/holiday" shape) -- 3 days back, well
      // within the 7-day tolerance.
      priceObservations: [priceObservation("2023-06-27", "50.00")],
    }),
  ];
  const withinTolerance = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: [],
    fxObservations: [],
    date: "2023-06-30",
    priceToleranceDays: 7,
  });
  assert.equal(withinTolerance.valueDecimal, "500");
  assert.equal(withinTolerance.completeness, "complete");

  // The SAME facts, but the graph's exact-date-only rule (the default,
  // `priceToleranceDays` omitted) must NOT pick up that 3-day-old price --
  // exact-date-only stays exact-date-only.
  const exactDateOnly = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: [],
    fxObservations: [],
    date: "2023-06-30",
  });
  assert.equal(exactDateOnly.valueDecimal, null);

  // A date whose nearest observation is 9 days back (beyond the 7-day
  // tolerance) stays an honest gap, never a stale carried-forward figure.
  const factsFarther: HistoricalValueSecurityFact[] = [
    security({
      transactions: facts[0]!.transactions,
      priceObservations: [priceObservation("2023-06-21", "50.00")],
    }),
  ];
  const beyondTolerance = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: factsFarther,
    cashAccounts: [],
    fxObservations: [],
    date: "2023-06-30",
    priceToleranceDays: 7,
  });
  assert.equal(beyondTolerance.valueDecimal, null);
  assert.equal(beyondTolerance.heldSecurityCount, 1);
  assert.equal(beyondTolerance.pricedSecurityCount, 0);
});

test("HIST-001 review B3 ruling: a total built ENTIRELY from cash (no security ever priced) that is NEGATIVE never renders as a portfolio value -- degrades to an honest gap", () => {
  const facts: HistoricalValueSecurityFact[] = [
    security({
      transactions: [
        {
          id: "buy1",
          type: "buy",
          status: "posted",
          localTradeDate: "2020-01-01",
          tradeAt: "2020-01-01T00:00:00Z",
          quantityDecimal: "10",
          unitPriceDecimal: null,
          reversesTransactionId: null,
        },
      ],
      priceObservations: [], // never priced on this date
    }),
  ];
  const cash: HistoricalValueCashFact[] = [
    {
      cashAccountId: "ca",
      currencyCode: "AUD",
      entries: [
        {
          id: "e1",
          localDate: "2020-01-01",
          signedAmountDecimal: "-500",
          status: "posted",
          reversesEntryId: null,
        },
      ],
    },
  ];
  const point = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: cash,
    fxObservations: [],
    date: "2020-06-01",
  });
  assert.equal(point.valueDecimal, null);
  assert.equal(point.completeness, "partial");

  // Sanity: a POSITIVE cash-only total (no security priced) is NOT
  // suppressed by this guard -- only the negative case is nonsensical.
  const positiveCash: HistoricalValueCashFact[] = [
    {
      cashAccountId: "ca",
      currencyCode: "AUD",
      entries: [
        {
          id: "e1",
          localDate: "2020-01-01",
          signedAmountDecimal: "500",
          status: "posted",
          reversesEntryId: null,
        },
      ],
    },
  ];
  const positivePoint = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: facts,
    cashAccounts: positiveCash,
    fxObservations: [],
    date: "2020-06-01",
  });
  assert.equal(positivePoint.valueDecimal, "500");
});

test("HIST-001 review fold: a THROWING deriveSharesHeldAtDate sets anyComponentMissing -- never silently reports the point as fully complete", () => {
  // `deriveSharesHeldAtDate` self-catches a malformed QUANTITY (a no-op
  // contribution, per its own doc comment) -- it does NOT throw for that.
  // What genuinely throws is its internal sort comparator
  // (`left.tradeAt.localeCompare(right.tradeAt)`) when `tradeAt` itself is
  // not a string -- a deeper data-integrity corruption than this pure
  // module validates against (the app-layer loader's own row mapping
  // already guards against this at the external boundary; this exercises
  // the pure function's OWN defensive catch for a caller that bypasses
  // that, e.g. a future direct caller). Two transactions are required so
  // the sort comparator actually runs (Array.prototype.sort never invokes
  // it for a single element).
  const throwingSecurity: HistoricalValueSecurityFact = security({
    portfolioSecurityId: "ps-throws",
    transactions: [
      {
        id: "buy-a",
        type: "buy",
        status: "posted",
        localTradeDate: "2020-01-01",
        tradeAt: undefined as unknown as string,
        quantityDecimal: "10",
        unitPriceDecimal: null,
        reversesTransactionId: null,
      },
      {
        id: "buy-b",
        type: "buy",
        status: "posted",
        localTradeDate: "2020-02-01",
        tradeAt: "2020-02-01T00:00:00Z",
        quantityDecimal: "5",
        unitPriceDecimal: null,
        reversesTransactionId: null,
      },
    ],
    priceObservations: [],
  });
  const goodSecurity = security({
    portfolioSecurityId: "ps-good",
    transactions: [
      {
        id: "buy-good",
        type: "buy",
        status: "posted",
        localTradeDate: "2020-01-01",
        tradeAt: "2020-01-01T00:00:00Z",
        quantityDecimal: "10",
        unitPriceDecimal: null,
        reversesTransactionId: null,
      },
    ],
    priceObservations: [priceObservation("2020-06-01", "5.00")],
  });
  const point = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: [throwingSecurity, goodSecurity],
    cashAccounts: [],
    fxObservations: [],
    date: "2020-06-01",
  });
  // The good security's real $50 contributes; the throwing one must NOT
  // make this read as fully "complete" just because it silently dropped
  // out -- a real data-integrity gap, disclosed.
  assert.equal(point.valueDecimal, "50");
  assert.equal(point.completeness, "partial");
});

test("HIST-001 review fold: a THROWING deriveCashBalanceAtDate sets anyComponentMissing -- never silently reports the point as fully complete", () => {
  const goodSecurity = security({
    portfolioSecurityId: "ps-good",
    transactions: [
      {
        id: "buy-good",
        type: "buy",
        status: "posted",
        localTradeDate: "2020-01-01",
        tradeAt: "2020-01-01T00:00:00Z",
        quantityDecimal: "10",
        unitPriceDecimal: null,
        reversesTransactionId: null,
      },
    ],
    priceObservations: [priceObservation("2020-06-01", "5.00")],
  });
  const throwingCash: HistoricalValueCashFact[] = [
    {
      cashAccountId: "ca-throws",
      currencyCode: "AUD",
      // `null` entries array: `.filter()` throws inside
      // `deriveCashBalanceAtDate` -- a deeper corruption than a single
      // malformed entry (which that function already self-catches).
      entries: null as unknown as [],
    },
  ];
  const point = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: [goodSecurity],
    cashAccounts: throwingCash,
    fxObservations: [],
    date: "2020-06-01",
  });
  assert.equal(point.valueDecimal, "50"); // the security's real value still counts
  assert.equal(point.completeness, "partial");
});

// ---------------------------------------------------------------------------
// Part 3: DB-backed `app/historical-portfolio-value.ts` -- real migrated D1
// schema, sparse-monthly-then-daily fixture, sold-out period, bounded reads.
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

/** One held security ("FMG") with SPARSE monthly closes 2016-2017 then
 * DAILY closes from 2020 onward -- the exact density-change shape the
 * owner's 18-file import produced. Plus a cash account flagged
 * `completeness = 'incomplete'` (real real-account shape found during
 * investigation) with a fully-known ledger balance, so the "value is not
 * understated" honesty fix has a concrete fixture to prove against. */
async function sparseHistoryFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES
      ('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s-fmg','equity','asx','AUD','Fortescue','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('ps-fmg','a','pa','s-fmg','FMG','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx-buy','a','pa','ps-fmg','buy','posted','2016-01-15T00:00:00Z','2016-01-15','1000','2','AUD','2000','0','0','manual','a',1,'2016-01-15');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-owner-fmg','s-fmg','owner-import','ASX','FMG','2016-01-01','verified');

    -- Sparse monthly closes, 2016 (owner-import pre-2018 downsampling).
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-2016-01','owner-import','user','a','a','mapping-owner-fmg','s-fmg','eod','2016-01-31T04:00:00Z','2016-01-31','Australia/Sydney','AUD','2.00','raw','observed','2026-08-24T00:00:00Z'),
      ('price-2016-02','owner-import','user','a','a','mapping-owner-fmg','s-fmg','eod','2016-02-29T04:00:00Z','2016-02-29','Australia/Sydney','AUD','2.10','raw','observed','2026-08-24T00:00:00Z'),
      -- Daily closes once the density changes (2020 onward).
      ('price-2020-01','owner-import','user','a','a','mapping-owner-fmg','s-fmg','eod','2020-01-02T04:00:00Z','2020-01-02','Australia/Sydney','AUD','5.00','raw','observed','2026-08-24T00:00:00Z'),
      ('price-2020-02','owner-import','user','a','a','mapping-owner-fmg','s-fmg','eod','2020-01-03T04:00:00Z','2020-01-03','Australia/Sydney','AUD','5.10','raw','observed','2026-08-24T00:00:00Z');

    -- Real-account shape: cash flagged completeness='incomplete' but the
    -- ledger balance is fully known (400 posted).
    INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES
      ('ca','a','pa','AUD','incomplete','active');
    INSERT INTO cash_ledger_entries(id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES
      ('cle1','a','pa','ca',NULL,'2016-01-01T00:00:00Z','2016-01-01','cash_deposit','400','posted','2016-01-01');
  `);
  return db;
}

test("HIST-001: loadHistoricalPortfolioValueSeries -- sparse-monthly-then-daily series values only real observation dates, honestly, cash included", async () => {
  const db = await sparseHistoryFixture();
  const client = createSqliteSqlClient(db);
  // "now" kept within a decade of 2016 so the sparse pre-2018 dates fall
  // inside the loader's own ~10-year candidate-date bound (a deliberate,
  // documented cap -- see MAX_CANDIDATE_DATES in
  // app/historical-portfolio-value.ts), matching what a real reader would
  // see for a portfolio whose earliest trade is within that window.
  const result = await loadHistoricalPortfolioValueSeries(
    client,
    "a",
    "pa",
    new Date("2020-06-01T00:00:00Z"),
  );
  assert.ok(result);
  if (!result) return;
  assert.equal(result.baseCurrencyCode, "AUD");
  // Exactly the 4 real observation dates -- never a synthetic daily grid
  // filling in the ~4-year gap between 2016-02-29 and 2020-01-02.
  assert.deepEqual(
    result.points.map((point) => point.date),
    ["2016-01-31", "2016-02-29", "2020-01-02", "2020-01-03"],
  );
  // 2016-01-31: 1000 shares * 2.00 + 400 cash = 2400.00
  assert.equal(result.points[0]!.valueDecimal, "2400");
  assert.equal(result.points[0]!.completeness, "complete");
  // 2020-01-02: 1000 * 5.00 + 400 = 5400.00
  assert.equal(result.points[2]!.valueDecimal, "5400");
  assert.equal(result.datesTruncated, false);
});

test("HIST-001: loadHistoricalPortfolioValueAtDates -- targets specific FY-end dates against the same bounded fact set; a date with no observation on it reports an honest gap, never interpolated", async () => {
  const db = await sparseHistoryFixture();
  const client = createSqliteSqlClient(db);
  const byDate = await loadHistoricalPortfolioValueAtDates(
    client,
    "a",
    "pa",
    ["2016-01-31", "2016-06-30", "2020-01-02"],
    new Date("2020-06-01T00:00:00Z"),
  );
  assert.ok(byDate);
  if (!byDate) return;
  assert.equal(byDate.get("2016-01-31")?.valueDecimal, "2400");
  // 2016-06-30: no observation on this exact date for the SECURITY (between
  // the sparse Jan/Feb 2016 rows and the 2020 daily rows) -- an honest,
  // disclosed PARTIAL point: the cash leg is still known (400, same
  // currency, no FX needed) and is never dropped just because the security
  // leg has a gap, but `completeness` flips to "partial" so the caller
  // knows this total is real-but-understated, not a full snapshot.
  assert.equal(byDate.get("2016-06-30")?.valueDecimal, "400");
  assert.equal(byDate.get("2016-06-30")?.completeness, "partial");
  assert.equal(byDate.get("2020-01-02")?.valueDecimal, "5400");
});

test("HIST-001 review: ownership isolation -- a cross-owner portfolio read is denied honestly (null), for BOTH loaders", async () => {
  const db = await sparseHistoryFixture();
  db.exec(`
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const now = new Date("2020-06-01T00:00:00Z");
  const seriesAsWrongOwner = await loadHistoricalPortfolioValueSeries(
    client,
    "b", // portfolio "pa" belongs to user "a", not "b"
    "pa",
    now,
  );
  assert.equal(seriesAsWrongOwner, null);
  const atDatesAsWrongOwner = await loadHistoricalPortfolioValueAtDates(
    client,
    "b",
    "pa",
    ["2016-01-31"],
    now,
  );
  assert.equal(atDatesAsWrongOwner, null);
  // Sanity: the genuine owner still reads successfully against the SAME db.
  const seriesAsOwner = await loadHistoricalPortfolioValueSeries(
    client,
    "a",
    "pa",
    now,
  );
  assert.ok(seriesAsOwner);
});

test("HIST-001 review: MAX+1 fail-closed -- exceeding MAX_CASH_ACCOUNTS throws rather than silently truncating", async () => {
  const db = await sparseHistoryFixture();
  // 50 MORE cash accounts (51 total including the fixture's own "ca") --
  // one past MAX_CASH_ACCOUNTS. `cash_accounts` has a UNIQUE(portfolio_id,
  // currency_code) constraint, so each needs its OWN currency code (and a
  // matching `currencies` row for the FK) -- 50 synthetic 3-letter codes,
  // none colliding with the fixture's own "AUD".
  const codes = Array.from({ length: 50 }, (_, index) => {
    const first = String.fromCharCode(65 + Math.floor(index / 25));
    const second = String.fromCharCode(65 + (index % 25));
    return `Z${first}${second}`;
  });
  const currencyRows = codes
    .map((code, index) => `('${code}',${900 + index},'Synthetic ${code}',2)`)
    .join(",");
  db.exec(
    `INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ${currencyRows};`,
  );
  const accountRows = codes
    .map(
      (code, index) =>
        `('ca-extra-${index}','a','pa','${code}','complete','active')`,
    )
    .join(",");
  db.exec(
    `INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES ${accountRows};`,
  );
  const client = createSqliteSqlClient(db);
  await assert.rejects(
    () =>
      loadHistoricalPortfolioValueSeries(
        client,
        "a",
        "pa",
        new Date("2020-06-01T00:00:00Z"),
      ),
    /too_many_cash_accounts/,
  );
});

test("HIST-001 review fold: datesTruncated is set when the RANGE itself is clamped by the 10-year floor, even when the candidate-date COUNT never overflows", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES
      ('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','asx','AUD','Old Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('ps','a','pa','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-owner-s','s','owner-import','ASX','S','2000-01-01','verified');
    -- Earliest trade in year 2000 -- 26 years before "now" below, far past
    -- the ~10-year MAX_CANDIDATE_DATES floor.
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx-old','a','pa','ps','buy','posted','2000-01-01T00:00:00Z','2000-01-01','100','1','AUD','100','0','0','manual','a',1,'2000-01-01');
    -- Just ONE observation, well within the 10-year floor -- the candidate
    -- DATE COUNT never overflows MAX_CANDIDATE_DATES, so only the RANGE
    -- clamp itself can explain a truthful datesTruncated here.
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-recent','owner-import','user','a','a','mapping-owner-s','s','eod','2020-01-02T04:00:00Z','2020-01-02','Australia/Sydney','AUD','10.00','raw','observed','2026-08-24T00:00:00Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadHistoricalPortfolioValueSeries(
    client,
    "a",
    "pa",
    new Date("2026-08-25T00:00:00Z"),
  );
  assert.ok(result);
  if (!result) return;
  assert.equal(result.points.length, 1); // far under MAX_CANDIDATE_DATES
  assert.equal(
    result.datesTruncated,
    true,
    "the true earliest-trade-derived range (year 2000) was clamped forward by the 10-year floor -- real history this read never even queried for",
  );
});

// ---------------------------------------------------------------------------
// Part 4: bounded-read / no-write pin -- this feature performs SELECT-only
// reads, never a write, so the D1 free-plan write budget is never touched
// by a view (HIST-001 ruling).
// ---------------------------------------------------------------------------

test("HIST-001: app/historical-portfolio-value.ts never calls a write method (source pin -- no .run(/.batch( on the SqlClient)", async () => {
  const source = await readFile(
    new URL("../app/historical-portfolio-value.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /client\.run\(/);
  assert.doesNotMatch(source, /client\.batch\(/);
  assert.doesNotMatch(source, /\bINSERT INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\b/i);
  assert.doesNotMatch(source, /\bDELETE FROM\b/i);
});

test("HIST-001: domain/snapshots/historical-portfolio-value.ts is DB-free (no SqlClient import at all)", async () => {
  const source = await readFile(
    new URL(
      "../domain/snapshots/historical-portfolio-value.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /sql-client/);
  assert.doesNotMatch(source, /SqlClient/);
});

// ---------------------------------------------------------------------------
// Part 5: Multi-Year integration (`app/owned-income-projection.ts`) --
// historical FY rows populated from the SAME derivation, and the
// "incorrect future years" disclosure fix.
// ---------------------------------------------------------------------------

async function multiYearFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES
      ('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','asx','AUD','Priced Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-a','s','yahoo-compatible','ASX','S','2026-01-01','verified'),
      ('mapping-owner-a','s','owner-import','ASX','S','2016-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa','buy','posted','2020-01-01T00:00:00Z','2020-01-01','100','5','AUD','500','0','0','manual','a',1,'2020-01-01');
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m1','a','pa','psa','2026-03-01',NULL,NULL,NULL,'150',NULL,'batch-a','2026-03-01','2026-03-01',1);
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status) VALUES
      ('run-a','a','pa','2026-08-13','2026-08-13',1,'test','2','2','run-a','2026-08-13','2026-08-13','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at) VALUES
      ('a','pa','run-a',1,'2','2026-08-13T01:00:00Z');
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-a','a','pa','psa','100','500','500','5','complete','ready','2','run-a',1,'2026-08-13T01:00:00Z');
    -- Priced: FY23 end (2023-06-30) AND current (2026-08-13) -- FY24/FY25
    -- deliberately left without an exact-date observation (an honest gap).
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-fy23','owner-import','user','a','a','mapping-owner-a','s','eod','2023-06-30T06:00:00Z','2023-06-30','Australia/Sydney','AUD','8','raw','observed','2026-08-01T00:00:00Z'),
      ('price-now','yahoo-compatible','deployment',NULL,'deployment','mapping-a','s','eod','2026-08-13T01:00:00Z','2026-08-13','Australia/Sydney','AUD','10','raw','observed','2026-08-13T01:01:00Z');
    -- Real-account shape: cash flagged 'incomplete' but every held
    -- security is fully priced -- the "incorrect future years" fix's
    -- exact reproduction fixture.
    INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES
      ('ca','a','pa','AUD','incomplete','active');
    INSERT INTO cash_ledger_entries(id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES
      ('cle1','a','pa','ca',NULL,'2024-01-01T00:00:00Z','2024-01-01','cash_deposit','1000','posted','2024-01-01');
  `);
  return db;
}

test("HIST-001: Multi-Year historical FY rows are populated from the read-time derivation (one derivation, same as the graph) -- a genuinely unpriced FY-end date stays an honest gap, never fabricated", async () => {
  const db = await multiYearFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
    { yearsBack: 4 },
  );
  assert.equal(projection.status, "ok");
  const pastRows = projection.pastFinancialYears;
  assert.equal(pastRows.ok, true);
  if (!pastRows.ok) return;
  const fy23 = pastRows.rows.find((row) => row.endingYear === 2023);
  const fy24 = pastRows.rows.find((row) => row.endingYear === 2024);
  assert.ok(fy23, "expected an FY23 row");
  assert.ok(fy24, "expected an FY24 row");
  // FY23 ends 2023-06-30 -- exactly the priced date -- 100 shares * $8 = 800.
  assert.equal(fy23!.portfolioValueDecimal, "800");
  assert.equal(fy23!.valueStatus, "available");
  // FY24 ends 2024-06-30 -- no exact-date observation -- an honest,
  // disclosed gap, never a fabricated/interpolated figure.
  assert.equal(fy24!.portfolioValueDecimal, null);
  assert.equal(fy24!.valueStatus, "unavailable");
});

test("HIST-001: the 'incorrect future years' fix -- currentPortfolioValueStatus is 'partial' solely from cash completeness (every security fully priced), so the disclosure honestly says so instead of falsely blaming unpriced holdings", async () => {
  const db = await multiYearFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  assert.equal(projection.portfolioValueStatus, "partial");
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) return;
  assert.equal(
    projection.multiYearBaselineInput!.assumptions.currentPortfolioValueStatus,
    "partial",
  );
  const reason =
    projection.multiYearBaselineInput!.assumptions
      .currentPortfolioValuePartialReason;
  assert.ok(reason, "expected a partial reason to be computed");
  // THE FIX: the real cause is cash-history completeness, not unpriced
  // holdings (the fixture's one held security has a current price) -- the
  // OLD blanket claim was the "N held securities are unpriced" shape;
  // that specific claim must NOT appear here (0 securities are actually
  // unpriced in this fixture).
  assert.doesNotMatch(reason!, /held (?:security is|securities are) unpriced/);
  assert.match(reason!, /not understated/);
  // The row's own method string carries the SAME honest reason (DIV-011's
  // "survive standalone consumption" precedent).
  for (const row of projection.multiYear.rows) {
    assert.match(row.method, /current portfolio value is partial/);
    assert.doesNotMatch(row.method, /some holdings are unpriced/);
  }
});

test("HIST-001: existing DIV-011 fallback wording is preserved byte-identical when no partial reason is supplied (no regression for a fixture/caller that omits it)", () => {
  // Exercises the pure domain function directly with the field omitted --
  // exactly the shape every pre-existing test fixture (div-009/div-011)
  // already uses.
  const result = projectMultiYearIncome({
    assumptions: {
      currentPortfolioValueDecimal: "1000",
      currentPortfolioValueStatus: "partial",
      baseForecastGrossDecimal: "100",
      baseForecastCashDecimal: "70",
      baseYieldIncludesPartialTtm: false,
      baseForecastFrankingIncomplete: false,
      baseExcludedSecurityCount: 0,
      valueGrowthPercentDecimal: "6",
      valueGrowthSource: "none",
      dividendGrowthPercentDecimal: "6",
      dividendGrowthSource: "none",
    },
    yearsForward: 1,
    startEndingYear: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(
    result.rows[0]!.method,
    /based on a partial \(understated\) current portfolio value -- some holdings are unpriced/,
  );
});

test("HIST-001 review fold: an UNCONVERTED (FX-missing) cash account genuinely understates the current value -- the disclosure says so, distinct from the non-understating 'incomplete' cash-history case", async () => {
  const db = await multiYearFixture();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('USD',840,'US dollar',2);
    -- A SECOND, foreign-currency cash account with a real nonzero balance
    -- but NO fx_rate_observations row for AUD/USD anywhere -- the ONLY way
    -- loadOwnedHoldings's loadCash fails to CONVERT (as opposed to the
    -- pre-existing 'ca' account's completeness='incomplete' flag, which
    -- does NOT fail conversion at all, since AUD is already the base
    -- currency).
    INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES
      ('ca-usd','a','pa','USD','complete','active');
    INSERT INTO cash_ledger_entries(id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES
      ('cle-usd','a','pa','ca-usd',NULL,'2024-01-01T00:00:00Z','2024-01-01','cash_deposit','200','posted','2024-01-01');
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  assert.equal(projection.portfolioValueStatus, "partial");
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) return;
  const reason =
    projection.multiYearBaselineInput!.assumptions
      .currentPortfolioValuePartialReason;
  assert.ok(reason);
  // THE FIX: an unconverted cash account IS a real value-understating gap
  // -- named explicitly, never folded into the generic "not understated"
  // fallback the pure cash-history-completeness case uses.
  assert.match(reason!, /cash .*could not convert to the base currency/);
  assert.doesNotMatch(reason!, /not understated/);
});

// ---------------------------------------------------------------------------
// Part 6: `PortfolioValueChart` render pin -- gap-dashed rendering, honest
// empty/unavailable states (UI-018 gap conventions).
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

test("HIST-001: PortfolioValueChart -- unavailable state renders an honest message, no fabricated chart", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    {
      history: {
        status: "unavailable",
        baseCurrencyCode: "AUD",
        points: [],
        datesTruncated: false,
      },
      financialYearStartMonth: 7,
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-25T00:00:00.000Z",
    },
  );
  assert.match(html, /Portfolio value history is temporarily unavailable/);
  assert.doesNotMatch(html, /<svg/);
});

test("HIST-001: PortfolioValueChart -- empty state (no priced dates yet) renders an honest empty message, no fabricated chart", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    {
      history: {
        status: "empty",
        baseCurrencyCode: "AUD",
        points: [],
        datesTruncated: false,
      },
      financialYearStartMonth: 7,
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-25T00:00:00.000Z",
    },
  );
  assert.match(html, /No priced holding dates found yet/);
  assert.doesNotMatch(html, /<svg/);
});

test("HIST-001: PortfolioValueChart -- renders an SVG with a dashed gap segment across a genuine sparse-date hole, bare base-currency axis labels (UI-026)", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    {
      // Default range is "12M" (relative to the LATEST point), so every
      // point here is deliberately within 12 months of "2025-12-15" --
      // the internal ~104-day hole between 2025-09-02 and 2025-12-15 is
      // still a genuine gap (well past `classifyPriceHistorySegments`'s
      // 10-day absolute floor) but survives the range filter.
      history: {
        status: "ok",
        baseCurrencyCode: "AUD",
        points: [
          {
            date: "2025-09-01",
            valueDecimal: "2000.00",
            completeness: "complete",
          },
          {
            date: "2025-09-02",
            valueDecimal: "2100.00",
            completeness: "complete",
          },
          {
            date: "2025-12-15",
            valueDecimal: "5100.00",
            completeness: "complete",
          },
        ],
        datesTruncated: false,
      },
      financialYearStartMonth: 7,
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-25T00:00:00.000Z",
    },
  );
  assert.match(html, /<svg/);
  assert.match(html, /price-history-gap/);
  // Base-currency axis label is BARE ($), never "AUD 5,100.00" (UI-026).
  assert.match(html, /\$5,100/);
  assert.doesNotMatch(html, /AUD 5/);
});

test("HIST-001 review B2b: a PARTIAL point renders VISUALLY DISTINCT from a complete point -- never solid-identical -- and the caption names the count of unpriced held securities", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    {
      history: {
        status: "ok",
        baseCurrencyCode: "AUD",
        points: [
          {
            date: "2025-09-01",
            valueDecimal: "2000",
            completeness: "complete",
            heldSecurityCount: 3,
            pricedSecurityCount: 3,
          },
          {
            date: "2025-09-02",
            valueDecimal: "2100",
            // Partial: 1 of 3 held securities was unpriced this day.
            completeness: "partial",
            heldSecurityCount: 3,
            pricedSecurityCount: 2,
          },
          {
            date: "2025-09-03",
            valueDecimal: "2200",
            completeness: "complete",
            heldSecurityCount: 3,
            pricedSecurityCount: 3,
          },
        ],
        datesTruncated: false,
      },
      financialYearStartMonth: 7,
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-25T00:00:00.000Z",
    },
  );
  assert.match(html, /<svg/);
  // The partial point's marker AND at least one adjacent line run are
  // visually distinct (SHAPE/pattern -- the `price-history-partial` class,
  // never solid-identical to `.price-history-line` alone).
  assert.match(html, /price-history-dot price-history-partial/);
  assert.match(html, /price-history-line price-history-partial/);
  // Caption names the count of unpriced HELD securities (1 unpriced
  // instance: 3 held - 2 priced on the one partial day), not just "1
  // partial".
  assert.match(html, /1 partial \(1 unpriced held-security instance/);
  // The table's State column also names the per-row priced/held count.
  assert.match(html, /partial \(2\/3 held securities priced\)/);
});

// ---------------------------------------------------------------------------
// Part 7: review B1 compute-bound pin -- realistic-scale performance.
// ---------------------------------------------------------------------------

/** Wraps a real SqlClient to count every row `.all()` returns -- the
 * "measured read budget" this task's ARCHITECTURE.md §9.1 entry cites. */
function countingSqlClient(client: ReturnType<typeof createSqliteSqlClient>) {
  let rowsRead = 0;
  const wrapped: typeof client = {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const rows = await client.all<T>(sql, params);
      rowsRead += rows.length;
      return rows;
    },
    get: client.get.bind(client),
    run: client.run.bind(client),
    batch: client.batch.bind(client),
  };
  return { client: wrapped, rowsRead: () => rowsRead };
}

/**
 * Realistic-scale fixture: 18 held securities (the owner's real count)
 * sharing ~1,500 common trading dates (~6 years of weekday EOD closes,
 * the exact "1,500 dates x 18 securities" scale the review's B1 finding
 * measured ~35s CPU against under the OLD per-date linear-scan
 * implementation). Generated programmatically -- 27,000 price rows is not
 * hand-writable SQL.
 */
async function realisticScaleFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  const dates: string[] = [];
  // 1,500 weekday dates starting 2020-01-01 (skips weekends -- an
  // approximation of a real trading calendar, not exact holiday accuracy,
  // which is irrelevant to this performance measurement).
  const start = Date.UTC(2020, 0, 1);
  let cursor = start;
  while (dates.length < 1500) {
    const day = new Date(cursor);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(day.toISOString().slice(0, 10));
    }
    cursor += 86_400_000;
  }

  const securityIds = Array.from({ length: 18 }, (_, index) => `sec-${index}`);
  const statements: string[] = [
    `INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);`,
    `INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');`,
    `INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);`,
    `INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');`,
    `INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');`,
  ];
  statements.push(
    `INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES ${securityIds
      .map(
        (id) =>
          `('${id}','equity','asx','AUD','Security ${id}','2026-08-01','2026-08-01')`,
      )
      .join(",")};`,
  );
  statements.push(
    `INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES ${securityIds
      .map(
        (id) =>
          `('ps-${id}','a','pa','${id}','${id}','AUD','held','2026-08-01','2026-08-01')`,
      )
      .join(",")};`,
  );
  statements.push(
    `INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES ${securityIds
      .map(
        (id) =>
          `('map-${id}','${id}','owner-import','ASX','${id}','2020-01-01','verified')`,
      )
      .join(",")};`,
  );
  statements.push(
    `INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES ${securityIds
      .map(
        (id) =>
          `('tx-${id}','a','pa','ps-${id}','buy','posted','2020-01-01T00:00:00Z','2020-01-01','100','10','AUD','1000','0','0','manual','a',1,'2020-01-01')`,
      )
      .join(",")};`,
  );
  // 18 x 1,500 = 27,000 price rows, chunked into batches (a single
  // multi-hundred-thousand-character SQL string is impractical).
  const priceRows: string[] = [];
  let counter = 0;
  for (const id of securityIds) {
    for (const date of dates) {
      counter += 1;
      priceRows.push(
        `('price-${counter}','owner-import','user','a','a','map-${id}','${id}','eod','${date}T04:00:00.000Z','${date}','Australia/Sydney','AUD','10.00','raw','observed','2026-08-24T00:00:00.000Z')`,
      );
    }
  }
  db.exec(statements.join("\n"));
  const CHUNK = 1000;
  for (let index = 0; index < priceRows.length; index += CHUNK) {
    const chunk = priceRows.slice(index, index + CHUNK);
    db.exec(
      `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES ${chunk.join(",")};`,
    );
  }
  return db;
}

test("HIST-001 review B1 compute-bound pin: 18 securities x ~1,500 shared trading dates (27,000 price rows) completes the FULL series derivation in bounded time -- the indexed lookup fix, not the old O(dates x securities x observations) linear scan", async () => {
  const db = await realisticScaleFixture();
  const rawClient = createSqliteSqlClient(db);
  const { client, rowsRead } = countingSqlClient(rawClient);
  const startedAt = performance.now();
  const result = await loadHistoricalPortfolioValueSeries(
    client,
    "a",
    "pa",
    new Date("2026-08-25T00:00:00Z"),
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(result);
  if (!result) return;
  assert.equal(result.points.length, 1500);
  // Sanity: the derivation actually ran real math, not a short-circuit --
  // every point should have all 18 securities priced (same date grid).
  assert.equal(result.points[0]!.pricedSecurityCount, 18);
  assert.equal(
    result.points[result.points.length - 1]!.pricedSecurityCount,
    18,
  );
  // GENEROUS ceiling (review: "count evaluations or wall-clock with
  // generous ceiling") -- the old O(dates x securities x observations)
  // scan was measured at ~35s-CPU-class cost on real data at this scale;
  // the indexed fix should complete in well under a second on any modern
  // machine. 5s leaves enormous headroom while still catching a
  // regression back to the quadratic-ish shape.
  assert.ok(
    elapsedMs < 5_000,
    `expected the indexed derivation to complete in <5000ms, took ${elapsedMs.toFixed(0)}ms`,
  );
  // Recorded (also in docs/ARCHITECTURE.md §9.1): the measured read
  // budget for a load at this exact realistic scale.
  console.log(
    `HIST-001 B1 measurement: ${elapsedMs.toFixed(0)}ms elapsed, ${rowsRead()} total rows read for an 18-security/~1,500-date Overview load.`,
  );
});
