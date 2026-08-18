import { randomUUID } from "node:crypto";
import { createAuditInsertStatement } from "../db/repositories/audit.ts";
import {
  createOwnedImportStagingRepository,
  createOwnedSecurityResolutionRepository,
  type SqlClient,
} from "../db/repositories/index.ts";
import type { SqlStatement } from "../db/repositories/sql-client.ts";
import { SHARESIGHT_SYNC_PARSER_FORMAT } from "../domain/sharesight-sync/index.ts";

// BRK-009B: the explicit server-side "resolve securities" pass for
// `sharesight_sync` batches -- runs automatically as part of the sync action
// right after staging (`app/sharesight-sync-service.ts`), and again,
// idempotently, as the first step of the atomic accept action
// (`app/import-accept-service.ts`) so an already-staged batch (synced before
// this feature shipped, or one whose sync-time pass only partially
// completed) still resolves before the owner accepts it. Deliberately NOT
// invoked from preview rendering (`app/import-preview.ts`) -- resolution is
// always an explicit write step, never a side effect of reading a preview.
// CSV batches are entirely out of scope (`parserFormat !== "sharesight_sync"`
// short-circuits to a no-op below) -- they keep the pre-existing owner-driven
// candidate/verify/attest/skip flow completely unchanged (BRK-009B ruling).
export type ResolveSharesightSecuritiesContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

export type ResolveSharesightSecuritiesOptions = {
  now?: () => string;
};

export type ResolveSharesightSecuritiesResult =
  | {
      ok: true;
      /** Distinct instruments already linked before this pass ran, or
       * matched to an existing security by this pass (any tier, including
       * the same-user fallback). */
      resolvedCount: number;
      /** Distinct instruments auto-created from Sharesight metadata by this
       * pass. */
      createdCount: number;
      /** Distinct instruments whose resolution produced a genuine conflict
       * (or an unrecognized currency / concurrent-update race) -- staged as
       * a blocking `SECURITY_RESOLUTION_CONFLICT` issue on every row that
       * references the instrument. */
      conflictCount: number;
    }
  | { ok: false; status: 404; message: string };

type NormalizedRowGroup = {
  symbol: string;
  exchange: string | null;
  currency: string;
  sharesightInstrumentId: string | null;
  instrumentName: string | null;
  isin: string | null;
  rows: { id: string; physicalRowNumber: number }[];
  // BRK-010: true until a non-dividend row is seen in this group -- a group
  // is symbol+exchange+currency, so a security's AUD trades and USD payouts
  // naturally land in DIFFERENT groups (different currency) and this stays
  // true for the payout-only group, false for the trade group. See
  // `db/repositories/security-resolution.ts`'s `SecurityResolutionCandidateIdentity.rowClass`
  // doc comment for why this matters: only a group whose rows are ALL
  // dividend/payout rows is exempt from the strict currency-agreement rule.
  allDividendRows: boolean;
};

function groupKey(
  symbol: string,
  exchange: string | null,
  currency: string,
): string {
  return [
    symbol.trim().toUpperCase(),
    (exchange ?? "").trim().toUpperCase(),
    currency.trim().toUpperCase(),
  ].join("|");
}

/** F1 (BRK-009B review): clears this service's OWN previously-staged,
 * still-unresolved `SECURITY_RESOLUTION_CONFLICT` issues for `rowIds` when a
 * re-run's resolution for the SAME instrument now succeeds -- narrowly
 * scoped to that exact code, batch, and row set (this service is the only
 * writer of that code, so nothing else's issues are ever touched). Returns
 * the number of issues actually cleared so the caller can decide whether an
 * audit event is warranted. */
async function markConflictIssuesResolved(
  client: SqlClient,
  userId: string,
  batchId: string,
  rowIds: readonly string[],
  resolvedAt: string,
  resolvedByUserId: string,
): Promise<number> {
  if (rowIds.length === 0) return 0;
  const placeholders = rowIds.map(() => "?").join(", ");
  const result = await client.run(
    `UPDATE import_issues
        SET resolved_at = ?, resolved_by_user_id = ?, resolved_value = 'auto_resolved_by_rerun',
            updated_at = ?, version = version + 1
      WHERE user_id = ? AND batch_id = ? AND row_id IN (${placeholders})
        AND code = 'SECURITY_RESOLUTION_CONFLICT' AND resolved_at IS NULL`,
    [resolvedAt, resolvedByUserId, resolvedAt, userId, batchId, ...rowIds],
  );
  return result.changes;
}

