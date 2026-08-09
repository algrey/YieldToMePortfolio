import { createHash, randomUUID } from "node:crypto";
import { createAuditInsertStatement, createAuditRepository } from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

export type AccountLifecycleRequestType = "disable" | "deletion" | "export";
export type ExportRetentionClass =
  | "account-lifetime"
  | "operational-35-days"
  | "provider-contract"
  | "not-user-data";
export type ExportTableClassification = {
  classification:
    "owned" | "user-scoped-observation" | "operational" | "excluded";
  ownerColumn:
    | "id"
    | "user_id"
    | "scope_user_id"
    | "target_owner_user_id"
    | "verified_by_user_id"
    | null;
  retention: ExportRetentionClass;
  reason: string;
};
const PROCESS_DOWNLOAD_AUDIT_MANIFEST = "audit_events.process_download";

const owned = (
  ownerColumn: ExportTableClassification["ownerColumn"],
  reason: string,
  retention: ExportRetentionClass = "account-lifetime",
): ExportTableClassification => ({
  classification: "owned",
  ownerColumn,
  reason,
  retention,
});
const excluded = (
  reason: string,
  retention: ExportRetentionClass = "not-user-data",
): ExportTableClassification => ({
  classification: "excluded",
  ownerColumn: null,
  reason,
  retention,
});
const operational = (
  ownerColumn: ExportTableClassification["ownerColumn"],
  reason: string,
): ExportTableClassification => ({
  classification: "operational",
  ownerColumn,
  reason,
  retention: "operational-35-days",
});

const OWNED_TABLES = [
  "user_settings",
  "user_identities",
  "portfolios",
  "portfolio_settings",
  "portfolio_securities",
  "import_batches",
  "import_commit_chunks",
  "import_rows",
  "import_issues",
  "import_mapping_decisions",
  "transactions",
  "ledger_mutation_guards",
  "manual_ledger_mutation_keys",
  "cash_accounts",
  "cash_ledger_entries",
  "manual_overrides",
  "portfolio_daily_snapshots",
  "holding_daily_snapshots",
  "calculation_runs",
  "snapshot_publications",
  "projection_publications",
  "tax_lots",
  "lot_allocations",
  "holding_projections",
];
const classifications: Record<string, ExportTableClassification> =
  Object.fromEntries(
    OWNED_TABLES.map((name) => [
      name,
      owned("user_id", name.replaceAll("_", " ")),
    ]),
  );
classifications.users = owned("id", "Internal account record");
classifications.price_observations = owned(
  "scope_user_id",
  "User-scoped price observations",
  "provider-contract",
);
classifications.price_observations.classification = "user-scoped-observation";
classifications.fx_rate_observations = owned(
  "scope_user_id",
  "User-scoped FX observations",
  "provider-contract",
);
classifications.fx_rate_observations.classification = "user-scoped-observation";
classifications.market_data_refresh_jobs = owned(
  "scope_user_id",
  "User-scoped refresh work",
  "operational-35-days",
);
classifications.security_provider_mappings = owned(
  "verified_by_user_id",
  "Mappings verified by this owner",
  "provider-contract",
);
classifications.audit_events = owned(
  "target_owner_user_id",
  "Redacted owner audit events",
  "account-lifetime",
);
classifications[PROCESS_DOWNLOAD_AUDIT_MANIFEST] = operational(
  "target_owner_user_id",
  "Process and download audit access rows retained as purge input",
);
classifications.account_lifecycle_requests = owned(
  "user_id",
  "Immutable lifecycle request metadata",
  "operational-35-days",
);
classifications.account_export_jobs = operational(
  "user_id",
  "Mutable export job control state; retained as purge input",
);
classifications.account_export_checkpoint_guards = operational(
  "user_id",
  "Ephemeral export checkpoint guard; retained as purge input",
);
classifications.account_export_manifest = operational(
  "user_id",
  "Export manifest control state; retained as purge input",
);
classifications.account_export_chunks = operational(
  "user_id",
  "Bounded export artifact storage; retained as purge input",
);
for (const name of [
  "currencies",
  "exchanges",
  "securities",
  "security_identifiers",
  "market_data_providers",
])
  classifications[name] = excluded("Shared reference data");

/** Every schema table must be classified before an export job can run. */
export const ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS: Readonly<
  Record<string, ExportTableClassification>
> = Object.freeze(classifications);

export type AccountExportManifestItem = {
  table: string;
  classification: ExportTableClassification["classification"];
  retention: ExportRetentionClass;
  reason: string;
  sourceRowCount: number;
  capturedRowCount: number;
  objectCount: number;
  digest: string;
};
export type AccountLifecycleRequest = {
  id: string;
  userId: string;
  actorUserId: string | null;
  requestType: AccountLifecycleRequestType;
  idempotencyKey: string;
  includeExport: boolean;
  exportJobId: string | null;
  status: "completed";
  createdAt: string;
  updatedAt: string;
};
export type AccountExportJob = {
  id: string;
  userId: string;
  lifecycleRequestId: string;
  phase: "capture" | "reconcile" | "finalize";
  status: "queued" | "running" | "completed" | "failed" | "expired";
  tableIndex: number;
  rowCursor: number;
  reconcileTableIndex: number;
  reconcileRowCursor: number;
  reconcileDigest: string;
  reconcileRowCount: number;
  captureFragmentOffset: number;
  finalizeTableName: string;
  finalizeChunkIndex: number;
  finalizeDigest: string;
  operationalAuditHighWater: number;
  rowCount: number;
  objectCount: number;
  version: number;
  manifestDigest: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};
