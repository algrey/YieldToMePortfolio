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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  bundleKeyPrefixRange,
  type BundleDividendLinkageItem,
  type BundleScaffoldSecurity,
  type BundleServiceContext,
} from "../app/portfolio-bundle-service.ts";
import {
  canonicalBundleJson,
  sha256Hex,
  type BundleDividendManualRecord,
  type BundleTransaction,
  type PortfolioBundleV1,
} from "../domain/exports/portfolio-bundle.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { countUnrelatedPortfolios } from "../db/repositories/system-backup.ts";

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

// ---------------------------------------------------------------------------
// OPS-005 fixtures/helpers: a real "reversed original + re-imported twin"
// shape (BUG-018's own legal post-fix shape) PLUS an unrelated fourth root,
// timed with a deterministic clock so the pre-BUG-018-round-2 breadth-first
// order and the current depth-first order provably disagree about what sits
// at a chunk boundary -- see `oldBreadthFirstChainOrder`'s own comment.
// ---------------------------------------------------------------------------

/** OPS-005 regression fixture. One portfolio, FOUR transactions:
 *   originalA (root, t0, source_reference "shared-ref") --reversed by-->
 *     mirrorA (child of originalA, t2)
 *   rootExtra (unrelated root, t1, no source_reference)
 *   twinA (root, t3, RE-USES originalA's freed "shared-ref")
 *
 * A deterministic clock (never the real one) drives `created_at` so the
 * ordering relationship below is exact, never flaky:
 *   OLD (breadth-first) order: [originalA, rootExtra, twinA, mirrorA]
 *   NEW (depth-first)   order: [originalA, mirrorA, rootExtra, twinA]
 * A part boundary that commits the OLD order's first TWO items
 * (`{originalA, rootExtra}`) therefore sits at NEW-order position 2 too --
 * but position 2 of the NEW order is `rootExtra`, not `mirrorA`. A stale
 * positional resume (`newOrder.slice(committedCount)`) starts at position 2
 * and so skips `mirrorA` (position 1) entirely -- see the regression test
 * using this fixture for the full walk-through and the pre-fix proof.
 */
async function reversedPlusUnrelatedRootFixture(): Promise<{
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
  let clockMs = new Date("2026-01-01T00:00:00.000Z").getTime();
  const nextTimestamp = (): string => {
    const iso = new Date(clockMs).toISOString();
    clockMs += 1000;
    return iso;
  };
  const ledger = createOwnedLedgerRepository(client, nextTimestamp);

  const originalA = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "100",
    unitPriceDecimal: "5",
    grossAmountDecimal: "500",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "csv_import",
    sourceReference: "shared-ref",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-01-01T00:00:00.000Z",
    localTradeDate: "2026-01-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(originalA.ok, true);
  if (!originalA.ok) throw new Error("fixture originalA failed");

  const rootExtra = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "10",
    unitPriceDecimal: "5",
    grossAmountDecimal: "50",
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
  assert.equal(rootExtra.ok, true);

  const mirrorA = await ledger.reverse(
    "a",
    "pa",
    originalA.transaction.id,
    randomUUID(),
    randomUUID(),
  );
  assert.equal(mirrorA.ok, true);

  const twinA = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "100",
    unitPriceDecimal: "5",
    grossAmountDecimal: "500",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "csv_import",
    sourceReference: "shared-ref",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-01-04T00:00:00.000Z",
    localTradeDate: "2026-01-04",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(twinA.ok, true);

  return { client };
}

/** OPS-005 round 2 regression fixture. One portfolio, THREE dividend
 * records, timed with a deterministic clock (never the real one) so the
 * pre-BUG-018-round-2 breadth-first order and the current depth-first order
 * provably disagree, mirroring `reversedPlusUnrelatedRootFixture` above but
 * for the DIVIDEND phase (round 1 fixed only transactions):
 *   divOriginal (root, t0) --superseded by--> divChild (child, t2)
 *   divExtra (unrelated root, t1)
 *
 *   OLD (breadth-first) order: [divOriginal, divExtra, divChild]
 *   NEW (depth-first)   order: [divOriginal, divChild, divExtra]
 * A part boundary that commits the OLD order's first TWO items
 * (`{divOriginal, divExtra}`) sits at NEW-order position 2 -- but position 2
 * of the NEW order is `divExtra` (already written), not `divChild` (still
 * missing). A stale positional resume (`newOrder.slice(committedCount)`)
 * would therefore compute an EMPTY remainder here and never send
 * `divChild` at all.
 */
async function dividendOrderMismatchFixture(): Promise<{ client: SqlClient }> {
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
  let clockMs = new Date("2026-01-01T00:00:00.000Z").getTime();
  const nextTimestamp = (): string => {
    const iso = new Date(clockMs).toISOString();
    clockMs += 1000;
    return iso;
  };
  const manualRecords = createDividendManualRecordRepository(
    client,
    nextTimestamp,
  );

  const divOriginal = await manualRecords.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-01",
    sharesDecimal: "100",
    dividendPerShareDecimal: "1.0",
    requestId: randomUUID(),
  });
  assert.equal(divOriginal.ok, true);
  if (!divOriginal.ok) throw new Error("fixture divOriginal failed");

  const divExtra = await manualRecords.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-04-01",
    sharesDecimal: "50",
    dividendPerShareDecimal: "0.5",
    requestId: randomUUID(),
  });
  assert.equal(divExtra.ok, true);

  const divChild = await manualRecords.supersede(
    "a",
    "pa",
    divOriginal.record.id,
    {
      sharesDecimal: "100",
      dividendPerShareDecimal: "1.2",
      expectedVersion: divOriginal.record.version,
      requestId: randomUUID(),
    },
  );
  assert.equal(divChild.ok, true);

  return { client };
}

