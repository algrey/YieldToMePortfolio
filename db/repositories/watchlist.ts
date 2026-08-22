import { randomUUID } from "node:crypto";
import {
  createAuditInsertStatement,
  createConditionalAuditInsertStatement,
} from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

// ---------------------------------------------------------------------------
// WLT-001: the owner's watchlist repository -- USER-scoped (no portfolioId
// anywhere in this file), reads/writes only `watchlist_entries`. Records
// interest only; quote data is read separately by the caller via the SAME
// `selectPriceObservation`/`selectFxObservation` selection every other quote
// surface in this codebase uses (see `app/owned-watchlist.ts`) -- this
// repository never touches `price_observations`/`fx_rate_observations`.
// ---------------------------------------------------------------------------

export type WatchlistEntryKind = "security" | "currency_pair";

export type WatchlistEntryRecord = {
  id: string;
  userId: string;
  kind: WatchlistEntryKind;
  securityId: string | null;
  baseCurrencyCode: string | null;
  quoteCurrencyCode: string | null;
  displayOrder: number;
  createdAt: string;
  version: number;
};

export type WatchlistMutationFailure = {
  ok: false;
  reason: "not_found" | "invalid_input" | "conflict" | "atomic_failure";
};

export type WatchlistEntryResult =
  { ok: true; entry: WatchlistEntryRecord } | WatchlistMutationFailure;

export type ReorderWatchlistResult =
  { ok: true; entries: WatchlistEntryRecord[] } | WatchlistMutationFailure;

const ENTRY_COLUMNS = `
  id, user_id, kind, security_id, base_currency_code, quote_currency_code,
  display_order, created_at, version
`;

function mapEntry(row: Record<string, unknown>): WatchlistEntryRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: String(row.kind) as WatchlistEntryKind,
    securityId: row.security_id === null ? null : String(row.security_id),
    baseCurrencyCode:
      row.base_currency_code === null ? null : String(row.base_currency_code),
    quoteCurrencyCode:
      row.quote_currency_code === null ? null : String(row.quote_currency_code),
    displayOrder: Number(row.display_order),
    createdAt: String(row.created_at),
    version: Number(row.version),
  };
}

