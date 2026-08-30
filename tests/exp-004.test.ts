/**
 * EXP-004 -- resumable, chunked full-system backup CORE restore. See
 * TASKS.md's "### EXP-004" entry and `docs/BACKUP_FORMAT.md`'s "Restore
 * (import)" section. Covers: `domain/exports/chain-order.ts` and
 * `domain/exports/chunk-rows.ts` (pure logic, direct unit tests);
 * `app/portfolio-bundle-service.ts`'s new `commitPortfolioBundleScaffold`/
 * `commitPortfolioBundleTransactionsPart`/`commitPortfolioBundleDividendsPart`/
 * `commitPortfolioBundleFinalize` (real migrated in-memory SQLite fixture,
 * mirroring tests/exp-001.test.ts's/tests/exp-002.test.ts's own pattern):
 * scaffold owner-scoping, part idempotency (resend is a no-op), cross-user
 * rejection, and resume evidence (live server-derived counts).
 *
 * The full end-to-end "resume after a prior partial restore" scenario
 * (production incident shape) is covered at the system-backup-service layer
 * by tests/exp-002.test.ts's "a portfolio with a leftover partial-replay
 * remnant..." test -- not duplicated here.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { createOwnedLedgerRepository } from "../db/repositories/ledger.ts";
import { createDividendManualRecordRepository } from "../db/repositories/dividends.ts";
import { chainOrder, type ChainItem } from "../domain/exports/chain-order.ts";
import { chunkRows } from "../domain/exports/chunk-rows.ts";
import {
  commitPortfolioBundleDividendsPart,
  commitPortfolioBundleFinalize,
  commitPortfolioBundleScaffold,
  commitPortfolioBundleTransactionsPart,
  exportPortfolioBundle,
  fingerprintBundle,
  fingerprintBundleWithByteLength,
  type BundleDividendLinkageItem,
  type BundleScaffoldSecurity,
  type BundleServiceContext,
} from "../app/portfolio-bundle-service.ts";
import {
  canonicalBundleJson,
  sha256Hex,
  type PortfolioBundleV1,
} from "../domain/exports/portfolio-bundle.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";

/** The part sizes `app/components/system-backup-panel.tsx` drives the
 * chunked core restore at -- declared once here so the per-request work
 * census below and the panel wiring pin at the end of this file can never
 * disagree about what "a full part" means. */
const TRANSACTIONS_PART_ROWS = 20;
const DIVIDENDS_PART_ROWS = 50;

// ---------------------------------------------------------------------------
// Pure logic: chainOrder / chunkRows.
// ---------------------------------------------------------------------------

type Item = ChainItem & { label: string };

test("chainOrder: empty input returns empty output", () => {
  assert.deepEqual(
    chainOrder<Item>([], () => null),
    [],
  );
});

test("chainOrder: a single item with no dependency is returned as-is", () => {
  const item: Item = {
    ref: "r1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "one",
  };
  assert.deepEqual(
    chainOrder([item], () => null),
    [item],
  );
});

test("chainOrder: a child is always placed strictly after its parent, even when the input array lists the child FIRST", () => {
  const parent: Item = {
    ref: "p",
    createdAt: "2026-01-02T00:00:00.000Z",
    label: "parent",
  };
  const child: Item = {
    ref: "c",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "child",
  };
  // Child's createdAt is EARLIER than the parent's -- a naive createdAt sort
  // would put the child first, which is exactly the bug this function fixes.
  const ordered = chainOrder([child, parent], (item) =>
    item.ref === "c" ? "p" : null,
  );
  assert.deepEqual(
    ordered.map((item) => item.ref),
    ["p", "c"],
  );
});

test("chainOrder: same-millisecond createdAt ties break deterministically by ref, never randomly", () => {
  const sameTime = "2026-01-01T00:00:00.000Z";
  const a: Item = { ref: "b-ref", createdAt: sameTime, label: "a" };
  const b: Item = { ref: "a-ref", createdAt: sameTime, label: "b" };
  const ordered = chainOrder([a, b], () => null);
  assert.deepEqual(
    ordered.map((item) => item.ref),
    ["a-ref", "b-ref"],
  );
});

