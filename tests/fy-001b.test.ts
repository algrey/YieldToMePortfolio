import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedUserSettingsRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";
import {
  validateFinancialYearStartMonth,
  validateHomeCurrency,
} from "../app/portfolio-action-contract.ts";

// FY-001B: lets the owner change the FY start month from the settings
// surface. Mirrors the established home-currency/holding-currency-view
// coverage depth: repository-level persistence/version/ownership tests
// (tests/db-001b.test.ts, tests/ops-001.test.ts's pattern), a route-level
// CSRF-first source check (tests/qa-001a.test.ts's pattern), and
// source-text UI assertions (tests/ui-001.test.ts's pattern, since the
// settings popover is closed on initial static render).
//
// app/portfolio-actions.ts transitively imports "next/headers", which only
// vinext's bundler resolves -- not Node's strict ESM loader used by
// `node --test` (the same constraint documented in tests/qa-001a.test.ts).
// So changeFinancialYearStartMonthAction's malformed-input rejection is
// verified at its validator boundary (validateFinancialYearStartMonth,
// directly below) plus a source-order assertion further down confirming the
// action validates before reaching any authenticated context, rather than
// by importing and calling the action itself.

// --- boundary validation ---------------------------------------------------

test("FY-001B: validateFinancialYearStartMonth accepts only integers 1-12", () => {
  assert.equal(validateFinancialYearStartMonth(1), 1);
  assert.equal(validateFinancialYearStartMonth(7), 7);
  assert.equal(validateFinancialYearStartMonth(12), 12);
  assert.equal(validateFinancialYearStartMonth(0), null);
  assert.equal(validateFinancialYearStartMonth(13), null);
  assert.equal(validateFinancialYearStartMonth(1.5), null);
  assert.equal(validateFinancialYearStartMonth("7"), null);
  assert.equal(validateFinancialYearStartMonth(null), null);
  assert.equal(validateFinancialYearStartMonth(undefined), null);
  // Sanity: unrelated validators are unaffected by this file's import.
  assert.equal(validateHomeCurrency("aud"), "AUD");
});

