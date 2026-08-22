// UI-030 (owner directive, verbatim): "In holdings, for any ticker row that
// has sold shares, there should be a forth line. On the left column on the
// fourth line it should say 'Realised:' and then have the realised capital
// followed by the gain expressed as a percent of the basis at the time of
// the gain. Example: 'Realised: +$15000 (+13.91%)'."
//
// Part 1 (pure, no DB): `domain/gains/security-totals.ts`'s
// `computeSecurityRealisedGainTotals` -- per-security lifetime rollup,
// sign-preserving sums incl. a loss, multi-security isolation, zero-basis
// (never divide by zero), and incomplete-basis handling (partial vs
// entirely-unknown).
//
// Part 2 (render, via the same child-process trick every other `.tsx`
// formatter test in this suite uses): `app/owned-holding-format.tsx`'s
// `ownedHoldingRealisedGainLine` -- no fourth line for a never-sold
// security, amount+percent shape, loss tone, the partial-coverage
// qualifier, the all-incomplete "unavailable" state, and base-currency
// (never foreign-flagged) rendering regardless of which currency is the
// portfolio's own base.
//
// Part 3 (migrated in-memory D1-shaped DB, mirroring `tests/cgt-001a.test.ts`'s
// fixtures): `app/owned-capital-gains.ts`'s `loadOwnedRealisedGainTotals` --
// one batched read sums a security's disposals across financial years into
// one lifetime entry, and a different security's disposal stays separate.
//
// Part 4 (review fold, reviewer follow-up 3): ONE rendered
// `OwnedHoldingsScreen` pin (via `PortfolioShell`, the same child-process
// trick `tests/qa-001b.test.ts`'s `renderOwnedHoldings` uses) with
// `ownedWorkspace.realisedGains` actually populated -- proves the real prop
// threading (`app/authenticated-workspace.ts` -> `OwnedWorkspace` ->
// `OwnedHoldingsScreen` -> `ownedHoldingRealisedGainLine`) end to end, so a
// regression anywhere in that chain (e.g. a renamed prop, a dropped
// `realisedGains={...}` at the call site) cannot silently kill the feature
// the way a pure-function-only test suite would miss.
//
// Part 5 (review fold, reviewer follow-up 4): a half-even TIE fixture for
// `percentDecimal`'s rounding, independently hand-verified.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnedRealisedGainTotals } from "../app/owned-capital-gains.ts";
import { computeSecurityRealisedGainTotals } from "../domain/gains/security-totals.ts";
import type { CapitalGainDisposalRow } from "../domain/gains/disposal-rows.ts";

// ===========================================================================
// Part 1: computeSecurityRealisedGainTotals (domain/gains/security-totals.ts)
// ===========================================================================

function row(
  overrides: Partial<CapitalGainDisposalRow>,
): CapitalGainDisposalRow {
  return {
    allocationId: "alloc",
    portfolioSecurityId: "sec-1",
    securitySymbol: "ABC",
    securityName: "ABC Holdings",
    acquiredDate: "2024-01-01",
    disposedDate: "2026-01-15",
    quantityDecimal: "1",
    proceedsDecimal: "0",
    basisDecimal: "0",
    feeDecimal: "0",
    taxDecimal: "0",
    gainDecimal: "0",
    basisStatus: "complete",
    holdingPeriodEligible: true,
    discountThresholdDate: "2025-01-01",
    eligibility: "not_applicable_zero",
    ...overrides,
  };
}

test("UI-030 security-totals: sums gains sign-preserving across a gain and a loss for one security, and computes percent of basis-at-disposal", () => {
  // sec-1: gain 1000 (basis 2000) + loss -200 (basis 800)
  //   gainDecimal = 800, basisAtDisposalDecimal = 2800
  //   percent = 800 / 2800 * 100 = 28.571428... -> trimmed 2dp = 28.57
  const rows: CapitalGainDisposalRow[] = [
    row({
      allocationId: "a1",
      portfolioSecurityId: "sec-1",
      gainDecimal: "1000",
      basisDecimal: "2000",
    }),
    row({
      allocationId: "a2",
      portfolioSecurityId: "sec-1",
      gainDecimal: "-200",
      basisDecimal: "800",
    }),
  ];
  const totals = computeSecurityRealisedGainTotals(rows);
  const total = totals.get("sec-1");
  assert.ok(total);
  assert.equal(total?.disposalCount, 2);
  assert.equal(total?.knownDisposalCount, 2);
  assert.equal(total?.partialCoverage, false);
  assert.equal(total?.gainDecimal, "800");
  assert.equal(total?.basisAtDisposalDecimal, "2800");
  assert.equal(total?.percentDecimal, "28.57");
});

