import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createImportReconciliationPreview,
  type ImportPreviewMappingDecision,
  type ImportReconciliationRow,
  type NormalizedImportRow,
} from "../domain/imports/index.ts";
import {
  createOwnedImportMappingDecisionRepository,
  createSqliteSqlClient,
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
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-07-30', '2026-07-30', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-07-30', '2026-07-30', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-07-30', '2026-07-30', 1);
    INSERT INTO import_batches (id, user_id, parser_format, parser_version, filename, byte_size, file_sha256, status, created_at, updated_at, version)
    VALUES ('batch-a', 'user-a', 'strict-versioned-csv', '1', 'sample.csv', 10, 'hash-a', 'parsed', '2026-07-30', '2026-07-30', 1);
  `);
  return database;
}

function row(
  id: string,
  physicalRowNumber: number,
  overrides: Partial<NormalizedImportRow> = {},
): ImportReconciliationRow {
  return {
    id,
    physicalRowNumber,
    rowClass: "transaction",
    fingerprint: id,
    normalized: {
      id,
      symbol: "ABC",
      name: "Alpha",
      displaySymbol: null,
      exchange: "ASX",
      portfolio: "Main",
      currency: "USD",
      sharesOwned: "5",
      costPerShare: "10",
      commission: "0",
      transactionDate: "2026-07-01 GMT+1000",
      transactionTime: "10:00:00",
      purchaseExchangeRate: "1.5",
      type: "buy",
      accounting: "fifo",
      accountingExecutionIds: null,
      notes: null,
      tradeAtUtc: "2026-07-01T00:00:00.000Z",
      localTradeDate: "2026-07-01",
      cashEvent: null,
      ...overrides,
    },
  };
}

const portfolio = {
  id: "portfolio-a",
  name: "Main",
  homeCurrencyCode: "AUD",
  historyCompleteFrom: "2026-01-01",
};

const security = {
  id: "membership-a",
  portfolioId: "portfolio-a",
  sourceSymbol: "ABC",
  sourceExchangeAlias: "ASX",
  sourceCurrencyCode: "USD",
  securityId: "security-abc",
};

const decisions: ImportPreviewMappingDecision[] = [
  {
    kind: "security",
    sourceKey: "portfolio-a|abc|asx|usd",
    scope: "batch",
    targetId: "membership-a",
  },
  {
    kind: "fx",
    sourceKey: "USD->AUD",
    scope: "batch",
    targetValue: "native_to_home",
  },
];

test("reconciliation previews deterministic quantities and explicit mappings", () => {
  const preview = createImportReconciliationPreview({
    portfolios: [portfolio],
    securityCandidates: [security],
    decisions,
    rows: [
      row("buy-1", 2),
      row("sell-1", 3, {
        type: "sell",
        sharesOwned: "2",
        tradeAtUtc: "2026-07-02T00:00:00.000Z",
      }),
      { ...row("duplicate", 4, { id: "buy-1" }), fingerprint: "buy-1" },
    ],
  });

  assert.equal(preview.ready, true);
  assert.deepEqual(preview.projectedQuantities, { "membership-a": "3" });
  assert.deepEqual(preview.counts, {
    transactionCreates: 2,
    candidateCreates: 0,
    skips: 1,
    unresolved: 0,
  });
  assert.equal(preview.issues[0]?.code, "DUPLICATE_ROW");
});

test("ambiguous securities, FX direction, oversell, and incomplete history block or explain preview", () => {
  const ambiguous = createImportReconciliationPreview({
    portfolios: [portfolio],
    securityCandidates: [security, { ...security, id: "membership-b" }],
    rows: [row("ambiguous", 2)],
  });
  assert.equal(ambiguous.ready, false);
  assert.equal(ambiguous.issues[0]?.code, "SECURITY_MAPPING_AMBIGUOUS");

  const oversell = createImportReconciliationPreview({
    portfolios: [{ ...portfolio, historyCompleteFrom: null }],
    securityCandidates: [security],
    decisions,
    rows: [row("sell", 2, { type: "sell", sharesOwned: "1" })],
  });
  assert.equal(oversell.ready, false);
  assert.ok(oversell.issues.some((issue) => issue.code === "OVERSELL"));
  assert.ok(
    oversell.issues.some((issue) => issue.code === "INCOMPLETE_HISTORY"),
  );
});

test("cash sentinel previews without creating a security candidate", () => {
  const preview = createImportReconciliationPreview({
    portfolios: [portfolio],
    securityCandidates: [],
    rows: [
      row("cash", 2, {
        symbol: "USD=CASH",
        exchange: null,
        currency: "USD",
        purchaseExchangeRate: null,
        cashEvent: "cash_deposit",
      }),
    ],
  });
  assert.equal(preview.ready, true);
  assert.equal(preview.counts.candidateCreates, 0);
  assert.equal(preview.unresolvedCandidates.length, 0);
});

test("row decisions override batch decisions and unresolved candidates remain blocked", () => {
  const unresolved = createImportReconciliationPreview({
    portfolios: [portfolio],
    securityCandidates: [{ ...security, securityId: null }],
    decisions: [
      {
        kind: "security",
        sourceKey: "buy-1",
        scope: "row",
        targetId: "membership-a",
      },
      decisions[1]!,
    ],
    rows: [row("buy-1", 2)],
  });
  assert.equal(unresolved.ready, false);
  assert.ok(
    unresolved.issues.some(
      (issue) => issue.code === "SECURITY_MAPPING_REQUIRED",
    ),
  );

  const invalidFx = createImportReconciliationPreview({
    portfolios: [portfolio],
    securityCandidates: [security],
    decisions: [
      decisions[0]!,
      {
        kind: "fx",
        sourceKey: "USD->AUD",
        scope: "batch",
        targetValue: "not-a-direction",
      },
    ],
    rows: [row("buy-1", 2)],
  });

  assert.equal(invalidFx.ready, false);
  assert.ok(
    invalidFx.issues.some((issue) => issue.code === "FX_DIRECTION_REQUIRED"),
  );
});

test("mapping decisions are owner-scoped and reusable by batch", async () => {
  const database = await migratedDatabase();
  const repository = createOwnedImportMappingDecisionRepository(
    createSqliteSqlClient(database),
    () => "2026-07-30T12:00:00Z",
  );
  const saved = await repository.save("user-a", {
    batchId: "batch-a",
    kind: "security",
    sourceKey: "portfolio-a|abc|asx|usd",
    normalizedSourceValue: "abc|asx|usd",
    targetId: "membership-a",
    targetValue: null,
    scope: "batch",
    confidence: "user",
    source: "user",
  });
  assert.equal(saved.userId, "user-a");
  assert.equal((await repository.list("user-a", "batch-a")).length, 1);
  assert.deepEqual(await repository.list("user-b", "batch-a"), []);
  const updated = await repository.save("user-a", {
    batchId: "batch-a",
    kind: "security",
    sourceKey: "portfolio-a|abc|asx|usd",
    normalizedSourceValue: "abc|asx|usd",
    targetId: "membership-a",
    targetValue: "resolved",
    scope: "batch",
    confidence: "user",
    source: "user",
  });
  assert.equal(updated.targetValue, "resolved");
  assert.equal(updated.version, 2);
});
