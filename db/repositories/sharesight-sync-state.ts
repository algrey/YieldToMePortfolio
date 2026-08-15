import { randomUUID } from "node:crypto";
import { createConditionalAuditInsertStatement } from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

// BRK-004: minimal owner-scoped repository for the Sharesight sync cursor
// (`sharesight_sync_state` -- see `db/schema.ts`'s header comment on that
// table for why there is no token table). Deliberately minimal -- get/list/
// upsert only, version-guarded like every other owner-scoped
// single-row-per-key table in this repository layer (mirrors
// `dividends.ts`'s `createDividendAssumptionsRepository.saveSecurityAssumptions`
// guard-conditional-single-batch pattern: a surrogate `id` makes a
// re-select-and-compare-id check after the batch an authoritative signal
// for whether THIS call's own insert fired, so no more elaborate audit-first
// guard is needed here -- see that function's sibling
// `savePortfolioAssumptions` for why a table WITHOUT a surrogate id needs
// the more defensive variant instead). `BRK-005` extends this with the
// actual bounded/resumable sync-run machinery; this task only reserves the
// cursor shape.

export type SharesightSyncStateRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  sharesightPortfolioId: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastTradeWatermark: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type UpsertSharesightSyncStateInput = {
  enabled: boolean;
  lastSyncedAt: string | null;
  lastTradeWatermark: string | null;
  expectedVersion: number | null;
  requestId: string;
};

export type SharesightSyncStateMutationFailure = {
  ok: false;
  reason: "invalid_input" | "not_found" | "version_conflict" | "atomic_failure";
};

const SHARESIGHT_SYNC_STATE_COLUMNS = `
  id, user_id, portfolio_id, sharesight_portfolio_id, enabled,
  last_synced_at, last_trade_watermark, created_at, updated_at, version
`;

function mapSharesightSyncState(
  row: Record<string, unknown>,
): SharesightSyncStateRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    sharesightPortfolioId: String(row.sharesight_portfolio_id),
    enabled: Boolean(row.enabled),
    lastSyncedAt:
      row.last_synced_at === null ? null : String(row.last_synced_at),
    lastTradeWatermark:
      row.last_trade_watermark === null
        ? null
        : String(row.last_trade_watermark),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** `undefined`/`null` pass -- only a *present* value must be a non-empty
 * string, matching the `isNullable` convention in `dividends.ts`. */
function isNullableNonEmptyString(value: unknown): boolean {
  return value === null || value === undefined || nonEmptyString(value);
}

