/**
 * BRK-004 — Sharesight connection schema and token handling.
 *
 * Covers: the env-driven, inert-when-absent `worker/sharesight-config.ts`
 * factory (including the no-override binding guard); the bounded 2xx
 * response-body read timeout in `domain/sharesight/client.ts`; the
 * `sharesight_sync_state` migration/triggers; and the minimal owner-scoped
 * repository over that table, including OPS-003 purge/export coverage.
 *
 * The dynamic-`import()` ESLint gap closed in `eslint.config.mjs`
 * (`no-restricted-syntax`) is lint-config, not runtime behavior -- it was
 * verified with a temporary probe file (a throwaway file under `app/` doing
 * `import("../domain/sharesight/transport.ts")`, confirmed to fail
 * `eslint`, then deleted) rather than a permanent test fixture; see the
 * BRK-004 completion note in TASKS.md for that verification record.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSharesightClient,
  type SharesightFetcher,
} from "../domain/sharesight/index.ts";
import {
  ACCOUNT_PURGE_CONFIRMATION,
  createSharesightSyncStateRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";
import {
  __resetSharesightIntegrationCacheForTests,
  createSharesightIntegrationConfig,
} from "../worker/sharesight-config.ts";
import { completedExport, finishPurge, fixture } from "./fixtures/ops-003.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// worker/sharesight-config.ts: env-driven, inert-when-absent factory.
// ---------------------------------------------------------------------------

test("BRK-004 config factory: absent client id/secret yields a typed disabled state, not a thrown error", () => {
  const config = createSharesightIntegrationConfig({});
  assert.equal(config.enabled, false);
  if (!config.enabled) assert.equal(config.reason, "not_configured");
});

test("BRK-004 config factory: whitespace-only or non-string env values are treated as absent", () => {
  const config = createSharesightIntegrationConfig({
    SHARESIGHT_CLIENT_ID: "   ",
    SHARESIGHT_CLIENT_SECRET: 12345,
  });
  assert.equal(config.enabled, false);
  if (!config.enabled) assert.equal(config.reason, "not_configured");
});

test("BRK-004 config factory: a half-configured pair fails closed as disabled with a distinct reason, never silently enabled", () => {
  const onlyId = createSharesightIntegrationConfig({
    SHARESIGHT_CLIENT_ID: "id-only",
  });
  assert.equal(onlyId.enabled, false);
  if (!onlyId.enabled) assert.equal(onlyId.reason, "incomplete_configuration");

  const onlySecret = createSharesightIntegrationConfig({
    SHARESIGHT_CLIENT_SECRET: "secret-only",
  });
  assert.equal(onlySecret.enabled, false);
  if (!onlySecret.enabled)
    assert.equal(onlySecret.reason, "incomplete_configuration");
});

test("BRK-004 config factory: present client id/secret build an enabled client pinned to Sharesight's real defaults via client_credentials only", async () => {
  const calls: Array<{ url: string; body: string | null }> = [];
  const fetcher: SharesightFetcher = async (url, init) => {
    const href = String(url);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url: href, body });
    if (href.includes("/oauth2/token")) {
      return jsonResponse(200, {
        access_token: "token-x",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    return jsonResponse(200, { portfolios: [] });
  };

  const config = createSharesightIntegrationConfig(
    { SHARESIGHT_CLIENT_ID: "cid", SHARESIGHT_CLIENT_SECRET: "csecret" },
    { fetcher },
  );
  assert.equal(config.enabled, true);
  if (!config.enabled) return;

  const result = await config.client.listPortfolios();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  // Pinned to the real Sharesight token/data hosts -- never a caller
  // override -- and the client_credentials grant only.
  assert.equal(calls[0].url, "https://api.sharesight.com/oauth2/token");
  assert.ok(calls[0].body?.includes("grant_type=client_credentials"));
  assert.ok(calls[0].body?.includes("client_id=cid"));
  assert.ok(calls[0].body?.includes("client_secret=csecret"));
  assert.equal(calls[1].url, "https://api.sharesight.com/api/v3/portfolios");
});

// ---------------------------------------------------------------------------
// BRK-016: module-scope token-provider memoization (real production path
// only -- every case that injects `dependencies` must stay unmemoized).
// ---------------------------------------------------------------------------

test("BRK-016: two consecutive createSharesightIntegrationConfig(env) calls with the same credential pair share one token provider, so two data calls across them cost exactly ONE token exchange", async () => {
  __resetSharesightIntegrationCacheForTests();
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let dataCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/oauth2/token")) {
      tokenCalls += 1;
      return jsonResponse(200, {
        access_token: `brk-016-token-${tokenCalls}`,
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    dataCalls += 1;
    return jsonResponse(200, { portfolios: [] });
  }) as typeof fetch;
  try {
    // No `dependencies` argument on either call -- this is the real
    // production shape (every entry point calls it this way); that is
    // exactly what makes the memo eligible.
    const first = createSharesightIntegrationConfig({
      SHARESIGHT_CLIENT_ID: "brk-016-cid",
      SHARESIGHT_CLIENT_SECRET: "brk-016-secret",
    });
    const second = createSharesightIntegrationConfig({
      SHARESIGHT_CLIENT_ID: "brk-016-cid",
      SHARESIGHT_CLIENT_SECRET: "brk-016-secret",
    });
    assert.equal(first.enabled, true);
    assert.equal(second.enabled, true);
    if (!first.enabled || !second.enabled) return;

    const resultA = await first.client.listPortfolios();
    const resultB = await second.client.listPortfolios();
    assert.equal(resultA.ok, true);
    assert.equal(resultB.ok, true);
    assert.equal(dataCalls, 2, "expected both data calls to actually go out");
    assert.equal(
      tokenCalls,
      1,
      "expected the second config's client to reuse the first's provider (and its cached access token), not re-exchange",
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetSharesightIntegrationCacheForTests();
  }
});

test("BRK-016: a different credential pair builds a brand-new, unshared provider", async () => {
  __resetSharesightIntegrationCacheForTests();
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/oauth2/token")) {
      tokenCalls += 1;
      return jsonResponse(200, {
        access_token: `brk-016-diff-token-${tokenCalls}`,
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    return jsonResponse(200, { portfolios: [] });
  }) as typeof fetch;
  try {
    const first = createSharesightIntegrationConfig({
      SHARESIGHT_CLIENT_ID: "brk-016-cid-a",
      SHARESIGHT_CLIENT_SECRET: "brk-016-secret-a",
    });
    const second = createSharesightIntegrationConfig({
      SHARESIGHT_CLIENT_ID: "brk-016-cid-b",
      SHARESIGHT_CLIENT_SECRET: "brk-016-secret-b",
    });
    assert.equal(first.enabled, true);
    assert.equal(second.enabled, true);
    if (!first.enabled || !second.enabled) return;

    await first.client.listPortfolios();
    await second.client.listPortfolios();
    assert.equal(
      tokenCalls,
      2,
      "a changed credential pair must never reuse the prior pair's provider/token",
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetSharesightIntegrationCacheForTests();
  }
});

test("BRK-016: an injected `dependencies` argument always bypasses the memo, even across two configs built with the identical credential pair", async () => {
  __resetSharesightIntegrationCacheForTests();
  let firstExchanges = 0;
  const firstFetcher: SharesightFetcher = async (url) => {
    if (String(url).includes("/oauth2/token")) firstExchanges += 1;
    return jsonResponse(200, {
      access_token: "brk-016-dep-token-1",
      token_type: "Bearer",
      expires_in: 1800,
    });
  };
  let secondExchanges = 0;
  const secondFetcher: SharesightFetcher = async (url) => {
    if (String(url).includes("/oauth2/token")) secondExchanges += 1;
    return jsonResponse(200, {
      access_token: "brk-016-dep-token-2",
      token_type: "Bearer",
      expires_in: 1800,
    });
  };
  const first = createSharesightIntegrationConfig(
    {
      SHARESIGHT_CLIENT_ID: "brk-016-dep-cid",
      SHARESIGHT_CLIENT_SECRET: "brk-016-dep-secret",
    },
    { fetcher: firstFetcher },
  );
  const second = createSharesightIntegrationConfig(
    {
      SHARESIGHT_CLIENT_ID: "brk-016-dep-cid",
      SHARESIGHT_CLIENT_SECRET: "brk-016-dep-secret",
    },
    { fetcher: secondFetcher },
  );
  assert.equal(first.enabled, true);
  assert.equal(second.enabled, true);
  if (!first.enabled || !second.enabled) return;
  await first.client.listPortfolios();
  await second.client.listPortfolios();
  assert.equal(firstExchanges, 1);
  assert.equal(
    secondExchanges,
    1,
    "each dependencies-injected config must build and use its own unmemoized provider, never share the other's",
  );
});

test("BRK-016 source pin: createSharesightIntegrationConfig only takes the memoized provider path when no dependencies were supplied", async () => {
  const source = await readFile(
    new URL("../worker/sharesight-config.ts", import.meta.url),
    "utf-8",
  );
  assert.match(
    source,
    /dependencies\s*\?\s*createSharesightTokenProvider\(\{[\s\S]{0,300}?\}\)\s*:\s*memoizedTokenProvider\(clientId,\s*clientSecret\)/,
  );
});

test("BRK-004 binding guard: worker/sharesight-config.ts's source never references the host-pinning override flag or a custom token/base URL option", async () => {
  const source = await readFile(
    new URL("../worker/sharesight-config.ts", import.meta.url),
    "utf-8",
  );
  assert.equal(source.includes("unsafeAllowOtherHost"), false);
  assert.equal(source.includes("tokenUrl"), false);
  assert.equal(source.includes("baseUrl"), false);
});

// ---------------------------------------------------------------------------
// domain/sharesight/client.ts: bounded 2xx body-read timeout (BRK-008
// carry-over: the client's success-path `response.text()` read previously
// shared the pre-fix non-2xx path's unbounded/untimed shape).
// ---------------------------------------------------------------------------

/** A 2xx `Response`-shaped object whose body stream's `read()` never
 * resolves -- simulates a stalled/slow-drip successful response body.
 * Mirrors `tests/brk-003.test.ts`'s `stalledBodyNonOkResponse` for the
 * non-2xx case. */
