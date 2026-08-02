import { randomUUID } from "node:crypto";
import { createAuditInsertStatement } from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { ManualOverride } from "../../domain/market-data/contracts.ts";

export type ManualOverrideRecord = ManualOverride & {
  id: string;
  userId: string;
};

export type SaveManualOverrideInput = {
  id?: string;
  portfolioId?: string | null;
  securityId?: string | null;
  type: ManualOverride["type"];
  targetKey: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  valueJson: string;
  reason: string;
  supersedesOverrideId?: string | null;
  requestId: string;
  calculationVersion?: number;
};

export type ManualOverrideMutationFailure = {
  ok: false;
  reason:
    "not_found" | "invalid_input" | "conflict" | "ownership" | "atomic_failure";
};

export type ManualOverrideMutationResult =
  | {
      ok: true;
      override: ManualOverrideRecord;
      invalidationId: string | null;
    }
  | ManualOverrideMutationFailure;

const OVERRIDE_COLUMNS = `
  id, user_id, portfolio_id, security_id, type, target_key, effective_from,
  effective_to, value_json, reason, status, supersedes_override_id, created_at
`;

function mapOverride(row: Record<string, unknown>): ManualOverrideRecord {
  return {
    kind: "manual_override",
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: row.portfolio_id === null ? null : String(row.portfolio_id),
    securityId: row.security_id === null ? null : String(row.security_id),
    type: String(row.type) as ManualOverride["type"],
    targetKey: String(row.target_key),
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to),
    valueJson: String(row.value_json),
    reason: String(row.reason),
    status: String(row.status) as ManualOverride["status"],
    supersedesOverrideId:
      row.supersedes_override_id === null
        ? null
        : String(row.supersedes_override_id),
    createdAt: String(row.created_at),
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

function validDecimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
    /[1-9]/.test(value.replace(".", ""))
  );
}

function validOverrideValue(
  type: ManualOverride["type"],
  valueJson: string,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (type === "price") {
    const close = record.closeDecimal ?? record.close;
    return validDecimal(close) && typeof record.currencyCode === "string";
  }
  if (type === "fx_rate") {
    return (
      validDecimal(record.rateDecimal) &&
      typeof record.baseCurrencyCode === "string" &&
      typeof record.quoteCurrencyCode === "string" &&
      record.baseCurrencyCode !== record.quoteCurrencyCode
    );
  }
  if (type === "security_mapping") {
    return typeof record.targetId === "string" && record.targetId.length > 0;
  }
  return validDecimal(record.rateDecimal);
}

