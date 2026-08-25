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

test("HIST-001: computeHistoricalPortfolioValueAtDate -- FX-converted foreign holding + a base-currency holding sum honestly; missing FX degrades to partial, never a silent zero or a wrong-currency number", () => {
  // BUG-002 owner ruling: this derivation is securities-only (cash is
  // deliberately excluded -- see the domain module's header). A second
  // base-currency (AUD) security stands in for the OLD cash leg here, to
  // keep pinning the SAME point: a different component's FX failure never
  // drops an already-known, no-FX-needed component out of the total.
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
  const audSecurity = security({
    portfolioSecurityId: "ps-aud",
    currencyCode: "AUD",
    transactions: [
      {
        id: "buy-aud",
        type: "buy",
        status: "posted",
        localTradeDate: "2022-01-01",
        tradeAt: "2022-01-01T00:00:00Z",
        quantityDecimal: "20",
        unitPriceDecimal: null,
        reversesTransactionId: null,
      },
    ],
    priceObservations: [priceObservation("2022-06-01", "10.00")], // 20 * 10.00 = 200
  });
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
    securities: [usdSecurity, audSecurity],
    fxObservations: fx,
    date: "2022-06-01",
  });
  assert.equal(withFx.completeness, "complete");
  assert.notEqual(withFx.valueDecimal, null);
  // The AUD security's $200 is definitely part of the total (never dropped
  // just because a DIFFERENT component needed FX).
  assert.ok(
    Number(withFx.valueDecimal) > 200,
    `expected the AUD security's $200 to be included in the total, got ${withFx.valueDecimal}`,
  );

  // Same date, but with NO fx_rate_observations at all: the USD security
  // cannot convert -- the point must degrade to partial (AUD-security-only
  // total), never silently drop to zero or fabricate a conversion.
  const withoutFx = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: [usdSecurity, audSecurity],
    fxObservations: [],
    date: "2022-06-01",
  });
  assert.equal(withoutFx.completeness, "partial");
  assert.equal(withoutFx.valueDecimal, "200");
  assert.equal(withoutFx.pricedSecurityCount, 1);
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
    fxObservations: [],
    date: "2023-06-30",
    priceToleranceDays: 7,
  });
  assert.equal(beyondTolerance.valueDecimal, null);
  assert.equal(beyondTolerance.heldSecurityCount, 1);
  assert.equal(beyondTolerance.pricedSecurityCount, 0);
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
    fxObservations: [],
    date: "2020-06-01",
  });
  // The good security's real $50 contributes; the throwing one must NOT
  // make this read as fully "complete" just because it silently dropped
  // out -- a real data-integrity gap, disclosed.
  assert.equal(point.valueDecimal, "50");
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
 * owner's 18-file import produced. Also seeds a REAL cash account/ledger
 * entry -- the ledger itself is retained (owner ruling, 2026-08-25: "Don't
 * destroy the ledger, could be useful in future, but yes for now stocks
 * only") -- deliberately present so the tests below can pin that this
 * derivation truly never reads it (BUG-002 owner ruling: securities-only;
 * see `domain/snapshots/historical-portfolio-value.ts`'s header), not just
 * that it happens to compute the right number in its absence. */
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

    -- A real cash account/ledger entry -- retained data (owner ruling), but
    -- deliberately NEVER consumed by this securities-only derivation; the
    -- tests below pin that its presence changes nothing.
    INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES
      ('ca','a','pa','AUD','incomplete','active');
    INSERT INTO cash_ledger_entries(id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES
      ('cle1','a','pa','ca',NULL,'2016-01-01T00:00:00Z','2016-01-01','cash_deposit','400','posted','2016-01-01');
  `);
  return db;
}

test("HIST-001/BUG-002: loadHistoricalPortfolioValueSeries -- sparse-monthly-then-daily series values only real observation dates, securities-only (a real cash account/ledger entry exists in the fixture but is never consumed)", async () => {
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
  // BUG-002 owner ruling: securities-only -- 2016-01-31: 1000 shares * 2.00
  // = 2000.00 (the fixture's own $400 cash ledger entry is deliberately
  // NOT summed in). The security is fully priced on this exact date, so
  // the point reads confidently "complete" regardless of the cash
  // account's own `completeness = 'incomplete'` flag (that flag is simply
  // never consulted here any more).
  assert.equal(result.points[0]!.valueDecimal, "2000");
  assert.equal(result.points[0]!.completeness, "complete");
  // 2020-01-02: 1000 * 5.00 = 5000.00
  assert.equal(result.points[2]!.valueDecimal, "5000");
  assert.equal(result.datesTruncated, false);
});

test("HIST-001/BUG-002: loadHistoricalPortfolioValueAtDates -- targets specific FY-end dates against the same bounded fact set; a date with no observation on it reports an honest gap, never interpolated, and never falls back to the (retained but unconsumed) cash ledger", async () => {
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
  assert.equal(byDate.get("2016-01-31")?.valueDecimal, "2000");
  // 2016-06-30: no observation on this exact date for the SECURITY (between
  // the sparse Jan/Feb 2016 rows and the 2020 daily rows) -- an honest,
  // disclosed gap. BUG-002 owner ruling: this is now a genuine NULL/gap
  // (never falls back to the fixture's own $400 cash ledger balance, which
  // would have masked the gap under the OLD cash-inclusive derivation).
  assert.equal(byDate.get("2016-06-30")?.valueDecimal, null);
  assert.equal(byDate.get("2016-06-30")?.completeness, "partial");
  assert.equal(byDate.get("2020-01-02")?.valueDecimal, "5000");
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

test("HIST-001/BUG-002: a large number of cash accounts (well past the OLD MAX_CASH_ACCOUNTS cap this derivation used to enforce) never affects or fails this read -- cash_accounts is never queried at all", async () => {
  const db = await sparseHistoryFixture();
  // 50 MORE cash accounts (51 total including the fixture's own "ca") --
  // one past the removed MAX_CASH_ACCOUNTS cap this module used to enforce
  // when it still read `cash_accounts`. `cash_accounts` has a
  // UNIQUE(portfolio_id, currency_code) constraint, so each needs its OWN
  // currency code (and a matching `currencies` row for the FK) -- 50
  // synthetic 3-letter codes, none colliding with the fixture's own "AUD".
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
  // BUG-002 owner ruling: securities-only -- this must succeed (no
  // "too_many_cash_accounts"/any cash-related error) and read the SAME
  // securities-only value as the sibling test above, proving cash_accounts
  // is genuinely never consulted regardless of how many rows exist.
  const result = await loadHistoricalPortfolioValueSeries(
    client,
    "a",
    "pa",
    new Date("2020-06-01T00:00:00Z"),
  );
  assert.ok(result);
  if (!result) return;
  assert.equal(result.points[0]!.valueDecimal, "2000");
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

test("HIST-001/BUG-002: Multi-Year historical FY rows are populated from the read-time derivation (one derivation, same as the graph), securities-only -- a genuinely unpriced FY-end date stays an honest gap, never fabricated, and `multiYearFixture()`'s cash account (flagged 'incomplete') never taints an otherwise-fully-priced FY row", async () => {
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

test("HIST-001/BUG-002: currentPortfolioValueDecimal/portfolioValueStatus are securities-only -- the fixture's cash account (flagged 'incomplete', a real nonzero balance) no longer degrades the CURRENT figure at all (extends the historical 'incorrect future years' fix to the current-value read too, per the owner's 2026-08-25 ruling: 'give the value of the stock portfolio, no magic negative cash or anything')", async () => {
  const db = await multiYearFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  // 100 shares * $10.00 (the fixture's 'price-now' row) = $1000 --
  // securities-only, no cash summed in, and no longer degraded to
  // "partial" by the cash account's own completeness flag.
  assert.equal(projection.currentPortfolioValueDecimal, "1000");
  assert.equal(projection.portfolioValueStatus, "available");
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) return;
  assert.equal(
    projection.multiYearBaselineInput!.assumptions.currentPortfolioValueStatus,
    "available",
  );
  assert.equal(
    projection.multiYearBaselineInput!.assumptions
      .currentPortfolioValuePartialReason,
    null,
  );
  // The row's own method string carries no partial-value caveat at all --
  // status is "available", so `projectMultiYearIncome`'s own conditional
  // clause for that text never fires (see its own doc comment).
  for (const row of projection.multiYear.rows) {
    assert.doesNotMatch(row.method, /current portfolio value is partial/);
    assert.doesNotMatch(row.method, /some holdings are unpriced/);
  }
  // BUG-002 owner-visible pin: this fixture's cash account is flagged
  // `completeness = 'incomplete'` -- under the OLD (pre-owner-ruling)
  // cash-inclusive derivation that flag would have degraded every
  // Multi-Year past-FY row to "unavailable" (the 2-state fails-closed
  // contract in `app/owned-income-projection.ts` never presents a
  // "partial" figure as confident) AND the current-FY row too. Since both
  // the historical AND current derivations are now securities-only, that
  // flag is never even consulted here -- the FY23 row (exactly priced, 100
  // shares * $8) reads AVAILABLE with its real securities-only value, and
  // the current-FY row sits coherently ABOVE it (a growing portfolio),
  // proving cash completeness genuinely cannot reach either path any more.
  const pastRows = projection.pastFinancialYears;
  assert.equal(pastRows.ok, true);
  if (pastRows.ok) {
    const fy23 = pastRows.rows.find((row) => row.endingYear === 2023);
    assert.ok(fy23, "expected an FY23 row");
    assert.equal(fy23!.valueStatus, "available");
    assert.equal(fy23!.portfolioValueDecimal, "800");
  }
  assert.equal(projection.currentFinancialYear.ok, true);
  if (projection.currentFinancialYear.ok) {
    assert.equal(
      projection.currentFinancialYear.row.portfolioValueDecimal,
      "1000",
    );
    assert.equal(projection.currentFinancialYear.row.valueStatus, "available");
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

test("HIST-001/BUG-002: an UNCONVERTED (FX-missing) cash account no longer affects currentPortfolioValueDecimal/portfolioValueStatus AT ALL -- cash is out of scope for this figure regardless of WHY it's incomplete (a genuine conversion failure, not just a completeness flag)", async () => {
  const db = await multiYearFixture();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('USD',840,'US dollar',2);
    -- A SECOND, foreign-currency cash account with a real nonzero balance
    -- but NO fx_rate_observations row for AUD/USD anywhere -- previously
    -- the ONE way loadOwnedHoldings's loadCash fails to CONVERT (as
    -- opposed to the pre-existing 'ca' account's completeness='incomplete'
    -- flag, which never failed conversion at all, since AUD is already the
    -- base currency). BUG-002: since cash is no longer summed into
    -- currentPortfolioValueDecimal AT ALL, neither cash-shaped gap can
    -- reach it any more -- this test now proves that for the STRICTER,
    -- genuinely-value-understating cash gap too, not just the completeness
    -- flag (already covered by the sibling test above).
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
  // Still exactly the securities-only $1000 -- the unconverted $200 USD
  // cash account contributes nothing and blocks nothing.
  assert.equal(projection.currentPortfolioValueDecimal, "1000");
  assert.equal(projection.portfolioValueStatus, "available");
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) return;
  assert.equal(
    projection.multiYearBaselineInput!.assumptions
      .currentPortfolioValuePartialReason,
    null,
  );
});

test("HIST-001/BUG-002: a DEEPLY NEGATIVE cash balance (the real owner account's exact shape -- an 'incomplete' account with only debits, no offsetting deposit ever recorded) never reaches currentPortfolioValueDecimal -- the headline reads the honest securities-only figure, not a huge negative number, and is not degraded to 'partial'", async () => {
  const db = await multiYearFixture();
  // Replace the fixture's modest cash entry with a large negative balance
  // -- the real account investigated for this task had a NET -$830,082.54
  // running balance (107 entries, all debits, zero deposits).
  db.exec(`
    UPDATE cash_ledger_entries SET signed_amount_decimal = '-830082.54' WHERE id = 'cle1';
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  // 100 shares * $10.00 = $1000 -- exactly as with the fixture's ORIGINAL,
  // modest cash entry above; the magnitude/sign of the cash balance makes
  // NO difference at all, because it is never read for this figure.
  assert.equal(projection.currentPortfolioValueDecimal, "1000");
  assert.equal(projection.portfolioValueStatus, "available");
});

test("HIST-001/BUG-002: app/owned-income-projection.ts sources currentPortfolioValueDecimal from cash.securitiesSubtotal, never cash.knownTotal (source pin -- knownTotal still includes cash, and is otherwise unused)", async () => {
  const source = await readFile(
    new URL("../app/owned-income-projection.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /holdings\.cash\.securitiesSubtotal/);
  assert.doesNotMatch(source, /holdings\.cash\.knownTotal/);
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

/** BUG-002 determinism pin: renders the SAME props TWICE, in the SAME
 * subprocess invocation, and returns both markups -- catches any render-
 * time non-determinism (`new Date()`/`Date.now()`/`Math.random()`, a
 * default-locale `toLocaleString()`/`toLocaleDateString()` call, or any
 * other impure read) that could make a client hydration re-render diverge
 * from the server-rendered markup for identical props, per React's own
 * hydration-mismatch warning ("Variable input such as Date.now() or
 * Math.random() which changes each time it's called"). */
function renderComponentTwice(
  componentName: string,
  componentPath: string,
  props: unknown,
): { first: string; second: string } {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify(props)};
    const first = renderToStaticMarkup(createElement(${componentName}, props));
    const second = renderToStaticMarkup(createElement(${componentName}, props));
    process.stdout.write(JSON.stringify({ first, second }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  return JSON.parse(output) as { first: string; second: string };
}

test("HIST-001/BUG-002 determinism pin: PortfolioValueChart renders BYTE-IDENTICAL markup across two renders of the SAME props (server-render-vs-hydration shape) -- guards against a stray new Date()/Date.now()/Math.random()/default-locale call reintroducing the Overview hydration-mismatch class of bug", () => {
  const { first, second } = renderComponentTwice(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    {
      history: {
        status: "ok",
        baseCurrencyCode: "AUD",
        points: [
          {
            date: "2018-01-31",
            valueDecimal: "5000.00",
            completeness: "complete",
            heldSecurityCount: 1,
            pricedSecurityCount: 1,
          },
          {
            date: "2020-06-30",
            valueDecimal: "6000.00",
            completeness: "partial",
            heldSecurityCount: 2,
            pricedSecurityCount: 1,
          },
          {
            date: "2026-08-24",
            valueDecimal: "10000.00",
            completeness: "complete",
            heldSecurityCount: 1,
            pricedSecurityCount: 1,
          },
        ],
        datesTruncated: true,
      },
      financialYearStartMonth: 7,
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-25T04:00:00.000Z",
    },
  );
  assert.equal(first, second);
  // Sanity: this genuinely exercised the populated-chart branch, not one of
  // the early-return empty/unavailable states (which would trivially match).
  assert.match(first, /<svg/);
});

/** Strips line comments and block comments before a source-regex scan --
 * several doc comments in this codebase deliberately DESCRIBE a forbidden
 * pattern in prose (e.g. "never new Date() inside a client component"),
 * which would otherwise false-positive a raw-text scan for that same
 * pattern. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("HIST-001/BUG-002 determinism pin (source scan): PortfolioValueChart never calls Date.now()/Math.random(), and never a BARE (argument-less, i.e. wall-clock) new Date() -- the render-twice test above only proves determinism for the props it happens to cover; this proves the class of impurity itself is absent from the source. A `new Date(dateString)` parse of an ALREADY-FIXED date string (this file's own `chartDate` helper) is deliberately allowed -- that is deterministic, not a wall-clock read.", async () => {
  const source = stripComments(
    await readFile(
      new URL("../app/components/portfolio-value-chart.tsx", import.meta.url),
      "utf8",
    ),
  );
  assert.doesNotMatch(source, /Date\.now\(/);
  assert.doesNotMatch(source, /Math\.random\(/);
  assert.doesNotMatch(source, /new Date\(\)/);
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

// ---------------------------------------------------------------------------
// Part 8 (BUG-002, owner ruling 2026-08-25, verbatim: "How is cash handled.
// First step is to make it work for the stocks, give the value of the stock
// portfolio. No magic negative cash or anything."): this derivation is
// SECURITIES-ONLY. An earlier version of this task threaded
// `cash_accounts.completeness` through so an account flagged 'incomplete'
// degraded a historical point -- investigation on the real account found
// the true problem one level up: that account's ledger has NO reliable
// opening balance at all (over $800k of net debits, zero recorded
// deposits), so REPLAYING it at every past date produced a large, growing,
// and fundamentally not-a-balance negative number that dragged every
// historical total down to a misleadingly small or negative figure -- no
// confidence label could make that number honest. The owner ruled the
// derivation should not attempt cash at all for now (ledger data itself is
// RETAINED, not deleted -- see `docs/CALCULATIONS.md`'s HIST-001
// subsection). These tests pin that a cash account/ledger entry, however
// it's shaped, can never affect a computed point.
// ---------------------------------------------------------------------------

test("HIST-001/BUG-002: computeHistoricalPortfolioValueAtDate has no cashAccounts parameter at all -- securities-only by construction, not by a value happening to net to zero", () => {
  const security: HistoricalValueSecurityFact = {
    portfolioSecurityId: "ps",
    currencyCode: "AUD",
    transactions: [
      {
        id: "t1",
        type: "buy",
        status: "posted",
        localTradeDate: "2020-01-01",
        tradeAt: "2020-01-01T00:00:00Z",
        quantityDecimal: "100",
        unitPriceDecimal: null,
        reversesTransactionId: null,
      },
    ],
    priceObservations: [priceObservation("2020-06-30", "10.00")],
  };
  const point = computeHistoricalPortfolioValueAtDate({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: "2026-08-25T00:00:00.000Z",
    securities: [security],
    fxObservations: [],
    date: "2020-06-30",
  });
  // 100 shares * $10.00 = $1000.00 -- exactly the securities-only figure,
  // never reduced by any cash leg (there is no parameter to supply one).
  assert.equal(point.valueDecimal, "1000");
  assert.equal(point.completeness, "complete");
});

test("HIST-001/BUG-002: app/historical-portfolio-value.ts never queries cash_accounts/cash_ledger_entries at all (source pin) -- a deeply-negative real cash ledger cannot silently resurface here", async () => {
  const source = await readFile(
    new URL("../app/historical-portfolio-value.ts", import.meta.url),
    "utf8",
  );
  // SQL-shaped patterns only -- distinct from the module's own explanatory
  // prose (its header/inline comments name these tables to document that
  // they are deliberately NOT read).
  assert.doesNotMatch(source, /FROM cash_accounts/);
  assert.doesNotMatch(source, /FROM cash_ledger_entries/);
  assert.doesNotMatch(source, /JOIN cash_accounts/);
  assert.doesNotMatch(source, /JOIN cash_ledger_entries/);
});

test("HIST-001/BUG-002: domain/snapshots/historical-portfolio-value.ts has no cash-shaped types, fields, or logic left (source pin) -- the header's own explanation of the owner ruling is the only place the word 'cash' may still appear", async () => {
  const source = await readFile(
    new URL(
      "../domain/snapshots/historical-portfolio-value.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /HistoricalValueCashFact/);
  assert.doesNotMatch(source, /cashAccounts/);
  assert.doesNotMatch(source, /deriveCashBalanceAtDate/);
  assert.doesNotMatch(source, /calculateCashConversion/);
  assert.doesNotMatch(source, /LedgerCashFact/);
  assert.doesNotMatch(source, /cashHistoryIncomplete/);
});

test("HIST-001/BUG-002: loadHistoricalPortfolioValueAtDates -- a real, deeply-negative cash ledger in the DB (the exact real-account shape investigation found) never reaches the computed point", async () => {
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
      ('ps','a','pa','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-s','s','owner-import','ASX','S','2020-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','ps','buy','posted','2020-01-01T00:00:00Z','2020-01-01','100','5','AUD','500','0','0','manual','a',1,'2020-01-01');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price1','owner-import','user','a','a','mapping-s','s','eod','2020-06-30T04:00:00Z','2020-06-30','Australia/Sydney','AUD','10.00','raw','observed','2026-08-24T00:00:00Z');
    -- Real-account shape: a cash ledger with no offsetting deposit ever
    -- recorded (only debits) -- exactly what investigation found on the
    -- real account (over $800k net negative). This derivation must never
    -- touch it.
    INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES
      ('ca','a','pa','AUD','incomplete','active');
    INSERT INTO cash_ledger_entries(id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES
      ('cle1','a','pa','ca',NULL,'2020-01-01T00:00:00Z','2020-01-01','cash_withdrawal','-5000000','posted','2020-01-01');
  `);
  const client = createSqliteSqlClient(db);
  const byDate = await loadHistoricalPortfolioValueAtDates(
    client,
    "a",
    "pa",
    ["2020-06-30"],
    new Date("2026-08-25T00:00:00Z"),
  );
  assert.ok(byDate);
  if (!byDate) return;
  const point = byDate.get("2020-06-30");
  // 100 shares * $10.00 = $1000.00 -- NOT dragged to a huge negative
  // number by the $5,000,000-negative cash ledger sitting right there in
  // the DB, and confidently "available"/"complete" (the security is fully
  // priced; the cash account's own 'incomplete' flag is irrelevant here).
  assert.equal(point?.valueDecimal, "1000");
  assert.equal(point?.completeness, "complete");
});
