// BRK-015: pure watermark-window arithmetic for the routine (narrowed)
// Sharesight sync. Isolated from `app/sharesight-sync-service.ts` (and from
// `db/repositories/sharesight-sync-state.ts`'s watermark QUERY) so the date
// arithmetic itself is unit-testable without any DB/client fixture.

/**
 * Overlap window (days) subtracted from the last COMMITTED TRADE date
 * before it is used as the routine sync's `from` bound for `listTrades` --
 * covers late-settled trades that post after their nominal date. A
 * starting point, not a measured value (TASKS.md BRK-015's own Risks note).
 */
export const SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS = 30;

/**
 * Overlap window (days) subtracted from the last COMMITTED PAYOUT
 * (`payment_date`) before it is used as the routine sync's `from` bound for
 * `listPayouts`. Deliberately a SEPARATE, LARGER constant than the trade
 * overlap. Owner-confirmed, verbatim (2026-09-02): "Let's do 90 days,
 * dividends are low volume" -- payouts are low-volume (~119 records across
 * the account's whole history, vs. ~107 trades), so a generous window
 * costs almost nothing, while a too-small one silently and permanently
 * loses a late-entered dividend -- the exact data the owner originally
 * reported missing.
 *
 * **THIS CONSTANT IS NOT LITERALLY 90 -- read this before changing it.**
 * The owner's approved intent is 90 days of REAL (paid-date) coverage, not
 * the literal number 90 in this field. Live-confirmed finding (2026-09-02,
 * GET-only spike against the owner's real account, through the sealed
 * client, no values printed beyond a derived day-count and a boolean
 * verdict): `listPayouts`'s `start_date` filters by EX-DATE (`goes_ex_on`),
 * NOT paid date (`paid_on`). This codebase's watermark is derived from
 * `dividend_manual_records.payment_date` (the paid date -- there is no
 * committed ex-date column to derive from instead), so a LITERAL 90 here
 * would deliver only (90 - ex-to-paid gap) days of actual paid-date
 * coverage -- materially less than the owner approved, not "90 days
 * either way." Every one of the owner's 119 payouts carries a NONZERO
 * ex-to-paid gap; the largest observed on this account is 62 days. To
 * deliver the owner's approved 90 days of EFFECTIVE paid-date coverage,
 * this constant is 90 (the approved coverage) PLUS that observed 62-day
 * gap, rounded up with margin (90 + 62 = 152, rounded to 180) -- so a
 * late-entered payout near the worst observed ex/paid gap still falls
 * inside the window. A worse, unobserved gap on a different account
 * remains a real residual risk this rounding-up margin mitigates but does
 * not eliminate; see `docs/ARCHITECTURE.md` §8.2's BRK-015 review-round
 * entry for the full investigation record and this exact accounting.
 */
export const SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS = 180;

/**
 * Subtracts `overlapDays` calendar days from a `YYYY-MM-DD` committed
 * watermark date, returning a `YYYY-MM-DD` string suitable for
 * `SharesightListParams.from`. Pure UTC calendar-date arithmetic (no
 * time-of-day, no local timezone) -- matches the plain business-date shape
 * `loadCommittedSharesightWatermarks` returns (`transactions
 * .local_trade_date` / `dividend_manual_records.payment_date`, both
 * already-normalized `YYYY-MM-DD` dates, never a full timestamp).
 *
 * `overlapDays` is REQUIRED (no default) -- review round B1 fix: trades and
 * payouts use different, non-interchangeable constants
 * (`SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS` / `SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS`),
 * and a shared default here would silently re-introduce a single value
 * doing duty for both streams the way the pre-review-fix code did for the
 * watermark itself.
 */
export function computeRoutineSyncFromDate(
  committedWatermark: string,
  overlapDays: number,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(committedWatermark);
  if (!match) {
    throw new Error(
      `computeRoutineSyncFromDate: expected a YYYY-MM-DD date, got ${JSON.stringify(committedWatermark)}`,
    );
  }
  const [, year, month, day] = match;
  const asUtcMs = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const shiftedMs = asUtcMs - overlapDays * 86_400_000;
  return new Date(shiftedMs).toISOString().slice(0, 10);
}

/**
 * Describes what a sync call actually examined for ONE stream (trades or
 * payouts), for honest UI copy (TASKS.md BRK-015: "a routine sync must
 * never read as fully in sync when it only examined a recent window").
 * `"full"` covers BOTH the explicit Full resync action AND a routine
 * sync's own first-ever run for that stream (no committed watermark exists
 * yet, so no `from` bound was sent either) -- in both cases the ACTUAL
 * Sharesight request for that stream carried no date filter, which is the
 * fact this type reports, independent of which action asked for it.
 */
export type SharesightStreamWindow =
  { kind: "full" } | { kind: "narrowed"; sinceDate: string };

/**
 * Review round B1 fix: trades and payouts are reported SEPARATELY, never
 * folded into one shared window -- each stream's `from` bound is computed
 * independently (its own watermark, its own overlap constant), so the UI
 * must be able to state, honestly, that (for example) trades were checked
 * since one date while payouts were checked since an earlier or later one,
 * rather than implying a single window covered both.
 */
export type SharesightSyncWindow = Readonly<{
  trades: SharesightStreamWindow;
  payouts: SharesightStreamWindow;
}>;