/** One guarded `import_issues` insert for the new `SECURITY_RESOLUTION_CONFLICT`
 * code (BRK-009B) -- idempotent (skips if an unresolved copy already exists
 * for this row) and ownership-scoped, mirroring the shape
 * `db/repositories/import-staging.ts`'s own `issueInsertStatement` writes at
 * parse time, but re-runnable at any later batch status (resolution runs
 * well after the batch leaves `uploaded`) rather than only at upload time. */
function conflictIssueStatement(
  userId: string,
  batchId: string,
  rowId: string,
  physicalRowNumber: number,
  message: string,
  createdAt: string,
): SqlStatement {
  return {
    sql: `
      INSERT INTO import_issues (
        id, user_id, batch_id, row_id, physical_row_number, field, severity,
        code, message, suggested_resolution_type, resolved_value,
        resolved_by_user_id, resolved_at, created_at, updated_at, version
      )
      SELECT ?, ?, ?, ?, ?, NULL, 'error', 'SECURITY_RESOLUTION_CONFLICT', ?, NULL, NULL, NULL, NULL, ?, ?, 1
      WHERE EXISTS (
              SELECT 1 FROM import_rows WHERE id = ? AND user_id = ? AND batch_id = ?
            )
        AND NOT EXISTS (
              SELECT 1 FROM import_issues
              WHERE batch_id = ? AND user_id = ? AND row_id = ?
                AND code = 'SECURITY_RESOLUTION_CONFLICT' AND resolved_at IS NULL
            )
    `,
    params: [
      randomUUID(),
      userId,
      batchId,
      rowId,
      physicalRowNumber,
      message,
      createdAt,
      createdAt,
      rowId,
      userId,
      batchId,
      batchId,
      userId,
      rowId,
    ],
  };
}

