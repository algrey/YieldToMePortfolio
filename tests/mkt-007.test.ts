// MKT-007: the `market_data_providers` registry row (`id='yahoo-compatible'`,
// `status='enabled'`) that `app/security-verification-service.ts` gates
// "Verify with market-data provider" on is now seeded by the hand-authored
// `drizzle/0037_steady_signal.sql` data-only migration instead of only ever
// existing in test fixtures. These tests prove:
//   1. the full migration chain alone (no test-fixture INSERT) produces the
//      row, enabled;
//   2. re-applying the seeding statement is a no-op (idempotent);
//   3. the row's presence does NOT itself turn verification on -- with the
//      row enabled but `MARKET_DATA_PROVIDER` unset, `resolveConfiguredProvider`
//      still falls back to the disabled provider stub and the request fails
//      closed with the explicit unavailable message, making no live network
//      call (see `app/security-verification-service.ts`'s
//      `resolveConfiguredProvider`: it dynamically imports `cloudflare:workers`,
//      which does not resolve under plain Node -- the same environment these
//      tests run in -- so this also exercises the "env var absent" path for
//      free, without needing to fake Worker bindings).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  verifySecurityCandidateWithContext,
  type SecurityVerifyActionContext,
} from "../app/security-verification-service.ts";
import type { ImportReviewPreview } from "../app/import-preview.ts";
import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";

async function readMigrationFile(name: string): Promise<string> {
  return readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
}

async function migrationFileNames(): Promise<string[]> {
  return (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
}

// Applies the full chain exactly as a fresh deployment would -- deliberately
// WITHOUT any test-fixture `INSERT INTO market_data_providers`, so the row
// asserted on below can only have come from the migration itself.
async function freshlyMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of await migrationFileNames()) {
    database.exec(await readMigrationFile(file));
  }
  return database;
}

test("full-chain migration seeds the yahoo-compatible provider row as enabled reference data, with no test fixture involved", async () => {
  const database = await freshlyMigratedDatabase();
  const row = database
    .prepare(
      `SELECT id, code, name, status, capabilities_json, rate_limit_json
         FROM market_data_providers WHERE id = 'yahoo-compatible'`,
    )
    .get() as
    | {
        id: string;
        code: string;
        name: string;
        status: string;
        capabilities_json: string;
        rate_limit_json: string;
      }
    | undefined;
  assert.ok(row, "expected the migration to seed the yahoo-compatible row");
  assert.equal(row!.code, "yahoo-best-effort");
  assert.equal(row!.status, "enabled");
  assert.equal(row!.capabilities_json, "{}");
  assert.equal(row!.rate_limit_json, "{}");
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS n FROM market_data_providers")
        .get() as { n: number }
    ).n,
    1,
  );
});

test("re-applying the seeding migration is idempotent (ON CONFLICT DO NOTHING, no duplicate/overwrite)", async () => {
  const database = await freshlyMigratedDatabase();
  // Mutate the row to prove a re-apply does not clobber it back to the
  // seeded values -- ON CONFLICT DO NOTHING must leave an already-present
  // row (whatever its current status) untouched, not silently reset it.
  database.exec(
    "UPDATE market_data_providers SET status = 'suspended' WHERE id = 'yahoo-compatible'",
  );
  database.exec(await readMigrationFile("0037_steady_signal.sql"));

  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS n FROM market_data_providers")
        .get() as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT status FROM market_data_providers WHERE id = 'yahoo-compatible'",
        )
        .get() as { status: string }
    ).status,
    "suspended",
    "ON CONFLICT DO NOTHING must not overwrite an existing row",
  );
});

// Mirrors `normalizedRow`/`stageRow` in `tests/imp-004b.test.ts` -- the
// import-preview builder requires this full normalized-row shape (trade
// fields included) to classify the row as a genuine unresolved security
// candidate; a partial/invented shape does not reliably reach that state.
function normalizedNewSymbolRow() {
  return {
    id: "source-1",
    symbol: "NEW",
    name: "New Co",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "5",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01 GMT+1000",
    transactionTime: "10:00:00",
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-01T00:00:00.000Z",
    localTradeDate: "2026-08-01",
    cashEvent: null,
  };
}

function seedVerifyFixture(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-11', '2026-08-11', 1);
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, 'file-a', 'parsed',
      '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', 1);
  `);
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES ('row-1', 'user-a', 'batch-a', 2, 'transaction', '[]', ?,
         'fingerprint-row-1', 'valid', NULL, 'staged', '2026-08-11', '2026-08-11', 1)`,
    )
    .run(JSON.stringify(normalizedNewSymbolRow()));
}

