// UI-023: the per-holding Transactions view -- read-only list of every
// ledger transaction recorded against one holding, newest first. Reuses the
// established `.income-fy-table` visual system (see globals.css's CGT note:
// shared tables, not bespoke ones) and the same honesty conventions as the
// dividend list: an unknown amount renders "Unavailable" via
// `formatIncomeMoney(..., null)`, never a fabricated zero; status is text,
// never colour alone; truncation is disclosed with real counts.
import {
  MAX_HOLDING_TRANSACTION_ROWS,
  type OwnedHoldingTransactionRow,
} from "../owned-holding-transactions.ts";
import { formatIncomeMoney } from "../income-format.ts";
import { groupThousands } from "../../domain/calculations/index.ts";
import {
  ownedHoldingDecimal,
  ownedHoldingTrimmed,
} from "../owned-holding-format";
import { currencyDisplayPrefix } from "../currency-display.ts";
import { HoldingNav } from "./holding-nav";

// Literal labels for the ledger's closed type/status enums
// (db/schema.ts transactions_type_check / transactions_status_check); an
// unexpected value falls through as its raw text rather than being hidden.
const TYPE_LABELS: Record<string, string> = {
  buy: "Buy",
  sell: "Sell",
  split: "Split",
  opening_balance: "Opening balance",
  cash_deposit: "Cash deposit",
  cash_withdrawal: "Cash withdrawal",
  fee: "Fee",
  tax: "Tax",
};
const STATUS_LABELS: Record<string, string> = {
  posted: "Posted",
  reversed: "Reversed",
  superseded: "Superseded",
  void_pending: "Void pending",
};

function isNonZeroDecimal(value: string): boolean {
  return /[1-9]/.test(value);
}

export function HoldingTransactionsScreen({
  portfolioId,
  portfolioSecurityId,
  symbol,
  subtitle,
  baseCurrencyCode,
  rows,
  truncated,
  totalCount,
}: {
  portfolioId: string;
  portfolioSecurityId: string;
  symbol: string;
  subtitle: string;
  /** UI-026: the active portfolio's own base currency -- money renders as a
   * bare symbol when a transaction's own currency matches this (native
   * ledger transactions can be in a different currency), flagged
   * otherwise. */
  baseCurrencyCode: string;
  rows: readonly OwnedHoldingTransactionRow[];
  truncated: boolean;
  totalCount: number;
}) {
  return (
    <main className="income-screen holding-screen">
      <HoldingNav
        portfolioId={portfolioId}
        portfolioSecurityId={portfolioSecurityId}
        symbol={symbol}
        subtitle={subtitle}
        active="transactions"
      />

      {truncated ? (
        <p className="status-banner warning" role="status">
          <strong>
            Showing the most recent{" "}
            {groupThousands(String(MAX_HOLDING_TRANSACTION_ROWS))} of{" "}
            {groupThousands(String(totalCount))} transactions
          </strong>
          <span>
            Older transactions for this holding are recorded but not shown here.
          </span>
        </p>
      ) : null}

      <div className="income-fy-table-wrap">
        <table className="income-fy-table">
          <caption>Ledger transactions for {symbol}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Type</th>
              <th scope="col" className="numeric">
                Quantity
              </th>
              <th scope="col" className="numeric">
                Price
              </th>
              <th scope="col" className="numeric">
                Value
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  No transactions recorded for this holding yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const costsNote = [
                  isNonZeroDecimal(row.feeAmountDecimal)
                    ? `fees ${formatIncomeMoney(row.currencyCode, baseCurrencyCode, row.feeAmountDecimal)}`
                    : null,
                  isNonZeroDecimal(row.taxAmountDecimal)
                    ? `tax ${formatIncomeMoney(row.currencyCode, baseCurrencyCode, row.taxAmountDecimal)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <tr key={row.id}>
                    <th scope="row">{row.businessDate}</th>
                    <td>
                      {TYPE_LABELS[row.type] ?? row.type}
                      {row.reversesTransactionId !== null
                        ? " (reversal)"
                        : row.supersedesTransactionId !== null
                          ? " (supersession)"
                          : ""}
                    </td>
                    <td className="numeric">
                      {ownedHoldingDecimal(row.quantityDecimal, 4)}
                    </td>
                    <td className="numeric">
                      {row.unitPriceDecimal === null
                        ? "—"
                        : `${currencyDisplayPrefix(row.currencyCode, baseCurrencyCode)}${ownedHoldingTrimmed(row.unitPriceDecimal)}`}
                    </td>
                    <td className="numeric">
                      {formatIncomeMoney(
                        row.currencyCode,
                        baseCurrencyCode,
                        row.grossAmountDecimal,
                      )}
                      {costsNote ? (
                        <>
                          <br />
                          <span className="transaction-costs-note">
                            {costsNote}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {STATUS_LABELS[row.status] ?? row.status}
                      <br />
                      <span className="transaction-costs-note">
                        {row.sourceType}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