/** The pre-BUG-018-round-2 breadth-first `chainOrder`, copied verbatim
 * (only re-typed against this file's own `ChainItem` import) from git
 * history (`d4f9159`, the commit immediately before BUG-018 round 2
 * replaced it with the depth-first version `chain-order.ts` now exports).
 * Used ONLY by the regression test below, to construct a real "part 1
 * committed under the OLD order" scenario without needing a scratch git
 * worktree -- this function is never imported by, and never influences,
 * any production code path. */
function oldBreadthFirstChainOrder<T extends ChainItem>(
  items: readonly T[],
  dependencyOf: (item: T) => string | null,
): T[] {
  const byRef = new Map(items.map((item) => [item.ref, item]));
  const stableCompare = (a: T, b: T): number =>
    a.createdAt === b.createdAt
      ? a.ref.localeCompare(b.ref)
      : a.createdAt.localeCompare(b.createdAt);
  const children = new Map<string, T[]>();
  const queue: T[] = [];
  for (const item of items) {
    const dep = dependencyOf(item);
    if (dep === null || !byRef.has(dep)) {
      queue.push(item);
      continue;
    }
    const siblings = children.get(dep);
    if (siblings) siblings.push(item);
    else children.set(dep, [item]);
  }
  queue.sort(stableCompare);
  const ordered: T[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor]!;
    ordered.push(item);
    const kids = children.get(item.ref);
    if (!kids) continue;
    kids.sort(stableCompare);
    queue.push(...kids);
  }
  return ordered;
}

/** BUG-019 regression harness: wraps `client` so EVERY `run()`/`batch()`
 * call carrying a statement matching `matchSql` throws instead of
 * executing -- standing in for a destination that is permanently
 * unreachable for the ONE request/client instance that is about to attempt
 * it (a crashed Worker invocation never gets to retry in-process; the
 * NEXT request is a fresh call with a fresh, healthy client). Matches both
 * `run()` (the pre-fix separate `UPDATE ... target_portfolio_id` call) and
 * `batch()` (the post-fix atomic call the link statement now travels in),
 * so the SAME wrapper reproduces the failure against either shape:
 * pre-fix it throws on the FIRST (and only) attempt, uncaught, after the
 * portfolio row has already been durably created by a separate, earlier,
 * unintercepted `create()` batch -- exactly the partial state this task
 * exists to make impossible; post-fix, every one of the (up to five)
 * atomic create+link attempts this client makes rolls back in full, so it
 * either exhausts its retries with NOTHING written, or (this wrapper
 * always throws on match, so it always exhausts) returns a graceful
 * `ok:false` -- never a half-created portfolio. */
function withFailureOn(
  client: SqlClient,
  matchSql: (sql: string) => boolean,
): SqlClient {
  return {
    ...client,
    async run(sql, params) {
      if (matchSql(sql)) throw new Error("BUG-019 simulated failure");
      return client.run(sql, params);
    },
    async batch(statements) {
      if (statements.some((statement) => matchSql(statement.sql))) {
        throw new Error("BUG-019 simulated failure");
      }
      return client.batch(statements);
    },
  };
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

/** Drives one BUG-019 failed-request-then-retry cycle: a scaffold call
 * whose destination client always throws on the target-link statement
 * (standing in for a crashed request -- see `withFailureOn`'s own comment),
 * followed by a genuine retry through the SAME `commitPortfolioBundleScaffold`
 * entry point using the real, healthy client. The first call's outcome
 * (pre-fix: an uncaught throw with a real orphan already durably written;
 * post-fix: a graceful `ok:false` with nothing written) is deliberately
 * NOT asserted on here -- only the state the SECOND call leaves behind is,
 * which is what a real owner retrying a failed restore actually observes. */
async function scaffoldOnceFailingThenRetry(
  db: DatabaseSync,
  bundle: PortfolioBundleV1,
  userId: string,
) {
  const realClient = createSqliteSqlClient(db);
  const failingClient = withFailureOn(realClient, (sql) =>
    sql.includes("target_portfolio_id"),
  );
  try {
    await commitPortfolioBundleScaffold(
      ctxFor(failingClient, userId),
      bundle,
      "backup.json",
      JSON.stringify(bundle).length,
    );
  } catch {
    // Pre-fix: the standalone link UPDATE throws uncaught. Expected --
    // the retry below is the actual assertion subject.
  }
  const retried = await commitPortfolioBundleScaffold(
    ctxFor(realClient, userId),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  return { realClient, retried };
}

test("BUG-019: a crash between creating the destination portfolio and linking it to its batch never orphans a portfolio -- a retry creates exactly one", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");

  const { realClient, retried } = await scaffoldOnceFailingThenRetry(
    db,
    bundle,
    "target",
  );
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.equal(retried.result.idempotent, false);
  // The code must be the ORIGINAL requested code -- not a `-restored`
  // fallback, which would only fire if the first (real) code were already
  // taken by an undetected orphan from the failed attempt.
  assert.equal(retried.result.code, bundle.portfolio.code);

  const totalPortfolioCount = await realClient.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'target'",
  );
  assert.equal(totalPortfolioCount?.n, 1);

  const linkedBatch = await realClient.get<{
    target_portfolio_id: string | null;
    status: string;
  }>(
    "SELECT target_portfolio_id, status FROM import_batches WHERE user_id = 'target' LIMIT 1",
  );
  assert.equal(linkedBatch?.target_portfolio_id, retried.result.portfolioId);
});

