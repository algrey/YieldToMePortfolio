import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deriveSharesightSecuritiesSummary,
  type SharesightSecuritySummaryCandidate,
  type SharesightSecuritySummaryRow,
} from "../domain/imports/security-summary.ts";
import {
  createImportReconciliationPreview,
  type ImportPreviewPortfolio,
  type ImportReconciliationRow,
} from "../domain/imports/reconciliation.ts";
import type { NormalizedImportRow } from "../domain/imports/strict-versioned-parser.ts";

// UI-015: the Review securities table showed a foreign-currency dividend
// group (e.g. RMD/ASX/USD payouts) as a SECOND "Awaiting resolution" line
// even after its rows resolved to the SAME security as the AUD group,
// because `deriveSharesightSecuritiesSummary` grouped strictly by (symbol,
// exchange, currency) without BRK-010's dividend-currency-agnostic
// candidate match. See TASKS.md's UI-015 entry for the full ruling set.

// ---------------------------------------------------------------------------
// Part 1: deriveSharesightSecuritiesSummary -- the merge/disclosure logic.
// ---------------------------------------------------------------------------

function row(
  overrides: Partial<{
    id: string;
    symbol: string;
    exchange: string | null;
    currency: string;
    type: NormalizedImportRow["type"];
    totalCashDecimal: string | null;
  }> = {},
): SharesightSecuritySummaryRow {
  return {
    id: overrides.id ?? "row-1",
    rowClass: "transaction",
    normalizedFields: {
      symbol: overrides.symbol ?? "RMD",
      exchange: overrides.exchange === undefined ? "ASX" : overrides.exchange,
      currency: overrides.currency ?? "AUD",
      instrumentName: null,
      type: overrides.type ?? "buy",
      totalCashDecimal:
        overrides.totalCashDecimal === undefined
          ? null
          : overrides.totalCashDecimal,
    },
    excludedByOwnerAt: null,
  };
}

function candidate(
  overrides: Partial<SharesightSecuritySummaryCandidate> = {},
): SharesightSecuritySummaryCandidate {
  return {
    portfolioId: "portfolio-a",
    sourceSymbol: "RMD",
    sourceExchangeAlias: "ASX",
    sourceCurrencyCode: "AUD",
    securityId: null,
    ...overrides,
  };
}

test("UI-015: an RMD-shaped batch (AUD trades + USD totals-mode dividends, one resolved security) renders ONE line with an honest USD disclosure and a summed row count", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "trade-1", type: "buy" }),
      row({ id: "trade-2", type: "sell" }),
      row({
        id: "div-1",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "20.40",
      }),
      row({
        id: "div-2",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "18.10",
      }),
      row({
        id: "div-3",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "22.00",
      }),
    ],
    targetPortfolioId: "portfolio-a",
    // BRK-010: the USD payout-only group deliberately has NO candidate row
    // of its own -- its rows reuse the security's single portfolio_securities
    // link, so only the AUD candidate exists.
    securityCandidates: [candidate({ securityId: "sec-rmd" })],
    conflictedRowIds: new Set(),
    securityNames: new Map([["sec-rmd", "Ramelius Resources"]]),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(
    summary.length,
    1,
    "expected the two currency groups to merge into ONE line",
  );
  const entry = summary[0]!;
  assert.equal(entry.state, "resolved");
  assert.equal(entry.securityId, "sec-rmd");
  assert.equal(entry.sourceCurrencyCode, "AUD");
  assert.deepEqual(entry.additionalPayoutCurrencyCodes, ["USD"]);
  assert.equal(entry.rowCount, 5, "2 trade rows + 3 dividend rows");
});

