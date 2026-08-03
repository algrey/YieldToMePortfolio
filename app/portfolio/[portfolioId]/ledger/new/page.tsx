import Link from "next/link";
import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";

type ManualLedgerEntryPageProps = {
  params: Promise<{ portfolioId: string }>;
};

export default async function ManualLedgerEntryPage({
  params,
}: ManualLedgerEntryPageProps) {
  const { portfolioId } = await params;
  const workspace = await loadAuthenticatedWorkspace(portfolioId);

  if (workspace.status === "unavailable") {
    return (
      <main className="manual-workflow-placeholder">
        <section className="empty-state" aria-labelledby="ledger-unavailable">
          <p className="eyebrow">Private ledger</p>
          <h1 id="ledger-unavailable">Manual entry unavailable</h1>
          <p>
            The owned portfolio could not be verified. No portfolio data or
            financial form is shown.
          </p>
        </section>
      </main>
    );
  }

  if (workspace.activePortfolio === null) notFound();

  return (
    <main className="manual-workflow-placeholder">
      <section className="empty-state" aria-labelledby="ledger-coming-soon">
        <p className="eyebrow">Separate financial workflow</p>
        <h1 id="ledger-coming-soon">Manual entry is not available yet</h1>
        <p>
          Ledger inspection remains read-only. Manual transactions and immutable
          corrections will be enabled only when their dedicated, validated
          workflow is complete.
        </p>
        <Link href={`/portfolio/${portfolioId}/details`}>
          Return to portfolio details
        </Link>
      </section>
    </main>
  );
}
