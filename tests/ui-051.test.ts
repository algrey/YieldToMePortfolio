/** UI-051 — Owner-directed: "when the site first loads and has an existing
 * portfolio it should start on the holdings tab." Before this task, `/`
 * with an active portfolio rendered the Overview tab in place (via
 * `loadAuthenticatedWorkspace(undefined, {includeOverview: true})`); now it
 * redirects straight to `/portfolio/<id>/holdings`, the same "first"
 * portfolio ordering every other caller's implicit default already uses
 * (`resolveAuthenticatedRequestContext`'s own `list(userId)[0]` fallback —
 * `db/repositories/owned-portfolios.ts`'s `list()`, `ORDER BY updated_at
 * DESC, id ASC`).
 *
 * `app/page.tsx` and `app/authenticated-workspace.ts` both pull in
 * `next/headers`, so neither is directly importable under plain `node
 * --test` (see e.g. `tests/prf-002.test.ts`'s own header comment for this
 * repo's established workaround). This file therefore:
 *  (1) drives the real, directly-importable `resolveAuthenticatedRequestContext`
 *      — the SAME function `loadAuthenticatedWorkspace` calls once, and the
 *      exact source of the "first portfolio" id the new `landingRedirectOut`
 *      slot reports — to prove the redirect target and its cost, mirroring
 *      `tests/prf-002.test.ts`'s/`tests/prf-003.test.ts`'s own
 *      "auth-resolution" tests; and
 *  (2) pins the source-level wiring in both files (the same convention
 *      `tests/ui-024.test.ts`'s own wiring-guard test at its bottom uses).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import type { SqlClient, SqlStatement } from "../db/repositories/sql-client.ts";

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

/** Counts D1 client calls/statements only — this test doesn't need
 * `tests/prf-001.test.ts`'s/`tests/prf-002.test.ts`'s full per-stage/
 * EXPLAIN-QUERY-PLAN census machinery, just the total cost of ONE
 * `resolveAuthenticatedRequestContext` resolution to compare against the
 * root overview page's known 19/19 (calls/statements) census figure and to
 * prove two resolutions never happen in the same request. */
function countingClient(client: SqlClient): {
  client: SqlClient;
  stats: { calls: number; statements: number };
} {
  const stats = { calls: 0, statements: 0 };
  return {
    stats,
    client: {
      all: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => {
        stats.calls += 1;
        stats.statements += 1;
        return client.all<T>(sql, params);
      },
      get: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => {
        stats.calls += 1;
        stats.statements += 1;
        return client.get<T>(sql, params);
      },
      run: (sql: string, params?: readonly unknown[]) => {
        stats.calls += 1;
        stats.statements += 1;
        return client.run(sql, params);
      },
      batch: (statements: readonly SqlStatement[]) => {
        stats.calls += 1;
        stats.statements += statements.length;
        return client.batch(statements);
      },
    },
  };
}

const NOW = "2026-08-01T00:00:00.000Z";
const PRINCIPAL = {
  tokenType: "app" as const,
  issuer: "https://issuer.example.test",
  audience: "aud",
  subject: "subject-1",
  email: "owner1@example.test",
  issuedAt: null,
  notBefore: 0,
  expiresAt: 9_999_999_999,
  keyId: "kid-1",
};

async function seedOwnerWithIdentity(db: DatabaseSync): Promise<void> {
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('owner-1','active','owner1@example.test','Australia/Sydney','${NOW}','${NOW}');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES ('owner-1','AUD','Australia/Sydney',7,'${NOW}','${NOW}',1);
    INSERT INTO user_identities(id,user_id,provider,issuer,subject,status,created_at,updated_at) VALUES ('identity-1','owner-1','cloudflare_access','https://issuer.example.test','subject-1','active','${NOW}','${NOW}');
  `);
}

// ---------------------------------------------------------------------------
// (1) The redirect target: same "first portfolio" ordering as every other
// caller's implicit default.
// ---------------------------------------------------------------------------

test("UI-051: with no requestedPortfolioId (page.tsx's real call shape), resolveAuthenticatedRequestContext resolves the MOST RECENTLY UPDATED active portfolio -- the same ordering every other implicit-default caller already relies on", async () => {
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  await seedOwnerWithIdentity(db);
  db.exec(`
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-older','owner-1','P1','Older','AUD','Australia/Sydney','fifo','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-newer','owner-1','P2','Newer','AUD','Australia/Sydney','fifo','active','2026-02-01T00:00:00.000Z','2026-07-01T00:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await resolveAuthenticatedRequestContext(
    client,
    PRINCIPAL,
    undefined,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.context.activePortfolio?.id, "portfolio-newer");
  db.close();
});

