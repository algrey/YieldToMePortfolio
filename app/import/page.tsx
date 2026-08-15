import { ImportReview } from "../components/import-review";
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
        <p className="eyebrow">Import review</p>
        <h1>Import is unavailable</h1>
        <p>{workspace.message ?? "Your private workspace is unavailable."}</p>
      </main>
    );
  }
  if (workspace.portfolios.length === 0) {
    return (
      <main className="import-review-page">
        <p className="eyebrow">Import review</p>
        <h1>Create a portfolio first</h1>
        <p>No private portfolio is available to receive this import.</p>
      </main>
    );
  }
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
