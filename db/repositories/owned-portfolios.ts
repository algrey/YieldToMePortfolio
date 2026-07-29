import { randomUUID } from "node:crypto";
import { type SqlClient } from "./sql-client.ts";
import { createAuditRepository } from "./audit.ts";

export type PortfolioStatus = "active" | "archived";
export type PortfolioAccountingMethod = "fifo";

export type OwnedPortfolioRecord = {
  id: string;
  userId: string;
  code: string;
  name: string;
  baseCurrencyCode: string;
  timezone: string;
  accountingMethod: PortfolioAccountingMethod;
  historyCompleteFrom: string | null;
  status: PortfolioStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  homeCurrencyCode: string;
};

export type OwnedUserSettingsRecord = {
  userId: string;
  homeCurrencyCode: string;
  timezone: string;
  defaultHoldingCurrencyView: "native" | "home";
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type CreatePortfolioInput = {
  id?: string;
  code: string;
  name: string;
  timezone: string;
  accountingMethod?: PortfolioAccountingMethod;
  historyCompleteFrom?: string | null;
};

export type UpdatePortfolioInput = {
  expectedVersion: number;
  name?: string;
  timezone?: string;
};

export type ArchiveRestorePortfolioInput = {
  expectedVersion: number;
};

export type HomeCurrencyChangeInput = {
  expectedVersion: number;
  homeCurrencyCode: string;
};

export type PortfolioMutationFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict" };

export type PortfolioMutationResult =
  { ok: true; portfolio: OwnedPortfolioRecord } | PortfolioMutationFailure;

export type HomeCurrencyRebaseRequest = {
  requestId: string;
  userId: string;
  previousHomeCurrencyCode: string;
  nextHomeCurrencyCode: string;
  affectedPortfolioIds: string[];
  portfolioCount: number;
  requestedAt: string;
};

export type HomeCurrencyChangeResult =
  | {
      ok: true;
      settings: OwnedUserSettingsRecord;
      rebaseRequest: HomeCurrencyRebaseRequest;
    }
  | PortfolioMutationFailure;

export type PortfolioListOptions = {
  includeArchived?: boolean;
};

export type PortfolioRepositoryOptions = {
  requestId?: string;
};

const PORTFOLIO_COLUMNS = `
  p.id,
  p.user_id,
  p.code,
  p.name,
  p.base_currency_code,
  p.timezone,
  p.accounting_method,
  p.history_complete_from,
  p.status,
  p.created_at,
  p.updated_at,
  p.version,
  us.home_currency_code
`;

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function isMutationFailure(value: unknown): value is PortfolioMutationFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === false
  );
}

function createPortfolioRecord(
  row: Record<string, unknown>,
): OwnedPortfolioRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    code: String(row.code),
    name: String(row.name),
    baseCurrencyCode: String(row.base_currency_code),
    timezone: String(row.timezone),
    accountingMethod: String(
      row.accounting_method,
    ) as PortfolioAccountingMethod,
    historyCompleteFrom:
      row.history_complete_from === null
        ? null
        : String(row.history_complete_from),
    status: String(row.status) as PortfolioStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    homeCurrencyCode: String(row.home_currency_code),
  };
}

