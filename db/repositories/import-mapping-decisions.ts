import { randomUUID } from "node:crypto";
import type { SqlClient } from "./sql-client.ts";

export type ImportMappingKind =
  "portfolio" | "security" | "currency" | "transaction_type" | "fx";
export type ImportMappingScope = "row" | "batch" | "user_future";
export type ImportMappingConfidence =
  "user" | "exact_identifier" | "system_candidate";

export type ImportMappingDecision = {
  id: string;
  userId: string;
  batchId: string;
  kind: ImportMappingKind;
  sourceKey: string;
  normalizedSourceValue: string;
  targetId: string | null;
  targetValue: string | null;
  scope: ImportMappingScope;
  confidence: ImportMappingConfidence;
  source: ImportMappingConfidence;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveImportMappingDecisionInput = Omit<
  ImportMappingDecision,
  "id" | "userId" | "createdAt" | "updatedAt" | "version"
> & { id?: string };

function createRecord(row: Record<string, unknown>): ImportMappingDecision {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    batchId: String(row.batch_id),
    kind: String(row.kind) as ImportMappingKind,
    sourceKey: String(row.source_key),
    normalizedSourceValue: String(row.normalized_source_value),
    targetId: row.target_id === null ? null : String(row.target_id),
    targetValue: row.target_value === null ? null : String(row.target_value),
    scope: String(row.scope) as ImportMappingScope,
    confidence: String(row.confidence) as ImportMappingConfidence,
    source: String(row.source) as ImportMappingConfidence,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

const SELECT_COLUMNS = `
  id, user_id, batch_id, kind, source_key, normalized_source_value,
  target_id, target_value, scope, confidence, source, created_at, updated_at, version
`;

export function createOwnedImportMappingDecisionRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  return {
    async save(
      userId: string,
      input: SaveImportMappingDecisionInput,
    ): Promise<ImportMappingDecision> {
      const timestamp = now();
      const id = input.id ?? randomUUID();
      const rows = await client.all<Record<string, unknown>>(
        `
          INSERT INTO import_mapping_decisions (
            id, user_id, batch_id, kind, source_key, normalized_source_value,
            target_id, target_value, scope, confidence, source,
            created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT (batch_id, user_id, kind, source_key, scope)
          DO UPDATE SET
            normalized_source_value = excluded.normalized_source_value,
            target_id = excluded.target_id,
            target_value = excluded.target_value,
            confidence = excluded.confidence,
            source = excluded.source,
            updated_at = excluded.updated_at,
            version = import_mapping_decisions.version + 1
          RETURNING ${SELECT_COLUMNS}
        `,
        [
          id,
          userId,
          input.batchId,
          input.kind,
          input.sourceKey,
          input.normalizedSourceValue,
          input.targetId,
          input.targetValue,
          input.scope,
          input.confidence,
          input.source,
          timestamp,
          timestamp,
        ],
      );
      return createRecord(rows[0] ?? {});
    },

    async list(
      userId: string,
      batchId: string,
    ): Promise<ImportMappingDecision[]> {
      const rows = await client.all<Record<string, unknown>>(
        `
          SELECT ${SELECT_COLUMNS}
          FROM import_mapping_decisions
          WHERE user_id = ? AND batch_id = ?
          ORDER BY kind ASC, source_key ASC, scope ASC
        `,
        [userId, batchId],
      );
      return rows.map(createRecord);
    },
  };
}
