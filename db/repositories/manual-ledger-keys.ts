import { randomUUID } from "node:crypto";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

export type ManualLedgerMutationPurpose = "create" | "reverse" | "supersede";

export type ManualLedgerMutationKey = Readonly<{
  key: string;
  purpose: ManualLedgerMutationPurpose;
  targetTransactionId: string | null;
  status: "issued" | "used";
  expiresAt: string;
}>;

export type LedgerMutationAuthorization = Readonly<{
  key: string;
  purpose: ManualLedgerMutationPurpose;
  targetTransactionId: string | null;
}>;

const KEY_TTL_MS = 30 * 60 * 1000;

function record(row: Record<string, unknown>): ManualLedgerMutationKey {
  return {
    key: String(row.key),
    purpose: String(row.purpose) as ManualLedgerMutationPurpose,
    targetTransactionId:
      row.target_transaction_id === null
        ? null
        : String(row.target_transaction_id),
    status: String(row.status) as "issued" | "used",
    expiresAt: String(row.expires_at),
  };
}

export function createManualLedgerMutationKeyRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  return {
    async issue(
      userId: string,
      portfolioId: string,
      purpose: ManualLedgerMutationPurpose,
      targetTransactionId: string | null,
    ): Promise<ManualLedgerMutationKey | null> {
      if (
        (purpose === "create" && targetTransactionId !== null) ||
        (purpose !== "create" && targetTransactionId === null)
      ) {
        return null;
      }
      const issuedAt = now();
      const expiresAt = new Date(
        new Date(issuedAt).valueOf() + KEY_TTL_MS,
      ).toISOString();
      const key = `manual-ledger:${randomUUID()}`;
      const rows = await client.all<Record<string, unknown>>(
        `INSERT INTO manual_ledger_mutation_keys (
           key, user_id, portfolio_id, purpose, target_transaction_id,
           status, issued_at, expires_at
         )
         SELECT ?, ?, ?, ?, ?, 'issued', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM portfolios
           WHERE id = ? AND user_id = ? AND status = 'active'
         ) AND (
           ? = 'create' OR EXISTS (
             SELECT 1 FROM transactions
             WHERE id = ? AND user_id = ? AND portfolio_id = ?
               AND status = 'posted' AND reverses_transaction_id IS NULL
           )
         )
         RETURNING key, purpose, target_transaction_id, status, expires_at`,
        [
          key,
          userId,
          portfolioId,
          purpose,
          targetTransactionId,
          issuedAt,
          expiresAt,
          portfolioId,
          userId,
          purpose,
          targetTransactionId,
          userId,
          portfolioId,
        ],
      );
      return rows[0] ? record(rows[0]) : null;
    },

    async authorize(
      userId: string,
      portfolioId: string,
      key: string,
      purpose: ManualLedgerMutationPurpose,
      targetTransactionId: string | null,
    ): Promise<LedgerMutationAuthorization | null> {
      const row = await client.get<Record<string, unknown>>(
        `SELECT key, purpose, target_transaction_id, status, expires_at
         FROM manual_ledger_mutation_keys
         WHERE key = ? AND user_id = ? AND portfolio_id = ? AND purpose = ?
           AND ((target_transaction_id IS NULL AND ? IS NULL) OR target_transaction_id = ?)
           AND (status = 'used' OR expires_at >= ?)
         LIMIT 1`,
        [
          key,
          userId,
          portfolioId,
          purpose,
          targetTransactionId,
          targetTransactionId,
          now(),
        ],
      );
      return row
        ? {
            key: String(row.key),
            purpose: String(row.purpose) as ManualLedgerMutationPurpose,
            targetTransactionId:
              row.target_transaction_id === null
                ? null
                : String(row.target_transaction_id),
          }
        : null;
    },
  };
}

export function consumeManualLedgerMutationKeyStatement(
  authorization: LedgerMutationAuthorization,
  userId: string,
  portfolioId: string,
  resultTransactionId: string,
  usedAt: string,
): SqlStatement {
  return {
    sql: `UPDATE manual_ledger_mutation_keys
          SET status = 'used', result_transaction_id = ?, used_at = ?
          WHERE key = ? AND user_id = ? AND portfolio_id = ? AND purpose = ?
            AND ((target_transaction_id IS NULL AND ? IS NULL) OR target_transaction_id = ?)
            AND status = 'issued'`,
    params: [
      resultTransactionId,
      usedAt,
      authorization.key,
      userId,
      portfolioId,
      authorization.purpose,
      authorization.targetTransactionId,
      authorization.targetTransactionId,
    ],
  };
}