test("UI-051: with a single portfolio, resolveAuthenticatedRequestContext resolves it as the redirect target", async () => {
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  await seedOwnerWithIdentity(db);
  db.exec(`
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P1','Portfolio','AUD','Australia/Sydney','fifo','active','${NOW}','${NOW}');
  `);
  const client = createSqliteSqlClient(db);
  const result = await resolveAuthenticatedRequestContext(
    client,
    PRINCIPAL,
    undefined,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.context.activePortfolio?.id, "portfolio-1");
  db.close();
});

test("UI-051: with zero portfolios, resolveAuthenticatedRequestContext resolves ok with a null activePortfolio -- never a redirect target (matches page.tsx's fresh-install fallthrough)", async () => {
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  await seedOwnerWithIdentity(db);
  const client = createSqliteSqlClient(db);
  const result = await resolveAuthenticatedRequestContext(
    client,
    PRINCIPAL,
    undefined,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.context.activePortfolio, null);
  db.close();
});

test("UI-051: an invalid principal never resolves ok -- never a redirect target (matches page.tsx's degraded-state fallthrough, requirement: never redirect on auth failure)", async () => {
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  // Deliberately no seeded users/identities/portfolios at all -- a `null`
  // email fails identity resolution BEFORE any D1 read (see
  // `identity-lifecycle.ts`'s `resolve()`: the email check runs before the
  // `findAccessIdentity` lookup), the cleanest reliable way to reach
  // `ok: false` without touching JIT auto-provisioning's own DB writes.
  const client = createSqliteSqlClient(db);
  const result = await resolveAuthenticatedRequestContext(
    client,
    { ...PRINCIPAL, email: null },
    undefined,
  );
  assert.equal(result.ok, false);
  db.close();
});

// ---------------------------------------------------------------------------
// (2) Cost: the redirect decision is exactly ONE auth+portfolio resolution
// -- never doubled (the identity `touchWithAudit` write is not safe to run
// twice in one request), and far cheaper than the root overview's known
// 19/19 calls/statements (tests/prf-002.test.ts's "/ (root overview)" row).
// ---------------------------------------------------------------------------

test("UI-051: the redirect decision's full cost -- one resolveAuthenticatedRequestContext call -- is far below the root overview page's 19/19 calls/statements census figure", async () => {
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  await seedOwnerWithIdentity(db);
  db.exec(`
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P1','Portfolio','AUD','Australia/Sydney','fifo','active','${NOW}','${NOW}');
  `);
  const { client, stats } = countingClient(createSqliteSqlClient(db));
  const result = await resolveAuthenticatedRequestContext(
    client,
    PRINCIPAL,
    undefined,
  );
  assert.equal(result.ok, true);
  console.log(
    `\nUI-051 redirect-decision census: calls=${stats.calls} statements=${stats.statements} (root overview census: calls=19 statements=19)`,
  );
  assert.ok(
    stats.calls < 19 && stats.statements < 19,
    `expected the redirect decision (${stats.calls} calls / ${stats.statements} statements) to cost strictly less than the root overview's full 19/19 load`,
  );
  db.close();
});

test("UI-051: resolving the SAME principal twice costs exactly double one resolution's D1 work -- pins WHY loadAuthenticatedWorkspace's landingRedirectOut slot must reuse its own single resolution rather than a separate pre-check calling resolveAuthenticatedRequestContext again (that would double-insert the touchWithAudit audit-log row)", async () => {
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  await seedOwnerWithIdentity(db);
  db.exec(`
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P1','Portfolio','AUD','Australia/Sydney','fifo','active','${NOW}','${NOW}');
  `);
  const once = countingClient(createSqliteSqlClient(db));
  await resolveAuthenticatedRequestContext(once.client, PRINCIPAL, undefined);
  const oneResolutionStatements = once.stats.statements;
  assert.ok(oneResolutionStatements > 0);

  const twice = countingClient(createSqliteSqlClient(db));
  await resolveAuthenticatedRequestContext(twice.client, PRINCIPAL, undefined);
  await resolveAuthenticatedRequestContext(twice.client, PRINCIPAL, undefined);
  assert.equal(twice.stats.statements, oneResolutionStatements * 2);
  db.close();
});

// ---------------------------------------------------------------------------
// Wiring guards -- confirm app/page.tsx and app/authenticated-workspace.ts
// actually thread the landingRedirectOut slot into a real redirect, and that
// the early-return sits BEFORE the settings/usdAudRate/portfolio-list reads
// (so the zero-portfolio/failure paths' cost is provably unchanged: the
// early-return check runs, resolves to `null`, and execution falls through
// to the untouched original code below it).
// ---------------------------------------------------------------------------

