import { ImportReview } from "../components/import-review";
import { HistoryBackControl } from "../components/back-control";
import { loadAuthenticatedWorkspace } from "../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../portfolio-actions";
import { loadOwnedSharesightLinks } from "../owned-sharesight-links";
import type { SharesightLinkStatus } from "../sharesight-sync-panel-helpers";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const workspace = await loadAuthenticatedWorkspace();
  if (workspace.status !== "ready" && workspace.status !== "empty") {
    return (
      <main className="import-review-page">
        <div className="subnav-heading">
          <HistoryBackControl fallbackHref="/" label="Back" />
          <p className="eyebrow">Import review</p>
        </div>
        <h1>Import is unavailable</h1>
        <p>{workspace.message ?? "Your private workspace is unavailable."}</p>
      </main>
    );
  }
  // UI-049 (owner-reported): a fresh installation with zero portfolios used
  // to dead-end here with "Create a portfolio first" -- but the full-system
  // restore panel this page renders below (EXP-002/EXP-003) exists
  // specifically to repopulate a fresh deployment, which IS this exact
  // zero-portfolio state. The page must always render so restore stays
  // reachable; `ImportReview` itself degrades the CSV-import section when
  // `portfolios` is empty (see its own header note).
  // BRK-005B: `loadAuthenticatedWorkspace` already verified auth and D1
  // access above -- a second `getAuthenticatedSqlContext` failure here is a
  // rare double-failure, not a normal path. Review follow-up 1: degrading
  // to "not linked" here would be dishonest (a real link could still exist
  // -- this snapshot simply could not be read), so every portfolio gets the
  // distinct `unknown` status instead; the section's own Link/Sync actions
  // independently re-verify ownership server-side regardless of what this
  // snapshot shows.
  const context = await getAuthenticatedSqlContext();
  const sharesightLinks: Record<string, SharesightLinkStatus> = context.ok
    ? await loadOwnedSharesightLinks(
        context.client,
        context.userId,
        workspace.portfolios.map((portfolio) => portfolio.id),
      )
    : Object.fromEntries(
        workspace.portfolios.map((portfolio) => [
          portfolio.id,
          { status: "unknown" as const },
        ]),
      );
  return (
    <ImportReview
      portfolios={workspace.portfolios.map((portfolio) => ({
        id: portfolio.id,
        name: portfolio.name,
        homeCurrencyCode: portfolio.homeCurrencyCode,
      }))}
      sharesightLinks={sharesightLinks}
    />
  );
}
