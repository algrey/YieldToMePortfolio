import {
  addDecimal,
  formatDecimalTrimmed,
  fromInteger,
  parseDecimal,
  type DecimalFraction,
} from "../../domain/calculations/decimal.ts";
import type { SqlClient } from "./sql-client.ts";

const MAX_INSPECTION_ROWS = 200;

export type PortfolioInspectionTransaction = Readonly<{
  id: string;
  type: string;
  status: string;
  businessDate: string;
  tradeAt: string;
  settlementDate: string | null;
  securityId: string | null;
  securityLabel: string | null;
  quantityDecimal: string | null;
  unitPriceDecimal: string | null;
  currencyCode: string;
  grossAmountDecimal: string | null;
  feeAmountDecimal: string;
  taxAmountDecimal: string;
  fxRateToBaseDecimal: string | null;
  fxRateSource: string | null;
  fxObservedAt: string | null;
  sourceType: string;
  sourceReference: string | null;
  reversesTransactionId: string | null;
  supersedesTransactionId: string | null;
  calculationVersion: number;
}>;

export type PortfolioInspectionLot = Readonly<{
  id: string;
  securityId: string;
  securityLabel: string;
  openingTransactionId: string;
  acquiredAt: string;
  originalQuantityDecimal: string;
  openQuantityDecimal: string;
  nativeBasisDecimal: string | null;
  baseBasisDecimal: string | null;
  basisStatus: string;
  status: string;
  calculationVersion: number;
  rebuiltAt: string;
}>;

export type PortfolioInspectionLotAllocation = Readonly<{
  id: string;
  sellTransactionId: string;
  taxLotId: string;
  allocationSequence: number;
  matchedQuantityDecimal: string;
  allocatedBaseBasisDecimal: string | null;
  baseNetProceedsDecimal: string | null;
  baseRealisedGainDecimal: string | null;
  basisStatus: string;
  calculationVersion: number;
}>;

export type PortfolioInspectionCashAccount = Readonly<{
  id: string;
  currencyCode: string;
  completeness: string;
  status: string;
  balanceDecimal: string | null;
  balanceStatus: "complete" | "window_incomplete" | "invalid_decimal";
}>;

export type PortfolioInspectionCashEntry = Readonly<{
  id: string;
  cashAccountId: string;
  currencyCode: string;
  transactionId: string | null;
  effectiveAt: string;
  businessDate: string;
  type: string;
  signedAmountDecimal: string;
  status: string;
  reversesEntryId: string | null;
}>;

export type PortfolioInspection = Readonly<{
  portfolio: Readonly<{
    id: string;
    code: string;
    name: string;
    homeCurrencyCode: string;
    baseCurrencyCode: string;
    timezone: string;
    accountingMethod: string;
    status: string;
    version: number;
  }>;
  settings: Readonly<{
    homeCurrencyCode: string;
    timezone: string;
    defaultHoldingCurrencyView: "native" | "home";
    version: number;
  }> | null;
  transactions: readonly PortfolioInspectionTransaction[];
  lots: readonly PortfolioInspectionLot[];
  allocations: readonly PortfolioInspectionLotAllocation[];
  cashAccounts: readonly PortfolioInspectionCashAccount[];
  cashEntries: readonly PortfolioInspectionCashEntry[];
  truncated: Readonly<{
    transactions: boolean;
    lots: boolean;
    allocations: boolean;
    cashEntries: boolean;
  }>;
}>;

