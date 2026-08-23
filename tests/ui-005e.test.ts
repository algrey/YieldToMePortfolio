import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  postManualLedgerWithContext,
  reverseManualLedgerWithContext,
} from "../app/manual-ledger-actions.ts";
import {
  createManualLedgerPortfolioPost,
  createManualLedgerTransactionPost,
} from "../app/manual-ledger-route.ts";
import {
  parseManualLedgerForm,
  previewFromPrepared,
  type ManualLedgerFormValue,
} from "../app/manual-ledger-contract.ts";
import {
  createManualLedgerMutationKeyRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  LEDGER_INVENTORY_LIMITS,
  type SqlClient,
} from "../db/repositories/index.ts";
import { prepareLedgerPosting } from "../domain/ledger/posting.ts";
import type { LedgerPostingInput } from "../domain/ledger/posting.ts";

const base: ManualLedgerFormValue = {
  type: "buy",
  portfolioSecurityId: "membership-a",
  quantityDecimal: "2",
  unitPriceDecimal: "10.25",
  grossAmountDecimal: "20.50",
  feeAmountDecimal: "1.25",
  taxAmountDecimal: "0.50",
  currencyCode: "USD",
  tradeAt: "2026-08-03T10:00:00.000Z",
  localTradeDate: "2026-08-03",
  settlementDate: "2026-08-05",
  fxRateToBaseDecimal: null,
  fxRateSource: null,
  fxObservedAt: null,
  sourceReference: null,
};

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
           ('portfolio-b', 'user-b', 'B', 'Bob', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'ABC', 'USD', 'unresolved', '2026-08-03', '2026-08-03'),
           ('membership-b', 'user-b', 'portfolio-b', 'ABC', 'USD', 'unresolved', '2026-08-03', '2026-08-03');
  `);
  return database;
}

function context(database: DatabaseSync, userId = "user-a") {
  return {
    client: createSqliteSqlClient(database),
    userId,
    requestId: `request-${userId}`,
  };
}

function posting(
  idempotencyKey: string,
  overrides: Partial<LedgerPostingInput> = {},
): LedgerPostingInput {
  return {
    portfolioId: "portfolio-a",
    type: "buy",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "1",
    unitPriceDecimal: "10",
    grossAmountDecimal: "10",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey,
    tradeAt: "2026-08-01T10:00:00Z",
    localTradeDate: "2026-08-01",
    settlementDate: null,
    currencyCode: "USD",
    requestId: `request-${idempotencyKey}`,
    ...overrides,
  };
}

async function issue(
  database: DatabaseSync,
  purpose: "create" | "reverse" | "supersede",
  targetTransactionId: string | null = null,
): Promise<string> {
  const issued = await createManualLedgerMutationKeyRepository(
    createSqliteSqlClient(database),
  ).issue("user-a", "portfolio-a", purpose, targetTransactionId);
  assert.ok(issued);
  return issued.key;
}

test("manual contract supports approved types and fails closed at exact boundaries", () => {
  for (const type of [
    "buy",
    "sell",
    "cash_deposit",
    "cash_withdrawal",
    "fee",
    "tax",
    "split",
  ]) {
    const input =
      type === "split"
        ? {
            ...base,
            type,
            grossAmountDecimal: null,
            quantityDecimal: "3",
            unitPriceDecimal: "2",
            feeAmountDecimal: "0",
            taxAmountDecimal: "0",
          }
        : type === "buy" || type === "sell"
          ? { ...base, type }
          : {
              ...base,
              type,
              portfolioSecurityId: null,
              quantityDecimal: null,
              unitPriceDecimal: null,
              grossAmountDecimal: "10",
            };
    assert.equal(
      parseManualLedgerForm(
        input,
        "portfolio-a",
        "request-a",
        "manual-ledger:key",
      ).ok,
      true,
      type,
    );
  }
  const deferred = parseManualLedgerForm(
    { ...base, type: "dividend" },
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(deferred.ok, false);
  assert.match(deferred.ok ? "" : deferred.message, /Transfers and dividends/);

  for (const invalid of [
    { ...base, localTradeDate: "2026-02-30" },
    { ...base, tradeAt: "2026-02-30T10:00:00.000Z" },
    { ...base, settlementDate: "2026-02-30" },
  ]) {
    assert.equal(
      parseManualLedgerForm(
        invalid,
        "portfolio-a",
        "request-a",
        "manual-ledger:key",
      ).ok,
      false,
    );
  }
  const invalidDecimal = parseManualLedgerForm(
    { ...base, quantityDecimal: "1e2" },
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(invalidDecimal.ok, true);
  if (invalidDecimal.ok) {
    assert.equal(prepareLedgerPosting(invalidDecimal.input).ok, false);
  }
});

test("manual preview retains exact amounts and explicit missing FX", () => {
  const parsed = parseManualLedgerForm(
    base,
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const prepared = prepareLedgerPosting(parsed.input);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const preview = previewFromPrepared(
    "buy",
    parsed.input,
    prepared.posting,
    "AUD",
  );
  assert.equal(preview.grossAmountDecimal, "20.5");
  assert.equal(preview.cashEffectDecimal, "-22.25");
  assert.equal(preview.fxStatus, "unavailable");
});

test("server-issued keys bind create, reverse, and replacement retries to one owner and target", async () => {
  const database = await migratedDatabase();
  const createKey = await issue(database, "create");
  const value = { ...base, idempotencyKey: createKey };
  const created = await postManualLedgerWithContext(
    context(database),
    "portfolio-a",
    value,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const retry = await postManualLedgerWithContext(
    context(database),
    "portfolio-a",
    value,
  );
  assert.equal(retry.ok, true);
  assert.equal(retry.ok && retry.mutation.idempotent, true);
  const consumedKey = database
    .prepare(
      "SELECT status, result_transaction_id FROM manual_ledger_mutation_keys WHERE key = ?",
    )
    .get(createKey) as {
    status: string;
    result_transaction_id: string;
  };
  assert.equal(consumedKey.status, "used");
  assert.equal(
    consumedKey.result_transaction_id,
    created.mutation.transaction.id,
  );

  const forged = await postManualLedgerWithContext(
    context(database),
    "portfolio-a",
    { ...base, idempotencyKey: "manual-ledger:forged" },
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.ok ? 0 : forged.status, 409);
  const otherOwner = await postManualLedgerWithContext(
    context(database, "user-b"),
    "portfolio-a",
    value,
  );
  assert.equal(otherOwner.ok, false);

  const reverseKey = await issue(
    database,
    "reverse",
    created.mutation.transaction.id,
  );
  const missingReverseKey = await reverseManualLedgerWithContext(
    context(database),
    "portfolio-a",
    created.mutation.transaction.id,
    "",
  );
  assert.equal(missingReverseKey.ok, false);
  const crossTargetKey = await reverseManualLedgerWithContext(
    context(database),
    "portfolio-a",
    "another-transaction",
    reverseKey,
  );
  assert.equal(crossTargetKey.ok, false);
  const reversed = await reverseManualLedgerWithContext(
    context(database),
    "portfolio-a",
    created.mutation.transaction.id,
    reverseKey,
  );
  assert.equal(reversed.ok, true);
  const reversedRetry = await reverseManualLedgerWithContext(
    context(database),
    "portfolio-a",
    created.mutation.transaction.id,
    reverseKey,
  );
  assert.equal(reversedRetry.ok, true);
  assert.equal(reversedRetry.ok && reversedRetry.mutation.idempotent, true);

  const secondCreateKey = await issue(database, "create");
  const second = await postManualLedgerWithContext(
    context(database),
    "portfolio-a",
    {
      ...base,
      tradeAt: "2026-08-04T10:00:00.000Z",
      localTradeDate: "2026-08-04",
      settlementDate: null,
      idempotencyKey: secondCreateKey,
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const replacementKey = await issue(
    database,
    "supersede",
    second.mutation.transaction.id,
  );
  const replacement = await postManualLedgerWithContext(
    context(database),
    "portfolio-a",
    {
      ...base,
      quantityDecimal: "3",
      grossAmountDecimal: "30.75",
      tradeAt: "2026-08-04T10:00:00.000Z",
      localTradeDate: "2026-08-04",
      settlementDate: null,
      idempotencyKey: replacementKey,
    },
    second.mutation.transaction.id,
  );
  assert.equal(replacement.ok, true);
  assert.equal(
    (
      database
        .prepare("SELECT status FROM transactions WHERE id = ?")
        .get(second.mutation.transaction.id) as { status: string }
    ).status,
    "superseded",
  );
  assert.equal(
    replacement.ok && replacement.mutation.transaction.supersedesTransactionId,
    second.mutation.transaction.id,
  );
});

test("route boundary enforces CSRF, private responses, ownership, and double submit", async () => {
  const database = await migratedDatabase();
  const key = await issue(database, "create");
  const action = async (portfolioId: string, value: unknown) =>
    postManualLedgerWithContext(
      context(database),
      portfolioId,
      value as ManualLedgerFormValue,
    );
  const route = createManualLedgerPortfolioPost(action);
  let actionCalled = false;
  const blockedRoute = createManualLedgerPortfolioPost(async () => {
    actionCalled = true;
    return { ok: false, status: 503, message: "unexpected" };
  });
  const blocked = await blockedRoute(
    new Request("https://example.test/api/portfolios/portfolio-a/ledger", {
      method: "POST",
      headers: {
        origin: "https://attacker.test",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ ...base, idempotencyKey: key }),
    }),
    { params: Promise.resolve({ portfolioId: "portfolio-a" }) },
  );
  assert.equal(blocked.status, 403);
  assert.equal(actionCalled, false);

  const request = () =>
    new Request("https://example.test/api/portfolios/portfolio-a/ledger", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...base, idempotencyKey: key }),
    });
  const first = await route(request(), {
    params: Promise.resolve({ portfolioId: "portfolio-a" }),
  });
  const retry = await route(request(), {
    params: Promise.resolve({ portfolioId: "portfolio-a" }),
  });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  const retryBody = (await retry.json()) as {
    mutation: { idempotent: boolean };
  };
  assert.equal(retryBody.mutation.idempotent, true);

  const hiddenRoute = createManualLedgerPortfolioPost(async () => ({
    ok: false,
    status: 404,
    message: "Not found.",
  }));
  const hidden = await hiddenRoute(request(), {
    params: Promise.resolve({ portfolioId: "portfolio-b" }),
  });
  assert.equal(hidden.status, 404);

  const reverseRoute = createManualLedgerTransactionPost(async () => ({
    ok: false,
    status: 409,
    message: "A server-issued key is required.",
  }));
  const missingKey = await reverseRoute(request(), {
    params: Promise.resolve({
      portfolioId: "portfolio-a",
      transactionId: "transaction-a",
    }),
  });
  assert.equal(missingKey.status, 409);
});

test("inventory validation handles more than 200 lots and rejects a later oversell", async () => {
  const database = await migratedDatabase();
  const insert = database.prepare(`
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at,
      local_trade_date, quantity_decimal, unit_price_decimal, currency_code,
      gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, source_type,
      idempotency_key, created_by_user_id, calculation_version, created_at, version
    ) VALUES (?, 'user-a', 'portfolio-a', 'membership-a', 'buy', 'posted', ?,
      '2026-07-01', '1', '1', 'USD', '1', '0', '0', 'manual', ?, 'user-a', 1,
      '2026-08-03', 1)
  `);
  const lotCount = LEDGER_INVENTORY_LIMITS.maxEvents - 500;
  for (let index = 0; index < lotCount; index += 1) {
    const id = `lot-${String(index).padStart(3, "0")}`;
    insert.run(id, "2026-07-01T00:00:00Z", id);
  }
  const baseClient = createSqliteSqlClient(database);
  let queryCount = 0;
  const client: SqlClient = {
    all(sql, params) {
      queryCount += 1;
      return baseClient.all(sql, params);
    },
    get(sql, params) {
      queryCount += 1;
      return baseClient.get(sql, params);
    },
    run(sql, params) {
      queryCount += 1;
      return baseClient.run(sql, params);
    },
    async batch(statements) {
      queryCount += statements.length;
      return baseClient.batch!(statements);
    },
  };
  const repository = createOwnedLedgerRepository(client);
  const sold = await repository.post(
    "user-a",
    posting("large-sell", {
      type: "sell",
      quantityDecimal: String(lotCount),
      grossAmountDecimal: String(lotCount * 10),
      tradeAt: "2026-08-01T10:00:00Z",
    }),
  );
  assert.equal(sold.ok, true);
  const oversell = await repository.post(
    "user-a",
    posting("large-oversell", {
      type: "sell",
      quantityDecimal: "0.00000001",
      grossAmountDecimal: null,
      tradeAt: "2026-08-01T11:00:00Z",
    }),
  );
  assert.deepEqual(oversell, { ok: false, reason: "oversell" });
  assert.equal(queryCount <= 50, true, `used ${queryCount} D1 operations`);
});

test("concurrent sales cannot both consume the same quantity", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedLedgerRepository(
    createSqliteSqlClient(database),
  );
  const bought = await repository.post("user-a", posting("concurrent-buy"));
  assert.equal(bought.ok, true);
  const [left, right] = await Promise.all([
    repository.post(
      "user-a",
      posting("concurrent-sell-a", {
        type: "sell",
        tradeAt: "2026-08-01T11:00:00Z",
      }),
    ),
    repository.post(
      "user-a",
      posting("concurrent-sell-b", {
        type: "sell",
        tradeAt: "2026-08-01T11:00:01Z",
      }),
    ),
  ]);
  assert.equal([left, right].filter((result) => result.ok).length, 1);
  assert.equal(
    [left, right].some((result) => !result.ok && result.reason === "oversell"),
    true,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM transactions WHERE type = 'sell' AND status = 'posted'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
});

test("rendered manual workflow remains labelled, keyboard-operable, and narrow-safe", async () => {
  const componentUrl = new URL(
    "../app/components/manual-ledger-entry.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    // UI-037: the heading's HistoryBackControl calls useRouter(), so this
    // static render mounts the same router stub qa-001b.test.ts uses.
    import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
    import { ManualLedgerEntry } from ${JSON.stringify(componentUrl)};
    const routerStub = {
      push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {},
    };
    process.stdout.write(renderToStaticMarkup(createElement(
      AppRouterContext.Provider, { value: routerStub },
      createElement(ManualLedgerEntry, {
        portfolioId: "portfolio-a", baseCurrencyCode: "AUD",
        initialIdempotencyKey: "manual-ledger:server-issued",
        options: { currencies: ["AUD", "USD"], securities: [
          { id: "membership-a", label: "ABC", currencyCode: "USD" }
        ] }
      }),
    )));
  `;
  const html = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.match(html, /<fieldset>/);
  assert.match(html, /Entry type/);
  assert.match(html, /Business date/);
  assert.match(html, /Exact trade time/);
  assert.match(html, /Post immutable ledger fact/);
  assert.match(html, /Server impact preview/);

  const [component, styles] = await Promise.all([
    readFile(
      new URL("../app/components/manual-ledger-entry.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /setCorrectionKey\([\s\S]*await fetch/);
  assert.match(component, /idempotencyKey: key/);
  assert.match(styles, /\.manual-ledger-grid input,[\s\S]*min-height: 44px/);
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.manual-ledger-grid[\s\S]*grid-template-columns: 1fr/,
  );
});
