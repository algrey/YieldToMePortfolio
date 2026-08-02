import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  type LedgerMutationResult,
} from "../db/repositories/index.ts";
import type { LedgerPostingInput } from "../domain/ledger/index.ts";

function present<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  await applyMigrations(database, files);
  seedOwnedLedgerFixture(database);
  return database;
}

async function applyMigrations(
  database: DatabaseSync,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
}

function seedOwnedLedgerFixture(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-02', '2026-08-02', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-02', '2026-08-02', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-02', '2026-08-02', 1),
           ('user-b', 'USD', 'Australia/Sydney', '2026-08-02', '2026-08-02', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-02', '2026-08-02', 1),
           ('portfolio-b', 'user-b', 'B', 'Bob', 'USD', 'Australia/Sydney', 'fifo', 'active', '2026-08-02', '2026-08-02', 1);
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'ABC', 'USD', 'unresolved', '2026-08-02', '2026-08-02');
  `);
}

function input(
  overrides: Partial<LedgerPostingInput> = {},
): LedgerPostingInput {
  return {
    portfolioId: "portfolio-a",
    type: "buy",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "2",
    unitPriceDecimal: "10.25",
    grossAmountDecimal: null,
    feeAmountDecimal: "1.25",
    taxAmountDecimal: "0.50",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: "buy-1",
    tradeAt: "2026-08-01T10:00:00Z",
    localTradeDate: "2026-08-01",
    settlementDate: "2026-08-03",
    currencyCode: "USD",
    requestId: "request-1",
    ...overrides,
  };
}

function success(result: LedgerMutationResult) {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected successful ledger mutation");
  return result;
}

test("migration backfills an unambiguous legacy retry reference", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const idempotencyMigrationIndex = files.findIndex((entry) =>
    entry.startsWith("0013_"),
  );
  assert.notEqual(idempotencyMigrationIndex, -1);
  await applyMigrations(database, files.slice(0, idempotencyMigrationIndex));
  seedOwnedLedgerFixture(database);
  database.exec(`
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at,
      local_trade_date, quantity_decimal, unit_price_decimal, currency_code,
      gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, source_type,
      source_reference, created_by_user_id, calculation_version, created_at
    ) VALUES (
      'legacy-transaction', 'user-a', 'portfolio-a', 'membership-a', 'buy',
      'posted', '2026-08-01T10:00:00Z', '2026-08-01', '2', '10.25', 'USD',
      '20.5', '1.25', '0.5', 'manual', 'legacy-retry', 'user-a', 1,
      '2026-08-02T00:00:00Z'
    ), (
      'legacy-ambiguous-manual', 'user-a', 'portfolio-a', 'membership-a',
      'buy', 'posted', '2026-08-01T11:00:00Z', '2026-08-01', '1', '10',
      'USD', '10', '0', '0', 'manual', 'ambiguous-reference', 'user-a', 1,
      '2026-08-02T00:00:00Z'
    ), (
      'legacy-ambiguous-system', 'user-a', 'portfolio-a', 'membership-a',
      'buy', 'posted', '2026-08-01T12:00:00Z', '2026-08-01', '1', '10',
      'USD', '10', '0', '0', 'system', 'ambiguous-reference', 'user-a', 1,
      '2026-08-02T00:00:00Z'
    );
  `);

  await applyMigrations(database, files.slice(idempotencyMigrationIndex));

  assert.equal(
    present(
      database
        .prepare(
          "SELECT idempotency_key FROM transactions WHERE id = 'legacy-transaction'",
        )
        .get() as { idempotency_key: string } | undefined,
    ).idempotency_key,
    "legacy-retry",
  );
  assert.equal(
    present(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM transactions WHERE source_reference = 'ambiguous-reference' AND idempotency_key IS NULL",
        )
        .get() as { count: number } | undefined,
    ).count,
    2,
  );
});

test("posts trades and cash effects atomically with exact FX provenance", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedLedgerRepository(
    createSqliteSqlClient(database),
    () => "2026-08-02T00:00:00Z",
  );
  const posted = success(
    await repository.post(
      "user-a",
      input({
        fxRateToBaseDecimal: "1.52",
        fxRateSource: "manual-import",
        fxObservedAt: "2026-08-01T00:00:00Z",
      }),
    ),
  );

  assert.equal(posted.idempotent, false);
  assert.equal(posted.transaction.idempotencyKey, "buy-1");
  assert.equal(posted.transaction.sourceReference, null);
  assert.equal(posted.transaction.grossAmountDecimal, "20.5");
  assert.equal(posted.transaction.fxRateToBaseDecimal, "1.52");
  assert.equal(posted.cashEntry?.type, "cash_withdrawal");
  assert.equal(posted.cashEntry?.signedAmountDecimal, "-22.25");
  assert.equal(posted.calculationRunId.length > 0, true);
  assert.equal(
    present(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE target_id = ?",
        )
        .get(posted.transaction.id) as { count: number } | undefined,
    ).count,
    1,
  );
});

test("supports cash events, fees, taxes, and explicit split without fabricating FX", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedLedgerRepository(
    createSqliteSqlClient(database),
  );
  const deposit = success(
    await repository.post(
      "user-a",
      input({
        type: "cash_deposit",
        portfolioSecurityId: null,
        quantityDecimal: null,
        unitPriceDecimal: null,
        grossAmountDecimal: "1000",
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        currencyCode: "AUD",
        idempotencyKey: "deposit-1",
      }),
    ),
  );
  const fee = success(
    await repository.post(
      "user-a",
      input({
        type: "fee",
        portfolioSecurityId: null,
        quantityDecimal: null,
        unitPriceDecimal: null,
        grossAmountDecimal: "2.50",
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        currencyCode: "AUD",
        idempotencyKey: "fee-1",
      }),
    ),
  );
  const sell = success(
    await repository.post(
      "user-a",
      input({
        type: "sell",
        quantityDecimal: "1",
        unitPriceDecimal: "10",
        grossAmountDecimal: null,
        feeAmountDecimal: "0.50",
        taxAmountDecimal: "0.25",
        idempotencyKey: "sell-1",
      }),
    ),
  );
  const tax = success(
    await repository.post(
      "user-a",
      input({
        type: "tax",
        portfolioSecurityId: null,
        quantityDecimal: null,
        unitPriceDecimal: null,
        grossAmountDecimal: "1.25",
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        currencyCode: "AUD",
        idempotencyKey: "tax-1",
      }),
    ),
  );
  const withdrawal = success(
    await repository.post(
      "user-a",
      input({
        type: "cash_withdrawal",
        portfolioSecurityId: null,
        quantityDecimal: null,
        unitPriceDecimal: null,
        grossAmountDecimal: "100",
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        currencyCode: "AUD",
        idempotencyKey: "withdrawal-1",
      }),
    ),
  );
  const split = success(
    await repository.post(
      "user-a",
      input({
        type: "split",
        quantityDecimal: "3",
        unitPriceDecimal: "2",
        grossAmountDecimal: null,
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        idempotencyKey: "split-1",
      }),
    ),
  );

  assert.equal(deposit.cashEntry?.signedAmountDecimal, "1000");
  assert.equal(fee.cashEntry?.signedAmountDecimal, "-2.5");
  assert.equal(sell.cashEntry?.signedAmountDecimal, "9.25");
  assert.equal(tax.cashEntry?.type, "tax");
  assert.equal(withdrawal.cashEntry?.signedAmountDecimal, "-100");
  assert.equal(split.cashEntry, null);
  assert.equal(split.transaction.fxRateToBaseDecimal, null);
  const balance = present(
    database
      .prepare(
        "SELECT SUM(CAST(signed_amount_decimal AS REAL)) AS balance FROM cash_ledger_entries WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'",
      )
      .get() as { balance: number } | undefined,
  ).balance;
  assert.equal(balance, 905.5);
});

test("retries only identical posting intent for an owner and portfolio", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedLedgerRepository(
    createSqliteSqlClient(database),
  );
  const originalInput = input({ sourceReference: "manual-source-1" });
  const first = success(await repository.post("user-a", originalInput));
  const retry = success(await repository.post("user-a", originalInput));
  assert.equal(retry.idempotent, true);
  assert.equal(retry.transaction.id, first.transaction.id);
  assert.equal(retry.transaction.idempotencyKey, "buy-1");
  assert.equal(retry.transaction.sourceReference, "manual-source-1");

  const changedSourceReference = await repository.post(
    "user-a",
    input({ sourceReference: "manual-source-2" }),
  );
  assert.deepEqual(changedSourceReference, {
    ok: false,
    reason: "conflict",
  });
  const changedFinancialIntent = await repository.post(
    "user-a",
    input({ sourceReference: "manual-source-1", unitPriceDecimal: "11" }),
  );
  assert.deepEqual(changedFinancialIntent, {
    ok: false,
    reason: "conflict",
  });
  const reusedSourceReference = await repository.post(
    "user-a",
    input({
      idempotencyKey: "buy-2",
      sourceReference: "manual-source-1",
    }),
  );
  assert.deepEqual(reusedSourceReference, { ok: false, reason: "conflict" });

  database.exec(
    "UPDATE portfolios SET status = 'archived' WHERE id = 'portfolio-a'",
  );
  const archivedRetry = success(await repository.post("user-a", originalInput));
  assert.equal(archivedRetry.idempotent, true);

  const crossUser = await repository.post("user-b", input());
  assert.deepEqual(crossUser, { ok: false, reason: "not_found" });
  const crossPortfolio = await repository.post(
    "user-a",
    input({ portfolioId: "portfolio-b", idempotencyKey: "cross-portfolio" }),
  );
  assert.deepEqual(crossPortfolio, { ok: false, reason: "not_found" });
  assert.equal(
    present(
      database.prepare("SELECT COUNT(*) AS count FROM transactions").get() as
        { count: number } | undefined,
    ).count,
    1,
  );
});

test("allows the same idempotency key in a different owner portfolio", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedLedgerRepository(
    createSqliteSqlClient(database),
  );
  const sharedInput = {
    type: "cash_deposit" as const,
    portfolioSecurityId: null,
    quantityDecimal: null,
    unitPriceDecimal: null,
    grossAmountDecimal: "10",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual" as const,
    idempotencyKey: "shared-key",
    tradeAt: "2026-08-01T10:00:00Z",
    localTradeDate: "2026-08-01",
    currencyCode: "USD",
    requestId: "shared-request",
  };

  success(
    await repository.post("user-a", {
      ...sharedInput,
      portfolioId: "portfolio-a",
    }),
  );
  success(
    await repository.post("user-b", {
      ...sharedInput,
      portfolioId: "portfolio-b",
    }),
  );

  assert.equal(
    present(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM transactions WHERE idempotency_key = 'shared-key'",
        )
        .get() as { count: number } | undefined,
    ).count,
    2,
  );
});

test("rejects impossible calendar dates before posting", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedLedgerRepository(
    createSqliteSqlClient(database),
  );
  const result = await repository.post(
    "user-a",
    input({ localTradeDate: "2026-02-30", idempotencyKey: "bad-date" }),
  );
  assert.deepEqual(result, { ok: false, reason: "invalid_date" });
});

test("reversal and supersession preserve source facts and rebuild markers", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedLedgerRepository(
    createSqliteSqlClient(database),
  );
  const original = success(await repository.post("user-a", input()));
  const reversed = success(
    await repository.reverse(
      "user-a",
      "portfolio-a",
      original.transaction.id,
      "reverse-1",
      "request-reverse",
    ),
  );
  assert.equal(
    reversed.transaction.reversesTransactionId,
    original.transaction.id,
  );
  assert.equal(reversed.cashEntry?.signedAmountDecimal, "22.25");
  const reversalRetry = success(
    await repository.reverse(
      "user-a",
      "portfolio-a",
      original.transaction.id,
      "reverse-1",
      "request-reverse-retry",
    ),
  );
  assert.equal(reversalRetry.idempotent, true);
  assert.equal(reversalRetry.transaction.id, reversed.transaction.id);
  assert.equal(
    present(
      database
        .prepare("SELECT status FROM transactions WHERE id = ?")
        .get(original.transaction.id) as { status: string } | undefined,
    ).status,
    "reversed",
  );

  const replacement = success(
    await repository.post(
      "user-a",
      input({ idempotencyKey: "replacement-1", unitPriceDecimal: "11" }),
    ),
  );
  assert.equal(replacement.transaction.grossAmountDecimal, "22");
  const superseded = success(
    await repository.supersede(
      "user-a",
      "portfolio-a",
      replacement.transaction.id,
      input({ idempotencyKey: "replacement-2", unitPriceDecimal: "12" }),
    ),
  );
  assert.equal(
    superseded.transaction.supersedesTransactionId,
    replacement.transaction.id,
  );
  const supersessionRetry = success(
    await repository.supersede(
      "user-a",
      "portfolio-a",
      replacement.transaction.id,
      input({ idempotencyKey: "replacement-2", unitPriceDecimal: "12" }),
    ),
  );
  assert.equal(supersessionRetry.idempotent, true);
  assert.equal(supersessionRetry.transaction.id, superseded.transaction.id);
  assert.equal(
    present(
      database
        .prepare("SELECT COUNT(*) AS count FROM calculation_runs")
        .get() as { count: number } | undefined,
    ).count,
    4,
  );
});

test("atomic failure leaves no financial, audit, or invalidation row", async () => {
  const database = await migratedDatabase();
  const baseClient = createSqliteSqlClient(database);
  const failingClient = {
    ...baseClient,
    batch: async () => {
      throw new Error("injected audit failure");
    },
  };
  const repository = createOwnedLedgerRepository(failingClient);
  const failed = await repository.post("user-a", input());
  assert.deepEqual(failed, { ok: false, reason: "atomic_failure" });
  assert.equal(
    present(
      database.prepare("SELECT COUNT(*) AS count FROM transactions").get() as
        { count: number } | undefined,
    ).count,
    0,
  );
  assert.equal(
    present(
      database
        .prepare("SELECT COUNT(*) AS count FROM cash_ledger_entries")
        .get() as { count: number } | undefined,
    ).count,
    0,
  );
  assert.equal(
    present(
      database.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as
        { count: number } | undefined,
    ).count,
    0,
  );
  assert.equal(
    present(
      database
        .prepare("SELECT COUNT(*) AS count FROM calculation_runs")
        .get() as { count: number } | undefined,
    ).count,
    0,
  );
});
