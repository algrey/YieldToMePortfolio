import { randomUUID } from "node:crypto";
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "../../domain/calculations/decimal.ts";
import { createAuditInsertStatement } from "./audit.ts";
import {
  consumeManualLedgerMutationKeyStatement,
  type LedgerMutationAuthorization,
} from "./manual-ledger-keys.ts";
import {
  unresolvableValueHistoryClearFromDateStatement,
  valueHistoryInvalidationFromDateStatement,
} from "./portfolio-value-history.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import {
  prepareLedgerPosting,
  type LedgerPostingInput,
  type PreparedLedgerPosting,
} from "../../domain/ledger/posting.ts";

export type LedgerTransactionRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string | null;
  type: string;
  status: string;
  tradeAt: string;
  localTradeDate: string;
  settlementDate: string | null;
  quantityDecimal: string | null;
  unitPriceDecimal: string | null;
  currencyCode: string;
  grossAmountDecimal: string | null;
  feeAmountDecimal: string;
  taxAmountDecimal: string;
  fxRateToBaseDecimal: string | null;
  fxRateSource: string | null;
  fxObservedAt: string | null;
  sourceType: string;
  sourceReference: string | null;
  idempotencyKey: string | null;
  importRowId: string | null;
  reversesTransactionId: string | null;
  supersedesTransactionId: string | null;
  createdByUserId: string;
  calculationVersion: number;
  createdAt: string;
  version: number;
};

export type CashLedgerEntryRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  cashAccountId: string;
  transactionId: string | null;
  effectiveAt: string;
  localEffectiveDate: string;
  type: string;
  signedAmountDecimal: string;
  status: string;
  reversesEntryId: string | null;
  createdAt: string;
};

export type LedgerMutationFailure = {
  ok: false;
  reason:
    | "not_found"
    | "invalid_input"
    | "conflict"
    | "gross_mismatch"
    | "invalid_date"
    | "invalid_source"
    | "cash_effect_invalid"
    | "oversell"
    | "inventory_limit"
    | "concurrent_change"
    | "atomic_failure";
};

export type LedgerMutationSuccess = {
  ok: true;
  transaction: LedgerTransactionRecord;
  cashEntry: CashLedgerEntryRecord | null;
  calculationRunId: string;
  idempotent: boolean;
};

export type LedgerMutationResult =
  LedgerMutationSuccess | LedgerMutationFailure;

type InternalLedgerInput = LedgerPostingInput & {
  importRowId?: string | null;
  reversesTransactionId?: string | null;
  supersedesTransactionId?: string | null;
  status?: "posted";
  reversalEntryId?: string | null;
};

export type LedgerPostingPersistenceInput = LedgerPostingInput & {
  importRowId?: string | null;
  reversesTransactionId?: string | null;
  supersedesTransactionId?: string | null;
  reversalEntryId?: string | null;
};

export type LedgerPostingStatements = {
  statements: SqlStatement[];
  transactionId: string;
  calculationRunId: string;
};

export const LEDGER_INVENTORY_LIMITS = {
  pageSize: 500,
  maxPages: 12,
  maxEvents: 6_000,
  retryAttempts: 2,
} as const;

type InventorySnapshot = Readonly<{
  portfolioSecurityId: string;
  transactionCount: number;
  versionTotal: number;
}>;

type InventoryEvent = Readonly<{
  id: string;
  type: "buy" | "sell" | "split";
  tradeAt: string;
  quantityDecimal: string;
  unitPriceDecimal: string | null;
}>;

type InventoryPlan = Readonly<{
  snapshot: InventorySnapshot;
}>;

function inventoryEventFromInput(
  id: string,
  input: InternalLedgerInput,
): InventoryEvent | null {
  if (
    input.portfolioSecurityId === null ||
    (input.type !== "buy" && input.type !== "sell" && input.type !== "split") ||
    input.quantityDecimal === null
  ) {
    return null;
  }
  return {
    id,
    type: input.type,
    tradeAt: input.tradeAt,
    quantityDecimal: input.quantityDecimal,
    unitPriceDecimal: input.unitPriceDecimal,
  };
}