export async function resolveSharesightBatchSecuritiesWithContext(
  context: ResolveSharesightSecuritiesContext,
  batchId: string,
  options: ResolveSharesightSecuritiesOptions = {},
): Promise<ResolveSharesightSecuritiesResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch) {
    return { ok: false, status: 404, message: "Import batch not found." };
  }
  // Scope: sharesight_sync batches ONLY -- see this module's header comment.
  if (
    batch.parserFormat !== SHARESIGHT_SYNC_PARSER_FORMAT ||
    batch.targetPortfolioId === null
  ) {
    return { ok: true, resolvedCount: 0, createdCount: 0, conflictCount: 0 };
  }

  const rows = await staging.listRows(context.userId, batchId);
  const groups = new Map<string, NormalizedRowGroup>();
  for (const row of rows) {
    if (row.rowClass !== "transaction") continue;
    const normalized = row.normalizedFields;
    const symbol = normalized?.symbol ?? null;
    const currency = normalized?.currency ?? null;
    if (!symbol || !currency) continue;
    const exchange = normalized?.exchange ?? null;
    const key = groupKey(symbol, exchange, currency);
    let group = groups.get(key);
    if (!group) {
      group = {
        symbol,
        exchange,
        currency,
        sharesightInstrumentId: null,
        instrumentName: null,
        isin: null,
        rows: [],
        allDividendRows: true,
      };
      groups.set(key, group);
    }
    group.rows.push({ id: row.id, physicalRowNumber: row.physicalRowNumber });
    if (normalized?.type !== "dividend") {
      group.allDividendRows = false;
    }
    if (
      group.sharesightInstrumentId === null &&
      normalized?.sharesightInstrumentId
    ) {
      group.sharesightInstrumentId = normalized.sharesightInstrumentId;
    }
    if (group.instrumentName === null && normalized?.instrumentName) {
      group.instrumentName = normalized.instrumentName;
    }
    if (group.isin === null && normalized?.isin) {
      group.isin = normalized.isin;
    }
  }

  const repository = createOwnedSecurityResolutionRepository(
    context.client,
    now,
  );
  let resolvedCount = 0;
  let createdCount = 0;
  let conflictCount = 0;
  const nowIso = now();

  for (const group of groups.values()) {
    const candidate = {
      portfolioId: batch.targetPortfolioId,
      sourceSymbol: group.symbol,
      sourceExchangeAlias: group.exchange,
      sourceCurrencyCode: group.currency,
    };
    const result = await repository.resolveAndLink(
      context.userId,
      {
        symbol: group.symbol,
        exchangeAlias: group.exchange,
        currencyCode: group.currency,
        sharesightInstrumentId: group.sharesightInstrumentId,
        isin: group.isin,
        instrumentName: group.instrumentName,
        // BRK-010: exempts this candidate from the strict currency-agreement
        // rule when (and only when) EVERY row in this symbol+exchange+
        // currency group is a payout/dividend row -- see
        // `NormalizedRowGroup.allDividendRows`'s doc comment.
        rowClass: group.allDividendRows ? "dividend" : "trade",
      },
      candidate,
    );

    if (result.ok) {
      if (result.outcome === "already_resolved") {
        resolvedCount += 1;
      } else {
        if (result.outcome === "created") createdCount += 1;
        else resolvedCount += 1;
        // Owner-attributed audit event per created/linked security (BRK-009B
        // ruling) -- best-effort, matching `security-attestation-service.ts`'s
        // identical precedent (an audit write failure must never undo an
        // already-committed resolution/link).
        try {
          const auditStatement = createAuditInsertStatement(
            {
              actorUserId: context.userId,
              targetOwnerUserId: context.userId,
              action: "sharesight.security.auto_resolve",
              targetType: "import_batch",
              targetId: batchId,
              requestId: context.requestId,
              result: "success",
              metadata: {
                portfolioId: candidate.portfolioId,
                sourceSymbol: candidate.sourceSymbol,
                sourceExchangeAlias: candidate.sourceExchangeAlias,
                sourceCurrencyCode: candidate.sourceCurrencyCode,
                securityId: result.securityId,
                portfolioSecurityId: result.portfolioSecurityId,
                created: result.created,
                tier: result.tier,
              },
            },
            now,
          );
          await context.client.run(auditStatement.sql, auditStatement.params);
        } catch {
          // See comment above -- never fails the already-committed resolution.
        }
      }
      // F1 (BRK-009B review): this instrument resolved successfully on this
      // pass -- clear any of ITS rows' previously-staged, still-unresolved
      // `SECURITY_RESOLUTION_CONFLICT` issues (a stale block from an earlier
      // pass whose disagreement no longer reproduces), auditing the
      // resolution. Best-effort: never fails an already-committed
      // resolution over a housekeeping write.
      try {
        const rowIds = group.rows.map((row) => row.id);
        const cleared = await markConflictIssuesResolved(
          context.client,
          context.userId,
          batchId,
          rowIds,
          nowIso,
          context.userId,
        );
        if (cleared > 0) {
          const clearedAuditStatement = createAuditInsertStatement(
            {
              actorUserId: context.userId,
              targetOwnerUserId: context.userId,
              action: "sharesight.security.conflict_resolved",
              targetType: "import_batch",
              targetId: batchId,
              requestId: context.requestId,
              result: "success",
              metadata: {
                portfolioId: candidate.portfolioId,
                sourceSymbol: candidate.sourceSymbol,
                sourceExchangeAlias: candidate.sourceExchangeAlias,
                sourceCurrencyCode: candidate.sourceCurrencyCode,
                clearedIssueCount: cleared,
              },
            },
            now,
          );
          await context.client.run(
            clearedAuditStatement.sql,
            clearedAuditStatement.params,
          );
        }
      } catch {
        // Best-effort -- see comment above.
      }
      continue;
    }

    conflictCount += 1;
    // F1 (BRK-009B review): describe the real unblock path -- fix the
    // underlying disagreement (or the unrecognized currency) upstream in
    // Sharesight/the owner's own data, then re-run the sync or accept
    // (which re-runs this pass and clears the issue automatically once the
    // disagreement no longer reproduces), or exclude the affected rows
    // (IMP-008) to commit the rest of the batch in the meantime.
    const message =
      result.reason === "conflict"
        ? `Sharesight instrument "${group.symbol}" resolved to more than one existing security (tiers: ${result.tiers.join(", ")}) -- fix the underlying disagreement (the conflicting security's currency or exchange evidence), then re-run the sync or accept to clear this automatically, or exclude these rows to commit the rest of the batch in the meantime.`
        : result.reason === "invalid_currency"
          ? `Sharesight instrument "${group.symbol}" reports a currency code this app does not recognize -- fix the currency in Sharesight, then re-run the sync or accept to clear this automatically, or exclude these rows to commit the rest of the batch in the meantime.`
          : `Sharesight instrument "${group.symbol}" could not be resolved because of a concurrent write -- re-run the sync or accept to retry (this often clears itself automatically), or exclude these rows to commit the rest of the batch in the meantime.`;
    try {
      await context.client.batch(
        group.rows.map((row) =>
          conflictIssueStatement(
            context.userId,
            batchId,
            row.id,
            row.physicalRowNumber,
            message,
            nowIso,
          ),
        ),
      );
    } catch {
      // Best-effort -- an idempotent re-run of this pass retries the same
      // guarded insert; never lets a persisted-issue write failure surface
      // as a hard error for the whole batch.
    }
  }

  return { ok: true, resolvedCount, createdCount, conflictCount };
}
