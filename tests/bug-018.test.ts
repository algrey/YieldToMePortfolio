// BUG-018 -- a reversed transaction's `source_reference` used to occupy
// `transactions_portfolio_source_reference_unique` forever (`ledger.reverse()`
// never clears it), so a reverse-then-re-import of the SAME trade landed the
// re-import row as `commit_status = 'skipped'` pointing at the REVERSED
// transaction and created no new ledger fact. For a Sharesight sync batch --
// whose keys are `sharesight-trade:<id>`, identity-only and never changing --
// this made every reversed trade permanently unsyncable.
//
// Fix: `transactions_portfolio_source_reference_unique` narrowed to a PARTIAL
// unique index `WHERE status <> 'reversed'` (`db/schema.ts`, migration
// `0060_bug_018_reversed_source_reference_partial_index.sql`); the matching
// `AND status <> 'reversed'` predicate added to `import-commit.ts`'s
// commit-time trade lookup, `app/import-actions.ts`'s
// `existingTradeSourceReferences` suppression query (BUG-013's proven
// invariant: suppression set == commit skip set), and
// `sharesight-sync-state.ts`'s `loadCommittedSharesightRowValues` (BRK-014's
// value-comparison map, which mirrors the commit predicate by design).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  commitPortfolioBundleImport,
  commitPortfolioBundleScaffold,
  commitPortfolioBundleTransactionsPart,
  exportPortfolioBundle,
} from "../app/portfolio-bundle-service.ts";
import { chainOrder } from "../domain/exports/chain-order.ts";
import type { PortfolioBundleV1 } from "../domain/exports/portfolio-bundle.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedLedgerRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  loadCommittedSharesightRowValues,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
import type {
  SharesightClient,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";

// ---------------------------------------------------------------------------
// Fixtures (CSV path) -- mirrors tests/imp-003a.test.ts/imp-003b.test.ts.
// ---------------------------------------------------------------------------

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-09-03', '2026-09-03', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-09-03', '2026-09-03', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-09-03', '2026-09-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-09-03', '2026-09-03'),
           ('membership-b', 'user-b', 'portfolio-b', 'security-a', 'ABC', 'AUD', 'held', '2026-09-03', '2026-09-03');
  `);
  return database;
}

function normalized(
  rowNumber: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `source-${rowNumber}`,
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
    transactionTime: `10:00:${String(rowNumber).padStart(2, "0")}`,
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `2026-08-01T00:00:${String(rowNumber).padStart(2, "0")}.000Z`,
    localTradeDate: "2026-08-01",
    cashEvent: null,
    ...overrides,
  };
}

function insertBatch(
  database: DatabaseSync,
  input: {
    id: string;
    userId?: string;
    targetPortfolioId?: string;
    fileSha256: string;
    status?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES (?, ?, ?, 'strict-versioned-csv', ?, ?, 100, ?, ?,
         '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 1)`,
    )
    .run(
      input.id,
      input.userId ?? "user-a",
      input.targetPortfolioId ?? "portfolio-a",
      SUPPORTED_IMPORT_PARSER_VERSION,
      `${input.id}.csv`,
      input.fileSha256,
      input.status ?? "ready",
    );
}