function applyInventoryEvent(
  quantity: DecimalFraction,
  event: InventoryEvent,
): { ok: true; quantity: DecimalFraction } | LedgerMutationFailure {
  try {
    const eventQuantity = parseDecimal(event.quantityDecimal);
    if (event.type === "buy") {
      return { ok: true, quantity: addDecimal(quantity, eventQuantity) };
    }
    if (event.type === "sell") {
      const remaining = subtractDecimal(quantity, eventQuantity);
      return compareDecimal(remaining, parseDecimal("0")) < 0
        ? { ok: false, reason: "oversell" }
        : { ok: true, quantity: remaining };
    }
    if (event.unitPriceDecimal === null) {
      return { ok: false, reason: "invalid_input" };
    }
    const denominator = parseDecimal(event.unitPriceDecimal);
    if (
      compareDecimal(eventQuantity, parseDecimal("0")) <= 0 ||
      compareDecimal(denominator, parseDecimal("0")) <= 0
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    return {
      ok: true,
      quantity: roundDecimal(
        divideDecimal(multiplyDecimal(quantity, eventQuantity), denominator),
        18,
      ),
    };
  } catch {
    return { ok: false, reason: "invalid_input" };
  }
}

const TRANSACTION_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at,
  local_trade_date, settlement_date, quantity_decimal, unit_price_decimal,
  currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal,
  fx_rate_to_base_decimal, fx_rate_source, fx_observed_at, source_type,
  source_reference, idempotency_key, import_row_id, reverses_transaction_id,
  supersedes_transaction_id, created_by_user_id, calculation_version,
  created_at, version
`;

function mapTransaction(row: Record<string, unknown>): LedgerTransactionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    portfolioSecurityId:
      row.portfolio_security_id === null
        ? null
        : String(row.portfolio_security_id),
    type: String(row.type),
    status: String(row.status),
    tradeAt: String(row.trade_at),
    localTradeDate: String(row.local_trade_date),
    settlementDate:
      row.settlement_date === null ? null : String(row.settlement_date),
    quantityDecimal:
      row.quantity_decimal === null ? null : String(row.quantity_decimal),
    unitPriceDecimal:
      row.unit_price_decimal === null ? null : String(row.unit_price_decimal),
    currencyCode: String(row.currency_code),
    grossAmountDecimal:
      row.gross_amount_decimal === null
        ? null
        : String(row.gross_amount_decimal),
    feeAmountDecimal: String(row.fee_amount_decimal),
    taxAmountDecimal: String(row.tax_amount_decimal),
    fxRateToBaseDecimal:
      row.fx_rate_to_base_decimal === null
        ? null
        : String(row.fx_rate_to_base_decimal),
    fxRateSource:
      row.fx_rate_source === null ? null : String(row.fx_rate_source),
    fxObservedAt:
      row.fx_observed_at === null ? null : String(row.fx_observed_at),
    sourceType: String(row.source_type),
    sourceReference:
      row.source_reference === null ? null : String(row.source_reference),
    idempotencyKey:
      row.idempotency_key === null ? null : String(row.idempotency_key),
    importRowId: row.import_row_id === null ? null : String(row.import_row_id),
    reversesTransactionId:
      row.reverses_transaction_id === null
        ? null
        : String(row.reverses_transaction_id),
    supersedesTransactionId:
      row.supersedes_transaction_id === null
        ? null
        : String(row.supersedes_transaction_id),
    createdByUserId: String(row.created_by_user_id),
    calculationVersion: Number(row.calculation_version),
    createdAt: String(row.created_at),
    version: Number(row.version),
  };
}

function mapCashEntry(row: Record<string, unknown>): CashLedgerEntryRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    cashAccountId: String(row.cash_account_id),
    transactionId:
      row.transaction_id === null ? null : String(row.transaction_id),
    effectiveAt: String(row.effective_at),
    localEffectiveDate: String(row.local_effective_date),
    type: String(row.type),
    signedAmountDecimal: String(row.signed_amount_decimal),
    status: String(row.status),
    reversesEntryId:
      row.reverses_entry_id === null ? null : String(row.reverses_entry_id),
    createdAt: String(row.created_at),
  };
}

function negate(value: string): string {
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

function cashTypeForEffect(type: string, effect: string): string {
  if (type === "fee" || type === "tax") return type;
  return effect.startsWith("-") ? "cash_withdrawal" : "cash_deposit";
}

/** Executes `statements` as one D1-compatible atomic unit via `batch()`. */
async function atomic(
  client: SqlClient,
  statements: readonly SqlStatement[],
): Promise<void> {
  await client.batch(statements);
}

/** Build one posting's statements so import chunks can share one D1 batch. */
export async function buildLedgerPostingStatements(
  client: SqlClient,
  userId: string,
  input: LedgerPostingPersistenceInput,
  prepared: PreparedLedgerPosting,
  action: string,
  now: () => string = () => new Date().toISOString(),
): Promise<LedgerPostingStatements> {
  const createdAt = now();
  const calculationRunId = randomUUID();
  const cashEffect = prepared.cashEffectDecimal;
  const cashEntryId = cashEffect === null ? null : prepared.cashEntryId;
  const existingAccount =
    cashEffect === null
      ? null
      : await client.get<{ id: string }>(
          `SELECT id FROM cash_accounts
           WHERE user_id = ? AND portfolio_id = ? AND currency_code = ?
           LIMIT 1`,
          [userId, input.portfolioId, input.currencyCode],
        );
  const accountId =
    cashEffect === null
      ? null
      : (existingAccount?.id ?? prepared.cashAccountId);
  const statements: SqlStatement[] = [];
  if (accountId) {
    statements.push({
      sql: `INSERT INTO cash_accounts
        (id, user_id, portfolio_id, currency_code, completeness, status)
        VALUES (?, ?, ?, ?, ?, 'active')
        ON CONFLICT (portfolio_id, currency_code) DO NOTHING`,
      params: [
        accountId,
        userId,
        input.portfolioId,
        input.currencyCode,
        input.type === "opening_balance" ? "opening_balance" : "incomplete",
      ],
    });
  }
  statements.push({
    sql: `INSERT INTO transactions (${TRANSACTION_COLUMNS})
      VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    params: [
      prepared.transactionId,
      userId,
      input.portfolioId,
      input.portfolioSecurityId,
      input.type,
      input.tradeAt,
      input.localTradeDate,
      input.settlementDate ?? null,
      input.quantityDecimal,
      input.unitPriceDecimal,
      input.currencyCode,
      prepared.grossAmountDecimal,
      input.feeAmountDecimal,
      input.taxAmountDecimal,
      input.fxRateToBaseDecimal,
      input.fxRateSource ?? null,
      input.fxObservedAt ?? null,
      input.sourceType,
      prepared.sourceReference,
      prepared.idempotencyKey,
      input.importRowId ?? null,
      input.reversesTransactionId ?? null,
      input.supersedesTransactionId ?? null,
      userId,
      prepared.calculationVersion,
      createdAt,
    ],
  });
  if (cashEffect !== null && cashEntryId && accountId) {
    statements.push({
      sql: `INSERT INTO cash_ledger_entries (
        id, user_id, portfolio_id, cash_account_id, transaction_id,
        effective_at, local_effective_date, type, signed_amount_decimal,
        status, reverses_entry_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`,
      params: [
        cashEntryId,
        userId,
        input.portfolioId,
        accountId,
        prepared.transactionId,
        input.tradeAt,
        input.localTradeDate,
        cashTypeForEffect(input.type, cashEffect),
        cashEffect,
        input.reversalEntryId ?? null,
        createdAt,
      ],
    });
  }
  statements.push({
    sql: `INSERT INTO calculation_runs (
      id, user_id, portfolio_id, range_from, range_to, calculation_version,
      reason, invalidation_source, status, attempt, ledger_high_water_start,
      idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'ledger_mutation', ?, 'queued', 0, ?, ?, ?, ?)`,
    params: [
      calculationRunId,
      userId,
      input.portfolioId,
      input.localTradeDate,
      input.localTradeDate,
      prepared.calculationVersion,
      prepared.transactionId,
      prepared.transactionId,
      `ledger:${prepared.idempotencyKey}`,
      createdAt,
      createdAt,
    ],
  });
  // CALC-005: the snapshot pipeline is retired -- this posting no longer
  // queues a sibling `snapshot`-pipeline `calculation_runs` row (see
  // docs/ARCHITECTURE.md's CALC-005 entry). The `ledger_mutation` row
  // queued above (pipeline `projection`, implicit via the column default)
  // is unchanged.
  // HIST-002 review B2 (BLOCKING): this posting can change shares held from
  // `input.localTradeDate` onward (the ledger-CSV commit path this function
  // serves) -- invalidate every stored value-history row from that date
  // forward, in the SAME atomic batch as the posting itself, so the graph
  // can never freeze on a stale figure. See
  // `valueHistoryInvalidationFromDateStatement`'s own doc comment.
  statements.push(
    valueHistoryInvalidationFromDateStatement(
      userId,
      input.portfolioId,
      input.localTradeDate,
    ),
  );
  // BUG-012: a new trade can turn a date this portfolio had marked
  // 'no_holdings' into a real holding -- clear the mark in the SAME atomic
  // batch as the DELETE above, see this module's import's own doc comment.
  statements.push(
    unresolvableValueHistoryClearFromDateStatement(
      userId,
      input.portfolioId,
      input.localTradeDate,
    ),
  );
  statements.push(
    createAuditInsertStatement(
      {
        actorUserId: userId,
        targetOwnerUserId: userId,
        action,
        targetType: "transaction",
        targetId: prepared.transactionId,
        requestId: input.requestId,
        result: "success",
        metadata: {
          type: input.type,
          sourceType: input.sourceType,
          currencyCode: input.currencyCode,
        },
        occurredAt: createdAt,
      },
      now,
    ),
  );
  return {
    statements,
    transactionId: prepared.transactionId,
    calculationRunId,
  };
}

