import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  composeCoveredTotals,
  selectFxObservation,
  selectPriceObservation,
  type FxObservation,
  type ManualOverride,
  type PriceObservation,
} from "../domain/market-data/index.ts";
import {
  createOwnedManualOverrideRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";

function present<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

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
           ('user-b', 'USD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
           ('portfolio-b', 'user-b', 'B', 'Bob', 'USD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
  `);
  return database;
}

function price(overrides: Partial<PriceObservation> = {}): PriceObservation {
  return {
    kind: "price",
    providerId: "yahoo-compatible",
    providerRevisionId: null,
    mappingId: "mapping-a",
    securityId: "security-a",
    scope: { kind: "deployment", userId: null },
    interval: "eod",
    observationAt: "2026-08-03T06:00:00Z",
    marketDate: "2026-08-03",
    marketTimezone: "Australia/Sydney",
    currencyCode: "AUD",
    closeDecimal: "42.10",
    previousCloseDecimal: "41.90",
    adjustmentState: "raw",
    adjustmentFactor: null,
    quality: "observed",
    delayedMinutes: null,
    ingestedAt: "2026-08-03T07:00:00Z",
    payloadSha256: null,
    ...overrides,
  };
}

function fx(overrides: Partial<FxObservation> = {}): FxObservation {
  return {
    kind: "fx",
    providerId: "yahoo-compatible",
    providerRevisionId: null,
    scope: { kind: "deployment", userId: null },
    baseCurrencyCode: "USD",
    quoteCurrencyCode: "AUD",
    rateDecimal: "1.52",
    interval: "eod",
    observedAt: "2026-08-03T06:00:00Z",
    marketDate: "2026-08-03",
    quality: "observed",
    delayedMinutes: null,
    ingestedAt: "2026-08-03T07:00:00Z",
    payloadSha256: null,
    ...overrides,
  };
}

test("selects delayed/best-effort before EOD, then bounded prior sessions", () => {
  const selected = selectPriceObservation({
    asOf: "2026-08-03",
    targetKey: "security-a",
    observations: [
      price({
        interval: "eod",
        closeDecimal: "40",
        observationAt: "2026-08-03T06:00:00Z",
      }),
      price({
        interval: "delayed",
        closeDecimal: "42",
        observationAt: "2026-08-03T05:00:00Z",
      }),
    ],
  });
  assert.equal(selected.status, "current");
  assert.equal(selected.selected?.closeDecimal, "42");
  assert.equal(selected.selected?.interval, "delayed");

  const fallback = selectPriceObservation({
    asOf: "2026-08-04",
    targetKey: "security-a",
    observations: [price({ marketDate: "2026-08-03" })],
  });
  assert.equal(fallback.status, "fallback");
  assert.equal(fallback.explanation.fallback, true);

  const unavailable = selectPriceObservation({
    asOf: "2026-08-20",
    targetKey: "security-a",
    observations: [price({ marketDate: "2026-08-03" })],
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.display, null);
});

test("selection respects deployment and authenticated user observation scope", () => {
  const deployment = price({ closeDecimal: "40" });
  const userObservation = price({
    closeDecimal: "41",
    scope: { kind: "user", userId: "user-a" },
  });
  const own = selectPriceObservation({
    asOf: "2026-08-03",
    targetKey: "security-a",
    userId: "user-a",
    scope: { kind: "user", userId: "user-a" },
    observations: [deployment, userObservation],
  });
  assert.equal(own.selected?.closeDecimal, "41");
  const other = selectPriceObservation({
    asOf: "2026-08-03",
    targetKey: "security-a",
    userId: "user-b",
    scope: { kind: "user", userId: "user-b" },
    observations: [deployment, userObservation],
  });
  assert.equal(other.status, "unavailable");
});

test("manual price and FX overrides take priority and identity FX is exact", () => {
  const override: ManualOverride = {
    kind: "manual_override",
    id: "override-price",
    userId: "user-a",
    portfolioId: "portfolio-a",
    securityId: "security-a",
    type: "price",
    targetKey: "security-a",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-10",
    valueJson: '{"closeDecimal":"43.25","currencyCode":"AUD"}',
    reason: "Corrected close",
    status: "active",
    supersedesOverrideId: null,
    createdAt: "2026-08-03T08:00:00Z",
  };
  const selected = selectPriceObservation({
    asOf: "2026-08-03",
    targetKey: "security-a",
    observations: [price()],
    overrides: [override],
  });
  assert.equal(selected.selected?.source, "manual");
  assert.equal(selected.selected?.closeDecimal, "43.25");
  assert.equal(selected.explanation.overrideId, "override-price");

  const manualFx = selectFxObservation({
    asOf: "2026-08-03",
    targetKey: "USD->AUD",
    baseCurrencyCode: "USD",
    quoteCurrencyCode: "AUD",
    observations: [fx({ rateDecimal: "1.51" })],
    overrides: [
      {
        ...override,
        id: "override-fx",
        type: "fx_rate",
        targetKey: "USD->AUD",
        valueJson:
          '{"rateDecimal":"1.53","baseCurrencyCode":"USD","quoteCurrencyCode":"AUD"}',
      },
    ],
  });
  assert.equal(manualFx.selected?.rateDecimal, "1.53");
  const identity = selectFxObservation({
    asOf: "2026-08-03",
    targetKey: "AUD->AUD",
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "AUD",
    observations: [],
  });
  assert.equal(identity.selected?.rateDecimal, "1");
  assert.equal(identity.explanation.source, "identity");
});

test("coverage totals stay aligned and never turn gaps into zero", () => {
  const coverage = composeCoveredTotals([
    { id: "covered", valueDecimal: "100.25", basisDecimal: "80" },
    { id: "missing-price", valueDecimal: null, basisDecimal: "20" },
    { id: "missing-basis", valueDecimal: "30", basisDecimal: null },
  ]);
  assert.equal(coverage.status, "partial");
  assert.equal(coverage.valueTotalDecimal, "130.25");
  assert.equal(coverage.basisTotalDecimal, "100");
  assert.equal(coverage.alignedValueTotalDecimal, "100.25");
  assert.deepEqual(coverage.excludedIds, ["missing-price", "missing-basis"]);
});

test("manual overrides are owner-scoped, interval-conflict checked, supersedable, and removable", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedManualOverrideRepository(
    createSqliteSqlClient(database),
    () => "2026-08-03T09:00:00Z",
  );
  const input = {
    portfolioId: "portfolio-a",
    securityId: null,
    type: "price" as const,
    targetKey: "security-a",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-10",
    valueJson: '{"closeDecimal":"43.25","currencyCode":"AUD"}',
    reason: "Corrected close",
    requestId: "request-1",
  };
  const saved = await repository.save("user-a", input);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.ok(saved.invalidationId);
  const conflict = await repository.save("user-a", {
    ...input,
    valueJson: '{"closeDecimal":"44","currencyCode":"AUD"}',
    requestId: "request-2",
  });
  assert.deepEqual(conflict, { ok: false, reason: "conflict" });
  const replacement = await repository.save("user-a", {
    ...input,
    id: "override-2",
    valueJson: '{"closeDecimal":"44","currencyCode":"AUD"}',
    supersedesOverrideId: saved.override.id,
    requestId: "request-3",
  });
  assert.equal(replacement.ok, true);
  const crossUser = await repository.remove(
    "user-b",
    saved.override.id,
    "request-4",
  );
  assert.deepEqual(crossUser, { ok: false, reason: "not_found" });
  const removed = await repository.remove("user-a", "override-2", "request-5");
  assert.equal(removed.ok, true);
  if (removed.ok) {
    const restored = selectPriceObservation({
      asOf: "2026-08-03",
      targetKey: "security-a",
      observations: [price({ closeDecimal: "42" })],
      overrides: [removed.override],
    });
    assert.equal(restored.selected?.source, "provider");
    assert.equal(restored.selected?.closeDecimal, "42");
  }
  assert.equal(
    present(
      database
        .prepare("SELECT status FROM manual_overrides WHERE id = 'override-2'")
        .get() as { status: string } | undefined,
    ).status,
    "revoked",
  );
  assert.equal(
    present(
      database.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as
        { count: number } | undefined,
    ).count,
    3,
  );
  assert.equal(
    present(
      database
        .prepare("SELECT COUNT(*) AS count FROM calculation_runs")
        .get() as { count: number } | undefined,
    ).count,
    3,
  );
});

test("manual override atomic failure leaves no override or invalidation", async () => {
  const database = await migratedDatabase();
  const baseClient = createSqliteSqlClient(database);
  const failingClient = {
    ...baseClient,
    batch: async () => {
      throw new Error("injected failure");
    },
  };
  const repository = createOwnedManualOverrideRepository(failingClient);
  const failed = await repository.save("user-a", {
    portfolioId: "portfolio-a",
    type: "price",
    targetKey: "security-a",
    effectiveFrom: "2026-08-01",
    valueJson: '{"closeDecimal":"43.25","currencyCode":"AUD"}',
    reason: "Corrected close",
    requestId: "request-fail",
  });
  assert.deepEqual(failed, { ok: false, reason: "atomic_failure" });
  assert.equal(
    present(
      database
        .prepare("SELECT COUNT(*) AS count FROM manual_overrides")
        .get() as { count: number } | undefined,
    ).count,
    0,
  );
  assert.equal(
    present(
      database
        .prepare("SELECT COUNT(*) AS count FROM calculation_runs")
        .get() as { count: number } | undefined,
    ).count,
    0,
  );
});
