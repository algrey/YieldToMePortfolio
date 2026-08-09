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

function principal(value: unknown): value is VerifiedAccessPrincipal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.tokenType === "app" &&
    typeof candidate.issuer === "string" &&
    typeof candidate.audience === "string" &&
    typeof candidate.subject === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const key = url.searchParams.get("idempotencyKey");
  if (
    (type !== "disable" && type !== "deletion" && type !== "export") ||
    !key ||
    key.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  )
    return Response.json(
      { ok: false, message: "Invalid lifecycle status request." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  const encoded = (await headers()).get(VERIFIED_PRINCIPAL_HEADER);
  try {
    const decoded = decodeAccessJwtBase64Url(encoded ?? "");
    if (!principal(decoded)) throw new Error("invalid_principal");
    const { getSqlClient } = await import("../../../../../db/d1-sql-client.ts");
    const client = await getSqlClient();
    const repository = createAccountLifecycleRepository(client);
    const requestRecord = await repository.getForPrincipal(
      decoded.issuer,
      decoded.subject,
      type,
      key,
    );
    if (!requestRecord)
      return Response.json(
        { ok: false, message: "Lifecycle request was not found." },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    const identity = await createIdentityRepository(client).findAccessIdentity(
      decoded.issuer,
      decoded.subject,
    );
    const job =
      requestRecord.exportJobId && identity
        ? await createAccountLifecycleRepository(client).getJob(
            identity.userId,
            requestRecord.exportJobId,
          )
        : null;
    const boundedJob = job
      ? {
          id: job.id,
          phase: job.phase,
          status: job.status,
          tableIndex: job.tableIndex,
          reconcileTableIndex: job.reconcileTableIndex,
          rowCount: job.rowCount,
          objectCount: job.objectCount,
          manifestDigest: job.manifestDigest,
          expiresAt: job.expiresAt,
        }
      : null;
    return Response.json(
      {
        ok: true,
        request: {
          id: requestRecord.id,
          requestType: requestRecord.requestType,
          includeExport: requestRecord.includeExport,
          exportJobId: requestRecord.exportJobId,
          status: requestRecord.status,
          lifecycle:
            identity?.userStatus === "deletion_pending"
              ? "deletion_pending"
              : identity?.userStatus === "disabled"
                ? "disabled"
                : null,
          createdAt: requestRecord.createdAt,
          updatedAt: requestRecord.updatedAt,
        },
        job: boundedJob,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, message: "Lifecycle status is unavailable." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }
}
