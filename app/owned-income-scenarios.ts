import {
  createIncomeScenarioRepository,
  type IncomeScenarioRecord,
} from "../db/repositories/index.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";

export type { IncomeScenarioRecord };

// DIV-014: server-side loader for the Income multi-year page's "Save
// Scenario" list -- mirrors `app/owned-watchlist.ts`'s thin
// repository-wrapping shape (a page-level `app/owned-*.ts` module rather
// than the page importing `db/repositories/*` directly, matching every
// other owned-mode page loader in this codebase).
export async function loadOwnedIncomeScenarios(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<IncomeScenarioRecord[]> {
  return createIncomeScenarioRepository(client).list(userId, portfolioId);
}