async function atomic(
  client: SqlClient,
  statements: readonly SqlStatement[],
): Promise<void> {
  if (client.batch) {
    await client.batch(statements);
    return;
  }
  await client.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const statement of statements) {
      await client.run(statement.sql, statement.params);
    }
    await client.run("COMMIT");
  } catch (error) {
    await client.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export function createOwnedManualOverrideRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(
    userId: string,
    id: string,
  ): Promise<ManualOverrideRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${OVERRIDE_COLUMNS} FROM manual_overrides
       WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId],
    );
    return row ? mapOverride(row) : null;
  }

  async function validateScope(
    userId: string,
    input: SaveManualOverrideInput,
  ): Promise<ManualOverrideMutationFailure | null> {
    if (input.portfolioId) {
      const portfolio = await client.get<{ id: string }>(
        "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
        [input.portfolioId, userId],
      );
      if (!portfolio) return { ok: false, reason: "not_found" };
    }
    if (input.securityId) {
      const security = await client.get<{ id: string }>(
        "SELECT id FROM securities WHERE id = ? LIMIT 1",
        [input.securityId],
      );
      if (!security) return { ok: false, reason: "not_found" };
    }
    return null;
  }

  async function save(
    userId: string,
    input: SaveManualOverrideInput,
  ): Promise<ManualOverrideMutationResult> {
    const effectiveTo = input.effectiveTo ?? null;
    if (
      !input.targetKey ||
      input.targetKey.length > 240 ||
      !validDate(input.effectiveFrom) ||
      (effectiveTo !== null && !validDate(effectiveTo)) ||
      (effectiveTo !== null && effectiveTo < input.effectiveFrom) ||
      input.reason.trim().length < 1 ||
      input.reason.length > 500 ||
      (input.calculationVersion !== undefined &&
        (!Number.isSafeInteger(input.calculationVersion) ||
          input.calculationVersion < 1)) ||
      !validOverrideValue(input.type, input.valueJson)
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    const scopeFailure = await validateScope(userId, input);
    if (scopeFailure) return scopeFailure;
    const existing = input.supersedesOverrideId
      ? await get(userId, input.supersedesOverrideId)
      : null;
    if (
      input.supersedesOverrideId &&
      (!existing || existing.status !== "active")
    ) {
      return { ok: false, reason: "conflict" };
    }
    if (
      existing &&
      (existing.type !== input.type || existing.targetKey !== input.targetKey)
    ) {
      return { ok: false, reason: "conflict" };
    }
    const overlap = await client.get<{ id: string }>(
      `SELECT id FROM manual_overrides
       WHERE user_id = ? AND type = ? AND target_key = ? AND status = 'active'
         AND id <> COALESCE(?, '')
         AND NOT (
           (effective_to IS NOT NULL AND effective_to < ?)
           OR (? IS NOT NULL AND ? < effective_from)
         ) LIMIT 1`,
      [
        userId,
        input.type,
        input.targetKey,
        input.supersedesOverrideId ?? null,
        input.effectiveFrom,
        effectiveTo,
        effectiveTo,
      ],
    );
    if (overlap) return { ok: false, reason: "conflict" };

    const id = input.id ?? randomUUID();
    const createdAt = now();
    const invalidationId = input.portfolioId ? randomUUID() : null;
    const statements: SqlStatement[] = [];
    if (existing) {
      statements.push({
        sql: `UPDATE manual_overrides SET status = 'superseded'
          WHERE id = ? AND user_id = ? AND status = 'active'`,
        params: [existing.id, userId],
      });
    }
    statements.push({
      sql: `INSERT INTO manual_overrides (
        id, user_id, portfolio_id, security_id, type, target_key,
        effective_from, effective_to, value_json, reason, status,
        supersedes_override_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      params: [
        id,
        userId,
        input.portfolioId ?? null,
        input.securityId ?? null,
        input.type,
        input.targetKey,
        input.effectiveFrom,
        effectiveTo,
        input.valueJson,
        input.reason.trim(),
        input.supersedesOverrideId ?? null,
        createdAt,
      ],
    });
    if (invalidationId && input.portfolioId) {
      statements.push({
        sql: `INSERT INTO calculation_runs (
          id, user_id, portfolio_id, range_from, range_to, calculation_version,
          reason, invalidation_source, status, attempt, ledger_high_water_start,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manual_override', ?, 'queued', 0, '', ?, ?, ?)`,
        params: [
          invalidationId,
          userId,
          input.portfolioId,
          input.effectiveFrom,
          effectiveTo ?? input.effectiveFrom,
          input.calculationVersion ?? 1,
          id,
          `override:${id}`,
          createdAt,
          createdAt,
        ],
      });
    }
    statements.push(
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: existing
            ? "market.override.supersede"
            : "market.override.create",
          targetType: "manual_override",
          targetId: id,
          requestId: input.requestId,
          result: "success",
          metadata: {
            type: input.type,
            targetKey: input.targetKey,
            portfolioId: input.portfolioId ?? null,
          },
          occurredAt: createdAt,
        },
        now,
      ),
    );
    try {
      await atomic(client, statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const override = await get(userId, id);
    return override
      ? { ok: true, override, invalidationId }
      : { ok: false, reason: "atomic_failure" };
  }

  async function remove(
    userId: string,
    id: string,
    requestId: string,
  ): Promise<ManualOverrideMutationResult> {
    const existing = await get(userId, id);
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.status !== "active") return { ok: false, reason: "conflict" };
    const createdAt = now();
    const invalidationId = existing.portfolioId ? randomUUID() : null;
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE manual_overrides SET status = 'revoked'
          WHERE id = ? AND user_id = ? AND status = 'active'`,
        params: [id, userId],
      },
    ];
    if (invalidationId && existing.portfolioId) {
      statements.push({
        sql: `INSERT INTO calculation_runs (
          id, user_id, portfolio_id, range_from, range_to, calculation_version,
          reason, invalidation_source, status, attempt, ledger_high_water_start,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'manual_override_remove', ?, 'queued', 0, '', ?, ?, ?)`,
        params: [
          invalidationId,
          userId,
          existing.portfolioId,
          existing.effectiveFrom,
          existing.effectiveTo ?? existing.effectiveFrom,
          id,
          `override-remove:${id}`,
          createdAt,
          createdAt,
        ],
      });
    }
    statements.push(
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "market.override.remove",
          targetType: "manual_override",
          targetId: id,
          requestId,
          result: "success",
          metadata: { type: existing.type },
          occurredAt: createdAt,
        },
        now,
      ),
    );
    try {
      await atomic(client, statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const override = await get(userId, id);
    return override
      ? { ok: true, override, invalidationId }
      : { ok: false, reason: "atomic_failure" };
  }

  async function list(
    userId: string,
    targetKey?: string,
  ): Promise<ManualOverrideRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${OVERRIDE_COLUMNS} FROM manual_overrides
       WHERE user_id = ? ${targetKey ? "AND target_key = ?" : ""}
       ORDER BY created_at ASC, id ASC`,
      targetKey ? [userId, targetKey] : [userId],
    );
    return rows.map(mapOverride);
  }

  return { get, list, remove, save };
}