function stageTradeRow(
  database: DatabaseSync,
  input: {
    id: string;
    batchId: string;
    userId?: string;
    physicalRowNumber: number;
    fingerprint: string;
    targetPortfolioId?: string;
    targetPortfolioSecurityId?: string;
    overrides?: Record<string, unknown>;
  },
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, target_portfolio_security_id,
         commit_status, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, 'transaction', '[]', ?, ?, 'valid', ?, ?,
         'staged', '2026-09-03', '2026-09-03', 1)`,
    )
    .run(
      input.id,
      input.userId ?? "user-a",
      input.batchId,
      input.physicalRowNumber,
      JSON.stringify(
        normalized(input.physicalRowNumber, input.overrides ?? {}),
      ),
      input.fingerprint,
      input.targetPortfolioId ?? "portfolio-a",
      input.targetPortfolioSecurityId ?? "membership-a",
    );
}

async function previewVersion(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<string> {
  const validated = await createOwnedImportCommitRepository(client).validate(
    userId,
    batchId,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("preview validation failed");
  return validated.previewVersion;
}

function commitInput(version: string, key: string): ImportCommitInput {
  return {
    expectedVersion: 1,
    expectedPreviewVersion: version,
    idempotencyKey: key,
    confirmation: true,
    requestId: `${key}-request`,
  };
}

async function commitBatchToCompletion(
  client: SqlClient,
  userId: string,
  batchId: string,
  key: string,
): Promise<void> {
  const version = await previewVersion(client, userId, batchId);
  const repository = createOwnedImportCommitRepository(client);
  let result = await repository.commit(
    userId,
    batchId,
    commitInput(version, key),
  );
  for (
    let attempt = 0;
    attempt < 10 && (!result.ok || result.status !== "committed");
    attempt += 1
  ) {
    assert.equal(result.ok, true);
    result = await repository.commit(
      userId,
      batchId,
      commitInput(version, key),
    );
  }
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected the import to commit");
  assert.equal(result.status, "committed");
}

function reversalInput(expectedVersion: number, key = "reverse-a") {
  return {
    expectedVersion,
    idempotencyKey: key,
    confirmation: true,
    requestId: "request-reversal",
  };
}

function batchVersion(database: DatabaseSync, batchId: string): number {
  return (
    database
      .prepare("SELECT version FROM import_batches WHERE id = ?")
      .get(batchId) as { version: number }
  ).version;
}

// The exact suppression query BUG-018 adds `status <> 'reversed'` to
// (`app/import-actions.ts`'s `existingTradeSourceReferences`) -- reproduced
// here because that file transitively imports `next/headers` and cannot be
// imported by this plain Node test runner (established precedent, see
// tests/bug-011.test.ts's F-a source-pin doc comment).
function suppressionSetContains(
  database: DatabaseSync,
  userId: string,
  portfolioId: string,
  sourceReference: string,
): boolean {
  const rows = database
    .prepare(
      `SELECT portfolio_id, source_reference FROM transactions
       WHERE user_id = ? AND source_type = 'csv_import' AND source_reference IS NOT NULL
         AND status <> 'reversed'`,
    )
    .all(userId) as { portfolio_id: string; source_reference: string }[];
  return rows.some(
    (row) =>
      row.portfolio_id === portfolioId &&
      row.source_reference === sourceReference,
  );
}

// The exact economic-identity comparison query BUG-011 built
// (`app/import-actions.ts`'s `existingTradeRows`), reproduced for the same
// reason as above -- used to prove a re-imported trade never warns against
// its own reversed self or the reversal's compensating mirror.
function economicIdentityMatches(
  database: DatabaseSync,
  userId: string,
  portfolioSecurityId: string,
  type: string,
  localTradeDate: string,
  quantityDecimal: string,
  unitPriceDecimal: string,
): number {
  const rows = database
    .prepare(
      `SELECT portfolio_security_id, type, local_trade_date,
              quantity_decimal, unit_price_decimal
       FROM transactions
       WHERE user_id = ? AND status = 'posted'
         AND type IN ('buy', 'sell') AND reverses_transaction_id IS NULL
         AND portfolio_security_id IS NOT NULL
         AND quantity_decimal IS NOT NULL AND unit_price_decimal IS NOT NULL`,
    )
    .all(userId) as {
    portfolio_security_id: string;
    type: string;
    local_trade_date: string;
    quantity_decimal: string;
    unit_price_decimal: string;
  }[];
  return rows.filter(
    (row) =>
      row.portfolio_security_id === portfolioSecurityId &&
      row.type === type &&
      row.local_trade_date === localTradeDate &&
      row.quantity_decimal === quantityDecimal &&
      row.unit_price_decimal === unitPriceDecimal,
  ).length;
}

// ---------------------------------------------------------------------------
// A1: core regression -- reverse-then-re-import lands as a new posted
// transaction; the reversed original and its mirror stay untouched.
// ---------------------------------------------------------------------------

test("BUG-018 regression: reverse-then-re-import of an identical CSV trade lands as a NEW posted transaction with a cash entry; the reversed original and its compensating mirror are untouched; import_rows.commit_status reaches 'committed', never 'skipped' -- fails pre-fix (the re-import used to skip against the still-occupying reversed row)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);

  insertBatch(database, { id: "batch-a", fileSha256: "file-a" });
  stageTradeRow(database, {
    id: "row-1",
    batchId: "batch-a",
    physicalRowNumber: 2,
    fingerprint: "shared-fingerprint",
  });
  await commitBatchToCompletion(client, "user-a", "batch-a", "commit-a");

  const original = database
    .prepare(
      `SELECT id, status FROM transactions
       WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:shared-fingerprint'`,
    )
    .get() as { id: string; status: string };
  assert.equal(original.status, "posted");

  const reversed = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(batchVersion(database, "batch-a")),
  );
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");

  const originalAfterReversal = database
    .prepare("SELECT status, source_reference FROM transactions WHERE id = ?")
    .get(original.id) as { status: string; source_reference: string };
  assert.equal(originalAfterReversal.status, "reversed");
  assert.equal(
    originalAfterReversal.source_reference,
    "import-fingerprint:shared-fingerprint",
    "ledger.reverse() must never clear source_reference -- the reversed fact is immutable",
  );
  const mirror = database
    .prepare(
      "SELECT id, status, reverses_transaction_id FROM transactions WHERE reverses_transaction_id = ?",
    )
    .get(original.id) as {
    id: string;
    status: string;
    reverses_transaction_id: string;
  };
  assert.equal(mirror.status, "posted");

  // The suppression set and the economic-identity comparison must both
  // already treat this identity as free/non-matching BEFORE the re-import
  // batch is even staged -- the re-import must not warn against its own
  // reversed self or the reversal mirror (both share identical economics).
  assert.equal(
    suppressionSetContains(
      database,
      "user-a",
      "portfolio-a",
      "import-fingerprint:shared-fingerprint",
    ),
    false,
    "a reversed row must no longer suppress TRADE_NEAR_EXISTING_ENTRY -- BUG-013's suppression-set-equals-skip-set invariant",
  );
  assert.equal(
    economicIdentityMatches(
      database,
      "user-a",
      "membership-a",
      "buy",
      "2026-08-01",
      "2",
      "10",
    ),
    0,
    "neither the reversed original (excluded by status='posted') nor its mirror (excluded by reverses_transaction_id) may match",
  );

  // Re-import: a distinct batch (a fresh upload) staging a row whose
  // fingerprint reproduces the SAME identity.
  insertBatch(database, {
    id: "batch-b",
    fileSha256: "file-b",
    status: "ready",
  });
  database
    .prepare(`UPDATE import_batches SET version = 1 WHERE id = 'batch-b'`)
    .run();
  stageTradeRow(database, {
    id: "row-2",
    batchId: "batch-b",
    physicalRowNumber: 2,
    fingerprint: "shared-fingerprint",
  });
  await commitBatchToCompletion(client, "user-a", "batch-b", "commit-b");

  const reimportedRow = database
    .prepare(
      "SELECT commit_status, commit_transaction_id FROM import_rows WHERE id = 'row-2'",
    )
    .get() as { commit_status: string; commit_transaction_id: string | null };
  assert.equal(
    reimportedRow.commit_status,
    "committed",
    "BUG-018: must commit as a genuinely new row, not skip against the reversed original",
  );
  assert.ok(reimportedRow.commit_transaction_id);
  assert.notEqual(reimportedRow.commit_transaction_id, original.id);
  assert.notEqual(reimportedRow.commit_transaction_id, mirror.id);

  const reimported = database
    .prepare(
      "SELECT status, source_reference, reverses_transaction_id FROM transactions WHERE id = ?",
    )
    .get(reimportedRow.commit_transaction_id) as {
    status: string;
    source_reference: string;
    reverses_transaction_id: string | null;
  };
  assert.equal(reimported.status, "posted");
  assert.equal(
    reimported.source_reference,
    "import-fingerprint:shared-fingerprint",
    "the re-import reuses the SAME source_reference -- the partial index frees it once the prior row is reversed",
  );
  assert.equal(reimported.reverses_transaction_id, null);

  // A cash entry was created for the new posting.
  const cashEntry = database
    .prepare("SELECT id FROM cash_ledger_entries WHERE transaction_id = ?")
    .get(reimportedRow.commit_transaction_id);
  assert.ok(
    cashEntry,
    "the re-imported trade must post a cash entry like any normal committed trade",
  );

  // The original reversed row and its mirror are untouched.
  const originalAfterReimport = database
    .prepare("SELECT status, source_reference FROM transactions WHERE id = ?")
    .get(original.id) as { status: string; source_reference: string };
  assert.deepEqual(originalAfterReimport, originalAfterReversal);
  const mirrorAfterReimport = database
    .prepare("SELECT status FROM transactions WHERE id = ?")
    .get(mirror.id) as { status: string };
  assert.equal(mirrorAfterReimport.status, "posted");

  // Three rows now legitimately share the identity triple: the reversed
  // original, its mirror (source_type = 'system', untouched by the index),
  // and the freshly re-imported posted row -- exactly two `csv_import` rows
  // coexist under the partial index (one reversed, one not).
  const sharingIdentity = database
    .prepare(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE user_id = 'user-a' AND source_type = 'csv_import'
         AND source_reference = 'import-fingerprint:shared-fingerprint'`,
    )
    .get() as { count: number };
  assert.equal(sharingIdentity.count, 2);
});

// ---------------------------------------------------------------------------
// A2: a batch still mid-reversal ('reversing') -- the not-yet-reversed
// transaction still blocks a re-import; the already-reversed one (processed
// by an earlier chunk of the SAME still-reversing batch) is importable.
// ---------------------------------------------------------------------------

test("BUG-018: a batch mid-reversal ('reversing', chunked) still blocks re-import of its not-yet-reversed transaction, while a transaction an earlier chunk already flipped to 'reversed' is importable even though the batch itself has not finished reversing", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);

  insertBatch(database, { id: "batch-a", fileSha256: "file-a" });
  stageTradeRow(database, {
    id: "row-1",
    batchId: "batch-a",
    physicalRowNumber: 2,
    fingerprint: "fp-1",
  });
  stageTradeRow(database, {
    id: "row-2",
    batchId: "batch-a",
    physicalRowNumber: 3,
    fingerprint: "fp-2",
  });
  await commitBatchToCompletion(client, "user-a", "batch-a", "commit-a");

  const [t1, t2] = database
    .prepare(
      `SELECT id, source_reference FROM transactions
       WHERE user_id = 'user-a' ORDER BY source_reference ASC`,
    )
    .all() as { id: string; source_reference: string }[];
  assert.ok(t1 && t2);

  // chunkSize 1: a single reverse() call processes exactly one transaction
  // and leaves the batch 'reversing', not 'reversed'.
  const reversalRepo = createOwnedImportReversalRepository(client, {
    chunkSize: 1,
  });
  const firstChunk = await reversalRepo.reverse(
    "user-a",
    "batch-a",
    reversalInput(batchVersion(database, "batch-a"), "reverse-chunked"),
  );
  assert.equal(firstChunk.ok, true);
  if (firstChunk.ok) assert.equal(firstChunk.status, "reversing");

  const batchStatus = database
    .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
    .get() as { status: string };
  assert.equal(batchStatus.status, "reversing");

  const statuses = database
    .prepare("SELECT id, status FROM transactions WHERE id IN (?, ?)")
    .all(t1!.id, t2!.id) as { id: string; status: string }[];
  const reversedNow = statuses.find((row) => row.status === "reversed");
  const stillPosted = statuses.find((row) => row.status === "posted");
  assert.ok(
    reversedNow,
    "exactly one transaction was processed by the single chunk",
  );
  assert.ok(stillPosted, "the other transaction has not been reached yet");

  const reversedFingerprint =
    reversedNow!.id === t1!.id ? t1!.source_reference : t2!.source_reference;
  const postedFingerprint =
    stillPosted!.id === t1!.id ? t1!.source_reference : t2!.source_reference;

  // Re-import BOTH identities while the batch is still 'reversing'.
  insertBatch(database, { id: "batch-b", fileSha256: "file-b" });
  const reversedFp = reversedFingerprint.replace("import-fingerprint:", "");
  const postedFp = postedFingerprint.replace("import-fingerprint:", "");
  stageTradeRow(database, {
    id: "row-3",
    batchId: "batch-b",
    physicalRowNumber: 2,
    fingerprint: reversedFp,
  });
  stageTradeRow(database, {
    id: "row-4",
    batchId: "batch-b",
    physicalRowNumber: 3,
    fingerprint: postedFp,
  });
  await commitBatchToCompletion(client, "user-a", "batch-b", "commit-b");

  const reimportedRows = database
    .prepare(
      "SELECT id, commit_status, commit_transaction_id FROM import_rows WHERE batch_id = 'batch-b'",
    )
    .all() as {
    id: string;
    commit_status: string;
    commit_transaction_id: string | null;
  }[];
  const reversedRow = reimportedRows.find((row) => row.id === "row-3");
  const postedRow = reimportedRows.find((row) => row.id === "row-4");
  assert.equal(
    reversedRow?.commit_status,
    "committed",
    "the identity an earlier chunk already reversed is importable even though the batch overall is still 'reversing'",
  );
  assert.equal(
    postedRow?.commit_status,
    "skipped",
    "the identity not yet reached by the reversal is still 'posted' and must still block re-import",
  );
  assert.equal(postedRow?.commit_transaction_id, stillPosted!.id);
});

// ---------------------------------------------------------------------------
// A3: ownership isolation.
// ---------------------------------------------------------------------------

test("BUG-018: ownership isolation -- a different owner's posted transaction sharing the identical source_reference STRING (a different portfolio) is unaffected by, and does not block or leak into, this owner's reverse-then-re-import", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);

  insertBatch(database, { id: "batch-a", fileSha256: "file-a" });
  stageTradeRow(database, {
    id: "row-1",
    batchId: "batch-a",
    physicalRowNumber: 2,
    fingerprint: "shared-fingerprint",
  });
  await commitBatchToCompletion(client, "user-a", "batch-a", "commit-a");

  insertBatch(database, {
    id: "batch-owner-b",
    userId: "user-b",
    targetPortfolioId: "portfolio-b",
    fileSha256: "file-owner-b",
  });
  stageTradeRow(database, {
    id: "row-owner-b",
    batchId: "batch-owner-b",
    userId: "user-b",
    physicalRowNumber: 2,
    fingerprint: "shared-fingerprint",
    targetPortfolioId: "portfolio-b",
    targetPortfolioSecurityId: "membership-b",
  });
  await commitBatchToCompletion(
    client,
    "user-b",
    "batch-owner-b",
    "commit-owner-b",
  );

  const userATransaction = database
    .prepare(
      "SELECT id FROM transactions WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:shared-fingerprint'",
    )
    .get() as { id: string };
  const reversed = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(batchVersion(database, "batch-a")),
  );
  assert.equal(reversed.ok, true);

  // user-b's row, sharing the exact same string identity in a different
  // (differently-owned) portfolio, is untouched by user-a's reversal.
  const userBTransaction = database
    .prepare(
      "SELECT status FROM transactions WHERE user_id = 'user-b' AND source_reference = 'import-fingerprint:shared-fingerprint'",
    )
    .get() as { status: string };
  assert.equal(userBTransaction.status, "posted");

  // user-a re-imports; user-b's unrelated posted row must not block it (the
  // commit-time lookup and the partial index are both scoped by
  // portfolio_id, and portfolios are owned by a single user).
  insertBatch(database, { id: "batch-b", fileSha256: "file-b" });
  stageTradeRow(database, {
    id: "row-2",
    batchId: "batch-b",
    physicalRowNumber: 2,
    fingerprint: "shared-fingerprint",
  });
  await commitBatchToCompletion(client, "user-a", "batch-b", "commit-b");
  const reimportedRow = database
    .prepare("SELECT commit_status FROM import_rows WHERE id = 'row-2'")
    .get() as { commit_status: string };
  assert.equal(reimportedRow.commit_status, "committed");

  // And user-a's activity leaves user-b's row exactly as it was.
  const userBTransactionAfter = database
    .prepare(
      "SELECT status FROM transactions WHERE user_id = 'user-b' AND source_reference = 'import-fingerprint:shared-fingerprint'",
    )
    .get() as { status: string };
  assert.deepEqual(userBTransactionAfter, userBTransaction);
  assert.ok(userATransaction.id);
});

// ---------------------------------------------------------------------------
// B: the partial unique index itself -- schema-level guarantee, independent
// of any application code path.
// ---------------------------------------------------------------------------

test("BUG-018: the partial unique index rejects a second NON-reversed row sharing (portfolio_id, source_type, source_reference), but permits one once the first is reversed -- schema-level, bypassing the application layer entirely", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const ledger = createOwnedLedgerRepository(client);

  const first = await ledger.post("user-a", {
    portfolioId: "portfolio-a",
    type: "buy",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "1",
    unitPriceDecimal: "10",
    grossAmountDecimal: "10",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: "1",
    sourceType: "csv_import",
    sourceReference: "import-fingerprint:dup-key",
    idempotencyKey: "idem-1",
    tradeAt: "2026-08-01T00:00:00.000Z",
    localTradeDate: "2026-08-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: "identity",
    fxObservedAt: null,
    requestId: "request-1",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstRow = database
    .prepare("SELECT * FROM transactions WHERE id = ?")
    .get(first.transaction.id) as Record<string, unknown>;
  assert.ok(firstRow);

  const columns = Object.keys(firstRow);
  const insertSql = `INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  function insertCopy(overrides: Record<string, unknown>): void {
    const values = columns.map(
      (column) =>
        (column in overrides
          ? overrides[column]
          : firstRow[column]) as SQLInputValue,
    );
    database.prepare(insertSql).run(...values);
  }

  // A second row sharing the identity triple, still `status = 'posted'`
  // (same as the first) -- the partial index must reject this.
  assert.throws(
    () =>
      insertCopy({
        id: "duplicate-1",
        idempotency_key: "idem-2",
        status: "posted",
      }),
    /UNIQUE constraint failed/,
  );

  // Reverse the first row directly at the schema level (equivalent to what
  // `ledger.reverse()`'s status flip does).
  database
    .prepare("UPDATE transactions SET status = 'reversed' WHERE id = ?")
    .run(first.transaction.id);

  // Now a NON-reversed duplicate is permitted -- the partial index's `WHERE
  // status <> 'reversed'` no longer counts the first row.
  assert.doesNotThrow(() =>
    insertCopy({
      id: "duplicate-2",
      idempotency_key: "idem-3",
      status: "posted",
    }),
  );

  // A second reversed row sharing the SAME identity is also permitted --
  // the partial index places no limit on the reversed group at all.
  assert.doesNotThrow(() =>
    insertCopy({
      id: "duplicate-3",
      idempotency_key: "idem-4",
      status: "reversed",
    }),
  );

  // But a THIRD non-reversed duplicate, while "duplicate-2" is still
  // 'posted', is rejected exactly like the very first attempt.
  assert.throws(
    () =>
      insertCopy({
        id: "duplicate-4",
        idempotency_key: "idem-5",
        status: "posted",
      }),
    /UNIQUE constraint failed/,
  );
});

