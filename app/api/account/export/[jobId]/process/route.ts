import { headers } from "next/headers";
import {
  decodeAccessJwtBase64Url,
  type VerifiedAccessPrincipal,
} from "../../../../../../domain/auth/access-jwt.ts";
import {
  ACCOUNT_EXPORT_JOB_ID_PATTERN,
  createAccountLifecycleRepository,
  createIdentityRepository,
} from "../../../../../../db/repositories/index.ts";
import { VERIFIED_PRINCIPAL_HEADER } from "../../../../../../domain/auth/verified-principal-header.ts";
import { rejectCrossSiteMutation } from "../../../../../mutation-request.ts";
import {
  authorizeExportJobRequest,
  parseExportRecoveryCredentials,
} from "../../../../../export-recovery-request.ts";

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

async function readBoundedBody(request: Request): Promise<boolean> {
  if (!request.body) return true;
  const reader = request.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return true;
      bytes += part.value.byteLength;
      if (bytes > 1024) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  if (!(await readBoundedBody(request)))
    return Response.json(
      { ok: false, message: "Export process request is too large." },
      { status: 413, headers: { "cache-control": "private, no-store" } },
    );
  const jobId = (await params).jobId;
  if (!ACCOUNT_EXPORT_JOB_ID_PATTERN.test(jobId))
    return Response.json(
      { ok: false, message: "Invalid export job." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  const recovery = parseExportRecoveryCredentials(new URL(request.url));
  if (!recovery.ok)
    return Response.json(
      { ok: false, message: "Invalid export recovery request." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  const encoded = (await headers()).get(VERIFIED_PRINCIPAL_HEADER);
  let verified: VerifiedAccessPrincipal;
  try {
    const decoded = decodeAccessJwtBase64Url(encoded ?? "");
    if (!principal(decoded)) throw new Error("invalid_principal");
    verified = decoded;
  } catch {
    return Response.json(
      { ok: false, message: "Authentication is unavailable." },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }
  try {
    const { getSqlClient } =
      await import("../../../../../../db/d1-sql-client.ts");
    const client = await getSqlClient();
    const identity = await createIdentityRepository(client).findAccessIdentity(
      verified.issuer,
      verified.subject,
    );
    if (!identity)
      return Response.json(
        { ok: false, message: "Export was not found." },
        { status: 404, headers: { "cache-control": "private, no-store" } },
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
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    let job = await repository.processExportJob(
      identity.userId,
      jobId,
      crypto.randomUUID(),
    );
    // One HTTP request advances a bounded number of independently guarded D1
    // checkpoints. This keeps each database unit retry-safe while making a
    // 100,000-row export operable without one browser round trip per 8 rows.
    for (let step = 1; step < 25 && job.status === "running"; step += 1)
      job = await repository.processExportJob(
        identity.userId,
        jobId,
        crypto.randomUUID(),
      );
    return Response.json(
      {
        ok: true,
        job: {
          id: job.id,
          phase: job.phase,
          status: job.status,
          tableIndex: job.tableIndex,
          reconcileTableIndex: job.reconcileTableIndex,
          rowCount: job.rowCount,
          objectCount: job.objectCount,
          manifestDigest: job.manifestDigest,
          expiresAt: job.expiresAt,
        },
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, message: "Export is unavailable." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
}