test("chainOrder: a dangling dependency (ref not present in the array) is treated as a root, never dropped", () => {
  const item: Item = {
    ref: "c",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "orphan",
  };
  const ordered = chainOrder([item], () => "missing-parent");
  assert.deepEqual(ordered, [item]);
});

test("chunkRows: zero rows produces zero chunks", () => {
  assert.deepEqual(chunkRows([], 100), []);
});

test("chunkRows: fewer rows than the chunk size produces exactly one (short) part", () => {
  const rows = [1, 2, 3];
  assert.deepEqual(chunkRows(rows, 100), [[1, 2, 3]]);
});

test("chunkRows: exactly one chunk size worth of rows produces exactly one FULL part, not a trailing empty one", () => {
  const rows = Array.from({ length: 100 }, (_, i) => i);
  const chunks = chunkRows(rows, 100);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.length, 100);
});

test("chunkRows: one row over the chunk size produces two parts, the second holding exactly the remainder", () => {
  const rows = Array.from({ length: 101 }, (_, i) => i);
  const chunks = chunkRows(rows, 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, 100);
  assert.equal(chunks[1]?.length, 1);
  assert.equal(chunks[1]?.[0], 100);
});

// ---------------------------------------------------------------------------
// Behavioural: the granular scaffold/transactions/dividends/finalize
// functions against a real migrated in-memory SQLite fixture.
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

/** Owner "a": one portfolio (pa) with two securities, a 2-link transaction
 * supersession chain, and a 2-link dividend supersession chain plus one
 * manual (wasImported=false) record -- enough to exercise chain ordering,
 * cross-part idempotency, and finalize's linkage pass. */
async function sourceFixture(): Promise<{
  db: DatabaseSync;
  client: SqlClient;
}> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','Portfolio A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01');
    INSERT INTO security_identifiers(id,security_id,scheme,value,valid_from,source) VALUES
      ('si1','s1','ticker','ALPHA','2026-08-01','owner_attested');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const ledger = createOwnedLedgerRepository(client);
  const post1 = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "100",
    unitPriceDecimal: "5",
    grossAmountDecimal: "500",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-01-01T00:00:00.000Z",
    localTradeDate: "2026-01-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(post1.ok, true);
  if (!post1.ok) throw new Error("fixture post1 failed");
  const supersede1 = await ledger.supersede("a", "pa", post1.transaction.id, {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "110",
    unitPriceDecimal: "5",
    grossAmountDecimal: "550",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-01-02T00:00:00.000Z",
    localTradeDate: "2026-01-02",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(supersede1.ok, true);

  const manualRecords = createDividendManualRecordRepository(client);
  const div1 = await manualRecords.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-01",
    sharesDecimal: "100",
    dividendPerShareDecimal: "1.0",
    requestId: randomUUID(),
  });
  assert.equal(div1.ok, true);
  if (!div1.ok) throw new Error("fixture div1 failed");
  const div2 = await manualRecords.supersede("a", "pa", div1.record.id, {
    sharesDecimal: "100",
    dividendPerShareDecimal: "1.2",
    expectedVersion: div1.record.version,
    requestId: randomUUID(),
  });
  assert.equal(div2.ok, true);

  return { db, client };
}

function ctxFor(client: SqlClient, userId: string): BundleServiceContext {
  return { client, userId, requestId: randomUUID() };
}

function seedFreshAccount(db: DatabaseSync, userId: string): void {
  db.exec(`
    INSERT OR IGNORE INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('${userId}','active','${userId}@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('${userId}','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
  `);
}

function dividendLinkageFor(
  bundle: PortfolioBundleV1,
): BundleDividendLinkageItem[] {
  return bundle.dividendManualRecords.map((record) => ({
    ref: record.ref,
    securityRef: record.securityRef,
    supersedesRef: record.supersedesRef,
    supersededByDeletedRecord: record.supersededByDeletedRecord,
  }));
}

async function buildBundle(): Promise<PortfolioBundleV1> {
  const { client } = await sourceFixture();
  const exported = await exportPortfolioBundle(ctxFor(client, "a"), "pa");
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error("export failed");
  return exported.bundle;
}

