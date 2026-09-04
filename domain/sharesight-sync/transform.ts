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
import {
  divideDecimal,
  formatDecimalExact,
  fromInteger,
  isZero,
  parseDecimal,
  roundDecimal,
} from "../calculations/decimal.ts";

export const SHARESIGHT_SYNC_PARSER_FORMAT = "sharesight_sync";
export const SHARESIGHT_SYNC_PARSER_VERSION = "sharesight-sync-v1";

// BRK-010 review (2026-08-19): half-even rounding at the same 24-place
// intermediate scale `domain/dividends/franking.ts`'s `DEFAULT_TIER_SCALE`
// establishes for financial math with no natural terminating scale -- a
// decimal reciprocal (unlike a multiplication) is not guaranteed to
// terminate, so this rounding is load-bearing here, not defence-in-depth.
const PORTFOLIO_RATE_SCALE = 24;

/**
 * BRK-010 review finding B1 (LIVE-CONFIRMED, see `SharesightPayout.exchangeRateDecimal`'s
 * doc comment in `contracts.ts` for the live evidence): Sharesight's raw
 * `exchange_rate` is NOT the multiply-a-payout-amount-by-this-to-reach-the-
 * portfolio-base-total factor -- it is the inverse (empirically, the
 * ordinary AUD/USD quote convention: USD received per 1 AUD). Every
 * downstream consumer of `NormalizedImportRow.exchangeRateDecimal` /
 * `dividend_manual_records.fx_rate_to_portfolio_decimal` expects the
 * OPPOSITE convention (multiply record-currency amount by this to reach
 * the portfolio's base-currency amount, matching the column name) -- this
 * function performs that correction exactly once, here, so no other layer
 * ever needs to know the raw wire field's own (inverse) sign. `null`/`"0"`
 * (no rate, or a malformed zero that cannot be inverted) both degrade to
 * `null` -- never a fabricated or divide-by-zero value.
 */
export function invertToPortfolioConversionRate(
  rawExchangeRateDecimal: string | null,
): string | null {
  if (rawExchangeRateDecimal === null) return null;
  let raw;
  try {
    raw = parseDecimal(rawExchangeRateDecimal);
  } catch {
    return null;
  }
  if (isZero(raw)) return null;
  try {
    return formatDecimalExact(
      roundDecimal(divideDecimal(fromInteger(1n), raw), PORTFOLIO_RATE_SCALE),
    );
  } catch {
    return null;
  }
}

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
    // BRK-009A: additive metadata carriage only -- see
    // `NormalizedImportRow`'s doc comment (`strict-versioned-parser.ts`) for
    // why these stay OUT of `canonicalRowDigestFields`
    // (`app/sharesight-sync-service.ts`) and every row's own `fingerprint`
    // below, both of which are unaffected by this block.
    sharesightInstrumentId: null,
    instrumentName: null,
    isin: null,
    // BRK-010 review (B2): unlike sharesightInstrumentId/instrumentName/isin
    // above (matching aids, deliberately digest-EXCLUDED), this field is
    // VALUE-BEARING money data and IS included in
    // `canonicalRowDigestFields` (`app/sharesight-sync-service.ts`) -- see
    // `buildDividendRowFromPayout`'s assignment below for the full
    // rationale. `fingerprint` (identity/dedupe) never depended on it
    // either way.
    exchangeRateDecimal: null,
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
  // BRK-009A: additive, absent-tolerant metadata carriage -- present when
  // Sharesight's `instrument.id`/`instrument.name`/`instrument.isin` were,
  // `null` otherwise. Never affects `fingerprint` below or the batch digest
  // (`canonicalRowDigestFields` in `app/sharesight-sync-service.ts`
  // deliberately omits these fields).
  normalized.sharesightInstrumentId = trade.sharesightInstrumentId;
  normalized.instrumentName = trade.instrumentName;
  normalized.isin = trade.isin;

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
 *
 * BRK-022 slice 2: exported (name unchanged) so
 * `app/sharesight-sync-service.ts` can compute the IDENTICAL
 * `source_reference` for a future-dated (pending, not-yet-staged) payout's
 * own `sharesight_pending_payouts` row -- the shared key is what lets a
 * later paid record (staged under this same key once the payout is no
 * longer future-dated) override the pending observation rather than
 * doubling it.
 */
