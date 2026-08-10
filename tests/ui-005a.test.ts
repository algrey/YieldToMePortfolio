import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  loadOwnedPortfolioInspection,
  loadPortfolioInspectionSafely,
} from "../db/repositories/portfolio-inspection.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";

function renderInspectionStates(): {
  empty: string;
  unavailable: string;
  populated: string;
} {
  const componentUrl = new URL(
    "../app/components/portfolio-details.tsx",
    import.meta.url,
  ).href;
  const fixtureUrl = new URL("./fixtures/ui-005a.ts", import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { OwnedPortfolioDetails } from ${JSON.stringify(componentUrl)};
    import { UI_005A_INSPECTION_FIXTURE } from ${JSON.stringify(fixtureUrl)};
    const render = (inspection) => renderToStaticMarkup(
      createElement(OwnedPortfolioDetails, { inspection, onOpenSettings() {} }),
    );
    const emptyInspection = {
      ...UI_005A_INSPECTION_FIXTURE,
      transactions: [], lots: [], allocations: [], cashAccounts: [], cashEntries: [],
      truncated: { transactions: false, lots: false, allocations: false, cashEntries: false },
    };
    process.stdout.write(JSON.stringify({
      empty: render(emptyInspection),
      unavailable: render(null),
      populated: render(UI_005A_INSPECTION_FIXTURE),
    }));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    ),
  ) as { empty: string; unavailable: string; populated: string };
}

