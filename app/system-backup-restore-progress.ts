// EXP-003: pure, DOM/localStorage/fetch-free resume-cursor logic for the
// full-system backup restore's chunked price-history upload
// (`app/components/system-backup-panel.tsx`) -- split out purely for
// testability under the plain Node test runner, which cannot import `.tsx`
// files at all ("Unknown file extension .tsx"). Mirrors
// `tests/div-013.test.ts`'s identically-documented constraint/pattern: pure
// decision logic lives in a `.ts` sibling and is unit-tested directly; the
// component's WIRING to it (the `fetch`/`localStorage` calls themselves) is
// pinned on source instead.
//
// Review B3 fix (BLOCKING, 2026-08-28): a resume cursor keyed only by the
// backup file's SHA-256 digest is silently WRONG evidence once the restore
// TARGET changes under it -- the SAME file re-selected against a FRESH
// deployment (this artifact's own primary documented purpose) or
// re-selected after the owner undoes the price history an earlier attempt
// wrote both keep the identical digest, so blindly trusting `nextChunk`
// would silently skip real, unwritten rows and misreport totals carried
// over from a run that no longer reflects the current database.
// `isResumeCursorValid` below is what lets a resume be validated against
// the CURRENT server rather than trusted outright.

export type RestoreProgress = {
  nextChunk: number;
  written: number;
  unresolvedRowCount: number;
  unchangedCount: number;
  /** The id of every price-upload batch this cursor's completed parts (`0`
   * .. `nextChunk - 1`) actually created, in order -- what
   * `isResumeCursorValid` checks against the CURRENT server before a resume
   * is honored. */
  batchIds: string[];
};

export const EMPTY_RESTORE_PROGRESS: RestoreProgress = {
  nextChunk: 0,
  written: 0,
  unresolvedRowCount: 0,
  unchangedCount: 0,
  batchIds: [],
};

export function restoreProgressStorageKey(digest: string): string {
  return `yieldtome-system-restore-v1:${digest}`;
}

/**
 * Total, never-throws parse of a raw `localStorage` value into a
 * `RestoreProgress` -- anything that is not a well-formed, non-negative
 * cursor falls back to `EMPTY_RESTORE_PROGRESS`. A cursor written before
 * this fix (or otherwise missing `batchIds`) is deliberately treated the
 * SAME as a missing cursor: it carries no evidence `isResumeCursorValid`
 * could check, so it is UNVERIFIABLE, not merely unverified -- see that
 * function's own comment for why unverifiable must mean "discard", never
 * "trust".
 */
export function parseStoredRestoreProgress(
  raw: string | null,
): RestoreProgress {
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<RestoreProgress> | null;
    if (
      parsed &&
      Number.isSafeInteger(parsed.nextChunk) &&
      parsed.nextChunk! >= 0 &&
      Number.isSafeInteger(parsed.written) &&
      parsed.written! >= 0 &&
      Number.isSafeInteger(parsed.unresolvedRowCount) &&
      parsed.unresolvedRowCount! >= 0 &&
      Number.isSafeInteger(parsed.unchangedCount) &&
      parsed.unchangedCount! >= 0 &&
      Array.isArray(parsed.batchIds) &&
      parsed.batchIds.every((id) => typeof id === "string")
    ) {
      return parsed as RestoreProgress;
    }
  } catch {
    // Malformed JSON is treated exactly like "no cursor" below.
  }
  return { ...EMPTY_RESTORE_PROGRESS };
}

/**
 * Review B3 fix (BLOCKING, 2026-08-28): a stored cursor is a RESUME CLAIM,
 * not a fact. This takes the batch ids the cursor CLAIMS its completed
 * parts wrote and the ids a cheap owner-scoped server probe reports as
 * STILL EXISTING (`GET /api/market-data/price-uploads`, called by the
 * component's `verifyResumeCursorBatches`) and says whether every claimed
 * id survives. `claimedBatchIds` being empty (a fresh cursor, `nextChunk ===
 * 0`) is vacuously valid -- there is nothing yet to verify. If even ONE
 * claimed id is missing (the batch was deleted, or never existed on THIS
 * server/database at all), the whole cursor is invalid: the caller must
 * discard it and restart at chunk 0 with zeroed totals, never reporting a
 * previous run's counts as this run's own. Restarting only costs time --
 * every write `confirmBackupPriceUpload` performs is an idempotent
 * natural-key upsert -- while trusting a stale cursor would silently drop
 * real rows.
 */
export function isResumeCursorValid(
  claimedBatchIds: readonly string[],
  existingBatchIds: ReadonlySet<string>,
): boolean {
  return claimedBatchIds.every((id) => existingBatchIds.has(id));
}
