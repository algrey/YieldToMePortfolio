import type { VerifiedAccessPrincipal } from "./access-jwt.ts";
import {
  createIdentityLifecycleService,
  type IdentityLifecycleOptions,
  type InternalUser,
} from "./identity-lifecycle.ts";
import {
  createOwnedPortfolioRepository,
  type OwnedPortfolioRecord,
} from "../../db/repositories/owned-portfolios.ts";
import type { SqlClient } from "../../db/repositories/sql-client.ts";

export type AuthenticatedRequestContext = {
  user: InternalUser;
  activePortfolio: OwnedPortfolioRecord | null;
};

export type RequestContextResult =
  | { ok: true; context: AuthenticatedRequestContext }
  | { ok: false; reason: "identity" | "portfolio-not-found" };

export async function resolveAuthenticatedRequestContext(
  client: SqlClient,
  principal: VerifiedAccessPrincipal,
  requestedPortfolioId?: string,
  options?: IdentityLifecycleOptions,
): Promise<RequestContextResult> {
  const identity = await createIdentityLifecycleService(
    client,
    options,
  ).resolve(principal);
  if (!identity.ok) {
    return { ok: false, reason: "identity" };
  }

  const portfolios = createOwnedPortfolioRepository(client);
  const activePortfolio = requestedPortfolioId
    ? await portfolios.get(identity.user.id, requestedPortfolioId)
    : ((await portfolios.list(identity.user.id))[0] ?? null);

  if (requestedPortfolioId !== undefined && activePortfolio === null) {
    return { ok: false, reason: "portfolio-not-found" };
  }

  return {
    ok: true,
    context: {
      user: identity.user,
      activePortfolio,
    },
  };
}