test("UI-015: two dividend-only foreign currencies both fold into the same primary line, sorted and each currency listed once", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "trade-1", type: "buy" }),
      row({
        id: "div-usd",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "10",
      }),
      row({
        id: "div-nzd",
        currency: "NZD",
        type: "dividend",
        totalCashDecimal: "12",
      }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [candidate({ securityId: "sec-rmd" })],
    conflictedRowIds: new Set(),
    securityNames: new Map([["sec-rmd", "Ramelius Resources"]]),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0]!.additionalPayoutCurrencyCodes, ["NZD", "USD"]);
  assert.equal(summary[0]!.rowCount, 3);
});

test("UI-015: a per-share CSV-style dividend row (no totalCashDecimal) never triggers the currency-agnostic merge -- BRK-010's mechanism is totals-mode-only", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "trade-1", type: "buy" }),
      // Same symbol/exchange, a DIFFERENT currency, but `totalCashDecimal`
      // is null -- a per-share dividend row, never a Sharesight totals-mode
      // payout, so it must keep the strict (symbol, exchange, currency)
      // candidate match and stay its own unresolved group.
      row({
        id: "div-1",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: null,
      }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [candidate({ securityId: "sec-rmd" })],
    conflictedRowIds: new Set(),
    securityNames: new Map([["sec-rmd", "Ramelius Resources"]]),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 2, "must NOT merge a per-share dividend group");
  const aud = summary.find((entry) => entry.sourceCurrencyCode === "AUD");
  const usd = summary.find((entry) => entry.sourceCurrencyCode === "USD");
  assert.equal(aud!.state, "resolved");
  assert.equal(aud!.rowCount, 1);
  assert.equal(usd!.state, "unresolved", "no USD candidate exists at all");
  assert.deepEqual(usd!.additionalPayoutCurrencyCodes, []);
});

test("UI-015: a conflicted row in the dividend-only foreign-currency group is never silently folded into the resolved line -- conflict stays its own honest line", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "trade-1", type: "buy" }),
      row({
        id: "div-1",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "20",
      }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [candidate({ securityId: "sec-rmd" })],
    // The USD dividend row is blocked by a persisted
    // SECURITY_RESOLUTION_CONFLICT issue.
    conflictedRowIds: new Set(["div-1"]),
    securityNames: new Map([["sec-rmd", "Ramelius Resources"]]),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(
    summary.length,
    2,
    "conflict must never merge into the resolved line",
  );
  const aud = summary.find((entry) => entry.sourceCurrencyCode === "AUD");
  const usd = summary.find((entry) => entry.sourceCurrencyCode === "USD");
  assert.equal(aud!.state, "resolved");
  assert.equal(
    aud!.rowCount,
    1,
    "the conflicted USD row must not inflate the resolved line's count",
  );
  assert.equal(usd!.state, "conflict");
  assert.equal(usd!.securityId, null);
});

test("UI-015: a genuinely unresolved dividend-only group (no candidate match even ignoring currency) reports unresolved, never fabricated as resolved", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({
        id: "div-1",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "20",
      }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.state, "unresolved");
  assert.equal(summary[0]!.securityId, null);
  assert.deepEqual(summary[0]!.additionalPayoutCurrencyCodes, []);
  assert.equal(
    summary[0]!.dividendOnly,
    true,
    "a solo dividend-only group is flagged dividendOnly regardless of state",
  );
});

test("UI-015 review round F4: a payout-only steady state (dividend-only line, no primary sibling in the batch) is flagged dividendOnly, distinct from a merged line", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      // No AUD trade/dividend group at all in THIS batch -- the security's
      // trades already committed in an earlier batch; this resync batch is
      // 100% USD dividends.
      row({
        id: "div-1",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "20",
      }),
      row({
        id: "div-2",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "18",
      }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [
      candidate({ sourceCurrencyCode: "AUD", securityId: "sec-rmd" }),
    ],
    conflictedRowIds: new Set(),
    securityNames: new Map([["sec-rmd", "Ramelius Resources"]]),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 1, "nothing to merge into -- one solo line");
  const entry = summary[0]!;
  assert.equal(entry.state, "resolved");
  assert.equal(entry.securityId, "sec-rmd");
  assert.equal(
    entry.sourceCurrencyCode,
    "USD",
    "the line's own currency is the payout currency, not the security's AUD candidate currency",
  );
  assert.equal(entry.rowCount, 2);
  assert.deepEqual(entry.additionalPayoutCurrencyCodes, []);
  assert.equal(entry.dividendOnly, true);
});

