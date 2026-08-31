import { notFound } from "next/navigation";
import {
  loadAuthenticatedWorkspace,
  type AuthenticatedWorkspaceSqlContext,
} from "../../../../../authenticated-workspace";
import {
  loadOwnedHoldingIdentity,
  loadOwnedHoldingTransactions,
} from "../../../../../owned-holding-transactions";
import { HoldingTransactionsScreen } from "../../../../../components/holding-transactions";
import { HoldingAreaUnavailable } from "../../../../../components/holding-nav";
import { holdingSubtitle } from "../../../../../holding-subtitle";

// UI-023: the per-holding Transactions tab -- every ledger transaction for
// one holding, owner-scoped, read-only, force-dynamic like every owned page.
export const dynamic = "force-dynamic";

type HoldingTransactionsPageProps = {
  params: Promise<{
    portfolioId: string;
    section: string;
    holdingId: string;
  }>;
};

export default async function HoldingTransactionsPage({
  params,
}: HoldingTransactionsPageProps) {
  const { portfolioId, section, holdingId } = await params;
  // Owned mode only: the preview fixture has no ledger, and the only valid
  // section for this area is the Holdings tab it was entered from.
  if (section !== "holdings" || portfolioId === "preview") {
    notFound();
  }

  // PRF-005 (Income area census follow-up: the same PRF-002 duplicate-
  // identity-resolution defect, never fixed on the holding sub-tab pages):
  // `sqlContextOut` recovers the client/userId `loadAuthenticatedWorkspace`
  // already resolved instead of paying for a second, duplicate
  // `getAuthenticatedSqlContext` identity resolution (which doubles
  // `touchWithAudit`'s write batch on every load of this page).
  const sqlContextOut: { current: AuthenticatedWorkspaceSqlContext } = {
    current: { ok: false },
  };
  const workspace = await loadAuthenticatedWorkspace(
    portfolioId,
    {},
    sqlContextOut,
  );
  if (workspace.status === "unavailable") {
    return (
      <HoldingAreaUnavailable
        portfolioId={portfolioId}
        portfolioSecurityId={holdingId}
        active="transactions"
        message={
          workspace.message ?? "The owned portfolio could not be verified."
        }
      />
    );
  }
  if (workspace.activePortfolio === null) notFound();

  const context = sqlContextOut.current;
  if (!context.ok) {
    return (
      <HoldingAreaUnavailable
        portfolioId={portfolioId}
        portfolioSecurityId={holdingId}
        active="transactions"
        message="Portfolio data is temporarily unavailable."
      />
    );
  }

  const identity = await loadOwnedHoldingIdentity(
    context.client,
    context.userId,
    portfolioId,
    holdingId,
  );
  if (!identity) notFound();

  let transactions: Awaited<ReturnType<typeof loadOwnedHoldingTransactions>>;
  try {
    transactions = await loadOwnedHoldingTransactions(
      context.client,
      context.userId,
      portfolioId,
      holdingId,
    );
  } catch {
    return (
      <HoldingAreaUnavailable
        portfolioId={portfolioId}
        portfolioSecurityId={holdingId}
        active="transactions"
        message="This holding's transactions could not be loaded."
      />
    );
  }

  return (
    <HoldingTransactionsScreen
      portfolioId={portfolioId}
      portfolioSecurityId={identity.portfolioSecurityId}
      symbol={identity.symbol}
      subtitle={holdingSubtitle(identity)}
      baseCurrencyCode={workspace.activePortfolio.baseCurrencyCode}
      rows={transactions.rows}
      truncated={transactions.truncated}
      totalCount={transactions.totalCount}
    />
  );
}
