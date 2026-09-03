import type { SqlStatement } from "../db/repositories/sql-client.ts";

// PRF-015: `app/import-actions.ts`'s `loadReview` cannot be imported by this
// repo's plain Node test runner (`getAuthenticatedSqlContext` pulls in
// `next/headers` transitively), so `tests/imp-004a.test.ts` kept a hand-typed
// `pagePreview` mirror of `loadReview`'s query batch. That mirror drifted
// from production THREE times in one day -- PRF-009 rounds 1-3 (a stray
// `LIMIT` and a cap the production query no longer had) and, discovered
// while fixing this task, a missed BUG-018 `AND status <> 'reversed'`
// predicate and a missed BRK-009C `canonical_name` LEFT JOIN column -- so the
// DIV-016C/BUG-013/BUG-018 suites were exercising a shape production did not
// have. Every query `loadReview` mirrors is extracted here, into a plain
// module with no `next/headers` dependency, so `loadReview` and the test's
// `pagePreview`/`currentPreviewVersion` helpers import the SAME function and
// can no longer diverge by construction. Each function returns the query's
// `sql`/`params` only -- consuming the rows (mapping, capping, degrading) is
// still each caller's own responsibility and stays where it was.

/** `loadReview`'s security-candidate read: every `portfolio_securities` row
 * this owner has, widened by a `securities.canonical_name` LEFT JOIN column
 * (BRK-009C) for the "Review securities" summary's Name column. */
export function portfolioSecurityCandidatesQuery(userId: string): SqlStatement {
  return {
    sql: `SELECT ps.id, ps.portfolio_id, ps.source_symbol, ps.source_exchange_alias,
        ps.source_currency_code, ps.security_id, s.canonical_name
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       WHERE ps.user_id = ?
       ORDER BY ps.source_symbol ASC, ps.id ASC`,
    params: [userId],
  };
}

/** BUG-013: `dividend_manual_records` widened OFF `import_batch_id IS NULL`
 * (that filter was the confirmed root cause of a silent cross-route
 * dividend double-commit -- see `app/import-actions.ts`'s `loadReview` for
 * the full history), carrying the amount/franking/currency columns
 * `DIVIDEND_MATCHES_EXISTING_ENTRY` (`domain/imports/reconciliation.ts`)
 * needs, excluding a superseded (historical) row. Bounded at `limit` rows
 * (the caller passes `MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK +
 * 1`) so the caller's `capExistingDividendRows` can detect overflow exactly. */
export function existingManualDividendRowsQuery(
  userId: string,
  limit: number,
): SqlStatement {
  return {
    sql: `SELECT portfolio_security_id, payment_date, shares_decimal,
              dividend_per_share_decimal, franking_credit_per_share_decimal,
              total_cash_decimal, total_franking_decimal, currency_code
       FROM dividend_manual_records
       WHERE user_id = ? AND superseded_by_record_id IS NULL
       LIMIT ?`,
    params: [userId, limit],
  };
}

/** BUG-013: `dividend_receipts` (a provider-observed fact, no
 * `import_batch_id`/route concept) feeds only DIV-004's payment-date-
 * proximity check. Bounded the same way as the manual-records query above --
 * both feed the same combined, capped `existingDividendEntries` array. */
export function existingReceiptDividendRowsQuery(
  userId: string,
  limit: number,
): SqlStatement {
  return {
    sql: `SELECT portfolio_security_id, payment_date FROM dividend_receipts
       WHERE user_id = ?
       LIMIT ?`,
    params: [userId, limit],
  };
}

/** PRF-009 correction round B1: every dividend row already imported (any
 * prior batch) by this owner, keyed by `(portfolio_id, source_reference)`.
 * This is DIV-016C's COMPARISON set, not a pure suppression set --
 * `createImportReconciliationPreview` (`domain/imports/reconciliation.ts`)
 * uses membership to split the matching pool into `freshRows`/
 * `alreadyImportedRows`, so it is DELIBERATELY left UNBOUNDED (no `LIMIT`,
 * never routed through `capSuppressionReferenceRows`) -- a fail-open
 * collapse to empty would put a genuinely dedupe-bound row back into
 * `freshRows` and earn it a false `DIVIDEND_RECONCILIATION_PROPOSED`. */
export function existingDividendSourceReferenceRowsQuery(
  userId: string,
): SqlStatement {
  return {
    sql: `SELECT portfolio_id, source_reference FROM dividend_manual_records
       WHERE user_id = ? AND source_reference IS NOT NULL`,
    params: [userId],
  };
}

/** BUG-013 review round (ruling 1): the trade analog of the dividend
 * suppression set -- every existing `transactions.source_reference` this
 * owner has, used to suppress `TRADE_NEAR_EXISTING_ENTRY` for a row already
 * bound for an identical commit-time exact-match skip
 * (`source_type = 'csv_import'`, reproduced exactly from
 * `db/repositories/import-commit.ts`'s own dedupe check).
 *
 * BUG-018: `status <> 'reversed'` matches the commit-time lookup's own
 * predicate -- a reversed row no longer occupies the `source_reference` key,
 * so this suppression set must stop treating a reversed row as "will be
 * skipped" too. Unlike a comparison set, truncating this pure SUPPRESSION
 * set can only ever ADD noise, never hide a duplicate, so it fails OPEN
 * (bounded at `limit`, the caller's `capSuppressionReferenceRows` degrades
 * overflow to an empty set). */
export function existingTradeSourceReferenceRowsQuery(
  userId: string,
  limit: number,
): SqlStatement {
  return {
    sql: `SELECT portfolio_id, source_reference FROM transactions
       WHERE user_id = ? AND source_type = 'csv_import' AND source_reference IS NOT NULL
         AND status <> 'reversed'
       LIMIT ?`,
    params: [userId, limit],
  };
}

/** BUG-011: every existing POSTED buy/sell transaction across the whole
 * owner (any portfolio, any source route, any prior batch/import), for the
 * preview-time cross-route duplicate-trade warning. `+reverses_transaction_id
 * IS NULL` excludes a reversal's compensating mirror row (F1) using SQLite's
 * unary-plus no-index hint (PRF-009 fold-in (a)) to keep the planner on the
 * `user_id` seek instead of the `reverses_transaction_id` unique index's
 * NULL group, which spans every owner. Bounded at `limit` so the caller's
 * `capExistingTradeRows` can detect overflow exactly (F2). */
export function existingTradeRowsQuery(
  userId: string,
  limit: number,
): SqlStatement {
  return {
    sql: `SELECT portfolio_security_id, type, local_trade_date,
              quantity_decimal, unit_price_decimal
       FROM transactions
       WHERE user_id = ? AND status = 'posted'
         AND type IN ('buy', 'sell') AND +reverses_transaction_id IS NULL
         AND portfolio_security_id IS NOT NULL
         AND quantity_decimal IS NOT NULL AND unit_price_decimal IS NOT NULL
       LIMIT ?`,
    params: [userId, limit],
  };
}
