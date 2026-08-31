import { loadPortfolioInspectionSafely } from "../db/repositories/portfolio-inspection.ts";
import type { PortfolioInspection } from "../db/repositories/portfolio-inspection.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";
import type { AuthenticatedWorkspaceSqlContext } from "./authenticated-workspace.ts";

export async function loadAuthenticatedPortfolioInspection(
  portfolioId: string,
  // PRF-002 (owner-reported production CPU-limit failure across every
  // authenticated page): `[section]/page.tsx`'s "details" branch already
  // calls `loadAuthenticatedWorkspace` (an auth/ownership gate) before
  // calling this function -- an optional `preResolvedSqlContext` lets that
  // caller pass the SAME `client`/`userId` it already resolved (via
  // `loadAuthenticatedWorkspace`'s `sqlContextOut` output slot) instead of
  // this function re-running a second, duplicate
  // `getAuthenticatedSqlContext` identity resolution (identity lookup plus
  // its `touchWithAudit` write). Omitted, this falls back to resolving its
  // own context exactly as before -- unchanged for any other caller.
  preResolvedSqlContext?: AuthenticatedWorkspaceSqlContext,
): Promise<PortfolioInspection | null> {
  const context =
    preResolvedSqlContext ?? (await getAuthenticatedSqlContext(portfolioId));
  if (!context.ok) return null;
  return loadPortfolioInspectionSafely(
    context.client,
    context.userId,
    portfolioId,
  );
}
