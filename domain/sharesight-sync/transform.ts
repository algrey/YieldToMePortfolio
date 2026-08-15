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
// `db/schema.ts`'s `dividendManualRecords` header note. A null-id (Sharesight
// "unconfirmed") payout stages too once its `paidOnDate` is past. EVERY
// payout, confirmed or not, keys by `(sharesightPortfolioId, holdingId,
// paidOnDate)` -- never the Sharesight `id` -- so confirmation never changes
// a row's identity; see the BRK-005C block comment above
// `payoutIdentityKey` for why the original BRK-005 skip-everything inference
// was wrong, and why the id-vs-natural-key split of the first BRK-005C
// attempt was replaced by this single scheme.
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

/**
 * BRK-005C CORRECTION (2026-08-16, owner-confirmed against live data --
 * `docs/ARCHITECTURE.md` §8.2 and `TASKS.md`'s BRK-005 note carry the full
 * story). The BRK-005 inference below (`buildPayoutRow`'s original comment)
 * was WRONG in practice: Sharesight auto-creates a payout row from every
 * dividend ANNOUNCEMENT and leaves it "unconfirmed" (`id: null`) until the
 * owner manually confirms it there -- but Sharesight's OWN tax reports
 * already count an unconfirmed payout as received income once its
 * `paid_on` date has passed. The owner's real account had 99 of 118
 * payouts null-id; treating every one of them as "not a paid fact yet" and
 * skipping it silently dropped the large majority of real dividend income,
 * not a handful of not-yet-paid distributions. Owner's own words: "Unconfirmed
 * payouts go into the tax calculations and should be kept."
 *
 * Corrected rule: a null-id payout whose `paidOnDate` is on or before the
 * sync's own injected `now` (never `Date.now()` in this pure module --
 * threaded in via `SharesightTransformInput.now` from
 * `app/sharesight-sync-service.ts`'s existing now-injection seam) stages
 * exactly like a confirmed payout, carrying a provenance note ("unconfirmed
 * in Sharesight") so the owner can still see it was never manually
 * confirmed there. Only a FUTURE-dated null-id payout (not yet due) still
 * skips with `SHARESIGHT_PAYOUT_UNCONFIRMED`.
 *
 * REVIEW ROUND FAIL, addressed here (Orchestrator ruling, 2026-08-16
 * follow-up): the FIRST version of this correction keyed a staged
 * unconfirmed payout by `(sharesightPortfolioId, symbol, market, paidOn)`
 * but kept the ORIGINAL `sharesight-payout:<id>` key for a confirmed one --
 * two DIFFERENT identity schemes for the SAME real-world distribution
 * depending only on whether Sharesight has gotten around to confirming it
 * yet (B1: a payout synced+committed while unconfirmed, then CONFIRMED by
 * Sharesight before the next sync, flipped from the natural key to the id
 * key -- a different `source_reference` that the cross-batch dedupe had
 * never seen, so it committed AGAIN as a duplicate). That version also
 * disambiguated a same-holding/same-date collision with a content-sorted
 * `:<ordinal>` suffix (B2: unstable if two payouts were ever indistinguishable
 * on every other field a real API response provides, and in any case an
 * invented mechanism the review found unwarranted) and, for a genuinely
 * byte-identical duplicate pair, silently staged both as two separate
 * "facts" (B3).
 *
 * Corrected identity scheme, unconditionally for EVERY payout (confirmed or
 * not): `sharesight-payout:<sharesightPortfolioId>:<holdingId>:<paidOnDate>`
 * -- see `payoutIdentityKey`. `holdingId` is Sharesight's own required,
 * stable holding identifier (never a ticker, which can be reused/renamed --
 * this also closes a reviewer follow-up about durable security identity),
 * so the key is a pure function of WHICH holding got paid WHEN, completely
 * independent of the Sharesight `id` field's confirmed/null state -- a
 * payout that starts unconfirmed and later gets confirmed keys IDENTICALLY
 * both times (B1 closed). The Sharesight `id`, when present, is surfaced in
 * the row's own `notes` only (visible in preview/audit -- never used for
 * identity; see `payoutProvenanceNote`).
 *
 * Collision (two payouts in one fetch sharing the SAME key -- same holding,
 * same `paid_on`, e.g. an interim and a special dividend): no ordinal, no
 * auto-disambiguation of any kind (B2 closed) -- `buildPayoutRow` stages
 * BOTH (or however many) rows, but each one also carries an error-severity
 * `SHARESIGHT_PAYOUT_KEY_COLLISION` issue naming the holding, the date, and
 * the collision count, which blocks readiness (`hasUnresolvedPersistedIssue`
 * in `app/import-ready-service.ts`) for THIS batch PERMANENTLY: an
 * uncommitted batch has no reverse/discard path at all
 * (`db/repositories/import-commit.ts`'s reversal only ever applies to an
 * already-COMMITTED batch), so a blocked batch simply sits, harmless and
 * never committable, in import history. The block also persists across
 * EVERY SUBSEQUENT sync, since each one re-fetches the identical colliding
 * pair from Sharesight and blocks its own freshly-staged batch the same
 * way -- reviewer-verified false and removed from the guidance: neither
 * "reverse this batch" (impossible, it was never committed) nor "enter the
 * dividend(s) manually" (does not stop the next sync from re-staging the
 * same ambiguity) actually resolves anything. The only remedy that
 * actually works is OUTSIDE this pipeline entirely: resolve/deduplicate
 * the payout inside Sharesight itself (merge or remove the duplicate so
 * the holding reports exactly one payout for that date), then re-sync. A
 * byte-identical duplicate pair hits this exact same path (B3 closed):
 * this module does not attempt to distinguish "two genuinely different
 * distributions that happen to collide" from "the same distribution
 * reported twice" -- both are equally unsafe to auto-resolve and both
 * require the same Sharesight-side fix. Residual, documented rather than
 * solved (reviewer follow-up): if Sharesight ever RE-CREATES a holding (a
 * merge or a delete-then-re-add, as opposed to editing the existing one)
 * its `holdingId` changes, so that holding's already-committed payouts
 * would re-commit ONCE MORE under the new id on the next sync -- a rare,
 * bounded, one-time re-commit distinct from the collision failure mode
 * above, not a repeating drift.
 */
