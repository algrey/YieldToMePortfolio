// BRK-005B: pure, directly-testable helpers shared by
// `components/sharesight-sync-panel.tsx`, `components/import-review.tsx`,
// and the server-only `owned-sharesight-links.ts` loader -- mirrors
// `dividend-history-prefill.ts`'s extraction pattern (UI-006C) so
// message-formatting/state-merging logic can be pinned by tests without
// executing React effects. This codebase's component tests render static
// markup only (`renderToStaticMarkup`); there is no jsdom harness to
// exercise client-side fetch/dialog state transitions, so any logic that
// needs its own assertions independent of a specific render lives here.

/**
 * `linked`/`not_linked` are the two ordinary outcomes.
 *
 * `needs_repair` reports the pre-existing single-active-link invariant
 * being violated (more than one `enabled = true` row for this local
 * portfolio) -- the SAME condition `runSharesightSyncWithContext` itself
 * fails closed on with a 409 (see its "more than one enabled Sharesight
 * link" message) -- surfaced honestly to the owner as "needs a re-link"
 * rather than silently picking one of the several candidates or
 * masquerading as an ordinary "not linked".
 *
 * `unknown` is used by the CALLER (`app/import/page.tsx`) when the link
 * status genuinely could not be determined (a rare double D1-access
 * failure after `loadAuthenticatedWorkspace` already succeeded) --
 * `loadOwnedSharesightLinks` itself never returns it. Reviewer follow-up 1:
 * this must render with its OWN distinct copy ("Link status unavailable —
 * reload to retry."), never silently collapsed into "Not linked", which
 * would invite an owner to re-link over a perfectly good existing link just
 * because a snapshot read failed.
 */
export type SharesightLinkStatus =
  | { status: "linked"; sharesightPortfolioId: string }
  | { status: "not_linked" }
  | { status: "needs_repair" }
  | { status: "unknown" };

/**
 * The disabled-integration failure carries no structured "disabled" flag in
 * its JSON payload (`SharesightSyncActionFailure` is just
 * `{ ok: false; status; message }`) -- these two literal strings are the
 * only signal available to distinguish "Sharesight isn't connected for this
 * deployment" (an inert, expected state, never an error tone) from every
 * other 409 this same backend returns (e.g. "link first", "more than one
 * enabled link"), which ARE actionable errors. Mirrors
 * `disabledIntegrationFailure` in `app/sharesight-sync-service.ts` exactly.
 */
export function isDisabledIntegrationMessage(message: string): boolean {
  return (
    message === "Sharesight is not connected for this deployment." ||
    message === "Sharesight is only partially configured for this deployment."
  );
}

export type SharesightSyncSuccess = {
  ok: true;
  batchId: string;
  batchStatus: string;
  rowsStaged: number;
  skippedPayouts: number;
  reused: boolean;
};

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

/** Batch created-vs-reused (with its CURRENT status -- reviewer follow-up
 * 2: a reused batch that is already `committed` must never read as though
 * there is fresh pending work to stage/review), row count, and a
 * skipped-payout warning naming where to find details -- never silently
 * dropping the skipped count.
 *
 * BRK-005C: `skippedPayouts` now counts only FUTURE-dated (not-yet-paid)
 * unconfirmed payouts -- a past-dated unconfirmed payout stages as a real
 * row instead (`domain/sharesight-sync/transform.ts`'s BRK-005C
 * correction), so the copy below says "future-dated" rather than the prior
 * "unconfirmed" wording, which would otherwise wrongly imply every
 * unconfirmed payout was skipped. */
export function formatSyncResultMessage(result: SharesightSyncSuccess): string {
  const batchLine = result.reused
    ? `No changes since last sync -- reused batch ${result.batchId} (status: ${statusLabel(result.batchStatus)}).`
    : `Created batch ${result.batchId}.`;
  const rowsLine = `${result.rowsStaged} row${result.rowsStaged === 1 ? "" : "s"} staged.`;
  const skippedLine =
    result.skippedPayouts > 0
      ? ` ${result.skippedPayouts} future-dated payout${result.skippedPayouts === 1 ? "" : "s"} skipped -- not yet paid; details in the batch preview.`
      : "";
  return `${batchLine} ${rowsLine}${skippedLine}`;
}

/**
 * Review finding B1 (BLOCKING): `SharesightSyncPanel` previously seeded its
 * OWN local `link` state once from an `initialLink` prop, then remounted
 * (via `key={targetPortfolioId}`) on every target-portfolio switch --
 * switching away and back silently re-read the STALE server-rendered
 * snapshot, discarding a link created earlier in the same session
 * (reviewer repro: link A -> switch to B -> back to A -> "Not linked",
 * Sync button gone). Fixed by hoisting the link map into `ImportReview`'s
 * OWN state (`sharesightLinkOverrides`), which -- unlike the panel's
 * per-portfolio remounted state -- persists across every target-portfolio
 * switch for the lifetime of the page. `mergeSharesightLinks` is the exact,
 * directly-testable merge `ImportReview` performs each render: the
 * server-seeded base map overlaid by whatever has actually been linked
 * client-side since.
 */
export function mergeSharesightLinks<T>(
  base: Record<string, T>,
  overrides: Record<string, T>,
): Record<string, T> {
  return { ...base, ...overrides };
}
