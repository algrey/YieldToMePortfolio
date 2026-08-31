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
  // PRF-004 (owner-reported: tab navigation still 3-10+s on Workers Free):
  // the portfolio lookup below depends ONLY on the resolved `userId`, never
  // on anything `identity.resolve()`'s own `touchWithAudit` write produces
  // -- but `userId` is known well before that write finishes (see
  // `identity-lifecycle.ts`'s `onIdentityKnown` doc comment). Firing the
  // portfolio query as soon as `userId` is known lets it run CONCURRENTLY
  // with the audit write's D1 round trip instead of strictly after it,
  // removing one full sequential hop from every authenticated page load.
  // `portfolios` is created here (no DB call yet) so the callback can use it
  // the moment `userId` is known.
  const portfolios = createOwnedPortfolioRepository(client, undefined, {
    requestId: options?.requestId,
  });
  let earlyActivePortfolio: Promise<OwnedPortfolioRecord | null> | null = null;
  const identity = await createIdentityLifecycleService(client, {
    ...options,
    onIdentityKnown: (userId) => {
      earlyActivePortfolio = requestedPortfolioId
        ? portfolios.get(userId, requestedPortfolioId)
        : portfolios.list(userId).then((list) => list[0] ?? null);
    },
  }).resolve(principal);
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

  // PRF-004: `earlyActivePortfolio` is set the moment `userId` was known
  // (see this function's own PRF-004 comment above) -- by this point it is
  // either already resolved or resolving concurrently with the audit write
  // that just finished, so this simply joins it rather than issuing a fresh,
  // now-redundant query. Only the (structurally rare) `provisioning` branch
  // of `identity.resolve()` -- a brand-new user, whose `userId` is not known
  // until its own INSERT completes -- ever leaves this `null`, in which case
  // this falls back to the original sequential lookup, unchanged.
  const activePortfolio: OwnedPortfolioRecord | null = earlyActivePortfolio
    ? await earlyActivePortfolio
    : requestedPortfolioId
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
