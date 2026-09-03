import { parseDecimal } from "../calculations/decimal.ts";
import type { NormalizedImportRow } from "./strict-versioned-parser.ts";
// DIV-004: reuse DIV-001's documented proximity window rather than
// re-deriving a second "how close counts as a duplicate" constant.
import { PROXIMITY_WINDOW_DAYS } from "../dividends/history.ts";
// DIV-016 part C: the shared matching algorithm -- see that module's header
// comment for the owner rulings and tolerance decision it implements.
import {
  cashTotalsWithinTolerance,
  computeDividendCashTotal,
  computeDividendReconciliation,
} from "./dividend-reconciliation.ts";

type Decimal = { coefficient: bigint; scale: number };

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

function decimal(value: string): Decimal {
  if (!DECIMAL.test(value)) throw new Error(`Invalid decimal: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function power(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function align(left: Decimal, right: Decimal): [bigint, bigint] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * power(scale - left.scale),
    right.coefficient * power(scale - right.scale),
  ];
}

// BUG-011: decimal-STRING equality for the trade economic-identity check
// below -- "100", "100.00", and "100.000" must compare equal (AGENTS.md:
// never use JavaScript binary floating point for quantity/price
// comparisons). Reuses `decimal`/`align` rather than a naive string or
// `Number()` comparison.
//
// Review round F4: `decimal()` THROWS on a non-canonical string (a leading
// `-`/`+`, leading zeros, empty, exponent notation, a trailing `.`, or
// whitespace) with no try/catch anywhere on this preview path -- one such
// value reaching here would 500 the whole import review page. Every writer
// today goes through `prepareLedgerPosting`'s `CANONICAL_DECIMAL` (byte-
// identical to this file's `DECIMAL`), so this is unreachable in practice,
// but the blast radius (the entire preview, not just this one advisory
// warning) is large enough to guard defensively: an unparseable value is
// treated as NOT EQUAL, never thrown -- the warning silently fails to fire
// for that one comparison rather than breaking the page.
function decimalEqual(left: string, right: string): boolean {
  try {
    const [leftCoefficient, rightCoefficient] = align(
      decimal(left),
      decimal(right),
    );
    return leftCoefficient === rightCoefficient;
  } catch {
    return false;
  }
}

// BUG-013: safe wrappers around `computeDividendCashTotal`/
// `cashTotalsWithinTolerance` for the dividend economic-identity check
// below, mirroring `decimalEqual`'s F4 lesson above -- an incoming row's
// `normalized` fields are typed `string | null` but a row STAGED BEFORE a
// field existed (e.g. `frankingPerShare`/`totalCashDecimal`/
// `totalFrankingDecimal` predate IMP-006/BRK-005) deserializes its stored
// `normalized_fields_json` with that key genuinely ABSENT (`undefined`, not
// `null`), and an existing DB entry's decimal columns could in principle be
// a corrupt/non-canonical value. Either would otherwise throw out of
// `parseDecimal`/`parseDecimalResult` and 500 the whole import review page
// for one bad comparison. Failure is treated as "no comparable amount" /
// "not within tolerance" -- the warning silently fails to fire for that one
// comparison rather than breaking the page, exactly like `decimalEqual`.
//
// `safeComputeDividendCashTotal` is EXPORTED (review round, ruling 2): the
// caller (`app/import-actions.ts`'s `loadReview`) computes the SAME
// `cashTotalDecimal`/`frankingTotalDecimal` shape from raw DB columns for
// EVERY row in the now-widened `existingManualRows` query -- a per-share
// row's `shares_decimal`/`dividend_per_share_decimal` is exactly as exposed
// to a corrupt/non-canonical value as any other decimal column this file
// already guards, and the widened query is NEW exposure (the pre-widening
// query selected no decimal columns at all). Exporting the ALREADY-TESTED
// wrapper avoids a second, driftable reimplementation at that call site.
export function safeComputeDividendCashTotal(fields: {
  totalCashDecimal: string | null;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
}): string | null {
  try {
    return computeDividendCashTotal(fields);
  } catch {
    return null;
  }
}

function safeCashTotalsWithinTolerance(left: string, right: string): boolean {
  try {
    return cashTotalsWithinTolerance(left, right);
  } catch {
    return false;
  }
}

// BUG-014 correction round 3: the bound a TOTALS-mode amount is actually
// validated against -- `parseDecimal`'s "input" limits (24 fractional digits /
// 64 total, `domain/calculations/decimal.ts`'s `DECIMAL_LIMITS`), referenced
// through the parse function itself rather than restated as a number here.
//
// Round 2 validated a totals-mode value against `parseDecimalResult`'s WIDER
// 96-scale "result" bound instead (via a self-compare through
// `safeCashTotalsWithinTolerance`), reasoning that a transported total is a
// result, not a fresh input. That reasoning was wrong about where the value
// ENDS UP: a staged totals-mode amount is stored verbatim in
// `dividend_manual_records.total_cash_decimal` and read back through
// `parseDecimal` (`domain/dividends/history.ts`), so 24 -- not 96 -- is the
// only scale this system can actually carry for a stored dividend amount.
// `db/repositories/dividends.ts`'s insert builder now enforces exactly that
// bound at the write boundary; this makes the preview WARN about the same
// value the commit will reject, rather than passing a 25-to-96-digit total
// through silently and only failing later.
function parsesWithinStoredAmountBounds(value: string): boolean {
  try {
    parseDecimal(value);
    return true;
  } catch {
    return false;
  }
}

// BUG-014: reuses `safeComputeDividendCashTotal` above (never re-derives the
// parsing logic) and adds only a diagnosis of WHY the result came back
// `null`, for the two DIV-016C reconciliation-candidate sites below.
// `computeDividendCashTotal` returns `null` from a genuinely clean early
// return in exactly one shape: `totalCashDecimal` strictly `null` AND
// (`sharesDecimal` strictly `null` OR `dividendPerShareDecimal` strictly
// `null`) -- anything else that still comes back `null` here (a legacy
// `undefined` field slipping past those `=== null` guards, a non-canonical
// stored string, an over-scale value) must have thrown inside
// `safeComputeDividendCashTotal`'s try block instead. `malformed` is true
// only for that second, genuinely-unexpected case -- a row/candidate simply
// never carrying enough data is not malformed, and must stay silent exactly
// as it always has.
//
// BUG-014 CORRECTION ROUND (B1, BLOCKING): the check above is necessary but
// NOT sufficient. `computeDividendCashTotal`'s TOTALS-mode branch (used
// whenever `totalCashDecimal !== null`) returns that field VERBATIM --
// `parseDecimal`/`parseDecimalResult` are never called on it, so it can
// NEVER throw regardless of how malformed the stored/staged string is (a
// trailing space, a non-canonical `+`/leading-zero form, or a value whose
// scale exceeds even `parseDecimalResult`'s wide 96-scale/256-digit "result"
// bound -- see `domain/calculations/decimal.ts`'s `DECIMAL_LIMITS`). Without
// this second check, such a value came back `cashTotalDecimal !== null` /
// `malformed: false` -- reported as a clean, comparable amount -- and then
// reached `cashTotalsWithinTolerance` (via `computeDividendReconciliation`,
// or the raw compare below) for the first time, where it WOULD throw,
// 500ing the page or crashing commit-time `revalidate()`. Fixed by parsing
// that verbatim value here instead of trusting it.
//
// CORRECTION ROUND 3 (reviewer F1): round 2 parsed it through
// `safeCashTotalsWithinTolerance`'s self-compare, i.e. against
// `parseDecimalResult`'s WIDER 96-scale "result" bound, so a 25-to-96-digit
// totals value still passed here as clean -- and, since a staged totals
// amount is PERSISTED verbatim and read back through `parseDecimal` (24
// scale), such a value committed successfully and then crashed `/income`
// forever. It is now bounded by `parseDecimal` itself
// (`parsesWithinStoredAmountBounds`), matching both the read path and
// `db/repositories/dividends.ts`'s insert boundary. Per-share-mode values are
// covered by the existing throw-inside-the-try-block path above (each operand
// is `parseDecimal`d) plus the self-compare on their computed product; this
// covers the ONE shape that path structurally cannot.
function safeComputeDividendCashTotalDiagnosed(fields: {
  totalCashDecimal: string | null;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
}): { cashTotalDecimal: string | null; malformed: boolean } {
  const cashTotalDecimal = safeComputeDividendCashTotal(fields);
  if (cashTotalDecimal !== null) {
    // The branch condition MIRRORS `computeDividendCashTotal`'s own
    // (`totalCashDecimal !== null` selects the verbatim-passthrough branch),
    // so each mode is validated against the bound that actually applies to
    // its result:
    //  - TOTALS mode: the value is the staged/stored string itself and will
    //    be persisted verbatim, so it is bounded by `parseDecimal`'s "input"
    //    limits -- the same bound the read path and the insert builder use
    //    (correction round 3; round 2 wrongly used the wider 96-scale
    //    "result" bound here -- see `parsesWithinStoredAmountBounds`).
    //  - PER-SHARE mode: the value is a COMPUTED product of two already-
    //    `parseDecimal`-validated operands, so its scale can legitimately
    //    reach 48 and the wider "result" bound is the correct one; the
    //    self-compare also re-checks it can survive the actual match-time
    //    parse.
    const withinBound =
      fields.totalCashDecimal !== null
        ? parsesWithinStoredAmountBounds(cashTotalDecimal)
        : safeCashTotalsWithinTolerance(cashTotalDecimal, cashTotalDecimal);
    if (!withinBound) {
      return { cashTotalDecimal: null, malformed: true };
    }
    return { cashTotalDecimal, malformed: false };
  }
  const genuinelyAbsent =
    fields.totalCashDecimal === null &&
    (fields.sharesDecimal === null || fields.dividendPerShareDecimal === null);
  return { cashTotalDecimal: null, malformed: !genuinelyAbsent };
}

function add(left: string, right: string): string {
  const a = decimal(left);
  const b = decimal(right);
  const [leftCoefficient, rightCoefficient] = align(a, b);
  const scale = Math.max(a.scale, b.scale);
  return normalize({ coefficient: leftCoefficient + rightCoefficient, scale });
}

function subtract(left: string, right: string): string | null {
  const a = decimal(left);
  const b = decimal(right);
  const [leftCoefficient, rightCoefficient] = align(a, b);
  if (leftCoefficient < rightCoefficient) return null;
  return normalize({
    coefficient: leftCoefficient - rightCoefficient,
    scale: Math.max(a.scale, b.scale),
  });
}

function normalize(value: Decimal): string {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

// Plain calendar-day difference, matching `domain/dividends/history.ts`'s
// private `daysBetween` exactly (kept local rather than exported/shared,
// since it is a two-line date-math primitive, not shared business logic --
// only the proximity WINDOW constant is reused, per DIV-004's instruction
// not to re-derive that).
function daysBetweenDates(a: string, b: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / msPerDay,
  );
}

// Review round (post-BUG-013): the EXACT `source_reference` a row would
// commit under (`db/repositories/import-commit.ts`'s shared
// `` `import-fingerprint:${row.normalizedFingerprint ?? row.id}` `` for both
// the trade and dividend branches), scoped by portfolio the same way both
// `existingDividendSourceReferences` and the new `existingTradeSourceReferences`
// sets key their entries -- a single shared key builder so the two never
// drift out of sync with each other or with `import-commit.ts`'s own
// construction.
function sourceReferenceKey(portfolioId: string, fingerprint: string): string {
  return `${portfolioId}::import-fingerprint:${fingerprint}`;
}

export type ImportReconciliationRow = Readonly<{
  id: string;
  physicalRowNumber: number;
  rowClass:
    "portfolio_security_definition" | "transaction" | "blank" | "unsupported";
  normalized: NormalizedImportRow;
  fingerprint: string;
  targetPortfolioId?: string | null;
  targetPortfolioSecurityId?: string | null;
}>;

export type ImportPreviewPortfolio = Readonly<{
  id: string;
  name: string;
  homeCurrencyCode: string;
  historyCompleteFrom?: string | null;
}>;

export type ImportPreviewSecurityCandidate = Readonly<{
  id: string;
  portfolioId: string;
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  securityId: string | null;
}>;

export type ImportPreviewMappingDecision = Readonly<{
  kind: "portfolio" | "security" | "currency" | "transaction_type" | "fx";
  sourceKey: string;
  scope: "row" | "batch" | "user_future";
  targetId?: string | null;
  targetValue?: string | null;
}>;

export type ImportReconciliationIssue = Readonly<{
  code:
    | "PORTFOLIO_MAPPING_REQUIRED"
    | "PORTFOLIO_MAPPING_INVALID"
    | "SECURITY_MAPPING_REQUIRED"
    | "SECURITY_MAPPING_AMBIGUOUS"
    | "FX_DIRECTION_REQUIRED"
    | "FX_RATE_INCOMPLETE"
    | "DUPLICATE_ROW"
    | "OVERSELL"
    | "INCOMPLETE_HISTORY"
    | "ROW_UNSUPPORTED"
    | "DIVIDEND_NEAR_EXISTING_ENTRY"
    // BUG-011: advisory, non-blocking warning that an incoming buy/sell
    // row's economic identity (security + type + trade date + quantity +
    // price) exactly matches an EXISTING posted transaction -- see
    // `ImportPreviewExistingTradeEntry`'s doc comment for the cross-route
    // duplicate this guards against and why it is never an automatic skip.
    | "TRADE_NEAR_EXISTING_ENTRY"
    // BUG-011 review round F2: the caller (`app/import-actions.ts`) caps how
    // many existing posted trades it loads for the check above; exceeding
    // the cap degrades that check to "not computed" rather than silently
    // truncating the comparison set (which could produce a false negative
    // -- a real duplicate missed because its match fell outside the
    // truncated set -- indistinguishable from a genuine non-match). This
    // batch-level, no-`rowId` info issue makes that degraded state visible
    // rather than silent.
    | "TRADE_DUPLICATE_CHECK_UNAVAILABLE"
    // BUG-013: the dividend equivalent of TRADE_NEAR_EXISTING_ENTRY --
    // advisory, non-blocking warning that an incoming dividend row's
    // ECONOMIC IDENTITY (security + exact payment date + cash-total amount,
    // within DIV-016C's own tolerance) matches an EXISTING dividend_manual_
    // records row from ANY route/batch (not just owner-typed ones -- see
    // `ImportPreviewExistingDividendEntry`'s doc comment for why the caller
    // widened its filter). Distinct from `DIVIDEND_NEAR_EXISTING_ENTRY`
    // (DIV-004), which is a looser payment-date-PROXIMITY-only heuristic
    // with no amount check and (before this task) never saw an
    // import-sourced existing row at all.
    | "DIVIDEND_MATCHES_EXISTING_ENTRY"
    // BUG-013: mirrors TRADE_DUPLICATE_CHECK_UNAVAILABLE -- the caller's own
    // comparison-set cap for the query(ies) backing `existingDividendEntries`
    // was exceeded, so BOTH the check above and DIV-004's proximity check
    // were not computed this time (the same widened, now-larger query feeds
    // both). Batch-level, no `rowId`, `info` severity, never blocking.
    | "DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE"
    // DIV-016 part C: advisory, preview-only disclosure of the reconciliation
    // this batch's commit would apply (PROPOSED) or could not safely decide
    // (AMBIGUOUS) -- see `ImportPreviewDividendReconciliationCandidate`'s doc
    // comment for scope and `domain/imports/review.ts` for why these codes,
    // like `DIVIDEND_NEAR_EXISTING_ENTRY`, are excluded from `previewVersion`.
    | "DIVIDEND_RECONCILIATION_PROPOSED"
    | "DIVIDEND_RECONCILIATION_AMBIGUOUS"
    // DIV-016 part C, review round 1 B1 (BLOCKING): a row whose OWN
    // cross-batch identity was already committed in a PRIOR import can
    // never actually reconcile (only a row THIS batch actually inserts can
    // supersede a manual record) -- this code states that truth instead of
    // a false `DIVIDEND_RECONCILIATION_PROPOSED` promise. See the matching
    // block's own comment in `createImportReconciliationPreview` below.
    | "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE"
    // BUG-014: an incoming STAGED dividend row could not be checked against
    // `input.reconciliationCandidates` at all, because its own comparable
    // cash total genuinely could not be computed -- either a legacy
    // `normalized_fields_json` blob predating a field (deserializes to
    // `undefined`, not `null`) or a non-canonical/over-scale value slipped
    // past a prior writer's validation. Distinct from the SILENT, EXPECTED
    // `null` `computeDividendCashTotal` already returns when a row simply
    // never carried enough data (both `totalCashDecimal` and one of
    // `sharesOwned`/`costPerShare` are genuinely absent, i.e. strictly
    // `null`) -- that case is not this code; only an actually-thrown parse
    // failure is. Row-linked, derived purely from `evidence.rows` (present
    // on every caller, not a page-only-supplied signal), so unlike the
    // codes above it is NOT excluded from `previewVersion` hashing -- see
    // `domain/imports/review.ts`.
    | "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE"
    // BUG-014: the DB-sourced analog -- an existing
    // `dividend_manual_records` reconciliation candidate's stored decimal
    // columns could not be parsed (a corrupt/non-canonical value, or one
    // whose scale exceeds `parseDecimal`'s bound even though
    // `db/repositories/dividends.ts`'s `isDecimalString` does not enforce
    // that bound at write time). The candidate is excluded from the
    // matching pool entirely rather than fabricating a comparable amount.
    // Batch-level (no `rowId`): depends on the page-only-supplied
    // `input.reconciliationCandidates`, so -- like
    // `DIVIDEND_RECONCILIATION_PROPOSED` et al. -- it IS excluded from
    // `previewVersion` hashing; see `domain/imports/review.ts`.
    | "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE";
  severity: "error" | "warning" | "info";
  rowId?: string;
  physicalRowNumber?: number;
  sourceKey?: string;
  message: string;
}>;

// DIV-004: an existing (already-persisted, pre-this-batch) dividend fact
// used to warn the reviewer that an incoming CSV dividend row looks like a
// probable duplicate BEFORE they commit it -- never a hard block, since it
// is only a proximity heuristic, not a certain duplicate (matching the
// FRANKING_ON_NON_DIVIDEND precedent for a non-blocking dividend-row
// warning).
//
// BUG-013 CORRECTION: this type previously carried a doc comment claiming it
// "deliberately excludes previously IMPORTED rows: an imported-vs-imported
// near-match is cross-batch dedupe's job" -- that claim was the confirmed
// root cause of a SILENT cross-route dividend double-commit (see TASKS.md's
// BUG-013 entry). A dividend's `source_reference` is a route-specific
// fingerprint (a Sharesight payout identity key for one route, a sha256 over
// CSV fields for the other) that can never collide across routes, so
// "cross-batch dedupe" never actually caught an imported-vs-imported
// cross-route match at all -- the exclusion above just made that gap
// invisible too. The caller (`app/import-actions.ts`) now includes every
// non-superseded `dividend_manual_records` row regardless of route/batch,
// and this type carries the additional amount/franking/currency fields the
// economic-identity check (`DIVIDEND_MATCHES_EXISTING_ENTRY`) needs.
export type ImportPreviewExistingDividendEntry = Readonly<{
  portfolioSecurityId: string;
  paymentDate: string;
  // BUG-013: comparable cash total (see `computeDividendCashTotal`) for the
  // economic-identity check (`DIVIDEND_MATCHES_EXISTING_ENTRY`) below.
  // Optional/nullable: a `dividend_receipts` entry never carries this (that
  // table is a provider-observed fact outside the CSV/Sharesight IMPORT
  // routes this task's cross-route gap is about -- out of scope, see
  // `ImportPreviewDividendReconciliationCandidate`'s established precedent
  // for the same narrower dividend_manual_records-only scoping), and a
  // dividend_manual_records row missing enough fields to compute one is
  // likewise `null`, never fabricated. Absent entirely for every caller
  // that predates this task (keeps DIV-004-only fixtures compiling
  // unchanged).
  cashTotalDecimal?: string | null;
  // BUG-013: comparable TOTAL franking credits, same derivation as
  // `cashTotalDecimal` but over the franking fields (`computeDividendCashTotal`
  // is a generic "total = given, or shares x per-unit" helper -- reused here
  // for franking, not just cash). `null`/absent when unknown. Used only to
  // SURFACE a franking discrepancy alongside a cash-total match, never to
  // decide the match itself -- franking legitimately differs between routes
  // (e.g. a 17-column CSV header reports no franking at all) without the
  // two rows being a different real distribution.
  frankingTotalDecimal?: string | null;
  // BUG-013: non-null only when this dividend_manual_records row recorded a
  // currency DIFFERENT FROM ITS OWN SECURITY's currency (Sharesight totals-
  // mode FX case B/C -- see `db/repositories/import-commit.ts`'s dividend
  // branch). Deliberately NOT compared against the incoming row's own
  // `normalized.currency` for an equality decision: that field is always
  // set on the incoming row's raw evidence regardless of whether it is
  // foreign to the SECURITY (a fact only resolvable via a DB lookup this
  // pure function does not have), so a direct equality check would be
  // comparing "declared row currency" against "confirmed-foreign-to-
  // security flag" and would misfire constantly (every native CSV row would
  // spuriously "differ" from a `null` here). Used only to surface, in the
  // warning message, that FX was involved on the EXISTING side when
  // present -- never to compute a currency match/mismatch verdict.
  currencyCode?: string | null;
}>;

// BUG-011: an existing POSTED buy/sell transaction (any source route,
// any prior batch), used to warn the reviewer that an incoming trade row
// looks like the same real-world trade already on the ledger BEFORE they
// commit it -- never a hard block. Root cause: Sharesight sync mints
// `import-fingerprint:sharesight-trade:<id>` and CSV import mints
// `import-fingerprint:<sha256 of normalized fields>` -- structurally
// disjoint `source_reference` key spaces that can never collide, so the
// existing exact-string dedupe (`db/repositories/import-commit.ts`) cannot
// catch the same real trade arriving twice through different routes. This
// warning is the recurrence-prevention decision surface: it is
// DELIBERATELY never an automatic skip, because production evidence found
// two LEGITIMATE same-security/date/quantity/price trades under distinct
// Sharesight trade ids (one parcel filled in two lots) -- an auto-skip
// would have silently dropped a real trade. `type`/`tradeDate` are compared
// exactly; `quantityDecimal`/`priceDecimal` are decimal STRINGS compared via
// `decimalEqual`, never binary floating point (AGENTS.md).
export type ImportPreviewExistingTradeEntry = Readonly<{
  portfolioSecurityId: string;
  type: "buy" | "sell";
  tradeDate: string;
  quantityDecimal: string;
  priceDecimal: string;
}>;

// DIV-016 part C: an existing OWNER-TYPED, non-superseded manual dividend
// record (`dividend_manual_records`, `import_batch_id IS NULL AND
// superseded_by_record_id IS NULL`) eligible to be matched and SUPERSEDED by
// an incoming Sharesight payout row. Deliberately narrower than
// `ImportPreviewExistingDividendEntry` above: `dividend_receipts` rows are
// never reconciliation candidates (only a manually entered fact can be
// superseded, per the DIV-016 owner ruling), and this shape carries the
// comparable cash amount the AMOUNT leg of the matching rule needs (see
// `domain/imports/dividend-reconciliation.ts`), not just security+date.
export type ImportPreviewDividendReconciliationCandidate = Readonly<{
  id: string;
  portfolioSecurityId: string;
  paymentDate: string;
  totalCashDecimal: string | null;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  // BUG-014 correction round (follow-up): display-only label (e.g.
  // `portfolio_securities.display_symbol`/`source_symbol`) for the
  // `DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE` warning message
  // -- this batch-level issue has no `rowId` for the review UI's row-fact
  // lookup to key off, so the message names the record itself instead.
  // Optional/nullable and never used for matching -- omitted entirely by a
  // caller/fixture that predates this field (message then falls back to
  // payment date alone), and never fabricated when the caller has no
  // symbol to offer.
  securitySymbol?: string | null;
}>;

export type ImportReconciliationPreview = Readonly<{
  ready: boolean;
  counts: Readonly<{
    transactionCreates: number;
    dividendCreates: number;
    candidateCreates: number;
    skips: number;
    unresolved: number;
  }>;
  projectedQuantities: Readonly<Record<string, string>>;
  unresolvedCandidates: readonly ImportPreviewSecurityCandidate[];
  // DIV-016 part C: advisory disclosure of the safe (unambiguous) proposed
  // reconciliations this batch's rows resolve to against
  // `input.reconciliationCandidates` -- see that field's doc comment for
  // scope. Always `[]` when `reconciliationCandidates` is omitted (never
  // fabricates a match without candidate evidence). Excluded from
  // `previewVersion` by `domain/imports/review.ts` -- see its doc comment.
  proposedReconciliations: readonly Readonly<{
    rowId: string;
    physicalRowNumber: number;
    manualRecordId: string;
    portfolioSecurityId: string;
    paymentDate: string;
  }>[];
  resolvedTargets: Readonly<
    Record<
      string,
      Readonly<{
        portfolioId: string;
        portfolioSecurityId: string | null;
        fxDirection: "native_to_home" | "home_to_native" | null;
      }>
    >
  >;
  issues: readonly ImportReconciliationIssue[];
}>;

export type ImportReconciliationInput = Readonly<{
  rows: readonly ImportReconciliationRow[];
  portfolios: readonly ImportPreviewPortfolio[];
  securityCandidates: readonly ImportPreviewSecurityCandidate[];
  decisions?: readonly ImportPreviewMappingDecision[];
  existingFingerprints?: ReadonlySet<string>;
  existingQuantities?: Readonly<Record<string, string>>;
  // DIV-004: existing owner-entered manual records (no `import_batch_id`)
  // and receipts, loaded by the caller, used to warn on a probable
  // near-duplicate dividend row before commit -- see
  // `ImportPreviewExistingDividendEntry`'s doc comment for scope.
  existingDividendEntries?: readonly ImportPreviewExistingDividendEntry[];
  // BUG-013: mirrors `existingTradeEntriesUnavailable` -- true when the
  // caller's own comparison-set cap for the query(ies) backing
  // `existingDividendEntries` was exceeded, so neither the economic-identity
  // check nor DIV-004's proximity check ran this time. Never both this AND
  // a non-empty `existingDividendEntries` at once.
  existingDividendEntriesUnavailable?: boolean;
  // BUG-011: existing posted buy/sell transactions (any source route),
  // loaded by the caller, used to warn on a probable cross-route duplicate
  // trade before commit -- see `ImportPreviewExistingTradeEntry`'s doc
  // comment for scope.
  existingTradeEntries?: readonly ImportPreviewExistingTradeEntry[];
  // BUG-011 review round F2: true when the caller's existing-trade query hit
  // its cap and therefore did NOT load the full comparison set -- raises
  // `TRADE_DUPLICATE_CHECK_UNAVAILABLE` instead of running the (now
  // unreliable) check. Never both this AND a non-empty `existingTradeEntries`
  // at once; the caller supplies exactly one signal.
  existingTradeEntriesUnavailable?: boolean;
  // DIV-016 part C: existing manual dividend rows eligible for reconciliation
  // -- see `ImportPreviewDividendReconciliationCandidate`'s doc comment.
  reconciliationCandidates?: readonly ImportPreviewDividendReconciliationCandidate[];
  // DIV-016 part C, review round 1 B1 (BLOCKING): the set of
  // `${portfolioId}::${sourceReference}` composite keys ALREADY committed
  // to `dividend_manual_records` from a PRIOR import (any batch) -- the
  // EXACT identity `db/repositories/import-commit.ts`'s dividend branch
  // checks before it ever reaches the supersede step. A row whose own
  // computed `import-fingerprint:<fingerprint>` identity is in this set can
  // never actually insert (the cross-batch idempotency short-circuit fires
  // first), so it is excluded from the reconciliation matching pool
  // entirely -- see `createImportReconciliationPreview`'s own comment at
  // the `freshRows`/`alreadyImportedRows` split for why.
  //
  // BUG-013 review round: this SAME set is now ALSO consulted earlier, in
  // the main per-row loop, to suppress `DIVIDEND_NEAR_EXISTING_ENTRY`/
  // `DIVIDEND_MATCHES_EXISTING_ENTRY` for a row already bound for this
  // exact commit-time skip -- warning on a row commit will discard anyway
  // is guaranteed noise (measured: 0 -> 252 warnings on a 126-row full
  // re-sync). See `dividendAlreadyBoundForSkip` in
  // `createImportReconciliationPreview`.
  existingDividendSourceReferences?: ReadonlySet<string>;
  // BUG-013 review round: the trade analog of `existingDividendSourceReferences`
  // just above -- `${portfolioId}::${sourceReference}` composite keys of
  // every EXISTING `transactions` row's `source_reference` (any status,
  // matching `db/repositories/import-commit.ts`'s own commit-time dedupe
  // predicate exactly, which likewise applies no `status` filter), used to
  // suppress `TRADE_NEAR_EXISTING_ENTRY` (BUG-011) for a row already bound
  // for an identical commit-time skip -- this check has been LIVE in
  // production with this exact noise property since BUG-011 shipped (the
  // 2026-09-01 batch staged 226 trades, committed 0; every one would have
  // warned under the pre-fix behaviour).
  existingTradeSourceReferences?: ReadonlySet<string>;
}>;

function decisionFor(
  decisions: readonly ImportPreviewMappingDecision[],
  kind: ImportPreviewMappingDecision["kind"],
  sourceKey: string,
  rowKey?: string,
): ImportPreviewMappingDecision | undefined {
  return [...decisions]
    .filter(
      (decision) =>
        decision.kind === kind &&
        (decision.sourceKey === sourceKey ||
          (decision.scope === "row" && decision.sourceKey === rowKey)),
    )
    .sort((left, right) => {
      const rank = { row: 0, batch: 1, user_future: 2 } as const;
      return rank[left.scope] - rank[right.scope];
    })[0];
}

function portfolioFor(
  row: ImportReconciliationRow,
  portfolios: readonly ImportPreviewPortfolio[],
  decisions: readonly ImportPreviewMappingDecision[],
): ImportPreviewPortfolio | null {
  const source = row.normalized.portfolio ?? "";
  const decision = decisionFor(decisions, "portfolio", source, row.id);
  if (decision?.targetId) {
    return (
      portfolios.find((portfolio) => portfolio.id === decision.targetId) ?? null
    );
  }
  if (row.targetPortfolioId !== undefined && row.targetPortfolioId !== null) {
    return (
      portfolios.find((portfolio) => portfolio.id === row.targetPortfolioId) ??
      null
    );
  }
  const matches = portfolios.filter(
    (portfolio) => normalized(portfolio.name) === normalized(source),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function securityKey(
  portfolioId: string,
  row: ImportReconciliationRow,
): string {
  const normalizedRow = row.normalized;
  return [
    portfolioId,
    normalized(normalizedRow.symbol ?? ""),
    normalized(normalizedRow.exchange ?? ""),
    normalized(normalizedRow.currency ?? ""),
  ].join("|");
}

export function createImportReconciliationPreview(
  input: ImportReconciliationInput,
): ImportReconciliationPreview {
  const decisions = input.decisions ?? [];
  const existingFingerprints = input.existingFingerprints ?? new Set<string>();
  // Review round (post-BUG-013): a row already bound for a commit-time
  // exact-`source_reference` dedupe SKIP (the SAME real staged content
  // re-committing -- e.g. a full re-sync of an already-fully-committed
  // account) needs neither cross-route advisory warning below, since commit
  // will skip it regardless of what it economically matches. Declared here
  // (rather than where each was previously read, later in this function) so
  // the per-row loop can consult them too; `existingDividendSourceReferences`
  // is the SAME set the DIV-016 part C reconciliation-pool split below
  // already used -- moved up, not duplicated.
  const existingDividendSourceReferences =
    input.existingDividendSourceReferences ?? new Set<string>();
  const existingTradeSourceReferences =
    input.existingTradeSourceReferences ?? new Set<string>();
  const issues: ImportReconciliationIssue[] = [];
  const unresolvedCandidates: ImportPreviewSecurityCandidate[] = [];
  const unresolvedCandidateIds = new Set<string>();
  const projectedQuantities: Record<string, string> = {};
  const resolvedTargets: Record<
    string,
    {
      portfolioId: string;
      portfolioSecurityId: string | null;
      fxDirection: "native_to_home" | "home_to_native" | null;
    }
  > = {};
  const holdings = new Map<string, string>();
  const seen = new Set(existingFingerprints);
  const resolvedRows: Array<{
    row: ImportReconciliationRow;
    portfolio: ImportPreviewPortfolio;
    membershipId: string;
  }> = [];
  let transactionCreates = 0;
  let dividendCreates = 0;
  let candidateCreates = 0;
  let skips = 0;
  let unresolved = 0;

  // BUG-011 review round F2: a batch-level (no `rowId`), informational
  // disclosure that the cross-route trade-duplicate check below could not
  // run this time -- never a silent skip. See `existingTradeEntriesUnavailable`'s
  // doc comment for why (the caller's own comparison-set cap).
  if (input.existingTradeEntriesUnavailable) {
    issues.push({
      code: "TRADE_DUPLICATE_CHECK_UNAVAILABLE",
      severity: "info",
      message:
        "This portfolio has too many existing trades to check for cross-route duplicates in this preview; the duplicate-trade warning was not computed this time.",
    });
  }

  // BUG-013: mirrors the trade disclosure above, for the dividend
  // comparison set.
  if (input.existingDividendEntriesUnavailable) {
    issues.push({
      code: "DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE",
      severity: "info",
      message:
        "This account has too many existing dividend records to check for near-duplicates in this preview; the dividend duplicate warnings were not computed this time.",
    });
  }

  for (const row of [...input.rows].sort((left, right) =>
    left.physicalRowNumber === right.physicalRowNumber
      ? left.id.localeCompare(right.id)
      : left.physicalRowNumber - right.physicalRowNumber,
  )) {
    if (row.rowClass === "blank") {
      skips += 1;
      continue;
    }
    if (row.rowClass === "unsupported") {
      unresolved += 1;
      issues.push({
        code: "ROW_UNSUPPORTED",
        severity: "error",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        message: "This row cannot be previewed until its format is supported.",
      });
      continue;
    }
    if (seen.has(row.fingerprint)) {
      skips += 1;
      issues.push({
        code: "DUPLICATE_ROW",
        severity: "warning",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        message:
          "This row duplicates an existing staged or committed row and will be skipped.",
      });
      continue;
    }
    seen.add(row.fingerprint);

    const portfolio = portfolioFor(row, input.portfolios, decisions);
    if (!portfolio) {
      unresolved += 1;
      issues.push({
        code:
          row.targetPortfolioId !== undefined
            ? "PORTFOLIO_MAPPING_INVALID"
            : "PORTFOLIO_MAPPING_REQUIRED",
        severity: "error",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        sourceKey: row.normalized.portfolio ?? "",
        message: "Select one of your portfolios before previewing this row.",
      });
      continue;
    }

    const isCash = row.normalized.cashEvent !== null;
    // BRK-010: a totals-mode Sharesight payout row's own cash currency is a
    // property of the CASH EVENT, not the security's identity (see
    // `db/repositories/security-resolution.ts`'s `linkResolvedSecurity` doc
    // comment for the matching resolution-time ruling) -- computed here,
    // ahead of its other use further down, so the candidate match below can
    // ignore currency for exactly this row shape. Narrowly scoped to
    // totals-mode (`totalCashDecimal` set) rather than every dividend row:
    // a CSV per-share dividend row has no established FX mechanism at all
    // (this task's `import-commit.ts` fix is likewise totals-mode-only), so
    // its pre-existing currency-matched candidate behaviour is unchanged.
    const isTotalsModeDividend =
      row.normalized.type === "dividend" &&
      (row.normalized.totalCashDecimal ?? null) !== null;
    let membershipId: string | null = null;
    if (!isCash) {
      const key = securityKey(portfolio.id, row);
      const decision = decisionFor(decisions, "security", key, row.id);
      const candidates = input.securityCandidates.filter(
        (candidate) =>
          candidate.portfolioId === portfolio.id &&
          normalized(candidate.sourceSymbol) ===
            normalized(row.normalized.symbol ?? "") &&
          normalized(candidate.sourceExchangeAlias ?? "") ===
            normalized(row.normalized.exchange ?? "") &&
          (isTotalsModeDividend ||
            normalized(candidate.sourceCurrencyCode) ===
              normalized(row.normalized.currency ?? "")),
      );
      const selectedTargetId =
        decision?.targetId ?? row.targetPortfolioSecurityId ?? null;
      membershipId =
        selectedTargetId ?? candidates[0]?.id ?? `candidate:${key}`;
      if (selectedTargetId) {
        const selectedCandidate = input.securityCandidates.find(
          (candidate) =>
            candidate.id === selectedTargetId &&
            candidate.portfolioId === portfolio.id,
        );
        if (!selectedCandidate || selectedCandidate.securityId === null) {
          unresolved += 1;
          issues.push({
            code: "SECURITY_MAPPING_REQUIRED",
            severity: "error",
            rowId: row.id,
            physicalRowNumber: row.physicalRowNumber,
            sourceKey: key,
            message:
              "The selected security mapping is not owned by this portfolio.",
          });
          continue;
        }
      } else if (candidates.length > 1) {
        unresolved += 1;
        issues.push({
          code: "SECURITY_MAPPING_AMBIGUOUS",
          severity: "error",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: key,
          message:
            "More than one owned security candidate matches; ticker alone is not enough.",
        });
        continue;
      } else if (
        candidates.length === 0 ||
        candidates[0]?.securityId === null
      ) {
        if (
          candidates.length === 0 &&
          !unresolvedCandidateIds.has(membershipId)
        ) {
          candidateCreates += 1;
        }
        unresolved += 1;
        const candidate = {
          id: membershipId,
          portfolioId: portfolio.id,
          sourceSymbol: row.normalized.symbol ?? "",
          sourceExchangeAlias: row.normalized.exchange,
          sourceCurrencyCode: row.normalized.currency ?? "",
          securityId: null,
        };
        if (!unresolvedCandidateIds.has(candidate.id)) {
          unresolvedCandidateIds.add(candidate.id);
          unresolvedCandidates.push(candidate);
        }
        issues.push({
          code: "SECURITY_MAPPING_REQUIRED",
          severity: "error",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: key,
          message: "Resolve this private security candidate before committing.",
        });
        continue;
      }
    }

    // Dividend rows never resolve FX at import time: `dividend_manual_records`
    // stores native per-share amounts only and DIV-001's read-time
    // derivation, not the importer, is responsible for any base-currency
    // conversion. `Purchase Exchange Rate` is unused/ignored on these rows.
    const isDividend = row.normalized.type === "dividend";

    // Review round (post-BUG-013, THE material follow-up): true when THIS
    // row's own commit-time `source_reference` already exists in
    // `dividend_manual_records` for this portfolio -- meaning commit will
    // SKIP it outright (the identical staged content re-committing, e.g. a
    // full re-sync of an already-fully-committed account), never actually
    // insert it. Both dividend advisory checks below are guaranteed noise on
    // such a row: measured on an owner-shaped fixture (18 securities x 7
    // quarterly payouts = 126 already-committed records, re-staged as a
    // full re-sync), warnings went from 0 to 252 -- DIVIDEND_NEAR_EXISTING_
    // ENTRY and DIVIDEND_MATCHES_EXISTING_ENTRY, one of EACH on every single
    // row -- with commit skipping all 126 regardless. A genuinely CROSS-
    // ROUTE duplicate has a DIFFERENT computed fingerprint/source_reference
    // (the whole reason this task exists -- the two routes' key spaces are
    // structurally disjoint), so it is NEVER present in this set and stays
    // fully detected; this suppression only silences the case where commit
    // was always going to skip the row anyway.
    const dividendAlreadyBoundForSkip = existingDividendSourceReferences.has(
      sourceReferenceKey(portfolio.id, row.fingerprint),
    );

    // DIV-004: a NON-BLOCKING proximity warning (mirrors FRANKING_ON_NON_
    // DIVIDEND -- readiness/commit are unaffected) when an incoming dividend
    // row falls within DIV-001's matching window of an EXISTING owner-typed
    // manual record or receipt for the SAME resolved security. By this
    // point `membershipId` (when non-null) is always a genuine, already-
    // resolved portfolio-security id -- every unresolved-security path above
    // already issued an error and `continue`d -- so this never fires for a
    // row still awaiting security resolution.
    if (
      isDividend &&
      !dividendAlreadyBoundForSkip &&
      membershipId !== null &&
      row.normalized.localTradeDate !== null
    ) {
      const paymentDate = row.normalized.localTradeDate;
      const nearExisting = (input.existingDividendEntries ?? []).some(
        (entry) =>
          entry.portfolioSecurityId === membershipId &&
          Math.abs(daysBetweenDates(entry.paymentDate, paymentDate)) <=
            PROXIMITY_WINDOW_DAYS,
      );
      if (nearExisting) {
        issues.push({
          code: "DIVIDEND_NEAR_EXISTING_ENTRY",
          severity: "warning",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: membershipId,
          message: `This dividend is within ${PROXIMITY_WINDOW_DAYS} days of an existing entry already recorded for this security -- check it is not a duplicate before committing.`,
        });
      }
    }

    // BUG-013: the dividend equivalent of BUG-011's TRADE_NEAR_EXISTING_ENTRY
    // -- an incoming dividend row whose ECONOMIC IDENTITY (resolved security
    // + EXACT payment date + cash-total amount, within DIV-016C's own
    // `cashTotalsWithinTolerance` tolerance) matches an EXISTING
    // dividend_manual_records row is a possible cross-route duplicate: the
    // same real distribution already imported by CSV (or Sharesight sync)
    // arriving again via the other route. Root cause: a dividend's
    // `source_reference` is `import-fingerprint:<fingerprint>`, and the
    // fingerprint itself is a Sharesight payout identity key
    // (`sharesight-payout:<portfolioId>:<holdingId>:<paidOnDate>`) for one
    // route and a sha256 over the CSV row's normalized fields for the
    // other -- structurally disjoint key spaces sharing no component, so
    // the exact-string dedupe in `db/repositories/import-commit.ts` can
    // never catch this cross-route case (see this codebase's TASKS.md
    // BUG-013 entry for the full investigation). DELIBERATELY non-blocking
    // for the identical reason BUG-011 is: a genuinely repeated real
    // distribution (e.g. two separate real payments happening to share a
    // date and amount) must stay importable on confirmation, never
    // auto-skipped or dropped.
    //
    // Uses `cashTotalsWithinTolerance` (DIV-016C's own established 1%
    // tolerance), not a stricter exact-decimal match: unlike a trade's
    // price/quantity (expected byte-identical for the same real fill), a
    // dividend's cash total can genuinely differ by rounding noise across
    // routes (a CSV per-share recombination vs. Sharesight's own totals-mode
    // figure) without being a different distribution -- see
    // `domain/imports/dividend-reconciliation.ts`'s header comment for the
    // full rationale this reuses rather than re-deriving.
    //
    // Franking/FX are NEVER part of the match decision (they legitimately
    // differ between routes -- e.g. a 17-column CSV header reports no
    // franking at all), but a detected franking difference is surfaced in
    // the message rather than silently ignored -- see
    // `ImportPreviewExistingDividendEntry`'s doc comment for why currency/FX
    // is disclosed (when recorded on the existing side) but never compared
    // for equality here.
    if (
      isDividend &&
      !dividendAlreadyBoundForSkip &&
      membershipId !== null &&
      row.normalized.localTradeDate !== null
    ) {
      const paymentDate = row.normalized.localTradeDate;
      const incomingCashTotal = safeComputeDividendCashTotal({
        totalCashDecimal: row.normalized.totalCashDecimal ?? null,
        sharesDecimal: row.normalized.sharesOwned,
        dividendPerShareDecimal: row.normalized.costPerShare,
      });
      if (incomingCashTotal !== null) {
        const incomingFrankingTotal = safeComputeDividendCashTotal({
          totalCashDecimal: row.normalized.totalFrankingDecimal ?? null,
          sharesDecimal: row.normalized.sharesOwned,
          dividendPerShareDecimal: row.normalized.frankingPerShare,
        });
        const matchingEntry = (input.existingDividendEntries ?? []).find(
          (entry) =>
            entry.portfolioSecurityId === membershipId &&
            entry.paymentDate === paymentDate &&
            (entry.cashTotalDecimal ?? null) !== null &&
            safeCashTotalsWithinTolerance(
              entry.cashTotalDecimal as string,
              incomingCashTotal,
            ),
        );
        if (matchingEntry) {
          const existingFrankingTotal =
            matchingEntry.frankingTotalDecimal ?? null;
          const notes: string[] = [];
          if (
            existingFrankingTotal !== null &&
            incomingFrankingTotal !== null
          ) {
            if (
              !safeCashTotalsWithinTolerance(
                existingFrankingTotal,
                incomingFrankingTotal,
              )
            ) {
              notes.push(
                "the recorded franking credits differ between the two records",
              );
            }
          } else if (existingFrankingTotal !== incomingFrankingTotal) {
            notes.push(
              "franking credits are recorded on only one of the two records",
            );
          }
          if ((matchingEntry.currencyCode ?? null) !== null) {
            notes.push(
              `the existing record was booked with a foreign-currency conversion (${matchingEntry.currencyCode})`,
            );
          }
          const noteSuffix =
            notes.length > 0
              ? ` Note: ${notes.join("; ")} -- this does not by itself mean these are different distributions, but check it before committing.`
              : "";
          issues.push({
            code: "DIVIDEND_MATCHES_EXISTING_ENTRY",
            severity: "warning",
            rowId: row.id,
            physicalRowNumber: row.physicalRowNumber,
            sourceKey: membershipId,
            message: `This dividend matches an existing record for the same security, payment date, and amount -- check this is not the same distribution already imported through a different route before committing.${noteSuffix}`,
          });
        }
      }
    }

    // BUG-011: an incoming buy/sell row whose ECONOMIC IDENTITY (resolved
    // security + type + trade date + quantity + price) exactly matches an
    // EXISTING posted transaction is a possible cross-route duplicate -- the
    // same real trade already imported by CSV (or Sharesight sync) now
    // arriving again via the other route, each minting a structurally
    // disjoint `source_reference` so the exact-string dedupe in
    // `db/repositories/import-commit.ts` can never catch it. DELIBERATELY
    // non-blocking (`severity: "warning"`, never affects `ready`): production
    // evidence found two LEGITIMATE trades under this exact identity (same
    // security/date/quantity/price, distinct Sharesight ids -- one parcel
    // filled in two lots), so an automatic skip here would silently drop a
    // real trade. By this point `membershipId` (when non-null) is always a
    // genuine, already-resolved portfolio-security id, matching the
    // DIVIDEND_NEAR_EXISTING_ENTRY precedent just above.
    //
    // Review round (post-BUG-013 follow-up ruling, applies retroactively to
    // this ALREADY-LIVE check): a row already bound for the identical
    // commit-time exact-`source_reference` SKIP needs no warning either --
    // the 2026-09-01 production batch staged 226 trades and committed 0 (a
    // full re-sync of an already-fully-committed account), so under the
    // pre-fix behaviour it would have warned on all 226. `tradeAlreadyBoundForSkip`
    // mirrors `dividendAlreadyBoundForSkip` above exactly: a genuinely
    // cross-route duplicate's fingerprint/source_reference is structurally
    // different (the reason this check exists at all) and is never in this
    // set, so cross-route detection is unweakened.
    const tradeAlreadyBoundForSkip = existingTradeSourceReferences.has(
      sourceReferenceKey(portfolio.id, row.fingerprint),
    );
    if (
      !isDividend &&
      !isCash &&
      !tradeAlreadyBoundForSkip &&
      membershipId !== null &&
      (row.normalized.type === "buy" || row.normalized.type === "sell") &&
      row.normalized.localTradeDate !== null &&
      row.normalized.sharesOwned !== null &&
      row.normalized.costPerShare !== null
    ) {
      const tradeType = row.normalized.type;
      const tradeDate = row.normalized.localTradeDate;
      const quantity = row.normalized.sharesOwned;
      const price = row.normalized.costPerShare;
      const matchesExisting = (input.existingTradeEntries ?? []).some(
        (entry) =>
          entry.portfolioSecurityId === membershipId &&
          entry.type === tradeType &&
          entry.tradeDate === tradeDate &&
          decimalEqual(entry.quantityDecimal, quantity) &&
          decimalEqual(entry.priceDecimal, price),
      );
      if (matchesExisting) {
        issues.push({
          code: "TRADE_NEAR_EXISTING_ENTRY",
          severity: "warning",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: membershipId,
          message: `This ${tradeType} matches an existing posted transaction for the same security, date, quantity, and price -- check this is not the same trade already imported through a different route before committing.`,
        });
      }
    }

    let fxDirection: "native_to_home" | "home_to_native" | null = null;
    if (
      !isDividend &&
      row.normalized.purchaseExchangeRate !== null &&
      row.normalized.currency !== portfolio.homeCurrencyCode
    ) {
      const fxKey = `${row.normalized.currency}->${portfolio.homeCurrencyCode}`;
      const fxDecision = decisionFor(decisions, "fx", fxKey, row.id);
      if (
        fxDecision?.targetValue !== "native_to_home" &&
        fxDecision?.targetValue !== "home_to_native"
      ) {
        unresolved += 1;
        issues.push({
          code: "FX_DIRECTION_REQUIRED",
          severity: "error",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: fxKey,
          message:
            "Confirm whether the supplied exchange rate converts native currency to home currency or is inverse.",
        });
      } else {
        fxDirection = fxDecision.targetValue;
      }
    } else if (
      !isDividend &&
      row.normalized.type !== null &&
      row.normalized.currency !== portfolio.homeCurrencyCode &&
      row.normalized.purchaseExchangeRate === null
    ) {
      issues.push({
        code: "FX_RATE_INCOMPLETE",
        severity: "warning",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        message:
          "No purchase exchange rate is available; native facts remain importable but home-currency basis is incomplete.",
      });
    }

    if (
      !issues.some(
        (issue) => issue.rowId === row.id && issue.severity === "error",
      )
    ) {
      resolvedTargets[row.id] = {
        portfolioId: portfolio.id,
        portfolioSecurityId: membershipId,
        fxDirection,
      };
    }

    resolvedRows.push({
      row,
      portfolio,
      membershipId:
        membershipId ?? `cash:${portfolio.id}:${row.normalized.currency ?? ""}`,
    });
    if (row.rowClass === "transaction") {
      if (isDividend) {
        dividendCreates += 1;
      } else {
        transactionCreates += 1;
      }
    }
  }

  for (const item of resolvedRows) {
    const row = item.row;
    if (
      row.rowClass !== "transaction" ||
      row.normalized.cashEvent !== null ||
      row.normalized.type === "dividend"
    )
      continue;
    const quantity = row.normalized.sharesOwned;
    if (quantity === null || row.normalized.type === null) continue;
    const current =
      holdings.get(item.membershipId) ??
      input.existingQuantities?.[item.membershipId] ??
      "0";
    if (row.normalized.type === "buy") {
      holdings.set(item.membershipId, add(current, quantity));
      continue;
    }
    const next = subtract(current, quantity);
    if (next === null) {
      unresolved += 1;
      issues.push({
        code: "OVERSELL",
        severity: "error",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        sourceKey: item.membershipId,
        message:
          "The sell quantity exceeds the quantity available in this preview; add opening history or correct the mapping.",
      });
      holdings.set(item.membershipId, "0");
    } else {
      holdings.set(item.membershipId, next);
    }
  }

  for (const [membershipId, quantity] of holdings) {
    projectedQuantities[membershipId] = quantity;
  }

  for (const portfolio of input.portfolios) {
    const firstSell = resolvedRows.find(
      ({ row, portfolio: rowPortfolio }) =>
        rowPortfolio.id === portfolio.id && row.normalized.type === "sell",
    );
    if (firstSell && portfolio.historyCompleteFrom === null) {
      issues.push({
        code: "INCOMPLETE_HISTORY",
        severity: "warning",
        rowId: firstSell.row.id,
        physicalRowNumber: firstSell.row.physicalRowNumber,
        message:
          "This preview contains a sell without a declared opening-history boundary; completeness remains unresolved.",
      });
    }
  }

  // DIV-016 part C: advisory-only preview disclosure of the reconciliation
  // this batch's commit would apply. Built from `resolvedRows` (rows that
  // already cleared portfolio/security resolution, in the SAME shape
  // `resolvedTargets` above reflects) rather than re-walking `input.rows`,
  // so a dividend row's `membershipId` here is always the identical,
  // genuinely-resolved portfolio-security id commit-time reconciliation
  // will use. Never blocks readiness (`PROPOSED`/`AMBIGUOUS`/`ALREADY_
  // IMPORTED_MANUAL_DUPLICATE` are `info`/`warning`, never `error`) --
  // reconciliation is a commit-time decision, not a precondition for
  // staging.
  //
  // B1 (review round 1 BLOCKING fix): a row whose OWN cross-batch identity
  // (`import-fingerprint:<fingerprint>`, the exact `source_reference`
  // `db/repositories/import-commit.ts`'s dividend branch checks against
  // `dividend_manual_records` BEFORE it ever reaches the supersede step)
  // already exists from a PRIOR import never actually inserts a new row --
  // the commit loop's pre-existing cross-batch idempotency short-circuit
  // fires first and `continue`s. Proposing a reconciliation for such a row
  // was a FALSE PROMISE: the owner would read "committing will supersede
  // the manual record," commit, and get neither -- a real double count left
  // silently in place. Fixed at the root: `dividendReconciliationRows` is
  // split into `freshRows` (eligible to actually insert and therefore
  // actually reconcile) and `alreadyImportedRows` (dedupe-bound, excluded
  // from the matching pool ENTIRELY -- so they can also never wrongly
  // consume/poison a manual candidate that a sibling fresh row could
  // otherwise have cleanly, unambiguously matched). Ruling (ORCHESTRATOR,
  // ambiguous-preview-vs-commit review B1): "Reconciliation supersedes ONLY
  // via rows the CURRENT batch actually inserts."
  const dividendReconciliationRowsAll = resolvedRows
    .filter(
      ({ row }) =>
        row.rowClass === "transaction" &&
        row.normalized.type === "dividend" &&
        row.normalized.cashEvent === null &&
        row.normalized.localTradeDate !== null,
    )
    .map(({ row, portfolio, membershipId }) => {
      // BUG-014: `computeDividendCashTotal` used to be called unguarded
      // here -- a staged row whose `normalized_fields_json` genuinely
      // lacked `sharesOwned` (deserializes to `undefined`, which sails past
      // the `=== null` guards) threw `Invalid decimal string.` straight out
      // of this pure function, 500ing the entire `/import` review page for
      // one bad row. A non-canonical/over-scale PER-SHARE-mode
      // (`sharesDecimal`/`dividendPerShareDecimal`) value is caught the same
      // way, bound by `parseDecimal`'s narrower "input" limit (scale 24,
      // 64 digits -- `domain/calculations/decimal.ts`'s `DECIMAL_LIMITS`).
      //
      // CORRECTION (BUG-014 correction round, B1): this comment previously
      // claimed "or carried a non-canonical/over-scale decimal" covered
      // EVERY case reaching this row, which was false for TOTALS-mode --
      // `computeDividendCashTotal` returns a non-null `totalCashDecimal`
      // VERBATIM, never parsing it, so a malformed totals-mode value never
      // threw here and sailed through as `malformed: false`.
      // `safeComputeDividendCashTotalDiagnosed` now additionally parses that
      // verbatim value through `parseDecimal` -- the SAME "input" bound
      // (scale 24, 64 digits) the per-share-mode path above is held to, and
      // the same bound `db/repositories/dividends.ts` enforces before the
      // amount can be stored and `domain/dividends/history.ts` re-parses it
      // at read time (correction round 3, reviewer F1: round 2 used
      // `parseDecimalResult`'s wider 96-scale "result" bound here, which let
      // a 25-to-96-digit total pass preview silently and then commit).
      // Both modes are now covered, by the one bound that applies to a
      // stored dividend amount.
      //
      // An unparseable value is now "cannot compare" -- the row still
      // stages and renders, it is simply excluded from the reconciliation
      // matching pool below (via the `cashTotalDecimal !== null` filter,
      // unchanged), and the malformed case additionally raises a visible
      // warning so the owner sees WHY, rather than the row silently
      // vanishing from consideration exactly like a benign no-data row
      // would.
      const { cashTotalDecimal, malformed } =
        safeComputeDividendCashTotalDiagnosed({
          totalCashDecimal: row.normalized.totalCashDecimal ?? null,
          sharesDecimal: row.normalized.sharesOwned,
          dividendPerShareDecimal: row.normalized.costPerShare,
        });
      if (malformed) {
        issues.push({
          code: "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
          severity: "warning",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: membershipId,
          // BUG-014 correction round: this dividend row has no per-field
          // edit affordance anywhere in the import review UI (see
          // `app/components/import-review.tsx`) -- "review the amount
          // fields before committing" told the owner to do something the
          // product cannot do. The two actual remedies: skip the row (IMP-
          // 008's "Skip this row" -- it will not be committed and can be
          // included again later), or fix the amount in the source file and
          // re-import as a new batch.
          message:
            "This dividend's cash total could not be read (a missing or unparseable amount field) -- it cannot be checked against existing manually entered records automatically. This row cannot be edited in place: skip it (\"Skip this row\", below) if you don't need it, or fix the amount in the source file and re-import.",
        });
      }
      return {
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        portfolioId: portfolio.id,
        portfolioSecurityId: membershipId,
        paymentDate: row.normalized.localTradeDate as string,
        sourceReference: `import-fingerprint:${row.fingerprint}`,
        cashTotalDecimal,
      };
    })
    .filter(
      (entry): entry is typeof entry & { cashTotalDecimal: string } =>
        entry.cashTotalDecimal !== null,
    );
  const freshRows = dividendReconciliationRowsAll.filter(
    (row) =>
      !existingDividendSourceReferences.has(
        `${row.portfolioId}::${row.sourceReference}`,
      ),
  );
  const alreadyImportedRows = dividendReconciliationRowsAll.filter((row) =>
    existingDividendSourceReferences.has(
      `${row.portfolioId}::${row.sourceReference}`,
    ),
  );
  // BUG-014: mirrors the staged-row fix above -- `computeDividendCashTotal`
  // used to be called unguarded here too, and this candidate set is
  // DB-sourced (`dividend_manual_records` decimal columns), so it is
  // exposed to a corrupt/non-canonical STORED value as well as a legacy
  // staged blob.
  //
  // CORRECTION (BUG-014 correction round, B1): this comment previously
  // claimed "`isDecimalString` does not bound scale, but `parseDecimal`
  // does (>24)" as if that were the ONE bound guarding every column here --
  // it is the bound for the PER-SHARE-mode columns (`shares_decimal`/
  // `dividend_per_share_decimal`) only. A TOTALS-mode `total_cash_decimal`
  // is never passed through `parseDecimal` at all (`computeDividendCashTotal`
  // returns it verbatim); `safeComputeDividendCashTotalDiagnosed` now parses
  // it explicitly, at that same `parseDecimal` "input" bound (scale 24, 64
  // digits) -- correction round 3, reviewer F1: round 2 bounded it at
  // `parseDecimalResult`'s wider 96 scale, which is not a scale this system
  // can store or read back. An unparseable candidate (either mode) is excluded
  // from matching (unchanged `cashTotalDecimal !== null` filter below) and
  // now also raises a visible, batch-level warning -- never a silent drop.
  const reconciliationCandidates = (input.reconciliationCandidates ?? []).map(
    (candidate) => {
      const { cashTotalDecimal, malformed } =
        safeComputeDividendCashTotalDiagnosed({
          totalCashDecimal: candidate.totalCashDecimal,
          sharesDecimal: candidate.sharesDecimal,
          dividendPerShareDecimal: candidate.dividendPerShareDecimal,
        });
      if (malformed) {
        // BUG-014 correction round (follow-up): this is a BATCH-level issue
        // (no `rowId`) -- `app/components/import-review.tsx`'s issue list
        // only attaches row-fact context (security/date) to a `rowId`-
        // linked issue, so without naming the record here the owner has no
        // way to find WHICH existing manually entered record this is about
        // besides the raw `sourceKey` (the record id, never rendered).
        // Names the payment date (always present) and the security symbol
        // (when the caller supplied one -- see
        // `ImportPreviewDividendReconciliationCandidate.securitySymbol`'s
        // doc comment; omitted rather than fabricated when unknown).
        const securityLabel = candidate.securitySymbol
          ? ` (${candidate.securitySymbol}, paid ${candidate.paymentDate})`
          : ` (paid ${candidate.paymentDate})`;
        issues.push({
          code: "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
          severity: "warning",
          sourceKey: candidate.id,
          message: `An existing manually entered dividend record${securityLabel} has a stored amount that could not be read -- it was excluded from automatic reconciliation matching; open and correct that record directly.`,
        });
      }
      return {
        id: candidate.id,
        portfolioSecurityId: candidate.portfolioSecurityId,
        paymentDate: candidate.paymentDate,
        cashTotalDecimal,
      };
    },
  );
  const dividendCandidatesWithCash = reconciliationCandidates.filter(
    (candidate): candidate is typeof candidate & { cashTotalDecimal: string } =>
      candidate.cashTotalDecimal !== null,
  );
  const dividendReconciliation = computeDividendReconciliation(
    freshRows,
    dividendCandidatesWithCash,
  );
  const rowById = new Map(freshRows.map((row) => [row.rowId, row]));
  const proposedReconciliations = dividendReconciliation.matches.map(
    (match) => {
      const source = rowById.get(match.rowId)!;
      return {
        rowId: match.rowId,
        physicalRowNumber: source.physicalRowNumber,
        manualRecordId: match.manualRecordId,
        portfolioSecurityId: source.portfolioSecurityId,
        paymentDate: source.paymentDate,
      };
    },
  );
  for (const match of proposedReconciliations) {
    issues.push({
      code: "DIVIDEND_RECONCILIATION_PROPOSED",
      severity: "info",
      rowId: match.rowId,
      physicalRowNumber: match.physicalRowNumber,
      sourceKey: match.manualRecordId,
      message:
        "This Sharesight dividend matches an existing manually entered record for the same security and payment date -- committing will supersede the manual record so the distribution is not double-counted.",
    });
  }
  for (const rowId of dividendReconciliation.ambiguousRowIds) {
    const source = rowById.get(rowId);
    if (!source) continue;
    issues.push({
      code: "DIVIDEND_RECONCILIATION_AMBIGUOUS",
      severity: "warning",
      rowId,
      physicalRowNumber: source.physicalRowNumber,
      sourceKey: source.portfolioSecurityId,
      message:
        "This dividend matches more than one existing entry (or an existing entry matches more than one incoming dividend) closely enough to reconcile automatically -- nothing will be linked automatically; check which record is correct before committing.",
    });
  }
  // B1 fix: a dedupe-bound row (its own source_reference already committed
  // from a PRIOR import) that WOULD otherwise have matched a manual
  // candidate gets the TRUTH instead of a false PROPOSED promise -- this
  // distribution already exists both as a previously-imported row and as a
  // manual row, and stays double-counted until the owner acts (delete the
  // manual row -- it is a deletable head -- or reverse the earlier batch and
  // re-import). Checked directly against the matching predicate (security +
  // payment date + tolerance), not through `computeDividendReconciliation`'s
  // ambiguity machinery -- this row can never actually reconcile regardless
  // of how many candidates it resembles, so "would it match at least one"
  // is the only relevant question.
  //
  // BUG-014 correction round (B1): uses the SAFE wrapper, not the raw
  // `cashTotalsWithinTolerance` this used to call directly. Both operands
  // here are already filtered through the (now self-validating)
  // `safeComputeDividendCashTotalDiagnosed` above, so neither should be able
  // to throw in practice -- this is defense-in-depth against a future
  // caller of this same loop shape getting that pre-validation wrong, not a
  // sign either operand is currently expected to be malformed.
  for (const row of alreadyImportedRows) {
    const wouldHaveMatched = dividendCandidatesWithCash.some(
      (candidate) =>
        candidate.portfolioSecurityId === row.portfolioSecurityId &&
        candidate.paymentDate === row.paymentDate &&
        safeCashTotalsWithinTolerance(
          row.cashTotalDecimal,
          candidate.cashTotalDecimal,
        ),
    );
    if (!wouldHaveMatched) continue;
    issues.push({
      code: "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE",
      severity: "warning",
      rowId: row.rowId,
      physicalRowNumber: row.physicalRowNumber,
      sourceKey: row.portfolioSecurityId,
      message:
        "This distribution was already imported in a previous batch AND exists as a manually entered record -- it remains double-counted. This commit will not reconcile them (only rows this batch actually inserts can supersede a manual record). Delete the manual record, or reverse the earlier import batch and re-import, to resolve it.",
    });
  }

  return {
    ready: !issues.some((issue) => issue.severity === "error"),
    counts: {
      transactionCreates,
      dividendCreates,
      candidateCreates,
      skips,
      unresolved,
    },
    projectedQuantities,
    unresolvedCandidates,
    proposedReconciliations,
    resolvedTargets,
    issues,
  };
}
