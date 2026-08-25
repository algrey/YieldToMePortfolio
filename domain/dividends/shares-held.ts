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
  const reversedIds = new Set(
    transactions
      .filter((transaction) => transaction.reversesTransactionId !== null)
      .map((transaction) => transaction.reversesTransactionId as string),
  );
  const usable = transactions
    .filter((transaction) => transaction.status === "posted")
    .filter((transaction) => transaction.reversesTransactionId === null)
    .filter((transaction) => !reversedIds.has(transaction.id))
    .filter((transaction) => transaction.localTradeDate <= asOfDate)
    .slice()
    .sort(
      (left, right) =>
        left.tradeAt.localeCompare(right.tradeAt) ||
        left.id.localeCompare(right.id),
    );

  let total: DecimalFraction = ZERO;
  for (const transaction of usable) {
    if (transaction.type === "buy" || transaction.type === "sell") {
      if (transaction.quantityDecimal === null) continue;
      let quantity: DecimalFraction;
      try {
        quantity = parseDecimal(transaction.quantityDecimal);
      } catch {
        continue;
      }
      total = addDecimal(
        total,
        transaction.type === "sell" ? negateDecimal(quantity) : quantity,
      );
      continue;
    }
    if (transaction.type === "split") {
      const numerator = positiveOrNull(transaction.quantityDecimal);
      const denominator = positiveOrNull(transaction.unitPriceDecimal);
      if (!numerator || !denominator) continue; // malformed split fact: no effect rather than a thrown error
      total = roundDecimal(
        divideDecimal(multiplyDecimal(total, numerator), denominator),
        SPLIT_RATIO_SCALE,
      );
      continue;
    }
    // Every other transaction type (cash movements, fees, tax, opening
    // balance) has no effect on share quantity.
  }
  return formatDecimalExact(total);
}

// HIST-001: sibling reconstruction for a cash ACCOUNT's running balance at an
// arbitrary historical date, from raw `cash_ledger_entries` facts -- reused
// alongside `deriveSharesHeldAtDate` above so the historical-portfolio-value
// derivation (`domain/snapshots/historical-portfolio-value.ts`) can honestly
// reconstruct "securities + cash" at a past date the SAME way
// `app/owned-holdings.ts`'s `loadCash` sums entries for "now" -- one summing
// rule, two callers. Mirrors `deriveSharesHeldAtDate`'s exclusion pattern: a
// reversed entry (`status !== "posted"`) and the reversal record that points
// at it both contribute zero.
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
