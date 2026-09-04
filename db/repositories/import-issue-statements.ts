import { randomUUID } from "node:crypto";
import type { SqlStatement } from "./sql-client.ts";

// BRK-019 slice 1 CORRECTION ROUND: extracted from
// `db/repositories/import-commit.ts`'s formerly-private
// `committedRecordDiffersIssueStatement` so `app/import-ready-service.ts`
// can persist the SAME `ROW_DIFFERS_FROM_COMMITTED_RECORD` finding at the
// ready transition (for the DIV-004 near-match/paid-date-correction case,
// which commit's own exact-`source_reference` lookup structurally cannot
// see -- a corrected paid date mints a NEW identity key) without a second,
// independently-drifting SQL copy. `import_issues` is the SAME table/shape
// `db/repositories/import-staging.ts` writes a persisted issue into at parse
// time (e.g. `SHARESIGHT_PAYOUT_KEY_COLLISION`) -- `import_issues.code` is
// free-form text with no CHECK constraint (`db/schema.ts`), so this needs no
// migration.
//
// `WHERE NOT EXISTS` guards against inserting a duplicate copy of the same
// finding on a retried commit chunk or a repeated ready-check call.
//
// CORRECTION ROUND (F4): the `WHERE NOT EXISTS` guard now also scopes by
// `user_id`, matching this codebase's convention of never keying an
// ownership-sensitive existence check on `batch_id`/`row_id` alone.
export function rowDiffersFromCommittedRecordIssueStatement(
  userId: string,
  batchId: string,
  rowId: string,
  physicalRowNumber: number,
  message: string,
  createdAt: string,
): SqlStatement {
  const id = randomUUID();
  return {
    sql: `
      INSERT INTO import_issues (
        id, user_id, batch_id, row_id, physical_row_number, field, severity,
        code, message, suggested_resolution_type, resolved_value,
        resolved_by_user_id, resolved_at, created_at, updated_at, version
      )
      SELECT ?, ?, ?, ?, ?, NULL, 'error', 'ROW_DIFFERS_FROM_COMMITTED_RECORD', ?, NULL, NULL, NULL, NULL, ?, ?, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM import_issues
        WHERE user_id = ? AND batch_id = ? AND row_id = ? AND code = 'ROW_DIFFERS_FROM_COMMITTED_RECORD'
      )
    `,
    params: [
      id,
      userId,
      batchId,
      rowId,
      physicalRowNumber,
      message,
      createdAt,
      createdAt,
      userId,
      batchId,
      rowId,
    ],
  };
}
