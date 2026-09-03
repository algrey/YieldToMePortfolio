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

/**
 * BRK-015: mirrors `domain/sharesight-sync/window.ts`'s
 * `SharesightStreamWindow`/`SharesightSyncWindow` (fresh, structurally-
 * identical types here rather than importing that domain module, since this
 * file -- unlike its sibling `-service.ts` -- is consumed by the CLIENT
 * component and must stay import-light).
 *
 * Review round B1 fix: trades and payouts are reported as TWO SEPARATE
 * stream windows, never folded into one -- the two streams narrow
 * independently (their own watermark, their own overlap constant), so a
 * shared summary could silently overstate coverage for whichever stream
 * happened to have the wider window.
 */
export type SharesightSyncStreamWindowSummary =
  { kind: "full" } | { kind: "narrowed"; sinceDate: string };

export type SharesightSyncWindowSummary = Readonly<{
  trades: SharesightSyncStreamWindowSummary;
  payouts: SharesightSyncStreamWindowSummary;
}>;

export type SharesightSyncSuccess = {
  ok: true;
  batchId: string;
  batchStatus: string;
  rowsStaged: number;
  skippedPayouts: number;
  // BRK-014 (owner-reported): of `rowsStaged`, how many are genuinely NEW
  // versus already match a currently-committed record for this portfolio.
  // Always `newRows + alreadyImportedRows === rowsStaged`. See
  // `app/sharesight-sync-service.ts`'s `isRowAlreadyImported` doc comment
  // for the exact "unchanged identity + unchanged value" definition and why
  // a Sharesight-side value correction counts as `newRows`, never
  // `alreadyImportedRows`.
  newRows: number;
  alreadyImportedRows: number;
  reused: boolean;
  window: SharesightSyncWindowSummary;
};

/** BRK-015: the two sync modes the owner can trigger -- `"routine"` (the
 * default, watermark-narrowed) and `"full"` (the explicit secondary action,
 * unconditional fetch). Shared by the panel's fetch-URL builder and the
 * route's query-param parser so both sides of the wire agree on the exact
 * same two literal strings. */
export type SharesightSyncModeParam = "routine" | "full";

/**
 * Review round follow-up 3 fix: the panel's fetch URL and the route's query
 * parsing were each an untested inline literal (`?mode=${mode}` / a raw
 * `searchParams.get("mode") === "full"` check), and the one regression test
 * that used to pin this exact string was RELAXED (to tolerate any query
 * string at all) rather than fixed when the panel grew the query param --
 * "the tested layer is not the layer the browser hits." `buildSharesightSyncUrl`
 * is now the SINGLE place that literal query string is constructed;
 * `resolveSharesightSyncMode` (below) is the SINGLE place it is parsed back
 * out server-side -- both directly unit-tested against the exact wire
 * string, not just source-scanned.
 */
export function buildSharesightSyncUrl(
  portfolioId: string,
  mode: SharesightSyncModeParam,
): string {
  return `/api/portfolios/${portfolioId}/sharesight-sync?mode=${mode}`;
}

/**
 * Parses the sync route's `?mode=` query param from a request URL. Anything
 * other than the exact literal `"full"` -- including it being entirely
 * absent -- resolves to `"routine"`: this query param is same-origin UI
 * wiring, not owner-facing input that needs its own validation error, so an
 * unrecognised value fails safe to the narrower, cheaper default rather
 * than rejecting the request.
 */
