import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type CreateUnresolvedPortfolioSecurity = {
  id: string;
  userId: string;
  portfolioId: string;
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  sourceName: string | null;
  displaySymbol: string | null;
  displayName: string | null;
  firstRelevantDate: string | null;
  lastRelevantDate: string | null;
  createdAt: string;
};

export function createPortfolioSecurityRepository(
  db: DrizzleD1Database<typeof schema>,
) {
  return {
    async createUnresolved(input: CreateUnresolvedPortfolioSecurity) {
      await db.insert(schema.portfolioSecurities).values({
        ...input,
        securityId: null,
        status: "unresolved",
        updatedAt: input.createdAt,
      });
    },

    async findOwned(
      userId: string,
      portfolioId: string,
      portfolioSecurityId: string,
    ) {
      return await db.query.portfolioSecurities.findFirst({
        where: and(
          eq(schema.portfolioSecurities.id, portfolioSecurityId),
          eq(schema.portfolioSecurities.userId, userId),
          eq(schema.portfolioSecurities.portfolioId, portfolioId),
        ),
      });
    },
  };
}