async function currentReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
                source_currency_code, security_id
           FROM portfolio_securities WHERE user_id = ?
          ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
  );
  const { buildImportReviewPreview } = await import("../app/import-preview.ts");
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates: candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    })),
  });
}

test("activation gate: row enabled + MARKET_DATA_PROVIDER unset still fails closed via the disabled provider stub, with no live network call", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("no live network call should occur in this test");
  }) as typeof fetch;
  try {
    const database = await freshlyMigratedDatabase();
    seedVerifyFixture(database);
    // Confirm the guard's precondition: the migration-seeded row really is
    // enabled going into this call (this test does not touch it further),
    // so the 503 "not available for this deployment" pre-check at
    // `security-verification-service.ts` (which only fires when the row is
    // missing/disabled) is NOT what should produce the failure here -- the
    // env-driven disabled-provider stub is.
    assert.equal(
      (
        database
          .prepare(
            "SELECT status FROM market_data_providers WHERE id = 'yahoo-compatible'",
          )
          .get() as { status: string }
      ).status,
      "enabled",
    );

    const client = createSqliteSqlClient(database);
    const context: SecurityVerifyActionContext = { client, userId: "user-a" };
    const review = await currentReview(client, "user-a", "batch-a");

    // No `options.provider` override: this exercises the real
    // `resolveConfiguredProvider(context.client)` path used in production,
    // which reads `MARKET_DATA_PROVIDER` from the Worker env. Under plain
    // Node (this test runner), `cloudflare:workers` does not resolve, so
    // `resolveConfiguredProvider` falls into its own disabled-stub fallback
    // exactly as it would for an operator who never set the env var.
    const result = await verifySecurityCandidateWithContext(
      context,
      "batch-a",
      {
        portfolioId: "portfolio-a",
        sourceSymbol: "NEW",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
        expectedVersion: review.batch.version,
        expectedPreviewVersion: review.previewVersion,
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 502);
      assert.match(result.message, /unavailable for this deployment/i);
    }
    assert.equal(fetchCalls, 0, "expected no live network call");
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS n FROM portfolio_securities")
          .get() as { n: number }
      ).n,
      0,
      "a failed-closed verify must not publish a security",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("row missing/not-enabled pre-check: a suspended registry row is an explicit 503 before any provider is ever consulted", async () => {
  const database = await freshlyMigratedDatabase();
  seedVerifyFixture(database);
  // Suspend the migration-seeded row AFTER migrations have already run --
  // this is the distinct guard at the top of
  // `verifySecurityCandidateWithContext` (`security-verification-service.ts`,
  // the `SELECT status FROM market_data_providers ...` check) firing on a
  // present-but-not-'enabled' row, as opposed to the other test above's
  // env-driven disabled-provider-stub path, which only runs once this
  // pre-check has already passed.
  database.exec(
    "UPDATE market_data_providers SET status = 'suspended' WHERE id = 'yahoo-compatible'",
  );

  const client = createSqliteSqlClient(database);
  const context: SecurityVerifyActionContext = { client, userId: "user-a" };
  const review = await currentReview(client, "user-a", "batch-a");

  let providerCalls = 0;
  const spyProvider = {
    capabilities: () => {
      throw new Error("capabilities() should never be called");
    },
    searchSecurities: async () => {
      providerCalls += 1;
      throw new Error("searchSecurities() should never be called");
    },
    getDailyPrices: async () => {
      throw new Error("getDailyPrices() should never be called");
    },
    getLatestObservation: async () => {
      throw new Error("getLatestObservation() should never be called");
    },
    getFxRates: async () => {
      throw new Error("getFxRates() should never be called");
    },
    getDividendEvents: async () => {
      throw new Error("getDividendEvents() should never be called");
    },
    getSplitEvents: async () => {
      throw new Error("getSplitEvents() should never be called");
    },
  };

  const result = await verifySecurityCandidateWithContext(
    context,
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
    // An explicit provider is passed so a non-zero `providerCalls` would
    // prove the pre-check was bypassed (rather than merely relying on the
    // env-driven fallback also happening to be inert, as the test above
    // does for its own, later-stage failure path).
    { provider: spyProvider },
  );

  assert.deepEqual(result, {
    ok: false,
    status: 503,
    message: "Market-data verification is not available for this deployment.",
  });
  assert.equal(providerCalls, 0, "expected no provider call");
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS n FROM portfolio_securities")
        .get() as { n: number }
    ).n,
    0,
    "a failed-closed verify must not publish a security",
  );
});