test("UI-030 security-totals: each portfolioSecurityId gets its own isolated entry -- one security's rows never bleed into another's sums", () => {
  const rows: CapitalGainDisposalRow[] = [
    row({
      allocationId: "a1",
      portfolioSecurityId: "sec-1",
      gainDecimal: "100",
      basisDecimal: "200",
    }),
    row({
      allocationId: "a2",
      portfolioSecurityId: "sec-2",
      gainDecimal: "500",
      basisDecimal: "500",
    }),
  ];
  const totals = computeSecurityRealisedGainTotals(rows);
  assert.equal(totals.size, 2);
  assert.equal(totals.get("sec-1")?.gainDecimal, "100");
  assert.equal(totals.get("sec-2")?.gainDecimal, "500");
  assert.equal(totals.get("sec-2")?.percentDecimal, "100"); // trimmed, no ".00"
  // A security with no rows at all simply has no entry (never-sold).
  assert.equal(totals.get("sec-3"), undefined);
});

test("UI-030 security-totals: zero total basis (e.g. free shares) never divides by zero -- percentDecimal is null, gain still reported", () => {
  const rows: CapitalGainDisposalRow[] = [
    row({ gainDecimal: "100", basisDecimal: "0" }),
  ];
  const total = computeSecurityRealisedGainTotals(rows).get("sec-1");
  assert.equal(total?.gainDecimal, "100");
  assert.equal(total?.basisAtDisposalDecimal, "0");
  assert.equal(total?.percentDecimal, null);
});

test("UI-030 security-totals: an incomplete-basis disposal is excluded from the sums (never a fabricated zero) and disclosed via partialCoverage/excludedIncompleteCount", () => {
  const rows: CapitalGainDisposalRow[] = [
    row({ allocationId: "known-1", gainDecimal: "100", basisDecimal: "200" }),
    row({
      allocationId: "incomplete-1",
      gainDecimal: null,
      basisDecimal: null,
      basisStatus: "incomplete_basis",
      eligibility: "unknown_incomplete_basis",
    }),
  ];
  const total = computeSecurityRealisedGainTotals(rows).get("sec-1");
  assert.equal(total?.disposalCount, 2);
  assert.equal(total?.knownDisposalCount, 1);
  assert.equal(total?.excludedIncompleteCount, 1);
  assert.equal(total?.partialCoverage, true);
  // Only the known row contributes -- the incomplete one is excluded, not
  // folded in as a zero.
  assert.equal(total?.gainDecimal, "100");
  assert.equal(total?.basisAtDisposalDecimal, "200");
});

test("UI-030 security-totals: when EVERY disposal for a security is incomplete, the known-sum is the empty '0' (never presented as a real known gain) and basis is '0' too", () => {
  const rows: CapitalGainDisposalRow[] = [
    row({
      gainDecimal: null,
      basisDecimal: null,
      basisStatus: "incomplete_fx",
      eligibility: "unknown_incomplete_basis",
    }),
  ];
  const total = computeSecurityRealisedGainTotals(rows).get("sec-1");
  assert.equal(total?.disposalCount, 1);
  assert.equal(total?.knownDisposalCount, 0);
  assert.equal(total?.partialCoverage, true);
  assert.equal(total?.gainDecimal, "0");
  assert.equal(total?.basisAtDisposalDecimal, "0");
  assert.equal(total?.percentDecimal, null);
});

test("UI-030 security-totals: no rows at all produces an empty map", () => {
  assert.equal(computeSecurityRealisedGainTotals([]).size, 0);
});

// ===========================================================================
// Part 2: ownedHoldingRealisedGainLine (app/owned-holding-format.tsx)
// ===========================================================================

