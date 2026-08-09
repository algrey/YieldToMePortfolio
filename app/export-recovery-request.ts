import type { AccountLifecycleRequestType } from "../db/repositories/account-lifecycle";

export type ExportRecoveryCredentials = {
  requestType: AccountLifecycleRequestType;
  idempotencyKey: string;
};

export function parseExportRecoveryCredentials(
  url: URL,
): { ok: true; credentials: ExportRecoveryCredentials | null } | { ok: false } {
  const requestType = url.searchParams.get("requestType");
  const idempotencyKey = url.searchParams.get("idempotencyKey");
  if (requestType === null && idempotencyKey === null)
    return { ok: true, credentials: null };
  if (
    (requestType !== "disable" &&
      requestType !== "deletion" &&
      requestType !== "export") ||
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  )
    return { ok: false };
  return { ok: true, credentials: { requestType, idempotencyKey } };
}

export async function authorizeExportJobRequest(input: {
  identityStatus: "active" | "revoked";
  userStatus: string;
  credentials: ExportRecoveryCredentials | null;
  exactRequestOwnsJob: (
    credentials: ExportRecoveryCredentials,
  ) => Promise<boolean>;
}): Promise<boolean> {
  if (input.identityStatus === "active" && input.userStatus === "active")
    return true;
  return input.credentials !== null
    ? await input.exactRequestOwnsJob(input.credentials)
    : false;
}
