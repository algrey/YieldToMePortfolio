// CGT-001A: owner-scoped read service composing the ledger's published
// projection tables (`tax_lots`, `lot_allocations`, DB-004/LED-002B) into
// the pure `domain/gains` per-disposal/per-FY calculations. Mirrors
// `app/owned-holdings.ts`'s (holdings) and `app/owned-dividend-history.ts`'s
// (dividends) composition pattern: this module owns SqlClient access and
// owner-scope predicates; every actual eligibility/aggregation rule lives
// in the pure `domain/gains` modules this file only composes. Read-only --
// no routes/UI (CGT-001B consumes this later).
//
// Publication-pointer discipline (identical requirement to
// `app/owned-holdings.ts`): `lot_allocations`/`tax_lots` are written by
// EVERY calculation run attempt, including superseded/stale ones -- only
// the run referenced by the single current `projection_publications` row
// for this portfolio is the CURRENT, trustworthy one. This module reads
// allocations WHERE calculation_run_id = <the published run id> exactly
// like holdings reads `holding_projections` the same way, so a stale or
// partially-completed run's rows are structurally invisible (never even
// selected), not filtered out after the fact.
//
// Empty-state short-circuit: a portfolio that has never posted an active
// (non-reversed) 'sell' transaction cannot have any `lot_allocations` rows
// regardless of whether a calculation run/publication exists yet (a
// brand-new portfolio has neither) -- this returns the ordinary empty
// "no disposals yet" state without requiring a publication, mirroring
// `loadOwnedHoldings`'s zero-held-securities short-circuit. Once an active
// sell exists, a valid current publication is REQUIRED (same checks as
// holdings); its absence is a typed failure (calculation not yet
// published), not a silent empty result -- a real disposal must never
// silently read as "no disposals yet".
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios.ts";
import { currentFyWindow } from "../domain/calculations/financial-year.ts";
import { parseDecimalResult } from "../domain/calculations/decimal.ts";
import {
  computeFyCapitalGainsTotals,
  deriveCapitalGainDisposalRow,
  type CapitalGainAllocationFact,
  type CapitalGainDisposalRow,
  type FyCapitalGainsTotal,
} from "../domain/gains/index.ts";

const MAX_ALLOCATIONS = 10_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Matches `app/owned-holdings.ts`'s own `DECIMAL` boundary pattern exactly.
// Quantity/basis/proceeds/fee/tax are never negative in the ledger's model;
// `base_realised_gain_decimal` alone can be a loss, so it gets the signed
// variant.
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

type Row = Record<string, unknown>;

export type OwnedCapitalGainsHistory = {
  today: string;
  financialYearStartMonth: number;
  baseCurrencyCode: string;
  disposalCount: number;
  /** Sorted newest-FY-first, mirroring `app/owned-dividend-history.ts`. Empty when there have been no disposals at all. */
  fyTotals: FyCapitalGainsTotal[];
};

