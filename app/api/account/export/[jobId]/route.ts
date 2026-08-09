import { headers } from "next/headers";
import {
  decodeAccessJwtBase64Url,
  type VerifiedAccessPrincipal,
} from "../../../../../domain/auth/access-jwt.ts";
import {
  createAccountLifecycleRepository,
  createIdentityRepository,
} from "../../../../../db/repositories/index.ts";
import { VERIFIED_PRINCIPAL_HEADER } from "../../../../../domain/auth/verified-principal-header.ts";
import type { AccountExportCursor } from "../../../../../db/repositories/account-lifecycle.ts";
import { ACCOUNT_EXPORT_JOB_ID_PATTERN } from "../../../../../db/repositories/account-lifecycle.ts";
import {
  authorizeExportJobRequest,
  parseExportRecoveryCredentials,
} from "../../../../export-recovery-request.ts";

const privateHeaders = { "cache-control": "private, no-store" };

function decodeCursor(value: string | null): AccountExportCursor | null {
  if (!value) return null;
  if (value.length > 256) throw new Error("invalid_export_cursor");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const parsed: unknown = JSON.parse(atob(padded));
  if (!parsed || typeof parsed !== "object")
    throw new Error("invalid_export_cursor");
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.tableName !== "string" ||
    !/^[A-Za-z0-9_]{1,100}$/.test(candidate.tableName) ||
    !Number.isSafeInteger(candidate.chunkIndex) ||
    Number(candidate.chunkIndex) < 0
  )
    throw new Error("invalid_export_cursor");
  return {
    tableName: candidate.tableName,
    chunkIndex: Number(candidate.chunkIndex),
  };
}

function principal(value: unknown): value is VerifiedAccessPrincipal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.tokenType === "app" &&
    typeof candidate.issuer === "string" &&
    typeof candidate.audience === "string" &&
    typeof candidate.subject === "string" &&
    typeof candidate.email === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const url = new URL(request.url);
  const jobId = (await params).jobId;
  if (!ACCOUNT_EXPORT_JOB_ID_PATTERN.test(jobId))
    return Response.json(
      { ok: false, message: "Invalid export job." },
      { status: 400, headers: privateHeaders },
    );
  const recovery = parseExportRecoveryCredentials(url);
  if (!recovery.ok)
    return Response.json(
      { ok: false, message: "Invalid export recovery request." },
      { status: 400, headers: privateHeaders },
    );
  const partText = url.searchParams.get("part");
  const part = partText === null ? null : Number(partText);
  if (
    (part !== null &&
      (!/^[1-9][0-9]{0,5}$/.test(partText!) || !Number.isSafeInteger(part))) ||
    (part !== null && url.searchParams.has("after"))
  )
    return Response.json(
      { ok: false, message: "Invalid export part." },
      { status: 400, headers: privateHeaders },
    );
  let cursor: AccountExportCursor | null;
  try {
    cursor = decodeCursor(url.searchParams.get("after"));
  } catch {
    return Response.json(
      { ok: false, message: "Invalid export cursor." },
      { status: 400, headers: privateHeaders },
    );
  }
  const encoded = (await headers()).get(VERIFIED_PRINCIPAL_HEADER);
  let verified: VerifiedAccessPrincipal;
  try {
    const decoded = decodeAccessJwtBase64Url(encoded ?? "");
    if (!principal(decoded)) throw new Error("invalid_principal");
    verified = decoded;
  } catch {
    return Response.json(
      { ok: false, message: "Authentication is unavailable." },
      { status: 401, headers: privateHeaders },
    );
  }
  try {
    const { getSqlClient } = await import("../../../../../db/d1-sql-client.ts");
    const client = await getSqlClient();
    const identity = await createIdentityRepository(client).findAccessIdentity(
      verified.issuer,
      verified.subject,
    );
    if (!identity)
      return Response.json(
        { ok: false, message: "Export was not found." },
        { status: 404, headers: privateHeaders },
      );
    const repository = createAccountLifecycleRepository(client);
    const authorized = await authorizeExportJobRequest({
      identityStatus: identity.identityStatus,
      userStatus: identity.userStatus,
      credentials: recovery.credentials,
      exactRequestOwnsJob: async (credentials) =>
        (await repository.getJobForPrincipalRequest(
          verified.issuer,
          verified.subject,
          credentials.requestType,
          credentials.idempotencyKey,
          jobId,
        )) !== null,
    });
    if (!authorized)
      return Response.json(
        { ok: false, message: "Export was not found." },
        { status: 404, headers: privateHeaders },
      );
    const page = await repository.downloadPage(
      identity.userId,
      jobId,
      cursor,
      undefined,
      part,
    );
    return Response.json({ ok: true, ...page }, { headers: privateHeaders });
  } catch (error) {
    const message =
      error instanceof Error && error.message === "export_expired"
        ? "Export has expired."
        : "Export is unavailable.";
    return Response.json(
      { ok: false, message },
      { status: 404, headers: privateHeaders },
    );
  }
}
