// UI-023: owner-scoped read service for one holding's Transactions tab
// (`/portfolio/:id/holdings/:portfolioSecurityId/transactions`). Read-only
// selection over the immutable ledger -- no derivation, no mutation.
//
// Identity is resolved from the database (portfolio_securities joined to
// securities/exchanges with the SAME COALESCE fallbacks
// `app/owned-holdings.ts` uses), NOT from the workspace holdings list: a
// fully exited holding stays `status = 'held'` at zero quantity forever
// (see `app/owned-security-dividends.ts`'s SOLD SHARES note) but may drop
// out of the published valuation, and its transaction history must remain
// reachable regardless.
import type { SqlClient } from "../db/repositories/sql-client.ts";

// Mirrors the bounded-read discipline of `portfolio-inspection.ts`
// (MAX_INSPECTION_ROWS) but sized for a single security's full history.
export const MAX_HOLDING_TRANSACTION_ROWS = 500;

export type OwnedHoldingIdentity = Readonly<{
  portfolioSecurityId: string;
  symbol: string;
  name: string;
  exchange: string;
  currencyCode: string | null;
}>;

export type OwnedHoldingTransactionRow = Readonly<{
  id: string;
  type: string;
  status: string;
  businessDate: string;
  quantityDecimal: string | null;
  unitPriceDecimal: string | null;
  currencyCode: string;
  grossAmountDecimal: string | null;
  feeAmountDecimal: string;
  taxAmountDecimal: string;
  sourceType: string;
  reversesTransactionId: string | null;
  supersedesTransactionId: string | null;
}>;

export type OwnedHoldingTransactions = Readonly<{
  rows: readonly OwnedHoldingTransactionRow[];
  truncated: boolean;
  totalCount: number;
}>;

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`invalid_${key}`);
  return value;
}

function optionalText(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`invalid_${key}`);
  return value;
}

/**
 * Resolve one holding's display identity, owner-scoped. Returns null when
 * no such portfolio security exists for this user/portfolio (the routes
 * turn that into notFound, never a cross-user leak). LEFT JOINs so an
 * unresolved candidate (no canonical security yet) still resolves via its
 * source_* fields rather than vanishing.
 */
export async function loadOwnedHoldingIdentity(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityId: string,
): Promise<OwnedHoldingIdentity | null> {
  const row = await client.get<Record<string, unknown>>(
    `SELECT ps.id,
            COALESCE(ps.display_symbol, ps.source_symbol) AS symbol,
            COALESCE(ps.display_name, s.canonical_name, ps.source_name,
                     ps.source_symbol) AS name,
            COALESCE(e.mic, e.name, ps.source_exchange_alias, 'N/A')
              AS exchange,
            s.primary_currency_code AS currency_code
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       LEFT JOIN exchanges e ON e.id = s.exchange_id
      WHERE ps.id = ? AND ps.user_id = ? AND ps.portfolio_id = ?
      LIMIT 1`,
    [portfolioSecurityId, userId, portfolioId],
  );
  if (!row) return null;
  return {
    portfolioSecurityId: requiredText(row, "id"),
    symbol: requiredText(row, "symbol"),
    name: requiredText(row, "name"),
    exchange: requiredText(row, "exchange"),
    currencyCode: optionalText(row, "currency_code"),
  };
}

/**
 * Every ledger transaction for one holding, newest first, owner-scoped and
 * bounded. ALL types and statuses are returned -- hiding a split or a
 * reversed row would misrepresent the immutable ledger; the screen renders
 * status as text (never colour alone). `totalCount` comes from a separate
 * COUNT so truncation is disclosed with real numbers, never guessed.
 */
export async function loadOwnedHoldingTransactions(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityId: string,
): Promise<OwnedHoldingTransactions> {
  const [rawRows, countRow] = await Promise.all([
    client.all<Record<string, unknown>>(
      `SELECT id, type, status, local_trade_date, quantity_decimal,
              unit_price_decimal, currency_code, gross_amount_decimal,
              fee_amount_decimal, tax_amount_decimal, source_type,
              reverses_transaction_id, supersedes_transaction_id
         FROM transactions
        WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
        ORDER BY local_trade_date DESC, trade_at DESC, id DESC
        LIMIT ?`,
      [
        userId,
        portfolioId,
        portfolioSecurityId,
        MAX_HOLDING_TRANSACTION_ROWS + 1,
      ],
    ),
    client.get<Record<string, unknown>>(
      `SELECT count(*) AS count FROM transactions
        WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?`,
      [userId, portfolioId, portfolioSecurityId],
    ),
  ]);

  const truncated = rawRows.length > MAX_HOLDING_TRANSACTION_ROWS;
  const rows = rawRows.slice(0, MAX_HOLDING_TRANSACTION_ROWS).map((row) => ({
    id: requiredText(row, "id"),
    type: requiredText(row, "type"),
    status: requiredText(row, "status"),
    businessDate: requiredText(row, "local_trade_date"),
    quantityDecimal: optionalText(row, "quantity_decimal"),
    unitPriceDecimal: optionalText(row, "unit_price_decimal"),
    currencyCode: requiredText(row, "currency_code"),
    grossAmountDecimal: optionalText(row, "gross_amount_decimal"),
    feeAmountDecimal: requiredText(row, "fee_amount_decimal"),
    taxAmountDecimal: requiredText(row, "tax_amount_decimal"),
    sourceType: requiredText(row, "source_type"),
    reversesTransactionId: optionalText(row, "reverses_transaction_id"),
    supersedesTransactionId: optionalText(row, "supersedes_transaction_id"),
  }));
  const rawCount = countRow?.count;
  const totalCount =
    typeof rawCount === "number" &&
    Number.isSafeInteger(rawCount) &&
    rawCount >= 0
      ? rawCount
      : rows.length;
  return { rows, truncated, totalCount };
}