// ---------------------------------------------------------------------------
// C: Sharesight sync -- a reversed sync-sourced trade reads as NEW on the
// next sync and, once accepted, actually lands as a new posted transaction.
// ---------------------------------------------------------------------------

function fakeTrade(overrides: Partial<SharesightTrade> = {}): SharesightTrade {
  return {
    id: "trade-1",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    instrumentCode: "ABC",
    marketCode: "ASX",
    sharesightInstrumentId: null,
    instrumentName: null,
    isin: null,
    transactionType: "buy",
    transactionDate: "2026-08-01",
    currencyCode: "AUD",
    quantityDecimal: "5",
    priceDecimal: "10",
    valueDecimal: "50",
    brokerageDecimal: null,
    brokerageCurrencyCode: null,
    exchangeRateDecimal: null,
    exchangeRatePair: null,
    state: null,
    uniqueIdentifier: null,
    paidOnDate: null,
    descriptionCode: null,
    sourceCategory: null,
    comments: null,
    ...overrides,
  };
}

function fakePortfolio(
  overrides: Partial<SharesightPortfolio> = {},
): SharesightPortfolio {
  return {
    id: "sp-1",
    name: "My SS Portfolio",
    currencyCode: "AUD",
    inceptionDate: null,
    tzName: null,
    accessLevel: null,
    financialYearEnd: null,
    cgDiscount: null,
    countryCode: null,
    ownerName: null,
    taxEntityType: null,
    ...overrides,
  };
}