test("BUG-019: a failed-then-retried scaffold never leaves an orphan that trips the fresh-account precondition for a later system restore", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");

  const { realClient, retried } = await scaffoldOnceFailingThenRetry(
    db,
    bundle,
    "target",
  );
  assert.equal(retried.ok, true);
  if (!retried.ok) return;

  const fingerprint = await fingerprintBundle(bundle);
  const unrelated = await countUnrelatedPortfolios(realClient, "target", [
    fingerprint,
  ]);
  // Zero: the completed restore's ONE portfolio is fully accounted for by
  // its batch's `target_portfolio_id` -- no invisible orphan is left over
  // to fail a later system restore's fresh-account precondition.
  assert.equal(unrelated, 0);
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
    transactionRefs: bundle.transactions.map((tx) => tx.ref),
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

test("resume evidence uses a byte-RANGE, not LIKE: the prefix range is exact, and excludes a sibling fingerprint sharing the `bundle:` prefix", async () => {
  const fingerprint = "a".repeat(64);
  const range = bundleKeyPrefixRange(fingerprint);
  assert.equal(range.start, `bundle:${fingerprint}:`);
  // ';' is ':' + 1 in byte order, so the half-open range covers exactly the
  // keys beginning with the prefix.
  assert.equal(range.endExclusive, `bundle:${fingerprint};`);
  assert.ok(`bundle:${fingerprint}:` >= range.start);
  assert.ok(`bundle:${fingerprint}:zzzz` < range.endExclusive);
  // A DIFFERENT fingerprint sharing only the literal `bundle:` prefix must
  // fall outside the range in both directions.
  const sibling = `bundle:${"b".repeat(64)}:ref`;
  assert.ok(sibling < range.start || sibling >= range.endExclusive);
});

test("resume evidence counts only THIS bundle's rows when another bundle's rows share the `bundle:` prefix in the same portfolio", async () => {
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
  const written = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      transactions: ordered,
    },
  );
  assert.equal(written.ok, true);

  // A row from a DIFFERENT bundle replay, in the SAME owner+portfolio,
  // whose key shares the literal `bundle:` prefix. The old
  // `LIKE 'bundle:<fp>:%'` predicate and the range predicate must both
  // exclude it -- and the range's exclusive upper bound is what does so.
  const sibling = `bundle:${"f".repeat(64)}:other-ref`;
  const ledger = createOwnedLedgerRepository(client);
  const other = await ledger.post("target", {
    portfolioId: scaffold.result.portfolioId,
    type: "buy",
    portfolioSecurityId: scaffold.result.securities[0]!.portfolioSecurityId,
    quantityDecimal: "1",
    unitPriceDecimal: "1",
    grossAmountDecimal: "1",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: sibling,
    tradeAt: "2026-06-01T00:00:00.000Z",
    localTradeDate: "2026-06-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(other.ok, true);

  const rescaffold = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(rescaffold.ok, true);
  if (!rescaffold.ok) return;
  // Exactly this bundle's own rows -- the sibling is not counted, so the
  // browser does not skip a row it never wrote.
  assert.equal(
    rescaffold.result.committedTransactionCount,
    bundle.transactions.length,
  );
});

test("guard: no restore-path SQL uses a LIKE/GLOB pattern that production D1 would reject at 50 bytes", async () => {
  // Production D1 enforces SQLite's DEFAULT
  // `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` of 50 bytes;
  // `node:sqlite` raises it to 50,000, so a behavioural test can NEVER catch
  // this class of defect locally -- it has to be a structural one. A LIKE
  // pattern supplied as a BOUND parameter has no statically knowable length
  // at all, so it is banned outright in these modules; a literal pattern is
  // allowed only while it is provably short.
  const D1_LIKE_PATTERN_LIMIT_BYTES = 50;
  const roots = ["../app", "../db/repositories"];
  const files: string[] = [];
  for (const root of roots) {
    const base = fileURLToPath(new URL(`${root}/`, import.meta.url));
    const entries = await readdir(base, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  }
  assert.ok(
    files.length > 20,
    `expected to scan many modules, saw ${files.length}`,
  );

  const offences: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      // Ignore prose: only look at lines that are actually SQL-ish.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      const bound = /\b(LIKE|GLOB)\s+\?/.exec(line);
      if (bound) {
        offences.push(
          `${file}:${index + 1} uses a BOUND ${bound[1]} pattern (length unknowable; D1 rejects over ${D1_LIKE_PATTERN_LIMIT_BYTES} bytes)`,
        );
        continue;
      }
      const literal = /\b(LIKE|GLOB)\s+'([^']*)'/.exec(line);
      if (
        literal &&
        new TextEncoder().encode(literal[2]!).length >
          D1_LIKE_PATTERN_LIMIT_BYTES
      ) {
        offences.push(
          `${file}:${index + 1} uses a ${literal[1]} pattern over ${D1_LIKE_PATTERN_LIMIT_BYTES} bytes`,
        );
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    `LIKE/GLOB patterns that production D1 can reject:\n${offences.join("\n")}`,
  );
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
  // OPS-005: the ACTUAL resume mechanism -- the ref-probe, not the count --
  // names exactly what remains, already in the server's current chain
  // order (mirroring what `system-backup-panel.tsx` now does).
  assert.deepEqual(
    resumed.result.missingTransactionRefs,
    orderedTransactions.slice(1).map((tx) => tx.ref),
  );

  // ...and the remaining parts complete the restore, driven by the ref
  // list the browser now actually sends (never a count-derived slice).
  const transactionsByRef = new Map(
    bundle.transactions.map((tx) => [tx.ref, tx]),
  );
  const rest = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "own"),
    {
      portfolioId: resumed.result.portfolioId,
      batchId: resumed.result.batchId,
      fingerprint: resumed.result.fingerprint,
      securities: resumed.result.securities,
      transactions: resumed.result.missingTransactionRefs.map((ref) =>
        transactionsByRef.get(ref)!,
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
    transactionRefs: bundle.transactions.map((tx) => tx.ref),
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
// OPS-005: resume by ref-probe, immune to a chain-order change straddling a
// deploy (BUG-018 round 3's documented, previously-open hazard), plus
// finalize's own defence-in-depth transaction-ref verification.
// ---------------------------------------------------------------------------

test("OPS-005 regression (guard): resume via the ref-probe survives a chain-order change between the part that wrote committed rows and the part that resumes -- the pre-fix count/slice strategy would have silently dropped the reversal mirror here", async () => {
  const { client: sourceClient } = await reversedPlusUnrelatedRootFixture();
  const exported = await exportPortfolioBundle(ctxFor(sourceClient, "a"), "pa");
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;
  assert.equal(bundle.transactions.length, 4);

  const original = bundle.transactions.find((tx) => tx.status === "reversed");
  assert.ok(original, "the fixture must leave one reversed original");
  const mirror = bundle.transactions.find((tx) => tx.reversesRef !== null);
  assert.ok(mirror, "the fixture must leave one reversal mirror");
  assert.equal(mirror.reversesRef, original.ref);
  const twin = bundle.transactions.find(
    (tx) =>
      tx.reversesRef === null &&
      tx.status === "posted" &&
      tx.sourceReference === "shared-ref",
  );
  assert.ok(twin, "the fixture must leave one re-imported twin");
  const rootExtra = bundle.transactions.find(
    (tx) => tx.reversesRef === null && tx.sourceReference === null,
  );
  assert.ok(rootExtra, "the fixture must leave one unrelated root");

  const dependencyOf = (tx: BundleTransaction): string | null =>
    tx.reversesRef ?? tx.supersedesRef;
  const oldOrder = oldBreadthFirstChainOrder(bundle.transactions, dependencyOf);
  const newOrder = chainOrder(bundle.transactions, dependencyOf);
  // Sanity-check the fixture's own timing actually produces the disagreement
  // this test exists to exploit -- if either assertion below fails, the
  // fixture's clock/dependency wiring is wrong, not the production code.
  assert.deepEqual(
    oldOrder.map((tx) => tx.ref),
    [original.ref, rootExtra.ref, twin.ref, mirror.ref],
  );
  assert.deepEqual(
    newOrder.map((tx) => tx.ref),
    [original.ref, mirror.ref, rootExtra.ref, twin.ref],
  );

  const targetDb = await migratedDatabase();
  seedFreshAccount(targetDb, "target");
  const targetClient = createSqliteSqlClient(targetDb);

  const scaffold1 = await commitPortfolioBundleScaffold(
    ctxFor(targetClient, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold1.ok, true);
  if (!scaffold1.ok) return;

  // Part 1 committed under the OLD (pre-BUG-018-round-2) order -- exactly
  // what a restore begun before that deploy would have durably written by
  // the time a chunk boundary at position 2 landed.
  const part1 = await commitPortfolioBundleTransactionsPart(
    ctxFor(targetClient, "target"),
    {
      portfolioId: scaffold1.result.portfolioId,
      batchId: scaffold1.result.batchId,
      fingerprint: scaffold1.result.fingerprint,
      securities: scaffold1.result.securities,
      transactions: oldOrder.slice(0, 2),
    },
  );
  assert.equal(part1.ok, true, part1.ok ? "" : part1.message);

  // The deploy now ships the depth-first chainOrder. The owner reloads and
  // confirms again: scaffold must report exactly what remains from the
  // ACTUAL database state -- never from an assumption about which order
  // wrote part 1.
  const resumed = await commitPortfolioBundleScaffold(
    ctxFor(targetClient, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.result.committedTransactionCount, 2);

  // GUARD: proves this was a genuine, reproducible defect -- the OLD design
  // resumed by slicing the CURRENT (new) order at the live count. That
  // positional slice silently drops the mirror here, because position 2 of
  // the new order is `rootExtra` (already written), not the mirror (still
  // missing). This computation touches no service code; it only shows what
  // the retired strategy would have sent.
  const oldStyleSlice = newOrder.slice(
    resumed.result.committedTransactionCount,
  );
  assert.ok(
    !oldStyleSlice.some((tx) => tx.ref === mirror.ref),
    "pre-fix guard: the count/slice resume drops the reversal mirror when the write order and the resume order disagree",
  );

  // THE FIX: the ref-probe names exactly the unwritten rows, independent of
  // either order, in the server's own current chain order.
  assert.deepEqual(resumed.result.missingTransactionRefs, [
    mirror.ref,
    twin.ref,
  ]);

  // The browser (post-fix) sends exactly this list, in this order -- and
  // every row lands, none twice.
  const transactionsByRef = new Map(
    bundle.transactions.map((tx) => [tx.ref, tx]),
  );
  const part2 = await commitPortfolioBundleTransactionsPart(
    ctxFor(targetClient, "target"),
    {
      portfolioId: resumed.result.portfolioId,
      batchId: resumed.result.batchId,
      fingerprint: resumed.result.fingerprint,
      securities: resumed.result.securities,
      transactions: resumed.result.missingTransactionRefs.map((ref) =>
        transactionsByRef.get(ref)!,
      ),
    },
  );
  assert.equal(part2.ok, true, part2.ok ? "" : part2.message);

  const rows = await targetClient.all<{ id: string }>(
    "SELECT id FROM transactions WHERE user_id = 'target' AND portfolio_id = ?",
    [resumed.result.portfolioId],
  );
  assert.equal(
    rows.length,
    4,
    "every row restored exactly once -- none dropped, none duplicated",
  );

  const finalized = await commitPortfolioBundleFinalize(
    ctxFor(targetClient, "target"),
    {
      portfolioId: resumed.result.portfolioId,
      batchId: resumed.result.batchId,
      fingerprint: resumed.result.fingerprint,
      securities: resumed.result.securities,
      dividendLinkage: [],
      dividendSecurityAssumptions: [],
      dividendPortfolioAssumption: null,
      dividendFyOverrides: [],
      dividendEventOverrides: [],
      dividendImportFrankingOverrides: [],
      whatifScenarios: [],
      portfolioStatus: "active",
      transactionsCount: bundle.transactions.length,
      dividendRecordsCount: 0,
      transactionRefs: bundle.transactions.map((tx) => tx.ref),
    },
  );
  assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.message);
});

test("OPS-005: finalize's transaction-ref verification fails closed, and the batch is never marked committed, when a previously-committed transaction is missing at finalize time", async () => {
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
  const divResult = await commitPortfolioBundleDividendsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      records: chainOrder(
        bundle.dividendManualRecords,
        (record) => record.supersedesRef,
      ),
    },
  );
  assert.equal(divResult.ok, true);

  // Simulate a row vanishing between the transactions part and finalize
  // (a deleted row, a bug elsewhere, or a finalize replayed against the
  // wrong batch) -- one committed transaction is removed directly.
  const victim = await client.get<{ id: string }>(
    "SELECT id FROM transactions WHERE user_id = 'target' AND portfolio_id = ? LIMIT 1",
    [scaffold.result.portfolioId],
  );
  assert.ok(victim);
  // A real transaction has FK-restricted dependents (its own cash-ledger
  // entry, at least) -- fine for this fixture's own two-transaction chain,
  // which has neither a reversal/supersession target nor a lot-linked
  // sell, but toggling enforcement off for the one delete keeps this test
  // robust to that shape either way.
  db.exec("PRAGMA foreign_keys = OFF;");
  await client.run("DELETE FROM transactions WHERE id = ?", [victim.id]);
  db.exec("PRAGMA foreign_keys = ON;");

  const finalized = await commitPortfolioBundleFinalize(
    ctxFor(client, "target"),
    {
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
      transactionRefs: bundle.transactions.map((tx) => tx.ref),
    },
  );
  assert.equal(finalized.ok, false);
  if (finalized.ok) return;
  assert.equal(finalized.status, 409);
  assert.match(finalized.message, /1 transaction\(s\) were not found/);

  const batchRow = await client.get<{ status: string }>(
    "SELECT status FROM import_batches WHERE id = ?",
    [scaffold.result.batchId],
  );
  assert.notEqual(
    batchRow?.status,
    "committed",
    "a batch that failed finalize's transaction-ref check must never be marked committed",
  );
  assert.equal(batchRow?.status, "failed");
});

// ---------------------------------------------------------------------------
// OPS-005 round 2: the SAME ref-probe resume mechanism, extended to the
// DIVIDEND phase (round 1 fixed only transactions), plus finalize's new
// persisted-digest hardening (F1) -- a client-supplied ref list that is
// merely SHORT (every ref it sends is real and written) previously passed
// both existence probes trivially.
// ---------------------------------------------------------------------------

test("OPS-005 round 2 regression (guard): resume via the ref-probe survives a chain-order change for the DIVIDEND phase too -- the pre-fix count/slice strategy would have silently dropped the supersession record here", async () => {
  const { client: sourceClient } = await dividendOrderMismatchFixture();
  const exported = await exportPortfolioBundle(ctxFor(sourceClient, "a"), "pa");
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;
  assert.equal(bundle.dividendManualRecords.length, 3);

  const divOriginal = bundle.dividendManualRecords.find(
    (r) => r.supersedesRef === null && r.paymentDate === "2026-03-01",
  );
  assert.ok(divOriginal, "the fixture must leave the original record");
  const divExtra = bundle.dividendManualRecords.find(
    (r) => r.supersedesRef === null && r.paymentDate === "2026-04-01",
  );
  assert.ok(divExtra, "the fixture must leave the unrelated root");
  const divChild = bundle.dividendManualRecords.find(
    (r) => r.supersedesRef !== null,
  );
  assert.ok(divChild, "the fixture must leave the supersession record");
  assert.equal(divChild.supersedesRef, divOriginal.ref);

  const dependencyOf = (record: BundleDividendManualRecord): string | null =>
    record.supersedesRef;
  const oldOrder = oldBreadthFirstChainOrder(
    bundle.dividendManualRecords,
    dependencyOf,
  );
  const newOrder = chainOrder(bundle.dividendManualRecords, dependencyOf);
  // Sanity-check the fixture's own timing actually produces the disagreement
  // this test exists to exploit.
  assert.deepEqual(
    oldOrder.map((r) => r.ref),
    [divOriginal.ref, divExtra.ref, divChild.ref],
  );
  assert.deepEqual(
    newOrder.map((r) => r.ref),
    [divOriginal.ref, divChild.ref, divExtra.ref],
  );

  const targetDb = await migratedDatabase();
  seedFreshAccount(targetDb, "target");
  const targetClient = createSqliteSqlClient(targetDb);

  const scaffold1 = await commitPortfolioBundleScaffold(
    ctxFor(targetClient, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold1.ok, true);
  if (!scaffold1.ok) return;

  // Part 1 committed under the OLD (pre-BUG-018-round-2) order -- exactly
  // what a restore begun before OPS-005 round 1's own deploy would have
  // durably written by the time a chunk boundary at position 2 landed.
  const part1 = await commitPortfolioBundleDividendsPart(
    ctxFor(targetClient, "target"),
    {
      portfolioId: scaffold1.result.portfolioId,
      batchId: scaffold1.result.batchId,
      fingerprint: scaffold1.result.fingerprint,
      securities: scaffold1.result.securities,
      records: oldOrder.slice(0, 2),
    },
  );
  assert.equal(part1.ok, true, part1.ok ? "" : part1.message);

  // The deploy now ships the fix. The owner reloads and confirms again:
  // scaffold must report exactly what remains from the ACTUAL database
  // state -- never from an assumption about which order wrote part 1.
  const resumed = await commitPortfolioBundleScaffold(
    ctxFor(targetClient, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.result.committedDividendCount, 2);

  // GUARD: proves this was a genuine, reproducible defect for the DIVIDEND
  // phase, mirroring the transaction-side guard above -- the retired
  // count/slice strategy resumes by slicing the CURRENT (new) order at the
  // live count, which drops `divChild` here: position 2 of the new order is
  // `divExtra` (already written), not `divChild` (still missing). This
  // computation touches no service code; it only shows what the retired
  // strategy would have sent.
  const oldStyleSlice = newOrder.slice(resumed.result.committedDividendCount);
  assert.ok(
    !oldStyleSlice.some((r) => r.ref === divChild.ref),
    "pre-fix guard: the count/slice resume drops the supersession record when the write order and the resume order disagree",
  );

  // THE FIX: the ref-probe names exactly the unwritten row, independent of
  // either order, in the server's own current chain order.
  assert.deepEqual(resumed.result.missingDividendRefs, [divChild.ref]);

  // The browser (post-fix) sends exactly this list, in this order -- and
  // every row lands, none twice.
  const dividendsByRef = new Map(
    bundle.dividendManualRecords.map((r) => [r.ref, r]),
  );
  const part2 = await commitPortfolioBundleDividendsPart(
    ctxFor(targetClient, "target"),
    {
      portfolioId: resumed.result.portfolioId,
      batchId: resumed.result.batchId,
      fingerprint: resumed.result.fingerprint,
      securities: resumed.result.securities,
      records: resumed.result.missingDividendRefs.map((ref) =>
        dividendsByRef.get(ref)!,
      ),
    },
  );
  assert.equal(part2.ok, true, part2.ok ? "" : part2.message);

  const rows = await targetClient.all<{ id: string }>(
    "SELECT id FROM dividend_manual_records WHERE user_id = 'target' AND portfolio_id = ?",
    [resumed.result.portfolioId],
  );
  assert.equal(
    rows.length,
    3,
    "every dividend record restored exactly once -- none dropped, none duplicated",
  );

  const finalized = await commitPortfolioBundleFinalize(
    ctxFor(targetClient, "target"),
    {
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
      transactionRefs: bundle.transactions.map((tx) => tx.ref),
    },
  );
  assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.message);
});

test("OPS-005 round 2 (F1): finalize fails closed, naming the count mismatch, when the client's transactionRefs list is SHORTER than what scaffold persisted", async () => {
  const bundle = await buildBundle();
  assert.ok(
    bundle.transactions.length > 1,
    "fixture must have more than one transaction to prove a shorter list is caught",
  );
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
  const divResult = await commitPortfolioBundleDividendsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      records: chainOrder(
        bundle.dividendManualRecords,
        (record) => record.supersedesRef,
      ),
    },
  );
  assert.equal(divResult.ok, true);

  // Every row is ACTUALLY, durably written -- only the client's own claimed
  // list is incomplete (e.g. a browser-side bug/corruption dropped a ref).
  // The pre-existing existence probe passes this trivially, since it only
  // ever checks the refs the client DOES send.
  const shortTransactionRefs = bundle.transactions
    .slice(0, -1)
    .map((tx) => tx.ref);
  const finalized = await commitPortfolioBundleFinalize(
    ctxFor(client, "target"),
    {
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
      transactionRefs: shortTransactionRefs,
    },
  );
  assert.equal(finalized.ok, false);
  if (finalized.ok) return;
  assert.equal(finalized.status, 409);
  assert.match(
    finalized.message,
    new RegExp(
      `expected ${bundle.transactions.length} transaction ref\\(s\\) but finalize received ${shortTransactionRefs.length}`,
    ),
  );

  const batchRow = await client.get<{ status: string }>(
    "SELECT status FROM import_batches WHERE id = ?",
    [scaffold.result.batchId],
  );
  assert.equal(
    batchRow?.status,
    "failed",
    "a batch failing the persisted-digest check must never reach committed",
  );
});

test("OPS-005 round 2 (F1): finalize fails closed, naming the count mismatch, when the client's dividendLinkage list is SHORTER than what scaffold persisted", async () => {
  const bundle = await buildBundle();
  assert.ok(
    bundle.dividendManualRecords.length > 1,
    "fixture must have more than one dividend record to prove a shorter list is caught",
  );
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

  const txResult = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      transactions: chainOrder(
        bundle.transactions,
        (tx) => tx.reversesRef ?? tx.supersedesRef,
      ),
    },
  );
  assert.equal(txResult.ok, true);
  const divResult = await commitPortfolioBundleDividendsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      records: chainOrder(
        bundle.dividendManualRecords,
        (record) => record.supersedesRef,
      ),
    },
  );
  assert.equal(divResult.ok, true);

  // Every dividend record is ACTUALLY, durably written -- only the client's
  // own claimed `dividendLinkage` list is incomplete.
  const shortDividendLinkage = dividendLinkageFor(bundle).slice(0, -1);
  const finalized = await commitPortfolioBundleFinalize(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold.result.portfolioId,
      batchId: scaffold.result.batchId,
      fingerprint: scaffold.result.fingerprint,
      securities: scaffold.result.securities,
      dividendLinkage: shortDividendLinkage,
      dividendSecurityAssumptions: bundle.dividendSecurityAssumptions,
      dividendPortfolioAssumption: bundle.dividendPortfolioAssumption,
      dividendFyOverrides: bundle.dividendFyOverrides,
      dividendEventOverrides: bundle.dividendEventOverrides,
      dividendImportFrankingOverrides: bundle.dividendImportFrankingOverrides,
      whatifScenarios: bundle.whatifScenarios,
      portfolioStatus: bundle.portfolio.status,
      transactionsCount: bundle.transactions.length,
      dividendRecordsCount: bundle.dividendManualRecords.length,
      transactionRefs: bundle.transactions.map((tx) => tx.ref),
    },
  );
  assert.equal(finalized.ok, false);
  if (finalized.ok) return;
  assert.equal(finalized.status, 409);
  assert.match(
    finalized.message,
    new RegExp(
      `expected ${bundle.dividendManualRecords.length} dividend record ref\\(s\\) but finalize received ${shortDividendLinkage.length}`,
    ),
  );

  const batchRow = await client.get<{ status: string }>(
    "SELECT status FROM import_batches WHERE id = ?",
    [scaffold.result.batchId],
  );
  assert.equal(
    batchRow?.status,
    "failed",
    "a batch failing the persisted-digest check must never reach committed",
  );
});

