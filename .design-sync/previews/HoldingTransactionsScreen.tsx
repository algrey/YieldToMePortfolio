import { HoldingTransactionsScreen } from "yieldtome-ui";

// `rows` is typed `unknown` in the emitted contract; these literals mirror
// `OwnedHoldingTransactionRow` from app/owned-holding-transactions.ts.

const base = {
  status: "posted",
  feeAmountDecimal: "0",
  taxAmountDecimal: "0",
  sourceType: "csv_import",
  reversesTransactionId: null,
  supersedesTransactionId: null,
};

const vasRows = [
  {
    ...base,
    id: "tx-2041",
    type: "buy",
    businessDate: "2026-08-14",
    quantityDecimal: "120",
    unitPriceDecimal: "98.42",
    currencyCode: "AUD",
    grossAmountDecimal: "11810.40",
    feeAmountDecimal: "9.50",
    sourceType: "manual_entry",
  },
  {
    ...base,
    id: "tx-1990",
    type: "sell",
    businessDate: "2026-03-05",
    quantityDecimal: "50",
    unitPriceDecimal: "101.17",
    currencyCode: "AUD",
    grossAmountDecimal: "5058.50",
    feeAmountDecimal: "9.50",
  },
  {
    ...base,
    id: "tx-1952",
    type: "buy",
    businessDate: "2025-11-20",
    status: "superseded",
    quantityDecimal: "200",
    unitPriceDecimal: "94.80",
    currencyCode: "AUD",
    grossAmountDecimal: "18960.00",
  },
  {
    ...base,
    id: "tx-1953",
    type: "buy",
    businessDate: "2025-11-20",
    quantityDecimal: "200",
    unitPriceDecimal: "94.88",
    currencyCode: "AUD",
    grossAmountDecimal: "18976.00",
    feeAmountDecimal: "9.50",
    sourceType: "manual_entry",
    supersedesTransactionId: "tx-1952",
  },
  {
    ...base,
    id: "tx-1811",
    type: "buy",
    businessDate: "2024-06-12",
    status: "reversed",
    quantityDecimal: "75",
    unitPriceDecimal: "88.10",
    currencyCode: "AUD",
    grossAmountDecimal: "6607.50",
    feeAmountDecimal: "9.50",
  },
  {
    ...base,
    id: "tx-1812",
    type: "buy",
    businessDate: "2024-06-12",
    quantityDecimal: "-75",
    unitPriceDecimal: "88.10",
    currencyCode: "AUD",
    grossAmountDecimal: "-6607.50",
    feeAmountDecimal: "-9.50",
    sourceType: "manual_entry",
    reversesTransactionId: "tx-1811",
  },
  {
    ...base,
    id: "tx-1602",
    type: "opening_balance",
    businessDate: "2022-07-01",
    quantityDecimal: "310",
    unitPriceDecimal: null,
    currencyCode: "AUD",
    grossAmountDecimal: null,
    sourceType: "sharesight_sync",
  },
];

const aaplRows = [
  {
    ...base,
    id: "tx-2031",
    type: "buy",
    businessDate: "2026-05-06",
    quantityDecimal: "25",
    unitPriceDecimal: "212.35",
    currencyCode: "USD",
    grossAmountDecimal: "5308.75",
    feeAmountDecimal: "6.99",
    taxAmountDecimal: "0.12",
  },
  {
    ...base,
    id: "tx-1701",
    type: "split",
    businessDate: "2020-08-31",
    quantityDecimal: "60",
    unitPriceDecimal: null,
    currencyCode: "USD",
    grossAmountDecimal: null,
    sourceType: "sharesight_sync",
  },
  {
    ...base,
    id: "tx-1650",
    type: "buy",
    businessDate: "2020-02-18",
    quantityDecimal: "20",
    unitPriceDecimal: "318.73",
    currencyCode: "USD",
    grossAmountDecimal: "6374.60",
    feeAmountDecimal: "1.00",
    sourceType: "sharesight_sync",
  },
];

/** Canonical AUD holding: buys, a sell with fees, a supersession pair, a reversal pair, and an opening balance. */
export function Populated() {
  return (
    <HoldingTransactionsScreen
      portfolioId="p1"
      portfolioSecurityId="ps-vas"
      symbol="VAS"
      subtitle="Vanguard Australian Shares Index ETF · ASX · AUD"
      baseCurrencyCode="AUD"
      rows={vasRows}
      truncated={false}
      totalCount={vasRows.length}
    />
  );
}

/** USD-denominated holding in an AUD portfolio: every money cell carries the flagged US$ prefix. */
export function ForeignCurrency() {
  return (
    <HoldingTransactionsScreen
      portfolioId="p1"
      portfolioSecurityId="ps-aapl"
      symbol="AAPL"
      subtitle="Apple Inc. · NASDAQ · USD"
      baseCurrencyCode="AUD"
      rows={aaplRows}
      truncated={false}
      totalCount={aaplRows.length}
    />
  );
}

/** History longer than the 500-row bounded read: the banner discloses real counts. */
export function Truncated() {
  return (
    <HoldingTransactionsScreen
      portfolioId="p1"
      portfolioSecurityId="ps-vas"
      symbol="VAS"
      subtitle="Vanguard Australian Shares Index ETF · ASX · AUD"
      baseCurrencyCode="AUD"
      rows={vasRows}
      truncated={true}
      totalCount={1284}
    />
  );
}

/** A holding with no ledger transactions yet. */
export function Empty() {
  return (
    <HoldingTransactionsScreen
      portfolioId="p1"
      portfolioSecurityId="ps-wes"
      symbol="WES"
      subtitle="Wesfarmers Limited · ASX · AUD"
      baseCurrencyCode="AUD"
      rows={[]}
      truncated={false}
      totalCount={0}
    />
  );
}
