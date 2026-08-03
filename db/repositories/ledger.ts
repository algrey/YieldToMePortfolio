import { randomUUID } from "node:crypto";
import { createAuditInsertStatement } from "./audit.ts";
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
    const run = await client.get<{ id: string }>(
      `SELECT id FROM calculation_runs
       WHERE user_id = ? AND portfolio_id = ? AND invalidation_source = ?
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
    const statements: SqlStatement[] = [];
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
    return persist(userId, input, preparation.posting, "ledger.post");
  }

  async function reverse(
    userId: string,
    portfolioId: string,
    transactionId: string,
    idempotencyKey: string,
    requestId: string,
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
    if (original.status !== "posted") return { ok: false, reason: "conflict" };
    const originalCash = await getCashEntry(userId, portfolioId, transactionId);
    const reversalEffect = originalCash
      ? negate(originalCash.signedAmountDecimal)
      : null;
    const statusUpdate: SqlStatement = {
      sql: `UPDATE transactions SET status = 'reversed'
        WHERE id = ? AND user_id = ? AND portfolio_id = ? AND status = 'posted'`,
      params: [transactionId, userId, portfolioId],
    };
    return persist(
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
    );
  }

  async function supersede(
    userId: string,
    portfolioId: string,
    transactionId: string,
    input: LedgerPostingInput,
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
    if (original.status !== "posted") return { ok: false, reason: "conflict" };
    const ownershipFailure = await validateOwnership(userId, supersedingInput);
    if (ownershipFailure) return ownershipFailure;
    const statusUpdate: SqlStatement = {
      sql: `UPDATE transactions SET status = 'superseded'
        WHERE id = ? AND user_id = ? AND portfolio_id = ? AND status = 'posted'`,
      params: [transactionId, userId, portfolioId],
    };
    return persist(
      userId,
      supersedingInput,
      preparation.posting,
      "ledger.supersede",
      statusUpdate,
    );
  }

  return { post, reverse, supersede };
}