function renderRealisedLine(
  homeCurrencyCode: string,
  total: unknown,
): { tone: string; html: string } | null {
  const moduleUrl = new URL("../app/owned-holding-format.tsx", import.meta.url)
    .href;
  const script = `
    import { createElement, Fragment } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ownedHoldingRealisedGainLine } from ${JSON.stringify(moduleUrl)};
    const result = ownedHoldingRealisedGainLine(
      ${JSON.stringify(homeCurrencyCode)},
      ${JSON.stringify(total)},
    );
    process.stdout.write(
      JSON.stringify(
        result === null
          ? null
          : {
              tone: result.tone,
              html: renderToStaticMarkup(
                createElement(Fragment, null, result.content),
              ),
            },
      ),
    );
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

function fullTotal(overrides: Record<string, unknown> = {}) {
  return {
    portfolioSecurityId: "sec-1",
    disposalCount: 2,
    knownDisposalCount: 2,
    excludedIncompleteCount: 0,
    partialCoverage: false,
    gainDecimal: "15000",
    basisAtDisposalDecimal: "107836.81",
    percentDecimal: "13.91",
    ...overrides,
  };
}

test("UI-030 render: a security with no realised-gain entry at all (never sold, or the enrichment failed to load) gets no fourth line", () => {
  assert.equal(renderRealisedLine("AUD", undefined), null);
});

test("UI-030 render: a security with disposalCount 0 (defensive -- should not occur from the domain layer) also gets no fourth line", () => {
  assert.equal(
    renderRealisedLine("AUD", fullTotal({ disposalCount: 0 })),
    null,
  );
});

test("UI-030 render: the owner's own example shape -- 'Realised: +$15,000.00 (+13.91%)' (sign BEFORE the currency symbol, per the UI-030 review ruling 2026-08-23), positive tone, base currency bare '$'", () => {
  const result = renderRealisedLine("AUD", fullTotal());
  assert.ok(result);
  assert.equal(result?.tone, "positive");
  assert.match(result!.html, /Realised:\s*\+\$15,000\.00\s*\(\+13\.91%\)/);
});

test("UI-030 render: a net loss renders the minus sign (before the currency symbol) and negative tone", () => {
  const result = renderRealisedLine(
    "AUD",
    fullTotal({
      gainDecimal: "-500",
      basisAtDisposalDecimal: "2000",
      percentDecimal: "-25",
    }),
  );
  assert.ok(result);
  assert.equal(result?.tone, "negative");
  assert.match(result!.html, /Realised:\s*-\$500\.00\s*\(-25%\)/);
});

test("UI-030 render: zero total basis (free shares) shows the known amount with 'percent unavailable', never a divide-by-zero percent", () => {
  const result = renderRealisedLine(
    "AUD",
    fullTotal({
      gainDecimal: "100",
      basisAtDisposalDecimal: "0",
      percentDecimal: null,
    }),
  );
  assert.ok(result);
  assert.match(
    result!.html,
    /Realised:\s*\+\$100\.00\s*\(percent unavailable\)/,
  );
});

test("UI-030 render: partial coverage shows the known partial amount with an honest qualifier using CGT-001A's 'lot matches' vocabulary (never bare 'disposals' -- disposalCount counts allocations, per capital-gains-screen.tsx's standing ruling), and NEVER a percent (the denominator itself excludes the unknown allocations)", () => {
  const result = renderRealisedLine(
    "AUD",
    fullTotal({
      disposalCount: 3,
      knownDisposalCount: 2,
      excludedIncompleteCount: 1,
      partialCoverage: true,
      gainDecimal: "100",
      basisAtDisposalDecimal: "200",
      percentDecimal: "50", // present on the fixture, but must be SUPPRESSED in the rendered text
    }),
  );
  assert.ok(result);
  assert.match(result!.html, /Realised:\s*\+\$100\.00\s*\(partial/);
  assert.match(result!.html, /1 of 3 lot match/);
  assert.doesNotMatch(result!.html, /disposal/i);
  assert.doesNotMatch(result!.html, /50%/);
});

test("UI-030 render: when every disposal for a security is incomplete, the line reads honestly 'unavailable' -- never a fabricated $0", () => {
  const result = renderRealisedLine(
    "AUD",
    fullTotal({
      disposalCount: 1,
      knownDisposalCount: 0,
      excludedIncompleteCount: 1,
      partialCoverage: true,
      gainDecimal: "0",
      basisAtDisposalDecimal: "0",
      percentDecimal: null,
    }),
  );
  assert.ok(result);
  assert.equal(result?.tone, "neutral");
  assert.match(result!.html, /Realised:\s*unavailable/);
  assert.doesNotMatch(result!.html, /\$0/);
  // CGT-001A's standing "never label allocations 'disposals' unqualified"
  // ruling applies to the sr-only explanation too.
  assert.match(result!.html, /every lot match of this security/);
  assert.doesNotMatch(result!.html, /disposal/i);
});

test("UI-030 render: the amount is ALWAYS the bare base symbol, regardless of which currency is the portfolio's own base (never foreign-flagged -- realised gains are always base-currency facts)", () => {
  const aud = renderRealisedLine("AUD", fullTotal());
  const usd = renderRealisedLine(
    "USD",
    fullTotal({ gainDecimal: "15000", basisAtDisposalDecimal: "107836.81" }),
  );
  const gbp = renderRealisedLine(
    "GBP",
    fullTotal({ gainDecimal: "15000", basisAtDisposalDecimal: "107836.81" }),
  );
  // Sign lands BEFORE the currency symbol (UI-030 review ruling, 2026-08-23).
  assert.match(aud!.html, /\+\$15,000\.00/);
  // A base-USD portfolio must render a bare "$", never the foreign-flagged
  // "US$" -- this figure is already in USD, the portfolio's OWN base.
  assert.match(usd!.html, /\+\$15,000\.00/);
  assert.doesNotMatch(usd!.html, /US\$/);
  assert.match(gbp!.html, /\+£15,000\.00/);
});

// ===========================================================================
// Part 3: loadOwnedRealisedGainTotals (app/owned-capital-gains.ts)
// ===========================================================================

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    database.exec(
      await readFile(
        new URL(`../drizzle/${migrationFile}`, import.meta.url),
        "utf8",
      ),
    );
  }
  return database;
}

function seedBase(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version) VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, default_holding_currency_view, financial_year_start_month, created_at, updated_at, version) VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'home', 7, '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version) VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, created_at, updated_at) VALUES
      ('security-a', 'equity', 'AUD', 'ABC Holdings', '2026-08-03', '2026-08-03'),
      ('security-c', 'equity', 'AUD', 'XYZ Mining', '2026-08-03', '2026-08-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at) VALUES
      ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'hidden', '2026-08-03', '2026-08-03'),
      ('membership-c', 'user-a', 'portfolio-a', 'security-c', 'XYZ', 'AUD', 'hidden', '2026-08-03', '2026-08-03');
  `);
}

