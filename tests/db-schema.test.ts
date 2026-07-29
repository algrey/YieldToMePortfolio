import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function loadMigrationSql(): Promise<string> {
  const migrationFiles = (
    await readdir(new URL("../drizzle", import.meta.url))
  ).filter((file) => file.endsWith(".sql"));

  assert.equal(
    migrationFiles.length > 0,
    true,
    "expected a generated migration",
  );

  const migrationFile = migrationFiles.sort()[0];
  return await readFile(
    new URL(`../drizzle/${migrationFile}`, import.meta.url),
    "utf8",
  );
}

function createMigratedDatabase(sql: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(sql);
  return database;
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function indexNames(database: DatabaseSync, tableName: string): string[] {
  return database
    .prepare(`PRAGMA index_list('${tableName}')`)
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
}

function foreignKeys(database: DatabaseSync, tableName: string) {
  return database
    .prepare(`PRAGMA foreign_key_list('${tableName}')`)
    .all()
    .map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        id: Number(entry.id),
        seq: Number(entry.seq),
        table: String(entry.table),
        from: String(entry.from),
        to: String(entry.to),
        on_update: String(entry.on_update).toLowerCase(),
        on_delete: String(entry.on_delete).toLowerCase(),
        match: String(entry.match),
      };
    })
    .sort((left, right) => {
      const leftId = Number(left.id);
      const rightId = Number(right.id);
      if (leftId !== rightId) {
        return leftId - rightId;
      }

      return Number(left.seq) - Number(right.seq);
    });
}

test("generated migration applies cleanly with foreign keys enabled", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());

  const foreignKeysEnabled = database.prepare("PRAGMA foreign_keys;").get() as {
    foreign_keys: number;
  };
  assert.equal(foreignKeysEnabled.foreign_keys, 1);
  assert.deepEqual(tableNames(database), [
    "currencies",
    "portfolio_settings",
    "portfolios",
    "user_identities",
    "user_settings",
    "users",
  ]);
  assert.deepEqual(indexNames(database, "portfolios"), [
    "portfolios_id_user_id_unique",
    "portfolios_owner_status_updated_at_idx",
    "portfolios_user_id_code_unique",
  ]);
  assert.deepEqual(indexNames(database, "user_identities"), [
    "user_identities_provider_issuer_subject_unique",
    "user_identities_user_status_idx",
  ]);

  assert.deepEqual(foreignKeys(database, "user_settings"), [
    {
      id: 0,
      seq: 0,
      table: "currencies",
      from: "home_currency_code",
      to: "code",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 0,
      table: "users",
      from: "user_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
  ]);
  assert.deepEqual(foreignKeys(database, "portfolio_settings"), [
    {
      id: 0,
      seq: 0,
      table: "portfolios",
      from: "portfolio_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 0,
      seq: 1,
      table: "portfolios",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
  ]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check;").all(), []);
});

test("schema rejects duplicate identities, invalid enums, and cross-owner composite references", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());

  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1), ('USD', 840, 'US dollar', 2, 1);

    INSERT INTO users (
      id, status, display_name, primary_email, locale, timezone,
      terms_accepted_at, last_seen_at, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'active', 'Alice', 'alice@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'active', 'Bob', 'bob@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    )
    VALUES ('user-a', 'AUD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone, accounting_method,
      history_complete_from, status, created_at, updated_at, version
    )
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice Portfolio', 'AUD', 'Australia/Sydney', 'fifo', NULL, 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);

  assert.throws(() => {
    database.exec(`
        INSERT INTO user_identities (
          id, user_id, provider, issuer, subject, email_at_link,
          status, last_authenticated_at, created_at, updated_at, version
        )
        VALUES
          ('identity-a', 'user-a', 'cloudflare_access', 'https://example.cloudflareaccess.com', 'subject-a', 'alice@example.com', 'active', NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
          ('identity-b', 'user-b', 'cloudflare_access', 'https://example.cloudflareaccess.com', 'subject-a', 'bob@example.com', 'active', NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
      `);
  }, /UNIQUE constraint failed: user_identities\.provider, user_identities\.issuer, user_identities\.subject/);

  assert.throws(() => {
    database.exec(`
        INSERT INTO users (
          id, status, display_name, primary_email, locale, timezone,
          terms_accepted_at, last_seen_at, created_at, updated_at, version
        )
        VALUES
          ('user-c', 'unknown', 'Charlie', 'charlie@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
      `);
  }, /CHECK constraint failed: users_status_check/);

  assert.throws(() => {
    database.exec(`
        INSERT INTO portfolio_settings (
          portfolio_id, user_id, quote_staleness_policy,
          created_at, updated_at, version
        )
        VALUES ('portfolio-a', 'user-b', 'eod_standard', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
      `);
  }, /FOREIGN KEY constraint failed/);
});
