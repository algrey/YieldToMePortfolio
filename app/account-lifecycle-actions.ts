import { createAccountLifecycleRepository } from "../db/repositories/account-lifecycle.ts";
import {
  getAuthenticatedSqlContext,
  getVerifiedPrincipalSqlContext,
} from "./portfolio-actions.ts";

export type AccountLifecycleActionType = "disable" | "deletion" | "export";

export type AccountLifecycleActionResult =
  | {
      ok: true;
      request: Awaited<
        ReturnType<ReturnType<typeof createAccountLifecycleRepository>["get"]>
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
    // A revoked identity may only retry the exact immutable request already
    // created for that issuer/subject. It never gets a user id from the body.
    const recovery = await getVerifiedPrincipalSqlContext();
    if (!recovery.ok) return context;
    const repository = createAccountLifecycleRepository(recovery.client);
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
