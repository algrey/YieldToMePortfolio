// BRK-005: pure transform from Sharesight trades/payouts (BRK-003's
// GET-only client contracts, `domain/sharesight/contracts.ts`) into the
// EXACT staged-row shape the existing CSV import pipeline already
// understands (`ParsedImportRow`/`NormalizedImportRow`,
// `domain/imports/index.ts`). This module never touches the database, the
// network, or the staging/commit/reversal machinery -- its whole job is to
// build the same `ImportParseSuccess`-shaped value
// `db/repositories/import-staging.ts`'s `persistParsedResult` already knows
// how to store, so preview/resolve/ready/commit/reverse run completely
// unmodified against Sharesight-sourced rows exactly as they do against a
// CSV upload (Orchestrator ruling).
//
// Trades map to trade-class (`type: "buy" | "sell"`) rows; payouts map to
// dividend-class (`type: "dividend"`) rows carrying TOTALS
// (`totalCashDecimal`/`totalFrankingDecimal`), never a fabricated per-share
// figure -- see `NormalizedImportRow`'s BRK-005 header note in
// `domain/imports/strict-versioned-parser.ts` and
// `db/schema.ts`'s `dividendManualRecords` header note.
import type {
  SharesightPayout,
  SharesightTrade,
} from "../sharesight/contracts.ts";
import type {
  ImportIssue,
  ImportParseSummary,
  ImportTransactionKind,
  NormalizedImportRow,
  ParsedImportRow,
} from "../imports/index.ts";

export const SHARESIGHT_SYNC_PARSER_FORMAT = "sharesight_sync";
export const SHARESIGHT_SYNC_PARSER_VERSION = "sharesight-sync-v1";

/**
 * ASSUMPTION (no live-confirmed evidence names Sharesight's actual
 * `description_code` enum -- `domain/sharesight/contracts.ts`'s doc comment
 * on `SharesightTrade.descriptionCode` only confirms the field is a nullable
 * string, not its value set). This is a deliberately SMALL, conservative
 * allowlist used only as a CROSS-CHECK against the sign-derived direction
 * (never as the primary signal) -- an unrecognized code contributes no
 * signal at all rather than being guessed. Extend only from confirmed live
 * evidence (mirrors the discipline `domain/sharesight/parse.ts` already
 * applies to every other Sharesight field).
 */
const DESCRIPTION_CODE_DIRECTION: Readonly<Record<string, "buy" | "sell">> = {
  BUY: "buy",
  SELL: "sell",
};

function isNegativeDecimal(value: string): boolean {
  return value.trim().startsWith("-");
}

export type SharesightTradeDirectionResult =
  | { ok: true; type: "buy" | "sell" }
  | { ok: false; reason: "no_signal" | "disagreement" };

/**
 * Direction from `valueDecimal`'s CONFIRMED sign (sell negative -- BRK-003/
 * BRK-008 live evidence, `SharesightTrade.valueDecimal`'s doc comment),
 * cross-checked against `transactionType` (when it is `"buy"`/`"sell"`, not
 * `"other"`) and `descriptionCode` (via the conservative allowlist above).
 * ANY disagreement among the signals that ARE available is reported, never
 * silently resolved by picking one; if NO signal is available at all
 * (`valueDecimal` null, `transactionType` `"other"`/null, no recognized
 * `descriptionCode`) this reports `"no_signal"` -- both cases are the
 * "unmapped/ambiguous type" the Orchestrator ruling requires to fail closed
 * per row, never guessed.
 */
export function resolveSharesightTradeDirection(
  trade: SharesightTrade,
): SharesightTradeDirectionResult {
  const signDirection: "buy" | "sell" | null =
    trade.valueDecimal === null
      ? null
      : isNegativeDecimal(trade.valueDecimal)
        ? "sell"
        : "buy";
  const typeDirection: "buy" | "sell" | null =
    trade.transactionType === "buy" || trade.transactionType === "sell"
      ? trade.transactionType
      : null;
  const codeDirection: "buy" | "sell" | null = trade.descriptionCode
    ? (DESCRIPTION_CODE_DIRECTION[trade.descriptionCode.trim().toUpperCase()] ??
      null)
    : null;

  const signals = [signDirection, typeDirection, codeDirection].filter(
    (signal): signal is "buy" | "sell" => signal !== null,
  );
  if (new Set(signals).size > 1) return { ok: false, reason: "disagreement" };
  // Typed narrowing instead of a `signals[0]!` assertion: destructuring
  // gives an explicit `undefined` check for the empty-array case (no
  // signal at all) rather than asserting past it.
  const [direction] = signals;
  if (direction === undefined) return { ok: false, reason: "no_signal" };
  return { ok: true, type: direction };
}