export type AccountLifecycleRequestInput = {
  userId: string;
  actorUserId: string | null;
  requestType: AccountLifecycleRequestType;
  idempotencyKey: string;
  includeExport?: boolean;
  requestId: string;
  now: string;
};
export const ACCOUNT_EXPORT_LIMITS = Object.freeze({
  chunkRows: 8,
  maxChunkBytes: 64_000,
  maxDownloadChunks: 20,
  maxFragmentsPerStep: 4,
  maxFinalizeChunksPerStep: 100,
  retentionDays: 35,
});
export const ACCOUNT_EXPORT_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AccountExportCursor = {
  tableName: string;
  chunkIndex: number;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function foldRows(
  previous: string,
  rows: readonly Record<string, unknown>[],
): string {
  let value = previous === "0" ? "" : previous;
  for (const row of rows) value = digest(value + JSON.stringify(row));
  return value;
}
function redact(value: unknown, ownerUserId: string): unknown {
  if (Array.isArray(value))
    return value.map((item) => redact(item, ownerUserId));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactField(key, item, ownerUserId),
      ]),
    );
  return value;
}
function redactField(
  key: string,
  value: unknown,
  ownerUserId: string,
): unknown {
  const lower = key.toLowerCase();
  if (
    lower === "key" ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("authorization") ||
    lower.includes("private_key") ||
    lower.includes("idempotency")
  )
    return "[REDACTED]";
  if (
    (lower === "actor_user_id" || lower === "target_owner_user_id") &&
    value !== null &&
    value !== ownerUserId
  )
    return "[REDACTED]";
  if (typeof value === "string" && lower.endsWith("_json")) {
    try {
      return redact(JSON.parse(value), ownerUserId);
    } catch {
      return value;
    }
  }
  return redact(value, ownerUserId);
}
function sanitized(
  row: Record<string, unknown>,
  ownerUserId: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      redactField(key, value, ownerUserId),
    ]),
  );
}
function rowOwnerPredicate(
  table: string,
  classification: ExportTableClassification,
  userId: string,
): { sql: string; params: unknown[] } {
  if (table === "audit_events")
    return {
      sql: "(target_owner_user_id = ? OR actor_user_id = ?) AND action NOT IN ('account.export.process','account.export.download')",
      params: [userId, userId],
    };
  if (table === "security_provider_mappings")
    return { sql: "verified_by_user_id = ?", params: [userId] };
  if (!classification.ownerColumn)
    throw new Error(`missing_export_owner_column:${table}`);
  return { sql: `"${classification.ownerColumn}" = ?`, params: [userId] };
}
function record(row: Record<string, unknown>): AccountLifecycleRequest {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
    requestType: String(row.request_type) as AccountLifecycleRequestType,
    idempotencyKey: String(row.idempotency_key),
    includeExport: Boolean(row.include_export),
    exportJobId: row.export_job_id == null ? null : String(row.export_job_id),
    status: "completed",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
function jobRecord(row: Record<string, unknown>): AccountExportJob {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    lifecycleRequestId: String(row.lifecycle_request_id),
    phase: String(row.phase) as AccountExportJob["phase"],
    status: String(row.status) as AccountExportJob["status"],
    tableIndex: Number(row.table_index),
    rowCursor: Number(row.row_cursor),
    reconcileTableIndex: Number(row.reconcile_table_index),
    reconcileRowCursor: Number(row.reconcile_row_cursor),
    reconcileDigest: String(row.reconcile_digest),
    reconcileRowCount: Number(row.reconcile_row_count),
    captureFragmentOffset: Number(row.capture_fragment_offset),
    finalizeTableName: String(row.finalize_table_name),
    finalizeChunkIndex: Number(row.finalize_chunk_index),
    finalizeDigest: String(row.finalize_digest),
    operationalAuditHighWater: Number(row.operational_audit_high_water),
    rowCount: Number(row.row_count),
    objectCount: Number(row.object_count),
    version: Number(row.version),
    manifestDigest:
      row.manifest_digest == null ? null : String(row.manifest_digest),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function tableNames(client: SqlClient): Promise<string[]> {
  const rows = await client.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const applicationRows = rows.filter((row) => !isD1ReservedTable(row.name));
  for (const row of applicationRows)
    if (!ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS[row.name])
      throw new Error(`unclassified_export_table:${row.name}`);
  return applicationRows
    .map((row) => row.name)
    .filter(
      (name) =>
        ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS[name].classification !==
          "excluded" &&
        ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS[name].classification !==
          "operational",
    );
}

/** D1-owned namespaces are not application schema and `_cf_KV` is unqueryable. */
export function isD1ReservedTable(name: string): boolean {
  return /^_cf_/i.test(name) || /^d1_/i.test(name);
}
function expiry(now: string): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + ACCOUNT_EXPORT_LIMITS.retentionDays);
  return date.toISOString();
}