async function database(): Promise<DatabaseSync> {
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
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, default_holding_currency_view, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', 'home', '2026-08-03', '2026-08-03', 3),
           ('user-b', 'AUD', 'Australia/Sydney', 'native', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 2),
           ('portfolio-b', 'user-b', 'B', 'Bob', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, created_at, updated_at)
    VALUES ('security-a', 'equity', 'AUD', 'ABC Holdings', '2026-08-03', '2026-08-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-08-03', '2026-08-03');
    INSERT INTO calculation_runs (
      id, user_id, portfolio_id, range_from, range_to, calculation_version,
      reason, status, ledger_high_water_start, idempotency_key, created_at, updated_at
    ) VALUES (
      'run-a', 'user-a', 'portfolio-a', '2026-08-01', '2026-08-03', 4,
      'transaction_change', 'completed', 'tx-sell', 'run-key-a', '2026-08-03', '2026-08-03'
    );
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status,
      trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
      currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal,
      source_type, source_reference, created_by_user_id, calculation_version, created_at
    ) VALUES
      ('tx-buy', 'user-a', 'portfolio-a', 'membership-a', 'buy', 'posted',
       '2026-08-01T10:00:00Z', '2026-08-01', '1.500', '10.25',
       'AUD', '15.375', '0.125', '0', 'manual', 'manual-buy', 'user-a', 4, '2026-08-01'),
      ('tx-sell', 'user-a', 'portfolio-a', 'membership-a', 'sell', 'posted',
       '2026-08-02T10:00:00Z', '2026-08-02', '0.500', '11',
       'AUD', '5.50', '0', '0', 'csv_import', 'row-2', 'user-a', 4, '2026-08-02');
    INSERT INTO cash_accounts (id, user_id, portfolio_id, currency_code, completeness, status)
    VALUES ('cash-a', 'user-a', 'portfolio-a', 'AUD', 'incomplete', 'active');
    INSERT INTO cash_ledger_entries (
      id, user_id, portfolio_id, cash_account_id, transaction_id, effective_at,
      local_effective_date, type, signed_amount_decimal, status, created_at
    ) VALUES
      ('cash-entry-a', 'user-a', 'portfolio-a', 'cash-a', 'tx-buy', '2026-08-01T10:01:00Z', '2026-08-01', 'cash_withdrawal', '-15.500', 'posted', '2026-08-01'),
      ('cash-entry-b', 'user-a', 'portfolio-a', 'cash-a', 'tx-sell', '2026-08-02T10:01:00Z', '2026-08-02', 'cash_deposit', '5.50', 'posted', '2026-08-02');
      INSERT INTO cash_ledger_entries (
        id, user_id, portfolio_id, cash_account_id, effective_at,
        local_effective_date, type, signed_amount_decimal, status,
        reverses_entry_id, created_at
      ) VALUES (
        'cash-entry-reversed', 'user-a', 'portfolio-a', 'cash-a',
        '2026-08-03T10:01:00Z', '2026-08-03', 'cash_withdrawal',
        '15.500', 'reversed', 'cash-entry-a', '2026-08-03'
      );
    INSERT INTO tax_lots (
      id, user_id, portfolio_id, portfolio_security_id, opening_transaction_id,
      acquired_at, original_quantity_decimal, open_quantity_decimal,
      native_basis_decimal, base_basis_decimal, basis_status, status,
      calculation_run_id, calculation_version, rebuilt_at
    ) VALUES (
      'lot-a', 'user-a', 'portfolio-a', 'membership-a', 'tx-buy',
      '2026-08-01T10:00:00Z', '1.500', '1.000', '15.500', '15.500',
      'complete', 'open', 'run-a', 4, '2026-08-03T01:00:00Z'
    );
    INSERT INTO lot_allocations (
      id, user_id, portfolio_id, portfolio_security_id, sell_transaction_id,
      tax_lot_id, allocation_sequence, matched_quantity_decimal,
      allocated_base_basis_decimal, base_net_proceeds_decimal,
      fee_base_decimal, tax_base_decimal, base_realised_gain_decimal,
      basis_status, calculation_run_id, calculation_version
    ) VALUES (
      'allocation-a', 'user-a', 'portfolio-a', 'membership-a', 'tx-sell',
      'lot-a', 1, '0.500', '5.1666666667', '5.50', '0', '0', '0.3333333333',
      'complete', 'run-a', 4
    );
  `);
  return database;
}

test("portfolio inspection stays owner-scoped and preserves exact source decimals", async () => {
  const db = await database();
  const client = createSqliteSqlClient(db);
  const inspection = await loadOwnedPortfolioInspection(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.notEqual(inspection, null);
  assert.equal(inspection?.settings?.defaultHoldingCurrencyView, "home");
  assert.equal(inspection?.transactions[0]?.quantityDecimal, "0.500");
  assert.equal(inspection?.lots[0]?.openQuantityDecimal, "1.000");
  assert.equal(inspection?.cashAccounts[0]?.balanceDecimal, "-10");
  assert.equal(inspection?.cashAccounts[0]?.balanceStatus, "complete");
  assert.equal(
    inspection?.cashEntries.find((entry) => entry.status === "reversed")
      ?.signedAmountDecimal,
    "15.500",
  );
  assert.equal(inspection?.allocations[0]?.matchedQuantityDecimal, "0.500");
  assert.equal(
    inspection?.transactions.every(
      (transaction) => transaction.sourceReference !== "row-other",
    ),
    true,
  );
  assert.equal(
    await loadOwnedPortfolioInspection(client, "user-b", "portfolio-a"),
    null,
  );
  db.close();
});

test("portfolio inspection does not present a partial cash balance", async () => {
  const db = await database();
  const statement = db.prepare(`
    INSERT INTO cash_ledger_entries (
      id, user_id, portfolio_id, cash_account_id, effective_at,
      local_effective_date, type, signed_amount_decimal, status, created_at
    ) VALUES (?, 'user-a', 'portfolio-a', 'cash-a', ?, '2026-08-04',
      'cash_deposit', '1', 'posted', '2026-08-04')
  `);
  for (let index = 0; index < 201; index += 1) {
    const id = `cash-entry-extra-${index}`;
    statement.run(id, `2026-08-04T00:${String(index).padStart(2, "0")}:00Z`);
  }
  const inspection = await loadOwnedPortfolioInspection(
    createSqliteSqlClient(db),
    "user-a",
    "portfolio-a",
  );
  assert.equal(inspection?.truncated.cashEntries, true);
  assert.equal(inspection?.cashEntries.length, 200);
  assert.equal(inspection?.cashAccounts[0]?.balanceDecimal, null);
  assert.equal(inspection?.cashAccounts[0]?.balanceStatus, "window_incomplete");
  db.close();
});

test("inspection boundaries are exact and failures return the safe unavailable state", async () => {
  const db = await database();
  const statement = db.prepare(`
    INSERT INTO cash_ledger_entries (
      id, user_id, portfolio_id, cash_account_id, effective_at,
      local_effective_date, type, signed_amount_decimal, status, created_at
    ) VALUES (?, 'user-a', 'portfolio-a', 'cash-a', ?, '2026-08-04',
      'cash_deposit', '1', 'posted', '2026-08-04')
  `);
  for (let index = 0; index < 197; index += 1) {
    statement.run(
      `cash-entry-boundary-${index}`,
      `2026-08-04T00:${String(index).padStart(3, "0")}:00Z`,
    );
  }
  const complete = await loadOwnedPortfolioInspection(
    createSqliteSqlClient(db),
    "user-a",
    "portfolio-a",
  );
  assert.equal(complete?.cashEntries.length, 200);
  assert.equal(complete?.truncated.cashEntries, false);
  assert.equal(complete?.cashAccounts[0]?.balanceDecimal, "187");
  statement.run("cash-entry-boundary-overflow", "2026-08-05T00:00:00Z");
  const incomplete = await loadOwnedPortfolioInspection(
    createSqliteSqlClient(db),
    "user-a",
    "portfolio-a",
  );
  assert.equal(incomplete?.cashEntries.length, 200);
  assert.equal(incomplete?.truncated.cashEntries, true);
  assert.equal(incomplete?.cashAccounts[0]?.balanceDecimal, null);

  const failingClient: SqlClient = {
    async all() {
      throw new Error("injected read failure");
    },
    async get() {
      throw new Error("injected read failure");
    },
    async run() {
      throw new Error("unexpected mutation");
    },
    async batch() {
      throw new Error("unexpected batch write");
    },
  };
  assert.equal(
    await loadPortfolioInspectionSafely(failingClient, "user-a", "portfolio-a"),
    null,
  );
  db.close();
});

test("empty and unavailable details render explicit read-only states", async () => {
  const db = await database();
  const client = createSqliteSqlClient(db);
  const empty = await loadOwnedPortfolioInspection(
    client,
    "user-b",
    "portfolio-b",
  );
  assert.ok(empty);
  if (!empty) return;
  assert.equal(empty.transactions.length, 0);
  assert.equal(empty.cashAccounts.length, 0);
  const markup = renderInspectionStates();
  const emptyMarkup = markup.empty;
  assert.match(emptyMarkup, /No transactions are recorded/);
  assert.match(emptyMarkup, /No FIFO lots are available/);
  assert.match(emptyMarkup, /No cash account is recorded/);
  assert.doesNotMatch(emptyMarkup, /<input\b|contenteditable=/i);

  const unavailableMarkup = markup.unavailable;
  assert.match(unavailableMarkup, /Ledger details unavailable/);
  assert.match(unavailableMarkup, /No other owner’s data is shown/);

  const populatedMarkup = markup.populated;
  assert.match(populatedMarkup, /balance unavailable/);
  assert.match(populatedMarkup, /bounded inspection window/);
  assert.match(populatedMarkup, /Showing first 200 lots or matches/);
  assert.match(populatedMarkup, /Showing first 200 entries/);
  db.close();
});

test("details UI is read-only, provenance-explicit, and linked to separate entry workflow", async () => {
  const [component, page, manualRoute, repository, styles] = await Promise.all([
    readFile(
      new URL("../app/components/portfolio-details.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/[section]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/ledger/new/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../db/repositories/portfolio-inspection.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /Portfolio settings/);
  assert.match(component, /Transactions/);
  assert.match(component, /Tax lots/);
  assert.match(component, /Cash entries/);
  assert.match(component, /Manual entry and corrections/);
  assert.match(component, /<details className="inspection-evidence">/);
  assert.match(component, /bounded inspection window/);
  assert.doesNotMatch(component, /<input\b|contentEditable/);
  assert.match(page, /loadAuthenticatedPortfolioInspection/);
  assert.match(manualRoute, /loadAuthenticatedWorkspace\(portfolioId\)/);
  assert.match(manualRoute, /workspace\.activePortfolio === null/);
  assert.match(manualRoute, /ManualLedgerEntry/);
  assert.match(manualRoute, /getAuthenticatedSqlContext/);
  assert.doesNotMatch(manualRoute, /Manual entry is not available yet/);
  assert.match(repository, /t\.user_id = \? AND t\.portfolio_id = \?/);
  assert.match(repository, /l\.user_id = \? AND l\.portfolio_id = \?/);
  assert.match(repository, /e\.user_id = \? AND e\.portfolio_id = \?/);
  assert.match(
    styles,
    /\.inspection-evidence summary\s*{[^}]*min-height: 44px/s,
  );
  assert.match(
    styles,
    /\.manual-workflow-placeholder\s*{[^}]*width: min\(calc\(100% - 32px\), 760px\)/s,
  );
});
