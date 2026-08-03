import { loadOwnedPortfolioInspection as readPortfolioInspection } from "../db/repositories/portfolio-inspection.ts";
import type { PortfolioInspection } from "../db/repositories/portfolio-inspection.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";

export async function loadAuthenticatedPortfolioInspection(
  portfolioId: string,
): Promise<PortfolioInspection | null> {
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return null;
  return readPortfolioInspection(context.client, context.userId, portfolioId);
}