export function createOwnedLedgerRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function getTransaction(
    userId: string,
    portfolioId: string,
    transactionId: string,
  ): Promise<LedgerTransactionRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions
       WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
      [transactionId, userId, portfolioId],
    );
    return row ? mapTransaction(row) : null;
  }

  async function getByIdempotency(
    userId: string,
    input: InternalLedgerInput,
  ): Promise<LedgerTransactionRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions
       WHERE user_id = ? AND portfolio_id = ? AND idempotency_key = ? LIMIT 1`,
      [userId, input.portfolioId, input.idempotencyKey],
    );
    return row ? mapTransaction(row) : null;
  }

  async function getBySourceReference(
    userId: string,
    input: InternalLedgerInput,
  ): Promise<LedgerTransactionRecord | null> {
    if (input.sourceReference === null || input.sourceReference === undefined) {
      return null;
    }
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions
       WHERE user_id = ? AND portfolio_id = ? AND source_type = ?
         AND source_reference = ? LIMIT 1`,
      [userId, input.portfolioId, input.sourceType, input.sourceReference],
    );
    return row ? mapTransaction(row) : null;
  }

  async function inventorySnapshot(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
  ): Promise<InventorySnapshot> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT COUNT(*) AS transaction_count,
              COALESCE(SUM(version), 0) AS version_total
       FROM transactions
       WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?`,
      [userId, portfolioId, portfolioSecurityId],
    );
    return {
      portfolioSecurityId,
      transactionCount: Number(row?.transaction_count ?? 0),
      versionTotal: Number(row?.version_total ?? 0),
    };
  }

  async function validateInventory(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
    candidate: InventoryEvent | null,
    excludedTransactionId: string | null,
  ): Promise<{ ok: true; plan: InventoryPlan } | LedgerMutationFailure> {
    const snapshot = await inventorySnapshot(
      userId,
      portfolioId,
      portfolioSecurityId,
    );
    let cursorTradeAt = "";
    let cursorId = "";
    let quantity = parseDecimal("0");
    let candidateApplied = candidate === null;
    for (let page = 0; page < LEDGER_INVENTORY_LIMITS.maxPages; page += 1) {
      const rows = await client.all<Record<string, unknown>>(
        `SELECT id, type, trade_at, quantity_decimal, unit_price_decimal
         FROM transactions
         WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
           AND status = 'posted' AND reverses_transaction_id IS NULL
           AND type IN ('buy', 'sell', 'split')
           AND (? IS NULL OR id <> ?)
           AND (trade_at > ? OR (trade_at = ? AND id > ?))
         ORDER BY trade_at ASC, id ASC
         LIMIT ?`,
        [
          userId,
          portfolioId,
          portfolioSecurityId,
          excludedTransactionId,
          excludedTransactionId,
          cursorTradeAt,
          cursorTradeAt,
          cursorId,
          LEDGER_INVENTORY_LIMITS.pageSize + 1,
        ],
      );
      const pageRows = rows.slice(0, LEDGER_INVENTORY_LIMITS.pageSize);
      for (const row of pageRows) {
        const event: InventoryEvent = {
          id: String(row.id),
          type: String(row.type) as InventoryEvent["type"],
          tradeAt: String(row.trade_at),
          quantityDecimal: String(row.quantity_decimal),
          unitPriceDecimal:
            row.unit_price_decimal === null
              ? null
              : String(row.unit_price_decimal),
        };
        if (
          !candidateApplied &&
          candidate &&
          (candidate.tradeAt.localeCompare(event.tradeAt) < 0 ||
            (candidate.tradeAt === event.tradeAt &&
              candidate.id.localeCompare(event.id) < 0))
        ) {
          const applied = applyInventoryEvent(quantity, candidate);
          if (!applied.ok) return applied;
          quantity = applied.quantity;
          candidateApplied = true;
        }
        const applied = applyInventoryEvent(quantity, event);
        if (!applied.ok) return applied;
        quantity = applied.quantity;
      }
      if (rows.length <= LEDGER_INVENTORY_LIMITS.pageSize) {
        if (!candidateApplied && candidate) {
          const applied = applyInventoryEvent(quantity, candidate);
          if (!applied.ok) return applied;
        }
        return { ok: true, plan: { snapshot } };
      }
      const finalRow = pageRows.at(-1);
      cursorTradeAt = String(finalRow?.trade_at ?? "");
      cursorId = String(finalRow?.id ?? "");
    }
    return { ok: false, reason: "inventory_limit" };
  }

  function inventoryGuardStatements(
    userId: string,
    portfolioId: string,
    plans: readonly InventoryPlan[],
  ): SqlStatement[] {
    return plans.flatMap(({ snapshot }) => {
      const id = randomUUID();
      return [
        {
          sql: `INSERT INTO ledger_mutation_guards (
                  id, user_id, portfolio_id, portfolio_security_id, valid
                )
                SELECT ?, ?, ?, ?, CASE WHEN (
                  SELECT COUNT(*) FROM transactions
                  WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
                ) = ? AND (
                  SELECT COALESCE(SUM(version), 0) FROM transactions
                  WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
                ) = ? THEN 1 ELSE 0 END`,
          params: [
            id,
            userId,
            portfolioId,
            snapshot.portfolioSecurityId,
            userId,
            portfolioId,
            snapshot.portfolioSecurityId,
            snapshot.transactionCount,
            userId,
            portfolioId,
            snapshot.portfolioSecurityId,
            snapshot.versionTotal,
          ],
        },
        {
          sql: "DELETE FROM ledger_mutation_guards WHERE id = ? AND user_id = ?",
          params: [id, userId],
        },
      ];
    });
  }

  async function inventoryChanged(
    userId: string,
    portfolioId: string,
    plans: readonly InventoryPlan[],
  ): Promise<boolean> {
    for (const { snapshot } of plans) {
      const current = await inventorySnapshot(
        userId,
        portfolioId,
        snapshot.portfolioSecurityId,
      );
      if (
        current.transactionCount !== snapshot.transactionCount ||
        current.versionTotal !== snapshot.versionTotal
      ) {
        return true;
      }
    }
    return false;
  }

  function matchesPostingIntent(
    existing: LedgerTransactionRecord,
    input: InternalLedgerInput,
    prepared: PreparedLedgerPosting,
  ): boolean {
    return (
      existing.portfolioId === input.portfolioId &&
      existing.portfolioSecurityId === input.portfolioSecurityId &&
      existing.type === input.type &&
      existing.tradeAt === input.tradeAt &&
      existing.localTradeDate === input.localTradeDate &&
      existing.settlementDate === (input.settlementDate ?? null) &&
      existing.quantityDecimal === input.quantityDecimal &&
      existing.unitPriceDecimal === input.unitPriceDecimal &&
      existing.currencyCode === input.currencyCode &&
      existing.grossAmountDecimal === prepared.grossAmountDecimal &&
      existing.feeAmountDecimal === input.feeAmountDecimal &&
      existing.taxAmountDecimal === input.taxAmountDecimal &&
      existing.fxRateToBaseDecimal === input.fxRateToBaseDecimal &&
      existing.fxRateSource === (input.fxRateSource ?? null) &&
      existing.fxObservedAt === (input.fxObservedAt ?? null) &&
      existing.sourceType === input.sourceType &&
      existing.sourceReference === (input.sourceReference ?? null) &&
      existing.importRowId === (input.importRowId ?? null) &&
      existing.reversesTransactionId ===
        (input.reversesTransactionId ?? null) &&
      existing.supersedesTransactionId ===
        (input.supersedesTransactionId ?? null) &&
      existing.calculationVersion === prepared.calculationVersion
    );
  }

  async function getCashEntry(
    userId: string,
    portfolioId: string,
    transactionId: string,
  ): Promise<CashLedgerEntryRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT id, user_id, portfolio_id, cash_account_id, transaction_id,
        effective_at, local_effective_date, type, signed_amount_decimal, status,
        reverses_entry_id, created_at
       FROM cash_ledger_entries
       WHERE user_id = ? AND portfolio_id = ? AND transaction_id = ?
       LIMIT 1`,
      [userId, portfolioId, transactionId],
    );
    return row ? mapCashEntry(row) : null;
  }

  async function result(
    userId: string,
    portfolioId: string,
    transaction: LedgerTransactionRecord,
    idempotent: boolean,
  ): Promise<LedgerMutationSuccess> {
    const cashEntry = await getCashEntry(userId, portfolioId, transaction.id);
    // CALC-004 queued a sibling `snapshot`-pipeline row alongside this
    // transaction's `projection`-pipeline row; CALC-005 retired that
    // sibling (see docs/ARCHITECTURE.md), so this predicate is now
    // defensive rather than disambiguating -- kept explicit anyway so this
    // lookup can never nondeterministically pick a future non-projection
    // row for this `invalidation_source`, matching the run identity
    // callers already rely on (e.g. `import-reversal.ts`'s
    // `rebuildJobIds`).
    const run = await client.get<{ id: string }>(
      `SELECT id FROM calculation_runs
       WHERE user_id = ? AND portfolio_id = ? AND invalidation_source = ?
         AND pipeline = 'projection'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, portfolioId, transaction.id],
    );
    return {
      ok: true,
      transaction,
      cashEntry,
      calculationRunId: run?.id ?? "",
      idempotent,
    };
  }

  async function existingResult(
    userId: string,
    input: InternalLedgerInput,
    prepared: PreparedLedgerPosting,
    existing: LedgerTransactionRecord,
  ): Promise<LedgerMutationResult> {
    if (!matchesPostingIntent(existing, input, prepared)) {
      return { ok: false, reason: "conflict" };
    }
    return result(userId, input.portfolioId, existing, true);
  }

  async function validateOwnership(
    userId: string,
    input: LedgerPostingInput,
  ): Promise<LedgerMutationFailure | null> {
    const portfolio = await client.get<{ id: string }>(
      `SELECT id FROM portfolios
       WHERE id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
      [input.portfolioId, userId],
    );
    if (!portfolio) return { ok: false, reason: "not_found" };
    const currency = await client.get<{ code: string }>(
      "SELECT code FROM currencies WHERE code = ? AND is_active = 1 LIMIT 1",
      [input.currencyCode],
    );
    if (!currency) return { ok: false, reason: "invalid_input" };
    if (input.portfolioSecurityId !== null) {
      const security = await client.get<{ id: string }>(
        `SELECT id FROM portfolio_securities
         WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
        [input.portfolioSecurityId, userId, input.portfolioId],
      );
      if (!security) return { ok: false, reason: "not_found" };
    }
    return null;
  }

  async function persist(
    userId: string,
    input: InternalLedgerInput,
    prepared: PreparedLedgerPosting,
    action: string,
    statusUpdate: SqlStatement | null = null,
    cashEffectOverride?: string | null,
    inventoryPlans: readonly InventoryPlan[] = [],
    authorization?: LedgerMutationAuthorization,
    // HIST-002 review B2: the EARLIEST local_trade_date this mutation can
    // affect shares-held from. Defaults to `input.localTradeDate` -- correct
    // for `post` (a brand-new fact effective from its own date) and
    // `reverse` (whose `input.localTradeDate` is already copied from the
    // ORIGINAL transaction being reversed, see `reverse()` below). A
    // `supersede` can move a fact to a DIFFERENT date, so `supersede()`
    // passes the true min(original date, new date) explicitly.
    earliestAffectedLocalDate: string = input.localTradeDate,
  ): Promise<LedgerMutationResult> {
    const sourceReferenceConflict = await getBySourceReference(userId, input);
    if (sourceReferenceConflict) {
      return sourceReferenceConflict.idempotencyKey === input.idempotencyKey
        ? existingResult(userId, input, prepared, sourceReferenceConflict)
        : { ok: false, reason: "conflict" };
    }
    const createdAt = now();
    const calculationRunId = randomUUID();
    const cashEffect =
      cashEffectOverride === undefined
        ? prepared.cashEffectDecimal
        : cashEffectOverride;
    const cashEntryId = cashEffect === null ? null : prepared.cashEntryId;
    const existingAccount =
      cashEffect === null
        ? null
        : await client.get<{ id: string }>(
            `SELECT id FROM cash_accounts
             WHERE user_id = ? AND portfolio_id = ? AND currency_code = ?
             LIMIT 1`,
            [userId, input.portfolioId, input.currencyCode],
          );
    const accountId =
      cashEffect === null
        ? null
        : (existingAccount?.id ?? prepared.cashAccountId);
    const statements: SqlStatement[] = inventoryGuardStatements(
      userId,
      input.portfolioId,
      inventoryPlans,
    );
    if (statusUpdate) statements.push(statusUpdate);
    if (accountId) {
      statements.push({
        sql: `INSERT INTO cash_accounts
          (id, user_id, portfolio_id, currency_code, completeness, status)
          VALUES (?, ?, ?, ?, ?, 'active')
          ON CONFLICT (portfolio_id, currency_code) DO NOTHING`,
        params: [
          accountId,
          userId,
          input.portfolioId,
          input.currencyCode,
          input.type === "opening_balance" ? "opening_balance" : "incomplete",
        ],
      });
    }
    statements.push({
      sql: `INSERT INTO transactions (
        ${TRANSACTION_COLUMNS}
      ) VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      params: [
        prepared.transactionId,
        userId,
        input.portfolioId,
        input.portfolioSecurityId,
        input.type,
        input.tradeAt,
        input.localTradeDate,
        input.settlementDate ?? null,
        input.quantityDecimal,
        input.unitPriceDecimal,
        input.currencyCode,
        prepared.grossAmountDecimal,
        input.feeAmountDecimal,
        input.taxAmountDecimal,
        input.fxRateToBaseDecimal,
        input.fxRateSource ?? null,
        input.fxObservedAt ?? null,
        input.sourceType,
        prepared.sourceReference,
        prepared.idempotencyKey,
        input.importRowId ?? null,
        input.reversesTransactionId ?? null,
        input.supersedesTransactionId ?? null,
        userId,
        prepared.calculationVersion,
        createdAt,
      ],
    });
    if (authorization) {
      statements.push(
        consumeManualLedgerMutationKeyStatement(
          authorization,
          userId,
          input.portfolioId,
          prepared.transactionId,
          createdAt,
        ),
      );
    }
    if (cashEffect !== null && cashEntryId && accountId) {
      statements.push({
        sql: `INSERT INTO cash_ledger_entries (
          id, user_id, portfolio_id, cash_account_id, transaction_id,
          effective_at, local_effective_date, type, signed_amount_decimal,
          status, reverses_entry_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`,
        params: [
          cashEntryId,
          userId,
          input.portfolioId,
          accountId,
          prepared.transactionId,
          input.tradeAt,
          input.localTradeDate,
          cashTypeForEffect(input.type, cashEffect),
          cashEffect,
          input.reversalEntryId ?? null,
          createdAt,
        ],
      });
    }
    statements.push({
      sql: `INSERT INTO calculation_runs (
        id, user_id, portfolio_id, range_from, range_to, calculation_version,
        reason, invalidation_source, status, attempt, ledger_high_water_start,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'ledger_mutation', ?, 'queued', 0, ?, ?, ?, ?)`,
      params: [
        calculationRunId,
        userId,
        input.portfolioId,
        input.localTradeDate,
        input.localTradeDate,
        prepared.calculationVersion,
        prepared.transactionId,
        prepared.transactionId,
        `ledger:${prepared.idempotencyKey}`,
        createdAt,
        createdAt,
      ],
    });
    // CALC-005: the snapshot pipeline is retired -- this mutation no longer
    // queues a sibling `snapshot`-pipeline `calculation_runs` row (see
    // docs/ARCHITECTURE.md's CALC-005 entry). The `ledger_mutation` row
    // queued above (pipeline `projection`, implicit via the column default)
    // is unchanged.
    // HIST-002 review B2 (BLOCKING): post/reverse/supersede can all change
    // shares held from `earliestAffectedLocalDate` onward -- invalidate
    // every stored value-history row from that date forward, in the SAME
    // atomic batch as the mutation itself (never a separate, skippable
    // follow-up call). See `valueHistoryInvalidationFromDateStatement`'s own
    // doc comment.
    statements.push(
      valueHistoryInvalidationFromDateStatement(
        userId,
        input.portfolioId,
        earliestAffectedLocalDate,
      ),
    );
    // BUG-012: post/reverse/supersede can equally turn a
    // previously-'no_holdings' date into a real holding -- clear the mark
    // in the SAME atomic batch as the DELETE above.
    statements.push(
      unresolvableValueHistoryClearFromDateStatement(
        userId,
        input.portfolioId,
        earliestAffectedLocalDate,
      ),
    );
    statements.push(
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action,
          targetType: "transaction",
          targetId: prepared.transactionId,
          requestId: input.requestId,
          result: "success",
          metadata: {
            type: input.type,
            sourceType: input.sourceType,
            currencyCode: input.currencyCode,
          },
          occurredAt: createdAt,
        },
        now,
      ),
    );
    try {
      await atomic(client, statements);
    } catch {
      const existing = await getByIdempotency(userId, input);
      if (existing) return existingResult(userId, input, prepared, existing);
      if (await getBySourceReference(userId, input)) {
        return { ok: false, reason: "conflict" };
      }
      if (
        inventoryPlans.length > 0 &&
        (await inventoryChanged(userId, input.portfolioId, inventoryPlans))
      ) {
        return { ok: false, reason: "concurrent_change" };
      }
      return { ok: false, reason: "atomic_failure" };
    }
    const transaction = await getTransaction(
      userId,
      input.portfolioId,
      prepared.transactionId,
    );
    if (!transaction) return { ok: false, reason: "atomic_failure" };
    return result(userId, input.portfolioId, transaction, false);
  }

  async function post(
    userId: string,
    input: LedgerPostingInput,
    authorization?: LedgerMutationAuthorization,
  ): Promise<LedgerMutationResult> {
    const preparation = prepareLedgerPosting(input);
    if (!preparation.ok)
      return {
        ok: false,
        reason:
          preparation.reason === "gross_mismatch"
            ? "gross_mismatch"
            : preparation.reason === "invalid_date"
              ? "invalid_date"
              : preparation.reason === "invalid_source"
                ? "invalid_source"
                : preparation.reason === "cash_effect_invalid"
                  ? "cash_effect_invalid"
                  : "invalid_input",
      };
    const existing = await getByIdempotency(userId, input);
    if (existing) {
      return existingResult(userId, input, preparation.posting, existing);
    }
    const ownershipFailure = await validateOwnership(userId, input);
    if (ownershipFailure) return ownershipFailure;
    if (authorization && authorization.key !== input.idempotencyKey) {
      return { ok: false, reason: "conflict" };
    }
    for (
      let attempt = 0;
      attempt < LEDGER_INVENTORY_LIMITS.retryAttempts;
      attempt += 1
    ) {
      const event = inventoryEventFromInput(
        preparation.posting.transactionId,
        input,
      );
      const plans: InventoryPlan[] = [];
      if (event && input.portfolioSecurityId) {
        const validation = await validateInventory(
          userId,
          input.portfolioId,
          input.portfolioSecurityId,
          event,
          null,
        );
        if (!validation.ok) return validation;
        plans.push(validation.plan);
      }
      const mutation = await persist(
        userId,
        input,
        preparation.posting,
        "ledger.post",
        null,
        undefined,
        plans,
        authorization,
      );
      if (mutation.ok || mutation.reason !== "concurrent_change") {
        return mutation;
      }
    }
    return { ok: false, reason: "atomic_failure" };
  }

  async function reverse(
    userId: string,
    portfolioId: string,
    transactionId: string,
    idempotencyKey: string,
    requestId: string,
    authorization?: LedgerMutationAuthorization,
  ): Promise<LedgerMutationResult> {
    const original = await getTransaction(userId, portfolioId, transactionId);
    if (!original) return { ok: false, reason: "not_found" };
    const originalInput: LedgerPostingInput = {
      portfolioId,
      type: original.type as LedgerPostingInput["type"],
      portfolioSecurityId: original.portfolioSecurityId,
      quantityDecimal: original.quantityDecimal,
      unitPriceDecimal: original.unitPriceDecimal,
      grossAmountDecimal: original.grossAmountDecimal,
      feeAmountDecimal: original.feeAmountDecimal,
      taxAmountDecimal: original.taxAmountDecimal,
      fxRateToBaseDecimal: original.fxRateToBaseDecimal,
      sourceType: "system",
      idempotencyKey,
      tradeAt: original.tradeAt,
      localTradeDate: original.localTradeDate,
      settlementDate: original.settlementDate,
      currencyCode: original.currencyCode,
      fxRateSource: original.fxRateSource,
      fxObservedAt: original.fxObservedAt,
      requestId,
    };
    const existing = await getByIdempotency(userId, originalInput);
    const preparation = prepareLedgerPosting(originalInput);
    if (!preparation.ok) return { ok: false, reason: "invalid_input" };
    if (existing) {
      return existingResult(
        userId,
        { ...originalInput, reversesTransactionId: transactionId },
        preparation.posting,
        existing,
      );
    }
    if (authorization && authorization.key !== idempotencyKey) {
      return { ok: false, reason: "conflict" };
    }
    if (original.status !== "posted") return { ok: false, reason: "conflict" };
    const originalCash = await getCashEntry(userId, portfolioId, transactionId);
    const reversalEffect = originalCash
      ? negate(originalCash.signedAmountDecimal)
      : null;
    const statusUpdate: SqlStatement = {
      sql: `UPDATE transactions SET status = 'reversed', version = version + 1
        WHERE id = ? AND user_id = ? AND portfolio_id = ? AND status = 'posted'`,
      params: [transactionId, userId, portfolioId],
    };
    for (
      let attempt = 0;
      attempt < LEDGER_INVENTORY_LIMITS.retryAttempts;
      attempt += 1
    ) {
      const plans: InventoryPlan[] = [];
      if (
        original.portfolioSecurityId &&
        (original.type === "buy" ||
          original.type === "sell" ||
          original.type === "split")
      ) {
        const validation = await validateInventory(
          userId,
          portfolioId,
          original.portfolioSecurityId,
          null,
          transactionId,
        );
        if (!validation.ok) return validation;
        plans.push(validation.plan);
      }
      const mutation = await persist(
        userId,
        {
          ...originalInput,
          reversesTransactionId: transactionId,
          reversalEntryId: originalCash?.id ?? null,
        },
        preparation.posting,
        "ledger.reverse",
        statusUpdate,
        reversalEffect,
        plans,
        authorization,
      );
      if (mutation.ok || mutation.reason !== "concurrent_change") {
        return mutation;
      }
    }
    return { ok: false, reason: "atomic_failure" };
  }

  async function supersede(
    userId: string,
    portfolioId: string,
    transactionId: string,
    input: LedgerPostingInput,
    authorization?: LedgerMutationAuthorization,
  ): Promise<LedgerMutationResult> {
    const original = await getTransaction(userId, portfolioId, transactionId);
    if (!original) return { ok: false, reason: "not_found" };
    const supersedingInput: InternalLedgerInput = {
      ...input,
      portfolioId,
      supersedesTransactionId: transactionId,
    };
    const preparation = prepareLedgerPosting(supersedingInput);
    if (!preparation.ok) return { ok: false, reason: "invalid_input" };
    const existing = await getByIdempotency(userId, supersedingInput);
    if (existing) {
      return existingResult(
        userId,
        supersedingInput,
        preparation.posting,
        existing,
      );
    }
    if (authorization && authorization.key !== input.idempotencyKey) {
      return { ok: false, reason: "conflict" };
    }
    if (original.status !== "posted") return { ok: false, reason: "conflict" };
    const ownershipFailure = await validateOwnership(userId, supersedingInput);
    if (ownershipFailure) return ownershipFailure;
    const statusUpdate: SqlStatement = {
      sql: `UPDATE transactions SET status = 'superseded', version = version + 1
        WHERE id = ? AND user_id = ? AND portfolio_id = ? AND status = 'posted'`,
      params: [transactionId, userId, portfolioId],
    };
    const securityIds = new Set(
      [original.portfolioSecurityId, input.portfolioSecurityId].filter(
        (id): id is string => id !== null,
      ),
    );
    const retryAttempts = securityIds.size === 1 ? 2 : 1;
    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      const plans: InventoryPlan[] = [];
      for (const securityId of securityIds) {
        const candidate =
          input.portfolioSecurityId === securityId
            ? inventoryEventFromInput(
                preparation.posting.transactionId,
                supersedingInput,
              )
            : null;
        const validation = await validateInventory(
          userId,
          portfolioId,
          securityId,
          candidate,
          original.portfolioSecurityId === securityId ? transactionId : null,
        );
        if (!validation.ok) return validation;
        plans.push(validation.plan);
      }
      // HIST-002 review B2: a supersession can move a fact to a DIFFERENT
      // local_trade_date than the original -- invalidate from the EARLIER
      // of the two, so both the vacated old date and the new date's
      // forward history are covered by one ranged delete.
      const earliestAffectedLocalDate =
        original.localTradeDate < input.localTradeDate
          ? original.localTradeDate
          : input.localTradeDate;
      const mutation = await persist(
        userId,
        supersedingInput,
        preparation.posting,
        "ledger.supersede",
        statusUpdate,
        undefined,
        plans,
        authorization,
        earliestAffectedLocalDate,
      );
      if (mutation.ok || mutation.reason !== "concurrent_change") {
        return mutation;
      }
    }
    return { ok: false, reason: "atomic_failure" };
  }

  return { post, reverse, supersede };
}
