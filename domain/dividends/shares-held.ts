// DIV-001: pure "shares held at a date" derivation for one portfolio
// security, reused for (a) shares held at a dividend event's ex-date (the
// derived-history auto row's eligible quantity) and (b) shares held "now"
// (the forecast's current-holding quantity, `sharesHeldAtDate` with
// `asOfDate` = today).
//
// Deliberately NOT a reuse of `domain/ledger/fifo.ts`/`projections.ts`'s
// full FIFO lot rebuild -- this needs only a signed quantity sum as of an
// arbitrary historical date, not cost basis, remaining-lot tracking, or
// oversell validation. It mirrors two pieces of that module's pattern:
//
// 1. A transaction whose status flips to `reversed` (because a later
//    transaction reverses it) and the reversal transaction itself (which
//    carries `reversesTransactionId`) both contribute zero -- see
//    `projections.ts`'s `activeSecurityEvents`. Enforced here by TWO
//    independent, redundant signals for robustness: only `status ===
//    "posted"` rows are ever considered (a reversed original never even
//    enters the loop), AND any row whose id a reversal record points at is
//    separately excluded via `reversedIds` -- so a hypothetical mismatch
//    between the two (e.g. a status update that lagged a reversal write)
//    fails toward EXCLUDING the row rather than double-counting it.
// 2. A `split` transaction (Orchestrator ruling, 2026-08-13, reversing this
//    module's original "splits ignored" scope decision -- the data exists
//    in the ledger and dividend-history correctness requires it): applies
//    the split ratio to the RUNNING total at the split's trade date, the
//    identical numerator/denominator semantics `projections.ts`'s
//    `updateNativeLots` and `db/repositories/ledger.ts`'s split-quantity
//    validation use -- `quantityDecimal` is the numerator, the
//    (ledger-transaction-specific) `unitPriceDecimal` column is the
//    denominator, and existing quantity is multiplied by
//    `numerator / denominator` (e.g. a 2:1 split doubles the running
//    total). Processing every transaction in chronological order (`tradeAt`
//    -- the precise instant, not just the calendar day -- then `id` as a
//    final deterministic tiebreak) means a split occurring BEFORE an
//    ex-date multiplies the shares that were already summed by that point,
//    while a split AFTER an ex-date has no effect on that ex-date's total
//    (it hasn't happened yet as of `asOfDate`). Follow-up fix (review round
//    3): ordering was originally keyed on `localTradeDate` alone, which is
//    only a calendar DAY -- a same-day buy-then-split and a same-day
//    split-then-buy are indistinguishable by day and previously fell back
//    to an arbitrary id-based tiebreak, which can silently apply a split to
//    shares bought the same day AFTER it (or vice versa) in the wrong
//    order. `tradeAt` (an ISO instant) is the actual ledger sequencing
//    field -- the identical ordering key `domain/ledger/projections.ts`'s
//    `activeSecurityEvents` uses (`effectiveAt.localeCompare`, effectively
//    `tradeAt`) -- so same-day transactions now apply in their true ledger
//    order.
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  fromInteger,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  roundDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";

const ZERO = fromInteger(0n);
// Split-ratio division has no fixed terminating scale; round the running
// total to this many places afterward -- matches this codebase's
// `DECIMAL_LIMITS.allocationScale` convention for intermediate financial
// math with no natural terminating scale (see `domain/ledger/projections.ts`'s
// `divideRounded`, `domain/dividends/franking.ts`'s identical rationale).
const SPLIT_RATIO_SCALE = 24;

export type LedgerQuantityFact = {
  id: string;
  /** `buy` (+), `sell` (-), and `split` (ratio-multiplies the running total) affect the sum; every other type is 0. */
  type: string;
  status: "posted" | "reversed";
  /** Local calendar date (YYYY-MM-DD) the trade is effective on -- used for the `asOfDate` cutoff filter. */
  localTradeDate: string;
  /** Precise ISO instant the trade is effective at -- used ONLY for same-day (and cross-boundary) ordering, never the cutoff filter (that stays keyed on the business-date `localTradeDate`). */
  tradeAt: string;
  quantityDecimal: string | null;
  /** Split denominator (the `unit_price_decimal` ledger column, repurposed for `type === "split"` rows); the numerator is `quantityDecimal`. Ignored for every other type. */
  unitPriceDecimal: string | null;
  /** Set on a reversal record; points at the transaction it reverses. */
  reversesTransactionId: string | null;
};