export function createOwnedWatchlistRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function list(userId: string): Promise<WatchlistEntryRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${ENTRY_COLUMNS} FROM watchlist_entries
       WHERE user_id = ? ORDER BY display_order, created_at, id`,
      [userId],
    );
    return rows.map(mapEntry);
  }

  async function nextDisplayOrder(userId: string): Promise<number> {
    const row = await client.get<{ next: number | null }>(
      `SELECT MAX(display_order) AS next FROM watchlist_entries WHERE user_id = ?`,
      [userId],
    );
    return (row?.next ?? -1) + 1;
  }

  async function getBySecurity(
    userId: string,
    securityId: string,
  ): Promise<WatchlistEntryRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${ENTRY_COLUMNS} FROM watchlist_entries
       WHERE user_id = ? AND kind = 'security' AND security_id = ? LIMIT 1`,
      [userId, securityId],
    );
    return row ? mapEntry(row) : null;
  }

  async function getByPair(
    userId: string,
    baseCurrencyCode: string,
    quoteCurrencyCode: string,
  ): Promise<WatchlistEntryRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${ENTRY_COLUMNS} FROM watchlist_entries
       WHERE user_id = ? AND kind = 'currency_pair'
         AND base_currency_code = ? AND quote_currency_code = ? LIMIT 1`,
      [userId, baseCurrencyCode, quoteCurrencyCode],
    );
    return row ? mapEntry(row) : null;
  }

  /**
   * Adds a security to the watchlist -- idempotent: if this exact
   * (user, security) pair is already watched (the partial unique index
   * `watchlist_entries_user_security_unique`), the pre-existing row is
   * returned as success rather than a conflict, mirroring
   * `db/repositories/dividends.ts`'s idempotency-key create pattern.
   */
  async function addSecurity(
    userId: string,
    securityId: string,
    requestId: string,
  ): Promise<WatchlistEntryResult> {
    const security = await client.get<{ id: string }>(
      `SELECT id FROM securities WHERE id = ? LIMIT 1`,
      [securityId],
    );
    if (!security) return { ok: false, reason: "not_found" };

    const id = randomUUID();
    const createdAt = now();
    const displayOrder = await nextDisplayOrder(userId);
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO watchlist_entries (
                id, user_id, kind, security_id, display_order, created_at, version
              )
              SELECT ?, ?, 'security', ?, ?, ?, 1
              WHERE NOT EXISTS (
                SELECT 1 FROM watchlist_entries
                WHERE user_id = ? AND kind = 'security' AND security_id = ?
              )`,
        params: [
          id,
          userId,
          securityId,
          displayOrder,
          createdAt,
          userId,
          securityId,
        ],
      },
      // WLT-001 review (B5, BLOCKING): condition on `id = ? AND user_id = ?`
      // -- the FRESHLY GENERATED `id` this attempt tried to insert -- never
      // on the business key (`kind`/`security_id`) alone, mirroring
      // `db/repositories/dividends.ts`'s `dividend_receipt.create` audit
      // guard precedent exactly. A business-key guard is true whenever ANY
      // matching row exists, including one this call's own `WHERE NOT
      // EXISTS` guard just suppressed (the idempotent "already watching"
      // no-op) -- that spuriously wrote a "success" audit row for an insert
      // that never happened. `id` is a fresh UUID no prior row could ever
      // coincidentally hold, so this EXISTS check is true if and only if
      // THIS statement's own insert actually ran.
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "watchlist.add_security",
          targetType: "watchlist_entry",
          targetId: id,
          requestId,
          result: "success",
          occurredAt: createdAt,
        },
        "EXISTS (SELECT 1 FROM watchlist_entries WHERE id = ? AND user_id = ?)",
        [id, userId],
        now,
      ),
    ];
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const entry = await getBySecurity(userId, securityId);
    return entry
      ? { ok: true, entry }
      : { ok: false, reason: "atomic_failure" };
  }

  /**
   * Adds a currency pair to the watchlist -- idempotent, same shape as
   * `addSecurity` above.
   */
  async function addCurrencyPair(
    userId: string,
    baseCurrencyCode: string,
    quoteCurrencyCode: string,
    requestId: string,
  ): Promise<WatchlistEntryResult> {
    if (baseCurrencyCode === quoteCurrencyCode) {
      return { ok: false, reason: "invalid_input" };
    }
    const [base, quote] = await Promise.all([
      client.get<{ code: string }>(
        `SELECT code FROM currencies WHERE code = ? LIMIT 1`,
        [baseCurrencyCode],
      ),
      client.get<{ code: string }>(
        `SELECT code FROM currencies WHERE code = ? LIMIT 1`,
        [quoteCurrencyCode],
      ),
    ]);
    if (!base || !quote) return { ok: false, reason: "not_found" };

    const id = randomUUID();
    const createdAt = now();
    const displayOrder = await nextDisplayOrder(userId);
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO watchlist_entries (
                id, user_id, kind, base_currency_code, quote_currency_code,
                display_order, created_at, version
              )
              SELECT ?, ?, 'currency_pair', ?, ?, ?, ?, 1
              WHERE NOT EXISTS (
                SELECT 1 FROM watchlist_entries
                WHERE user_id = ? AND kind = 'currency_pair'
                  AND base_currency_code = ? AND quote_currency_code = ?
              )`,
        params: [
          id,
          userId,
          baseCurrencyCode,
          quoteCurrencyCode,
          displayOrder,
          createdAt,
          userId,
          baseCurrencyCode,
          quoteCurrencyCode,
        ],
      },
      // WLT-001 review (B5, BLOCKING): same `id`-precise guard as
      // `addSecurity` above -- see its comment for why a business-key
      // condition would spuriously audit an idempotent no-op insert.
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "watchlist.add_currency_pair",
          targetType: "watchlist_entry",
          targetId: id,
          requestId,
          result: "success",
          occurredAt: createdAt,
        },
        "EXISTS (SELECT 1 FROM watchlist_entries WHERE id = ? AND user_id = ?)",
        [id, userId],
        now,
      ),
    ];
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const entry = await getByPair(userId, baseCurrencyCode, quoteCurrencyCode);
    return entry
      ? { ok: true, entry }
      : { ok: false, reason: "atomic_failure" };
  }

  /**
   * Removes one entry -- version-guarded (optimistic concurrency, matching
   * every other owner-scoped mutation in this codebase). A row that no
   * longer exists (already removed) or whose version has moved on resolves
   * to `not_found`; the caller treats a repeat removal as a benign
   * idempotent outcome, never a hard error.
   */
  async function remove(
    userId: string,
    id: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<{ ok: true } | WatchlistMutationFailure> {
    const occurredAt = now();
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "watchlist.remove",
          targetType: "watchlist_entry",
          targetId: id,
          requestId,
          result: "success",
          occurredAt,
        },
        "EXISTS (SELECT 1 FROM watchlist_entries WHERE id = ? AND user_id = ? AND version = ?)",
        [id, userId, expectedVersion],
        now,
      ),
      {
        sql: `DELETE FROM watchlist_entries WHERE id = ? AND user_id = ? AND version = ?
              RETURNING id`,
        params: [id, userId, expectedVersion],
      },
    ];
    const rows = await client.batch(statements);
    const deleted = rows[rows.length - 1]?.results[0];
    if (!deleted) {
      const existing = await client.get<{ id: string }>(
        `SELECT id FROM watchlist_entries WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      return { ok: false, reason: existing ? "conflict" : "not_found" };
    }
    return { ok: true };
  }

  /**
   * Reorders the whole watchlist in one atomic batch. `orderedIds` must be
   * exactly the owner's current full set of entry ids (order-independent
   * set equality checked first) -- this is the concurrency guard (a stale
   * client whose view missed a concurrent add/remove is rejected as
   * `conflict` rather than silently dropping or duplicating a row) in place
   * of a per-row version, since reordering touches every row at once.
   * Submitting the SAME order twice is a safe no-op re-application
   * (idempotent), consistent with `addSecurity`/`addCurrencyPair` above.
   */
  async function reorder(
    userId: string,
    orderedIds: readonly string[],
    requestId: string,
  ): Promise<ReorderWatchlistResult> {
    if (
      orderedIds.length === 0 ||
      new Set(orderedIds).size !== orderedIds.length
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    const current = await list(userId);
    const currentIds = new Set(current.map((entry) => entry.id));
    if (
      orderedIds.length !== current.length ||
      !orderedIds.every((id) => currentIds.has(id))
    ) {
      return { ok: false, reason: "conflict" };
    }
    const occurredAt = now();
    const statements: SqlStatement[] = orderedIds.map((id, index) => ({
      sql: `UPDATE watchlist_entries SET display_order = ?, version = version + 1
            WHERE id = ? AND user_id = ?`,
      params: [index, id, userId],
    }));
    statements.push(
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "watchlist.reorder",
          targetType: "watchlist_entries",
          targetId: null,
          requestId,
          result: "success",
          occurredAt,
          metadata: { count: orderedIds.length },
        },
        now,
      ),
    );
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    return { ok: true, entries: await list(userId) };
  }

  return {
    list,
    addSecurity,
    addCurrencyPair,
    remove,
    reorder,
  };
}

export type WatchlistRepository = ReturnType<
  typeof createOwnedWatchlistRepository
>;
