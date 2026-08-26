// BUG-005 (owner-reported: the per-security Dividends tab shows "Shares at
// ex-date"/"Per share" as "Unknown" for a BRK-005 totals-mode Sharesight
// import even though "we already use it in the dividend forward
// projections"): extracted from `forecast.ts`'s DIV-006/DIV-008 per-row
// derivation so there is exactly ONE implementation of "shares held at a
// row's payment date" / "per-share rate derived from a totals-mode row" --
// the 12-month forecast's history-TTM fallback and the Dividends tab's
// display now both call these same functions rather than each carrying its
// own copy of the division.
//
// Naming note (kept honest for a future reader): every derivation here is
// keyed off `row.paymentDate`, NEVER `row.exDate` -- a BRK-005 totals-mode
// Sharesight payout carries only a payment date (no ex-date), and a payment
// date can fall materially after the true ex-date, when the ledger's held
// quantity may have already changed. This is a deliberate, disclosed
// approximation (see `deriveHistoryRowDps`'s doc comment for the accepted
// risk), never claimed to be "at ex-date" -- a consumer rendering a column
// literally labelled "Shares at ex-date" must disclose that a DERIVED value
// in that column was actually evaluated at the payment date instead (see
// `deriveHistoryRowDisplay`'s `sharesDerivedAtPayment`/
// `dividendPerShareDerived` flags).
import {
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  fromInteger,
  parseDecimal,
  roundDecimal,
} from "../calculations/decimal.ts";
import {
  deriveSharesHeldAtDate,
  type LedgerQuantityFact,
} from "./shares-held.ts";
import type { DerivedDividendRow } from "./history.ts";

const ZERO = fromInteger(0n);
const HISTORY_DPS_SCALE = 24;

/** Discriminated per-row DPS derivation result -- `ok: false` always names
 * WHY the rate is indeterminate, distinguishing a genuinely unknown amount
 * from a PROVABLE ledger gap (see `deriveHistoryRowDps`'s doc comment)
 * rather than collapsing both into one opaque `null`. */
export type HistoryRowDpsResult =
  | {
      ok: true;
      dpsDecimal: string;
      /** The ledger-derived shares-held-at-`row.paymentDate` figure used as
       * the DIVISOR to compute `dpsDecimal` from the row's total (cash or
       * franking) -- populated ONLY when `dpsDecimal` was actually DERIVED
       * this way (a BRK-005 totals-mode row). `null` when `dpsDecimal` came
       * directly from the row's own recorded per-share fact instead (a
       * per-share-mode row, whose own `row.sharesDecimal` is unrelated to
       * this division and must never be conflated with it). */
      sharesAtPaymentDecimal: string | null;
    }
  | {
      ok: false;
      /** `"unknown_amount"`: the row's cash figure or payment date is genuinely absent -- nothing to divide. `"history_gap"`: a real dividend was received (known cash, known payment date) but the ledger's OWN shares-held-at-payment-date resolves to zero or negative -- the ledger itself proves a gap (e.g. an early buy never imported), never silently treated the same as a plain unknown amount. */
      reason: "unknown_amount" | "history_gap";
    };

/**
 * DIV-006/DIV-008: per-row DPS (dividend-per-share) derivation for the
 * history-TTM fallback (and, since BUG-005, the Dividends tab's own
 * "Per share" column). A per-share-mode row (the overwhelming majority --
 * owner-typed manual entries, receipts, per-share CSV imports, provider
 * auto-derived rows) already carries its own `dividendPerShareDecimal`
 * directly -- the row's OWN `sharesDecimal` is irrelevant to that figure (it
 * is a rate, not a total) and is deliberately never consulted here.
 *
 * A BRK-005 totals-mode row (`dividendPerShareDecimal === null` but
 * `cashDecimal !== null` -- a Sharesight payout reporting only a total cash
 * amount, no share count) has no stored rate at all; this derives one by
 * dividing that total by the shares HELD ON THE ROW'S OWN `paymentDate`
 * (`deriveSharesHeldAtDate`), never by today's current share count -- a
 * position bought/sold between that historical payment and today would
 * otherwise silently mis-scale the derived rate.
 *
 * DIV-008 (owner ruling, 2026-08-23, replacing DIV-006's original
 * `portfolios.history_complete_from` completeness gate -- see
 * `docs/CALCULATIONS.md` section 11): this division is trusted whenever the
 * ledger-derived
 * shares-held-at-payment-date resolves POSITIVE -- the ledger AS IT STANDS
 * is the evidence, no separate owner-declared boundary required. A
 * zero-or-negative resolved share count despite a real received dividend
 * (known cash, known payment date) is a PROVABLE gap -- the ledger itself
 * proves something is missing (e.g. an early buy the owner never imported)
 * -- and is reported as `"history_gap"`, distinguishable from a genuinely
 * unknown amount/payment date (`"unknown_amount"`). Never silently dropped,
 * never a fabricated "0".
 *
 * ACCEPTED RISK (owner-informed, stated plainly): a missing EARLY buy that
 * still leaves the ledger-derived share count POSITIVE at the payment date
 * (e.g. the owner held MORE shares than the ledger shows, but still some)
 * yields an OVERSTATED DPS this function cannot detect or flag -- there is
 * no ledger evidence of a gap in that case. The owner explicitly chose this
 * visible-and-crosscheckable figure over the prior design's permanently
 * gated $0/missing state: "A user might want to see an incomplete history
 * and it would be easier to cross ref and debug an incorrect value than a
 * $0 or missing value."
 */
