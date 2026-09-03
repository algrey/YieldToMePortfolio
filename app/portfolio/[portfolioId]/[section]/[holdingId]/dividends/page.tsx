import { notFound } from "next/navigation";
import {
  loadAuthenticatedWorkspace,
  type AuthenticatedWorkspaceSqlContext,
} from "../../../../../authenticated-workspace";
import { loadOwnedSecurityDividendDetail } from "../../../../../owned-security-dividends";
import { loadOwnedHoldingIdentity } from "../../../../../owned-holding-transactions";
import { SecurityDividendsTab } from "../../../../../components/security-dividends-tab";
import { HoldingAreaUnavailable } from "../../../../../components/holding-nav";
import { holdingSubtitle } from "../../../../../holding-subtitle";

// UI-023C (owner-reported): the per-security Dividends screen used to live
// at `/portfolio/:id/securities/:portfolioSecurityId/dividends` -- an
// orphan outside the holding area's chrome with no way back to the ticker's
// other views. It is now the holding area's fourth sub-tab; the old route
// redirects here. Same owner-scoped, force-dynamic loading as before
// (UI-006C), same guards as the sibling tab pages.
export const dynamic = "force-dynamic";

type HoldingDividendsPageProps = {
  params: Promise<{
    portfolioId: string;
    section: string;
    holdingId: string;
  }>;
};

export default async function HoldingDividendsPage({
  params,
}: HoldingDividendsPageProps) {
  const { portfolioId, section, holdingId } = await params;
  // Owned mode only: the preview fixture has no dividend ledger, and the
  // only valid section for this area is the Holdings tab it was entered
  // from.
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
        active="dividends"
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
        active="dividends"
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

  let detail: Awaited<ReturnType<typeof loadOwnedSecurityDividendDetail>>;
  try {
    // PRF-013: `loadOwnedHoldingIdentity` above already confirmed ownership
    // (and threw `notFound()` if it failed), so this skips
    // `loadOwnedSecurityDividendDetail`'s own redundant ownership SELECT.
    detail = await loadOwnedSecurityDividendDetail(
      context.client,
      context.userId,
      portfolioId,
      holdingId,
      new Date(),
      { identityConfirmed: true },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") notFound();
    return (
      <HoldingAreaUnavailable
        portfolioId={portfolioId}
        portfolioSecurityId={holdingId}
        active="dividends"
        message="This security's dividend history could not be loaded."
      />
    );
  }

  return (
    <SecurityDividendsTab
      portfolioId={portfolioId}
      portfolioSecurityId={detail.portfolioSecurityId}
      symbol={detail.symbol}
      subtitle={holdingSubtitle(identity)}
      currencyCode={detail.currencyCode}
      baseCurrencyCode={workspace.activePortfolio.baseCurrencyCode}
      today={detail.today}
      rows={detail.rows}
      rowDisplayById={detail.rowDisplayById}
      filteredArtifactCount={detail.filteredArtifactCount}
      lifetimeTotals={detail.lifetimeTotals}
      overridesByEventId={detail.overridesByEventId}
      manualRecordsById={detail.manualRecordsById}
      frankingOverridesByManualRecordId={
        detail.frankingOverridesByManualRecordId
      }
      assumptions={detail.assumptions}
      portfolioAssumptions={detail.portfolioAssumptions}
    />
  );
}
