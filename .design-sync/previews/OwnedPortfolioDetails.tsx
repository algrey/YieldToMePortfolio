import { OwnedPortfolioDetails } from "yieldtome-ui";

// `inspection` is typed `unknown` in the emitted contract; these literals
// mirror `PortfolioInspection` from db/repositories/portfolio-inspection.ts.

const portfolio = {
  id: "p1",
  code: "SMSF",
  name: "Grey Family SMSF",
  homeCurrencyCode: "AUD",
  baseCurrencyCode: "AUD",
  timezone: "Australia/Sydney",
  accountingMethod: "fifo",
  status: "active",
  version: 7,
};

const settings = {
  homeCurrencyCode: "AUD",
  timezone: "Australia/Sydney",
  defaultHoldingCurrencyView: "native" as const,
  version: 3,
};

const transactionBase = {
  status: "posted",
  settlementDate: null,
  feeAmountDecimal: "0",
  taxAmountDecimal: "0",
  fxRateToBaseDecimal: null,
  fxRateSource: null,
  fxObservedAt: null,
  sourceType: "csv_import",
  sourceReference: null,
  reversesTransactionId: null,
  supersedesTransactionId: null,
  calculationVersion: 4,
};

const transactions = [
  {
    ...transactionBase,
    id: "tx-2041",
    type: "buy",
    businessDate: "2026-08-14",
    tradeAt: "2026-08-14T00:32:10Z",
    settlementDate: "2026-08-18",
    securityId: "ps-vas",
    securityLabel: "VAS",
    quantityDecimal: "120",
    unitPriceDecimal: "98.42",
    currencyCode: "AUD",
    grossAmountDecimal: "11810.40",
    feeAmountDecimal: "9.50",
    sourceReference: "CMC-88213417",
    sourceType: "manual_entry",
  },
  {
    ...transactionBase,
    id: "tx-2038",
    type: "sell",
    businessDate: "2026-07-22",
    tradeAt: "2026-07-22T03:15:44Z",
    settlementDate: "2026-07-24",
    securityId: "ps-bhp",
    securityLabel: "BHP",
    quantityDecimal: "150",
    unitPriceDecimal: "42.10",
    currencyCode: "AUD",
    grossAmountDecimal: "6315.00",
    feeAmountDecimal: "9.50",
    sourceReference: "CMC-88190022",
  },
  {
    ...transactionBase,
    id: "tx-2031",
    type: "buy",
    businessDate: "2026-05-06",
    tradeAt: "2026-05-06T14:31:02Z",
    settlementDate: "2026-05-08",
    securityId: "ps-aapl",
    securityLabel: "AAPL",
    quantityDecimal: "25",
    unitPriceDecimal: "212.35",
    currencyCode: "USD",
    grossAmountDecimal: "5308.75",
    feeAmountDecimal: "6.99",
    fxRateToBaseDecimal: "1.5487",
    fxRateSource: "Frankfurter",
    fxObservedAt: "2026-05-06T14:00:00Z",
    sourceReference: "IBKR-U4419-77",
  },
  {
    ...transactionBase,
    id: "tx-2019",
    type: "buy",
    businessDate: "2025-11-03",
    tradeAt: "2025-11-03T01:04:55Z",
    settlementDate: "2025-11-05",
    securityId: "ps-cba",
    securityLabel: "CBA",
    quantityDecimal: "40",
    unitPriceDecimal: "158.90",
    currencyCode: "AUD",
    grossAmountDecimal: "6356.00",
    feeAmountDecimal: "9.50",
    sourceReference: "CMC-88014390",
  },
  {
    ...transactionBase,
    id: "tx-2012",
    type: "buy",
    businessDate: "2025-08-19",
    tradeAt: "2025-08-19T00:12:08Z",
    status: "reversed",
    securityId: "ps-wes",
    securityLabel: "WES",
    quantityDecimal: "60",
    unitPriceDecimal: "71.05",
    currencyCode: "AUD",
    grossAmountDecimal: "4263.00",
    sourceType: "manual_entry",
    reversesTransactionId: null,
  },
  {
    ...transactionBase,
    id: "tx-2013",
    type: "buy",
    businessDate: "2025-08-19",
    tradeAt: "2025-08-19T00:12:08Z",
    securityId: "ps-wes",
    securityLabel: "WES",
    quantityDecimal: "-60",
    unitPriceDecimal: "71.05",
    currencyCode: "AUD",
    grossAmountDecimal: "-4263.00",
    sourceType: "manual_entry",
    reversesTransactionId: "tx-2012",
  },
];