export function deriveHistoryRowDps(
  row: DerivedDividendRow,
  transactions: readonly LedgerQuantityFact[],
): HistoryRowDpsResult {
  if (row.dividendPerShareDecimal !== null) {
    return {
      ok: true,
      dpsDecimal: row.dividendPerShareDecimal,
      sharesAtPaymentDecimal: null,
    };
  }
  if (row.cashDecimal === null) {
    return { ok: false, reason: "unknown_amount" }; // genuinely unknown amount
  }
  const paymentDate = row.paymentDate;
  if (paymentDate === null) return { ok: false, reason: "unknown_amount" };
  const sharesAtPayment = deriveSharesHeldAtDate(transactions, paymentDate);
  // A zero/negative ledger-derived share count at the payment date, despite
  // a real received dividend, PROVES a gap in the ledger -- distinguishable
  // from the generic "unknown_amount" reason above (see this function's doc
  // comment).
  if (compareDecimal(parseDecimal(sharesAtPayment), ZERO) <= 0) {
    return { ok: false, reason: "history_gap" };
  }
  return {
    ok: true,
    dpsDecimal: formatDecimalExact(
      roundDecimal(
        divideDecimal(
          parseDecimal(row.cashDecimal),
          parseDecimal(sharesAtPayment),
        ),
        HISTORY_DPS_SCALE,
      ),
    ),
    sharesAtPaymentDecimal: sharesAtPayment,
  };
}

/**
 * BUG-004: per-row FRANKING-per-share derivation for the history-TTM
 * fallback, mirroring `deriveHistoryRowDps`'s exact precedence so franking
 * is carried forward by the SAME evidence discipline as cash (owner-reported
 * "estimated franking credits show $0" despite ~$9,082 of real trailing-12-
 * month franking evidence -- root cause: the uncovered-tail estimate only
 * ever consulted the security's OWNER-SET franking-percent ASSUMPTION,
 * `dividend_security_assumptions.franking_percent_decimal`, which this
 * account never set, and never consulted the REAL per-row franking evidence
 * already resolved onto every history row, `DerivedDividendRow.frankingTotalDecimal`
 * -- see `computeSecurityDividendForecast`'s `uncoveredFrankingKnownDecimal`).
 *
 * A per-share-mode row's OWN resolved franking rate
 * (`row.franking.perShareDecimal`, already computed at row-construction time
 * from real per-dividend evidence -- an imported/receipt/manual franking
 * fact, or the security's own default-percent assumption grossed up against
 * THIS row's own per-share amount) is used directly, exactly like
 * `deriveHistoryRowDps` prefers `row.dividendPerShareDecimal` over
 * re-deriving one. `row.franking.source === "unknown"` (no override, no
 * default assumption, or the per-share dividend amount itself was unknown)
 * means this row's franking is genuinely unresolved -- `"unknown_amount"`,
 * never a fabricated "0".
 *
 * A BRK-005 totals-mode row (`row.dividendPerShareDecimal === null` -- a
 * Sharesight payout reporting only totals, no share count) never resolves a
 * native `franking.perShareDecimal` (`resolveFrankingPerShare` requires a
 * known per-share dividend amount to gross up); its franking is instead a
 * TOTAL dollar figure (`row.frankingTotalDecimal`, the record's own imported
 * `total_franking_decimal` when present), divided by the ledger's
 * shares-held-at-payment-date -- the identical DIV-008 fallback
 * `deriveHistoryRowDps` uses for cash, never today's current share count (a
 * position bought/sold since that payment would otherwise mis-scale the
 * rate). A zero/negative resolved share count despite real recorded
 * franking is the same PROVABLE ledger gap `deriveHistoryRowDps` names
 * `"history_gap"`.
 */