function fakeSharesightClient(fixtures: {
  portfolios?: SharesightPortfolio[];
  trades?: SharesightTrade[];
}): SharesightClient {
  return {
    async listPortfolios() {
      return { ok: true, value: fixtures.portfolios ?? [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return { ok: true, value: fixtures.trades ?? [] } as SharesightResult<
        SharesightTrade[]
      >;
    },
    async listPayouts() {
      return { ok: true, value: [] };
    },
    async listUserInstruments() {
      return { ok: true, value: [] };
    },
  };
}

async function sharesightMigratedDatabase(): Promise<DatabaseSync> {
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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-09-03', '2026-09-03', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-09-03', '2026-09-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-09-03', '2026-09-03');
  `);
  return database;
}

async function shPreviewVersion(
  client: SqlClient,
  batchId: string,
): Promise<string> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get("user-a", batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows("user-a", batchId),
      staging.listIssues("user-a", batchId),
      createOwnedImportMappingDecisionRepository(client).list(
        "user-a",
        batchId,
      ),
      createOwnedPortfolioRepository(client).list("user-a"),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
                source_currency_code, security_id
           FROM portfolio_securities WHERE user_id = ?
          ORDER BY source_symbol ASC, id ASC`,
        ["user-a"],
      ),
    ],
  );
  const review = buildImportReviewPreview({
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
  return review.previewVersion;
}

async function shCommitBatch(
  client: SqlClient,
  batchId: string,
): Promise<void> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get("user-a", batchId);
  if (!batch) throw new Error("expected batch to exist");
  const previewVersion = await shPreviewVersion(client, batchId);
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    batchId,
    { expectedVersion: batch.version, expectedPreviewVersion: previewVersion },
  );
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) return;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const input: ImportCommitInput = {
    expectedVersion: ready.review.batch.version,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: `${batchId}-commit`,
    confirmation: true,
    requestId: `${batchId}-commit-request`,
  };
  let result = await commitRepo.commit("user-a", batchId, input);
  for (
    let attempt = 0;
    attempt < 10 && (!result.ok || result.status !== "committed");
    attempt += 1
  ) {
    assert.equal(result.ok, true);
    result = await commitRepo.commit("user-a", batchId, input);
  }
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "committed");
}