function decimalScale(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

function exactSum(values: readonly string[]): string | null {
  let total: DecimalFraction = fromInteger(0n);
  let scale = 0;
  try {
    for (const value of values) {
      scale = Math.max(scale, decimalScale(value));
      total = addDecimal(total, parseDecimal(value));
    }
    return formatDecimalTrimmed(total, scale);
  } catch {
    return null;
  }
}

function mapTransaction(
  row: Record<string, unknown>,
): PortfolioInspectionTransaction {
  return {
    id: String(row.id),
    type: String(row.type),
    status: String(row.status),
    businessDate: String(row.local_trade_date),
    tradeAt: String(row.trade_at),
    settlementDate:
      row.settlement_date === null ? null : String(row.settlement_date),
    securityId:
      row.portfolio_security_id === null
        ? null
        : String(row.portfolio_security_id),
    securityLabel:
      row.security_label === null ? null : String(row.security_label),
    quantityDecimal:
      row.quantity_decimal === null ? null : String(row.quantity_decimal),
    unitPriceDecimal:
      row.unit_price_decimal === null ? null : String(row.unit_price_decimal),
    currencyCode: String(row.currency_code),
    grossAmountDecimal:
      row.gross_amount_decimal === null
        ? null
        : String(row.gross_amount_decimal),
    feeAmountDecimal: String(row.fee_amount_decimal),
    taxAmountDecimal: String(row.tax_amount_decimal),
    fxRateToBaseDecimal:
      row.fx_rate_to_base_decimal === null
        ? null
        : String(row.fx_rate_to_base_decimal),
    fxRateSource:
      row.fx_rate_source === null ? null : String(row.fx_rate_source),
    fxObservedAt:
      row.fx_observed_at === null ? null : String(row.fx_observed_at),
    sourceType: String(row.source_type),
    sourceReference:
      row.source_reference === null ? null : String(row.source_reference),
    reversesTransactionId:
      row.reverses_transaction_id === null
        ? null
        : String(row.reverses_transaction_id),
    supersedesTransactionId:
      row.supersedes_transaction_id === null
        ? null
        : String(row.supersedes_transaction_id),
    calculationVersion: Number(row.calculation_version),
  };
}

export async function loadOwnedPortfolioInspection(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<PortfolioInspection | null> {
  const portfolio = await client.get<Record<string, unknown>>(
    `SELECT p.id, p.code, p.name, p.base_currency_code, p.timezone,
            p.accounting_method, p.status, p.version,
            us.home_currency_code,
            us.default_holding_currency_view, us.version AS settings_version
       FROM portfolios p
       LEFT JOIN user_settings us ON us.user_id = p.user_id
      WHERE p.id = ? AND p.user_id = ?
      LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) return null;

  const [
    rawTransactionRows,
    rawLotRows,
    rawAllocationRows,
    accountRows,
    rawCashRows,
  ] = await Promise.all([
    client.all<Record<string, unknown>>(
      `SELECT t.id, t.type, t.status, t.local_trade_date, t.trade_at,
                t.settlement_date, t.portfolio_security_id,
                COALESCE(ps.display_symbol, ps.source_symbol, s.canonical_name)
                  AS security_label,
                t.quantity_decimal, t.unit_price_decimal, t.currency_code,
                t.gross_amount_decimal, t.fee_amount_decimal,
                t.tax_amount_decimal, t.fx_rate_to_base_decimal,
                t.fx_rate_source, t.fx_observed_at, t.source_type,
                t.source_reference, t.reverses_transaction_id,
                t.supersedes_transaction_id, t.calculation_version
           FROM transactions t
           LEFT JOIN portfolio_securities ps
             ON ps.id = t.portfolio_security_id
            AND ps.user_id = t.user_id
            AND ps.portfolio_id = t.portfolio_id
           LEFT JOIN securities s ON s.id = ps.security_id
          WHERE t.user_id = ? AND t.portfolio_id = ?
          ORDER BY t.local_trade_date DESC, t.trade_at DESC, t.id DESC
          LIMIT ?`,
      [userId, portfolioId, MAX_INSPECTION_ROWS + 1],
    ),
    client.all<Record<string, unknown>>(
      `SELECT l.id, l.portfolio_security_id, l.opening_transaction_id,
                l.acquired_at, l.original_quantity_decimal,
                l.open_quantity_decimal, l.native_basis_decimal,
                l.base_basis_decimal, l.basis_status, l.status,
                l.calculation_version, l.rebuilt_at,
                COALESCE(ps.display_symbol, ps.source_symbol, s.canonical_name)
                  AS security_label
           FROM tax_lots l
           JOIN portfolio_securities ps
             ON ps.id = l.portfolio_security_id
            AND ps.user_id = l.user_id
            AND ps.portfolio_id = l.portfolio_id
           LEFT JOIN securities s ON s.id = ps.security_id
          WHERE l.user_id = ? AND l.portfolio_id = ?
          ORDER BY l.acquired_at DESC, l.id DESC
          LIMIT ?`,
      [userId, portfolioId, MAX_INSPECTION_ROWS + 1],
    ),
    client.all<Record<string, unknown>>(
      `SELECT id, sell_transaction_id, tax_lot_id, allocation_sequence,
                matched_quantity_decimal, allocated_base_basis_decimal,
                base_net_proceeds_decimal, base_realised_gain_decimal,
                basis_status, calculation_version
           FROM lot_allocations
          WHERE user_id = ? AND portfolio_id = ?
          ORDER BY sell_transaction_id DESC, allocation_sequence ASC
          LIMIT ?`,
      [userId, portfolioId, MAX_INSPECTION_ROWS + 1],
    ),
    client.all<Record<string, unknown>>(
      `SELECT id, currency_code, completeness, status
           FROM cash_accounts
          WHERE user_id = ? AND portfolio_id = ?
          ORDER BY currency_code, id
          LIMIT ?`,
      [userId, portfolioId, MAX_INSPECTION_ROWS],
    ),
    client.all<Record<string, unknown>>(
      `SELECT e.id, e.cash_account_id, ca.currency_code, e.transaction_id,
                e.effective_at, e.local_effective_date, e.type,
                e.signed_amount_decimal, e.status, e.reverses_entry_id
           FROM cash_ledger_entries e
           JOIN cash_accounts ca
             ON ca.id = e.cash_account_id
            AND ca.user_id = e.user_id
            AND ca.portfolio_id = e.portfolio_id
          WHERE e.user_id = ? AND e.portfolio_id = ?
          ORDER BY e.local_effective_date DESC, e.effective_at DESC, e.id DESC
          LIMIT ?`,
      [userId, portfolioId, MAX_INSPECTION_ROWS + 1],
    ),
  ]);

  const transactionRowsTruncated =
    rawTransactionRows.length > MAX_INSPECTION_ROWS;
  const lotRowsTruncated = rawLotRows.length > MAX_INSPECTION_ROWS;
  const allocationRowsTruncated =
    rawAllocationRows.length > MAX_INSPECTION_ROWS;
  const cashRowsTruncated = rawCashRows.length > MAX_INSPECTION_ROWS;
  const transactionRows = rawTransactionRows.slice(0, MAX_INSPECTION_ROWS);
  const lotRows = rawLotRows.slice(0, MAX_INSPECTION_ROWS);
  const allocationRows = rawAllocationRows.slice(0, MAX_INSPECTION_ROWS);
  const cashRows = rawCashRows.slice(0, MAX_INSPECTION_ROWS);
  const cashEntries = cashRows.map((row) => ({
    id: String(row.id),
    cashAccountId: String(row.cash_account_id),
    currencyCode: String(row.currency_code),
    transactionId:
      row.transaction_id === null ? null : String(row.transaction_id),
    effectiveAt: String(row.effective_at),
    businessDate: String(row.local_effective_date),
    type: String(row.type),
    signedAmountDecimal: String(row.signed_amount_decimal),
    status: String(row.status),
    reversesEntryId:
      row.reverses_entry_id === null ? null : String(row.reverses_entry_id),
  }));

  const balances = new Map<string, string[]>();
  for (const entry of cashEntries) {
    if (entry.status !== "posted") continue;
    const values = balances.get(entry.cashAccountId) ?? [];
    values.push(entry.signedAmountDecimal);
    balances.set(entry.cashAccountId, values);
  }

  return {
    portfolio: {
      id: String(portfolio.id),
      code: String(portfolio.code),
      name: String(portfolio.name),
      homeCurrencyCode:
        portfolio.home_currency_code === null
          ? String(portfolio.base_currency_code)
          : String(portfolio.home_currency_code),
      baseCurrencyCode: String(portfolio.base_currency_code),
      timezone: String(portfolio.timezone),
      accountingMethod: String(portfolio.accounting_method),
      status: String(portfolio.status),
      version: Number(portfolio.version),
    },
    settings:
      portfolio.home_currency_code === null ||
      portfolio.default_holding_currency_view === null
        ? null
        : {
            homeCurrencyCode: String(portfolio.home_currency_code),
            timezone: String(portfolio.timezone),
            defaultHoldingCurrencyView: String(
              portfolio.default_holding_currency_view,
            ) as "native" | "home",
            version: Number(portfolio.settings_version),
          },
    transactions: transactionRows.map(mapTransaction),
    lots: lotRows.map((row) => ({
      id: String(row.id),
      securityId: String(row.portfolio_security_id),
      securityLabel: String(row.security_label),
      openingTransactionId: String(row.opening_transaction_id),
      acquiredAt: String(row.acquired_at),
      originalQuantityDecimal: String(row.original_quantity_decimal),
      openQuantityDecimal: String(row.open_quantity_decimal),
      nativeBasisDecimal:
        row.native_basis_decimal === null
          ? null
          : String(row.native_basis_decimal),
      baseBasisDecimal:
        row.base_basis_decimal === null ? null : String(row.base_basis_decimal),
      basisStatus: String(row.basis_status),
      status: String(row.status),
      calculationVersion: Number(row.calculation_version),
      rebuiltAt: String(row.rebuilt_at),
    })),
    allocations: allocationRows.map((row) => ({
      id: String(row.id),
      sellTransactionId: String(row.sell_transaction_id),
      taxLotId: String(row.tax_lot_id),
      allocationSequence: Number(row.allocation_sequence),
      matchedQuantityDecimal: String(row.matched_quantity_decimal),
      allocatedBaseBasisDecimal:
        row.allocated_base_basis_decimal === null
          ? null
          : String(row.allocated_base_basis_decimal),
      baseNetProceedsDecimal:
        row.base_net_proceeds_decimal === null
          ? null
          : String(row.base_net_proceeds_decimal),
      baseRealisedGainDecimal:
        row.base_realised_gain_decimal === null
          ? null
          : String(row.base_realised_gain_decimal),
      basisStatus: String(row.basis_status),
      calculationVersion: Number(row.calculation_version),
    })),
    cashAccounts: accountRows.map((row) => {
      const balanceDecimal = cashRowsTruncated
        ? null
        : exactSum(balances.get(String(row.id)) ?? []);
      return {
        id: String(row.id),
        currencyCode: String(row.currency_code),
        completeness: String(row.completeness),
        status: String(row.status),
        balanceDecimal,
        balanceStatus: cashRowsTruncated
          ? ("window_incomplete" as const)
          : balanceDecimal === null
            ? ("invalid_decimal" as const)
            : ("complete" as const),
      };
    }),
    cashEntries,
    truncated: {
      transactions: transactionRowsTruncated,
      lots: lotRowsTruncated,
      allocations: allocationRowsTruncated,
      cashEntries: cashRowsTruncated,
    },
  };
}

export async function loadPortfolioInspectionSafely(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<PortfolioInspection | null> {
  try {
    return await loadOwnedPortfolioInspection(client, userId, portfolioId);
  } catch {
    return null;
  }
}
