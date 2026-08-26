// EXP-001: owner-scoped DB reads/writes for the single-portfolio export/
// import bundle. Every query below is scoped by `user_id` AND
// `portfolio_id` (AGENTS.md: "constrain every portfolio-scoped query by
// authenticated internal user_id; never trust a client-supplied owner
// ID") -- `portfolioId` here always comes from `getAuthenticatedSqlContext`,
// which already verified ownership before this module runs.
import type { PortfolioBundleV1 } from "../../domain/exports/portfolio-bundle.ts";
import type { SqlClient } from "./sql-client.ts";

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return String(row[key]);
}
function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

/**
 * Reads every included owner-scoped fact for one portfolio and assembles
 * `PortfolioBundleV1`. Read-only -- see `docs/BACKUP_FORMAT.md` for the
 * full owned-table classification (included / excluded-derived /
 * excluded-price / excluded-other).
 */
export async function readPortfolioBundle(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  exportedAt: string,
): Promise<PortfolioBundleV1> {
  const portfolioRow = await client.get<Row>(
    `SELECT p.name, p.code, p.base_currency_code, p.timezone,
            p.accounting_method, p.history_complete_from,
            us.financial_year_start_month, ps.quote_staleness_policy
     FROM portfolios p
     JOIN user_settings us ON us.user_id = p.user_id
     LEFT JOIN portfolio_settings ps ON ps.portfolio_id = p.id AND ps.user_id = p.user_id
     WHERE p.id = ? AND p.user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolioRow) throw new Error("Portfolio not found for bundle export.");

  // Every `portfolio_securities` row this owner has for this portfolio --
  // not just currently-`held` ones, so a fully-sold-out security's history
  // (transactions/dividends referencing it) still resolves on import.
  const securityRows = await client.all<Row>(
    `SELECT ps.id AS portfolio_security_id, ps.source_symbol, ps.source_exchange_alias,
            ps.source_currency_code, ps.source_name, ps.display_symbol, ps.display_name,
            ps.status, ps.first_relevant_date, ps.last_relevant_date,
            s.canonical_name, s.primary_currency_code,
            (SELECT si.value FROM security_identifiers si
              WHERE si.security_id = ps.security_id AND si.scheme = 'ticker'
                AND si.valid_to IS NULL LIMIT 1) AS ticker_identifier,
            (SELECT si.value FROM security_identifiers si
              WHERE si.security_id = ps.security_id AND si.scheme = 'isin'
                AND si.valid_to IS NULL LIMIT 1) AS isin_identifier,
            (SELECT si.value FROM security_identifiers si
              WHERE si.security_id = ps.security_id AND si.scheme = 'sharesight_instrument'
                AND si.valid_to IS NULL LIMIT 1) AS sharesight_instrument_id
     FROM portfolio_securities ps
     LEFT JOIN securities s ON s.id = ps.security_id
     WHERE ps.user_id = ? AND ps.portfolio_id = ?
     ORDER BY ps.created_at ASC, ps.id ASC`,
    [userId, portfolioId],
  );
  const securityRefById = new Map<string, string>();
  const securities = securityRows.map((row) => {
    const portfolioSecurityId = str(row, "portfolio_security_id");
    securityRefById.set(portfolioSecurityId, portfolioSecurityId);
    return {
      ref: portfolioSecurityId,
      sourceSymbol: str(row, "source_symbol"),
      sourceExchangeAlias: strOrNull(row, "source_exchange_alias"),
      sourceCurrencyCode: str(row, "source_currency_code"),
      sourceName: strOrNull(row, "source_name"),
      displaySymbol: strOrNull(row, "display_symbol"),
      displayName: strOrNull(row, "display_name"),
      status: str(row, "status") as "held" | "watch" | "hidden" | "unresolved",
      firstRelevantDate: strOrNull(row, "first_relevant_date"),
      lastRelevantDate: strOrNull(row, "last_relevant_date"),
      canonicalName: strOrNull(row, "canonical_name"),
      primaryCurrencyCode: strOrNull(row, "primary_currency_code"),
      tickerIdentifier: strOrNull(row, "ticker_identifier"),
      isinIdentifier: strOrNull(row, "isin_identifier"),
      sharesightInstrumentId: strOrNull(row, "sharesight_instrument_id"),
    };
  });

  const txRows = await client.all<Row>(
    `SELECT id, portfolio_security_id, type, status, trade_at, local_trade_date,
            settlement_date, quantity_decimal, unit_price_decimal, currency_code,
            gross_amount_decimal, fee_amount_decimal, tax_amount_decimal,
            fx_rate_to_base_decimal, fx_rate_source, fx_observed_at, source_type,
            source_reference, created_at, reverses_transaction_id, supersedes_transaction_id
     FROM transactions
     WHERE user_id = ? AND portfolio_id = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, portfolioId],
  );
  const transactions = txRows.map((row) => ({
    ref: str(row, "id"),
    securityRef: strOrNull(row, "portfolio_security_id"),
    type: str(row, "type"),
    status: str(row, "status") as "posted" | "reversed" | "superseded",
    tradeAt: str(row, "trade_at"),
    localTradeDate: str(row, "local_trade_date"),
    settlementDate: strOrNull(row, "settlement_date"),
    quantityDecimal: strOrNull(row, "quantity_decimal"),
    unitPriceDecimal: strOrNull(row, "unit_price_decimal"),
    currencyCode: str(row, "currency_code"),
    grossAmountDecimal: strOrNull(row, "gross_amount_decimal"),
    feeAmountDecimal: str(row, "fee_amount_decimal"),
    taxAmountDecimal: str(row, "tax_amount_decimal"),
    fxRateToBaseDecimal: strOrNull(row, "fx_rate_to_base_decimal"),
    fxRateSource: strOrNull(row, "fx_rate_source"),
    fxObservedAt: strOrNull(row, "fx_observed_at"),
    sourceType: str(row, "source_type"),
    sourceReference: strOrNull(row, "source_reference"),
    createdAt: str(row, "created_at"),
    reversesRef: strOrNull(row, "reverses_transaction_id"),
    supersedesRef: strOrNull(row, "supersedes_transaction_id"),
  }));

  const divRows = await client.all<Row>(
    `SELECT id, portfolio_security_id, payment_date, shares_decimal,
            dividend_per_share_decimal, franking_credit_per_share_decimal,
            total_cash_decimal, total_franking_decimal, currency_code,
            fx_rate_to_portfolio_decimal, fx_rate_source, import_batch_id,
            source_reference, created_at, superseded_by_record_id
     FROM dividend_manual_records
     WHERE user_id = ? AND portfolio_id = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, portfolioId],
  );
  // `supersededByRecordId` points FORWARD (old -> new); the bundle's own
  // `supersedesRef` points BACKWARD (new -> old, matching the ledger
  // transaction shape above) so both chains replay the same way on import
  // (see `docs/BACKUP_FORMAT.md`'s replay-order rule).
  //
  // B1 fix (reviewer, tombstone resurrection): DIV-016A's DELETE semantics
  // allow head-deleting a row, which can leave an ANCESTOR's own
  // `superseded_by_record_id` pointing at an id that no longer exists (a
  // "tombstone" -- the ancestor stays permanently excluded from evidence,
  // never resurrected). The pre-fix version only recorded a chain link when
  // the SUCCESSOR was itself present among `divRows`, so a tombstoned
  // ancestor exported with `supersedesRef: null` on every row and no
  // exported successor at all -- indistinguishable from a normal, live,
  // never-superseded row. It would then IMPORT as live, wrongly resurrecting
  // its income. `existingIds` distinguishes "points at a row this export
  // also contains" (a real chain link) from "points at a row that is gone"
  // (a tombstone, carried forward via `supersededByDeletedRecord`).
  const existingIds = new Set(divRows.map((row) => str(row, "id")));
  const supersedesByNewId = new Map<string, string>();
  const tombstonedIds = new Set<string>();
  for (const row of divRows) {
    const supersededBy = strOrNull(row, "superseded_by_record_id");
    if (!supersededBy) continue;
    if (existingIds.has(supersededBy)) {
      supersedesByNewId.set(supersededBy, str(row, "id"));
    } else {
      tombstonedIds.add(str(row, "id"));
    }
  }
  const dividendManualRecords = divRows.map((row) => ({
    ref: str(row, "id"),
    securityRef: str(row, "portfolio_security_id"),
    paymentDate: str(row, "payment_date"),
    sharesDecimal: strOrNull(row, "shares_decimal"),
    dividendPerShareDecimal: strOrNull(row, "dividend_per_share_decimal"),
    frankingCreditPerShareDecimal: strOrNull(
      row,
      "franking_credit_per_share_decimal",
    ),
    totalCashDecimal: strOrNull(row, "total_cash_decimal"),
    totalFrankingDecimal: strOrNull(row, "total_franking_decimal"),
    currencyCode: strOrNull(row, "currency_code"),
    fxRateToPortfolioDecimal: strOrNull(row, "fx_rate_to_portfolio_decimal"),
    fxRateSource: strOrNull(row, "fx_rate_source"),
    sourceReference: strOrNull(row, "source_reference"),
    wasImported: strOrNull(row, "import_batch_id") !== null,
    createdAt: str(row, "created_at"),
    supersedesRef: supersedesByNewId.get(str(row, "id")) ?? null,
    supersededByDeletedRecord: tombstonedIds.has(str(row, "id")),
  }));

  const assumptionRows = await client.all<Row>(
    `SELECT portfolio_security_id, dividend_yield_percent_decimal,
            franking_percent_decimal, dividend_growth_percent_decimal,
            force_assumption
     FROM dividend_security_assumptions
     WHERE user_id = ? AND portfolio_id = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, portfolioId],
  );
  const dividendSecurityAssumptions = assumptionRows.map((row) => ({
    securityRef: str(row, "portfolio_security_id"),
    dividendYieldPercentDecimal: strOrNull(
      row,
      "dividend_yield_percent_decimal",
    ),
    frankingPercentDecimal: strOrNull(row, "franking_percent_decimal"),
    dividendGrowthPercentDecimal: strOrNull(
      row,
      "dividend_growth_percent_decimal",
    ),
    forceAssumption:
      row.force_assumption === null || row.force_assumption === undefined
        ? null
        : Boolean(row.force_assumption),
  }));

  const portfolioAssumptionRow = await client.get<Row>(
    `SELECT value_growth_percent_decimal, portfolio_dividend_growth_percent_decimal
     FROM dividend_portfolio_assumptions WHERE user_id = ? AND portfolio_id = ? LIMIT 1`,
    [userId, portfolioId],
  );

  const fyOverrideRows = await client.all<Row>(
    `SELECT financial_year_ending_year, grossed_amount_decimal, franking_amount_decimal
     FROM dividend_fy_overrides WHERE user_id = ? AND portfolio_id = ?
     ORDER BY financial_year_ending_year ASC`,
    [userId, portfolioId],
  );
  const dividendFyOverrides = fyOverrideRows.map((row) => ({
    financialYearEndingYear: Number(row.financial_year_ending_year),
    grossedAmountDecimal: str(row, "grossed_amount_decimal"),
    frankingAmountDecimal: strOrNull(row, "franking_amount_decimal"),
  }));

  const eventOverrideRows = await client.all<Row>(
    `SELECT portfolio_security_id, dividend_event_id, shares_decimal,
            dividend_per_share_decimal, franking_credit_per_share_decimal, exclude
     FROM dividend_event_overrides WHERE user_id = ? AND portfolio_id = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, portfolioId],
  );
  const dividendEventOverrides = eventOverrideRows.map((row) => ({
    securityRef: str(row, "portfolio_security_id"),
    dividendEventId: str(row, "dividend_event_id"),
    sharesDecimal: strOrNull(row, "shares_decimal"),
    dividendPerShareDecimal: strOrNull(row, "dividend_per_share_decimal"),
    frankingCreditPerShareDecimal: strOrNull(
      row,
      "franking_credit_per_share_decimal",
    ),
    exclude: Boolean(row.exclude),
  }));

  const frankingOverrideRows = await client.all<Row>(
    `SELECT portfolio_security_id, dividend_manual_record_id, franking_total_decimal
     FROM dividend_import_franking_overrides WHERE user_id = ? AND portfolio_id = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, portfolioId],
  );
  const dividendImportFrankingOverrides = frankingOverrideRows.map((row) => ({
    securityRef: str(row, "portfolio_security_id"),
    dividendManualRecordRef: str(row, "dividend_manual_record_id"),
    frankingTotalDecimal: str(row, "franking_total_decimal"),
  }));

  const scenarioRows = await client.all<Row>(
    `SELECT name, capital_rows_json, reinvest_dividends, value_growth_percent_decimal,
            dividend_growth_percent_decimal, created_at
     FROM income_whatif_scenarios WHERE user_id = ? AND portfolio_id = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, portfolioId],
  );
  const whatifScenarios = scenarioRows.map((row) => ({
    name: str(row, "name"),
    capitalRowsJson: str(row, "capital_rows_json"),
    reinvestDividends: Boolean(row.reinvest_dividends),
    valueGrowthPercentDecimal: strOrNull(row, "value_growth_percent_decimal"),
    dividendGrowthPercentDecimal: strOrNull(
      row,
      "dividend_growth_percent_decimal",
    ),
    createdAt: str(row, "created_at"),
  }));

  return {
    schemaVersion: 1,
    exportedAt,
    portfolio: {
      name: str(portfolioRow, "name"),
      code: str(portfolioRow, "code"),
      baseCurrencyCode: str(portfolioRow, "base_currency_code"),
      timezone: str(portfolioRow, "timezone"),
      accountingMethod: str(portfolioRow, "accounting_method"),
      historyCompleteFrom: strOrNull(portfolioRow, "history_complete_from"),
      financialYearStartMonthAtExport: Number(
        portfolioRow.financial_year_start_month,
      ),
    },
    portfolioSettings: {
      quoteStalenessPolicy: strOrNull(portfolioRow, "quote_staleness_policy"),
    },
    securities,
    transactions,
    dividendManualRecords,
    dividendSecurityAssumptions,
    dividendPortfolioAssumption: portfolioAssumptionRow
      ? {
          valueGrowthPercentDecimal: strOrNull(
            portfolioAssumptionRow,
            "value_growth_percent_decimal",
          ),
          portfolioDividendGrowthPercentDecimal: strOrNull(
            portfolioAssumptionRow,
            "portfolio_dividend_growth_percent_decimal",
          ),
        }
      : null,
    dividendFyOverrides,
    dividendEventOverrides,
    dividendImportFrankingOverrides,
    whatifScenarios,
  };
}
