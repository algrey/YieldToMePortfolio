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
import { createSharesightSyncStateRepository } from "../db/repositories/index.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import type { SharesightLinkStatus } from "./sharesight-sync-panel-helpers.ts";

export type { SharesightLinkStatus } from "./sharesight-sync-panel-helpers.ts";

export async function loadOwnedSharesightLinks(
  client: SqlClient,
  userId: string,
  portfolioIds: readonly string[],
): Promise<Record<string, SharesightLinkStatus>> {
  const repository = createSharesightSyncStateRepository(client);
  const entries = await Promise.all(
    portfolioIds.map(async (portfolioId) => {
      const links = await repository.list(userId, portfolioId);
      const enabled = links.filter((link) => link.enabled);
      const status: SharesightLinkStatus =
        enabled.length === 0
          ? { status: "not_linked" }
          : enabled.length === 1
            ? {
                status: "linked",
                sharesightPortfolioId: enabled[0]!.sharesightPortfolioId,
              }
            : { status: "needs_repair" };
      return [portfolioId, status] as const;
    }),
  );
  return Object.fromEntries(entries);
}