function insertTransaction(
  database: DatabaseSync,
  values: {
    id: string;
    portfolioSecurityId?: string;
    type: string;
    tradeAt: string;
    localTradeDate?: string;
    quantityDecimal?: string | null;
    unitPriceDecimal?: string | null;
    grossAmountDecimal?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO transactions (
        id, user_id, portfolio_id, portfolio_security_id, type, status,
        trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
        currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal,
        source_type, source_reference, created_by_user_id, calculation_version, created_at
      ) VALUES (?, 'user-a', 'portfolio-a', ?, ?, 'posted', ?, ?, ?, ?, 'AUD', ?, '0', '0', 'manual', ?, 'user-a', 1, ?)`,
    )
    .run(
      values.id,
      values.portfolioSecurityId ?? "membership-a",
      values.type,
      values.tradeAt,
      values.localTradeDate ?? values.tradeAt.slice(0, 10),
      values.quantityDecimal ?? null,
      values.unitPriceDecimal ?? null,
      values.grossAmountDecimal ?? null,
      values.id,
      values.tradeAt.slice(0, 10),
    );
}

function insertCalculationRun(
  database: DatabaseSync,
  values: { id: string; highWaterStart: string; highWaterEnd?: string | null },
): void {
  database
    .prepare(
      `INSERT INTO calculation_runs (
        id, user_id, portfolio_id, range_from, range_to, calculation_version,
        reason, status, ledger_high_water_start, ledger_high_water_end,
        idempotency_key, created_at, updated_at
      ) VALUES (?, 'user-a', 'portfolio-a', '2024-01-01', '2026-12-31', 1, 'transaction_change', 'completed', ?, ?, ?, '2026-08-03', '2026-08-03')`,
    )
    .run(
      values.id,
      values.highWaterStart,
      values.highWaterEnd ?? null,
      `key-${values.id}`,
    );
}

function insertPublication(
  database: DatabaseSync,
  values: { calculationRunId: string; ledgerHighWater: string },
): void {
  database
    .prepare(
      `INSERT INTO projection_publications (
        user_id, portfolio_id, calculation_run_id, calculation_version,
        ledger_high_water, published_at
      ) VALUES ('user-a', 'portfolio-a', ?, 1, ?, '2026-08-03T01:00:00Z')`,
    )
    .run(values.calculationRunId, values.ledgerHighWater);
}

function insertTaxLot(
  database: DatabaseSync,
  values: {
    id: string;
    portfolioSecurityId?: string;
    openingTransactionId: string;
    acquiredAt: string;
    calculationRunId: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO tax_lots (
        id, user_id, portfolio_id, portfolio_security_id, opening_transaction_id,
        acquired_at, original_quantity_decimal, open_quantity_decimal,
        native_basis_decimal, base_basis_decimal, basis_status, status,
        calculation_run_id, calculation_version, rebuilt_at
      ) VALUES (?, 'user-a', 'portfolio-a', ?, ?, ?, '10', '0', '100', '100', 'complete', 'closed', ?, 1, '2026-08-03T01:00:00Z')`,
    )
    .run(
      values.id,
      values.portfolioSecurityId ?? "membership-a",
      values.openingTransactionId,
      values.acquiredAt,
      values.calculationRunId,
    );
}