async function ownedPortfolio(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<boolean> {
  const row = await client.get<{ id: string }>(
    "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [portfolioId, userId],
  );
  return Boolean(row);
}

async function resolveMutationFailure(
  client: SqlClient,
  existsSql: string,
  params: readonly unknown[],
): Promise<SharesightSyncStateMutationFailure> {
  const row = await client.get<Record<string, unknown>>(existsSql, params);
  return row
    ? { ok: false, reason: "version_conflict" }
    : { ok: false, reason: "not_found" };
}

export function createSharesightSyncStateRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(
    userId: string,
    portfolioId: string,
    sharesightPortfolioId: string,
  ): Promise<SharesightSyncStateRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${SHARESIGHT_SYNC_STATE_COLUMNS}
       FROM sharesight_sync_state
       WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?
       LIMIT 1`,
      [userId, portfolioId, sharesightPortfolioId],
    );
    return row ? mapSharesightSyncState(row) : null;
  }

  async function list(
    userId: string,
    portfolioId: string,
  ): Promise<SharesightSyncStateRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${SHARESIGHT_SYNC_STATE_COLUMNS}
       FROM sharesight_sync_state
       WHERE user_id = ? AND portfolio_id = ?`,
      [userId, portfolioId],
    );
    return rows.map(mapSharesightSyncState);
  }

  async function upsert(
    userId: string,
    portfolioId: string,
    sharesightPortfolioId: string,
    input: UpsertSharesightSyncStateInput,
  ): Promise<
    | { ok: true; state: SharesightSyncStateRecord }
    | SharesightSyncStateMutationFailure
  > {
    if (!nonEmptyString(sharesightPortfolioId))
      return { ok: false, reason: "invalid_input" };
    if (
      !isNullableNonEmptyString(input.lastSyncedAt) ||
      !isNullableNonEmptyString(input.lastTradeWatermark)
    )
      return { ok: false, reason: "invalid_input" };
    if (!(await ownedPortfolio(client, userId, portfolioId)))
      return { ok: false, reason: "not_found" };

    const updatedAt = now();

    if (input.expectedVersion === null) {
      const id = randomUUID();
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO sharesight_sync_state (
            id, user_id, portfolio_id, sharesight_portfolio_id, enabled,
            last_synced_at, last_trade_watermark, created_at, updated_at,
            version
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM sharesight_sync_state
            WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?
          )`,
          params: [
            id,
            userId,
            portfolioId,
            sharesightPortfolioId,
            input.enabled ? 1 : 0,
            input.lastSyncedAt,
            input.lastTradeWatermark,
            updatedAt,
            updatedAt,
            userId,
            portfolioId,
            sharesightPortfolioId,
          ],
        },
        createConditionalAuditInsertStatement(
          {
            actorUserId: userId,
            targetOwnerUserId: userId,
            action: "broker_sync.sharesight.state.create",
            targetType: "sharesight_sync_state",
            // The row's own surrogate id, not `sharesightPortfolioId` --
            // the unique key is the 3-tuple (user, portfolio,
            // sharesight_portfolio_id), so two DIFFERENT local portfolios
            // connected to the SAME Sharesight portfolio would otherwise
            // produce audit events with an indistinguishable `target_id`
            // (review follow-up).
            targetId: id,
            requestId: input.requestId,
            result: "success",
            occurredAt: updatedAt,
          },
          "EXISTS (SELECT 1 FROM sharesight_sync_state WHERE id = ?)",
          [id],
          now,
        ),
      ];
      try {
        await client.batch(statements);
      } catch {
        return { ok: false, reason: "atomic_failure" };
      }
      const state = await get(userId, portfolioId, sharesightPortfolioId);
      return state && state.id === id
        ? { ok: true, state }
        : { ok: false, reason: "version_conflict" };
    }

    // Looked up ONCE, before the batch, purely to give the audit event the
    // row's own immutable surrogate id as `targetId` (review follow-up: the
    // unique key is the 3-tuple (user, portfolio, sharesight_portfolio_id),
    // so `sharesightPortfolioId` alone is not row-identifying -- two
    // DIFFERENT local portfolios connected to the SAME Sharesight portfolio
    // would otherwise produce indistinguishable audit events). This lookup
    // is never load-bearing for the version guard itself -- that guard is
    // still enforced, atomically, by the conditional audit INSERT's own
    // `EXISTS ... AND version = ?` predicate and the UPDATE's own
    // `WHERE ... AND version = ?` clause below, both evaluated at batch
    // execution time. A row's `id` never changes once created (no
    // delete/replace path exists for this table), so a version that has
    // since moved on between this lookup and the batch cannot make the
    // looked-up id stale or wrong -- it can only make the guarded
    // statements below no-op, which the version-conflict handling after the
    // batch already covers.
    const existing = await client.get<{ id: string }>(
      `SELECT id FROM sharesight_sync_state
       WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?
       LIMIT 1`,
      [userId, portfolioId, sharesightPortfolioId],
    );
    if (!existing) return { ok: false, reason: "not_found" };

    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "broker_sync.sharesight.state.update",
          targetType: "sharesight_sync_state",
          targetId: existing.id,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM sharesight_sync_state WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ? AND version = ?)",
        [userId, portfolioId, sharesightPortfolioId, input.expectedVersion],
        now,
      ),
      {
        sql: `UPDATE sharesight_sync_state SET
          enabled = ?, last_synced_at = ?, last_trade_watermark = ?,
          updated_at = ?, version = version + 1
        WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?
          AND version = ?
        RETURNING ${SHARESIGHT_SYNC_STATE_COLUMNS}`,
        params: [
          input.enabled ? 1 : 0,
          input.lastSyncedAt,
          input.lastTradeWatermark,
          updatedAt,
          userId,
          portfolioId,
          sharesightPortfolioId,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveMutationFailure(
        client,
        "SELECT id FROM sharesight_sync_state WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?",
        [userId, portfolioId, sharesightPortfolioId],
      );
    return { ok: true, state: mapSharesightSyncState(row) };
  }

  /**
   * BRK-005 review finding B4: `upsert` alone lets an owner end up with
   * MORE THAN ONE `enabled = true` row for the same local portfolio (e.g.
   * re-linking to a different Sharesight portfolio without ever disabling
   * the old link) -- `runSharesightSyncWithContext`'s
   * `links.find((candidate) => candidate.enabled)` then silently picks
   * whichever enabled row happens to come first in `list()`'s return order,
   * so a re-link can keep importing from the OLD Sharesight portfolio with
   * no visible error (reviewer repro). `linkExclusive` enforces a
   * single-active-link invariant: in the SAME atomic `client.batch()` call
   * as the target row's create/update, it disables every OTHER enabled row
   * for `(userId, portfolioId)`. Structurally near-identical to `upsert`
   * (duplicated rather than refactored to share code, so `upsert` itself --
   * used elsewhere for a non-exclusive touch, e.g. the sync watermark
   * update on an already-exclusive link -- stays exactly as tested).
   */
  async function linkExclusive(
    userId: string,
    portfolioId: string,
    sharesightPortfolioId: string,
    input: UpsertSharesightSyncStateInput,
  ): Promise<
    | { ok: true; state: SharesightSyncStateRecord }
    | SharesightSyncStateMutationFailure
  > {
    if (!nonEmptyString(sharesightPortfolioId))
      return { ok: false, reason: "invalid_input" };
    if (
      !isNullableNonEmptyString(input.lastSyncedAt) ||
      !isNullableNonEmptyString(input.lastTradeWatermark)
    )
      return { ok: false, reason: "invalid_input" };
    if (!(await ownedPortfolio(client, userId, portfolioId)))
      return { ok: false, reason: "not_found" };

    const updatedAt = now();
    const disableOthers: SqlStatement = {
      sql: `UPDATE sharesight_sync_state
        SET enabled = 0, updated_at = ?, version = version + 1
        WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id != ?
          AND enabled = 1`,
      params: [updatedAt, userId, portfolioId, sharesightPortfolioId],
    };

    if (input.expectedVersion === null) {
      const id = randomUUID();
      const statements: SqlStatement[] = [
        disableOthers,
        {
          sql: `INSERT INTO sharesight_sync_state (
            id, user_id, portfolio_id, sharesight_portfolio_id, enabled,
            last_synced_at, last_trade_watermark, created_at, updated_at,
            version
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM sharesight_sync_state
            WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?
          )`,
          params: [
            id,
            userId,
            portfolioId,
            sharesightPortfolioId,
            input.enabled ? 1 : 0,
            input.lastSyncedAt,
            input.lastTradeWatermark,
            updatedAt,
            updatedAt,
            userId,
            portfolioId,
            sharesightPortfolioId,
          ],
        },
        createConditionalAuditInsertStatement(
          {
            actorUserId: userId,
            targetOwnerUserId: userId,
            action: "broker_sync.sharesight.state.create",
            targetType: "sharesight_sync_state",
            targetId: id,
            requestId: input.requestId,
            result: "success",
            occurredAt: updatedAt,
          },
          "EXISTS (SELECT 1 FROM sharesight_sync_state WHERE id = ?)",
          [id],
          now,
        ),
      ];
      try {
        await client.batch(statements);
      } catch {
        return { ok: false, reason: "atomic_failure" };
      }
      const state = await get(userId, portfolioId, sharesightPortfolioId);
      return state && state.id === id
        ? { ok: true, state }
        : { ok: false, reason: "version_conflict" };
    }

    const existing = await client.get<{ id: string }>(
      `SELECT id FROM sharesight_sync_state
       WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?
       LIMIT 1`,
      [userId, portfolioId, sharesightPortfolioId],
    );
    if (!existing) return { ok: false, reason: "not_found" };

    const statements: SqlStatement[] = [
      disableOthers,
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "broker_sync.sharesight.state.update",
          targetType: "sharesight_sync_state",
          targetId: existing.id,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM sharesight_sync_state WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ? AND version = ?)",
        [userId, portfolioId, sharesightPortfolioId, input.expectedVersion],
        now,
      ),
      {
        sql: `UPDATE sharesight_sync_state SET
          enabled = ?, last_synced_at = ?, last_trade_watermark = ?,
          updated_at = ?, version = version + 1
        WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?
          AND version = ?
        RETURNING ${SHARESIGHT_SYNC_STATE_COLUMNS}`,
        params: [
          input.enabled ? 1 : 0,
          input.lastSyncedAt,
          input.lastTradeWatermark,
          updatedAt,
          userId,
          portfolioId,
          sharesightPortfolioId,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveMutationFailure(
        client,
        "SELECT id FROM sharesight_sync_state WHERE user_id = ? AND portfolio_id = ? AND sharesight_portfolio_id = ?",
        [userId, portfolioId, sharesightPortfolioId],
      );
    return { ok: true, state: mapSharesightSyncState(row) };
  }

  return { get, list, upsert, linkExclusive };
}