export function resolveSharesightSyncMode(
  url: string | URL,
): SharesightSyncModeParam {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return parsed.searchParams.get("mode") === "full" ? "full" : "routine";
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

/**
 * BRK-015: honest window disclosure -- "a routine sync must never read as
 * fully in sync with Sharesight when it only examined a recent window"
 * (TASKS.md). Always rendered, never conditionally dropped, so a `narrowed`
 * result can never be silently read as complete. Review round B1 fix:
 * states trades and payouts SEPARATELY (never a single combined date) --
 * the two streams narrow independently, so collapsing them into one
 * sentence could silently overstate coverage for whichever stream actually
 * had the narrower window.
 */
function windowLabel(window: SharesightSyncWindowSummary): string {
  if (window.trades.kind === "full" && window.payouts.kind === "full") {
    return "Checked your entire Sharesight history (trades and dividends).";
  }
  const tradesText =
    window.trades.kind === "narrowed"
      ? `trades since ${window.trades.sinceDate}`
      : "all trades";
  const payoutsText =
    window.payouts.kind === "narrowed"
      ? `dividends since ${window.payouts.sinceDate}`
      : "all dividends";
  return `Routine sync: checked ${tradesText} and ${payoutsText} (not your full history -- use Full resync to check everything).`;
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
/**
 * BRK-014 (owner-reported): the core fix for "It is unclear... it appears
 * to download everything" -- this line must let the owner tell a routine
 * no-op sync from one that will actually change their ledger BEFORE they
 * open the preview. Only rendered when rows were actually staged (a
 * zero-staged sync already reads unambiguously from `rowsLine` alone).
 *
 * Review round 3 (BLOCKING, correction to the round-1/round-2 wording): a
 * `newRows === 0` sync can happen two structurally different ways, and they
 * must not share one sentence.
 *
 * - `reused === true`: `startUpload`'s content-addressed dedupe resolved
 *   this fetch to the SAME batch as last time -- the fetched rows were
 *   BYTE-IDENTICAL to the prior sync (see `canonicalFetchDigestSource`),
 *   so "every staged row already matches an existing record" is literally
 *   true. Keeps the original "No new rows" copy.
 * - `reused === false`: a NEW batch was created, which only happens when
 *   `canonicalRowDigestFields`'s thirteen-field digest differed from every
 *   prior sync's -- something in the fetched rows genuinely changed. If
 *   `isRowAlreadyImported` still counts every row as already-imported, the
 *   only way both facts can be true is that the change landed on a field
 *   this function does NOT compare (`symbol`/`exchange` for either row
 *   kind, or a payout's `currency`/native-payout FX rate -- see
 *   `app/sharesight-sync-service.ts`'s `isRowAlreadyImported` doc comment
 *   for the exact residual list). Saying "already matches" here would be
 *   self-contradictory (a new batch that changed nothing cannot exist), so
 *   this case gets its own honest sentence naming what WAS checked and that
 *   something outside that set changed.
 *
 * The all-new and mixed shapes are unchanged: the all-new case omits the
 * redundant "0 already imported" clause; the mixed case names both counts.
 */
function newVsAlreadyImportedLine(result: SharesightSyncSuccess): string {
  if (result.rowsStaged === 0) return "";
  if (result.newRows === 0) {
    if (!result.reused) {
      return (
        " None differ from your ledger on the compared fields (quantity, " +
        "price, fee, date, type, currency for trades; cash, franking, " +
        "payment date, FX where recorded for payouts), but Sharesight's " +
        "data differs from the previous sync on a field that is not " +
        "compared (for example a symbol, exchange or market code change) " +
        "-- review the batch before accepting."
      );
    }
    return " No new rows -- every staged row already matches an existing record.";
  }
  const newLabel = `${result.newRows} new row${result.newRows === 1 ? "" : "s"}`;
  if (result.alreadyImportedRows === 0) return ` ${newLabel}.`;
  return ` ${newLabel}; ${result.alreadyImportedRows} already imported.`;
}

export function formatSyncResultMessage(result: SharesightSyncSuccess): string {
  const batchLine = result.reused
    ? `No changes since last sync -- reused batch ${result.batchId} (status: ${statusLabel(result.batchStatus)}).`
    : `Created batch ${result.batchId}.`;
  const rowsLine = `${result.rowsStaged} row${result.rowsStaged === 1 ? "" : "s"} staged.`;
  const newVsExistingLine = newVsAlreadyImportedLine(result);
  const skippedLine =
    result.skippedPayouts > 0
      ? ` ${result.skippedPayouts} future-dated payout${result.skippedPayouts === 1 ? "" : "s"} skipped -- not yet paid; details in the batch preview.`
      : "";
  // BRK-015: the window disclosure is its own trailing sentence, always
  // present.
  return `${batchLine} ${rowsLine}${newVsExistingLine}${skippedLine} ${windowLabel(result.window)}`;
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