const UNCONFIRMED_PAYOUT_PROVENANCE_NOTE =
  "unconfirmed in Sharesight -- auto-created there from an announcement and not yet manually confirmed, but staged here as real income because Sharesight's own tax reports already count it once paid (owner decision 2026-08-16, BRK-005C).";

/**
 * The SINGLE identity scheme for every staged payout row, confirmed or not
 * -- see the BRK-005C block comment above for why the Sharesight `id` plays
 * no part in it. `portfolioId` is the Sharesight portfolio this fetch was
 * scoped to (each payout's own `portfolioId` field, cross-checked equal to
 * the requested scope by `domain/sharesight/parse.ts`); `holdingId` is
 * Sharesight's own required, stable per-holding identifier (never a
 * ticker). Reuses the `sharesight-payout:` prefix the pre-BRK-005C
 * confirmed-id-only scheme used; a bare confirmed id was always a
 * decimal-digit string, which can never collide with this colon-delimited
 * shape, so no historically-committed `source_reference` is ambiguous
 * against this new one.
 */
function payoutIdentityKey(payout: SharesightPayout): string {
  return `sharesight-payout:${payout.portfolioId}:${payout.holdingId}:${payout.paidOnDate}`;
}

/**
 * Follow-up (Orchestrator ruling 2026-08-16): the Sharesight `id`, when
 * present, is no longer part of a payout's staged identity (see
 * `payoutIdentityKey`), so it would otherwise be invisible anywhere in the
 * staged row -- this appends it to `notes` so it stays visible in
 * preview/audit at least at the STAGED-row layer. IMPORTANT LIMITATION,
 * also documented in `docs/CSV_IMPORT_SPEC.md`'s Sharesight-sync section:
 * `dividend_manual_records` has no notes/comments column at all (see
 * `db/schema.ts`'s header note), so this value -- like a CSV dividend row's
 * own `Notes` field -- is visible only in the STAGED import preview, never
 * after commit; the `source_reference` (`payoutIdentityKey`) is the only
 * durable, post-commit signal a payout came from Sharesight at all.
 */
function payoutProvenanceNote(payout: SharesightPayout): string {
  const parts: string[] = [
    payout.id === null
      ? UNCONFIRMED_PAYOUT_PROVENANCE_NOTE
      : `Sharesight payout id ${payout.id} (confirmed there).`,
  ];
  if (payout.comments) parts.push(payout.comments);
  return parts.join(" ");
}

function buildDividendRowFromPayout(
  payout: SharesightPayout,
  rowNumber: number,
  portfolioName: string,
  identity: { fingerprint: string; issues: ImportIssue[] },
): ParsedImportRow {
  const normalized = blankNormalizedRow();
  normalized.id = payout.id;
  normalized.symbol = payout.symbol;
  normalized.exchange = payout.marketCode;
  normalized.portfolio = portfolioName;
  normalized.currency = payout.currencyCode;
  normalized.type = "dividend";
  normalized.commission = "0";
  normalized.notes = payoutProvenanceNote(payout);
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
    id: payout.id ?? "",
    symbol: payout.symbol,
    exchange: payout.marketCode,
    portfolio: portfolioName,
    currency: payout.currencyCode,
    sharesOwned: "",
    costPerShare: "",
    commission: "0",
    transactionDate: payout.paidOnDate,
    type: "Dividend",
    notes: normalized.notes ?? "",
    frankingPerShare: "",
  });

  return {
    rowNumber,
    kind: "transaction",
    rawFields,
    normalized,
    issues: identity.issues,
    fingerprint: identity.fingerprint,
  };
}

/** A null-id payout whose `paidOnDate` is strictly after `today` -- see
 * `buildPayoutRow`'s header comment. Confirmed (non-null-id) payouts are
 * NEVER classified future -- Sharesight itself already confirmed them, so
 * there is no "not yet due" state to wait out. */