// Local mutable mirror of `NormalizedImportRow` (whose fields are all
// `readonly`) -- built up field-by-field below, then assigned directly into
// a `ParsedImportRow.normalized` slot (structurally compatible; the
// `readonly` modifier is erased at the type level, not a runtime distinction).
type MutableNormalizedRow = {
  -readonly [K in keyof NormalizedImportRow]: NormalizedImportRow[K];
};

function blankNormalizedRow(): MutableNormalizedRow {
  return {
    id: null,
    symbol: null,
    name: null,
    displaySymbol: null,
    exchange: null,
    portfolio: null,
    currency: null,
    sharesOwned: null,
    costPerShare: null,
    commission: null,
    transactionDate: null,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: null,
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: null,
    localTradeDate: null,
    cashEvent: null,
    frankingPerShare: null,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
  };
}

/** Sharesight `transactionDate`/`paidOnDate` are plain `YYYY-MM-DD` calendar
 * dates (confirmed by `domain/sharesight/parse.ts`'s `isMarketDate`), never
 * an instant -- there is no separate time-of-day field to reconcile the way
 * CSV's `Transaction Time` column requires. `tradeAtUtc` is the date's own
 * UTC midnight instant and `localTradeDate` is the date itself, mirroring
 * how a CSV row with no `Transaction Time` normalizes today. */
function deriveDates(marketDate: string): {
  tradeAtUtc: string;
  localTradeDate: string;
} {
  return {
    tradeAtUtc: `${marketDate}T00:00:00.000Z`,
    localTradeDate: marketDate,
  };
}

function rawFieldsFor(fields: {
  id: string;
  symbol: string;
  exchange: string;
  portfolio: string;
  currency: string;
  sharesOwned: string;
  costPerShare: string;
  commission: string;
  transactionDate: string;
  type: string;
  notes: string;
  frankingPerShare: string;
}): string[] {
  // Mirrors the 18-column dividend-capable header's field order
  // (`SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS`) for consistency/debuggability
  // only -- `original_fields_json` is stored for audit/round-trip purposes
  // and is never rendered positionally anywhere in this codebase.
  return [
    fields.id,
    fields.symbol,
    "", // Name -- not modelled by the trade/payout contracts
    "", // Display Symbol
    fields.exchange,
    fields.portfolio,
    fields.currency,
    fields.sharesOwned,
    fields.costPerShare,
    fields.commission,
    fields.transactionDate,
    "", // Transaction Time -- Sharesight carries no separate time-of-day
    "", // Purchase Exchange Rate -- resolved at read time, not import time
    fields.type,
    "", // Accounting
    "", // Accounting Execution Ids
    fields.notes,
    fields.frankingPerShare,
  ];
}

export type SharesightTransformResult = {
  rows: ParsedImportRow[];
  issues: ImportIssue[];
  summary: ImportParseSummary;
};