test("OPS-005 round 2 (F1): the persisted ref digest+count is written on scaffold and survives a scaffold retry byte-for-byte (idempotent, recomputed fresh each time, never carried forward as mutable state)", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "target");
  const client = createSqliteSqlClient(db);

  const scaffold1 = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold1.ok, true);
  if (!scaffold1.ok) return;
  const batchId = scaffold1.result.batchId;

  const readDigestRow = () =>
    client.get<{
      bundle_transaction_refs_digest: string | null;
      bundle_transaction_refs_count: number | null;
      bundle_dividend_refs_digest: string | null;
      bundle_dividend_refs_count: number | null;
    }>(
      `SELECT bundle_transaction_refs_digest, bundle_transaction_refs_count,
              bundle_dividend_refs_digest, bundle_dividend_refs_count
       FROM import_batches WHERE id = ?`,
      [batchId],
    );

  const row1 = await readDigestRow();
  assert.ok(row1?.bundle_transaction_refs_digest);
  assert.equal(row1?.bundle_transaction_refs_count, bundle.transactions.length);
  assert.ok(row1?.bundle_dividend_refs_digest);
  assert.equal(
    row1?.bundle_dividend_refs_count,
    bundle.dividendManualRecords.length,
  );

  // A partial write in between -- simulating a resume in progress -- must
  // not disturb the persisted digest, since it is derived only from the
  // bundle's OWN content, never from what has been written so far.
  const orderedTransactions = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  const partial = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "target"),
    {
      portfolioId: scaffold1.result.portfolioId,
      batchId: scaffold1.result.batchId,
      fingerprint: scaffold1.result.fingerprint,
      securities: scaffold1.result.securities,
      transactions: orderedTransactions.slice(0, 1),
    },
  );
  assert.equal(partial.ok, true);

  const scaffold2 = await commitPortfolioBundleScaffold(
    ctxFor(client, "target"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffold2.ok, true);
  if (!scaffold2.ok) return;
  assert.equal(scaffold2.result.batchId, scaffold1.result.batchId);

  const row2 = await readDigestRow();
  assert.equal(
    row2?.bundle_transaction_refs_digest,
    row1?.bundle_transaction_refs_digest,
  );
  assert.equal(
    row2?.bundle_transaction_refs_count,
    row1?.bundle_transaction_refs_count,
  );
  assert.equal(
    row2?.bundle_dividend_refs_digest,
    row1?.bundle_dividend_refs_digest,
  );
  assert.equal(
    row2?.bundle_dividend_refs_count,
    row1?.bundle_dividend_refs_count,
  );
});

