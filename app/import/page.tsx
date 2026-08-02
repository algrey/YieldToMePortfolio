import { ImportReview } from "../components/import-review";
import { loadAuthenticatedWorkspace } from "../authenticated-workspace";

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
  return (
    <ImportReview
      portfolios={workspace.portfolios.map((portfolio) => ({
        id: portfolio.id,
        name: portfolio.name,
        homeCurrencyCode: portfolio.homeCurrencyCode,
      }))}
    />
  );
}
