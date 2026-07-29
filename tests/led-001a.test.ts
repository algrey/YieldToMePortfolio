import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  isCanonicalDecimal,
  validateCashLedgerEntry,
  validateLedgerTransaction,
} from "../domain/ledger/index.ts";

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    database.exec(
      await readFile(
        new URL(`../drizzle/${migrationFile}`, import.meta.url),
        "utf8",
      ),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (
      id, status, primary_email, timezone, created_at, updated_at, version
    ) VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, created_at, updated_at, version
    ) VALUES
      ('user-a', 'AUD', 'Australia/Sydney', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'USD', 'Australia/Sydney', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      accounting_method, status, created_at, updated_at, version
    ) VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('portfolio-b', 'user-b', 'B', 'Bob', 'USD', 'Australia/Sydney', 'fifo', 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
    INSERT INTO cash_accounts (
      id, user_id, portfolio_id, currency_code, completeness, status
    ) VALUES ('cash-a', 'user-a', 'portfolio-a', 'AUD', 'complete', 'active');
  `);
  return database;
}

type SqlFixtureValue = string | number | null;

function validTransaction(
  overrides: Record<string, SqlFixtureValue> = {},
): Record<string, SqlFixtureValue> {
  return {
    id: "transaction-a",
    user_id: "user-a",
    portfolio_id: "portfolio-a",
    portfolio_security_id: null,
    type: "cash_deposit",
    status: "posted",
    trade_at: "2026-07-29T00:00:00Z",
    local_trade_date: "2026-07-29",
    quantity_decimal: null,
    unit_price_decimal: null,
    currency_code: "AUD",
    gross_amount_decimal: "1000",
    fee_amount_decimal: "0",
    tax_amount_decimal: "0",
    fx_rate_to_base_decimal: null,
    source_type: "manual",
    reverses_transaction_id: null,
    supersedes_transaction_id: null,
    created_by_user_id: "user-a",
    calculation_version: 1,
    created_at: "2026-07-29T00:00:00Z",
    ...overrides,
  };
}

function insertTransaction(
  database: DatabaseSync,
  values: Record<string, SqlFixtureValue>,
) {
  database
    .prepare(
      `
        INSERT INTO transactions (
          id, user_id, portfolio_id, portfolio_security_id, type, status,
          trade_at, local_trade_date, settlement_date, quantity_decimal,
          unit_price_decimal, currency_code, gross_amount_decimal,
          fee_amount_decimal, tax_amount_decimal, fx_rate_to_base_decimal,
          fx_rate_source, fx_observed_at, source_type, source_reference,
          import_row_id, reverses_transaction_id, supersedes_transaction_id,
          created_by_user_id, calculation_version, created_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      values.id,
      values.user_id,
      values.portfolio_id,
      values.portfolio_security_id,
      values.type,
      values.status,
      values.trade_at,
      values.local_trade_date,
      null,
      values.quantity_decimal,
      values.unit_price_decimal,
      values.currency_code,
      values.gross_amount_decimal,
      values.fee_amount_decimal,
      values.tax_amount_decimal,
      null,
      null,
      null,
      values.source_type,
      null,
      null,
      values.reverses_transaction_id,
      values.supersedes_transaction_id,
      values.created_by_user_id,
      values.calculation_version,
      values.created_at,
      1,
    );
}