test("scaffold: creates an owner-scoped destination portfolio, its securities, and reports zero committed rows for a brand-new restore", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const client = createSqliteSqlClient(db);

  const result = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.result.idempotent, false);
  assert.equal(result.result.securities.length, 1);
  assert.equal(result.result.committedTransactionCount, 0);
  assert.equal(result.result.committedDividendCount, 0);

  const owned = await client.get<{ user_id: string }>(
    "SELECT user_id FROM portfolios WHERE id = ?",
    [result.result.portfolioId],
  );
  assert.equal(owned?.user_id, "target");
});

test("transactions part: writes rows in the given order, resending the SAME part is a no-op (idempotent, no duplicates)", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const client = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const ordered = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  assert.equal(ordered.length, 2); // original post + its supersession

  const partInput = {
    portfolioId: scaffold.result.portfolioId,
    batchId: scaffold.result.batchId,
    fingerprint: scaffold.result.fingerprint,
    securities: scaffold.result.securities,
    transactions: ordered,
  };
  const first = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    partInput,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.result.committedCount, 2);

  const countAfterFirst = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'target' AND portfolio_id = ?",
    [scaffold.result.portfolioId],
  );
  assert.equal(countAfterFirst?.n, 2);

  // Resend the IDENTICAL part -- must not duplicate anything.
  const second = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    partInput,
  );
  assert.equal(second.ok, true);
  const countAfterSecond = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'target' AND portfolio_id = ?",
    [scaffold.result.portfolioId],
  );
  assert.equal(countAfterSecond?.n, 2);

  // Resume evidence: a fresh scaffold call now reports both rows committed.
  const rescaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(rescaffold.ok, true);
  if (!rescaffold.ok) return;
  assert.equal(rescaffold.result.committedTransactionCount, 2);
  assert.equal(rescaffold.result.portfolioId, scaffold.result.portfolioId);
});

test("transactions part: split across TWO separate part calls (simulating chunking) commits every row exactly once, in chain order", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const client = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const ordered = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  const [firstChunk, secondChunk] = chunkRows(ordered, 1);
  assert.ok(firstChunk && secondChunk);

  const part1 = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      transactions: firstChunk,
    },
  );
  assert.equal(part1.ok, true);

  const part2 = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      transactions: secondChunk,
    },
  );
  assert.equal(part2.ok, true);

  const total = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'target' AND portfolio_id = ?",
    [scaffold.result.portfolioId],
  );
  assert.equal(total?.n, 2);
});

test("transactions part: a part naming a portfolio owned by ANOTHER user is rejected (never trusting a client-supplied portfolioId)", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  seedFreshAccount(db, "attacker");
  const client = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const ordered = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  // "attacker" tries to write into "target"'s own portfolio id.
  const result = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "attacker"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      transactions: ordered,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
  const total = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transactions WHERE portfolio_id = ?",
    [scaffold.result.portfolioId],
  );
  assert.equal(total?.n, 0);
});