function checkpointGuardStatements(
  jobId: string,
  userId: string,
  version: number,
): { id: string; insert: SqlStatement; remove: SqlStatement } {
  const id = randomUUID();
  return {
    id,
    insert: {
      sql: `INSERT INTO account_export_checkpoint_guards
        (id,export_job_id,user_id,expected_version,valid)
        SELECT ?,?,?,?,CASE WHEN EXISTS (
          SELECT 1 FROM account_export_jobs
          WHERE id=? AND user_id=? AND version=?
        ) THEN 1 ELSE 0 END`,
      params: [id, jobId, userId, version, jobId, userId, version],
    },
    remove: {
      sql: "DELETE FROM account_export_checkpoint_guards WHERE id=? AND export_job_id=? AND user_id=?",
      params: [id, jobId, userId],
    },
  };
}

function fragmentPayloads(
  table: string,
  row: Record<string, unknown>,
  rowDigest: string,
  offset: number,
): { payloads: string[]; fragmentCount: number; nextOffset: number } {
  const rowText = JSON.stringify(row);
  const fragmentCount = Math.ceil(rowText.length / 12_000);
  const end = Math.min(
    fragmentCount,
    offset + ACCOUNT_EXPORT_LIMITS.maxFragmentsPerStep,
  );
  const payloads = Array.from({ length: end - offset }, (_, relativeIndex) => {
    const fragmentIndex = offset + relativeIndex;
    return JSON.stringify({
      table,
      format: "row-fragment-v1",
      rowDigest,
      fragmentIndex,
      fragmentCount,
      data: rowText.slice(fragmentIndex * 12_000, (fragmentIndex + 1) * 12_000),
    });
  });
  if (
    payloads.some(
      (payload) =>
        new TextEncoder().encode(payload).byteLength >
        ACCOUNT_EXPORT_LIMITS.maxChunkBytes,
    )
  )
    throw new Error("export_chunk_fragmentation_unstable");
  return { payloads, fragmentCount, nextOffset: end };
}

