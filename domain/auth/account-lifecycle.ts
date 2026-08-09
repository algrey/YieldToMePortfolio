import { randomUUID } from "node:crypto";
import type { VerifiedAccessPrincipal } from "./access-jwt.ts";
import {
  createIdentityLifecycleService,
  type IdentityLifecycleOptions,
} from "./identity-lifecycle.ts";
import {
  createAccountLifecycleRepository,
  type AccountLifecycleRequest,
  type AccountLifecycleRequestType,
} from "../../db/repositories/account-lifecycle.ts";
import type { SqlClient } from "../../db/repositories/sql-client.ts";

export type AccountLifecycleResult =
  | { ok: true; request: AccountLifecycleRequest; userId: string }
  | {
      ok: false;
      reason:
        | "invalid-principal"
        | "missing-email"
        | "identity-revoked"
        | "user-not-active"
        | "provisioning-pending"
        | "jit-disabled"
        | "invalid-request"
        | "not-found";
    };

export type AccountLifecycleServiceOptions = IdentityLifecycleOptions & {
  now?: () => string;
};

/**
 * Binds lifecycle actions to the verified Access principal. There is no
 * target-user argument here: support/admin workflows need a separately
 * authorized actor path before they can operate on another account.
 */
export function createAccountLifecycleService(
  client: SqlClient,
  options: AccountLifecycleServiceOptions = {},
) {
  const identity = createIdentityLifecycleService(client, options);
  const repository = createAccountLifecycleRepository(
    client,
    options.now ?? (() => new Date().toISOString()),
  );
  const now = options.now ?? (() => new Date().toISOString());

  async function request(
    principal: VerifiedAccessPrincipal,
    requestType: AccountLifecycleRequestType,
    idempotencyKey: string,
    requestId?: string,
    includeExport = false,
  ): Promise<AccountLifecycleResult> {
    const resolved = await identity.resolve(principal);
    if (!resolved.ok) {
      const retry = await repository.getForPrincipal(
        principal.issuer,
        principal.subject,
        requestType,
        idempotencyKey,
      );
      if (retry) {
        return { ok: true, request: retry, userId: retry.userId };
      }
      return { ok: false, reason: resolved.reason };
    }

    try {
      const lifecycleRequest = await repository.request({
        userId: resolved.user.id,
        actorUserId: resolved.user.id,
        requestType,
        idempotencyKey,
        includeExport,
        requestId: requestId ?? randomUUID(),
        now: now(),
      });
      return { ok: true, request: lifecycleRequest, userId: resolved.user.id };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "invalid_lifecycle_request"
      ) {
        return { ok: false, reason: "invalid-request" };
      }
      throw error;
    }
  }

  return {
    request,
    disable: (
      principal: VerifiedAccessPrincipal,
      idempotencyKey: string,
      requestId?: string,
    ) => request(principal, "disable", idempotencyKey, requestId, false),
    requestDeletion: (
      principal: VerifiedAccessPrincipal,
      idempotencyKey: string,
      requestId?: string,
      includeExport = false,
    ) =>
      request(principal, "deletion", idempotencyKey, requestId, includeExport),
    export: async (
      principal: VerifiedAccessPrincipal,
      idempotencyKey: string,
      requestId?: string,
    ): Promise<AccountLifecycleResult> =>
      request(principal, "export", idempotencyKey, requestId, true),
  };
}