test("transactions part: a security id that does not belong to this owner/portfolio is rejected, never silently accepted", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const client = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const ordered = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  const tamperedSecurities: BundleScaffoldSecurity[] =
    scaffold.result.securities.map((s) => ({
      ref: s.ref,
      portfolioSecurityId: "not-a-real-id",
    }));
  const result = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: tamperedSecurities,
      transactions: ordered,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("dividends part + finalize: a supersession chain is written across parts and correctly linked at finalize, and finalize is idempotent on retry", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const client = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const orderedTransactions = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  const txResult = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      transactions: orderedTransactions,
    },
  );
  assert.equal(txResult.ok, true);

  const orderedDividends = chainOrder(
    bundle.dividendManualRecords,
    (record) => record.supersedesRef,
  );
  assert.equal(orderedDividends.length, 2);
  const divResult = await commitPortfolioBundleDividendsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      records: orderedDividends,
    },
  );
  assert.equal(divResult.ok, true);
  if (!divResult.ok) return;
  assert.equal(divResult.result.committedCount, 2);

  const finalizeInput = {
    portfolioId: scaffold.result.portfolioId,
    batchId: scaffold.result.batchId,
    fingerprint: scaffold.result.fingerprint,
    securities: scaffold.result.securities,
    dividendLinkage: dividendLinkageFor(bundle),
    dividendSecurityAssumptions: bundle.dividendSecurityAssumptions,
    dividendPortfolioAssumption: bundle.dividendPortfolioAssumption,
    dividendFyOverrides: bundle.dividendFyOverrides,
    dividendEventOverrides: bundle.dividendEventOverrides,
    dividendImportFrankingOverrides: bundle.dividendImportFrankingOverrides,
    whatifScenarios: bundle.whatifScenarios,
    portfolioStatus: bundle.portfolio.status,
    transactionsCount: bundle.transactions.length,
    dividendRecordsCount: bundle.dividendManualRecords.length,
  };
  const finalize1 = await commitPortfolioBundleFinalize(
    ctxFor(client, "target"),
    finalizeInput,
  );
  assert.equal(finalize1.ok, true);

  // The supersession chain is linked: exactly one LIVE (non-superseded)
  // dividend record remains for this security.
  const liveDividends = await client.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dividend_manual_records
     WHERE user_id = 'target' AND portfolio_id = ? AND superseded_by_record_id IS NULL`,
    [scaffold.result.portfolioId],
  );
  assert.equal(liveDividends?.n, 1);

  const batchRow = await client.get<{ status: string }>(
    "SELECT status FROM import_batches WHERE id = ?",
    [scaffold.result.batchId],
  );
  assert.equal(batchRow?.status, "committed");

  // Idempotent retry: finalize again -- must be a clean no-op (never
  // duplicating a what-if scenario, which has no natural key of its own).
  const finalize2 = await commitPortfolioBundleFinalize(
    ctxFor(client, "target"),
    finalizeInput,
  );
  assert.equal(finalize2.ok, true);
  const scenarioCount = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM income_whatif_scenarios WHERE user_id = 'target' AND portfolio_id = ?",
    [scaffold.result.portfolioId],
  );
  assert.equal(scenarioCount?.n, 0); // this fixture has none -- proves no phantom row either
});

test("dividends part: a part naming a portfolio owned by ANOTHER user is rejected", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  seedFreshAccount(db, "attacker");
  const client = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const orderedDividends = chainOrder(
    bundle.dividendManualRecords,
    (record) => record.supersedesRef,
  );
  const result = await commitPortfolioBundleDividendsPart(
    ctxFor(client, "attacker"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      records: orderedDividends,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("fingerprintBundle: two scaffold calls for the SAME bundle content resolve to the SAME fingerprint (idempotent-identity precondition)", async () => {
  const bundle = await buildBundle();
  const f1 = await fingerprintBundle(bundle);
  const f2 = await fingerprintBundle(bundle);
  assert.equal(f1, f2);
});

// ---------------------------------------------------------------------------
// EXP-004 correction (escalation, 2026-08-30). See TASKS.md "### EXP-004"
// and docs/BACKUP_FORMAT.md's "Per-request work census".
// ---------------------------------------------------------------------------

test("fingerprint compatibility: the one-pass fingerprint+byteLength helper reproduces the FROZEN fingerprint and the previous byte_size, byte for byte", async () => {
  const bundle = await buildBundle();
  const combined = await fingerprintBundleWithByteLength(bundle);

  // The fingerprint is the frozen `bundle:<fingerprint>:<ref>` idempotency
  // namespace every already-restored row in a live account was keyed with --
  // it must stay exactly `sha256Hex(canonicalBundleJson(bundle))`.
  assert.equal(
    combined.fingerprint,
    await sha256Hex(canonicalBundleJson(bundle)),
  );
  assert.equal(combined.fingerprint, await fingerprintBundle(bundle));

  // `byte_size` keeps its previous meaning: `sortKeysDeep` only REORDERS
  // keys, so the canonical form's UTF-8 length equals the plain
  // `JSON.stringify` length the scaffold used to compute with a second,
  // separate serialisation pass.
  assert.equal(
    combined.byteLength,
    new TextEncoder().encode(JSON.stringify(bundle)).length,
  );
});

/** Counts D1 client calls and individual SQL statements, the unit that maps
 * to a Cloudflare Workers request's CPU budget (each statement is marshalled
 * and its results parsed in-isolate, whether or not it is sent in a batch). */
function countingClient(client: SqlClient): {
  client: SqlClient;
  stats: { calls: number; statements: number };
} {
  const stats = { calls: 0, statements: 0 };
  return {
    stats,
    client: {
      all: (sql, params) => {
        stats.calls += 1;
        stats.statements += 1;
        return client.all(sql, params);
      },
      get: (sql, params) => {
        stats.calls += 1;
        stats.statements += 1;
        return client.get(sql, params);
      },
      run: (sql, params) => {
        stats.calls += 1;
        stats.statements += 1;
        return client.run(sql, params);
      },
      batch: (statements) => {
        stats.calls += 1;
        stats.statements += statements.length;
        return client.batch(statements);
      },
    },
  };
}

/** Owner "big": one portfolio, one security, `count` plain buy transactions
 * -- enough rows to fill a whole `TRANSACTIONS_RESTORE_CHUNK_ROWS` part, so
 * the per-request work census below measures a REAL full-size part rather
 * than extrapolating from a two-row fixture. */
async function largeBundle(count: number): Promise<PortfolioBundleV1> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('big','active','big@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('big','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pbig','big','BIG','Big Portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('sbig','equity','AUD','Alpha Co','2026-08-01','2026-08-01');
    INSERT INTO security_identifiers(id,security_id,scheme,value,valid_from,source) VALUES
      ('sibig','sbig','ticker','ALPHA','2026-08-01','owner_attested');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psbig','big','pbig','sbig','ALPHA','AUD','held','2026-08-01','2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const ledger = createOwnedLedgerRepository(client);
  const manualRecords = createDividendManualRecordRepository(client);
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 27) + 1).padStart(2, "0");
    const posted = await ledger.post("big", {
      portfolioId: "pbig",
      type: "buy",
      portfolioSecurityId: "psbig",
      quantityDecimal: "10",
      unitPriceDecimal: "5",
      grossAmountDecimal: "50",
      feeAmountDecimal: "0",
      taxAmountDecimal: "0",
      fxRateToBaseDecimal: null,
      sourceType: "manual",
      idempotencyKey: randomUUID(),
      tradeAt: `2026-01-${day}T00:00:00.000Z`,
      localTradeDate: `2026-01-${day}`,
      settlementDate: null,
      currencyCode: "AUD",
      fxRateSource: null,
      fxObservedAt: null,
      requestId: randomUUID(),
    });
    assert.equal(posted.ok, true);
    const dividend = await manualRecords.create("big", "pbig", {
      portfolioSecurityId: "psbig",
      paymentDate: `2026-03-${day}`,
      sharesDecimal: "100",
      dividendPerShareDecimal: "1.0",
      requestId: randomUUID(),
    });
    assert.equal(dividend.ok, true);
  }
  const exported = await exportPortfolioBundle(ctxFor(client, "big"), "pbig");
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error("large export failed");
  return exported.bundle;
}

test("per-request work census: a FULL-SIZE transactions/dividends part stays far below the database work of the single request Cloudflare already killed in production", async () => {
  // Production reference (TASKS.md "### EXP-004"): the pre-EXP-004 single
  // core-commit request performed a scaffold pass plus 63 `ledger.post`
  // replays -- ~992 D1 client calls / ~1,534 SQL statements -- before
  // Cloudflare terminated it on the Free plan's 10ms CPU budget with no
  // exception logged. EXP-004's own 100-row transactions part was measured
  // at ~1,302 calls / ~2,102 statements, i.e. MORE work than that
  // known-fatal request, which is why the chunked protocol still could not
  // finish. These ceilings are deliberately generous (they permit ~2x the
  // measured cost) but would fail loudly on a return to that scale.
  const KILLED_IN_PRODUCTION_CALLS = 992;
  const bundle = await largeBundle(
    Math.max(TRANSACTIONS_PART_ROWS, DIVIDENDS_PART_ROWS),
  );
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const raw = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(raw, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const orderedTransactions = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  ).slice(0, TRANSACTIONS_PART_ROWS);
  assert.equal(orderedTransactions.length, TRANSACTIONS_PART_ROWS);
  const txMeter = countingClient(raw);
  const txResult = await commitPortfolioBundleTransactionsPart(
    ctxFor(txMeter.client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      transactions: orderedTransactions,
    },
  );
  assert.equal(txResult.ok, true);
  assert.ok(
    txMeter.stats.calls < KILLED_IN_PRODUCTION_CALLS / 2,
    `a full ${TRANSACTIONS_PART_ROWS}-row transactions part issued ${txMeter.stats.calls} D1 client calls / ${txMeter.stats.statements} statements -- at or above half the work of the request Cloudflare already killed`,
  );
  assert.ok(txMeter.stats.statements < 900, String(txMeter.stats.statements));

  const orderedDividends = chainOrder(
    bundle.dividendManualRecords,
    (record) => record.supersedesRef,
  ).slice(0, DIVIDENDS_PART_ROWS);
  assert.equal(orderedDividends.length, DIVIDENDS_PART_ROWS);
  const divMeter = countingClient(raw);
  const divResult = await commitPortfolioBundleDividendsPart(
    ctxFor(divMeter.client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      records: orderedDividends,
    },
  );
  assert.equal(divResult.ok, true);
  assert.ok(
    divMeter.stats.calls < KILLED_IN_PRODUCTION_CALLS / 2,
    `a full ${DIVIDENDS_PART_ROWS}-row dividends part issued ${divMeter.stats.calls} D1 client calls / ${divMeter.stats.statements} statements`,
  );
});

test("a part whose browser-held fingerprint does not match its own batch is rejected, never written under a second idempotency namespace", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const client = createSqliteSqlClient(db);

  const scaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold.ok, true);
  if (!scaffold.ok) return;

  const ordered = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  const wrongFingerprint = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      // A stale/garbled value held in the browser across an interruption.
      // Trusted verbatim, this would silently start a SECOND copy of the
      // ledger under `bundle:<other>:<ref>` keys instead of resuming.
      fingerprint: "0".repeat(64),
      securities: scaffold.result.securities,
      transactions: ordered,
    },
  );
  assert.equal(wrongFingerprint.ok, false);
  if (wrongFingerprint.ok) return;
  assert.equal(wrongFingerprint.status, 409);

  const written = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'target' AND portfolio_id = ?",
    [scaffold.result.portfolioId],
  );
  assert.equal(written?.n, 0);
});

test("production leftover state: an OLD-code `committing` batch with partially replayed transactions resumes to a complete, non-duplicated restore", async () => {
  // Reproduces the exact shape found in the owner's production D1 on
  // 2026-08-30: one destination portfolio, its securities already resolved,
  // an `import_batches` row still `committing` with the pre-EXP-004 column
  // values (`total_rows` 0, `commit_high_water_row` 1,
  // `commit_idempotency_key` NULL), and part of the ledger already written
  // under this bundle's own `bundle:<fingerprint>:<ref>` keys.
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "own");
  const client = createSqliteSqlClient(db);

  const first = await commitPortfolioBundleScaffold(
    ctxFor(client, "own"),
    bundle,
    "yieldtome-system-backup-2026-08-30.json",
    141409,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const orderedTransactions = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  assert.ok(orderedTransactions.length > 1);
  const partial = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "own"),
    {
      portfolioId: first.result.portfolioId,
      batchId: first.result.batchId,
      fingerprint: first.result.fingerprint,
      securities: first.result.securities,
      transactions: orderedTransactions.slice(0, 1),
    },
  );
  assert.equal(partial.ok, true);
  // Rewrite the batch row into the OLD code's own leftover shape.
  await client.run(
    `UPDATE import_batches
     SET status = 'committing', total_rows = 0, transaction_rows = 0,
         commit_high_water_row = 1, commit_idempotency_key = NULL
     WHERE id = ? AND user_id = 'own'`,
    [first.result.batchId],
  );

  // The owner re-selects the SAME backup file and confirms again: scaffold
  // resumes IN PLACE (same batch, same destination portfolio) and reports
  // live, server-derived resume evidence.
  const resumed = await commitPortfolioBundleScaffold(
    ctxFor(client, "own"),
    bundle,
    "yieldtome-system-backup-2026-08-30.json",
    141409,
  );
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.result.idempotent, false);
  assert.equal(resumed.result.batchId, first.result.batchId);
  assert.equal(resumed.result.portfolioId, first.result.portfolioId);
  assert.equal(resumed.result.fingerprint, first.result.fingerprint);
  assert.equal(resumed.result.committedTransactionCount, 1);
  assert.equal(resumed.result.committedDividendCount, 0);

  // ...and the remaining parts complete the restore.
  const rest = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "own"),
    {
      portfolioId: resumed.result.portfolioId,
      batchId: resumed.result.batchId,
      fingerprint: resumed.result.fingerprint,
      securities: resumed.result.securities,
      transactions: orderedTransactions.slice(
        resumed.result.committedTransactionCount,
      ),
    },
  );
  assert.equal(rest.ok, true);
  const dividends = await commitPortfolioBundleDividendsPart(
    ctxFor(client, "own"),
    {
      portfolioId: resumed.result.portfolioId,
      batchId: resumed.result.batchId,
      fingerprint: resumed.result.fingerprint,
      securities: resumed.result.securities,
      records: chainOrder(
        bundle.dividendManualRecords,
        (record) => record.supersedesRef,
      ),
    },
  );
  assert.equal(dividends.ok, true);
  const finalized = await commitPortfolioBundleFinalize(ctxFor(client, "own"), {
    portfolioId: resumed.result.portfolioId,
    batchId: resumed.result.batchId,
    fingerprint: resumed.result.fingerprint,
    securities: resumed.result.securities,
    dividendLinkage: dividendLinkageFor(bundle),
    dividendSecurityAssumptions: bundle.dividendSecurityAssumptions,
    dividendPortfolioAssumption: bundle.dividendPortfolioAssumption,
    dividendFyOverrides: bundle.dividendFyOverrides,
    dividendEventOverrides: bundle.dividendEventOverrides,
    dividendImportFrankingOverrides: bundle.dividendImportFrankingOverrides,
    whatifScenarios: bundle.whatifScenarios,
    portfolioStatus: bundle.portfolio.status,
    transactionsCount: bundle.transactions.length,
    dividendRecordsCount: bundle.dividendManualRecords.length,
  });
  assert.equal(finalized.ok, true);

  // Exactly the backup's own rows -- the partially replayed prefix was
  // resumed, never duplicated -- in ONE portfolio, under ONE batch.
  const transactionCount = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'own' AND portfolio_id = ?",
    [resumed.result.portfolioId],
  );
  assert.equal(transactionCount?.n, bundle.transactions.length);
  const dividendCount = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM dividend_manual_records WHERE user_id = 'own' AND portfolio_id = ?",
    [resumed.result.portfolioId],
  );
  assert.equal(dividendCount?.n, bundle.dividendManualRecords.length);
  const portfolioCount = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'own'",
  );
  assert.equal(portfolioCount?.n, 1);
  const batches = await client.all<{ id: string; status: string }>(
    "SELECT id, status FROM import_batches WHERE user_id = 'own'",
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.status, "committed");
});

// ---------------------------------------------------------------------------
// Wiring pins: `system-backup-panel.tsx` cannot be imported/executed under
// the plain Node test runner (`.tsx`, and it transitively needs a DOM) --
// mirrors tests/exp-002.test.ts's own identically-justified source-grep
// pins for the pre-existing price-chunk loop. These confirm the panel
// actually drives the four-phase protocol and the chosen part sizes,
// without re-deriving behavioural coverage the tests above already own.
// ---------------------------------------------------------------------------
test("wiring: system-backup-panel.tsx drives all four EXP-004 core-restore phases at the chosen part sizes", async () => {
  const source = await readFile(
    new URL("../app/components/system-backup-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    new RegExp(
      `const TRANSACTIONS_RESTORE_CHUNK_ROWS = ${TRANSACTIONS_PART_ROWS}\\b`,
    ),
  );
  assert.match(
    source,
    new RegExp(
      `const DIVIDENDS_RESTORE_CHUNK_ROWS = ${DIVIDENDS_PART_ROWS}\\b`,
    ),
  );
  assert.match(source, /phase: "scaffold"/);
  assert.match(source, /phase: "transactions"/);
  assert.match(source, /phase: "dividends"/);
  assert.match(source, /phase: "finalize"/);
  assert.match(source, /from "\.\.\/\.\.\/domain\/exports\/chain-order\.ts"/);
  assert.match(source, /from "\.\.\/\.\.\/domain\/exports\/chunk-rows\.ts"/);
  // Resume evidence is server-derived, never a client-trusted claim -- the
  // panel must read the scaffold response's own counts, not invent its own.
  assert.match(source, /committedTransactionCount/);
  assert.match(source, /committedDividendCount/);
});
