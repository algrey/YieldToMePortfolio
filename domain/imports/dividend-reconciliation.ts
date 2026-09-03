// DIV-016 part C: the Sharesight dividend-reconciliation matching rule.
//
// Owner rulings (TASKS.md DIV-016): "If I later synced with sharesight it
// should not double count" and "sharesight should take precedence from
// there forward". A manually entered dividend row and the same distribution
// arriving later via a Sharesight import must never both count as evidence,
// and once reconciled the Sharesight-sourced row is authoritative going
// forward (Part A's import-row edit block already prevents a manual edit
// from landing on top of an imported row -- see `db/repositories/dividends.ts`'s
// `supersede()`).
//
// This module is the PURE matching decision only -- which incoming
// (Sharesight-sourced) rows correspond to which existing, owner-typed,
// non-superseded `dividend_manual_records` rows -- fail-safe by
// construction: a manual row matching more than one incoming row, or an
// incoming row matching more than one manual row, is NEVER auto-reconciled
// (surfaced as ambiguous instead of guessed, per the owner ruling "no
// auto-reconciliation for ambiguous matches"). Two call sites share this one
// algorithm: `db/repositories/import-commit.ts` (the AUTHORITATIVE,
// live-DB-state decision actually applied at commit time) and
// `domain/imports/reconciliation.ts` (the advisory, preview-only disclosure
// shown to the owner before they commit).
import {
  compareDecimal,
  formatDecimalExact,
  fromInteger,
  isZero,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  parseDecimalResult,
  subtractDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";

// TOLERANCE DECISION (DIV-016 part C): exact-match on cash total OR within a
// 1% relative difference, never a wider band. BRK-005 stores a Sharesight
// payout's TOTAL cash amount verbatim; a manual per-share-mode row's
// comparable total is derived here as `sharesDecimal x
// dividendPerShareDecimal` (see `computeDividendCashTotal`). The same
// real-world payout entered by hand and later reported by Sharesight can
// differ by a small amount -- manual entry rounding, or a per-share x
// shares recombination that does not reduce to the exact cents Sharesight's
// own totals-mode figure reports -- without being a DIFFERENT distribution.
// 1% is deliberately small: it absorbs that rounding noise while still
// requiring the two figures to agree closely enough that a coincidental
// match between two genuinely different payouts (same security, same
// payment date, materially different amount) is not silently reconciled.
//
// KNOWN, ACCEPTED LIMIT (review round 1 F3): Sharesight's own payout
// `amountDecimal` -- the `totalCashDecimal` this tolerance compares -- is
// (per `domain/sharesight-sync/transform.ts`'s own OPEN QUESTION note) NOT
// confirmed to be gross; a manual per-share-mode row's derived total
// (`sharesDecimal x dividendPerShareDecimal`) is, by construction, a GROSS
// figure. Where withholding tax makes the two genuinely diverge by more
// than 1%, this is a FAIL-SAFE outcome, not a mis-reconciliation: the rows
// simply never match, the double count this task exists to fix persists
// for that one distribution, and DIV-004's `DIVIDEND_NEAR_EXISTING_ENTRY`
// proximity warning (payment-date-only, no amount check) still fires to
// flag it for the owner's own judgement. Tightening this tolerance can
// never turn a false negative here into a wrong reconciliation -- the
// amount check only ever prevents a match, never fabricates one.
const TOLERANCE_RATIO_DECIMAL = "0.01";

export type DividendReconciliationCandidate = Readonly<{
  /** `dividend_manual_records.id` -- the existing manual row that would be
   * superseded. */
  id: string;
  portfolioSecurityId: string;
  paymentDate: string;
  cashTotalDecimal: string;
}>;

export type DividendReconciliationIncomingRow = Readonly<{
  /** The incoming import row's own id (`import_rows.id`). */
  rowId: string;
  portfolioSecurityId: string;
  paymentDate: string;
  cashTotalDecimal: string;
}>;

export type DividendReconciliationMatch = Readonly<{
  rowId: string;
  manualRecordId: string;
}>;

export type DividendReconciliationResult = Readonly<{
  /** Safe, unambiguous 1:1 matches only -- every entry here is a pair where
   * the incoming row matched exactly one candidate AND that candidate
   * matched exactly this one incoming row. */
  matches: readonly DividendReconciliationMatch[];
  /** Incoming rows that matched more than one candidate, or whose sole
   * candidate match itself matched more than one incoming row -- excluded
   * from `matches` entirely; never guessed. */
  ambiguousRowIds: ReadonlySet<string>;
  /** The candidate manual records involved in an ambiguous match above --
   * surfaced so the preview can flag the EXISTING row too, not just the
   * incoming one. */
  ambiguousManualRecordIds: ReadonlySet<string>;
}>;

/**
 * The cash total a dividend fact represents, comparable across both storage
 * shapes this codebase supports: BRK-005 totals-mode (`totalCashDecimal`
 * verbatim) and per-share mode (`sharesDecimal x dividendPerShareDecimal`,
 * exact decimal multiplication -- money is never routed through JavaScript
 * binary floating point, per AGENTS.md). Returns `null` when neither shape
 * is fully present -- never fabricates a comparable amount.
 */
export function computeDividendCashTotal(fields: {
  totalCashDecimal: string | null;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
}): string | null {
  if (fields.totalCashDecimal !== null) return fields.totalCashDecimal;
  if (fields.sharesDecimal === null || fields.dividendPerShareDecimal === null)
    return null;
  return formatDecimalExact(
    multiplyDecimal(
      parseDecimal(fields.sharesDecimal),
      parseDecimal(fields.dividendPerShareDecimal),
    ),
  );
}

function absoluteDecimal(value: DecimalFraction): DecimalFraction {
  return compareDecimal(value, fromInteger(0n)) < 0
    ? negateDecimal(value)
    : value;
}

/** Exact-equal, or within `TOLERANCE_RATIO_DECIMAL` relative difference of
 * the larger absolute magnitude. See this module's header comment for the
 * tolerance decision. */
export function cashTotalsWithinTolerance(a: string, b: string): boolean {
  const left = parseDecimalResult(a);
  const right = parseDecimalResult(b);
  const diff = absoluteDecimal(subtractDecimal(left, right));
  if (isZero(diff)) return true;
  const absLeft = absoluteDecimal(left);
  const absRight = absoluteDecimal(right);
  const maxAbs = compareDecimal(absLeft, absRight) >= 0 ? absLeft : absRight;
  if (isZero(maxAbs)) return true;
  const threshold = multiplyDecimal(
    maxAbs,
    parseDecimal(TOLERANCE_RATIO_DECIMAL),
  );
  return compareDecimal(diff, threshold) <= 0;
}

// BUG-014 correction round (B1): `cashTotalsWithinTolerance` above parses
// BOTH sides with `parseDecimalResult` and THROWS on a non-canonical or
// over-scale string. Every caller of `computeDividendReconciliation` below
// is expected to have already excluded any candidate/incoming row whose
// `cashTotalDecimal` failed to validate -- but `computeDividendCashTotal`'s
// own totals-mode branch returns `fields.totalCashDecimal` VERBATIM,
// unparsed, so a caller that skips (or gets wrong) that pre-validation step
// can still hand this matching function a syntactically-`string`,
// semantically-garbage value. A match PREDICATE throwing turns one bad
// row/candidate anywhere in the pool into a hard failure of the WHOLE
// reconciliation call, not just a missed comparison -- the same lesson
// `domain/imports/reconciliation.ts`'s `decimalEqual` (F4) and
// `safeCashTotalsWithinTolerance` already apply one layer up. This function
// is the one place that actually owns the compare, so it applies the same
// fail-safe here too, independent of whether every caller got its own
// pre-validation right: an unparseable pair can never be fabricated into a
// match, it simply never matches.
function cashTotalsWithinToleranceSafe(a: string, b: string): boolean {
  try {
    return cashTotalsWithinTolerance(a, b);
  } catch {
    return false;
  }
}

/**
 * MATCHING RULE (DIV-016 part C): an incoming row matches a candidate when
 * they share the SAME `portfolioSecurityId`, the SAME `paymentDate` (exact
 * string equality -- Sharesight payouts carry only `paidOnDate`, no
 * separate ex-date, so payment date is the only date this matching can or
 * should use, matching the owner ruling to match on payment date), and
 * their cash totals agree within tolerance.
 *
 * DELIBERATELY NOT part of the rule: `currency_code`. `portfolioSecurityId`
 * already pins the exact security, and a security's dividend evidence is
 * single-currency by this codebase's own invariant (`domain/dividends/
 * history.ts`'s header note) -- a foreign-currency-denominated payout's
 * `currency_code`/FX-rate provenance (BRK-010) describes how its cash total
 * was converted INTO that one security currency, not a second identity axis
 * to match on. Two facts for the same security/date/amount can never
 * legitimately be in different currencies once resolved to the security's
 * own currency, so adding a currency check here could only ever narrow
 * (never usefully disambiguate) a match -- a known, accepted asymmetry with
 * DIV-004's near-duplicate warning, which likewise does not compare
 * currency.
 *
 * Ambiguity is resolved fail-safe: a candidate/incoming pair reconciles
 * ONLY when it is a mutual 1:1 match (the incoming row matched exactly this
 * one candidate, and this candidate matched exactly this one incoming row).
 * Any row on either side that matches more than once is excluded from
 * `matches` and reported in `ambiguousRowIds`/`ambiguousManualRecordIds`
 * instead -- never guessed.
 */
export function computeDividendReconciliation(
  incoming: readonly DividendReconciliationIncomingRow[],
  candidates: readonly DividendReconciliationCandidate[],
): DividendReconciliationResult {
  const matchesByIncoming = new Map<string, string[]>();
  const matchesByCandidate = new Map<string, string[]>();
  for (const row of incoming) {
    const matchedCandidateIds: string[] = [];
    for (const candidate of candidates) {
      if (candidate.portfolioSecurityId !== row.portfolioSecurityId) continue;
      if (candidate.paymentDate !== row.paymentDate) continue;
      if (
        !cashTotalsWithinToleranceSafe(
          row.cashTotalDecimal,
          candidate.cashTotalDecimal,
        )
      )
        continue;
      matchedCandidateIds.push(candidate.id);
      matchesByCandidate.set(candidate.id, [
        ...(matchesByCandidate.get(candidate.id) ?? []),
        row.rowId,
      ]);
    }
    if (matchedCandidateIds.length > 0) {
      matchesByIncoming.set(row.rowId, matchedCandidateIds);
    }
  }

  const matches: DividendReconciliationMatch[] = [];
  const ambiguousRowIds = new Set<string>();
  const ambiguousManualRecordIds = new Set<string>();
  for (const [rowId, candidateIds] of matchesByIncoming) {
    if (candidateIds.length > 1) {
      ambiguousRowIds.add(rowId);
      for (const candidateId of candidateIds) {
        ambiguousManualRecordIds.add(candidateId);
      }
      continue;
    }
    const candidateId = candidateIds[0]!;
    const incomingForCandidate = matchesByCandidate.get(candidateId) ?? [];
    if (incomingForCandidate.length > 1) {
      ambiguousRowIds.add(rowId);
      ambiguousManualRecordIds.add(candidateId);
      continue;
    }
    matches.push({ rowId, manualRecordId: candidateId });
  }

  return { matches, ambiguousRowIds, ambiguousManualRecordIds };
}
