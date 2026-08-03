import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { rejectCrossSiteMutation } from "../app/mutation-request.ts";
import {
  createOwnedImportCommitRepository,
  createSqliteSqlClient,
  IMPORT_COMMIT_LIMITS,
  type SqlClient,
} from "../db/repositories/index.ts";

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
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'ABC', 'AUD', 'unresolved', '2026-08-03', '2026-08-03');
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv', '1',
      'sample.csv', 100, 'file-a', 'ready', '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1);
  `);
  return database;
}

function normalized(
  id: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id,
    symbol: "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "2",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01 GMT+1000",
    transactionTime: "10:00:00",
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `2026-08-01T00:00:0${id === "row-1" ? "0" : "1"}.000Z`,
    localTradeDate: "2026-08-01",
    cashEvent: null,
    ...overrides,
  });
}

function stageRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO import_rows (
      id, user_id, batch_id, physical_row_number, row_class,
      original_fields_json, normalized_fields_json, normalized_fingerprint,
      validation_status, target_portfolio_id, target_portfolio_security_id,
      commit_status, created_at, updated_at, version
    ) VALUES
      ('row-1', 'user-a', 'batch-a', 2, 'transaction', '[]', '${normalized("row-1")}', 'fingerprint-1', 'valid', 'portfolio-a', 'membership-a', 'staged', '2026-08-03', '2026-08-03', 1),
      ('row-2', 'user-a', 'batch-a', 3, 'transaction', '[]', '${normalized("row-2", { sharesOwned: "3" })}', 'fingerprint-2', 'valid', 'portfolio-a', 'membership-a', 'staged', '2026-08-03', '2026-08-03', 1),
      ('row-3', 'user-a', 'batch-a', 4, 'transaction', '[]', '${normalized("row-3", { cashEvent: "cash_deposit", symbol: "AUD=CASH", exchange: null, sharesOwned: "100", costPerShare: "1" })}', 'fingerprint-3', 'valid', 'portfolio-a', NULL, 'staged', '2026-08-03', '2026-08-03', 1);
  `);
}

test("bounded commit resumes from the durable high-water row and is idempotent", async () => {
  const database = await migratedDatabase();
  stageRows(database);
  const client = createSqliteSqlClient(database);
  const failing = createOwnedImportCommitRepository(client, {
    chunkSize: 2,
    failAtChunk: 1,
    now: () => "2026-08-03T01:00:00Z",
  });
  const first = await failing.commit("user-a", "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: "1.0",
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a",
  });
  assert.deepEqual(first, {
    ok: false,
    reason: "injected_failure",
    resumable: true,
  });
  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM transactions").get() as {
        count: number;
      }
    ).count,
    2,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT commit_high_water_row FROM import_batches WHERE id = 'batch-a'",
        )
        .get() as { commit_high_water_row: number }
    ).commit_high_water_row,
    3,
  );

  const resumed = await createOwnedImportCommitRepository(client, {
    chunkSize: 2,
    now: () => "2026-08-03T01:01:00Z",
  }).commit("user-a", "batch-a", {
    expectedVersion: 2,
    expectedPreviewVersion: "2.0",
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a-resume",
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.status, "committed");
  assert.equal(resumed.highWaterRow, 4);
  assert.equal(resumed.committedRows, 3);
  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM transactions").get() as {
        count: number;
      }
    ).count,
    3,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM calculation_runs WHERE reason = 'import_commit'",
        )
        .get() as { count: number }
    ).count,
    1,
  );

  const retried = await createOwnedImportCommitRepository(client).commit(
    "user-a",
    "batch-a",
    {
      expectedVersion: 999,
      expectedPreviewVersion: "999.0",
      idempotencyKey: "commit-a",
      confirmation: true,
      requestId: "request-a-retry",
    },
  );
  assert.equal(retried.ok, true);
  if (retried.ok) assert.equal(retried.idempotent, true);
});

test("commit confirmation, ownership, duplicate rows, and chunk bounds fail closed", async () => {
  assert.equal(IMPORT_COMMIT_LIMITS.maxChunkSize, 5);
  const database = await migratedDatabase();
  stageRows(database);
  database.exec(
    "UPDATE import_rows SET normalized_fingerprint = 'fingerprint-1' WHERE id = 'row-2'",
  );
  const client = createSqliteSqlClient(database);
  const repository = createOwnedImportCommitRepository(client, {
    chunkSize: 2,
  });
  const notConfirmed = await repository.commit("user-a", "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: "1.0",
    idempotencyKey: "commit-a",
    confirmation: false,
    requestId: "request-a",
  });
  assert.deepEqual(notConfirmed, {
    ok: false,
    reason: "confirmation_required",
  });

  const otherOwner = await repository.commit("user-b", "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: "1.0",
    idempotencyKey: "commit-b",
    confirmation: true,
    requestId: "request-b",
  });
  assert.deepEqual(otherOwner, { ok: false, reason: "not_found" });

  assert.throws(
    () => createOwnedImportCommitRepository(client, { chunkSize: 6 }),
    /invalid_import_commit_chunk_size/,
  );
  const result = await repository.commit("user-a", "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: "1.0",
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a",
  });
  assert.equal(result.ok, true);
  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM transactions").get() as {
        count: number;
      }
    ).count,
    2,
  );
});

test("a failed D1 batch leaves no partial import effect and remains resumable", async () => {
  const database = await migratedDatabase();
  stageRows(database);
  const base = createSqliteSqlClient(database);
  let fail = true;
  const client: SqlClient = {
    ...base,
    async batch(statements) {
      if (fail) {
        fail = false;
        throw new Error("injected D1 failure");
      }
      return base.batch!(statements);
    },
  };
  const first = await createOwnedImportCommitRepository(client, {
    chunkSize: 2,
  }).commit("user-a", "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: "1.0",
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a",
  });
  assert.deepEqual(first, {
    ok: false,
    reason: "atomic_failure",
    resumable: true,
  });
  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM transactions").get() as {
        count: number;
      }
    ).count,
    0,
  );
});

test("commit route rejects cross-site mutation before authentication or parsing", async () => {
  const response = rejectCrossSiteMutation(
    new Request("https://yield.example/api/import/commit/batch-a", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 403);
});