function buildTradeRow(
  trade: SharesightTrade,
  rowNumber: number,
  portfolioName: string,
): ParsedImportRow {
  const normalized = blankNormalizedRow();
  normalized.id = trade.id;
  normalized.symbol = trade.instrumentCode;
  normalized.exchange = trade.marketCode;
  normalized.portfolio = portfolioName;
  normalized.currency = trade.currencyCode;
  normalized.commission = trade.brokerageDecimal ?? "0";
  normalized.notes = trade.comments;

  const issues: ImportIssue[] = [];
  const direction = resolveSharesightTradeDirection(trade);
  if (!direction.ok) {
    issues.push({
      code: "TRANSACTION_TYPE_UNKNOWN",
      severity: "error",
      field: "type",
      message:
        direction.reason === "disagreement"
          ? `Sharesight trade ${trade.id}: the value sign, transaction type, and description code disagree on buy/sell direction -- resolve manually before this row can be staged.`
          : `Sharesight trade ${trade.id}: no reliable signal (value sign, transaction type, or description code) confirms whether this is a buy or a sell -- resolve manually before this row can be staged.`,
    });
    const rawFields = rawFieldsFor({
      id: trade.id,
      symbol: trade.instrumentCode,
      exchange: trade.marketCode,
      portfolio: portfolioName,
      currency: trade.currencyCode,
      sharesOwned: trade.quantityDecimal,
      costPerShare: trade.priceDecimal,
      commission: normalized.commission ?? "",
      transactionDate: trade.transactionDate,
      type: trade.transactionType ?? "",
      notes: trade.comments ?? "",
      frankingPerShare: "",
    });
    return {
      rowNumber,
      kind: "unsupported",
      rawFields,
      normalized,
      issues,
      fingerprint: `sharesight-trade:${trade.id}`,
    };
  }

  normalized.type = direction.type as ImportTransactionKind;
  normalized.sharesOwned = trade.quantityDecimal.replace(/^-/, "");
  normalized.costPerShare = trade.priceDecimal;
  const { tradeAtUtc, localTradeDate } = deriveDates(trade.transactionDate);
  normalized.tradeAtUtc = tradeAtUtc;
  normalized.localTradeDate = localTradeDate;

  const rawFields = rawFieldsFor({
    id: trade.id,
    symbol: trade.instrumentCode,
    exchange: trade.marketCode,
    portfolio: portfolioName,
    currency: trade.currencyCode,
    sharesOwned: normalized.sharesOwned,
    costPerShare: normalized.costPerShare,
    commission: normalized.commission ?? "",
    transactionDate: trade.transactionDate,
    type: direction.type,
    notes: trade.comments ?? "",
    frankingPerShare: "",
  });

  return {
    rowNumber,
    kind: "transaction",
    rawFields,
    normalized,
    issues,
    // BRK-005 idempotency: keyed by the Sharesight trade's own stable
    // numeric id (Orchestrator ruling), not a recomputed field hash -- a
    // resumed/repeated sync that re-fetches the identical trade produces the
    // identical fingerprint, so `import-commit.ts`'s existing
    // `source_reference` uniqueness (`import-fingerprint:sharesight-trade:<id>`)
    // dedupes it exactly like a re-uploaded CSV row.
    fingerprint: `sharesight-trade:${trade.id}`,
  };
}

export type SharesightPayoutTransformOutcome =
  | { kind: "row"; row: ParsedImportRow }
  | { kind: "skipped"; issue: ImportIssue };

function buildPayoutRow(
  payout: SharesightPayout,
  rowNumber: number,
  portfolioName: string,
): SharesightPayoutTransformOutcome {
  if (payout.id === null) {
    // Orchestrator ruling: a null-id payout is Sharesight's own
    // declared-but-not-yet-confirmed distribution (this codebase's
    // provider-event "estimated/declared" concept, not a paid fact) --
    // skipped entirely (never staged as a fact), surfaced as a visible
    // warning rather than silently dropped.
    return {
      kind: "skipped",
      issue: {
        code: "SHARESIGHT_PAYOUT_UNCONFIRMED",
        severity: "warning",
        message: `Sharesight payout for ${payout.symbol} paid ${payout.paidOnDate} has no confirmed id (an unconfirmed/declared distribution) and was skipped -- it will be picked up on a future sync once Sharesight confirms it.`,
      },
    };
  }

  const normalized = blankNormalizedRow();
  normalized.id = payout.id;
  normalized.symbol = payout.symbol;
  normalized.exchange = payout.marketCode;
  normalized.portfolio = portfolioName;
  normalized.currency = payout.currencyCode;
  normalized.type = "dividend";
  normalized.commission = "0";
  normalized.notes = payout.comments;
  const { tradeAtUtc, localTradeDate } = deriveDates(payout.paidOnDate);
  normalized.tradeAtUtc = tradeAtUtc;
  normalized.localTradeDate = localTradeDate;
  // Totals-only shape (Orchestrator ruling): Sharesight payouts report a
  // TOTAL cash amount and total franking credits, never a share count or a
  // per-share amount -- `sharesOwned`/`costPerShare`/`frankingPerShare`
  // deliberately stay null (never fabricated) and `totalCashDecimal`/
  // `totalFrankingDecimal` carry the real totals instead. `amountDecimal`
  // (not `grossAmountDecimal`, which includes franking) is the cash-only
  // total.
  //
  // OPEN QUESTION, explicitly NOT resolved here (review follow-up):
  // whether `amountDecimal` (wire `amount`) is the cash amount BEFORE or
  // AFTER withholding tax deduction (`residentWithholdingTaxDecimal`/
  // `nonResidentWithholdingTaxDecimal`) is genuinely unconfirmed -- no live
  // evidence or third-party documentation this repo has seen states the
  // relationship between `amount`/`gross_amount` and the two withholding
  // fields (see `docs/ARCHITECTURE.md` §8.2's BRK-008 payout evidence,
  // which confirms the withholding fields' SHAPE but not their arithmetic
  // relationship to `amount`). The CONSERVATIVE choice made here: stage
  // `amountDecimal` exactly as Sharesight reports it, with NO withholding
  // arithmetic applied in either direction (neither subtracting it as if
  // `amount` were gross, nor adding it back as if `amount` were already
  // net) -- guessing wrong in either direction would silently misstate a
  // real cash figure, which is worse than staging the number Sharesight
  // itself labels "amount" verbatim and leaving the question open. See
  // `docs/CALCULATIONS.md` §11 for the same note against the derivation
  // this value feeds, and treat this as a standing input to any future
  // `DIV`-feed decision that consumes Sharesight payouts more deeply
  // (Sharesight's own withholding fields are not otherwise surfaced to the
  // BRK-005 staged row at all yet).
  normalized.totalCashDecimal = payout.amountDecimal;
  normalized.totalFrankingDecimal = payout.frankingCreditsDecimal;

  const rawFields = rawFieldsFor({
    id: payout.id,
    symbol: payout.symbol,
    exchange: payout.marketCode,
    portfolio: portfolioName,
    currency: payout.currencyCode,
    sharesOwned: "",
    costPerShare: "",
    commission: "0",
    transactionDate: payout.paidOnDate,
    type: "Dividend",
    notes: payout.comments ?? "",
    frankingPerShare: "",
  });

  return {
    kind: "row",
    row: {
      rowNumber,
      kind: "transaction",
      rawFields,
      normalized,
      issues: [],
      // BRK-005 idempotency: keyed by the payout's own stable numeric id
      // (confirmed, non-null here) -- see `buildTradeRow`'s identical
      // convention.
      fingerprint: `sharesight-payout:${payout.id}`,
    },
  };
}

