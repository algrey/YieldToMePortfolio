// BRK-015: pure watermark-window arithmetic for the routine (narrowed)
// Sharesight sync. Isolated from `app/sharesight-sync-service.ts` (and from
// `db/repositories/sharesight-sync-state.ts`'s watermark QUERY) so the date
// arithmetic itself is unit-testable without any DB/client fixture.

/**
 * Overlap window (days) subtracted from the last COMMITTED sync point
 * before it is used as the routine sync's `from` bound -- covers
 * late-settled trades/payouts that post after their nominal date. A
 * starting point, not a measured value (TASKS.md BRK-015's own Risks note).
 */
export const SHARESIGHT_ROUTINE_SYNC_OVERLAP_DAYS = 30;

/**
 * Subtracts `overlapDays` calendar days from a `YYYY-MM-DD` committed
 * watermark date, returning a `YYYY-MM-DD` string suitable for
 * `SharesightListParams.from`. Pure UTC calendar-date arithmetic (no
 * time-of-day, no local timezone) -- matches the plain business-date shape
 * `loadCommittedSharesightWatermark` returns (`transactions
 * .local_trade_date` / `dividend_manual_records.payment_date`, both
 * already-normalized `YYYY-MM-DD` dates, never a full timestamp).
 */
export function computeRoutineSyncFromDate(
  committedWatermark: string,
  overlapDays: number = SHARESIGHT_ROUTINE_SYNC_OVERLAP_DAYS,
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
 * Describes what a sync call actually examined, for honest UI copy (TASKS.md
 * BRK-015: "a routine sync must never read as fully in sync when it only
 * examined a recent window"). `"full"` covers BOTH the explicit Full resync
 * action AND a routine sync's own first-ever run (no committed watermark
 * exists yet, so no `from` bound was sent either) -- in both cases the
 * ACTUAL Sharesight request carried no date filter, which is the fact this
 * type reports, independent of which action asked for it.
 */
export type SharesightSyncWindow =
  { kind: "full" } | { kind: "narrowed"; sinceDate: string };
