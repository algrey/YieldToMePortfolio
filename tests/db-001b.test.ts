import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedPortfolioRepository,
  createOwnedUserSettingsRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";

async function loadMigrationSql(): Promise<string> {
  const migrationFiles = (
    await readdir(new URL("../drizzle", import.meta.url))
  ).filter((file) => file.endsWith(".sql"));

  assert.ok(migrationFiles.length > 0, "expected a generated migration");

  const migrations = await Promise.all(
    migrationFiles
      .sort()
      .map((migrationFile) =>
        readFile(
          new URL(`../drizzle/${migrationFile}`, import.meta.url),
          "utf8",
        ),
      ),
  );
  return migrations.join("\n");
}

function createMigratedDatabase(sql: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(sql);
  return database;
}

function createRecordedSqlClient(database: DatabaseSync) {
  const baseClient = createSqliteSqlClient(database);
  const statements: string[] = [];

  return {
    statements,
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return await baseClient.all<T>(sql, params);
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T | undefined> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return await baseClient.get<T>(sql, params);
    },
    async run(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<{ changes: number; lastInsertRowId: number }> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return await baseClient.run(sql, params);
    },
    async batch(batchStatements: Parameters<typeof baseClient.batch>[0]) {
      for (const statement of batchStatements) {
        statements.push(statement.sql.replace(/\s+/g, " ").trim());
      }
      return await baseClient.batch(batchStatements);
    },
  };
}

function seedReferenceData(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES
      ('AUD', 36, 'Australian dollar', 2, 1),
      ('USD', 840, 'US dollar', 2, 1);

    INSERT INTO users (
      id, status, display_name, primary_email, locale, timezone,
      terms_accepted_at, last_seen_at, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'active', 'Alice', 'alice@example.com', 'en-AU', 'Australia/Sydney',
       NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'active', 'Bob', 'bob@example.com', 'en-AU', 'Australia/Sydney',
       NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    )
    VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'USD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);
}

test("owned portfolio repositories support same-user lifecycle and home-currency rebase requests", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createRecordedSqlClient(database);
  const portfolios = createOwnedPortfolioRepository(
    client,
    () => "2026-07-29T12:00:00Z",
  );
  const userSettings = createOwnedUserSettingsRepository(
    client,
    () => "2026-07-29T12:30:00Z",
  );

  const created = await portfolios.create("user-a", {
    id: "portfolio-a",
    code: "A",
    name: "Alice Portfolio",
    timezone: "Australia/Sydney",
  });
  assert.ok(created);
  assert.equal(created?.baseCurrencyCode, "AUD");
  assert.equal(created?.homeCurrencyCode, "AUD");

  const readBack = await portfolios.get("user-a", "portfolio-a");
  assert.ok(readBack);
  assert.equal(readBack?.name, "Alice Portfolio");
  assert.equal(readBack?.homeCurrencyCode, "AUD");

  const defaultList = await portfolios.list("user-a");
  assert.equal(defaultList.length, 1);
  assert.equal(defaultList[0]?.id, "portfolio-a");

  const renamed = await portfolios.rename("user-a", "portfolio-a", {
    expectedVersion: 1,
    name: "Alice Growth",
  });
  assert.equal(renamed.ok, true);
  if (!renamed.ok) {
    return;
  }

  assert.equal(renamed.portfolio.name, "Alice Growth");
  assert.equal(renamed.portfolio.version, 2);

  const archived = await portfolios.archive("user-a", "portfolio-a", {
    expectedVersion: 2,
  });
  assert.equal(archived.ok, true);
  if (!archived.ok) {
    return;
  }

  assert.equal(archived.portfolio.status, "archived");
  assert.equal((await portfolios.list("user-a")).length, 0);
  assert.equal(
    (await portfolios.list("user-a", { includeArchived: true })).length,
    1,
  );

  const restored = await portfolios.restore("user-a", "portfolio-a", {
    expectedVersion: 3,
  });
  assert.equal(restored.ok, true);
  if (!restored.ok) {
    return;
  }

  assert.equal(restored.portfolio.status, "active");
  assert.equal((await portfolios.list("user-a")).length, 1);

  const rebase = await userSettings.requestHomeCurrencyRebase("user-a", {
    expectedVersion: 1,
    homeCurrencyCode: "USD",
  });
  assert.equal(rebase.ok, true);
  if (!rebase.ok) {
    return;
  }

  assert.equal(rebase.settings.homeCurrencyCode, "USD");
  assert.equal(rebase.rebaseRequest.previousHomeCurrencyCode, "AUD");
  assert.equal(rebase.rebaseRequest.nextHomeCurrencyCode, "USD");
  assert.deepEqual(rebase.rebaseRequest.affectedPortfolioIds, ["portfolio-a"]);
  assert.equal(rebase.rebaseRequest.portfolioCount, 1);

  const unchangedPortfolio = await portfolios.get("user-a", "portfolio-a");
  assert.ok(unchangedPortfolio);
  assert.equal(unchangedPortfolio?.baseCurrencyCode, "AUD");

  const recordedStatements = client.statements.join("\n");
  assert.match(
    recordedStatements,
    /FROM user_settings AS us WHERE us\.user_id = \?/i,
  );
  assert.match(recordedStatements, /WHERE p\.user_id = \? AND p\.id = \?/i);
  assert.match(
    recordedStatements,
    /WHERE id = \? AND user_id = \? AND version = \?/i,
  );
  assert.match(recordedStatements, /WHERE user_id = \? AND version = \?/i);
});

test("owned portfolio repositories deny cross-user reads, writes, and optimistic conflicts", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createSqliteSqlClient(database);
  const portfolios = createOwnedPortfolioRepository(
    client,
    () => "2026-07-29T12:00:00Z",
  );

  const created = await portfolios.create("user-a", {
    id: "portfolio-a",
    code: "A",
    name: "Alice Portfolio",
    timezone: "Australia/Sydney",
  });
  assert.ok(created);

  const crossUserRead = await portfolios.get("user-b", "portfolio-a");
  assert.equal(crossUserRead, null);

  const crossUserRename = await portfolios.rename("user-b", "portfolio-a", {
    expectedVersion: 1,
    name: "Not Alice",
  });
  assert.equal(crossUserRename.ok, false);
  if (crossUserRename.ok) {
    return;
  }
  assert.equal(crossUserRename.reason, "not_found");

  const staleRename = await portfolios.rename("user-a", "portfolio-a", {
    expectedVersion: 0,
    name: "Stale rename",
  });
  assert.equal(staleRename.ok, false);
  if (staleRename.ok) {
    return;
  }
  assert.equal(staleRename.reason, "version_conflict");

  const crossUserArchive = await portfolios.archive("user-b", "portfolio-a", {
    expectedVersion: 1,
  });
  assert.equal(crossUserArchive.ok, false);
  if (crossUserArchive.ok) {
    return;
  }
  assert.equal(crossUserArchive.reason, "not_found");

  const archivedByOwner = await portfolios.archive("user-a", "portfolio-a", {
    expectedVersion: 1,
  });
  assert.equal(archivedByOwner.ok, true);
  if (!archivedByOwner.ok) {
    return;
  }

  const crossUserRestore = await portfolios.restore("user-b", "portfolio-a", {
    expectedVersion: archivedByOwner.portfolio.version,
  });
  assert.equal(crossUserRestore.ok, false);
  if (crossUserRestore.ok) {
    return;
  }
  assert.equal(crossUserRestore.reason, "not_found");
});
