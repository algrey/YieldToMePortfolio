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
import { createIdentityRepository } from "../../db/repositories/identity.ts";
import type { SqlClient } from "../../db/repositories/sql-client.ts";

export type AuthenticatedRequestContext = {
  user: InternalUser;
  activePortfolio: OwnedPortfolioRecord | null;
};

export type RequestContextResult =
  | { ok: true; context: AuthenticatedRequestContext }
  | { ok: false; reason: "identity" | "portfolio-not-found" }
  | {
      ok: false;
      reason: "lifecycle";
      lifecycle: "disabled" | "deletion_pending" | "purged";
    };

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
    if (
      identity.reason === "user-not-active" ||
      identity.reason === "identity-revoked"
    ) {
      const linked = await createIdentityRepository(client).findAccessIdentity(
        principal.issuer,
        principal.subject,
      );
      const userRecord = !linked
        ? await client.get<{ status: string }>(
            "SELECT status FROM users AS u INNER JOIN account_lifecycle_requests AS alr ON alr.user_id = u.id INNER JOIN user_identities AS ui ON ui.user_id = alr.user_id WHERE ui.issuer=? AND ui.subject=? LIMIT 1",
            [principal.issuer, principal.subject],
          )
        : null;
      const status = linked?.userStatus ?? userRecord?.status;
      return {
        ok: false,
        reason: "lifecycle",
        lifecycle:
          status === "deletion_pending"
            ? "deletion_pending"
            : status === "purged"
              ? "purged"
              : "disabled",
      };
    }
    return { ok: false, reason: "identity" };
  }

  const portfolios = createOwnedPortfolioRepository(client, undefined, {
    requestId: options?.requestId,
  });
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
