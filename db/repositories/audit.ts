import { randomUUID } from "node:crypto";
import { redactMetadata } from "../../domain/observability/redaction.ts";
import type { SqlClient } from "./sql-client.ts";

export type AuditResult = "success" | "failure" | "denied";

export type AppendAuditEventInput = {
  id?: string;
  actorUserId: string | null;
  targetOwnerUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  requestId: string;
  result: AuditResult;
  metadata?: unknown;
  occurredAt?: string;
};

export type AuditEventRecord = AppendAuditEventInput & {
  id: string;
  metadataJson: string;
  occurredAt: string;
};

function createRecord(row: Record<string, unknown>): AuditEventRecord {
  return {
    id: String(row.id),
    actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
    targetOwnerUserId:
      row.target_owner_user_id === null
        ? null
        : String(row.target_owner_user_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: row.target_id === null ? null : String(row.target_id),
    requestId: String(row.request_id),
    result: String(row.result) as AuditResult,
    metadataJson: String(row.metadata_json),
    metadata: undefined,
    occurredAt: String(row.occurred_at),
  };
}

export function createAuditRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  return {
    async append(input: AppendAuditEventInput): Promise<AuditEventRecord> {
      const id = input.id ?? randomUUID();
      const occurredAt = input.occurredAt ?? now();
      const metadataJson = JSON.stringify(redactMetadata(input.metadata ?? {}));

      await client.run(
        `
          INSERT INTO audit_events (
            id, actor_user_id, target_owner_user_id, action, target_type,
            target_id, request_id, result, metadata_json, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          input.actorUserId,
          input.targetOwnerUserId,
          input.action,
          input.targetType,
          input.targetId,
          input.requestId,
          input.result,
          metadataJson,
          occurredAt,
        ],
      );

      return {
        ...input,
        id,
        metadataJson,
        occurredAt,
      };
    },

    async listForOwner(userId: string): Promise<AuditEventRecord[]> {
      const rows = await client.all<Record<string, unknown>>(
        `
          SELECT id, actor_user_id, target_owner_user_id, action, target_type,
            target_id, request_id, result, metadata_json, occurred_at
          FROM audit_events
          WHERE target_owner_user_id = ?
          ORDER BY occurred_at ASC, id ASC
        `,
        [userId],
      );

      return rows.map(createRecord);
    },
  };
}
