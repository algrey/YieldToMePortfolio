import Link from "next/link";
import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";
import { ManualLedgerEntry } from "../../../../components/manual-ledger-entry";
import {
  loadOwnedManualLedgerOptions,
  type ManualLedgerOptions,
} from "../../../../../db/repositories/manual-ledger-options";
import { getAuthenticatedSqlContext } from "../../../../portfolio-actions";

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

  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) {
    return (
      <main className="manual-workflow-placeholder">
        <section
          className="empty-state"
          aria-labelledby="ledger-options-unavailable"
        >
          <p className="eyebrow">Private ledger</p>
          <h1 id="ledger-options-unavailable">Manual entry unavailable</h1>
          <p>
            The owned ledger options could not be loaded. No mutation form is
            shown.
          </p>
          <Link href={`/portfolio/${portfolioId}/details`}>
            Return to portfolio details
          </Link>
        </section>
      </main>
    );
  }
  let options: ManualLedgerOptions;
  try {
    options = await loadOwnedManualLedgerOptions(
      context.client,
      context.userId,
      portfolioId,
    );
  } catch {
    return (
      <main className="manual-workflow-placeholder">
        <section
          className="empty-state"
          aria-labelledby="ledger-options-unavailable"
        >
          <p className="eyebrow">Private ledger</p>
          <h1 id="ledger-options-unavailable">Manual entry unavailable</h1>
          <p>
            The owned ledger options could not be loaded. No mutation form is
            shown.
          </p>
          <Link href={`/portfolio/${portfolioId}/details`}>
            Return to portfolio details
          </Link>
        </section>
      </main>
    );
  }
  return (
    <ManualLedgerEntry
      portfolioId={portfolioId}
      baseCurrencyCode={workspace.activePortfolio.baseCurrencyCode}
      options={options}
    />
  );
}