test("FY-001B: the action validates the month and version and returns 400 before reaching any authenticated context", async () => {
  const source = await readFile(
    new URL("../app/portfolio-actions.ts", import.meta.url),
    "utf8",
  );
  const actionStart = source.indexOf(
    "export async function changeFinancialYearStartMonthAction",
  );
  assert.ok(actionStart >= 0, "expected changeFinancialYearStartMonthAction");
  const actionBody = source.slice(
    actionStart,
    source.indexOf("\n}", actionStart) + 2,
  );
  assert.match(actionBody, /validateFinancialYearStartMonth\(/);
  assert.match(actionBody, /status: 400 as const/);
  const validationIndex = actionBody.indexOf(
    "validateFinancialYearStartMonth(",
  );
  const authIndex = actionBody.indexOf("getAuthenticatedSqlContext()");
  assert.ok(validationIndex >= 0 && authIndex >= 0);
  assert.ok(
    validationIndex < authIndex,
    "must validate the month/version before opening an authenticated context",
  );
});

// --- repository: persistence, version bump, read-back, isolation ---------

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
       NULL, NULL, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1),
      ('user-b', 'active', 'Bob', 'bob@example.com', 'en-AU', 'Australia/Sydney',
       NULL, NULL, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1);

    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      financial_year_start_month, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'native', 7, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1),
      ('user-b', 'AUD', 'Australia/Sydney', 'native', 7, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1);
  `);
}

test("FY-001B: setFinancialYearStartMonth persists, bumps the version, and the change is visible on the read path", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createSqliteSqlClient(database);
  const userSettings = createOwnedUserSettingsRepository(
    client,
    () => "2026-08-13T01:00:00Z",
  );

  const result = await userSettings.setFinancialYearStartMonth("user-a", {
    financialYearStartMonth: 10,
    expectedVersion: 1,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.settings.financialYearStartMonth, 10);
  assert.equal(result.settings.version, 2);
  assert.equal(result.settings.updatedAt, "2026-08-13T01:00:00Z");
  // Other settings fields are untouched by this mutation.
  assert.equal(result.settings.homeCurrencyCode, "AUD");
  assert.equal(result.settings.defaultHoldingCurrencyView, "native");

  const readBack = await userSettings.get("user-a");
  assert.ok(readBack);
  assert.equal(readBack?.financialYearStartMonth, 10);
  assert.equal(readBack?.version, 2);
});

test("FY-001B: a stale expectedVersion is rejected as version_conflict and does not change the stored value", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createSqliteSqlClient(database);
  const userSettings = createOwnedUserSettingsRepository(client);

  const stale = await userSettings.setFinancialYearStartMonth("user-a", {
    financialYearStartMonth: 4,
    expectedVersion: 99,
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason, "version_conflict");

  const unchanged = await userSettings.get("user-a");
  assert.equal(unchanged?.financialYearStartMonth, 7);
  assert.equal(unchanged?.version, 1);
});

test("FY-001B: another owner's version cannot be used to change this owner's setting (cross-user isolation)", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createSqliteSqlClient(database);
  const userSettings = createOwnedUserSettingsRepository(client);

  const crossUser = await userSettings.setFinancialYearStartMonth("user-b", {
    financialYearStartMonth: 4,
    expectedVersion: 1,
  });
  // user-b's own row is version 1 too, so this mutates user-b's row, not
  // user-a's -- confirm user-a is completely unaffected by a sibling owner's
  // mutation of their own settings row.
  assert.equal(crossUser.ok, true);

  const userA = await userSettings.get("user-a");
  assert.equal(userA?.financialYearStartMonth, 7);
  assert.equal(userA?.version, 1);

  // A version that only exists on user-a's row must not let user-b jump
  // straight to it (no row for user-b at that version).
  const wrongVersionForOwner = await userSettings.setFinancialYearStartMonth(
    "user-b",
    { financialYearStartMonth: 5, expectedVersion: 1 },
  );
  assert.equal(wrongVersionForOwner.ok, false);
  if (wrongVersionForOwner.ok) return;
  assert.equal(wrongVersionForOwner.reason, "version_conflict");
});

// --- route: CSRF gate before any authenticated work -----------------------

test("FY-001B: the route imports and calls rejectCrossSiteMutation before reading the request body", async () => {
  const source = await readFile(
    new URL("../app/api/settings/financial-year/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /import \{ rejectCrossSiteMutation \} from ".*mutation-request";/,
  );
  const csrfIndex = source.indexOf("rejectCrossSiteMutation(request)");
  assert.ok(csrfIndex >= 0);
  const bodyReadIndex = source.indexOf("request.json(");
  assert.ok(bodyReadIndex >= 0);
  assert.ok(
    csrfIndex < bodyReadIndex,
    "must reject cross-site mutations before reading the request body",
  );
});

// --- settings UI: labelled, offline-disabled, accessible control ---------

test("FY-001B: the settings surface has a labelled financial-year-start month select naming the resulting window, disabled offline", async () => {
  const component = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /Financial year start/);
  // A full 1-12 month picker, not a partial/free-text control.
  assert.match(component, /FY_MONTH_NAMES\.map/);
  assert.match(component, /"January"[\s\S]{0,200}"December"/);
  // Helper text names the resulting window, e.g. "July: FY runs 1 Jul – 30 Jun".
  assert.match(component, /FY runs 1 \$\{FY_MONTH_ABBREVIATIONS/);
  // Same offline/pending gating as the sibling settings controls.
  assert.match(
    component,
    /changeFinancialYearStartMonth[\s\S]{0,400}disabled=\{actionPending \|\| !isOnline\}/,
  );
  // Programmatically associated helper text, not colour/position alone.
  assert.match(component, /aria-describedby="fy-start-month-helper"/);
  assert.match(component, /id="fy-start-month-helper"/);
  // Posts to the new endpoint with the current settings version (optimistic
  // concurrency), never a client-invented user id.
  assert.match(component, /"\/api\/settings\/financial-year"/);
  assert.match(
    component,
    /financialYearStartMonth: value,\s*expectedVersion: ownedWorkspace\.settingsVersion,/,
  );
});