test("BUG-018 (BRK-014 integration): a reversed Sharesight-sourced trade drops out of loadCommittedSharesightRowValues and reads as NEW (not already-imported) on the next sync, and accepting that sync actually commits it as a new posted transaction", async () => {
  const database = await sharesightMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const firstSharesightClient = fakeSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-1" })],
  });
  const linked = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-req" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    { integration: { enabled: true, client: firstSharesightClient } },
  );
  assert.equal(linked.ok, true);

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstSharesightClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.newRows, 1);
  assert.equal(first.alreadyImportedRows, 0);
  await shCommitBatch(client, first.batchId);

  const committed = database
    .prepare(
      "SELECT id FROM transactions WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:sharesight-trade:trade-1'",
    )
    .get() as { id: string };
  assert.ok(committed);

  const reversalRepo = createOwnedImportReversalRepository(client);
  const batchRow = database
    .prepare("SELECT version FROM import_batches WHERE id = ?")
    .get(first.batchId) as { version: number };
  const reversed = await reversalRepo.reverse(
    "user-a",
    first.batchId,
    reversalInput(batchRow.version, "reverse-sharesight"),
  );
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");

  // Direct unit check on the repository BUG-018 changed: the reversed
  // trade's `source_reference` must no longer appear in the committed-value
  // map at all.
  const committedValues = await loadCommittedSharesightRowValues(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(
    committedValues.trades.has("import-fingerprint:sharesight-trade:trade-1"),
    false,
    "a reversed trade must drop out of the committed-values map so it reads as NEW on the next sync",
  );

  // Re-sync. The fetched Sharesight content for trade-1 is byte-identical to
  // before, so `import_batches`' own file-level dedup key (unrelated to
  // BUG-018 -- untouched here, still a FULL unique index on
  // (user_id, file_sha256, parser_format, parser_version)) would reuse the
  // very same batch id if nothing else in the fetch changed; a second,
  // economically distinct trade is included so this resync produces a
  // genuinely NEW, freshly-committable batch, exercising the real
  // accept-and-commit path end to end.
  const secondSharesightClient = fakeSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [
      fakeTrade({ id: "trade-1" }),
      fakeTrade({
        id: "trade-2",
        transactionDate: "2026-08-05",
        quantityDecimal: "1",
        priceDecimal: "20",
        valueDecimal: "20",
      }),
    ],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: secondSharesightClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.notEqual(second.batchId, first.batchId);
  assert.equal(
    second.newRows,
    2,
    "BUG-018: the reversed trade must count as new again, alongside the genuinely new second trade",
  );
  assert.equal(second.alreadyImportedRows, 0);

  await shCommitBatch(client, second.batchId);
  const reimported = database
    .prepare(
      "SELECT id, status, reverses_transaction_id FROM transactions WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:sharesight-trade:trade-1' AND status = 'posted'",
    )
    .get() as {
    id: string;
    status: string;
    reverses_transaction_id: string | null;
  };
  assert.ok(
    reimported,
    "accepting the re-sync must actually commit the reversed trade as a new posted transaction",
  );
  assert.notEqual(reimported.id, committed.id);
  assert.equal(reimported.reverses_transaction_id, null);

  const originalStillReversed = database
    .prepare("SELECT status FROM transactions WHERE id = ?")
    .get(committed.id) as { status: string };
  assert.equal(originalStillReversed.status, "reversed");
});