test("OPS-005 round 2: the transaction/dividend ref probes are owner-scoped -- another owner's identically-keyed rows are never treated as this owner's own committed rows", async () => {
  const bundle = await buildBundle();
  const db = await migratedDatabase();
  seedFreshAccount(db, "owner-a");
  seedFreshAccount(db, "owner-b");
  const client = createSqliteSqlClient(db);

  // Owner A restores the bundle fully.
  const scaffoldA = await commitPortfolioBundleScaffold(
    ctxFor(client, "owner-a"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffoldA.ok, true);
  if (!scaffoldA.ok) return;
  const txA = await commitPortfolioBundleTransactionsPart(
    ctxFor(client, "owner-a"),
    {
      portfolioId: scaffoldA.result.portfolioId,
      batchId: scaffoldA.result.batchId,
      fingerprint: scaffoldA.result.fingerprint,
      securities: scaffoldA.result.securities,
      transactions: chainOrder(
        bundle.transactions,
        (tx) => tx.reversesRef ?? tx.supersedesRef,
      ),
    },
  );
  assert.equal(txA.ok, true);
  const divA = await commitPortfolioBundleDividendsPart(
    ctxFor(client, "owner-a"),
    {
      portfolioId: scaffoldA.result.portfolioId,
      batchId: scaffoldA.result.batchId,
      fingerprint: scaffoldA.result.fingerprint,
      securities: scaffoldA.result.securities,
      records: chainOrder(
        bundle.dividendManualRecords,
        (record) => record.supersedesRef,
      ),
    },
  );
  assert.equal(divA.ok, true);

  // Owner B scaffolds the exact SAME bundle content -- same fingerprint,
  // since it is derived from content alone, never from the owner -- into a
  // SEPARATE destination portfolio. Neither probe may be satisfied by owner
  // A's rows: every ref must still read as missing for owner B.
  const scaffoldB = await commitPortfolioBundleScaffold(
    ctxFor(client, "owner-b"),
    bundle,
    "backup.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(scaffoldB.ok, true);
  if (!scaffoldB.ok) return;
  assert.notEqual(scaffoldB.result.portfolioId, scaffoldA.result.portfolioId);
  assert.equal(scaffoldB.result.fingerprint, scaffoldA.result.fingerprint);
  assert.equal(scaffoldB.result.committedTransactionCount, 0);
  assert.equal(scaffoldB.result.committedDividendCount, 0);
  assert.deepEqual(
    new Set(scaffoldB.result.missingTransactionRefs),
    new Set(bundle.transactions.map((tx) => tx.ref)),
  );
  assert.deepEqual(
    new Set(scaffoldB.result.missingDividendRefs),
    new Set(bundle.dividendManualRecords.map((r) => r.ref)),
  );
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
  assert.match(source, /from "\.\.\/\.\.\/domain\/exports\/chunk-rows\.ts"/);
  // OPS-005 round 2: the panel no longer runs `chainOrder` itself for EITHER
  // phase's resume -- `missingTransactionRefs`/`missingDividendRefs` from
  // the scaffold response ARE the resume mechanism, so the panel no longer
  // imports `chain-order.ts` at all (it still recomputes chain order only
  // inside `commitPortfolioBundleImport`'s non-chunked whole-bundle path,
  // server-side, which this file never touches).
  assert.doesNotMatch(
    source,
    /from "\.\.\/\.\.\/domain\/exports\/chain-order\.ts"/,
  );
  assert.match(source, /missingTransactionRefs/);
  assert.match(source, /missingDividendRefs/);
  // Resume evidence is server-derived, never a client-trusted claim -- the
  // panel must read the scaffold response's own counts, not invent its own.
  assert.match(source, /committedTransactionCount/);
  assert.match(source, /committedDividendCount/);
});