function stalledBody2xxResponse(): Response {
  const reader = {
    read: () => new Promise<never>(() => {}), // never resolves
    cancel: async () => {},
  };
  const body = { getReader: () => reader };
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: new Headers({ "content-type": "application/json" }),
    body,
  } as unknown as Response;
}

test("BRK-004: a stalled 2xx body (read() never resolves) yields a typed, retryable timeout bounded by its own timer, not a hang", async () => {
  const tokenProvider = {
    getAccessToken: async () => ({ ok: true as const, value: "token-x" }),
  };
  const start = Date.now();
  const result = await createSharesightClient({
    tokenProvider,
    fetcher: async () => stalledBody2xxResponse(),
    timeoutMs: 300,
  }).listPortfolios();
  const elapsedMs = Date.now() - start;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "timeout");
    assert.equal(result.error.retryable, true);
  }
  assert.ok(
    elapsedMs < 3_000,
    `expected the body read's own timer to bound this promptly, took ${elapsedMs}ms`,
  );
});

test("BRK-004: a normal 2xx body still parses correctly through the new bounded reader (no regression on the success path)", async () => {
  const tokenProvider = {
    getAccessToken: async () => ({ ok: true as const, value: "token-x" }),
  };
  const result = await createSharesightClient({
    tokenProvider,
    fetcher: async () => jsonResponse(200, { portfolios: [] }),
  }).listPortfolios();
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, []);
});