// ---------------------------------------------------------------------------
// B1 (round 2, reviewer BLOCKING): the shape BUG-018 made legal -- a REVERSED
// original and a re-imported TWIN sharing one `source_reference`, plus the
// reversal's compensating mirror -- must survive an export/restore round
// trip. It did not. Two independent causes:
//
//  (a) `chainOrder` emitted every ROOT before any child (breadth-first), so
//      the replay order was [reversed original, twin, mirror]: the twin was
//      posted while the original was still `posted`, and the partial unique
//      index rightly rejected it;
//  (b) `ledger.getBySourceReference` carried no `status <> 'reversed'`
//      predicate, so `persist()` refused the write with `reason: "conflict"`
//      before it ever reached the database.
// ---------------------------------------------------------------------------

/** Builds the A1 shape (CSV commit -> reverse -> re-import of the identical
 * trade) and returns the three transactions it leaves behind. */
async function reversedPlusReimportFixture(): Promise<{
  database: DatabaseSync;
  client: SqlClient;
  originalId: string;
  mirrorId: string;
  twinId: string;
}> {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, { id: "batch-a", fileSha256: "file-a" });
  stageTradeRow(database, {
    id: "row-1",
    batchId: "batch-a",
    physicalRowNumber: 2,
    fingerprint: "shared-fingerprint",
  });
  await commitBatchToCompletion(client, "user-a", "batch-a", "commit-a");
  const originalId = (
    database
      .prepare(
        `SELECT id FROM transactions
         WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:shared-fingerprint'`,
      )
      .get() as { id: string }
  ).id;
  const reversed = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(batchVersion(database, "batch-a")),
  );
  assert.equal(reversed.ok, true);
  const mirrorId = (
    database
      .prepare("SELECT id FROM transactions WHERE reverses_transaction_id = ?")
      .get(originalId) as { id: string }
  ).id;
  insertBatch(database, { id: "batch-b", fileSha256: "file-b" });
  stageTradeRow(database, {
    id: "row-2",
    batchId: "batch-b",
    physicalRowNumber: 2,
    fingerprint: "shared-fingerprint",
  });
  await commitBatchToCompletion(client, "user-a", "batch-b", "commit-b");
  const twinId = (
    database
      .prepare(
        "SELECT commit_transaction_id AS id FROM import_rows WHERE id = 'row-2'",
      )
      .get() as { id: string }
  ).id;
  assert.notEqual(twinId, originalId);
  return { database, client, originalId, mirrorId, twinId };
}

/** The three refs an exported bundle of that shape carries, identified by
 * ROLE rather than by position -- export order is not part of the contract,
 * `chainOrder` is. */