test("ledger decimal and event validators reject unsafe shapes", () => {
  assert.equal(isCanonicalDecimal("123.4500"), true);
  assert.equal(isCanonicalDecimal("01.2"), false);
  assert.equal(isCanonicalDecimal("1e3"), false);
  assert.equal(isCanonicalDecimal("-1"), false);

  const valid = validateLedgerTransaction({
    type: "buy",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "2.5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "25",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: "1.1",
    sourceType: "manual",
  });
  assert.deepEqual(valid, { ok: true });
  assert.deepEqual(
    validateCashLedgerEntry({
      type: "cash_deposit",
      signedAmountDecimal: "100",
    }),
    { ok: true },
  );
  assert.deepEqual(
    validateCashLedgerEntry({
      type: "fee",
      signedAmountDecimal: "100",
    }),
    { ok: false, reason: "wrong-sign" },
  );

  const invalid = validateLedgerTransaction({
    type: "buy",
    portfolioSecurityId: null,
    quantityDecimal: "0",
    unitPriceDecimal: "1e2",
    grossAmountDecimal: null,
    feeAmountDecimal: "-1",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: "0",
    sourceType: "manual",
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.deepEqual(
      invalid.issues.map((issue) => issue.code),
      [
        "invalid-decimal",
        "invalid-decimal",
        "missing-security",
        "non-positive-quantity",
        "non-positive-fx-rate",
      ],
    );
  }
});

test("ledger tables enforce owner, portfolio, membership, import, and self-reference boundaries", async () => {
  const database = await createMigratedDatabase();
  insertTransaction(database, validTransaction());

  database
    .prepare(
      `
        INSERT INTO cash_ledger_entries (
          id, user_id, portfolio_id, cash_account_id, transaction_id,
          effective_at, local_effective_date, type, signed_amount_decimal,
          status, reverses_entry_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `,
    )
    .run(
      "cash-entry-a",
      "user-a",
      "portfolio-a",
      "cash-a",
      "transaction-a",
      "2026-07-29T00:00:00Z",
      "2026-07-29",
      "cash_deposit",
      "1000",
      "posted",
      "2026-07-29T00:00:00Z",
    );

  assert.throws(() => {
    insertTransaction(
      database,
      validTransaction({
        id: "transaction-cross-owner",
        user_id: "user-b",
        portfolio_id: "portfolio-a",
        created_by_user_id: "user-b",
      }),
    );
  }, /FOREIGN KEY constraint failed/);

  assert.throws(() => {
    insertTransaction(
      database,
      validTransaction({
        id: "transaction-cross-actor",
        created_by_user_id: "user-b",
      }),
    );
  }, /CHECK constraint failed: transactions_created_by_owner_check/);

  assert.throws(() => {
    database
      .prepare(
        `
          INSERT INTO cash_ledger_entries (
            id, user_id, portfolio_id, cash_account_id, transaction_id,
            effective_at, local_effective_date, type, signed_amount_decimal,
            status, created_at
          ) VALUES ('cash-cross-owner', 'user-b', 'portfolio-a', 'cash-a',
                    'transaction-a', '2026-07-29T00:00:00Z', '2026-07-29',
                    'cash_withdrawal', '5', 'posted', '2026-07-29T00:00:00Z')
        `,
      )
      .run();
  }, /FOREIGN KEY constraint failed/);

  assert.throws(() => {
    database
      .prepare(
        `
          INSERT INTO transactions (
            id, user_id, portfolio_id, type, status, trade_at,
            local_trade_date, currency_code, gross_amount_decimal,
            fee_amount_decimal, tax_amount_decimal, source_type,
            reverses_transaction_id, created_by_user_id,
            calculation_version, created_at, version
          ) VALUES ('transaction-reversal', 'user-b', 'portfolio-b',
                    'cash_deposit', 'posted', '2026-07-29T00:00:00Z',
                    '2026-07-29', 'USD', '1', '0', '0', 'manual',
                    'transaction-a', 'user-b', 1, '2026-07-29T00:00:00Z', 1)
        `,
      )
      .run();
  }, /FOREIGN KEY constraint failed/);

  insertTransaction(
    database,
    validTransaction({
      id: "transaction-reversal-1",
      reverses_transaction_id: "transaction-a",
    }),
  );
  assert.throws(() => {
    insertTransaction(
      database,
      validTransaction({
        id: "transaction-reversal-2",
        reverses_transaction_id: "transaction-a",
      }),
    );
  }, /UNIQUE constraint failed: transactions\.reverses_transaction_id/);

  insertTransaction(
    database,
    validTransaction({
      id: "transaction-supersession-1",
      supersedes_transaction_id: "transaction-a",
    }),
  );
  assert.throws(() => {
    insertTransaction(
      database,
      validTransaction({
        id: "transaction-supersession-2",
        supersedes_transaction_id: "transaction-a",
      }),
    );
  }, /UNIQUE constraint failed: transactions\.supersedes_transaction_id/);
});
