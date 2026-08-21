import { randomUUID } from "node:crypto";
import { type SqlClient, type SqlStatement } from "./sql-client.ts";

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

export type PriceSourcePreference =
  "yahoo_authenticated" | "yahoo_anonymous" | "sharesight_delayed";

export type OwnedUserSettingsRecord = {
  userId: string;
  homeCurrencyCode: string;
  timezone: string;
  defaultHoldingCurrencyView: "native" | "home";
  financialYearStartMonth: number;
  priceSourcePreference: PriceSourcePreference;
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

export type HoldingCurrencyViewChangeInput = {
  expectedVersion: number;
  view: "native" | "home";
};

export type FinancialYearStartMonthChangeInput = {
  expectedVersion: number;
  financialYearStartMonth: number;
};

export type PriceSourcePreferenceChangeInput = {
  expectedVersion: number;
  priceSourcePreference: PriceSourcePreference;
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

export type HoldingCurrencyViewChangeResult =
  { ok: true; settings: OwnedUserSettingsRecord } | PortfolioMutationFailure;

export type FinancialYearStartMonthChangeResult =
  { ok: true; settings: OwnedUserSettingsRecord } | PortfolioMutationFailure;

export type PriceSourcePreferenceChangeResult =
  { ok: true; settings: OwnedUserSettingsRecord } | PortfolioMutationFailure;

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
    financialYearStartMonth: Number(row.financial_year_start_month),
    priceSourcePreference: String(
      row.price_source_preference,
    ) as PriceSourcePreference,
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

function auditMutationStatement(input: {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  occurredAt: string;
  condition: string;
  conditionParams: readonly unknown[];
}): SqlStatement {
  return {
    sql: `
      INSERT INTO audit_events (
        id, actor_user_id, target_owner_user_id, action, target_type,
        target_id, request_id, result, metadata_json, occurred_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'success', '{}', ?
      WHERE ${input.condition}
    `,
    params: [
      randomUUID(),
      input.actorUserId,
      input.actorUserId,
      input.action,
      input.targetType,
      input.targetId,
      input.requestId,
      input.occurredAt,
      ...input.conditionParams,
    ],
  };
}

export function createOwnedPortfolioRepository(
  client: SqlClient,
  now?: () => string,
  options: PortfolioRepositoryOptions = {},
) {
  const requestId = options.requestId ?? randomUUID();

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
      const rows = await client.batch([
        {
          sql: `
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
          params: [
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
        },
        auditMutationStatement({
          actorUserId: userId,
          action: "portfolio.create",
          targetType: "portfolio",
          targetId: portfolioId,
          requestId,
          occurredAt: createdAt,
          condition:
            "EXISTS (SELECT 1 FROM portfolios WHERE id = ? AND user_id = ?)",
          conditionParams: [portfolioId, userId],
        }),
      ]);
      const row = rows[0]?.results[0];
      return row ? createPortfolioRecord(row) : null;
    },

    async rename(
      userId: string,
      portfolioId: string,
      input: UpdatePortfolioInput,
    ): Promise<PortfolioMutationResult> {
      const updatedAt = nowIso(now);
      const updateStatement: SqlStatement = {
        sql: `
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
        params: [
          input.name ?? null,
          input.timezone ?? null,
          updatedAt,
          portfolioId,
          userId,
          input.expectedVersion,
        ],
      };
      // See the pre-state-guard note in `owned-portfolios.ts` settings
      // mutations (DB-006): the audit INSERT runs first, guarded on the
      // batch's PRE-state (version = expectedVersion, matching the UPDATE's
      // own WHERE), with the version-bumping UPDATE last. A POST-state guard
      // (version = expectedVersion + 1) is unsound: a concurrent writer's
      // own bump can independently produce that value while THIS call's
      // UPDATE no-ops against its now-stale expectedVersion, producing a
      // spurious audit row for a mutation that never applied.
      const rows = await client.batch([
        auditMutationStatement({
          actorUserId: userId,
          action: "portfolio.rename",
          targetType: "portfolio",
          targetId: portfolioId,
          requestId,
          occurredAt: updatedAt,
          condition:
            "EXISTS (SELECT 1 FROM portfolios WHERE id = ? AND user_id = ? AND version = ?)",
          conditionParams: [portfolioId, userId, input.expectedVersion],
        }),
        updateStatement,
      ]);
      const row = rows[rows.length - 1]?.results[0];
      if (row) return { ok: true, portfolio: createPortfolioRecord(row) };
      return await resolveMutationFailure(
        client,
        "portfolios",
        userId,
        portfolioId,
      );
    },

    async archive(
      userId: string,
      portfolioId: string,
      input: ArchiveRestorePortfolioInput,
    ): Promise<PortfolioMutationResult> {
      const updatedAt = nowIso(now);
      const updateStatement: SqlStatement = {
        sql: `
          UPDATE portfolios
          SET status = 'archived', updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND version = ?
          RETURNING id, user_id, code, name, base_currency_code, timezone,
            accounting_method, history_complete_from, status, created_at,
            updated_at, version, base_currency_code AS home_currency_code
        `,
        params: [updatedAt, portfolioId, userId, input.expectedVersion],
      };
      // See the pre-state-guard note in `rename` above: the audit INSERT
      // runs first, guarded on the batch's PRE-state (version =
      // expectedVersion, matching the UPDATE's own WHERE), with the
      // version-bumping UPDATE last.
      const rows = await client.batch([
        auditMutationStatement({
          actorUserId: userId,
          action: "portfolio.archive",
          targetType: "portfolio",
          targetId: portfolioId,
          requestId,
          occurredAt: updatedAt,
          condition:
            "EXISTS (SELECT 1 FROM portfolios WHERE id = ? AND user_id = ? AND version = ?)",
          conditionParams: [portfolioId, userId, input.expectedVersion],
        }),
        updateStatement,
      ]);
      const row = rows[rows.length - 1]?.results[0];
      if (row) return { ok: true, portfolio: createPortfolioRecord(row) };
      return await resolveMutationFailure(
        client,
        "portfolios",
        userId,
        portfolioId,
      );
    },

    async restore(
      userId: string,
      portfolioId: string,
      input: ArchiveRestorePortfolioInput,
    ): Promise<PortfolioMutationResult> {
      const updatedAt = nowIso(now);
      const updateStatement: SqlStatement = {
        sql: `
          UPDATE portfolios
          SET status = 'active', updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND version = ?
          RETURNING id, user_id, code, name, base_currency_code, timezone,
            accounting_method, history_complete_from, status, created_at,
            updated_at, version, base_currency_code AS home_currency_code
        `,
        params: [updatedAt, portfolioId, userId, input.expectedVersion],
      };
      // See the pre-state-guard note in `rename` above: the audit INSERT
      // runs first, guarded on the batch's PRE-state (version =
      // expectedVersion, matching the UPDATE's own WHERE), with the
      // version-bumping UPDATE last.
      const rows = await client.batch([
        auditMutationStatement({
          actorUserId: userId,
          action: "portfolio.restore",
          targetType: "portfolio",
          targetId: portfolioId,
          requestId,
          occurredAt: updatedAt,
          condition:
            "EXISTS (SELECT 1 FROM portfolios WHERE id = ? AND user_id = ? AND version = ?)",
          conditionParams: [portfolioId, userId, input.expectedVersion],
        }),
        updateStatement,
      ]);
      const row = rows[rows.length - 1]?.results[0];
      if (row) return { ok: true, portfolio: createPortfolioRecord(row) };
      return await resolveMutationFailure(
        client,
        "portfolios",
        userId,
        portfolioId,
      );
    },
  };
}

export function createOwnedUserSettingsRepository(
  client: SqlClient,
  now?: () => string,
  options: PortfolioRepositoryOptions = {},
) {
  const requestId = options.requestId ?? randomUUID();

  return {
    async get(userId: string): Promise<OwnedUserSettingsRecord | null> {
      const row = await client.get<Record<string, unknown>>(
        `
          SELECT user_id, home_currency_code, timezone,
            default_holding_currency_view, financial_year_start_month,
            price_source_preference, created_at, updated_at, version
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
      const currentSettings = await client.get<{
        home_currency_code: string;
      }>(
        "SELECT home_currency_code FROM user_settings WHERE user_id = ? LIMIT 1",
        [userId],
      );
      if (!currentSettings) return { ok: false, reason: "not_found" };

      const updateStatement: SqlStatement = {
        sql: `
          UPDATE user_settings
          SET home_currency_code = ?, updated_at = ?, version = version + 1
          WHERE user_id = ? AND version = ?
          RETURNING user_id, home_currency_code, timezone,
            default_holding_currency_view, financial_year_start_month,
            price_source_preference, created_at, updated_at, version
        `,
        params: [
          input.homeCurrencyCode,
          updatedAt,
          userId,
          input.expectedVersion,
        ],
      };
      // The audit INSERT runs FIRST, guarded on the batch's PRE-state
      // (version = expectedVersion, matching the UPDATE's own WHERE), with
      // the version-bumping UPDATE LAST — see the QA-003 pattern in
      // `import-staging.ts` (`runAtomicPersist`). A POST-state guard
      // (version = expectedVersion + 1) is unsound: a concurrent writer's
      // own bump can independently produce that value while THIS call's
      // UPDATE no-ops against its now-stale expectedVersion, producing a
      // spurious audit row for a mutation that never applied.
      const rows = await client.batch([
        auditMutationStatement({
          actorUserId: userId,
          action: "settings.home_currency_change",
          targetType: "user_settings",
          targetId: userId,
          requestId,
          occurredAt: updatedAt,
          condition:
            "EXISTS (SELECT 1 FROM user_settings WHERE user_id = ? AND version = ?)",
          conditionParams: [userId, input.expectedVersion],
        }),
        updateStatement,
      ]);
      const row = rows[rows.length - 1]?.results[0];
      if (!row) {
        return await resolveMutationFailure(
          client,
          "user_settings",
          userId,
          userId,
        );
      }
      const settings = createUserSettingsRecord(row);
      const affectedPortfolioRows = await client.all<{ id: string }>(
        "SELECT id FROM portfolios WHERE user_id = ? ORDER BY updated_at DESC, id ASC",
        [userId],
      );
      return {
        ok: true,
        settings,
        rebaseRequest: {
          requestId: randomUUID(),
          userId,
          previousHomeCurrencyCode: currentSettings.home_currency_code,
          nextHomeCurrencyCode: input.homeCurrencyCode,
          affectedPortfolioIds: affectedPortfolioRows.map((item) => item.id),
          portfolioCount: affectedPortfolioRows.length,
          requestedAt: updatedAt,
        },
      };
    },

    async setHoldingCurrencyView(
      userId: string,
      input: HoldingCurrencyViewChangeInput,
    ): Promise<HoldingCurrencyViewChangeResult> {
      const updatedAt = nowIso(now);
      const updateStatement: SqlStatement = {
        sql: `
          UPDATE user_settings
          SET default_holding_currency_view = ?, updated_at = ?, version = version + 1
          WHERE user_id = ? AND version = ?
          RETURNING user_id, home_currency_code, timezone,
            default_holding_currency_view, financial_year_start_month,
            price_source_preference, created_at, updated_at, version
        `,
        params: [input.view, updatedAt, userId, input.expectedVersion],
      };
      // See the pre-state-guard note in `requestHomeCurrencyRebase` above:
      // the audit INSERT runs first, guarded on the batch's PRE-state
      // (version = expectedVersion), with the version-bumping UPDATE last.
      const rows = await client.batch([
        auditMutationStatement({
          actorUserId: userId,
          action: "settings.holding_currency_view_change",
          targetType: "user_settings",
          targetId: userId,
          requestId,
          occurredAt: updatedAt,
          condition:
            "EXISTS (SELECT 1 FROM user_settings WHERE user_id = ? AND version = ?)",
          conditionParams: [userId, input.expectedVersion],
        }),
        updateStatement,
      ]);
      const row = rows[rows.length - 1]?.results[0];
      return row
        ? { ok: true, settings: createUserSettingsRecord(row) }
        : await resolveMutationFailure(client, "user_settings", userId, userId);
    },

    async setFinancialYearStartMonth(
      userId: string,
      input: FinancialYearStartMonthChangeInput,
    ): Promise<FinancialYearStartMonthChangeResult> {
      const updatedAt = nowIso(now);
      const updateStatement: SqlStatement = {
        sql: `
          UPDATE user_settings
          SET financial_year_start_month = ?, updated_at = ?, version = version + 1
          WHERE user_id = ? AND version = ?
          RETURNING user_id, home_currency_code, timezone,
            default_holding_currency_view, financial_year_start_month,
            price_source_preference, created_at, updated_at, version
        `,
        params: [
          input.financialYearStartMonth,
          updatedAt,
          userId,
          input.expectedVersion,
        ],
      };
      // See the pre-state-guard note in `requestHomeCurrencyRebase` above:
      // the audit INSERT runs first, guarded on the batch's PRE-state
      // (version = expectedVersion), with the version-bumping UPDATE last.
      const rows = await client.batch([
        auditMutationStatement({
          actorUserId: userId,
          action: "settings.financial_year_start_month_change",
          targetType: "user_settings",
          targetId: userId,
          requestId,
          occurredAt: updatedAt,
          condition:
            "EXISTS (SELECT 1 FROM user_settings WHERE user_id = ? AND version = ?)",
          conditionParams: [userId, input.expectedVersion],
        }),
        updateStatement,
      ]);
      const row = rows[rows.length - 1]?.results[0];
      return row
        ? { ok: true, settings: createUserSettingsRecord(row) }
        : await resolveMutationFailure(client, "user_settings", userId, userId);
    },

    // MKT-009B: mirrors `setFinancialYearStartMonth` exactly (own settings
    // repository precedent, itself following FY-001's own precedent) --
    // owner-scoped, optimistic-version-guarded, single audited batch.
    async setPriceSourcePreference(
      userId: string,
      input: PriceSourcePreferenceChangeInput,
    ): Promise<PriceSourcePreferenceChangeResult> {
      const updatedAt = nowIso(now);
      const updateStatement: SqlStatement = {
        sql: `
          UPDATE user_settings
          SET price_source_preference = ?, updated_at = ?, version = version + 1
          WHERE user_id = ? AND version = ?
          RETURNING user_id, home_currency_code, timezone,
            default_holding_currency_view, financial_year_start_month,
            price_source_preference, created_at, updated_at, version
        `,
        params: [
          input.priceSourcePreference,
          updatedAt,
          userId,
          input.expectedVersion,
        ],
      };
      // See the pre-state-guard note in `requestHomeCurrencyRebase` above:
      // the audit INSERT runs first, guarded on the batch's PRE-state
      // (version = expectedVersion), with the version-bumping UPDATE last.
      const rows = await client.batch([
        auditMutationStatement({
          actorUserId: userId,
          action: "settings.price_source_preference_change",
          targetType: "user_settings",
          targetId: userId,
          requestId,
          occurredAt: updatedAt,
          condition:
            "EXISTS (SELECT 1 FROM user_settings WHERE user_id = ? AND version = ?)",
          conditionParams: [userId, input.expectedVersion],
        }),
        updateStatement,
      ]);
      const row = rows[rows.length - 1]?.results[0];
      return row
        ? { ok: true, settings: createUserSettingsRecord(row) }
        : await resolveMutationFailure(client, "user_settings", userId, userId);
    },
  };
}