function bundleRoles(bundle: PortfolioBundleV1): {
  originalRef: string;
  mirrorRef: string;
  twinRef: string;
} {
  assert.equal(bundle.transactions.length, 3);
  const mirror = bundle.transactions.find((tx) => tx.reversesRef !== null);
  assert.ok(mirror, "the exported bundle must carry the reversal mirror");
  const originalRef = mirror.reversesRef;
  assert.ok(originalRef);
  const twin = bundle.transactions.find(
    (tx) => tx.reversesRef === null && tx.ref !== originalRef,
  );
  assert.ok(twin, "the exported bundle must carry the re-imported twin");
  return { originalRef, mirrorRef: mirror.ref, twinRef: twin.ref };
}

test("BUG-018 (round 2) ordering rule: chainOrder emits a reversal IMMEDIATELY after the transaction it targets, before any unrelated root -- fails pre-fix, where the breadth-first sweep emitted [original, twin, mirror] and the twin was replayed while the original was still posted", () => {
  // The twin is given an EARLIER `createdAt` than the mirror so the
  // tie-break cannot accidentally produce the right answer: dependency
  // placement, not time, must decide.
  const original = { ref: "tx-original", createdAt: "2026-08-01T00:00:00Z" };
  const twin = { ref: "tx-twin", createdAt: "2026-08-02T00:00:00Z" };
  const mirror = { ref: "tx-mirror", createdAt: "2026-08-03T00:00:00Z" };
  const ordered = chainOrder([original, twin, mirror], (item) =>
    item.ref === "tx-mirror" ? "tx-original" : null,
  );
  assert.deepEqual(
    ordered.map((item) => item.ref),
    ["tx-original", "tx-mirror", "tx-twin"],
    "the reversal that FREES the shared source_reference must land before the twin that reuses it",
  );
});

test("BUG-018 (round 2): a parent's whole subtree is emitted before the next unrelated root (fails pre-fix), while unrelated roots and sibling children keep their existing deterministic createdAt-then-ref order (unchanged)", () => {
  const items = [
    { ref: "b", createdAt: "2026-08-02T00:00:00Z" },
    { ref: "a", createdAt: "2026-08-01T00:00:00Z" },
    { ref: "c", createdAt: "2026-08-03T00:00:00Z" },
  ];
  assert.deepEqual(
    chainOrder(items, () => null).map((item) => item.ref),
    ["a", "b", "c"],
  );
  // Two children of the SAME parent (same-millisecond, broken by ref) still
  // precede a later, unrelated root.
  const chained = [
    { ref: "root-late", createdAt: "2026-08-09T00:00:00Z" },
    { ref: "child-z", createdAt: "2026-08-02T00:00:00.000Z" },
    { ref: "child-a", createdAt: "2026-08-02T00:00:00.000Z" },
    { ref: "root-early", createdAt: "2026-08-01T00:00:00Z" },
  ];
  assert.deepEqual(
    chainOrder(chained, (item) =>
      item.ref.startsWith("child-") ? "root-early" : null,
    ).map((item) => item.ref),
    ["root-early", "child-a", "child-z", "root-late"],
  );
});

test('BUG-018 (round 2, B1): a portfolio holding a REVERSED original, its mirror, and a re-imported twin sharing one source_reference exports and RESTORES through commitPortfolioBundleImport -- fails pre-fix with 409 "A transaction could not be replayed (conflict)"', async () => {
  const source = await reversedPlusReimportFixture();
  const exported = await exportPortfolioBundle(
    { client: source.client, userId: "user-a", requestId: randomUUID() },
    "portfolio-a",
  );
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;
  assert.equal(bundle.transactions.length, 3);

  // Restore into the OTHER owner's account -- a real cross-account restore:
  // ownership is re-derived, never carried in the file.
  const restored = await commitPortfolioBundleImport(
    { client: source.client, userId: "user-b", requestId: randomUUID() },
    bundle,
    "portfolio.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(
    restored.ok,
    true,
    restored.ok ? "" : `restore failed: ${restored.message}`,
  );
  if (!restored.ok) return;

  const rows = source.database
    .prepare(
      `SELECT status, source_reference, reverses_transaction_id
       FROM transactions WHERE user_id = 'user-b' AND portfolio_id = ?`,
    )
    .all(restored.result.portfolioId) as {
    status: string;
    source_reference: string | null;
    reverses_transaction_id: string | null;
  }[];
  assert.equal(rows.length, 3, "all three transactions must be replayed");
  const reversedRows = rows.filter((row) => row.status === "reversed");
  assert.equal(reversedRows.length, 1);
  assert.equal(
    reversedRows[0]!.source_reference,
    "import-fingerprint:shared-fingerprint",
    "the restored original keeps the reversed fact's own source_reference",
  );
  const mirrors = rows.filter((row) => row.reverses_transaction_id !== null);
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0]!.status, "posted");
  const twins = rows.filter(
    (row) => row.status === "posted" && row.reverses_transaction_id === null,
  );
  assert.equal(twins.length, 1, "the re-imported twin must be restored too");
  assert.equal(
    twins[0]!.source_reference,
    "import-fingerprint:shared-fingerprint",
    "the twin legitimately reuses the freed key -- the partial index permits exactly one non-reversed holder",
  );
});

