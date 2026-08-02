import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAuditRepository } from "../db/repositories/audit.ts";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import {
  createOwnedPortfolioRepository,
  createOwnedUserSettingsRepository,
} from "../db/repositories/owned-portfolios.ts";
import {
  addRequestId,
  createRequestId,
  createStructuredLogEvent,
  redactMetadata,
} from "../domain/observability/index.ts";

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const sql = (
    await Promise.all(
      files.map((file) =>
        readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(sql);
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (
      id, status, primary_email, locale, timezone, created_at, updated_at, version
    ) VALUES (
      'user-a', 'active', 'alice@example.com', 'en-AU',
      'Australia/Sydney', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1
    );
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      accounting_method, status, created_at, updated_at, version
    ) VALUES (
      'portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney',
      'fifo', 'active', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1
    );
  `);
  return database;
}

function createAuditFailingClient(database: DatabaseSync) {
  const base = createSqliteSqlClient(database);
  return {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      return await base.all<T>(sql, params);
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T | undefined> {
      return await base.get<T>(sql, params);
    },
    async run(sql: string, params: readonly unknown[] = []) {
      if (/INSERT INTO audit_events/i.test(sql)) {
        throw new Error("injected audit failure");
      }
      return await base.run(sql, params);
    },
  };
}

test("audit events record actor, target, result, correlation, and redacted metadata", async () => {
  const database = await createMigratedDatabase();
  const audit = createAuditRepository(
    createSqliteSqlClient(database),
    () => "2026-07-30T00:01:00Z",
  );

  await audit.append({
    id: "audit-1",
    actorUserId: "user-a",
    targetOwnerUserId: "user-a",
    action: "portfolio.rename",
    targetType: "portfolio",
    targetId: "portfolio-a",
    requestId: "request-1",
    result: "success",
    metadata: {
      reason: "Updated display label",
      email: "alice@example.com",
      amount: "123.45",
      accessToken: "Bearer eyJsecret",
      token: "opaque-secret-token",
      csvRows: [{ amount: "999" }],
      rowCount: 12,
    },
  });

  const row = database
    .prepare("SELECT * FROM audit_events WHERE id = 'audit-1'")
    .get() as Record<string, unknown>;
  assert.equal(row.actor_user_id, "user-a");
  assert.equal(row.target_owner_user_id, "user-a");
  assert.equal(row.request_id, "request-1");
  assert.deepEqual(JSON.parse(String(row.metadata_json)), {
    reason: "Updated display label",
    email: "[REDACTED]",
    amount: "[REDACTED]",
    accessToken: "[REDACTED]",
    token: "[REDACTED]",
    csvRows: "[REDACTED]",
    rowCount: 12,
  });
});

test("audit events are append-only and owner listing is scoped", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const audit = createAuditRepository(client, () => "2026-07-30T00:02:00Z");
  await audit.append({
    id: "audit-2",
    actorUserId: "user-a",
    targetOwnerUserId: "user-a",
    action: "settings.change",
    targetType: "user_settings",
    targetId: "user-a",
    requestId: "request-2",
    result: "success",
  });

  assert.equal((await audit.listForOwner("user-a")).length, 1);
  assert.throws(() => {
    database.exec(
      "UPDATE audit_events SET result = 'failure' WHERE id = 'audit-2'",
    );
  }, /audit_events_are_append_only/);
  assert.throws(() => {
    database.exec("DELETE FROM audit_events WHERE id = 'audit-2'");
  }, /audit_events_are_append_only/);
});

test("request IDs accept safe correlation and reject untrusted header values", () => {
  const supplied = createRequestId(
    new Request("https://example.test", {
      headers: { "x-request-id": "trace-123" },
    }),
    () => "generated",
  );
  const invalid = createRequestId(
    new Request("https://example.test", {
      headers: { "x-request-id": "<script>bad</script>" },
    }),
    () => "generated",
  );
  assert.equal(supplied, "trace-123");
  assert.equal(invalid, "generated");

  const response = addRequestId(new Response("ok"), supplied);
  assert.equal(response.headers.get("x-request-id"), "trace-123");
});

test("structured log snapshots redact user and financial payloads", () => {
  const event = createStructuredLogEvent(
    {
      event: "import.commit",
      action: "import.commit",
      result: "failure",
      requestId: "request-3",
      metadata: {
        errorCode: "invalid-row",
        userId: "user-a",
        portfolioId: "portfolio-a",
        csvRows: ["private row"],
        quantity: "100",
        retryable: false,
      },
    },
    () => "2026-07-30T00:03:00Z",
  );
  assert.deepEqual(event, {
    level: "info",
    event: "import.commit",
    action: "import.commit",
    result: "failure",
    requestId: "request-3",
    occurredAt: "2026-07-30T00:03:00Z",
    metadata: {
      errorCode: "invalid-row",
      userId: "[REDACTED]",
      portfolioId: "[REDACTED]",
      csvRows: "[REDACTED]",
      quantity: "[REDACTED]",
      retryable: false,
    },
  });
  assert.deepEqual(redactMetadata({ email: "a@example.com" }), {
    email: "[REDACTED]",
  });
});

test("portfolio mutation rolls back when its audit append fails", async () => {
  const database = await createMigratedDatabase();
  database.exec(`
    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    ) VALUES (
      'user-a', 'AUD', 'Australia/Sydney', 'native',
      '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1
    );
  `);
  const repository = createOwnedPortfolioRepository(
    createAuditFailingClient(database),
    () => "2026-07-30T00:10:00Z",
    { requestId: "request-fault" },
  );

  await assert.rejects(
    repository.rename("user-a", "portfolio-a", {
      expectedVersion: 1,
      name: "Changed name",
    }),
    /injected audit failure/,
  );
  const row = database
    .prepare("SELECT name, version FROM portfolios WHERE id = 'portfolio-a'")
    .get() as { name: string; version: number };
  assert.equal(row.name, "Alice");
  assert.equal(row.version, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count,
    0,
  );
});

test("home-currency mutation rolls back when its audit append fails", async () => {
  const database = await createMigratedDatabase();
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    ) VALUES (
      'user-a', 'AUD', 'Australia/Sydney', 'native',
      '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1
    );
  `);
  const repository = createOwnedUserSettingsRepository(
    createAuditFailingClient(database),
    () => "2026-07-30T00:10:00Z",
    { requestId: "request-fault" },
  );

  await assert.rejects(
    repository.requestHomeCurrencyRebase("user-a", {
      expectedVersion: 1,
      homeCurrencyCode: "USD",
    }),
    /injected audit failure/,
  );
  const row = database
    .prepare(
      "SELECT home_currency_code, version FROM user_settings WHERE user_id = 'user-a'",
    )
    .get() as { home_currency_code: string; version: number };
  assert.equal(row.home_currency_code, "AUD");
  assert.equal(row.version, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count,
    0,
  );
});

test("D1-shaped audit batches roll back the primary write on batch failure", async () => {
  const database = await createMigratedDatabase();
  database.exec(`
    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    ) VALUES (
      'user-a', 'AUD', 'Australia/Sydney', 'native',
      '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1
    );
  `);
  const base = createSqliteSqlClient(database);
  const batchFailingClient = {
    ...base,
    async batch(statements: Parameters<NonNullable<typeof base.batch>>[0]) {
      return await base.batch!([
        statements[0]!,
        {
          sql: "INSERT INTO audit_events (invalid_column) VALUES (?)",
          params: ["x"],
        },
      ]);
    },
  };
  const repository = createOwnedPortfolioRepository(
    batchFailingClient,
    () => "2026-07-30T00:10:00Z",
    { requestId: "request-batch-fault" },
  );

  await assert.rejects(
    repository.rename("user-a", "portfolio-a", {
      expectedVersion: 1,
      name: "Changed name",
    }),
  );
  const row = database
    .prepare("SELECT name, version FROM portfolios WHERE id = 'portfolio-a'")
    .get() as { name: string; version: number };
  assert.equal(row.name, "Alice");
  assert.equal(row.version, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count,
    0,
  );
});