function insertLotAllocation(
  database: DatabaseSync,
  values: {
    id: string;
    portfolioSecurityId?: string;
    sellTransactionId: string;
    taxLotId: string;
    allocatedBaseBasisDecimal?: string;
    baseRealisedGainDecimal?: string;
    calculationRunId: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO lot_allocations (
        id, user_id, portfolio_id, portfolio_security_id, sell_transaction_id,
        tax_lot_id, allocation_sequence, matched_quantity_decimal,
        allocated_base_basis_decimal, base_net_proceeds_decimal,
        fee_base_decimal, tax_base_decimal, base_realised_gain_decimal,
        basis_status, calculation_run_id, calculation_version
      ) VALUES (?, 'user-a', 'portfolio-a', ?, ?, ?, 1, '5', ?, '80', '0', '0', ?, 'complete', ?, 1)`,
    )
    .run(
      values.id,
      values.portfolioSecurityId ?? "membership-a",
      values.sellTransactionId,
      values.taxLotId,
      values.allocatedBaseBasisDecimal ?? "50",
      values.baseRealisedGainDecimal ?? "30",
      values.calculationRunId,
    );
}

test("UI-030 service: loadOwnedRealisedGainTotals sums one security's disposals ACROSS financial years into one lifetime entry, and keeps a different security separate", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  // Security A: two sells in two different financial years (July-start FY),
  // each closing its own tax lot (tax_lots has a UNIQUE(opening_transaction_id,
  // calculation_run_id) constraint, so each lot needs its own opening buy).
  insertTransaction(database, {
    id: "tx-buy-a1",
    type: "buy",
    tradeAt: "2023-01-01T09:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-buy-a2",
    type: "buy",
    tradeAt: "2023-02-01T09:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell-a1",
    type: "sell",
    tradeAt: "2025-01-15T09:00:00Z", // FY25
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell-a2",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z", // FY26
    quantityDecimal: "5",
    unitPriceDecimal: "5",
    grossAmountDecimal: "25",
  });
  // Security C: one sell, kept separate from A.
  insertTransaction(database, {
    id: "tx-buy-c",
    portfolioSecurityId: "membership-c",
    type: "buy",
    tradeAt: "2023-01-01T09:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  insertTransaction(database, {
    id: "tx-sell-c",
    portfolioSecurityId: "membership-c",
    type: "sell",
    tradeAt: "2025-06-01T09:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });

  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell-a1",
    highWaterEnd: "tx-sell-c",
  });
  insertTaxLot(database, {
    id: "lot-a1",
    openingTransactionId: "tx-buy-a1",
    acquiredAt: "2023-01-01T09:00:00Z",
    calculationRunId: "run-a",
  });
  insertTaxLot(database, {
    id: "lot-a2",
    openingTransactionId: "tx-buy-a2",
    acquiredAt: "2023-02-01T09:00:00Z",
    calculationRunId: "run-a",
  });
  insertTaxLot(database, {
    id: "lot-c",
    portfolioSecurityId: "membership-c",
    openingTransactionId: "tx-buy-c",
    acquiredAt: "2023-01-01T09:00:00Z",
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-a1",
    sellTransactionId: "tx-sell-a1",
    taxLotId: "lot-a1",
    allocatedBaseBasisDecimal: "50",
    baseRealisedGainDecimal: "30", // gain
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-a2",
    sellTransactionId: "tx-sell-a2",
    taxLotId: "lot-a2",
    allocatedBaseBasisDecimal: "50",
    baseRealisedGainDecimal: "-25", // loss, following FY
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-c",
    portfolioSecurityId: "membership-c",
    sellTransactionId: "tx-sell-c",
    taxLotId: "lot-c",
    allocatedBaseBasisDecimal: "50",
    baseRealisedGainDecimal: "50",
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell-c",
  });

  const client = createSqliteSqlClient(database);
  const totals = await loadOwnedRealisedGainTotals(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(totals.baseCurrencyCode, "AUD");
  // Lifetime, across BOTH financial years: 30 + (-25) = 5, basis 50 + 50 = 100.
  const securityA = totals.bySecurity.get("membership-a");
  assert.equal(securityA?.disposalCount, 2);
  assert.equal(securityA?.gainDecimal, "5");
  assert.equal(securityA?.basisAtDisposalDecimal, "100");
  assert.equal(securityA?.percentDecimal, "5");
  // Security C stays a fully separate entry.
  const securityC = totals.bySecurity.get("membership-c");
  assert.equal(securityC?.disposalCount, 1);
  assert.equal(securityC?.gainDecimal, "50");
});

test("UI-030 service: a portfolio with no disposals ever returns an empty bySecurity map (never-sold securities have no entry)", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2026-01-01T10:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  const client = createSqliteSqlClient(database);
  const totals = await loadOwnedRealisedGainTotals(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(totals.bySecurity.size, 0);
});

// ===========================================================================
// Part 5 (review fold, reviewer follow-up 4): half-even TIE fixture for
// percentDecimal.
// ===========================================================================

test("UI-030 security-totals: percentDecimal rounds an EXACT tie half-even (banker's rounding), matching every other money/percent figure in this app", () => {
  // 13915 / 100000 * 100 = 13.915 exactly -- the digit being dropped is a
  // tie ("5"), and the preceding digit (1) is ODD, so half-even rounds UP
  // to the nearest even digit: 13.92.
  const tieRoundsUp = computeSecurityRealisedGainTotals([
    row({
      portfolioSecurityId: "sec-tie-up",
      gainDecimal: "13915",
      basisDecimal: "100000",
    }),
  ]).get("sec-tie-up");
  assert.equal(tieRoundsUp?.percentDecimal, "13.92");

  // 13925 / 100000 * 100 = 13.925 exactly -- the preceding digit (2) is
  // ALREADY even, so half-even leaves it there: 13.92 (not 13.93).
  const tieStaysEven = computeSecurityRealisedGainTotals([
    row({
      portfolioSecurityId: "sec-tie-even",
      gainDecimal: "13925",
      basisDecimal: "100000",
    }),
  ]).get("sec-tie-even");
  assert.equal(tieStaysEven?.percentDecimal, "13.92");
});

// ===========================================================================
// Part 4 (review fold, reviewer follow-up 3): a rendered OwnedHoldingsScreen
// pin proving realisedGains prop-threading end to end.
// ===========================================================================

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

function renderOwnedHoldingsWithRealisedGains(): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    function holdingValue(status, currencyCode, value, reason) {
      return { status, currencyCode, value, reason: reason ?? null };
    }

    // A sold-to-zero (fully exited) holding -- owned holdings never filter
    // zero-quantity rows (WLT-001-era finding), so this row still renders
    // normally and IS the one with a realisedGains entry.
    const exited = {
      id: "row-exited",
      securityId: "security-exited",
      symbol: "EXIT",
      name: "Exited Co",
      exchange: "ASX",
      currencyCode: "AUD",
      quantity: "0",
      averageNativeCost: null,
      nativeBasis: holdingValue("unavailable", "AUD", null, "missing_basis"),
      homeBasis: holdingValue("unavailable", "AUD", null, "missing_basis"),
      nativePrice: null,
      nativeValue: holdingValue("unavailable", "AUD", null, "missing_price"),
      homePrice: holdingValue("unavailable", "AUD", null, "missing_price"),
      homeValue: holdingValue("unavailable", "AUD", null, "missing_price"),
      dailyMovement: holdingValue("unavailable", "AUD", null, "missing_previous"),
      dailyPercent: holdingValue("unavailable", "AUD", null, "missing_previous"),
      unrealisedGain: holdingValue("unavailable", "AUD", null, "missing_price"),
      unrealisedPercent: holdingValue("unavailable", "AUD", null, "missing_price"),
      dailyTone: "neutral",
      gainTone: "neutral",
      priceState: "unavailable",
      actionStatus: "none",
      explanation: "Fixture explanation for the exited holding.",
      sort: { ticker: "EXIT", value: null, daily: null, gain: null },
    };

    // A currently-held, NEVER-sold holding -- no realisedGains entry at all.
    const neverSold = {
      ...exited,
      id: "row-never-sold",
      securityId: "security-never-sold",
      symbol: "HOLD",
      name: "Holding Co",
      quantity: "10",
      nativePrice: "10.00",
      nativeValue: holdingValue("available", "AUD", "100.00"),
      homePrice: holdingValue("available", "AUD", "10.00"),
      homeValue: holdingValue("available", "AUD", "100.00"),
      homeBasis: holdingValue("available", "AUD", "90.00"),
      nativeBasis: holdingValue("available", "AUD", "90.00"),
      averageNativeCost: "9.00",
      dailyMovement: holdingValue("available", "AUD", "1.00"),
      dailyPercent: holdingValue("available", "AUD", "1.0"),
      unrealisedGain: holdingValue("available", "AUD", "10.00"),
      unrealisedPercent: holdingValue("available", "AUD", "11.11"),
      dailyTone: "positive",
      gainTone: "positive",
      priceState: "current",
      sort: { ticker: "HOLD", value: "100.00", daily: "1.0", gain: "11.11" },
    };

    const ownedWorkspace = {
      status: "ready",
      userDisplayName: "Fixture Owner",
      homeCurrencyCode: "AUD",
      holdingCurrencyView: "native",
      settingsVersion: 1,
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: "AUD",
        baseCurrencyCode: "AUD",
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        {
          id: "portfolio-a",
          name: "Fixture Portfolio",
          homeCurrencyCode: "AUD",
          status: "active",
          version: 1,
        },
      ],
      holdings: [exited, neverSold],
      holdingsViewState: "complete",
      // ONLY the exited row has an entry -- neverSold is deliberately
      // absent, proving the "no entry at all" (never-sold) path renders no
      // fourth line even though realisedGains itself is populated for the
      // request.
      realisedGains: {
        "row-exited": {
          portfolioSecurityId: "row-exited",
          disposalCount: 1,
          knownDisposalCount: 1,
          excludedIncompleteCount: 0,
          partialCoverage: false,
          gainDecimal: "5000",
          basisAtDisposalDecimal: "40000",
          percentDecimal: "12.5",
        },
      },
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "holdings",
            ownedWorkspace,
          }),
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

// Extracts one holding row's own <a class="holding-row ...">...</a> markup
// by its detail-route id, so an assertion can be scoped to exactly that
// row rather than the whole page (two rows render side by side).
function extractHoldingRowHtml(html: string, rowId: string): string {
  const marker = `/portfolio/portfolio-a/holdings/${rowId}"`;
  const markerIndex = html.indexOf(marker);
  assert.ok(markerIndex !== -1, `expected a link to holding row ${rowId}`);
  const anchorStart = html.lastIndexOf("<a ", markerIndex);
  const anchorEnd = html.indexOf("</a>", markerIndex) + "</a>".length;
  return html.slice(anchorStart, anchorEnd);
}

test("UI-030 render (fold, reviewer follow-up 3): OwnedHoldingsScreen actually renders the fourth line from a real realisedGains prop -- present (owner shape) on the exited/zero-quantity row it belongs to, absent on a never-sold row even though realisedGains is populated for the request", () => {
  const html = renderOwnedHoldingsWithRealisedGains();

  const exitedRowHtml = extractHoldingRowHtml(html, "row-exited");
  assert.match(exitedRowHtml, /class="[^"]*row-quaternary[^"]*"/);
  assert.match(exitedRowHtml, /Realised:\s*\+\$5,000\.00\s*\(\+12\.5%\)/);

  const neverSoldRowHtml = extractHoldingRowHtml(html, "row-never-sold");
  assert.doesNotMatch(neverSoldRowHtml, /row-quaternary/);
  assert.doesNotMatch(neverSoldRowHtml, /Realised:/);
});