function isFutureUnconfirmedPayout(
  payout: SharesightPayout,
  today: string,
): boolean {
  return payout.id === null && payout.paidOnDate > today;
}

/**
 * `payoutIdentityKey` -> how many STAGEABLE payouts in this fetch share it
 * (1 = no collision). Computed once, up front, over the WHOLE fetch's
 * stageable set (confirmed payouts and past-dated unconfirmed payouts
 * alike -- see the BRK-005C block comment on why they now share one
 * identity scheme) so `buildPayoutRow` can look up any given payout's own
 * collision count without recomputing it per row.
 */
function countPayoutKeyCollisions(
  stageablePayouts: readonly SharesightPayout[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const payout of stageablePayouts) {
    const key = payoutIdentityKey(payout);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildPayoutRow(
  payout: SharesightPayout,
  rowNumber: number,
  portfolioName: string,
  today: string,
  keyCollisionCounts: ReadonlyMap<string, number>,
): SharesightPayoutTransformOutcome {
  if (isFutureUnconfirmedPayout(payout, today)) {
    // FUTURE-dated (not yet due): still no reliable "this really happened"
    // fact to stage -- skipped, surfaced as a visible warning rather than
    // silently dropped. See the BRK-005C block comment above for why a
    // PAST-dated null-id payout, by contrast, stages.
    return {
      kind: "skipped",
      issue: {
        code: "SHARESIGHT_PAYOUT_UNCONFIRMED",
        severity: "warning",
        message: `Sharesight payout for ${payout.symbol} due ${payout.paidOnDate} is future-dated (not yet paid) and has no confirmed id -- it was skipped and will be picked up on a future sync once its paid-on date has passed.`,
      },
    };
  }

  const key = payoutIdentityKey(payout);
  const collisionCount = keyCollisionCounts.get(key) ?? 1;
  const issues: ImportIssue[] =
    collisionCount > 1
      ? [
          {
            code: "SHARESIGHT_PAYOUT_KEY_COLLISION",
            severity: "error",
            message: `Sharesight reported ${collisionCount} payouts for holding ${payout.holdingId} paid on ${payout.paidOnDate} -- these cannot be told apart automatically, so this import can never be marked ready, and every future sync will hit the same block until this is fixed. Resolve the duplicate inside Sharesight itself (merge or remove it so this holding reports exactly one payout for this date), then re-sync -- this batch itself can safely stay in your import history; it will never commit.`,
          },
        ]
      : [];

  return {
    kind: "row",
    row: buildDividendRowFromPayout(payout, rowNumber, portfolioName, {
      fingerprint: key,
      issues,
    }),
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
  /**
   * ISO-8601 instant this transform treats as "now" -- REQUIRED, and
   * threaded through from `app/sharesight-sync-service.ts`'s existing
   * now-injection seam (`SharesightSyncActionOptions.now`, defaulting to a
   * real clock only at that boundary), never read from `Date.now()`/`new
   * Date()` inside this pure domain module. Used only to classify a
   * null-id payout's `paidOnDate` as past (on or before `now`'s own
   * calendar date -- stages as an "unconfirmed in Sharesight" real record,
   * BRK-005C) vs future (still skipped with a warning) -- see
   * `buildPayoutRow`.
   */
  now: string;
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

  // Calendar-date-only comparison (`paidOnDate` is a plain `YYYY-MM-DD`
  // Sharesight market date, never an instant -- see `deriveDates`'s header
  // note): the time-of-day component of `input.now` is deliberately
  // dropped so a payout paid earlier TODAY still counts as past-dated.
  //
  // FOLLOW-UP, not resolved here (documented in `docs/CSV_IMPORT_SPEC.md`'s
  // Sharesight-sync section): `today` is a UTC calendar date (`input.now`'s
  // own timezone, threaded from `app/sharesight-sync-service.ts`'s
  // `new Date().toISOString()`), compared directly against `paidOnDate`,
  // which is the SECURITY'S market-local date (e.g. an ASX payout's own
  // Sydney-local `paid_on`). For a security several hours ahead of UTC (ASX
  // is UTC+10/+11), a payout that is already "today" in Sydney can still
  // read as "tomorrow" in UTC for roughly the first 10-11 local hours of
  // that day -- a real payout could therefore be classified future-dated
  // (skipped) for a few hours longer than strictly necessary. This is a
  // FAIL-SAFE direction only (a payout is never staged too EARLY, only
  // possibly held back slightly too LATE) and self-heals on the very next
  // sync once UTC catches up -- never a permanent misclassification -- so
  // it is accepted as a documented approximation rather than plumbed
  // through a per-security market timezone this module does not otherwise
  // model.
  const today = input.now.slice(0, 10);
  const stageablePayouts = input.payouts.filter(
    (payout) => !isFutureUnconfirmedPayout(payout, today),
  );
  const keyCollisionCounts = countPayoutKeyCollisions(stageablePayouts);

  for (const payout of input.payouts) {
    rowNumber += 1;
    const outcome = buildPayoutRow(
      payout,
      rowNumber,
      input.portfolioName,
      today,
      keyCollisionCounts,
    );
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