test("BUG-018 (round 2, B1): the same shape restores through the CHUNKED system-backup twin, including when the part boundary falls between the original and its reversal (the reversal resolves its target from the database, not from in-process state)", async () => {
  const source = await reversedPlusReimportFixture();
  const exported = await exportPortfolioBundle(
    { client: source.client, userId: "user-a", requestId: randomUUID() },
    "portfolio-a",
  );
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;
  const roles = bundleRoles(bundle);

  const ordered = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  assert.deepEqual(
    ordered.map((tx) => tx.ref),
    [roles.originalRef, roles.mirrorRef, roles.twinRef],
    "the browser slicer and the server compute this identical order from the shared module",
  );

  const ctx = {
    client: source.client,
    userId: "user-b",
    requestId: randomUUID(),
  };
  const scaffold = await commitPortfolioBundleScaffold(
    ctx,
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;
  assert.equal(scaffold.result.committedTransactionCount, 0);

  // Boundary AFTER the original only: the reversal that frees the key lands
  // in a LATER request than the transaction it targets, and the twin that
  // reuses the key rides in that same later part.
  const partArgs = {
    portfolioId: scaffold.result.portfolioId,
    batchId: scaffold.result.batchId,
    fingerprint: scaffold.result.fingerprint,
    securities: scaffold.result.securities,
  };
  const first = await commitPortfolioBundleTransactionsPart(ctx, {
    ...partArgs,
    transactions: ordered.slice(0, 1),
  });
  assert.equal(first.ok, true, first.ok ? "" : `part 1: ${first.message}`);

  // Resume evidence between the two parts is the live server-side count,
  // and it must agree with where the boundary actually fell.
  const resumed = await commitPortfolioBundleScaffold(
    ctx,
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.result.committedTransactionCount, 1);

  const second = await commitPortfolioBundleTransactionsPart(ctx, {
    ...partArgs,
    transactions: ordered.slice(1),
  });
  assert.equal(second.ok, true, second.ok ? "" : `part 2: ${second.message}`);
  if (!second.ok) return;
  assert.equal(second.result.committedCount, 2);

  const rows = source.database
    .prepare(
      `SELECT status, source_reference, reverses_transaction_id
       FROM transactions WHERE user_id = 'user-b' AND portfolio_id = ?`,
    )
    .all(scaffold.result.portfolioId) as {
    status: string;
    source_reference: string | null;
    reverses_transaction_id: string | null;
  }[];
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.status === "reversed").length, 1);
  assert.equal(
    rows.filter(
      (row) =>
        row.status === "posted" &&
        row.reverses_transaction_id === null &&
        row.source_reference === "import-fingerprint:shared-fingerprint",
    ).length,
    1,
  );

  // Re-sending the SAME rows is still a no-op -- chunk retries must stay
  // idempotent now that a second row may legally share the key.
  const replay = await commitPortfolioBundleTransactionsPart(ctx, {
    ...partArgs,
    transactions: ordered,
  });
  assert.equal(replay.ok, true, replay.ok ? "" : `replay: ${replay.message}`);
  const afterReplay = source.database
    .prepare(
      "SELECT COUNT(*) AS count FROM transactions WHERE user_id = 'user-b' AND portfolio_id = ?",
    )
    .get(scaffold.result.portfolioId) as { count: number };
  assert.equal(afterReplay.count, 3, "a resent part must never duplicate");
});

// ---------------------------------------------------------------------------
// Reviewer F1 (round 2): the ledger's own manual path must agree with the
// import path and the partial index -- `getBySourceReference` is a pre-check
// FOR that constraint, so it must not be stricter than it.
// ---------------------------------------------------------------------------

test("BUG-018 (round 2, F1): ledger.post -> reverse -> post with the SAME owner-typed sourceReference succeeds (the reversed row no longer occupies the key), while post -> post with the same reference is still rejected as a conflict", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const ledger = createOwnedLedgerRepository(client);
  const postInput = (idempotencyKey: string) => ({
    portfolioId: "portfolio-a",
    type: "buy" as const,
    portfolioSecurityId: "membership-a",
    quantityDecimal: "2",
    unitPriceDecimal: "10",
    grossAmountDecimal: "20",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual" as const,
    sourceReference: "manual-ref-1",
    idempotencyKey,
    tradeAt: "2026-08-01T00:00:00.000Z",
    localTradeDate: "2026-08-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });

  const first = await ledger.post("user-a", postInput("manual-key-1"));
  assert.equal(first.ok, true, first.ok ? "" : `first post: ${first.reason}`);
  if (!first.ok) return;

  // A DIFFERENT posting reusing the same reference while the first is still
  // posted is still a conflict -- the key is genuinely occupied.
  const duplicate = await ledger.post("user-a", postInput("manual-key-2"));
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.equal(duplicate.reason, "conflict");

  const reversal = await ledger.reverse(
    "user-a",
    "portfolio-a",
    first.transaction.id,
    "manual-reverse-key",
    randomUUID(),
  );
  assert.equal(reversal.ok, true);
  assert.equal(
    (
      database
        .prepare("SELECT status FROM transactions WHERE id = ?")
        .get(first.transaction.id) as { status: string }
    ).status,
    "reversed",
  );

  // Now the key is free: the same manual reference may be posted again.
  const rePost = await ledger.post("user-a", postInput("manual-key-3"));
  assert.equal(
    rePost.ok,
    true,
    rePost.ok ? "" : `re-post after reversal was rejected: ${rePost.reason}`,
  );
  if (!rePost.ok) return;
  assert.notEqual(rePost.transaction.id, first.transaction.id);
  assert.equal(rePost.transaction.status, "posted");

  // ...and exactly once: a further duplicate is a conflict again.
  const secondDuplicate = await ledger.post(
    "user-a",
    postInput("manual-key-4"),
  );
  assert.equal(secondDuplicate.ok, false);
  if (secondDuplicate.ok) return;
  assert.equal(secondDuplicate.reason, "conflict");
});