function createUserSettingsRecord(
  row: Record<string, unknown>,
): OwnedUserSettingsRecord {
  return {
    userId: String(row.user_id),
    homeCurrencyCode: String(row.home_currency_code),
    timezone: String(row.timezone),
    defaultHoldingCurrencyView: String(row.default_holding_currency_view) as
      "native" | "home",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

async function resolveMutationFailure(
  client: SqlClient,
  table: "portfolios" | "user_settings",
  userId: string,
  resourceId: string,
): Promise<PortfolioMutationFailure> {
  const row =
    table === "portfolios"
      ? await client.get<{ id: string }>(
          "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
          [resourceId, userId],
        )
      : await client.get<{ user_id: string }>(
          "SELECT user_id FROM user_settings WHERE user_id = ? LIMIT 1",
          [userId],
        );

  return row
    ? { ok: false, reason: "version_conflict" }
    : { ok: false, reason: "not_found" };
}

async function runMutation<T extends Record<string, unknown>>(
  client: SqlClient,
  table: "portfolios" | "user_settings",
  updateSql: string,
  params: readonly unknown[],
  userId: string,
  resourceId: string,
): Promise<PortfolioMutationFailure | T> {
  const rows = await client.all<T>(updateSql, params);
  if (rows.length > 0) {
    return rows[0] as T;
  }

  return await resolveMutationFailure(client, table, userId, resourceId);
}

export function createOwnedPortfolioRepository(
  client: SqlClient,
  now?: () => string,
  options: PortfolioRepositoryOptions = {},
) {
  const requestId = options.requestId ?? randomUUID();
  const audit = createAuditRepository(client, now);

  async function recordMutation(
    userId: string,
    action: string,
    targetId: string,
  ): Promise<void> {
    await audit.append({
      actorUserId: userId,
      targetOwnerUserId: userId,
      action,
      targetType: "portfolio",
      targetId,
      requestId,
      result: "success",
      occurredAt: nowIso(now),
    });
  }

  return {
    async list(
      userId: string,
      options: PortfolioListOptions = {},
    ): Promise<OwnedPortfolioRecord[]> {
      const statusPredicate = options.includeArchived
        ? ""
        : "AND p.status = 'active'";
      const rows = await client.all<Record<string, unknown>>(
        `
          SELECT ${PORTFOLIO_COLUMNS}
          FROM portfolios AS p
          INNER JOIN user_settings AS us ON us.user_id = p.user_id
          WHERE p.user_id = ?
          ${statusPredicate}
          ORDER BY p.updated_at DESC, p.id ASC
        `,
        [userId],
      );

      return rows.map((row) => createPortfolioRecord(row));
    },

    async get(
      userId: string,
      portfolioId: string,
    ): Promise<OwnedPortfolioRecord | null> {
      const row = await client.get<Record<string, unknown>>(
        `
          SELECT ${PORTFOLIO_COLUMNS}
          FROM portfolios AS p
          INNER JOIN user_settings AS us ON us.user_id = p.user_id
          WHERE p.user_id = ? AND p.id = ?
          LIMIT 1
        `,
        [userId, portfolioId],
      );

      return row ? createPortfolioRecord(row) : null;
    },

    async create(
      userId: string,
      input: CreatePortfolioInput,
    ): Promise<OwnedPortfolioRecord | null> {
      const createdAt = nowIso(now);
      const portfolioId = input.id ?? randomUUID();
      const rows = await client.all<Record<string, unknown>>(
        `
          INSERT INTO portfolios (
            id, user_id, code, name, base_currency_code, timezone,
            accounting_method, history_complete_from, status,
            created_at, updated_at, version
          )
          SELECT
            ?, us.user_id, ?, ?, us.home_currency_code, ?, ?, ?, 'active',
            ?, ?, 1
          FROM user_settings AS us
          WHERE us.user_id = ?
          RETURNING id, user_id, code, name, base_currency_code, timezone,
            accounting_method, history_complete_from, status, created_at,
            updated_at, version, base_currency_code AS home_currency_code
        `,
        [
          portfolioId,
          input.code,
          input.name,
          input.timezone,
          input.accountingMethod ?? "fifo",
          input.historyCompleteFrom ?? null,
          createdAt,
          createdAt,
          userId,
        ],
      );

      const portfolio =
        rows.length > 0 ? createPortfolioRecord(rows[0] ?? {}) : null;
      if (portfolio) {
        await recordMutation(userId, "portfolio.create", portfolio.id);
      }
      return portfolio;
    },

    async rename(
      userId: string,
      portfolioId: string,
      input: UpdatePortfolioInput,
    ): Promise<PortfolioMutationResult> {
      const updatedAt = nowIso(now);
      const result = await runMutation<Record<string, unknown>>(
        client,
        "portfolios",
        `
          UPDATE portfolios
          SET name = COALESCE(?, name),
              timezone = COALESCE(?, timezone),
              updated_at = ?,
              version = version + 1
          WHERE id = ? AND user_id = ? AND version = ?
          RETURNING id, user_id, code, name, base_currency_code, timezone,
            accounting_method, history_complete_from, status, created_at,
            updated_at, version,
            base_currency_code AS home_currency_code
        `,
        [
          input.name ?? null,
          input.timezone ?? null,
          updatedAt,
          portfolioId,
          userId,
          input.expectedVersion,
        ],
        userId,
        portfolioId,
      );

      if (isMutationFailure(result)) {
        return result;
      }

      const portfolio = {
        ok: true as const,
        portfolio: createPortfolioRecord(result),
      };
      await recordMutation(userId, "portfolio.rename", portfolio.portfolio.id);
      return portfolio;
    },

    async archive(
      userId: string,
      portfolioId: string,
      input: ArchiveRestorePortfolioInput,
    ): Promise<PortfolioMutationResult> {
      const updatedAt = nowIso(now);
      const result = await runMutation<Record<string, unknown>>(
        client,
        "portfolios",
        `
          UPDATE portfolios
          SET status = 'archived',
              updated_at = ?,
              version = version + 1
          WHERE id = ? AND user_id = ? AND version = ?
          RETURNING id, user_id, code, name, base_currency_code, timezone,
            accounting_method, history_complete_from, status, created_at,
            updated_at, version,
            base_currency_code AS home_currency_code
        `,
        [updatedAt, portfolioId, userId, input.expectedVersion],
        userId,
        portfolioId,
      );

      if (isMutationFailure(result)) {
        return result;
      }

      const portfolio = {
        ok: true as const,
        portfolio: createPortfolioRecord(result),
      };
      await recordMutation(userId, "portfolio.archive", portfolio.portfolio.id);
      return portfolio;
    },

    async restore(
      userId: string,
      portfolioId: string,
      input: ArchiveRestorePortfolioInput,
    ): Promise<PortfolioMutationResult> {
      const updatedAt = nowIso(now);
      const result = await runMutation<Record<string, unknown>>(
        client,
        "portfolios",
        `
          UPDATE portfolios
          SET status = 'active',
              updated_at = ?,
              version = version + 1
          WHERE id = ? AND user_id = ? AND version = ?
          RETURNING id, user_id, code, name, base_currency_code, timezone,
            accounting_method, history_complete_from, status, created_at,
            updated_at, version,
            base_currency_code AS home_currency_code
        `,
        [updatedAt, portfolioId, userId, input.expectedVersion],
        userId,
        portfolioId,
      );

      if (isMutationFailure(result)) {
        return result;
      }

      const portfolio = {
        ok: true as const,
        portfolio: createPortfolioRecord(result),
      };
      await recordMutation(userId, "portfolio.restore", portfolio.portfolio.id);
      return portfolio;
    },
  };
}

export function createOwnedUserSettingsRepository(
  client: SqlClient,
  now?: () => string,
  options: PortfolioRepositoryOptions = {},
) {
  const requestId = options.requestId ?? randomUUID();
  const audit = createAuditRepository(client, now);

  return {
    async get(userId: string): Promise<OwnedUserSettingsRecord | null> {
      const row = await client.get<Record<string, unknown>>(
        `
          SELECT user_id, home_currency_code, timezone,
            default_holding_currency_view, created_at, updated_at, version
          FROM user_settings
          WHERE user_id = ?
          LIMIT 1
        `,
        [userId],
      );

      return row ? createUserSettingsRecord(row) : null;
    },

    async requestHomeCurrencyRebase(
      userId: string,
      input: HomeCurrencyChangeInput,
    ): Promise<HomeCurrencyChangeResult> {
      const updatedAt = nowIso(now);
      const currentSettings = await client.get<{ home_currency_code: string }>(
        "SELECT home_currency_code FROM user_settings WHERE user_id = ? LIMIT 1",
        [userId],
      );
      if (!currentSettings) {
        return { ok: false, reason: "not_found" };
      }

      const mutation = await runMutation<Record<string, unknown>>(
        client,
        "user_settings",
        `
          UPDATE user_settings
          SET home_currency_code = ?,
              updated_at = ?,
              version = version + 1
          WHERE user_id = ? AND version = ?
          RETURNING user_id, home_currency_code, timezone,
            default_holding_currency_view, created_at, updated_at, version
        `,
        [input.homeCurrencyCode, updatedAt, userId, input.expectedVersion],
        userId,
        userId,
      );

      if (isMutationFailure(mutation)) {
        return mutation;
      }

      const settings = createUserSettingsRecord(mutation);
      const affectedPortfolioRows = await client.all<{ id: string }>(
        `
          SELECT id
          FROM portfolios
          WHERE user_id = ?
          ORDER BY updated_at DESC, id ASC
        `,
        [userId],
      );

      await audit.append({
        actorUserId: userId,
        targetOwnerUserId: userId,
        action: "settings.home_currency_change",
        targetType: "user_settings",
        targetId: userId,
        requestId,
        result: "success",
        occurredAt: updatedAt,
      });

      return {
        ok: true,
        settings,
        rebaseRequest: {
          requestId: randomUUID(),
          userId,
          previousHomeCurrencyCode: currentSettings.home_currency_code,
          nextHomeCurrencyCode: input.homeCurrencyCode,
          affectedPortfolioIds: affectedPortfolioRows.map((row) => row.id),
          portfolioCount: affectedPortfolioRows.length,
          requestedAt: updatedAt,
        },
      };
    },
  };
}