// ---------------------------------------------------------------------------
// sharesight_sync_state migration + triggers.
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files)
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  return db;
}

/** Minimal owned fixture: user 'a'/'b', one portfolio each -- no dividend
 * seed data, since these tests only exercise `sharesight_sync_state`. */
async function ownedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
  `);
  return db;
}

test("migration creates sharesight_sync_state with its unique/index shape and all three purge-lock triggers", async () => {
  const db = await migratedDatabase();
  const indexNames = db
    .prepare("PRAGMA index_list('sharesight_sync_state')")
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  assert.deepEqual(indexNames, [
    "sharesight_sync_state_id_user_portfolio_unique",
    "sharesight_sync_state_owner_portfolio_idx",
    "sharesight_sync_state_target_unique",
  ]);
  const triggerNames = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='sharesight_sync_state' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggerNames, [
    "account_purge_lock_sharesight_sync_state_delete",
    "account_purge_lock_sharesight_sync_state_insert",
    "account_purge_lock_sharesight_sync_state_update",
  ]);
});

test("sharesight_sync_state rejects a cross-owner composite reference (portfolio belongs to a different owner)", async () => {
  const db = await ownedFixture();
  assert.throws(() => {
    db.exec(
      "INSERT INTO sharesight_sync_state(id,user_id,portfolio_id,sharesight_portfolio_id,enabled,created_at,updated_at,version) VALUES('x','a','pb','101',1,'2026-08-01','2026-08-01',1)",
    );
  }, /FOREIGN KEY constraint failed/);
});

test("sharesight_sync_state's target-unique index rejects a duplicate (user, portfolio, sharesight portfolio) row", async () => {
  const db = await ownedFixture();
  db.exec(
    "INSERT INTO sharesight_sync_state(id,user_id,portfolio_id,sharesight_portfolio_id,enabled,created_at,updated_at,version) VALUES('x','a','pa','101',1,'2026-08-01','2026-08-01',1)",
  );
  assert.throws(() => {
    db.exec(
      "INSERT INTO sharesight_sync_state(id,user_id,portfolio_id,sharesight_portfolio_id,enabled,created_at,updated_at,version) VALUES('y','a','pa','101',1,'2026-08-01','2026-08-01',1)",
    );
  }, /UNIQUE constraint failed/);
});

// ---------------------------------------------------------------------------
// Repository: minimal owner-scoped get/list/upsert.
// ---------------------------------------------------------------------------

test("repository get returns null for an unknown (user, portfolio, sharesight portfolio) tuple", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(createSqliteSqlClient(db));
  assert.equal(await repo.get("a", "pa", "101"), null);
});

test("repository upsert creates a row scoped to the caller's own portfolio; a cross-owner portfolio id is rejected as not_found", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.state.version, 1);
  assert.equal(created.state.enabled, true);
  assert.equal(created.state.sharesightPortfolioId, "101");
  // Cross-owner read: 'b' has no row under 'pa' (owned by 'a').
  assert.equal(await repo.get("b", "pa", "101"), null);

  const crossOwner = await repo.upsert("b", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r2",
  });
  assert.equal(crossOwner.ok, false);
  if (!crossOwner.ok) assert.equal(crossOwner.reason, "not_found");
});

test("repository duplicate create for the same target is rejected as version_conflict, not a silent lost update", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  const duplicate = await repo.upsert("a", "pa", "101", {
    enabled: false,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r2",
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, "version_conflict");
  const after = await repo.get("a", "pa", "101");
  assert.equal(after?.enabled, true);
  assert.equal(after?.version, 1);
});

test("repository version-guarded update persists sync bookkeeping fields and advances version; a stale version is rejected", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: "2026-08-02T00:00:00Z",
    lastTradeWatermark: "cursor-1",
    expectedVersion: created.state.version,
    requestId: "r2",
  });
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(updated.state.version, 2);
    assert.equal(updated.state.lastSyncedAt, "2026-08-02T00:00:00Z");
    assert.equal(updated.state.lastTradeWatermark, "cursor-1");
  }

  const stale = await repo.upsert("a", "pa", "101", {
    enabled: false,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: created.state.version, // stale: already advanced to 2
    requestId: "r3",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "version_conflict");
});

// ---------------------------------------------------------------------------
// Review follow-up: audit target_id must be ROW-identifying. The unique key
// is (user, portfolio, sharesight_portfolio_id), so `sharesightPortfolioId`
// alone is not row-identifying -- two different local portfolios connected
// to the same Sharesight portfolio would otherwise produce indistinguishable
// audit events. Both the create and update paths must record the row's own
// surrogate `id`, mirroring `dividends.ts`'s surrogate-id audit pattern.
// ---------------------------------------------------------------------------

test("audit target_id: create records the row's own surrogate id, not the sharesight portfolio id", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const auditRow = db
    .prepare(
      "SELECT target_id FROM audit_events WHERE action='broker_sync.sharesight.state.create' AND target_owner_user_id='a'",
    )
    .get() as { target_id: string } | undefined;
  assert.ok(auditRow, "expected an audit row for the create");
  assert.equal(auditRow?.target_id, created.state.id);
  assert.notEqual(auditRow?.target_id, "101");
});

test("audit target_id: update also records the row's own surrogate id", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const created = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const updated = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: "2026-08-02T00:00:00Z",
    lastTradeWatermark: "cursor-1",
    expectedVersion: created.state.version,
    requestId: "r2",
  });
  assert.equal(updated.ok, true);
  const auditRow = db
    .prepare(
      "SELECT target_id FROM audit_events WHERE action='broker_sync.sharesight.state.update' AND target_owner_user_id='a'",
    )
    .get() as { target_id: string } | undefined;
  assert.ok(auditRow, "expected an audit row for the update");
  assert.equal(auditRow?.target_id, created.state.id);
  assert.notEqual(auditRow?.target_id, "101");
});

test("audit target_id: two local portfolios connected to the SAME Sharesight portfolio id produce distinct, row-identifying audit target ids", async () => {
  const db = await ownedFixture();
  // 'a' owns both 'pa' and (added here) a second portfolio 'pa2', each
  // independently connected to the identical Sharesight portfolio id
  // "101" -- the exact scenario the reviewer flagged as indistinguishable
  // under the old `sharesightPortfolioId`-as-targetId scheme.
  db.exec(
    "INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pa2','a','A2','A second portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01')",
  );
  const repo = createSharesightSyncStateRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  const first = await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  const second = await repo.upsert("a", "pa2", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r2",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.state.id, second.state.id);
  const auditTargetIds = db
    .prepare(
      "SELECT target_id FROM audit_events WHERE action='broker_sync.sharesight.state.create' AND target_owner_user_id='a' ORDER BY occurred_at, target_id",
    )
    .all()
    .map((row) => (row as { target_id: string }).target_id);
  assert.equal(auditTargetIds.length, 2);
  assert.notEqual(auditTargetIds[0], auditTargetIds[1]);
  assert.deepEqual(
    new Set(auditTargetIds),
    new Set([first.state.id, second.state.id]),
  );
});

test("repository upsert rejects an empty sharesight portfolio id as invalid_input", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(createSqliteSqlClient(db));
  const result = await repo.upsert("a", "pa", "", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_input");
});

test("repository list only returns rows scoped to the caller's own user/portfolio", async () => {
  const db = await ownedFixture();
  const repo = createSharesightSyncStateRepository(
    createSqliteSqlClient(db),
    () => "2026-08-01T00:00:00Z",
  );
  await repo.upsert("a", "pa", "101", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r1",
  });
  await repo.upsert("b", "pb", "202", {
    enabled: true,
    lastSyncedAt: null,
    lastTradeWatermark: null,
    expectedVersion: null,
    requestId: "r2",
  });
  const listA = await repo.list("a", "pa");
  assert.equal(listA.length, 1);
  assert.equal(listA[0].sharesightPortfolioId, "101");
  const listB = await repo.list("b", "pb");
  assert.equal(listB.length, 1);
  assert.equal(listB[0].sharesightPortfolioId, "202");
});

// ---------------------------------------------------------------------------
// OPS-003 export/purge coverage for the new owner table, extending the
// shared ops-003 fixture (DB-005's pattern -- `tests/db-005.test.ts` does the
// identical thing for its six new tables).
// ---------------------------------------------------------------------------

test("purge-lock trigger fires for sharesight_sync_state while a purge job is active; the other owner is unaffected", async () => {
  const db = await fixture();
  const { repo } = await completedExport(db);
  const started = await repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(started.ok, true);
  assert.throws(
    () => db.exec("UPDATE sharesight_sync_state SET enabled=0 WHERE id='ssa'"),
    /account_purge_source_locked/,
  );
  // The other owner ('b') is unaffected by 'a's purge lock.
  db.exec("UPDATE sharesight_sync_state SET enabled=0 WHERE id='ssb'");
  assert.equal(
    db.prepare("SELECT enabled FROM sharesight_sync_state WHERE id='ssb'").get()
      ?.enabled,
    0,
  );
});

test("purge deletes sharesight_sync_state for the purged user only; the other owner's row survives", async () => {
  const db = await fixture();
  await completedExport(db);
  const result = await finishPurge(db);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "purged");
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM sharesight_sync_state WHERE user_id='a'")
      .get()?.n,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM sharesight_sync_state WHERE user_id='b'")
      .get()?.n,
    1,
  );
});

test("account export captures the owner's row from sharesight_sync_state", async () => {
  const db = await fixture();
  const { job } = await completedExport(db);
  const manifestRow = db
    .prepare(
      "SELECT classification, source_row_count, captured_row_count FROM account_export_manifest WHERE export_job_id=? AND table_name=?",
    )
    .get(job.id, "sharesight_sync_state") as
    | {
        classification: string;
        source_row_count: number;
        captured_row_count: number;
      }
    | undefined;
  assert.ok(manifestRow, "manifest row for sharesight_sync_state");
  assert.equal(manifestRow?.classification, "owned");
  assert.equal(manifestRow?.source_row_count, 1);
  assert.equal(manifestRow?.captured_row_count, 1);
  const chunk = db
    .prepare(
      "SELECT payload_json FROM account_export_chunks WHERE export_job_id=? AND table_name=? AND row_count>0",
    )
    .get(job.id, "sharesight_sync_state") as
    { payload_json: string } | undefined;
  assert.ok(chunk, "captured chunk payload for sharesight_sync_state");
  assert.equal(chunk?.payload_json.includes('"user_id":"a"'), true);
});
