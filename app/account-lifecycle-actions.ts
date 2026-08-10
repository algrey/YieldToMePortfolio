import { createAccountLifecycleRepository } from "../db/repositories/account-lifecycle.ts";
import {
  getAuthenticatedSqlContext,
  getVerifiedPrincipalSqlContext,
} from "./portfolio-actions.ts";

export type AccountLifecycleActionType =
  "disable" | "deletion" | "export" | "purge";

export type AccountLifecycleActionResult =
  | {
      ok: true;
      request:
        | Awaited<
            ReturnType<
              ReturnType<typeof createAccountLifecycleRepository>["get"]
            >
          >
        | Awaited<
            ReturnType<
              ReturnType<
                typeof createAccountLifecycleRepository
              >["purgeAccount"]
            >
          >;
    }
  | { ok: false; status: 400 | 401 | 404 | 409 | 503; message: string };

function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export async function requestAccountLifecycleAction(
  type: AccountLifecycleActionType,
  value: unknown,
): Promise<AccountLifecycleActionResult> {
  const input = value as {
    idempotencyKey?: unknown;
    includeExport?: unknown;
    confirmation?: unknown;
  } | null;
  if (!input || !validIdempotencyKey(input.idempotencyKey)) {
    return {
      ok: false,
      status: 400,
      message: "A valid idempotency key is required.",
    };
  }
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) {
    const recovery = await getVerifiedPrincipalSqlContext();
    if (!recovery.ok) return context;
    const repository = createAccountLifecycleRepository(recovery.client);
    if (type === "purge") {
      const existing = await repository.getForPrincipal(
        recovery.principal.issuer,
        recovery.principal.subject,
        "deletion",
        input.idempotencyKey,
      );
      if (!existing) return context;
      const purgeResult = await repository.purgeAccount(existing.userId, {
        idempotencyKey: input.idempotencyKey,
        confirmation:
          typeof input.confirmation === "string"
            ? input.confirmation
            : undefined,
        actorUserId: existing.userId,
        requestId: recovery.requestId,
      });
      if (!purgeResult.ok) {
        return {
          ok: false,
          status: 400,
          message: purgeResult.message ?? "Purge could not be completed.",
        };
      }
      return { ok: true, request: purgeResult };
    }
    const existing = await repository.getForPrincipal(
      recovery.principal.issuer,
      recovery.principal.subject,
      type,
      input.idempotencyKey,
    );
    if (!existing) return context;
    return { ok: true, request: existing };
  }
  try {
    const repository = createAccountLifecycleRepository(context.client);
    if (type === "purge") {
      const purgeResult = await repository.purgeAccount(context.userId, {
        idempotencyKey: input.idempotencyKey,
        confirmation:
          typeof input.confirmation === "string"
            ? input.confirmation
            : undefined,
        actorUserId: context.userId,
        requestId: context.requestId,
      });
      if (!purgeResult.ok) {
        return {
          ok: false,
          status: 400,
          message: purgeResult.message ?? "Purge could not be completed.",
        };
      }
      return { ok: true, request: purgeResult };
    }
    const request = await repository.request({
      userId: context.userId,
      actorUserId: context.userId,
      requestType: type,
      idempotencyKey: input.idempotencyKey,
      includeExport: input.includeExport === true,
      requestId: context.requestId,
      now: new Date().toISOString(),
    });
    return { ok: true, request };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The account lifecycle request could not be completed.",
    };
  }
}