export function deriveHistoryRowFrankingPerShare(
  row: DerivedDividendRow,
  transactions: readonly LedgerQuantityFact[],
): HistoryRowDpsResult {
  if (row.dividendPerShareDecimal !== null) {
    if (row.franking.perShareDecimal === null) {
      return { ok: false, reason: "unknown_amount" };
    }
    return {
      ok: true,
      dpsDecimal: row.franking.perShareDecimal,
      sharesAtPaymentDecimal: null,
    };
  }
  if (row.frankingTotalDecimal === null) {
    return { ok: false, reason: "unknown_amount" };
  }
  const paymentDate = row.paymentDate;
  if (paymentDate === null) return { ok: false, reason: "unknown_amount" };
  const sharesAtPayment = deriveSharesHeldAtDate(transactions, paymentDate);
  if (compareDecimal(parseDecimal(sharesAtPayment), ZERO) <= 0) {
    return { ok: false, reason: "history_gap" };
  }
  return {
    ok: true,
    dpsDecimal: formatDecimalExact(
      roundDecimal(
        divideDecimal(
          parseDecimal(row.frankingTotalDecimal),
          parseDecimal(sharesAtPayment),
        ),
        HISTORY_DPS_SCALE,
      ),
    ),
    sharesAtPaymentDecimal: sharesAtPayment,
  };
}

/** BUG-005: the Dividends tab's own per-row "Shares at ex-date"/"Per share"
 * display values -- the row's own recorded facts when present, otherwise the
 * IDENTICAL `deriveHistoryRowDps` division the 12-month forecast's
 * history-TTM fallback already relies on for a BRK-005 totals-mode row
 * (total cash, no share count, no per-share amount). Never a second/parallel
 * formula: `sharesDecimal`/`dividendPerShareDecimal` here are always either
 * the row's own recorded values, or `deriveHistoryRowDps`'s own derived
 * output -- nothing here recomputes the division independently. */
export type DerivedHistoryRowDisplay = {
  /** The row's own recorded `sharesDecimal` when present; otherwise the
   * ledger-derived shares-held-at-`paymentDate` figure for a BRK-005
   * totals-mode row; otherwise `null` (genuinely unresolvable -- see
   * `unresolvedReason`). */
  sharesDecimal: string | null;
  /** `true` exactly when `sharesDecimal` was DERIVED at the row's PAYMENT
   * date rather than recorded -- a recorded figure (including every
   * auto-derived row, which genuinely IS evaluated at ex-date) is evaluated
   * `false`. A consumer rendering a column literally labelled "at ex-date"
   * must disclose this flag rather than implying every value shares that
   * basis. */
  sharesDerivedAtPayment: boolean;
  /** The row's own recorded `dividendPerShareDecimal` when present;
   * otherwise `deriveHistoryRowDps`'s derived rate; otherwise `null`. */
  dividendPerShareDecimal: string | null;
  /** `true` exactly when `dividendPerShareDecimal` was derived rather than
   * recorded -- always equal to `sharesDerivedAtPayment` (the two are
   * produced by the same division), kept as a separate field for callers
   * that only care about one column. */
  dividendPerShareDerived: boolean;
  /** Set exactly when neither value could be resolved (recorded absent AND
   * derivation unavailable) -- mirrors `HistoryRowDpsResult`'s reasons.
   * `null` when both values are resolved (recorded or derived). */
  unresolvedReason: "unknown_amount" | "history_gap" | null;
};

export function deriveHistoryRowDisplay(
  row: DerivedDividendRow,
  transactions: readonly LedgerQuantityFact[],
): DerivedHistoryRowDisplay {
  if (row.dividendPerShareDecimal !== null) {
    // Per-share-mode row: both facts are recorded (see
    // `DerivedDividendRow.sharesDecimal`'s doc comment -- `null` only for a
    // BRK-005 totals-mode row). Nothing to derive.
    return {
      sharesDecimal: row.sharesDecimal,
      sharesDerivedAtPayment: false,
      dividendPerShareDecimal: row.dividendPerShareDecimal,
      dividendPerShareDerived: false,
      unresolvedReason: null,
    };
  }
  const result = deriveHistoryRowDps(row, transactions);
  if (!result.ok) {
    // The per-share rate is unresolvable, but the row's OWN recorded
    // `sharesDecimal` may still be a real known fact (e.g. an auto-derived
    // row whose provider event amount is genuinely unknown -- `sharesDecimal`
    // is `null` only for a BRK-005 totals-mode row, see that field's doc
    // comment). Passed through as-is rather than fabricated `null` here,
    // so a row with a known share count but an unresolvable rate still
    // shows its real share count instead of a spurious "Unknown".
    return {
      sharesDecimal: row.sharesDecimal,
      sharesDerivedAtPayment: false,
      dividendPerShareDecimal: null,
      dividendPerShareDerived: false,
      unresolvedReason: result.reason,
    };
  }
  return {
    sharesDecimal: result.sharesAtPaymentDecimal,
    sharesDerivedAtPayment: true,
    dividendPerShareDecimal: result.dpsDecimal,
    dividendPerShareDerived: true,
    unresolvedReason: null,
  };
}