test("UI-051: app/page.tsx redirects to the first portfolio's Holdings tab via loadAuthenticatedWorkspace's landingRedirectOut slot", async () => {
  const source = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const landingRedirect: \{ current: string \| null \} = \{ current: null \};/,
  );
  assert.match(source, /landingRedirect,\s*\n\s*\);/);
  assert.match(
    source,
    /if \(landingRedirect\.current\) \{\s*\n\s*redirect\(`\/portfolio\/\$\{landingRedirect\.current\}\/holdings`\);\s*\n\s*\}/,
  );
  // UI-002/UI-024 regression guard: the pre-existing `includeOverview: true`
  // load and the `ownedSectionRedirectPath`/`activeSection` wiring below the
  // new redirect check must both still be present, unchanged, for the
  // fresh-install/no-portfolio fallthrough render.
  assert.match(source, /includeOverview: true/);
  assert.match(
    source,
    /ownedSectionRedirectPath\(\s*\n\s*workspace\.activePortfolio\?\.id \?\? null,\s*\n\s*requestedSection,\s*\n\s*\)/,
  );
  assert.match(source, /if \(redirectPath\) redirect\(redirectPath\);/);
  assert.match(source, /activeSection=\{requestedSection\}/);
});

test("UI-051: app/authenticated-workspace.ts's landingRedirectOut early-return sits BEFORE the settings/usdAudRate/portfolio-list Promise.all -- the zero-portfolio/failure paths never pay for it", async () => {
  const source = await readFile(
    new URL("../app/authenticated-workspace.ts", import.meta.url),
    "utf8",
  );
  const resultIndex = source.indexOf(
    "const result = await resolveAuthenticatedRequestContext(",
  );
  const earlyReturnIndex = source.indexOf(
    "if (landingRedirectOut.current !== null) {",
  );
  const promiseAllIndex = source.indexOf(
    "const [portfolioRecords, settings, usdAudRate] = result.ok",
  );
  assert.ok(resultIndex > -1);
  assert.ok(earlyReturnIndex > -1);
  assert.ok(promiseAllIndex > -1);
  assert.ok(
    resultIndex < earlyReturnIndex && earlyReturnIndex < promiseAllIndex,
    "expected: resolveAuthenticatedRequestContext -> landingRedirectOut early-return -> settings/usdAudRate/portfolio-list Promise.all, in that order",
  );
});

test("UI-051 (reviewer follow-up): the landingRedirectOut early-return's throwaway workspace carries a non-empty, honest message -- never a blank string a future forgetful caller could render", async () => {
  const source = await readFile(
    new URL("../app/authenticated-workspace.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /return unavailableWorkspace\("Redirecting to your holdings\."\);/,
  );
  assert.doesNotMatch(source, /return unavailableWorkspace\(""\);/);
});

// ---------------------------------------------------------------------------
// Reviewer B1 (BLOCKING, ruling "keep labels honest"): once `/` redirects to
// Holdings on initial load, the four owned-mode chrome links in
// `portfolio-shell.tsx` that used to point at `/` (topbar brand, the
// portfolio-popover's "All portfolios ->", and the navigation drawer's brand
// + "Overview" links) would otherwise silently land an "Overview"-labelled
// click on Holdings instead -- a labelled control not doing what it says.
// Ruling: with an active portfolio, all four now target
// `/portfolio/:id/overview` directly (an explicit "go to Overview"
// navigation, which the owner's initial-load directive does not cover);
// `/` remains the target only in preview mode / owned-mode-with-no-
// portfolio. Source-pinned (rather than rendered) because three of these
// four Links only mount once the portfolio-popover or navigation-drawer is
// open (component state `tests/ui-024.test.ts`'s static
// `renderToStaticMarkup` harness does not drive), matching this file's own
// wiring-guard convention above.
// ---------------------------------------------------------------------------

test("UI-051 (reviewer B1): all four owned-mode chrome links target the active portfolio's Overview tab, falling back to '/' only with no active portfolio", async () => {
  // PRF-014 step 2b: `PortfolioShell` is owned-only now, so the old
  // `ownedMode && ownedWorkspace.activePortfolio` guard collapsed to a plain
  // `ownedWorkspace.activePortfolio` check (no runtime `ownedMode` flag left
  // -- see that component's own header comment). All four links stayed in
  // portfolio-shell.tsx (none of them moved to preview-shell.tsx).
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const conditionalOverviewHref =
    /href=\{\s*\n\s*ownedWorkspace\.activePortfolio\s*\n\s*\? `\/portfolio\/\$\{ownedWorkspace\.activePortfolio\.id\}\/overview`\s*\n\s*: "\/"\s*\n\s*\}/g;
  const matches = [...source.matchAll(conditionalOverviewHref)];
  assert.equal(
    matches.length,
    4,
    `expected exactly 4 owned-mode Overview-fallback-to-/ hrefs (topbar brand, popover, drawer brand, drawer Overview), found ${matches.length}`,
  );
});