export function createAccountLifecycleRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  const get = async (
    userId: string,
    requestType: AccountLifecycleRequestType,
    idempotencyKey: string,
  ) => {
    const row = await client.get<Record<string, unknown>>(
      "SELECT * FROM account_lifecycle_requests WHERE user_id = ? AND request_type = ? AND idempotency_key = ?",
      [userId, requestType, idempotencyKey],
    );
    return row ? record(row) : null;
  };
  const getForPrincipal = async (
    issuer: string,
    subject: string,
    requestType: AccountLifecycleRequestType,
    idempotencyKey: string,
  ) => {
    const row = await client.get<Record<string, unknown>>(
      "SELECT alr.* FROM account_lifecycle_requests AS alr INNER JOIN user_identities AS ui ON ui.user_id = alr.user_id WHERE ui.provider='cloudflare_access' AND ui.issuer=? AND ui.subject=? AND alr.request_type=? AND alr.idempotency_key=?",
      [issuer, subject, requestType, idempotencyKey],
    );
    return row ? record(row) : null;
  };
  const getJob = async (userId: string, jobId: string) => {
    const row = await client.get<Record<string, unknown>>(
      "SELECT * FROM account_export_jobs WHERE id = ? AND user_id = ?",
      [jobId, userId],
    );
    return row ? jobRecord(row) : null;
  };
  const getJobForPrincipalRequest = async (
    issuer: string,
    subject: string,
    requestType: AccountLifecycleRequestType,
    idempotencyKey: string,
    jobId: string,
  ) => {
    const row = await client.get<Record<string, unknown>>(
      `SELECT aej.* FROM account_export_jobs AS aej
       INNER JOIN account_lifecycle_requests AS alr
         ON alr.id=aej.lifecycle_request_id AND alr.user_id=aej.user_id
       INNER JOIN user_identities AS ui ON ui.user_id=aej.user_id
       WHERE ui.provider='cloudflare_access' AND ui.issuer=? AND ui.subject=?
         AND alr.request_type=? AND alr.idempotency_key=? AND alr.export_job_id=aej.id
         AND aej.id=? LIMIT 1`,
      [issuer, subject, requestType, idempotencyKey, jobId],
    );
    return row ? jobRecord(row) : null;
  };
  const audit = createAuditRepository(client, now);
  const runGuarded = async (
    userId: string,
    jobId: string,
    version: number,
    statements: SqlStatement[],
  ) => {
    const guard = checkpointGuardStatements(jobId, userId, version);
    const batch = [guard.insert, ...statements, guard.remove];
    if (client.batch) await client.batch(batch);
    else {
      await client.run("BEGIN IMMEDIATE TRANSACTION");
      try {
        for (const statement of batch)
          await client.run(statement.sql, statement.params);
        await client.run("COMMIT");
      } catch (error) {
        await client.run("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  };
  const finalizeExport = async (
    userId: string,
    job: AccountExportJob,
    at: string,
  ): Promise<AccountExportJob> => {
    const auditHighWater = await client.get<Record<string, unknown>>(
      "SELECT COALESCE(MAX(rowid),0) AS rowid FROM audit_events WHERE target_owner_user_id=? OR actor_user_id=?",
      [userId, userId],
    );
    const auditCutoff = Number(auditHighWater?.rowid ?? 0);
    const operationalCounts = new Map<string, number>();
    const operationalCutoffs = new Map<string, string>();
    const statements: SqlStatement[] = [];
    for (const [operationalTable, operationalClassification] of Object.entries(
      ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS,
    ).filter(([, value]) => value.classification === "operational")) {
      const predicate =
        operationalTable === PROCESS_DOWNLOAD_AUDIT_MANIFEST
          ? {
              sql: "rowid <= ? AND (target_owner_user_id = ? OR actor_user_id = ?) AND action IN ('account.export.process','account.export.download')",
              params: [auditCutoff, userId, userId],
            }
          : rowOwnerPredicate(
              operationalTable,
              operationalClassification,
              userId,
            );
      const sourceTable =
        operationalTable === PROCESS_DOWNLOAD_AUDIT_MANIFEST
          ? "audit_events"
          : operationalTable;
      const count = await client.get<Record<string, unknown>>(
        `SELECT COUNT(*) AS count FROM "${sourceTable}" WHERE ${predicate.sql}`,
        predicate.params,
      );
      const sourceRowCount = Number(count?.count ?? 0);
      const cutoff =
        operationalTable === PROCESS_DOWNLOAD_AUDIT_MANIFEST
          ? `audit-rowid:${auditCutoff}`
          : `job-version:${job.version}`;
      operationalCounts.set(operationalTable, sourceRowCount);
      operationalCutoffs.set(operationalTable, cutoff);
      statements.push({
        sql: "UPDATE account_export_manifest SET source_row_count=?,digest=?,cutoff_cursor=?,updated_at=? WHERE export_job_id=? AND table_name=? AND user_id=?",
        params: [
          sourceRowCount,
          digest(`${operationalTable}:${cutoff}:${sourceRowCount}`),
          cutoff,
          at,
          job.id,
          operationalTable,
          userId,
        ],
      });
    }
    const manifests = await client.all<Record<string, unknown>>(
      "SELECT table_name,classification,retention,reason,source_row_count,captured_row_count,object_count,digest,cutoff_cursor FROM account_export_manifest WHERE export_job_id=? AND user_id=? ORDER BY table_name ASC LIMIT 100",
      [job.id, userId],
    );
    const tables = manifests.map((row) => {
      const table = String(row.table_name);
      const sourceRowCount = operationalCounts.get(table);
      const cutoffCursor =
        operationalCutoffs.get(table) ??
        (row.cutoff_cursor == null ? null : String(row.cutoff_cursor));
      return {
        table,
        classification: String(row.classification),
        retention: String(row.retention),
        reason: String(row.reason),
        sourceRowCount:
          sourceRowCount === undefined
            ? Number(row.source_row_count)
            : sourceRowCount,
        capturedRowCount: Number(row.captured_row_count),
        objectCount: Number(row.object_count),
        digest:
          sourceRowCount === undefined
            ? String(row.digest)
            : digest(`${table}:${cutoffCursor}:${sourceRowCount}`),
        cutoffCursor,
      };
    });
    const initialDigest = digest(
      JSON.stringify({
        format: "yieldtome.account-export",
        version: 2,
        digestAlgorithm: "sha256-chain-v1",
        ownerId: userId,
        jobId: job.id,
        expiresAt: job.expiresAt,
        tables,
      }),
    );
    statements.push({
      sql: "UPDATE account_export_jobs SET phase='finalize',finalize_table_name='',finalize_chunk_index=-1,finalize_digest=?,operational_audit_high_water=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
      params: [initialDigest, auditCutoff, at, job.id, userId, job.version],
    });
    try {
      await runGuarded(userId, job.id, job.version, statements);
    } catch (error) {
      if (String(error).includes("account_export_checkpoint_guards_valid"))
        return (await getJob(userId, job.id))!;
      throw error;
    }
    return (await getJob(userId, job.id))!;
  };
  return {
    get,
    getForPrincipal,
    getJob,
    getJobForPrincipalRequest,
    async request(
      input: AccountLifecycleRequestInput,
    ): Promise<AccountLifecycleRequest> {
      if (!input.userId.trim() || !input.idempotencyKey.trim())
        throw new Error("invalid_lifecycle_request");
      if (input.actorUserId !== input.userId) throw new Error("owner_mismatch");
      const existing = await get(
        input.userId,
        input.requestType,
        input.idempotencyKey,
      );
      if (existing) return existing;
      const includeExport =
        input.includeExport === true || input.requestType === "export";
      const id = randomUUID();
      const jobId = includeExport ? randomUUID() : null;
      const statements: SqlStatement[] = [
        {
          sql: "INSERT INTO account_lifecycle_requests (id,user_id,actor_user_id,request_type,idempotency_key,status,include_export,export_job_id,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?,?,?)",
          params: [
            id,
            input.userId,
            input.actorUserId,
            input.requestType,
            input.idempotencyKey,
            includeExport ? 1 : 0,
            jobId,
            input.now,
            input.now,
          ],
        },
      ];
      if (jobId)
        statements.push({
          sql: "INSERT INTO account_export_jobs (id,user_id,lifecycle_request_id,phase,status,expires_at,created_at,updated_at) VALUES (?,?,?,'capture','queued',?,?,?)",
          params: [
            jobId,
            input.userId,
            id,
            expiry(input.now),
            input.now,
            input.now,
          ],
        });
      if (jobId)
        for (const [tableName, classification] of Object.entries(
          ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS,
        ).filter(
          ([, value]) =>
            value.classification === "excluded" ||
            value.classification === "operational",
        ))
          statements.push({
            sql: "INSERT INTO account_export_manifest (id,export_job_id,user_id,table_name,classification,retention,reason,source_row_count,captured_row_count,object_count,digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,0,0,'0',?,?)",
            params: [
              randomUUID(),
              jobId,
              input.userId,
              tableName,
              classification.classification,
              classification.retention,
              classification.reason,
              input.now,
              input.now,
            ],
          });
      if (input.requestType === "disable" || input.requestType === "deletion")
        statements.push(
          {
            sql: "UPDATE users SET status = CASE WHEN ? = 'deletion' AND status IN ('active','disabled') THEN 'deletion_pending' WHEN ? = 'disable' AND status = 'active' THEN 'disabled' ELSE status END, updated_at = ?, version = version + 1 WHERE id = ?",
            params: [
              input.requestType,
              input.requestType,
              input.now,
              input.userId,
            ],
          },
          {
            sql: "UPDATE user_identities SET status = 'revoked', updated_at = ?, version = version + 1 WHERE user_id = ? AND status = 'active'",
            params: [input.now, input.userId],
          },
        );
      statements.push(
        createAuditInsertStatement(
          {
            actorUserId: input.actorUserId,
            targetOwnerUserId: input.userId,
            action: `account.${input.requestType}`,
            targetType: "user",
            targetId: input.userId,
            requestId: input.requestId,
            result: "success",
            metadata: { requestType: input.requestType, includeExport },
            occurredAt: input.now,
          },
          now,
        ),
      );
      try {
        if (client.batch) await client.batch(statements);
        else {
          await client.run("BEGIN IMMEDIATE TRANSACTION");
          try {
            for (const statement of statements)
              await client.run(statement.sql, statement.params);
            await client.run("COMMIT");
          } catch (error) {
            await client.run("ROLLBACK").catch(() => undefined);
            throw error;
          }
        }
      } catch (error) {
        const retry = await get(
          input.userId,
          input.requestType,
          input.idempotencyKey,
        );
        if (retry) return retry;
        throw error;
      }
      const created = await get(
        input.userId,
        input.requestType,
        input.idempotencyKey,
      );
      if (!created) throw new Error("lifecycle_request_not_persisted");
      return created;
    },
    async processExportJob(
      userId: string,
      jobId: string,
      requestId: string,
      at = now(),
    ): Promise<AccountExportJob> {
      const job = await getJob(userId, jobId);
      if (!job) throw new Error("export_job_not_found");
      const report = async (outcome: AccountExportJob) => outcome;
      const failure = async (error: unknown): Promise<AccountExportJob> => {
        const code =
          error instanceof Error && /^export_[a-z_]{1,64}$/.test(error.message)
            ? error.message
            : "unexpected_error";
        try {
          await runGuarded(userId, jobId, job.version, [
            {
              sql: "UPDATE account_export_jobs SET status='failed',version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
              params: [at, jobId, userId, job.version],
            },
            createAuditInsertStatement(
              {
                actorUserId: userId,
                targetOwnerUserId: userId,
                action: "account.export.process",
                targetType: "account_export_job",
                targetId: jobId,
                requestId,
                result: "failure",
                metadata: { phase: job.phase, status: "failed", code },
                occurredAt: at,
              },
              now,
            ),
          ]);
        } catch (checkpointError) {
          if (
            !String(checkpointError).includes(
              "account_export_checkpoint_guards_valid",
            )
          )
            throw checkpointError;
        }
        return (await getJob(userId, jobId))!;
      };
      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "expired"
      )
        return job;
      try {
        if (new Date(job.expiresAt).getTime() <= new Date(at).getTime()) {
          await runGuarded(userId, jobId, job.version, [
            {
              sql: "UPDATE account_export_jobs SET status='expired',version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
              params: [at, jobId, userId, job.version],
            },
            createAuditInsertStatement(
              {
                actorUserId: userId,
                targetOwnerUserId: userId,
                action: "account.export.process",
                targetType: "account_export_job",
                targetId: jobId,
                requestId,
                result: "failure",
                metadata: { phase: job.phase, status: "expired" },
                occurredAt: at,
              },
              now,
            ),
          ]);
          return (await getJob(userId, jobId))!;
        }
        if (job.phase === "finalize") {
          const predicate = job.finalizeTableName
            ? " AND (table_name > ? OR (table_name=? AND chunk_index>?))"
            : "";
          const params: unknown[] = job.finalizeTableName
            ? [
                jobId,
                userId,
                job.finalizeTableName,
                job.finalizeTableName,
                job.finalizeChunkIndex,
                ACCOUNT_EXPORT_LIMITS.maxFinalizeChunksPerStep + 1,
              ]
            : [
                jobId,
                userId,
                ACCOUNT_EXPORT_LIMITS.maxFinalizeChunksPerStep + 1,
              ];
          const chunks = await client.all<Record<string, unknown>>(
            `SELECT table_name,chunk_index,row_count,digest FROM account_export_chunks WHERE export_job_id=? AND user_id=?${predicate} ORDER BY table_name,chunk_index LIMIT ?`,
            params,
          );
          const page = chunks.slice(
            0,
            ACCOUNT_EXPORT_LIMITS.maxFinalizeChunksPerStep,
          );
          let nextDigest = job.finalizeDigest;
          for (const row of page)
            nextDigest = digest(
              nextDigest +
                JSON.stringify({
                  table: String(row.table_name),
                  chunkIndex: Number(row.chunk_index),
                  rowCount: Number(row.row_count),
                  digest: String(row.digest),
                }),
            );
          const last = page.at(-1);
          if (
            chunks.length > ACCOUNT_EXPORT_LIMITS.maxFinalizeChunksPerStep &&
            last
          ) {
            await runGuarded(userId, jobId, job.version, [
              {
                sql: "UPDATE account_export_jobs SET finalize_table_name=?,finalize_chunk_index=?,finalize_digest=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
                params: [
                  String(last.table_name),
                  Number(last.chunk_index),
                  nextDigest,
                  at,
                  jobId,
                  userId,
                  job.version,
                ],
              },
            ]);
            return (await getJob(userId, jobId))!;
          }
          const manifestDigest = digest(nextDigest + ":end");
          await runGuarded(userId, jobId, job.version, [
            {
              sql: "UPDATE account_export_jobs SET status='completed',manifest_digest=?,finalize_digest=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
              params: [
                manifestDigest,
                nextDigest,
                at,
                jobId,
                userId,
                job.version,
              ],
            },
            createAuditInsertStatement(
              {
                actorUserId: userId,
                targetOwnerUserId: userId,
                action: "account.export.process",
                targetType: "account_export_job",
                targetId: jobId,
                requestId,
                result: "success",
                metadata: { phase: "finalize", status: "completed" },
                occurredAt: at,
              },
              now,
            ),
          ]);
          return (await getJob(userId, jobId))!;
        }
        const names = await tableNames(client);
        const tableIndex =
          job.phase === "capture" ? job.tableIndex : job.reconcileTableIndex;
        const cursor =
          job.phase === "capture" ? job.rowCursor : job.reconcileRowCursor;
        const table = names[tableIndex];
        if (!table) return await finalizeExport(userId, job, at);
        const classification = ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS[table];
        const predicate = rowOwnerPredicate(table, classification, userId);
        const rows = await client.all<Record<string, unknown>>(
          `SELECT rowid,* FROM "${table}" WHERE ${predicate.sql} AND rowid > ? ORDER BY rowid LIMIT ?`,
          [...predicate.params, cursor, ACCOUNT_EXPORT_LIMITS.chunkRows + 1],
        );
        if (job.phase === "reconcile") {
          if (rows.length === 0) {
            const manifest = await client.get<Record<string, unknown>>(
              "SELECT * FROM account_export_manifest WHERE export_job_id=? AND table_name=? AND user_id=?",
              [jobId, table, userId],
            );
            const reconciledDigest = job.reconcileDigest;
            if (
              !manifest ||
              Number(manifest.captured_row_count) !== job.reconcileRowCount ||
              String(manifest.digest) !== reconciledDigest
            ) {
              return await failure(new Error("export_reconciliation_mismatch"));
            }
            const nextIndex = job.reconcileTableIndex + 1;
            if (nextIndex >= names.length) {
              return await finalizeExport(userId, job, at);
            } else {
              try {
                await runGuarded(userId, jobId, job.version, [
                  {
                    sql: "UPDATE account_export_jobs SET reconcile_table_index=?,reconcile_row_cursor=0,reconcile_digest='0',reconcile_row_count=0,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
                    params: [nextIndex, at, jobId, userId, job.version],
                  },
                ]);
              } catch (error) {
                if (
                  String(error).includes(
                    "account_export_checkpoint_guards_valid",
                  )
                )
                  return await report((await getJob(userId, jobId))!);
                return await failure(error);
              }
            }
            return await report((await getJob(userId, jobId))!);
          }
          const page = rows.slice(0, ACCOUNT_EXPORT_LIMITS.chunkRows);
          const nextDigest = foldRows(
            job.reconcileDigest,
            page.map((row) => sanitized(row, userId)),
          );
          try {
            await runGuarded(userId, jobId, job.version, [
              {
                sql: "UPDATE account_export_jobs SET reconcile_row_cursor=?,reconcile_digest=?,reconcile_row_count=reconcile_row_count+?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
                params: [
                  Number(page.at(-1)?.rowid),
                  nextDigest,
                  page.length,
                  at,
                  jobId,
                  userId,
                  job.version,
                ],
              },
            ]);
          } catch (error) {
            if (
              String(error).includes("account_export_checkpoint_guards_valid")
            )
              return await report((await getJob(userId, jobId))!);
            return await failure(error);
          }
          return await report((await getJob(userId, jobId))!);
        }
        if (rows.length === 0) {
          const existingManifest = await client.get<Record<string, unknown>>(
            "SELECT id FROM account_export_manifest WHERE export_job_id=? AND table_name=? AND user_id=?",
            [jobId, table, userId],
          );
          const nextIndex = tableIndex + 1;
          const guard = checkpointGuardStatements(jobId, userId, job.version);
          const emptyCheckpoint: SqlStatement[] = [
            guard.insert,
            existingManifest
              ? {
                  sql: "UPDATE account_export_manifest SET source_row_count=captured_row_count,updated_at=? WHERE export_job_id=? AND table_name=? AND user_id=?",
                  params: [at, jobId, table, userId],
                }
              : {
                  sql: "INSERT INTO account_export_manifest (id,export_job_id,user_id,table_name,classification,retention,reason,source_row_count,captured_row_count,object_count,digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,0,0,'0',?,?)",
                  params: [
                    randomUUID(),
                    jobId,
                    userId,
                    table,
                    classification.classification,
                    classification.retention,
                    classification.reason,
                    at,
                    at,
                  ],
                },
            nextIndex >= names.length
              ? {
                  sql: "UPDATE account_export_jobs SET phase='reconcile',status='running',reconcile_table_index=0,reconcile_row_cursor=0,reconcile_digest='0',reconcile_row_count=0,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
                  params: [at, jobId, userId, job.version],
                }
              : {
                  sql: "UPDATE account_export_jobs SET table_index=?,row_cursor=0,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
                  params: [nextIndex, at, jobId, userId, job.version],
                },
            guard.remove,
          ];
          try {
            if (client.batch) await client.batch(emptyCheckpoint);
            else {
              await client.run("BEGIN IMMEDIATE TRANSACTION");
              try {
                for (const statement of emptyCheckpoint)
                  await client.run(statement.sql, statement.params);
                await client.run("COMMIT");
              } catch (error) {
                await client.run("ROLLBACK").catch(() => undefined);
                throw error;
              }
            }
          } catch (error) {
            if (
              String(error).includes("account_export_checkpoint_guards_valid")
            )
              return await report((await getJob(userId, jobId))!);
            return await failure(error);
          }
          return await report((await getJob(userId, jobId))!);
        }
        let page = rows
          .slice(0, ACCOUNT_EXPORT_LIMITS.chunkRows)
          .map((row) => sanitized(row, userId));
        let payload = JSON.stringify({ table, rows: page });
        while (
          new TextEncoder().encode(payload).byteLength >
            ACCOUNT_EXPORT_LIMITS.maxChunkBytes &&
          page.length > 1
        ) {
          page = page.slice(0, -1);
          payload = JSON.stringify({ table, rows: page });
        }
        const pageDigest = foldRows("0", page);
        let chunkPayloads: string[];
        let fragmentCount = 0;
        let nextFragmentOffset = 0;
        try {
          chunkPayloads =
            new TextEncoder().encode(payload).byteLength <=
            ACCOUNT_EXPORT_LIMITS.maxChunkBytes
              ? [payload]
              : page.length === 1
                ? (() => {
                    const fragments = fragmentPayloads(
                      table,
                      page[0]!,
                      digest(JSON.stringify(page[0])),
                      job.captureFragmentOffset,
                    );
                    fragmentCount = fragments.fragmentCount;
                    nextFragmentOffset = fragments.nextOffset;
                    return fragments.payloads;
                  })()
                : (() => {
                    throw new Error("export_chunk_too_large");
                  })();
        } catch (error) {
          return await failure(error);
        }
        const manifest = await client.get<Record<string, unknown>>(
          "SELECT * FROM account_export_manifest WHERE export_job_id=? AND table_name=? AND user_id=?",
          [jobId, table, userId],
        );
        const chunkIndex = await client.get<Record<string, unknown>>(
          "SELECT MAX(chunk_index) AS max FROM account_export_chunks WHERE export_job_id=? AND table_name=?",
          [jobId, table],
        );
        const index = Number(chunkIndex?.max ?? -1) + 1;
        const fragmentComplete =
          fragmentCount === 0 || nextFragmentOffset >= fragmentCount;
        const nextCursor = fragmentComplete
          ? Number(rows[page.length - 1].rowid)
          : job.rowCursor;
        const guard = checkpointGuardStatements(jobId, userId, job.version);
        const checkpointStatements: SqlStatement[] = [guard.insert];
        for (const [fragmentIndex, fragmentPayload] of chunkPayloads.entries())
          checkpointStatements.push({
            sql: "INSERT INTO account_export_chunks (id,export_job_id,user_id,table_name,chunk_index,payload_json,row_count,digest,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            params: [
              randomUUID(),
              jobId,
              userId,
              table,
              index + fragmentIndex,
              fragmentPayload,
              page.length,
              digest(fragmentPayload),
              job.expiresAt,
              at,
            ],
          });
        checkpointStatements.push(
          !manifest
            ? {
                sql: "INSERT INTO account_export_manifest (id,export_job_id,user_id,table_name,classification,retention,reason,source_row_count,captured_row_count,object_count,digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?, ?,?)",
                params: [
                  randomUUID(),
                  jobId,
                  userId,
                  table,
                  classification.classification,
                  classification.retention,
                  classification.reason,
                  fragmentComplete ? page.length : 0,
                  chunkPayloads.length,
                  fragmentComplete ? pageDigest : "0",
                  at,
                  at,
                ],
              }
            : {
                sql: "UPDATE account_export_manifest SET captured_row_count=captured_row_count+?,object_count=object_count+?,digest=?,updated_at=? WHERE export_job_id=? AND table_name=? AND user_id=?",
                params: [
                  fragmentComplete ? page.length : 0,
                  chunkPayloads.length,
                  fragmentComplete
                    ? foldRows(String(manifest.digest), page)
                    : String(manifest.digest),
                  at,
                  jobId,
                  table,
                  userId,
                ],
              },
        );
        checkpointStatements.push({
          sql: "UPDATE account_export_jobs SET row_cursor=?,capture_fragment_offset=?,row_count=row_count+?,object_count=object_count+?,status='running',version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?",
          params: [
            nextCursor,
            fragmentComplete ? 0 : nextFragmentOffset,
            fragmentComplete ? page.length : 0,
            chunkPayloads.length,
            at,
            jobId,
            userId,
            job.version,
          ],
        });
        checkpointStatements.push(guard.remove);
        try {
          if (client.batch) await client.batch(checkpointStatements);
          else {
            await client.run("BEGIN IMMEDIATE TRANSACTION");
            try {
              for (const statement of checkpointStatements)
                await client.run(statement.sql, statement.params);
              await client.run("COMMIT");
            } catch (error) {
              await client.run("ROLLBACK").catch(() => undefined);
              throw error;
            }
          }
        } catch (error) {
          if (String(error).includes("account_export_checkpoint_guards_valid"))
            return await report((await getJob(userId, jobId))!);
          return await failure(error);
        }
        return await report((await getJob(userId, jobId))!);
      } catch (error) {
        return await failure(error);
      }
    },
    async downloadPage(
      userId: string,
      jobId: string,
      cursor: AccountExportCursor | null = null,
      at = now(),
      part: number | null = null,
    ) {
      if (
        cursor !== null &&
        (!/^[A-Za-z0-9_]{1,100}$/.test(cursor.tableName) ||
          !Number.isSafeInteger(cursor.chunkIndex) ||
          cursor.chunkIndex < 0)
      )
        throw new Error("invalid_export_cursor");
      if (
        part !== null &&
        (!Number.isSafeInteger(part) || part < 1 || part > 1_000_000)
      )
        throw new Error("invalid_export_part");
      const job = await getJob(userId, jobId);
      if (!job || job.status !== "completed")
        throw new Error("export_not_ready");
      if (new Date(job.expiresAt).getTime() <= new Date(at).getTime())
        throw new Error("export_expired");
      const cursorPredicate = cursor
        ? " AND (table_name > ? OR (table_name = ? AND chunk_index > ?))"
        : "";
      const cursorParams = cursor
        ? [cursor.tableName, cursor.tableName, cursor.chunkIndex]
        : [];
      const partOffset =
        part === null
          ? ""
          : ` OFFSET ${(part - 1) * ACCOUNT_EXPORT_LIMITS.maxDownloadChunks}`;
      const chunks = await client.all<Record<string, unknown>>(
        `SELECT table_name,chunk_index,payload_json,row_count,digest,expires_at FROM account_export_chunks WHERE export_job_id=? AND user_id=?${cursorPredicate} ORDER BY table_name ASC,chunk_index ASC LIMIT ?${partOffset}`,
        [
          jobId,
          userId,
          ...cursorParams,
          ACCOUNT_EXPORT_LIMITS.maxDownloadChunks + 1,
        ],
      );
      const hasNext = chunks.length > ACCOUNT_EXPORT_LIMITS.maxDownloadChunks;
      const visibleChunks = chunks.slice(
        0,
        ACCOUNT_EXPORT_LIMITS.maxDownloadChunks,
      );
      const last = visibleChunks.at(-1);
      const nextCursor =
        hasNext && last
          ? {
              tableName: String(last.table_name),
              chunkIndex: Number(last.chunk_index),
            }
          : null;
      const manifest = await client.all<Record<string, unknown>>(
        "SELECT table_name,classification,retention,reason,source_row_count,captured_row_count,object_count,digest,cutoff_cursor FROM account_export_manifest WHERE export_job_id=? AND user_id=? ORDER BY table_name ASC LIMIT 100",
        [jobId, userId],
      );
      await audit.append({
        actorUserId: userId,
        targetOwnerUserId: userId,
        action: "account.export.download",
        targetType: "account_export_job",
        targetId: jobId,
        requestId: randomUUID(),
        result: "success",
        metadata: {
          cursor: cursor ?? null,
          chunkCount: visibleChunks.length,
          hasNext,
        },
        occurredAt: at,
      });
      return {
        job: {
          id: job.id,
          status: job.status,
          expiresAt: job.expiresAt,
          manifestDigest: job.manifestDigest,
        },
        manifest,
        chunks: visibleChunks,
        nextCursor,
        nextPart: part !== null && hasNext ? part + 1 : null,
      };
    },
  };
}