export function payoutIdentityKey(payout: SharesightPayout): string {
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
  // BRK-009A: additive, absent-tolerant metadata carriage -- payouts carry a
  // FLAT `instrument_id` only (no nested `instrument` object, so no name/isin
  // evidence exists for this shape -- see `SharesightPayout`'s doc comment);
  // `instrumentName`/`isin` stay `null` for every payout-derived row. Never
  // affects `fingerprint`/the batch digest -- see `blankNormalizedRow`'s
  // comment.
  normalized.sharesightInstrumentId = payout.sharesightInstrumentId;
  // BRK-010 review (B1, LIVE-CONFIRMED): Sharesight's own conversion rate
  // for this payout, when it carried one -- INVERTED here
  // (`invertToPortfolioConversionRate`) from the raw wire field's own
  // (empirically confirmed inverse) convention into this codebase's
  // multiply-to-portfolio-base convention; see that function's doc comment
  // and `SharesightPayout.exchangeRateDecimal`'s live evidence in
  // `contracts.ts`. Absent-tolerant, never fabricated when Sharesight
  // didn't supply a rate. VALUE-BEARING (BRK-010 review B2): unlike
  // `sharesightInstrumentId`/`instrumentName`/`isin` above, this field IS
  // included in the batch digest (`canonicalRowDigestFields`,
  // `app/sharesight-sync-service.ts`) -- a corrected/late rate from
  // Sharesight must re-stage as a new batch, not silently reuse a stale
  // one; the row's own `fingerprint` (identity/dedupe) is unaffected
  // either way (payout identity never depended on this field).
  normalized.exchangeRateDecimal = invertToPortfolioConversionRate(
    payout.exchangeRateDecimal,
  );
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
 * there is no "not yet due" state to wait out.
 *
 * BRK-022 slice 2: exported (name unchanged) so
 * `app/sharesight-sync-service.ts` can identify the SAME set of payouts
 * this module skips from staging and record them instead as
 * `sharesight_pending_payouts` observations -- one shared predicate, never
 * a second hand-written copy that could silently drift from this one. */
export function isFutureUnconfirmedPayout(
  payout: SharesightPayout,
  today: string,
): boolean {
  return payout.id === null && payout.paidOnDate > today;
}

/**
 * `payoutIdentityKey` -> how many payouts in the given list share it (1 = no
 * collision). Computed once, up front, over the WHOLE fetch's stageable set
 * (confirmed payouts and past-dated unconfirmed payouts alike -- see the
 * BRK-005C block comment on why they now share one identity scheme) so
 * `buildPayoutRow` can look up any given payout's own collision count
 * without recomputing it per row.
 *
 * BRK-022 slice 2 review round (F2): exported (name unchanged) so
 * `app/sharesight-sync-service.ts` can run the SAME collision check over its
 * own future-dated (pending) payout candidate set -- a completely separate
 * list from this module's `stageablePayouts` -- rather than a second
 * hand-written key-counting copy that could silently drift from this one.
 */
export function countPayoutKeyCollisions(
  payouts: readonly SharesightPayout[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const payout of payouts) {
    const key = payoutIdentityKey(payout);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Shared symbol+exchange normalisation (trim + uppercase both sides, empty
 * string for a null exchange alias) -- used by `tradeCurrencyByInstrumentKey`/
 * `resolvedCurrencyByInstrumentKey`/`payoutSecurityCurrencyProxy` below, and
 * exported for BRK-022 slice 2's pending-payout security resolution
 * (`app/sharesight-sync-service.ts`'s tier-2 symbol+exchange match against
 * `portfolio_securities.source_symbol`/`source_exchange_alias`) so both
 * call sites share ONE normalisation convention rather than risking silent
 * drift between two hand-written copies.
 */
export function instrumentMatchKey(
  symbol: string,
  exchangeAlias: string | null,
): string {
  return `${symbol.trim().toUpperCase()}|${(exchangeAlias ?? "").trim().toUpperCase()}`;
}

/**
 * BRK-010 review finding B4: a SECONDARY evidence source for
 * `payoutSecurityCurrencyProxy` -- a trade for the same instrument
 * (preferring the `sharesight_instrument` id when both sides carry one,
 * else `symbol|market`) present in THIS SAME fetch. A trade's currency IS
 * its security's currency, by construction, so this is genuine evidence,
 * not a guess -- but see `payoutSecurityCurrencyProxy`'s own doc comment
 * (round 3) for why REAL DB-resolved evidence (`resolvedCurrencyByInstrumentKey`
 * below) is always consulted FIRST, and why there is no further fallback
 * once both are exhausted.
 */
function tradeCurrencyByInstrumentKey(
  trades: readonly SharesightTrade[],
): ReadonlyMap<string, string> {
  const byInstrumentId = new Map<string, string>();
  const bySymbolMarket = new Map<string, string>();
  for (const trade of trades) {
    if (
      trade.sharesightInstrumentId &&
      !byInstrumentId.has(trade.sharesightInstrumentId)
    ) {
      byInstrumentId.set(trade.sharesightInstrumentId, trade.currencyCode);
    }
    const key = instrumentMatchKey(trade.instrumentCode, trade.marketCode);
    if (!bySymbolMarket.has(key)) bySymbolMarket.set(key, trade.currencyCode);
  }
  const merged = new Map<string, string>(bySymbolMarket);
  for (const [id, currency] of byInstrumentId) merged.set(`id:${id}`, currency);
  return merged;
}

/**
 * BRK-010 review round 3: the REAL-evidence counterpart to
 * `tradeCurrencyByInstrumentKey` above -- built from
 * `SharesightTransformInput.resolvedInstrumentCurrencies` (already-resolved
 * `securities.primary_currency_code`, queried by
 * `app/sharesight-sync-service.ts` before this pure transform runs), keyed
 * IDENTICALLY (`id:<sharesightInstrumentId>` and `SYMBOL|MARKET`) so
 * `payoutSecurityCurrencyProxy` can look up either evidence source with one
 * shared key-building convention.
 */
function resolvedCurrencyByInstrumentKey(
  resolved: readonly {
    sharesightInstrumentId: string | null;
    symbol: string;
    exchangeAlias: string | null;
    currencyCode: string;
  }[],
): ReadonlyMap<string, string> {
  const byInstrumentId = new Map<string, string>();
  const bySymbolMarket = new Map<string, string>();
  for (const row of resolved) {
    if (
      row.sharesightInstrumentId &&
      !byInstrumentId.has(row.sharesightInstrumentId)
    ) {
      byInstrumentId.set(row.sharesightInstrumentId, row.currencyCode);
    }
    const key = instrumentMatchKey(row.symbol, row.exchangeAlias);
    if (!bySymbolMarket.has(key)) bySymbolMarket.set(key, row.currencyCode);
  }
  const merged = new Map<string, string>(bySymbolMarket);
  for (const [id, currency] of byInstrumentId) merged.set(`id:${id}`, currency);
  return merged;
}

// BRK-010 review round 2 finding B2: `true` only for a genuinely present,
// non-zero decimal string -- a `null`/absent franking total (the
// overwhelmingly common shape for a foreign-currency payout, which is
// typically unfranked) is deliberately `false` here, never treated as
// "unverified" (nothing to be uncertain about). Malformed input degrades
// to `false` defensively (parse.ts already validates this field at the
// contract boundary, so this should never actually be reached malformed).
function isNonZeroDecimal(value: string | null): boolean {
  if (value === null) return false;
  try {
    return !isZero(parseDecimal(value));
  } catch {
    return false;
  }
}

/**
 * BRK-010 review finding B4, CORRECTED by review round 3 (BLOCKING): staging
 * cannot know a payout's SECURITY currency directly -- resolution (which
 * durably links an instrument to a `securities` row) runs later, as a
 * separate pass. This is a best-effort PROXY, in STRICT priority order:
 *
 *   1. REAL, DB-resolved evidence (`resolvedCurrencies`, built by
 *      `resolvedCurrencyByInstrumentKey` from
 *      `SharesightTransformInput.resolvedInstrumentCurrencies` --
 *      `securities.primary_currency_code` for an instrument this user has
 *      ALREADY linked, from ANY source, in this portfolio).
 *   2. Same-fetch TRADE evidence (`tradeCurrencies`,
 *      `tradeCurrencyByInstrumentKey`) -- consulted only when (1) found
 *      nothing.
 *   3. NOTHING (`null`). Unlike the pre-round-3 version, there is NO
 *      portfolio-base fallback here at all -- see the correction below.
 *
 * THE ROUND-3 CORRECTION: the removed fallback ("no same-fetch trade ->
 * guess the portfolio's own base currency") was wrong because "no
 * same-fetch trade" is the REALISTIC STEADY STATE, not a rare edge case.
 * `app/sharesight-sync-service.ts` re-fetches Sharesight's FULL trade list
 * every sync (no incremental/watermark narrowing), but for a security
 * whose only Sharesight evidence is ever payouts (a transferred-in
 * holding, an opening balance entered outside Sharesight, or any account
 * shape where Sharesight itself never recorded a matching trade),
 * same-fetch trade evidence is NEVER present, on ANY sync, forever -- and
 * the guessed portfolio-base target then wrongly read as "case B,
 * achievable" on EVERY sync. Once staged, NOTHING inside a batch can clear
 * a wrongly-fired `SHARESIGHT_PAYOUT_FX_RATE_MISSING`:
 * `app/security-resolution-service.ts`'s F1 self-heal
 * (`markConflictIssuesResolved`) filters `code = 'SECURITY_RESOLUTION_CONFLICT'`
 * ONLY -- it has never cleared this code, on any round of this task,
 * despite an earlier (also false) claim to the contrary that it did.
 * Re-resolution does not touch this issue; re-running accept does not
 * touch it; the ONLY way out was permanent exclusion (IMP-008) of a row
 * that may not actually need converting at all. This code must therefore
 * NEVER fire on a bare guess -- only on evidence real enough that the
 * block, once it fires, is trustworthy for the lifetime of the batch. When
 * genuinely NO evidence exists anywhere (a brand-new, payout-only
 * instrument with no resolved security yet), this function returns `null`
 * and the row simply stages with NO block at all --
 * `db/repositories/import-commit.ts`'s three-case model is the sole
 * AUTHORITATIVE gate (real DB-resolved `securities.primary_currency_code`,
 * evaluated fresh at commit time, after resolution has actually run) and
 * produces a batch-level 409 (`mapping_incomplete`), NOT a row-named
 * failure, if conversion turns out to be genuinely needed and impossible
 * then. This proxy's job is only
 * to raise that SAME conclusion EARLY, as a readiness block, when it can
 * do so on real evidence; it is never a substitute for that authoritative
 * check, and it must never invent evidence to approximate it ahead of
 * time.
 */
function payoutSecurityCurrencyProxy(
  payout: SharesightPayout,
  resolvedCurrencies: ReadonlyMap<string, string>,
  tradeCurrencies: ReadonlyMap<string, string>,
): string | null {
  const key = instrumentMatchKey(payout.symbol, payout.marketCode);
  if (payout.sharesightInstrumentId) {
    const byResolvedId = resolvedCurrencies.get(
      `id:${payout.sharesightInstrumentId}`,
    );
    if (byResolvedId) return byResolvedId;
  }
  const byResolvedSymbol = resolvedCurrencies.get(key);
  if (byResolvedSymbol) return byResolvedSymbol;

  if (payout.sharesightInstrumentId) {
    const byTradeId = tradeCurrencies.get(
      `id:${payout.sharesightInstrumentId}`,
    );
    if (byTradeId) return byTradeId;
  }
  return tradeCurrencies.get(key) ?? null;
}

/**
 * BRK-010 review round 2 finding B1, and round 3 SMALL-1/SMALL-2: a payout
 * paid in a currency other than its OWN SECURITY's currency (best-effort
 * proxy `targetCurrency`, see `payoutSecurityCurrencyProxy` -- `null` when
 * NO evidence exists at all, which never blocks: nothing here can tell
 * whether conversion would even be needed) stages with a blocking
 * `SHARESIGHT_PAYOUT_FX_RATE_MISSING` error issue when it carries no USABLE
 * `exchangeRateDecimal` -- but ONLY when conversion is actually ACHIEVABLE:
 * `targetCurrency === portfolioBaseCurrencyCode` (mirroring
 * `db/repositories/import-commit.ts`'s authoritative three-case model
 * exactly -- case B). When the proxy target itself differs from the
 * portfolio's base currency (case C -- e.g. an NZD-denominated security
 * receiving a USD payout inside an AUD-base portfolio), NO rate Sharesight
 * could ever supply would let this codebase convert the payout into the
 * security's own currency (the stored rate only ever converts
 * record-currency -> PORTFOLIO BASE), so a missing rate is NEVER a block
 * reason there -- the row must commit with its currency honestly recorded
 * and degrade to `mixed_currency` at read time
 * (`domain/dividends/history.ts`), never block on an unachievable
 * "fix" that resolving in Sharesight could never actually provide.
 *
 * "USABLE" (round 3 SMALL-1, replacing the earlier bare
 * `payout.exchangeRateDecimal !== null` presence check, corrected again in
 * round 4): the SAME `invertToPortfolioConversionRate` call that will
 * actually build `NormalizedImportRow.exchangeRateDecimal`, PLUS an
 * explicit non-positive check on its result, decides usability here --
 * covering missing (`null`), zero, malformed, and over-24dp-precision raw
 * rates via that call's own `null` return, and negative raw rates via the
 * added non-positive check (round 4 correction: a negative raw rate
 * inverts to a negative VALUE, not `null` -- `invertToPortfolioConversionRate`
 * only degrades `null`/zero/malformed/over-precision input to `null`, it
 * does not reject a well-formed negative decimal, so the bare `!== null`
 * check alone let a negative rate slip through as "usable"). All of these
 * shapes previously slipped through this gate as "present" only to
 * silently null out downstream and die at commit as a batch-level 409, not
 * a row-named failure. This also folds in round 2's separate ad hoc
 * negative-rate special case in `buildPayoutRow` below (removed -- SMALL-2:
 * this single code now covers "missing OR unusable", not two different
 * reasons under one name).
 *
 * A payout whose currency already matches its OWN security (e.g. a
 * USD-denominated security paying a USD dividend, in ANY portfolio base
 * currency) never blocks either -- no conversion is ever needed at the
 * security-native-currency level `domain/dividends/history.ts` operates in.
 * The row itself still stages (unlike the future-unconfirmed case above)
 * so its real facts stay visible and it can be excluded via IMP-008 to
 * commit the rest of the batch in the meantime; the block, when it DOES
 * fire, only prevents an unconverted foreign amount from ever reaching
 * `dividend_manual_records` -- it is a READINESS block, not a commit-time
 * one: a batch with an unresolved error-severity issue can never be marked
 * ready, so it never reaches commit at all. See `payoutSecurityCurrencyProxy`'s
 * doc comment (round 3) for the truth about what actually clears a
 * wrongly-fired instance of this issue within a batch: NOTHING -- which is
 * exactly why this function must only ever fire on real evidence.
 */
function payoutMissingFxRateIssue(
  payout: SharesightPayout,
  targetCurrency: string | null,
  portfolioBaseCurrencyCode: string,
): ImportIssue | null {
  if (
    targetCurrency === null ||
    payout.currencyCode === targetCurrency ||
    targetCurrency !== portfolioBaseCurrencyCode
  ) {
    return null;
  }
  const invertedRate = invertToPortfolioConversionRate(
    payout.exchangeRateDecimal,
  );
  // Round 4 correction: a NEGATIVE raw rate inverts to a negative VALUE, not
  // `null` (`invertToPortfolioConversionRate` only degrades `null`/zero/
  // malformed/over-precision input to `null` -- it does not reject a
  // negative one, since a negative decimal is itself well-formed). A
  // negative conversion factor is never usable (it would flip the sign of
  // real money), so it must be treated as unusable here too, alongside the
  // `null` case, even though `invertToPortfolioConversionRate` itself
  // returns a non-null string for it.
  if (invertedRate !== null && !isNegativeDecimal(invertedRate)) {
    return null; // a usable (present, positive) rate exists -- nothing to block on.
  }
  return {
    code: "SHARESIGHT_PAYOUT_FX_RATE_MISSING",
    severity: "error",
    message: `Sharesight payout for ${payout.symbol} paid ${payout.paidOnDate}, ${payout.amountDecimal} ${payout.currencyCode}, is in a currency other than this security's own (${targetCurrency}) and Sharesight did not supply a usable conversion rate -- resolve this in Sharesight (confirm the payout so it carries a valid exchange rate) then re-sync, or exclude this row to commit the rest of the batch in the meantime. A foreign-currency amount is never guessed or counted at 1:1.`,
  };
}

function buildPayoutRow(
  payout: SharesightPayout,
  rowNumber: number,
  portfolioName: string,
  today: string,
  keyCollisionCounts: ReadonlyMap<string, number>,
  targetCurrency: string | null,
  portfolioBaseCurrencyCode: string,
): SharesightPayoutTransformOutcome {
  if (isFutureUnconfirmedPayout(payout, today)) {
    // FUTURE-dated (not yet due): still no reliable "this really happened"
    // fact to stage as a transaction/dividend row -- skipped from THIS
    // batch, surfaced as a visible warning rather than silently dropped.
    // See the BRK-005C block comment above for why a PAST-dated null-id
    // payout, by contrast, stages.
    //
    // BRK-022 slice 2: wording corrected -- this payout is no longer simply
    // thrown away. `app/sharesight-sync-service.ts` records every payout
    // this predicate identifies as its own `sharesight_pending_payouts`
    // observation (an announced, not-yet-paid dividend, visible on the
    // Income screen once slice 3 lands), refreshed or withdrawn on every
    // subsequent sync until the real paid record replaces it under the same
    // identity key (`payoutIdentityKey`). The issue code/severity are
    // unchanged -- only the message's claim about what happens to the
    // payout is corrected.
    //
    // Review round correction (F4, 2026-09-04): the message used to assert
    // "has been recorded" unconditionally -- this pure, DB-free transform
    // cannot actually know that. Recording happens later, in
    // `app/sharesight-sync-service.ts`, and is not guaranteed: it is
    // best-effort (a DB failure surfaces via `pendingPayoutsError`, never
    // this issue) and, per the F2 collision rule, a payout that collides
    // with another future-dated payout sharing its identity key is
    // deliberately NOT recorded at all. The message now only states what
    // this module itself knows (not staged) and points at the sync summary
    // for the actual outcome, rather than asserting one.
    return {
      kind: "skipped",
      issue: {
        code: "SHARESIGHT_PAYOUT_UNCONFIRMED",
        severity: "warning",
        message: `Sharesight payout for ${payout.symbol} due ${payout.paidOnDate} is future-dated (not yet paid) and has no confirmed id -- not staged as a ledger row. Announced, not-yet-paid payouts are recorded separately by the sync; see the sync summary.`,
      },
    };
  }

  const key = payoutIdentityKey(payout);
  const collisionCount = keyCollisionCounts.get(key) ?? 1;
  const issues: ImportIssue[] = [];
  if (collisionCount > 1) {
    issues.push({
      code: "SHARESIGHT_PAYOUT_KEY_COLLISION",
      severity: "error",
      message: `Sharesight reported ${collisionCount} payouts for holding ${payout.holdingId} paid on ${payout.paidOnDate} -- these cannot be told apart automatically, so this import can never be marked ready, and every future sync will hit the same block until this is fixed. Resolve the duplicate inside Sharesight itself (merge or remove it so this holding reports exactly one payout for this date), then re-sync -- this batch itself can safely stay in your import history; it will never commit.`,
    });
  }
  const missingFxIssue = payoutMissingFxRateIssue(
    payout,
    targetCurrency,
    portfolioBaseCurrencyCode,
  );
  if (missingFxIssue) issues.push(missingFxIssue);
  // BRK-010 review round 2 finding B2 (product ruling): a foreign-to-its-
  // security payout with NONZERO franking is visible-but-never-blocking --
  // this warning names the unverified-currency reason; the derivation
  // (`domain/dividends/history.ts`) independently marks that record's
  // franking unknown regardless of whether this warning is ever resolved.
  // Never gated on "conversion achievable" (unlike `payoutMissingFxRateIssue`
  // above) -- the franking-currency question is unverified REGARDLESS of
  // whether Sharesight's rate happens to be usable for the CASH figure.
  // Round 3: gated on `targetCurrency !== null` -- with genuinely no
  // evidence of the security's own currency, this codebase cannot claim
  // the payout's currency "differs from this security's own" at all, so it
  // must not warn on a guess either.
  if (
    targetCurrency !== null &&
    payout.currencyCode !== targetCurrency &&
    isNonZeroDecimal(payout.frankingCreditsDecimal)
  ) {
    issues.push({
      code: "SHARESIGHT_PAYOUT_FRANKING_CURRENCY_UNVERIFIED",
      severity: "warning",
      message: `Sharesight payout for ${payout.symbol} paid ${payout.paidOnDate} is in a currency other than this security's own (${targetCurrency}) and carries a non-zero franking credit -- whether Sharesight reports foreign-payout franking in AUD or in the payout's own currency is unverified, so this record's franking is treated as unknown rather than trusted or converted. The cash amount itself is unaffected.`,
    });
  }

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
   * BRK-010 review round 3 (BLOCKING CORRECTION): every instrument this
   * user has ALREADY resolved a security for, in this portfolio, from ANY
   * source (an earlier Sharesight sync or a CSV import) --
   * `app/sharesight-sync-service.ts` queries this via
   * `db/repositories/security-resolution.ts`'s
   * `loadResolvedPortfolioInstrumentCurrencies` BEFORE calling this pure
   * transform. `payoutSecurityCurrencyProxy` prefers this REAL evidence
   * over the same-fetch trade heuristic below, and NEITHER is ever a
   * portfolio-base guess (see that function's doc comment for why the
   * previous fallback-to-portfolio-base was wrong). Optional, defaulting to
   * `[]` (no DB evidence) -- every caller from before this round (tests
   * exercising unrelated behaviour in `tests/brk-005.test.ts`/
   * `tests/brk-009a.test.ts`) keeps compiling/behaving unchanged; the one
   * REAL caller, `app/sharesight-sync-service.ts`, always supplies the
   * genuine query result.
   */
  resolvedInstrumentCurrencies?: readonly {
    sharesightInstrumentId: string | null;
    symbol: string;
    exchangeAlias: string | null;
    currencyCode: string;
  }[];
  /**
   * BRK-010: the LOCAL portfolio's own base currency
   * (`portfolios.base_currency_code`) -- used ONLY to decide whether a
   * payout's proxy TARGET currency is achievable (`=== this value`), never
   * as a currency-proxy fallback itself (see `payoutSecurityCurrencyProxy`'s
   * doc comment -- round 3 removed that fallback entirely). Trades never
   * consult this directly (their FX is resolved separately, at commit
   * time, via the pre-existing `purchaseExchangeRate`/ledger mechanism).
   */
  portfolioBaseCurrencyCode: string;
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

  const tradeCurrencies = tradeCurrencyByInstrumentKey(input.trades);
  const resolvedCurrencies = resolvedCurrencyByInstrumentKey(
    input.resolvedInstrumentCurrencies ?? [],
  );
  for (const payout of input.payouts) {
    rowNumber += 1;
    const targetCurrency = payoutSecurityCurrencyProxy(
      payout,
      resolvedCurrencies,
      tradeCurrencies,
    );
    const outcome = buildPayoutRow(
      payout,
      rowNumber,
      input.portfolioName,
      today,
      keyCollisionCounts,
      targetCurrency,
      input.portfolioBaseCurrencyCode,
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