test("UI-015 review round F1: a hypothetical second primary sibling never absorbs dividend-only rows itself -- only the FIRST primary merges, so dividend rows are never double-counted or double-disclosed", () => {
  const sharedCandidates: SharesightSecuritySummaryCandidate[] = [
    candidate({ sourceCurrencyCode: "AUD", securityId: "sec-x" }),
    candidate({ sourceCurrencyCode: "GBP", securityId: "sec-x" }),
  ];
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "trade-aud", currency: "AUD", type: "buy" }),
      row({ id: "trade-gbp", currency: "GBP", type: "buy" }),
      row({
        id: "div-usd-1",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "10",
      }),
      row({
        id: "div-usd-2",
        currency: "USD",
        type: "dividend",
        totalCashDecimal: "12",
      }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: sharedCandidates,
    conflictedRowIds: new Set(),
    securityNames: new Map([["sec-x", "Shared Co"]]),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(
    summary.length,
    2,
    "two primary (non-dividend-only) lines, the dividend-only group folded into exactly one of them",
  );
  const aud = summary.find((entry) => entry.sourceCurrencyCode === "AUD");
  const gbp = summary.find((entry) => entry.sourceCurrencyCode === "GBP");
  assert.ok(aud && gbp);
  // AUD's group appears first in row order, so it is the FIRST primary and
  // absorbs both USD dividend rows.
  assert.deepEqual(aud!.additionalPayoutCurrencyCodes, ["USD"]);
  assert.equal(aud!.rowCount, 3, "1 AUD trade + 2 USD dividend rows");
  // GBP must NOT also claim the USD dividend rows -- no double count, no
  // duplicated disclosure.
  assert.deepEqual(gbp!.additionalPayoutCurrencyCodes, []);
  assert.equal(gbp!.rowCount, 1, "its own GBP trade row only");
});

// ---------------------------------------------------------------------------
// Part 2: cross-check against reconciliation.ts's OWN pending-mapping issue,
// proving a genuinely-unresolved group's "Awaiting resolution" link (gated,
// client-side, on a real matching pending mapping -- see
// app/components/import-review.tsx's `pendingSecurityMappingKeyFor`) always
// points at a mapping that truly exists in `review.preview.issues`.
// ---------------------------------------------------------------------------

const PORTFOLIOS: ImportPreviewPortfolio[] = [
  { id: "portfolio-a", name: "Main", homeCurrencyCode: "AUD" },
];

function reconciliationRow(input: {
  rowId: string;
  symbol: string;
  exchange: string | null;
  currency: string;
  type: NormalizedImportRow["type"];
  totalCashDecimal?: string | null;
}): ImportReconciliationRow {
  const normalized: NormalizedImportRow = {
    id: input.rowId,
    symbol: input.symbol,
    name: null,
    displaySymbol: null,
    exchange: input.exchange,
    portfolio: "Main",
    currency: input.currency,
    sharesOwned: input.type === "dividend" ? null : "5",
    costPerShare: input.type === "dividend" ? null : "10",
    commission: null,
    transactionDate: "2026-08-01",
    transactionTime: null,
    purchaseExchangeRate: null,
    type: input.type,
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-01T00:00:00Z",
    localTradeDate: "2026-08-01",
    cashEvent: null,
    frankingPerShare: null,
    totalCashDecimal:
      input.totalCashDecimal === undefined ? null : input.totalCashDecimal,
  };
  return {
    id: input.rowId,
    physicalRowNumber: 2,
    rowClass: "transaction",
    normalized,
    fingerprint: `fp-${input.rowId}`,
  };
}

