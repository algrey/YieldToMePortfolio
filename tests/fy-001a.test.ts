import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  currentFyWindow,
  fyLabel,
  isValidFinancialYearStartMonth,
  lastFyWindow,
} from "../domain/calculations/financial-year.ts";
import {
  createOwnedUserSettingsRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";

// --- domain module: pure FY window/label math -----------------------------

test("FY-001A: default July, Sydney, FY-to-date and last FY windows/labels", () => {
  const current = currentFyWindow(
    "2026-08-13T00:00:00Z",
    7,
    "Australia/Sydney",
  );
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.deepEqual(current.window, {
    startDate: "2026-07-01",
    endDate: "2026-08-13",
  });
  assert.equal(fyLabel(current.window), "FY27");

  const last = lastFyWindow("2026-08-13T00:00:00Z", 7, "Australia/Sydney");
  assert.ok(last.ok);
  if (!last.ok) return;
  assert.deepEqual(last.window, {
    startDate: "2025-07-01",
    endDate: "2026-06-30",
  });
  assert.equal(fyLabel(last.window), "FY26");
});

test("FY-001A: a bare YYYY-MM-DD instant is treated as UTC midnight of that date", () => {
  const current = currentFyWindow("2026-08-13", 7, "Australia/Sydney");
  assert.ok(current.ok);
  if (!current.ok) return;
  // 2026-08-13T00:00:00Z is 2026-08-13T10:00 in Sydney (UTC+10 in August).
  assert.equal(current.window.endDate, "2026-08-13");
});

test("FY-001A: January start month yields plain calendar-year windows", () => {
  const current = currentFyWindow(
    "2026-08-13T00:00:00Z",
    1,
    "Australia/Sydney",
  );
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.deepEqual(current.window, {
    startDate: "2026-01-01",
    endDate: "2026-08-13",
  });
  // Jan-start FY label convention: ending year equals the start year.
  assert.equal(fyLabel(current.window), "FY26");

  const last = lastFyWindow("2026-08-13T00:00:00Z", 1, "Australia/Sydney");
  assert.ok(last.ok);
  if (!last.ok) return;
  assert.deepEqual(last.window, {
    startDate: "2025-01-01",
    endDate: "2025-12-31",
  });
  assert.equal(fyLabel(last.window), "FY25");
});

test("FY-001A: boundary instants respect the Sydney timezone across the UTC offset, not naive UTC dates", () => {
  // Sydney is UTC+10 on 1 July (outside AEDT). 2026-06-30T13:59:00Z is
  // 2026-06-30T23:59 local Sydney time — still the prior FY.
  const beforeBoundary = currentFyWindow(
    "2026-06-30T13:59:00Z",
    7,
    "Australia/Sydney",
  );
  assert.ok(beforeBoundary.ok);
  if (!beforeBoundary.ok) return;
  assert.equal(beforeBoundary.window.startDate, "2025-07-01");

  const beforeBoundaryLast = lastFyWindow(
    "2026-06-30T13:59:00Z",
    7,
    "Australia/Sydney",
  );
  assert.ok(beforeBoundaryLast.ok);
  if (!beforeBoundaryLast.ok) return;
  // "Last FY" from just before the boundary is the FY before that one.
  assert.equal(beforeBoundaryLast.window.startDate, "2024-07-01");

  // 2026-06-30T14:00:00Z is 2026-07-01T00:00 local Sydney time — the new FY
  // has just started, even though the server clock/UTC date is still 30 Jun.
  const atBoundary = currentFyWindow(
    "2026-06-30T14:00:00Z",
    7,
    "Australia/Sydney",
  );
  assert.ok(atBoundary.ok);
  if (!atBoundary.ok) return;
  assert.equal(atBoundary.window.startDate, "2026-07-01");
  assert.equal(atBoundary.window.endDate, "2026-07-01");
});

test("FY-001A: boundary math holds across a DST transition (Sydney AEDT start, early October)", () => {
  // Sydney enters daylight saving (UTC+11) at 2026-10-04T02:00 local, i.e.
  // 2026-10-03T16:00:00Z. A default-July FY start is unaffected by this
  // transition (it isn't near the FY boundary), but the local-date
  // resolution itself must still be correct either side of the jump.
  const beforeDstStarts = currentFyWindow(
    "2026-10-03T15:59:00Z",
    7,
    "Australia/Sydney",
  );
  assert.ok(beforeDstStarts.ok);
  if (!beforeDstStarts.ok) return;
  assert.equal(beforeDstStarts.window.endDate, "2026-10-04");

  const afterDstStarts = currentFyWindow(
    "2026-10-03T16:01:00Z",
    7,
    "Australia/Sydney",
  );
  assert.ok(afterDstStarts.ok);
  if (!afterDstStarts.ok) return;
  assert.equal(afterDstStarts.window.endDate, "2026-10-04");
  assert.equal(afterDstStarts.window.startDate, "2026-07-01");
});

test("FY-001A: a negative UTC-offset timezone (New York) resolves its own local boundary", () => {
  // New York is UTC-4 in July (EDT). 2026-06-30T23:30:00Z is 2026-06-30T19:30
  // local New York time — the prior FY there, even though it is already
  // 2026-07-01 in UTC.
  const stillPriorFy = currentFyWindow(
    "2026-06-30T23:30:00Z",
    7,
    "America/New_York",
  );
  assert.ok(stillPriorFy.ok);
  if (!stillPriorFy.ok) return;
  assert.equal(stillPriorFy.window.startDate, "2025-07-01");
  assert.equal(stillPriorFy.window.endDate, "2026-06-30");
});

test("FY-001A: isValidFinancialYearStartMonth accepts 1-12 only", () => {
  assert.equal(isValidFinancialYearStartMonth(1), true);
  assert.equal(isValidFinancialYearStartMonth(7), true);
  assert.equal(isValidFinancialYearStartMonth(12), true);
  assert.equal(isValidFinancialYearStartMonth(0), false);
  assert.equal(isValidFinancialYearStartMonth(13), false);
  assert.equal(isValidFinancialYearStartMonth(7.5), false);
  assert.equal(isValidFinancialYearStartMonth("7"), false);
});

test("FY-001A: invalid start months, timezones, and instants are rejected at the domain boundary", () => {
  const invalidMonthLow = currentFyWindow(
    "2026-08-13T00:00:00Z",
    0,
    "Australia/Sydney",
  );
  assert.deepEqual(invalidMonthLow, {
    ok: false,
    reason: "invalid_start_month",
  });

  const invalidMonthHigh = lastFyWindow(
    "2026-08-13T00:00:00Z",
    13,
    "Australia/Sydney",
  );
  assert.deepEqual(invalidMonthHigh, {
    ok: false,
    reason: "invalid_start_month",
  });

  const invalidTimezone = currentFyWindow(
    "2026-08-13T00:00:00Z",
    7,
    "Not/A_Zone",
  );
  assert.deepEqual(invalidTimezone, { ok: false, reason: "invalid_timezone" });

  const invalidInstant = currentFyWindow("not-a-date", 7, "Australia/Sydney");
  assert.deepEqual(invalidInstant, { ok: false, reason: "invalid_instant" });
});

// --- migration: schema apply + CHECK constraint ---------------------------

async function loadMigrationSql(): Promise<string> {
  const migrationFiles = (
    await readdir(new URL("../drizzle", import.meta.url))
  ).filter((file) => file.endsWith(".sql"));
  assert.ok(migrationFiles.length > 0, "expected a generated migration");
  const migrations = await Promise.all(
    migrationFiles
      .sort()
      .map((file) =>
        readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
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

function seedReferenceData(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);

    INSERT INTO users (
      id, status, display_name, primary_email, locale, timezone,
      terms_accepted_at, last_seen_at, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'active', 'Alice', 'alice@example.com', 'en-AU', 'Australia/Sydney',
       NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);
}

test("FY-001A: migration applies to a clean DB and existing/new rows default financial_year_start_month to 7", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);

  // Existing users must default to 7 with no data rewrite: omit the column
  // entirely on insert, matching how a pre-FY-001A row would have been
  // written by earlier application code.
  database.exec(`
    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    )
    VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);

  const row = database
    .prepare(
      "SELECT financial_year_start_month FROM user_settings WHERE user_id = 'user-a'",
    )
    .get() as { financial_year_start_month: number };
  assert.equal(row.financial_year_start_month, 7);
});

test("FY-001A: CHECK constraint rejects out-of-range financial_year_start_month values", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);

  assert.throws(() => {
    database.exec(`
      INSERT INTO user_settings (
        user_id, home_currency_code, timezone, default_holding_currency_view,
        financial_year_start_month, created_at, updated_at, version
      )
      VALUES
        ('user-a', 'AUD', 'Australia/Sydney', 'native', 0, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
    `);
  }, /CHECK constraint failed: user_settings_financial_year_start_month_check/);

  assert.throws(() => {
    database.exec(`
      INSERT INTO user_settings (
        user_id, home_currency_code, timezone, default_holding_currency_view,
        financial_year_start_month, created_at, updated_at, version
      )
      VALUES
        ('user-a', 'AUD', 'Australia/Sydney', 'native', 13, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
    `);
  }, /CHECK constraint failed: user_settings_financial_year_start_month_check/);
});

// --- repository read path ---------------------------------------------------

test("FY-001A: the settings read path exposes financialYearStartMonth alongside the existing fields", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  database.exec(`
    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      financial_year_start_month, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'native', 10, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);

  const client = createSqliteSqlClient(database);
  const userSettings = createOwnedUserSettingsRepository(client);
  const settings = await userSettings.get("user-a");
  assert.ok(settings);
  assert.equal(settings?.financialYearStartMonth, 10);
  assert.equal(settings?.homeCurrencyCode, "AUD");
  assert.equal(settings?.defaultHoldingCurrencyView, "native");
});

test("FY-001A: a row relying on the column default reads back as 7 through the repository", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  database.exec(`
    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    )
    VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);

  const client = createSqliteSqlClient(database);
  const userSettings = createOwnedUserSettingsRepository(client);
  const settings = await userSettings.get("user-a");
  assert.equal(settings?.financialYearStartMonth, 7);
});