const lots = [
  {
    id: "lot-501",
    securityId: "ps-vas",
    securityLabel: "VAS",
    openingTransactionId: "tx-2041",
    acquiredAt: "2026-08-14T00:32:10Z",
    originalQuantityDecimal: "120",
    openQuantityDecimal: "120",
    nativeBasisDecimal: "11819.90",
    baseBasisDecimal: "11819.90",
    basisStatus: "known",
    status: "open",
    calculationVersion: 4,
    rebuiltAt: "2026-09-03T18:05:12Z",
  },
  {
    id: "lot-488",
    securityId: "ps-bhp",
    securityLabel: "BHP",
    openingTransactionId: "tx-1877",
    acquiredAt: "2024-03-11T23:41:30Z",
    originalQuantityDecimal: "400",
    openQuantityDecimal: "250",
    nativeBasisDecimal: "11162.50",
    baseBasisDecimal: "11162.50",
    basisStatus: "known",
    status: "open",
    calculationVersion: 4,
    rebuiltAt: "2026-09-03T18:05:12Z",
  },
  {
    id: "lot-472",
    securityId: "ps-aapl",
    securityLabel: "AAPL",
    openingTransactionId: "tx-2031",
    acquiredAt: "2026-05-06T14:31:02Z",
    originalQuantityDecimal: "25",
    openQuantityDecimal: "25",
    nativeBasisDecimal: "5315.74",
    baseBasisDecimal: "8232.49",
    basisStatus: "known",
    status: "open",
    calculationVersion: 4,
    rebuiltAt: "2026-09-03T18:05:12Z",
  },
  {
    id: "lot-410",
    securityId: "ps-cba",
    securityLabel: "CBA",
    openingTransactionId: "tx-1602",
    acquiredAt: "2022-09-27T00:00:00Z",
    originalQuantityDecimal: "85",
    openQuantityDecimal: "85",
    nativeBasisDecimal: null,
    baseBasisDecimal: null,
    basisStatus: "missing_basis",
    status: "open",
    calculationVersion: 4,
    rebuiltAt: "2026-09-03T18:05:12Z",
  },
];

const allocations = [
  {
    id: "alloc-77",
    sellTransactionId: "tx-2038",
    taxLotId: "lot-488",
    allocationSequence: 1,
    matchedQuantityDecimal: "150",
    allocatedBaseBasisDecimal: "6697.50",
    baseNetProceedsDecimal: "6305.50",
    baseRealisedGainDecimal: "-392.00",
    basisStatus: "known",
    calculationVersion: 4,
  },
];

const cashAccounts = [
  {
    id: "cash-aud",
    currencyCode: "AUD",
    completeness: "complete",
    status: "active",
    balanceDecimal: "14238.17",
    balanceStatus: "complete" as const,
  },
  {
    id: "cash-usd",
    currencyCode: "USD",
    completeness: "partial_history",
    status: "active",
    balanceDecimal: "1191.25",
    balanceStatus: "complete" as const,
  },
];

const cashEntries = [
  {
    id: "ce-9102",
    cashAccountId: "cash-aud",
    currencyCode: "AUD",
    transactionId: "tx-2041",
    effectiveAt: "2026-08-14T00:32:10Z",
    businessDate: "2026-08-14",
    type: "trade_settlement",
    signedAmountDecimal: "-11819.90",
    status: "posted",
    reversesEntryId: null,
  },
  {
    id: "ce-9088",
    cashAccountId: "cash-aud",
    currencyCode: "AUD",
    transactionId: null,
    effectiveAt: "2026-07-17T00:00:00Z",
    businessDate: "2026-07-17",
    type: "dividend",
    signedAmountDecimal: "412.36",
    status: "posted",
    reversesEntryId: null,
  },
  {
    id: "ce-9051",
    cashAccountId: "cash-usd",
    currencyCode: "USD",
    transactionId: "tx-2031",
    effectiveAt: "2026-05-06T14:31:02Z",
    businessDate: "2026-05-06",
    type: "trade_settlement",
    signedAmountDecimal: "-5315.74",
    status: "posted",
    reversesEntryId: null,
  },
  {
    id: "ce-9050",
    cashAccountId: "cash-usd",
    currencyCode: "USD",
    transactionId: null,
    effectiveAt: "2026-05-01T22:00:00Z",
    businessDate: "2026-05-02",
    type: "cash_deposit",
    signedAmountDecimal: "6500.00",
    status: "posted",
    reversesEntryId: null,
  },
];

const noTruncation = {
  transactions: false,
  lots: false,
  allocations: false,
  cashEntries: false,
};

const noop = () => undefined;

/** Canonical owned ledger: AUD portfolio, one USD holding, a reversed entry, a matched sale, two cash ledgers. */
export function Populated() {
  return (
    <OwnedPortfolioDetails
      inspection={{
        portfolio,
        settings,
        transactions,
        lots,
        allocations,
        cashAccounts,
        cashEntries,
        truncated: noTruncation,
      }}
      onOpenSettings={noop}
    />
  );
}

/** Bounded read hit its 200-row window: every section discloses truncation and the cash balance is withheld. */
export function Truncated() {
  return (
    <OwnedPortfolioDetails
      inspection={{
        portfolio,
        settings,
        transactions: transactions.slice(0, 3),
        lots: lots.slice(0, 2),
        allocations,
        cashAccounts: cashAccounts.map((account) => ({
          ...account,
          balanceDecimal: null,
          balanceStatus: "window_incomplete" as const,
        })),
        cashEntries: cashEntries.slice(0, 2),
        truncated: {
          transactions: true,
          lots: true,
          allocations: true,
          cashEntries: true,
        },
      }}
      onOpenSettings={noop}
    />
  );
}

/** Freshly created portfolio with no ledger facts yet and no saved user settings row. */
export function EmptyLedger() {
  return (
    <OwnedPortfolioDetails
      inspection={{
        portfolio: { ...portfolio, code: "NEW", name: "Holiday fund", version: 1 },
        settings: null,
        transactions: [],
        lots: [],
        allocations: [],
        cashAccounts: [],
        cashEntries: [],
        truncated: noTruncation,
      }}
      onOpenSettings={noop}
    />
  );
}

/** Inspection could not be loaded: the honest fail-closed state. */
export function Unavailable() {
  return <OwnedPortfolioDetails inspection={null} onOpenSettings={noop} />;
}