function positiveOrNull(value: string | null): DecimalFraction | null {
  if (value === null) return null;
  try {
    const parsed = parseDecimal(value);
    return compareDecimal(parsed, ZERO) > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Excludes reversed originals and reversal records themselves, in EITHER
 * order of construction -- shared by `deriveSharesHeldAtDate` and
 * `buildSharesHeldTimeline` so both start from the identical "usable rows"
 * definition (HIST-002 layer 1: the two functions must never drift into two
 * conventions for the same fact). Does NOT sort or apply the `asOfDate`
 * cutoff -- callers do that themselves, differently. */
function usableTransactions(
  transactions: readonly LedgerQuantityFact[],
): LedgerQuantityFact[] {
  const reversedIds = new Set(
    transactions
      .filter((transaction) => transaction.reversesTransactionId !== null)
      .map((transaction) => transaction.reversesTransactionId as string),
  );
  return transactions
    .filter((transaction) => transaction.status === "posted")
    .filter((transaction) => transaction.reversesTransactionId === null)
    .filter((transaction) => !reversedIds.has(transaction.id));
}

/** The ledger's chronological application order for one security's usable
 * transactions -- `tradeAt` (the precise instant), `id` as the final
 * deterministic tiebreak. Shared so both functions below apply transactions
 * in the identical order. */
function byLedgerOrder(
  left: LedgerQuantityFact,
  right: LedgerQuantityFact,
): number {
  return (
    left.tradeAt.localeCompare(right.tradeAt) || left.id.localeCompare(right.id)
  );
}

/** ONE transaction's effect on a running shares-held total -- the single
 * definition of the math both `deriveSharesHeldAtDate` (per-date replay) and
 * `buildSharesHeldTimeline` (HIST-002 layer 1's hoisted one-walk-per-security
 * variant) fold with, so the two can never compute two different answers for
 * the same transaction sequence. */
function applyTransactionEffect(
  total: DecimalFraction,
  transaction: LedgerQuantityFact,
): DecimalFraction {
  if (transaction.type === "buy" || transaction.type === "sell") {
    if (transaction.quantityDecimal === null) return total;
    let quantity: DecimalFraction;
    try {
      quantity = parseDecimal(transaction.quantityDecimal);
    } catch {
      return total;
    }
    return addDecimal(
      total,
      transaction.type === "sell" ? negateDecimal(quantity) : quantity,
    );
  }
  if (transaction.type === "split") {
    const numerator = positiveOrNull(transaction.quantityDecimal);
    const denominator = positiveOrNull(transaction.unitPriceDecimal);
    if (!numerator || !denominator) return total; // malformed split fact: no effect rather than a thrown error
    return roundDecimal(
      divideDecimal(multiplyDecimal(total, numerator), denominator),
      SPLIT_RATIO_SCALE,
    );
  }
  // Every other transaction type (cash movements, fees, tax, opening
  // balance) has no effect on share quantity.
  return total;
}

/**
 * Signed quantity held for one portfolio security as of `asOfDate`
 * (inclusive), from raw ledger transaction facts. Returns the exact decimal
 * sum ("0" when nothing qualifies, including after a full exit -- selling
 * every share and never buying again correctly yields "0" for every
 * ex-date after the final sale, with no separate "no history" state: an
 * empty/zero position is a known fact, not missing data).
 */
export function deriveSharesHeldAtDate(
  transactions: readonly LedgerQuantityFact[],
  asOfDate: string,
): string {
  const usable = usableTransactions(transactions)
    .filter((transaction) => transaction.localTradeDate <= asOfDate)
    .sort(byLedgerOrder);

  let total: DecimalFraction = ZERO;
  for (const transaction of usable) {
    total = applyTransactionEffect(total, transaction);
  }
  return formatDecimalExact(total);
}

/** HIST-002 layer 1: one precomputed "shares held" walk for a security,
 * built ONCE and then queried cheaply for many dates -- replaces a
 * per-(date x security) `deriveSharesHeldAtDate` replay (each of which
 * re-filters and re-sorts the WHOLE transaction list) with a single
 * filter+sort+fold, followed by O(log n) lookups.
 *
 * Provable equivalence (not merely assumed): `deriveSharesHeldAtDate`
 * processes the SAME fixed ledger order (`byLedgerOrder`, keyed on `tradeAt`)
 * restricted to whichever prefix satisfies `localTradeDate <= asOfDate` --
 * filtering never reorders the survivors, so that restricted set is always
 * some SUBSEQUENCE of the full ledger order. That subsequence only equals a
 * simple PREFIX of the full order (letting a binary search answer every
 * date) when `localTradeDate` is non-decreasing along `byLedgerOrder` --
 * true whenever `tradeAt` and `localTradeDate` describe the same event
 * consistently (the overwhelmingly common case), but NOT schema-enforced
 * (`tradeAt`/`localTradeDate` are independently supplied at the ledger
 * boundary -- see `app/manual-ledger-contract.ts`). This function checks
 * that invariant itself, once, over the actual data: if it holds,
 * `checkpoints` below makes every date lookup a binary search, byte-identical
 * to the per-date replay by construction (both fold the same
 * `applyTransactionEffect` over the same prefix). If it does NOT hold for
 * some pathological security, `checkpoints` is `null` and
 * `sharesHeldAtDateFromTimeline` transparently falls back to calling
 * `deriveSharesHeldAtDate` directly -- slower for that one security, but
 * NEVER wrong.
 */
export type SharesHeldTimeline = {
  readonly checkpoints:
    | readonly {
        readonly localTradeDate: string;
        readonly totalDecimal: string;
      }[]
    | null;
  readonly transactions: readonly LedgerQuantityFact[];
};

export function buildSharesHeldTimeline(
  transactions: readonly LedgerQuantityFact[],
): SharesHeldTimeline {
  const order = usableTransactions(transactions).sort(byLedgerOrder);

  let monotonic = true;
  for (let index = 1; index < order.length; index += 1) {
    if (order[index]!.localTradeDate < order[index - 1]!.localTradeDate) {
      monotonic = false;
      break;
    }
  }
  if (!monotonic) {
    return { checkpoints: null, transactions };
  }

  let total: DecimalFraction = ZERO;
  const checkpoints: { localTradeDate: string; totalDecimal: string }[] = [];
  for (const transaction of order) {
    total = applyTransactionEffect(total, transaction);
    checkpoints.push({
      localTradeDate: transaction.localTradeDate,
      totalDecimal: formatDecimalExact(total),
    });
  }
  return { checkpoints, transactions };
}

/** Queries a `SharesHeldTimeline` at `asOfDate` -- O(log n) on the fast
 * (monotonic) path via a rightmost-match binary search over `checkpoints`
 * (duplicates on the same date are expected -- same-day transactions each
 * get their own checkpoint; the rightmost one is the correct end-of-day
 * total), or the exact `deriveSharesHeldAtDate` replay on the fallback path.
 * Always returns the identical string `deriveSharesHeldAtDate` would. */
export function sharesHeldAtDateFromTimeline(
  timeline: SharesHeldTimeline,
  asOfDate: string,
): string {
  const { checkpoints } = timeline;
  if (checkpoints === null) {
    return deriveSharesHeldAtDate(timeline.transactions, asOfDate);
  }
  let low = 0;
  let high = checkpoints.length - 1;
  let match = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (checkpoints[mid]!.localTradeDate <= asOfDate) {
      match = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return match === -1 ? "0" : checkpoints[match]!.totalDecimal;
}

// HIST-001: sibling reconstruction for a cash ACCOUNT's running balance at an
// arbitrary historical date, from raw `cash_ledger_entries` facts. Mirrors
// `deriveSharesHeldAtDate`'s exclusion pattern: a reversed entry (`status
// !== "posted"`) and the reversal record that points at it both contribute
// zero.
//
// BUG-002: originally also reused by the historical-portfolio-value
// derivation (`domain/snapshots/historical-portfolio-value.ts`) so it could
// reconstruct "securities + cash" at a past date the SAME way
// `app/owned-holdings.ts`'s `loadCash` sums entries for "now". That
// derivation is now securities-only (owner ruling, 2026-08-25 -- see
// `docs/CALCULATIONS.md`'s HIST-001 subsection), so this function has NO
// production consumer any more (a repo-wide grep finds none outside this
// file; `tests/hist-001.test.ts`'s Part 1 still exercises it directly).
// Deliberately KEPT, not deleted in a dead-code sweep: the owner's ruling
// was to narrow what the "portfolio value" figure reads, not to remove the
// cash ledger or its derivation logic ("don't destroy the ledger, could be
// useful in future").
export type LedgerCashFact = {
  id: string;
  /** Local calendar date (YYYY-MM-DD) the entry is effective on -- used for the `asOfDate` cutoff filter, matching `LedgerQuantityFact.localTradeDate`. */
  localDate: string;
  signedAmountDecimal: string;
  status: "posted" | "reversed";
  /** Set on a reversal record; points at the entry it reverses. */
  reversesEntryId: string | null;
};

/**
 * Signed cash balance for one cash account as of `asOfDate` (inclusive),
 * from raw ledger entry facts. Returns the exact decimal sum ("0" when
 * nothing qualifies) -- never a separate "no history" state, matching
 * `deriveSharesHeldAtDate`'s own convention.
 */
export function deriveCashBalanceAtDate(
  entries: readonly LedgerCashFact[],
  asOfDate: string,
): string {
  const reversedIds = new Set(
    entries
      .filter((entry) => entry.reversesEntryId !== null)
      .map((entry) => entry.reversesEntryId as string),
  );
  const usable = entries
    .filter((entry) => entry.status === "posted")
    .filter((entry) => entry.reversesEntryId === null)
    .filter((entry) => !reversedIds.has(entry.id))
    .filter((entry) => entry.localDate <= asOfDate);

  let total: DecimalFraction = ZERO;
  for (const entry of usable) {
    try {
      total = addDecimal(total, parseDecimal(entry.signedAmountDecimal));
    } catch {
      continue; // malformed amount: excluded, never fabricated
    }
  }
  return formatDecimalExact(total);
}
