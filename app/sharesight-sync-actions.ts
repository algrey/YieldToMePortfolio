// BRK-005: thin action wrappers that resolve authenticated owner context
// (`getAuthenticatedSqlContext`, which pulls in `next/headers`/the D1
// binding resolver) and delegate to `sharesight-sync-service.ts`'s
// `*WithContext` business logic -- kept separate so that service module
// stays directly testable against a plain sqlite-backed `SqlClient` (see
// its header note; mirrors `import-actions.ts`'s split from
// `import-ready-service.ts`/`security-verification-service.ts`).
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";
import {
  linkSharesightPortfolioWithContext,
  listSharesightPortfoliosWithContext,
  runSharesightSyncWithContext,
  type LinkSharesightPortfolioResult,
  type ListSharesightPortfoliosResult,
  type RunSharesightSyncResult,
} from "./sharesight-sync-service.ts";

export async function listSharesightPortfoliosAction(
  portfolioId: string,
): Promise<ListSharesightPortfoliosResult> {
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  return listSharesightPortfoliosWithContext(context, portfolioId);
}

export async function linkSharesightPortfolioAction(
  portfolioId: string,
  value: unknown,
): Promise<LinkSharesightPortfolioResult> {
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  return linkSharesightPortfolioWithContext(context, portfolioId, value);
}

export async function runSharesightSyncAction(
  portfolioId: string,
): Promise<RunSharesightSyncResult> {
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  return runSharesightSyncWithContext(context, portfolioId);
}
