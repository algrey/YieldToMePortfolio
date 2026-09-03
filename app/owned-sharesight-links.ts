// BRK-005B: server-only loader for the current Sharesight link status of
// each of the owner's portfolios, read directly off `sharesight_sync_state`
// (BRK-004's cursor table). BRK-005's own action layer
// (`sharesight-sync-actions.ts`/`sharesight-sync-service.ts`) never exposes
// a "read current link" result -- `listSharesightPortfoliosWithContext`
// lists SHARESIGHT's own portfolios (for the link dialog), not this app's
// stored link -- so the import screen's link-status line is read here,
// server-side, exactly like `owned-holdings.ts`/`owned-security-dividends.ts`
// compose repository reads for their pages, rather than inventing a new
// client-facing route just to answer "is this portfolio linked".
//
// `linkExclusive` (see that repository method's header note) guarantees at
// most one ENABLED row per (user, portfolio) under normal operation; the
// sync path itself still fails closed (409) if it ever observes more than
// one. Review follow-up 1: this loader used to fold that violation into a
// bare "not linked" (`null`), which is dishonest -- a portfolio stuck in
// that state IS linked, just ambiguously, and needs a re-link rather than
// being told there is nothing to sync from at all. It is now its own
// `needs_repair` status (see `SharesightLinkStatus`'s header note), never a
// non-deterministic pick of one of the several enabled rows.
//
// PRF-011: this used to call `createSharesightSyncStateRepository(client)
// .list(userId, portfolioId)` once PER portfolio (`Promise.all` still runs
// them concurrently, but that is still N round trips against the SAME
// table, one per portfolio on every `/import` load). Replaced with ONE
// `WHERE user_id = ? AND portfolio_id IN (...)` read, chunked at 50 ids per
// statement exactly like `db/repositories/sharesight-delayed-price-
// cache.ts`'s `loadSharesightDelayedPriceCache` (see that constant's doc
// comment for the bind-parameter-ceiling rationale), grouped back into a
// per-portfolio list in memory. Same table, same columns, same
// enabled-count-per-portfolio status derivation -- only the read shape
// changed.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import type { SharesightLinkStatus } from "./sharesight-sync-panel-helpers.ts";

export type { SharesightLinkStatus } from "./sharesight-sync-panel-helpers.ts";

/** Mirrors `sharesight-delayed-price-cache.ts`'s own chunk size/rationale:
 * keeps every single `IN (...)` statement to at most 51 bind params (1
 * `userId` + up to 50 portfolio ids), regardless of how many portfolios the
 * owner has. */
const LINK_READ_CHUNK_SIZE = 50;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function loadOwnedSharesightLinks(
  client: SqlClient,
  userId: string,
  portfolioIds: readonly string[],
): Promise<Record<string, SharesightLinkStatus>> {
  const unique = [...new Set(portfolioIds)];
  const enabledByPortfolio = new Map<string, string[]>();
  for (const batchIds of chunk(unique, LINK_READ_CHUNK_SIZE)) {
    if (batchIds.length === 0) continue;
    const placeholders = batchIds.map(() => "?").join(",");
    const rows = await client.all<{
      portfolio_id: string;
      sharesight_portfolio_id: string;
    }>(
      `SELECT portfolio_id, sharesight_portfolio_id
         FROM sharesight_sync_state
        WHERE user_id = ? AND enabled = 1 AND portfolio_id IN (${placeholders})`,
      [userId, ...batchIds],
    );
    for (const row of rows) {
      const list = enabledByPortfolio.get(row.portfolio_id) ?? [];
      list.push(row.sharesight_portfolio_id);
      enabledByPortfolio.set(row.portfolio_id, list);
    }
  }
  const result: Record<string, SharesightLinkStatus> = {};
  for (const portfolioId of unique) {
    const enabled = enabledByPortfolio.get(portfolioId) ?? [];
    result[portfolioId] =
      enabled.length === 0
        ? { status: "not_linked" }
        : enabled.length === 1
          ? {
              status: "linked",
              sharesightPortfolioId: enabled[0]!,
            }
          : { status: "needs_repair" };
  }
  return result;
}