export type SharesightTransformInput = {
  /** The LOCAL (already-linked) target portfolio's own name -- used as the
   * synthetic `Portfolio` field so `domain/imports/reconciliation.ts`'s
   * existing name-match fallback resolves every row to that portfolio with
   * no manual mapping step required (the owner already chose the portfolio
   * by linking it). */
  portfolioName: string;
  trades: readonly SharesightTrade[];
  payouts: readonly SharesightPayout[];
};

/**
 * Builds the complete `ParsedImportRow[]`/batch-level issues/summary for one
 * sync pull, in the exact shape `db/repositories/import-staging.ts`'s
 * `persistParsedResult` already knows how to store as an
 * `ImportParseSuccess`. Trades are numbered before payouts; row numbers are
 * a synthetic sequence starting at 2 across the whole pull (there is no
 * physical file to derive them from, but `import_rows_physical_row_number_check`
 * requires every row number to be greater than 1 -- CSV row 1 is always the
 * header, so the first DATA row is row 2; this synthetic sequence mirrors
 * that convention rather than inventing a different one).
 */
export function transformSharesightSync(
  input: SharesightTransformInput,
): SharesightTransformResult {
  const rows: ParsedImportRow[] = [];
  const issues: ImportIssue[] = [];
  let rowNumber = 1;
  let unsupportedRows = 0;
  let dividendRows = 0;
  let transactionRows = 0;

  for (const trade of input.trades) {
    rowNumber += 1;
    const row = buildTradeRow(trade, rowNumber, input.portfolioName);
    rows.push(row);
    if (row.kind === "unsupported") {
      unsupportedRows += 1;
    } else {
      transactionRows += 1;
    }
  }

  for (const payout of input.payouts) {
    rowNumber += 1;
    const outcome = buildPayoutRow(payout, rowNumber, input.portfolioName);
    if (outcome.kind === "skipped") {
      issues.push(outcome.issue);
      continue;
    }
    rows.push(outcome.row);
    transactionRows += 1;
    dividendRows += 1;
  }

  return {
    rows,
    issues,
    summary: {
      totalRows: rows.length,
      blankRows: 0,
      definitionRows: 0,
      transactionRows,
      unsupportedRows,
      cashTransactionRows: 0,
      dividendRows,
      duplicateRows: 0,
    },
  };
}