// Mirrors app/components/import-review.tsx's `normalizedKeyPart` +
// `pendingSecurityMappingKeyFor` exactly (trim + lowercase on symbol/
// exchange/currency, portfolioId left raw), matching reconciliation.ts's
// own `securityKey()`.
function clientPendingSecurityMappingKey(
  portfolioId: string,
  entry: {
    sourceSymbol: string;
    sourceExchangeAlias: string | null;
    sourceCurrencyCode: string;
  },
): string {
  const norm = (value: string) => value.trim().toLowerCase();
  return [
    portfolioId,
    norm(entry.sourceSymbol),
    norm(entry.sourceExchangeAlias ?? ""),
    norm(entry.sourceCurrencyCode),
  ].join("|");
}

test("UI-015: a genuinely unresolved group's SECURITY_MAPPING_REQUIRED sourceKey matches the client's pendingSecurityMappingKeyFor, so the Awaiting-resolution link only ever points at a mapping that truly exists", () => {
  const row1 = reconciliationRow({
    rowId: "div-1",
    symbol: "RMD",
    exchange: "ASX",
    currency: "USD",
    type: "dividend",
    totalCashDecimal: "20",
  });
  const preview = createImportReconciliationPreview({
    rows: [row1],
    portfolios: PORTFOLIOS,
    securityCandidates: [],
  });
  const issue = preview.issues.find(
    (candidateIssue) => candidateIssue.code === "SECURITY_MAPPING_REQUIRED",
  );
  assert.ok(issue, "expected a real pending security mapping issue");

  const summaryRow = row({
    id: "div-1",
    symbol: "RMD",
    exchange: "ASX",
    currency: "USD",
    type: "dividend",
    totalCashDecimal: "20",
  });
  const summary = deriveSharesightSecuritiesSummary({
    rows: [summaryRow],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary[0]!.state, "unresolved");

  const clientKey = clientPendingSecurityMappingKey("portfolio-a", summary[0]!);
  assert.equal(
    clientKey,
    issue!.sourceKey,
    "the client's pending-mapping key must match reconciliation's own securityKey() for the SAME group",
  );
});

// ---------------------------------------------------------------------------
// Part 3: import-review.tsx source assertions -- the gated rendering exists,
// names the symbol, and the currency disclosure never touches the
// identity-bearing sourceCurrencyCode value the name-edit mutation sends.
// ---------------------------------------------------------------------------

test("UI-015: the Awaiting-resolution link renders only when a matching pending security mapping exists, and always names the symbol", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /pendingSecurityMappingKeys\.has\(\s*\n\s*pendingSecurityMappingKeyFor\(/,
    "expected the awaiting-resolution branch to gate on a real pending mapping lookup",
  );
  assert.match(
    component,
    /Awaiting resolution -- see pending mappings\s*\n\s*above \(\{entry\.sourceSymbol\}\)/,
  );
  assert.match(
    component,
    /`Not yet resolved \(\$\{entry\.sourceSymbol\}\)`/,
    "expected an honest non-link fallback naming the symbol when no pending mapping exists",
  );
});

test("UI-015: the merged line's currency cell discloses extra payout currencies as honest text, distinct from the identity-bearing sourceCurrencyCode value", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /entry\.additionalPayoutCurrencyCodes/);
  assert.match(component, /\(dividends in/);
  // The metadata-save POST body must still send the RAW, unsuffixed
  // currency code (never the merged disclosure text), or the server-side
  // candidate match in import-security-metadata-service.ts would break.
  assert.match(component, /sourceCurrencyCode: entry\.sourceCurrencyCode,/);
});

test("UI-015 review round F4: the Currency cell renders a (dividends only) hint for a solo payout-only line", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /entry\.dividendOnly \? <> \(dividends only\)<\/> : null/,
  );
});