function field(row: Row, key: string): unknown {
  return row[key];
}
function requiredText(row: Row, key: string, pattern?: RegExp): string {
  const value = field(row, key);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern && !pattern.test(value))
  )
    throw new Error(`invalid_${key}`);
  return value;
}
function optionalText(row: Row, key: string, pattern?: RegExp): string | null {
  const value = field(row, key);
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || (pattern && !pattern.test(value)))
    throw new Error(`invalid_${key}`);
  return value;
}
function integer(row: Row, key: string): number {
  const value = field(row, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid_${key}`);
  return value;
}
// Reviewer fix (round 2): validate money-shaped columns at the SQL
// boundary, mirroring `app/owned-holdings.ts`'s `sourceDecimal`/
// `resultDecimal` -- a typed `invalid_<key>` failure here, not an
// `optionalText` pass-through that only surfaces as an opaque
// "Invalid decimal string." once `domain/gains` tries to parse it
// downstream.
function requiredDecimal(row: Row, key: string): string {
  const value = requiredText(row, key, UNSIGNED_DECIMAL);
  parseDecimalResult(value);
  return value;
}
function optionalDecimal(
  row: Row,
  key: string,
  pattern: RegExp,
): string | null {
  const value = optionalText(row, key, pattern);
  if (value === null) return null;
  parseDecimalResult(value);
  return value;
}
function basisStatusValue(row: Row): CapitalGainAllocationFact["basisStatus"] {
  const value = requiredText(row, "basis_status");
  if (
    value !== "complete" &&
    value !== "incomplete_fx" &&
    value !== "incomplete_basis"
  )
    throw new Error("invalid_basis_status");
  return value;
}

export async function loadOwnedCapitalGains(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<OwnedCapitalGainsHistory> {
  const portfolio = await client.get<Row>(
    `SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) throw new Error("not_owned");
  const baseCurrencyCode = requiredText(portfolio, "base_currency_code");

  const settings = await createOwnedUserSettingsRepository(client).get(userId);
  if (!settings) throw new Error("missing_user_settings");
  const currentWindow = currentFyWindow(
    now.toISOString(),
    settings.financialYearStartMonth,
    settings.timezone,
  );
  if (!currentWindow.ok)
    throw new Error(`invalid_fy_window:${currentWindow.reason}`);
  const today = currentWindow.window.endDate;

  const activeSellCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM transactions t
     WHERE t.user_id = ? AND t.portfolio_id = ? AND t.type = 'sell'
       AND t.status IN ('posted', 'reversed') AND t.reverses_transaction_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM transactions r
         WHERE r.user_id = t.user_id AND r.portfolio_id = t.portfolio_id
           AND r.reverses_transaction_id = t.id AND r.status IN ('posted', 'reversed')
       )`,
    [userId, portfolioId],
  );
  const activeSellCount = integer(activeSellCountRow ?? {}, "count");
  if (activeSellCount === 0) {
    return {
      today,
      financialYearStartMonth: settings.financialYearStartMonth,
      baseCurrencyCode,
      disposalCount: 0,
      fyTotals: [],
    };
  }

  const publicationCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM projection_publications pp WHERE pp.user_id = ? AND pp.portfolio_id = ?`,
    [userId, portfolioId],
  );
  if (integer(publicationCountRow ?? {}, "count") !== 1)
    throw new Error("invalid_projection_publication_count");
  const publication = await client.get<Row>(
    `SELECT pp.calculation_run_id, pp.calculation_version, pp.ledger_high_water,
            r.status AS run_status, r.calculation_version AS run_version,
            r.ledger_high_water_end
     FROM projection_publications pp
     JOIN calculation_runs r
       ON r.id = pp.calculation_run_id AND r.user_id = pp.user_id AND r.portfolio_id = pp.portfolio_id
     WHERE pp.user_id = ? AND pp.portfolio_id = ? LIMIT 1`,
    [userId, portfolioId],
  );
  if (!publication) throw new Error("missing_projection_publication");
  const runId = requiredText(publication, "calculation_run_id");
  const version = integer(publication, "calculation_version");
  if (
    requiredText(publication, "run_status") !== "completed" ||
    integer(publication, "run_version") !== version ||
    requiredText(publication, "ledger_high_water") !==
      requiredText(publication, "ledger_high_water_end")
  )
    throw new Error("invalid_projection_publication");

  const allocationCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM lot_allocations
     WHERE user_id = ? AND portfolio_id = ? AND calculation_run_id = ?`,
    [userId, portfolioId, runId],
  );
  const allocationCount = integer(allocationCountRow ?? {}, "count");
  if (allocationCount > MAX_ALLOCATIONS)
    throw new Error("too_many_allocations");

  const allocationRows = await client.all<Row>(
    `SELECT la.id AS allocation_id, la.portfolio_security_id,
            la.matched_quantity_decimal, la.allocated_base_basis_decimal,
            la.base_net_proceeds_decimal, la.fee_base_decimal,
            la.tax_base_decimal, la.base_realised_gain_decimal, la.basis_status,
            opening.local_trade_date AS acquired_date,
            sell.local_trade_date AS disposed_date,
            COALESCE(ps.display_symbol, ps.source_symbol) AS symbol,
            COALESCE(ps.display_name, s.canonical_name, ps.source_name, ps.source_symbol) AS name
     FROM lot_allocations la
     JOIN tax_lots tl
       ON tl.id = la.tax_lot_id AND tl.user_id = la.user_id
      AND tl.portfolio_id = la.portfolio_id AND tl.portfolio_security_id = la.portfolio_security_id
      AND tl.calculation_run_id = la.calculation_run_id
     JOIN transactions opening
       ON opening.id = tl.opening_transaction_id AND opening.user_id = la.user_id
      AND opening.portfolio_id = la.portfolio_id
     JOIN transactions sell
       ON sell.id = la.sell_transaction_id AND sell.user_id = la.user_id
      AND sell.portfolio_id = la.portfolio_id
     JOIN portfolio_securities ps
       ON ps.id = la.portfolio_security_id AND ps.user_id = la.user_id AND ps.portfolio_id = la.portfolio_id
     LEFT JOIN securities s ON s.id = ps.security_id
     WHERE la.user_id = ? AND la.portfolio_id = ? AND la.calculation_run_id = ?
     ORDER BY sell.local_trade_date, la.sell_transaction_id, la.allocation_sequence
     LIMIT ?`,
    [userId, portfolioId, runId, MAX_ALLOCATIONS + 1],
  );
  if (allocationRows.length > MAX_ALLOCATIONS)
    throw new Error("too_many_allocations");
  // Every JOIN above is a hard requirement (a lot allocation's acquisition
  // and disposal dates must always be resolvable via its tax lot's opening
  // transaction and its own sell transaction) -- if the joined row count
  // does not match the allocation count for this run, some allocation's
  // dates are unavailable. That "shouldn't happen" per CGT-001A's ruling,
  // so this fails typed/closed rather than silently under-reporting
  // disposals.
  if (allocationRows.length !== allocationCount)
    throw new Error("missing_allocation_dates");

  const facts: CapitalGainAllocationFact[] = allocationRows.map((row) => ({
    allocationId: requiredText(row, "allocation_id"),
    portfolioSecurityId: requiredText(row, "portfolio_security_id"),
    securitySymbol: requiredText(row, "symbol"),
    securityName: requiredText(row, "name"),
    acquiredDate: requiredText(row, "acquired_date", DATE),
    disposedDate: requiredText(row, "disposed_date", DATE),
    matchedQuantityDecimal: requiredDecimal(row, "matched_quantity_decimal"),
    allocatedBaseBasisDecimal: optionalDecimal(
      row,
      "allocated_base_basis_decimal",
      UNSIGNED_DECIMAL,
    ),
    baseNetProceedsDecimal: optionalDecimal(
      row,
      "base_net_proceeds_decimal",
      UNSIGNED_DECIMAL,
    ),
    feeBaseDecimal: optionalDecimal(row, "fee_base_decimal", UNSIGNED_DECIMAL),
    taxBaseDecimal: optionalDecimal(row, "tax_base_decimal", UNSIGNED_DECIMAL),
    baseRealisedGainDecimal: optionalDecimal(
      row,
      "base_realised_gain_decimal",
      SIGNED_DECIMAL,
    ),
    basisStatus: basisStatusValue(row),
  }));

  const rows: CapitalGainDisposalRow[] = facts.map((fact) => {
    const result = deriveCapitalGainDisposalRow(fact);
    if (!result.ok)
      throw new Error(`invalid_allocation_dates:${result.reason}`);
    return result.row;
  });

  const fyResult = computeFyCapitalGainsTotals(
    rows,
    settings.financialYearStartMonth,
  );
  if (!fyResult.ok)
    throw new Error(`invalid_fy_aggregation:${fyResult.reason}`);

  return {
    today,
    financialYearStartMonth: settings.financialYearStartMonth,
    baseCurrencyCode,
    disposalCount: rows.length,
    fyTotals: fyResult.totals,
  };
}
