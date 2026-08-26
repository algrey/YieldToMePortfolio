/** UI-006B -- dividend assumptions editor and manual receipt entry. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import {
  createDividendAssumptionsRepository,
  createDividendEventOverrideRepository,
  createDividendFyOverrideRepository,
  createDividendManualRecordRepository,
} from "../db/repositories/dividends.ts";
import { loadOwnedDividendAssumptions } from "../app/owned-dividend-assumptions.ts";
import {
  computeProximityWarning,
  deleteDividendManualRecordWithContext,
  saveDividendAssumptionsGridWithContext,
  saveDividendEntryWithContext,
  saveDividendFyOverrideWithContext,
  sharesAtDateWithContext,
  type DividendActionContext,
} from "../app/dividend-assumptions-actions.ts";
import {
  isDecimalString,
  isNonNegativeDecimalString,
  isPositiveDecimalString,
  isValidDateString,
  validateFrankingPercent,
  validateGrowthPercent,
  validateOwnerYieldPercent,
  validateValueGrowthPercent,
} from "../app/dividend-form-validation.ts";
import { deriveDividendHistoryForSecurity } from "../domain/dividends/history.ts";
import { computeFyDividendTotals } from "../domain/dividends/aggregations.ts";

// ---------------------------------------------------------------------------
// Boundary validators (app/dividend-form-validation.ts)
// ---------------------------------------------------------------------------

test('UI-006B: validateFrankingPercent pins 0-100 ("100 = fully franked") and rejects out-of-range/malformed values', () => {
  assert.deepEqual(validateFrankingPercent(null), { ok: true, value: null });
  assert.deepEqual(validateFrankingPercent(undefined), {
    ok: true,
    value: null,
  });
  assert.deepEqual(validateFrankingPercent("42.5"), {
    ok: true,
    value: "42.5",
  });
  assert.deepEqual(validateFrankingPercent("100"), { ok: true, value: "100" });
  assert.equal(validateFrankingPercent("101").ok, false);
  assert.equal(validateFrankingPercent("-1").ok, false);
  assert.equal(validateFrankingPercent("abc").ok, false);
  assert.equal(validateFrankingPercent("1e5").ok, false);
  const rejected = validateFrankingPercent("150");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /100/);
});

test("UI-006B: validateOwnerYieldPercent rejects negative yields but allows a wide sanity range", () => {
  assert.equal(validateOwnerYieldPercent("-0.1").ok, false);
  assert.equal(validateOwnerYieldPercent("0").ok, true);
  assert.equal(validateOwnerYieldPercent("450").ok, true);
  assert.equal(validateOwnerYieldPercent("1500").ok, false);
});

test("UI-006B: validateGrowthPercent/validateValueGrowthPercent allow negative growth but bound extremes", () => {
  assert.equal(validateGrowthPercent("-5").ok, true);
  assert.equal(validateGrowthPercent("-150").ok, false);
  assert.equal(validateValueGrowthPercent("-3").ok, true);
  assert.equal(validateValueGrowthPercent("2000").ok, false);
});

test("UI-006B: isValidDateString/isPositiveDecimalString/isNonNegativeDecimalString/isDecimalString reject malformed input", () => {
  assert.equal(isValidDateString("2026-08-13"), true);
  assert.equal(isValidDateString("2026-13-01"), false);
  assert.equal(isValidDateString("13/08/2026"), false);
  assert.equal(isPositiveDecimalString("0"), false);
  assert.equal(isPositiveDecimalString("1.5"), true);
  assert.equal(isNonNegativeDecimalString("0"), true);
  assert.equal(isNonNegativeDecimalString("-0"), false);
  assert.equal(isDecimalString("1e5"), false);
});

// ---------------------------------------------------------------------------
// CSRF-first route wiring (source-text checks -- see tests/fy-001b.test.ts's
// note: the route modules transitively import "next/headers", which only
// vinext's bundler resolves, not Node's strict ESM loader).
// ---------------------------------------------------------------------------

function splitHandlers(source: string): string[] {
  return source
    .split(/(?=export async function (?:GET|POST|PATCH|PUT|DELETE)\()/)
    .filter((part) =>
      /^export async function (GET|POST|PATCH|PUT|DELETE)\(/.test(part),
    );
}

const MUTATION_ROUTES = [
  "../app/api/portfolios/[portfolioId]/dividend-assumptions/route.ts",
  "../app/api/portfolios/[portfolioId]/dividend-entries/route.ts",
  "../app/api/portfolios/[portfolioId]/dividend-fy-overrides/route.ts",
  // BRK-011: added later than this task -- covered here too since this is
  // the established generic CSRF-route registry, not re-duplicated per task.
  "../app/api/portfolios/[portfolioId]/dividend-franking-override/route.ts",
];

test("UI-006B: every mutation handler in the new dividend routes rejects cross-site requests before reading the body", async () => {
  for (const route of MUTATION_ROUTES) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(
      source,
      /import \{ rejectCrossSiteMutation \} from ".*mutation-request\.ts";/,
      `${route} must import rejectCrossSiteMutation`,
    );
    const handlers = splitHandlers(source);
    assert.ok(
      handlers.length > 0,
      `${route} should export at least one handler`,
    );
    for (const handler of handlers) {
      const csrfIndex = handler.indexOf("rejectCrossSiteMutation(request)");
      assert.ok(
        csrfIndex >= 0,
        `${route} handler must call rejectCrossSiteMutation`,
      );
      const bodyReadIndex = handler.indexOf("request.json(");
      const bodyReadPos = bodyReadIndex >= 0 ? bodyReadIndex : Infinity;
      assert.ok(
        csrfIndex < bodyReadPos,
        `${route} handler must reject cross-site mutations before reading the request body`,
      );
    }
  }
});

test("UI-006B: the shares-at-date GET route has no CSRF gate (a read), and the action re-verifies ownership before reading any transaction", async () => {
  const route = await readFile(
    new URL(
      "../app/api/portfolios/[portfolioId]/dividend-shares-at-date/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(route, /rejectCrossSiteMutation/);
  assert.match(route, /sharesAtDateAction\(/);
  const actions = await readFile(
    new URL("../app/dividend-assumptions-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    actions,
    /SELECT id FROM portfolio_securities WHERE id = \? AND user_id = \? AND portfolio_id = \?/,
  );
});

test("UI-006B: the assumptions page loads via the owner-scoped context and is force-dynamic", async () => {
  const page = await readFile(
    new URL(
      "../app/portfolio/[portfolioId]/income/assumptions/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /loadAuthenticatedWorkspace\(portfolioId\)/);
  assert.match(page, /getAuthenticatedSqlContext\(portfolioId\)/);
  assert.match(page, /loadOwnedDividendAssumptions\(/);
  assert.match(page, /workspace\.activePortfolio === null\) notFound\(\)/);
});

test("UI-006B: the QA-001A matrix records the four new dividend routes and the assumptions page", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/api/portfolios/:portfolioId/dividend-assumptions",
    "/api/portfolios/:portfolioId/dividend-entries",
    "/api/portfolios/:portfolioId/dividend-fy-overrides",
    "/api/portfolios/:portfolioId/dividend-shares-at-date",
    "/portfolio/:id/income/assumptions",
    "tests/ui-006b.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

// B2 (UI-006B review fix): every "Denial-test evidence" citation this task
// added to the matrix was fabricated/paraphrased -- never a literal test
// title, so `grep -F` against the actual test file failed for all nine.
// This test self-detects that whole defect class: it parses every
// `` `tests/ui-006a.test.ts` "..."; "..." `` / `` `tests/ui-006b.test.ts`
// "..."; "..." `` citation group out of the matrix and asserts each quoted
// string is a LITERAL substring of the named test file's source -- exactly
// the `grep -F` check the reviewer ran by hand, now permanent and run on
// every `npm run check`.
test("UI-006B: every matrix citation naming tests/ui-006a.test.ts or tests/ui-006b.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ui006a, ui006b] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/ui-006a.test.ts", import.meta.url), "utf8"),
    readFile(new URL("../tests/ui-006b.test.ts", import.meta.url), "utf8"),
  ]);
  const sourceByFile: Record<string, string> = {
    "tests/ui-006a.test.ts": ui006a,
    "tests/ui-006b.test.ts": ui006b,
  };
  const citationGroupPattern =
    /`(tests\/ui-006[ab]\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const file = match[1]!;
    const source = sourceByFile[file]!;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        source.includes(title),
        `matrix cites "${title}" in ${file}, but that title is not a literal substring of ${file}'s source (fabricated/paraphrased citation)`,
      );
    }
  }
  // Guards the guard: if the matrix's citation FORMAT ever drifts (e.g. no
  // longer backtick-quoting the filename before the titles), this check
  // would silently match zero groups and stop verifying anything -- fail
  // loudly instead of passing vacuously.
  assert.ok(groupCount >= 5, "expected at least 5 citation groups to check");
  assert.ok(titleCount >= 10, "expected at least 10 quoted titles to check");
});

// ---------------------------------------------------------------------------
// Fixture + WithContext action-level behaviour.
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

async function fixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1),
      ('b','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de1','s1','p','cash','paid','2026-03-01','AUD','1','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z','2026-03-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa1','buy','posted','2026-01-01T00:00:00Z','2026-01-01','100','5','AUD','500','0','0','manual','a',1,'2026-01-01'),
      ('tx2','a','pa','psa1','sell','posted','2026-02-01T00:00:00Z','2026-02-01','40','6','AUD','240','0','0','manual','a',1,'2026-02-01');
  `);
  return db;
}

function contextFor(
  client: ReturnType<typeof createSqliteSqlClient>,
  userId: string,
): DividendActionContext {
  return { client, userId, requestId: "req-1" };
}

test("UI-006B: grid save creates security + portfolio rows, and a blank cell restores the provider fallback on the next save", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const created = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "4.2",
        frankingPercentDecimal: "100",
        dividendGrowthPercentDecimal: "2",
        expectedVersion: null,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: "3",
      portfolioDividendGrowthPercentDecimal: "2",
      expectedVersion: null,
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.securities[0]!.version, 1);
  assert.equal(created.portfolio.version, 1);

  const loaded1 = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(loaded1.securities[0]!.ownerFrankingPercentDecimal, "100");

  const cleared = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "4.2",
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: "2",
        expectedVersion: created.securities[0]!.version,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: "3",
      portfolioDividendGrowthPercentDecimal: "2",
      expectedVersion: created.portfolio.version,
    },
  });
  assert.equal(cleared.ok, true);

  const loaded2 = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(
    loaded2.securities[0]!.ownerFrankingPercentDecimal,
    null,
    "a blank cell must restore the provider fallback, not persist an empty string",
  );
});

test("UI-006B: a stale grid version is rejected (409) and reports exactly which rows already applied", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const created = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "4",
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        expectedVersion: null,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: null,
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const stale = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "5",
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        expectedVersion: 999,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: null,
    },
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.status, 409);
  assert.equal(stale.appliedSecurities.length, 0);

  const loaded = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(
    loaded.securities[0]!.ownerYieldPercentDecimal,
    "4",
    "the stale row's rejected value must never overwrite the persisted one",
  );
});

test("UI-006B: a mid-sequence grid failure (row 2 of 3 stale) commits row 1, leaves rows 2-3 and the portfolio row unsaved", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  db.exec(`
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s2','equity','AUD','Beta Co','2026-08-01','2026-08-01'),
      ('s3','equity','AUD','Gamma Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa2','a','pa','s2','BETA','AUD','held','2026-08-01','2026-08-01'),
      ('psa3','a','pa','s3','GAMMA','AUD','held','2026-08-01','2026-08-01');
  `);
  const ctx = contextFor(client, "a");
  const assumptionsSeed = createDividendAssumptionsRepository(client);
  // psa2 already has a saved (version 1) row so the grid call below hits a
  // genuine STALE version (version_conflict/409), not "never saved before"
  // (not_found/404) -- the reviewer's literal "stale row 2 of 3" scenario.
  const seeded = await assumptionsSeed.saveSecurityAssumptions(
    "a",
    "pa",
    "psa2",
    {
      dividendYieldPercentDecimal: "1",
      frankingPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
      expectedVersion: null,
      requestId: "seed",
    },
  );
  assert.equal(seeded.ok, true);

  const result = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "4",
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        expectedVersion: null,
      },
      {
        // Stale version (seeded row is really version 1) -> version_conflict
        // at row 2 of 3.
        portfolioSecurityId: "psa2",
        dividendYieldPercentDecimal: "5",
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        expectedVersion: 999,
      },
      {
        portfolioSecurityId: "psa3",
        dividendYieldPercentDecimal: "6",
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        expectedVersion: null,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: "3",
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: null,
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.equal(result.appliedSecurities.length, 1);
  assert.equal(result.appliedSecurities[0]!.portfolioSecurityId, "psa1");
  assert.equal(result.failedPortfolioSecurityId, "psa2");

  const assumptions = createDividendAssumptionsRepository(client);
  const psa1Row = await assumptions.getSecurityAssumptions("a", "pa", "psa1");
  assert.equal(psa1Row?.dividendYieldPercentDecimal, "4", "row 1 committed");
  const psa3Row = await assumptions.getSecurityAssumptions("a", "pa", "psa3");
  assert.equal(psa3Row, null, "row 3 must never have been attempted");
  const psa2Row = await assumptions.getSecurityAssumptions("a", "pa", "psa2");
  assert.equal(
    psa2Row?.dividendYieldPercentDecimal,
    "1",
    "row 2's rejected value must never overwrite the seeded one",
  );
  const portfolioRow = await assumptions.getPortfolioAssumptions("a", "pa");
  assert.equal(
    portfolioRow,
    null,
    "the portfolio row must not have been saved",
  );
});

test("UI-006B: grid save denies a cross-user security id (repository-level ownership re-check, not_found)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "b"); // user b, but psa1/pa belong to user a

  const result = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "4",
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        expectedVersion: null,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: null,
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("UI-006B: grid save rejects an out-of-range franking percent before touching the database", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const result = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: null,
        frankingPercentDecimal: "150",
        dividendGrowthPercentDecimal: null,
        expectedVersion: null,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: null,
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.match(result.message, /100/);
  const remaining = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
  );
  assert.equal(remaining.length, 0);
});

test("UI-006B: a manual dividend record (no linked event) persists to dividend_manual_records and appears in DIV-001 derived history as the manual tier", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const result = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: "0.2",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.target, "manual_record");

  const manualRecords = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
  );
  assert.equal(manualRecords.length, 1);
  assert.equal(
    manualRecords[0]!.importBatchId,
    null,
    "an owner-typed record via this form must be the MANUAL tier (import_batch_id NULL)",
  );

  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "psa1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: manualRecords.map((record) => ({
      id: record.id,
      paymentDate: record.paymentDate,
      sharesDecimal: record.sharesDecimal,
      dividendPerShareDecimal: record.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
      importBatchId: record.importBatchId,
    })),
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "manual");
});

// ---------------------------------------------------------------------------
// UI-009: idempotency guard on the standalone manual dividend CREATE.
// ---------------------------------------------------------------------------

test("UI-009: retrying a manual dividend create with the SAME idempotency key (a timed-out-but-committed save followed by a client retry) dedupes to exactly ONE record", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const input = {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: "0.2",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
    idempotencyKey: "dialog-session-1",
  };

  const first = await saveDividendEntryWithContext(ctx, "pa", input);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // Simulates the client seeing a timeout (or any client-visible failure)
  // for a save that actually committed server-side, then retrying with the
  // SAME dialog-session key -- the exact scenario UI-009 exists for.
  const retry = await saveDividendEntryWithContext(ctx, "pa", input);
  assert.equal(retry.ok, true);
  if (!retry.ok) return;

  // The retry must report the SAME record identity/version as the original
  // success, not a fresh one.
  assert.equal(retry.id, first.id);
  assert.equal(retry.version, first.version);

  const records = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
  );
  assert.equal(
    records.length,
    1,
    "a retry with the same idempotency key must never create a second row",
  );
});

test("UI-009: two DISTINCT dialog sessions (different idempotency keys) for the same security/date create two distinct records", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const base = {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: "0.2",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  };

  const sessionOne = await saveDividendEntryWithContext(ctx, "pa", {
    ...base,
    idempotencyKey: "dialog-session-1",
  });
  assert.equal(sessionOne.ok, true);

  const sessionTwo = await saveDividendEntryWithContext(ctx, "pa", {
    ...base,
    idempotencyKey: "dialog-session-2",
  });
  assert.equal(sessionTwo.ok, true);
  if (!sessionOne.ok || !sessionTwo.ok) return;

  assert.notEqual(
    sessionOne.id,
    sessionTwo.id,
    "a fresh dialog session (a new idempotency key) is a genuinely new record, not a dedupe",
  );

  const records = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
  );
  assert.equal(records.length, 2);
});

test("UI-009: a manual dividend create with NO idempotency key behaves exactly as before (no dedupe applied)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const input = {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: "0.2",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  };

  const first = await saveDividendEntryWithContext(ctx, "pa", input);
  assert.equal(first.ok, true);
  const second = await saveDividendEntryWithContext(ctx, "pa", input);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(
    first.id,
    second.id,
    "with no idempotency key, two submits are two genuinely separate records (pre-UI-009 behaviour preserved)",
  );

  const records = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
  );
  assert.equal(records.length, 2);
});

test("UI-009: an idempotency-key retry for a DIFFERENT security never returns another security's record (repository-level scoping)", async () => {
  const db = await fixture();
  db.exec(`
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s2','equity','AUD','Beta Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa2','a','pa','s2','BETA','AUD','held','2026-08-01','2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);

  const first = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey: "shared-key",
    requestId: "req-1",
  });
  assert.equal(first.ok, true);

  const second = await repository.create("a", "pa", {
    portfolioSecurityId: "psa2",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey: "shared-key",
    requestId: "req-1",
  });
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(
    first.record.id,
    second.record.id,
    "the same idempotency key for a DIFFERENT security is not a dedupe match -- the unique index is scoped per portfolio_security_id",
  );
});

// ---------------------------------------------------------------------------
// UI-009 finishing item 1: edited-payload retry honesty. A retry with the
// SAME idempotency key but DIFFERENT material fields (the owner edited the
// form between the original save and a retry) must never silently report
// the just-submitted values as saved -- it must disclose that the STORED
// values are what actually persisted.
// ---------------------------------------------------------------------------

test("UI-009 finishing item 1: a retry with the SAME idempotency key but DIFFERENT material fields dedupes to one record, reports storedDiffers, and returns the STORED (not the retried) values", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const idempotencyKey = "dialog-session-edited";

  const original = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-1",
  });
  assert.equal(original.ok, true);
  if (!original.ok) return;
  assert.equal(original.deduped, false);
  assert.equal(original.storedDiffers, false);

  // Reviewer's exact repro: the owner edited the form after the (actually
  // successful) first save appeared to hang, then a retry fired with NEW
  // values but the SAME dialog-session idempotency key.
  const retryWithEditedPayload = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-09-30",
    sharesDecimal: "100",
    dividendPerShareDecimal: "9.99",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-2",
  });
  assert.equal(retryWithEditedPayload.ok, true);
  if (!retryWithEditedPayload.ok) return;
  assert.equal(
    retryWithEditedPayload.deduped,
    true,
    "still a dedupe match on the idempotency key -- never a second row",
  );
  assert.equal(
    retryWithEditedPayload.storedDiffers,
    true,
    "the retried payload's material fields differ from what is stored",
  );
  // The returned record must be the STORED truth (0.5 / 2026-05-15), never
  // the just-submitted 9.99 / 2026-09-30 masquerading as saved.
  assert.equal(retryWithEditedPayload.record.id, original.record.id);
  assert.equal(retryWithEditedPayload.record.paymentDate, "2026-05-15");
  assert.equal(retryWithEditedPayload.record.dividendPerShareDecimal, "0.5");

  const records = await repository.list("a", "pa");
  assert.equal(
    records.length,
    1,
    "an edited-payload retry must still dedupe to exactly ONE record",
  );
  assert.equal(records[0]!.dividendPerShareDecimal, "0.5");
});

test("UI-009 finishing item 1: a retry with the SAME idempotency key and the SAME material fields (differently-scaled decimal strings) reports storedDiffers false", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const idempotencyKey = "dialog-session-same-value-different-scale";

  const original = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.50",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-1",
  });
  assert.equal(original.ok, true);

  // "0.5" and "0.50" are the SAME value at a different textual scale -- a
  // raw string comparison would wrongly flag this as an edited payload.
  const retry = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-2",
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.deduped, true);
  assert.equal(retry.storedDiffers, false);
});

// ---------------------------------------------------------------------------
// UI-009 finishing item 2: the blinded pre-check race (catch-branch
// re-check) and cross-user key isolation.
// ---------------------------------------------------------------------------

test("UI-009 finishing item 2: a race where a concurrent request commits between the pre-check and this request's own INSERT is caught by the catch-branch re-check, never a duplicate row", async () => {
  const db = await fixture();
  const realClient = createSqliteSqlClient(db);
  const idempotencyKey = "race-key";
  const competingId = "competing-record-id";
  let triggered = false;

  // Wraps the real client so the FIRST idempotency-key lookup (the
  // pre-check inside create()) behaves exactly as a genuine race would:
  // it legitimately sees nothing (the result below is computed BEFORE the
  // competing insert), but by the time this request's own INSERT runs, a
  // competing row -- from a request that supposedly ran concurrently and
  // committed first -- already exists with the same
  // (portfolio_security_id, idempotency_key). This forces create()'s
  // catch-branch (the one at the "concurrent retry" comment), not the
  // pre-check branch.
  const racingClient = {
    ...realClient,
    async get<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      const result = await realClient.get<T>(sql, params);
      if (!triggered && sql.includes("idempotency_key = ?")) {
        triggered = true;
        db.exec(`
          INSERT INTO dividend_manual_records (
            id, user_id, portfolio_id, portfolio_security_id, payment_date,
            shares_decimal, dividend_per_share_decimal,
            franking_credit_per_share_decimal, idempotency_key, created_at,
            updated_at, version
          ) VALUES (
            '${competingId}', 'a', 'pa', 'psa1', '2026-05-15',
            '100', '0.5', NULL, '${idempotencyKey}', '2026-05-15T00:00:00Z',
            '2026-05-15T00:00:00Z', 1
          )
        `);
      }
      return result;
    },
  };

  const repository = createDividendManualRecordRepository(racingClient);
  const result = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-1",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deduped, true);
  assert.equal(
    result.record.id,
    competingId,
    "the catch-branch re-check must surface the record that actually won the race, not fabricate a new identity",
  );

  const rows = await createDividendManualRecordRepository(realClient).list(
    "a",
    "pa",
  );
  assert.equal(
    rows.length,
    1,
    "this request's own losing INSERT must not have left a second row -- the unique index rejected it and the catch-branch found the winner",
  );
});

test("UI-009 finishing item 2: a cross-user attempt reusing another owner's idempotency key AND security id is denied, never dedupes into (or leaks) that owner's record", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const idempotencyKey = "guessed-or-replayed-key";

  const ownerCreate = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-1",
  });
  assert.equal(ownerCreate.ok, true);

  // A different user attempts a create carrying the SAME idempotency key
  // value AND user "a"'s exact portfolioSecurityId (e.g. a guessed or
  // replayed request) -- the repository-level ownership check must deny
  // this outright; the idempotency-key lookup must never be scoped loosely
  // enough to leak or dedupe into another owner's record.
  const crossUserAttempt = await repository.create("b", "pb", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-1",
  });
  assert.equal(crossUserAttempt.ok, false);
  if (crossUserAttempt.ok) return;
  assert.equal(crossUserAttempt.reason, "not_found");

  const ownerRecords = await repository.list("a", "pa");
  assert.equal(ownerRecords.length, 1);
});

test("UI-009 finishing item 2: two different owners using the SAME idempotency key against their OWN distinct securities both succeed as two independent records", async () => {
  const db = await fixture();
  db.exec(`
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psb1','b','pb','s1','ALPHA','AUD','held','2026-08-01','2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const repository = createDividendManualRecordRepository(client);
  const idempotencyKey = "same-literal-key-different-owners";

  const forOwnerA = await repository.create("a", "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-1",
  });
  const forOwnerB = await repository.create("b", "pb", {
    portfolioSecurityId: "psb1",
    paymentDate: "2026-05-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "0.5",
    frankingCreditPerShareDecimal: null,
    idempotencyKey,
    requestId: "req-1",
  });

  assert.equal(forOwnerA.ok, true);
  assert.equal(forOwnerB.ok, true);
  if (!forOwnerA.ok || !forOwnerB.ok) return;
  assert.notEqual(forOwnerA.record.id, forOwnerB.record.id);
  assert.equal(forOwnerA.deduped, false);
  assert.equal(forOwnerB.deduped, false);
});

test("UI-006B: an event-linked save persists to dividend_event_overrides, shows as edited, and Exclude marks it excluded without deleting it", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const providerEvent = {
    id: "de1",
    kind: "cash" as const,
    status: "paid" as const,
    exDate: "2026-03-01",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "1",
    supersedesEventId: null,
  };

  const saved = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-05",
    sharesDecimal: "50",
    dividendPerShareDecimal: "1.2",
    frankingCreditPerShareDecimal: null,
    dividendEventId: "de1",
    manualRecordId: null,
    expectedVersion: null,
    exclude: false,
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.target, "event_override");

  const overridesAfterEdit = await createDividendEventOverrideRepository(
    client,
  ).list("a", "pa");
  const editedRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "psa1",
    securityCurrencyCode: "AUD",
    events: [providerEvent],
    overrides: overridesAfterEdit.map((override) => ({
      dividendEventId: override.dividendEventId,
      sharesDecimal: override.sharesDecimal,
      dividendPerShareDecimal: override.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: override.frankingCreditPerShareDecimal,
      exclude: override.exclude,
    })),
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(editedRows.length, 1);
  assert.equal(editedRows[0]!.source, "edited");
  assert.equal(editedRows[0]!.excluded, false);

  const excluded = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-05",
    sharesDecimal: "50",
    dividendPerShareDecimal: "1.2",
    frankingCreditPerShareDecimal: null,
    dividendEventId: "de1",
    manualRecordId: null,
    expectedVersion: saved.version,
    exclude: true,
  });
  assert.equal(excluded.ok, true);

  const overridesAfterExclude = await createDividendEventOverrideRepository(
    client,
  ).list("a", "pa");
  const excludedRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "psa1",
    securityCurrencyCode: "AUD",
    events: [providerEvent],
    overrides: overridesAfterExclude.map((override) => ({
      dividendEventId: override.dividendEventId,
      sharesDecimal: override.sharesDecimal,
      dividendPerShareDecimal: override.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: override.frankingCreditPerShareDecimal,
      exclude: override.exclude,
    })),
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(
    excludedRows.length,
    1,
    "an excluded event-linked row is still returned (retrievable), never dropped",
  );
  assert.equal(excludedRows[0]!.excluded, true);
});

test("UI-006B: an FY override save changes the per-FY total's source to fy_override", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const saved = await saveDividendFyOverrideWithContext(ctx, "pa", {
    financialYearEndingYear: 2026,
    grossedAmountDecimal: "1000",
    frankingAmountDecimal: "300",
    expectedVersion: null,
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.financialYearEndingYear, 2026);

  const overrides = await createDividendFyOverrideRepository(client).list(
    "a",
    "pa",
  );
  const totals = computeFyDividendTotals(
    [],
    overrides.map((override) => ({
      endingYear: override.financialYearEndingYear,
      grossedAmountDecimal: override.grossedAmountDecimal,
      frankingAmountDecimal: override.frankingAmountDecimal,
    })),
    7,
  );
  assert.equal(totals.ok, true);
  if (!totals.ok) return;
  const fy2026 = totals.totals.find((total) => total.endingYear === 2026);
  assert.ok(fy2026, "expected an FY2026 total");
  assert.equal(fy2026!.source, "fy_override");
});

test("UI-006B: an FY override with a negative gross amount is rejected before writing", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const result = await saveDividendFyOverrideWithContext(ctx, "pa", {
    financialYearEndingYear: 2026,
    grossedAmountDecimal: "-1",
    frankingAmountDecimal: null,
    expectedVersion: null,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
});

test("UI-006B: shares-at-date is date-sensitive (buy then sell) and owner-scoped", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);

  const beforeSale = await sharesAtDateWithContext(
    contextFor(client, "a"),
    "pa",
    {
      portfolioSecurityId: "psa1",
      date: "2026-01-15",
    },
  );
  assert.equal(beforeSale.ok, true);
  if (beforeSale.ok) assert.equal(beforeSale.sharesDecimal, "100");

  const afterSale = await sharesAtDateWithContext(
    contextFor(client, "a"),
    "pa",
    {
      portfolioSecurityId: "psa1",
      date: "2026-02-15",
    },
  );
  assert.equal(afterSale.ok, true);
  if (afterSale.ok) assert.equal(afterSale.sharesDecimal, "60");

  const beforeAnyPurchase = await sharesAtDateWithContext(
    contextFor(client, "a"),
    "pa",
    {
      portfolioSecurityId: "psa1",
      date: "2025-12-01",
    },
  );
  assert.equal(beforeAnyPurchase.ok, true);
  if (beforeAnyPurchase.ok) assert.equal(beforeAnyPurchase.sharesDecimal, "0");

  const crossUser = await sharesAtDateWithContext(
    contextFor(client, "b"),
    "pa",
    {
      portfolioSecurityId: "psa1",
      date: "2026-02-15",
    },
  );
  assert.equal(crossUser.ok, false);
  if (crossUser.ok) return;
  assert.equal(crossUser.status, 404);
});

// F3 (UI-006B review fix): a bare `LIMIT 100000` silently truncates an
// oversized ledger and derives a wrong (too-low) shares-held figure with no
// disclosure. Verified via source (inserting 20,001 fixture transactions to
// exercise the throw directly would be prohibitively slow for a unit test,
// consistent with this codebase's existing convention for other MAX+1
// overflow boundaries -- e.g. `too_many_transactions`/
// `too_many_dividend_events` in `app/owned-dividend-history.ts` have no
// row-count-exercising test either): confirms the query binds `LIMIT ?` to
// `MAX + 1` (never a bare numeric literal) and that an overflow throws/is
// caught as a typed failure rather than silently truncating.
test("UI-006B: shares-at-date replaces the bare LIMIT with the MAX+1 overflow-throw pattern (source-verified, matching owned-dividend-history.ts)", async () => {
  const source = await readFile(
    new URL("../app/dividend-assumptions-actions.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /LIMIT 100000/,
    "must not use a bare numeric LIMIT that silently truncates",
  );
  assert.match(source, /MAX_TRANSACTIONS_PER_SECURITY \+ 1/);
  assert.match(source, /rows\.length > MAX_TRANSACTIONS_PER_SECURITY/);
});

test("UI-006B: a manual save near an existing entry for the same security surfaces DIV-004's non-blocking proximity warning", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const first = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.proximityWarning, null);

  const near = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-06", // 5 days later, inside the 7-day window
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(near.ok, true);
  if (!near.ok) return;
  assert.ok(near.proximityWarning);
  assert.match(near.proximityWarning!, /7 days/);
  // A warning is disclosed but never blocking -- the save still succeeded.
  const afterNear = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
  );
  assert.equal(afterNear.length, 2);

  const far = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-06-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(far.ok, true);
  if (far.ok) assert.equal(far.proximityWarning, null);
});

test("UI-006B: computeProximityWarning excludes the record being edited from its own proximity check", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const created = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const warning = await computeProximityWarning(
    client,
    "a",
    "pa",
    "psa1",
    "2026-03-01",
    created.id,
  );
  assert.equal(
    warning,
    null,
    "the record being edited must not warn against itself",
  );
});

// DIV-016 part A: an edit is now a SUPERSESSION, never an in-place rewrite
// (AGENTS.md ledger-immutability rule) -- `edited.id` is a NEW row's id, the
// ORIGINAL (`created.id`) is retained unmodified and marked superseded, and
// "Exclude this dividend" targets the CURRENT HEAD (`edited.id`), never a
// superseded ancestor.
test('UI-006B: an owner-typed manual record\'s edit (supersession) and delete ("Exclude this dividend" for the non-event-linked tier) both persist correctly', async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const created = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const edited = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "12",
    dividendPerShareDecimal: "1.1",
    frankingCreditPerShareDecimal: "0.3",
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
  });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.notEqual(edited.id, created.id);

  const repository = createDividendManualRecordRepository(client);
  const afterEdit = await repository.get("a", "pa", edited.id);
  assert.equal(afterEdit?.sharesDecimal, "12");
  assert.equal(afterEdit?.dividendPerShareDecimal, "1.1");

  // The original row is retained, unmodified, and excluded from evidence.
  const original = await repository.get("a", "pa", created.id);
  assert.equal(original?.sharesDecimal, "10");
  assert.equal(original?.dividendPerShareDecimal, "1");
  assert.equal(original?.supersededByRecordId, edited.id);
  const list = await repository.list("a", "pa", "psa1");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, edited.id);

  const deleted = await deleteDividendManualRecordWithContext(ctx, "pa", {
    manualRecordId: edited.id,
    expectedVersion: edited.version,
  });
  assert.equal(deleted.ok, true);
  const afterDelete = await repository.get("a", "pa", edited.id);
  assert.equal(afterDelete, null);
  // The superseded original survives deletion of its successor -- it is
  // never itself deletable (see `remove()`'s `superseded_by_record_id IS
  // NULL` guard), preserving the audit trail.
  const originalAfterDelete = await repository.get("a", "pa", created.id);
  assert.notEqual(originalAfterDelete, null);
});

// B1 (UI-006B review fix): an IMPORTED row (`import_batch_id IS NOT NULL`,
// created by IMP-006's CSV commit) must never be editable/deletable through
// these owner-facing actions -- doing so silently blended an owner edit
// into a row still labelled the imported tier and broke IMP-006's reversal
// accounting (the imported row's facts are supposed to change only by
// reversing the import batch that created it).

async function insertImportedManualRecord(
  client: ReturnType<typeof createSqliteSqlClient>,
): Promise<void> {
  await client.run(
    `INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal,
      franking_credit_per_share_decimal, import_batch_id, source_reference,
      created_at, updated_at, version
    ) VALUES ('imported-1', 'a', 'pa', 'psa1', '2026-04-01', '10', '1', NULL,
      'batch-1', 'row-1', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', 1)`,
    [],
  );
}

test("UI-006B: editing an imported dividend row is denied (409); an owner-typed row's edit still succeeds", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  await insertImportedManualRecord(client);
  const ctx = contextFor(client, "a");

  const deniedEdit = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-04-01",
    sharesDecimal: "99",
    dividendPerShareDecimal: "9",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: "imported-1",
    expectedVersion: 1,
  });
  assert.equal(deniedEdit.ok, false);
  if (deniedEdit.ok) return;
  assert.equal(deniedEdit.status, 409);
  assert.match(deniedEdit.message, /reversing the import batch/);

  const unchanged = await createDividendManualRecordRepository(client).get(
    "a",
    "pa",
    "imported-1",
  );
  assert.equal(
    unchanged?.sharesDecimal,
    "10",
    "the imported row must be unmodified",
  );
  assert.equal(unchanged?.version, 1);

  // An owner-typed (non-imported) row's edit still succeeds.
  const ownerTyped = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(ownerTyped.ok, true);
  if (!ownerTyped.ok) return;
  const editOwnerTyped = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "11",
    dividendPerShareDecimal: "1.5",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: ownerTyped.id,
    expectedVersion: ownerTyped.version,
  });
  assert.equal(editOwnerTyped.ok, true);
});

test("UI-006B: deleting an imported dividend row is denied (409); an owner-typed row's delete still succeeds", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  await insertImportedManualRecord(client);
  const ctx = contextFor(client, "a");

  const deniedDelete = await deleteDividendManualRecordWithContext(ctx, "pa", {
    manualRecordId: "imported-1",
    expectedVersion: 1,
  });
  assert.equal(deniedDelete.ok, false);
  if (deniedDelete.ok) return;
  assert.equal(deniedDelete.status, 409);
  assert.match(deniedDelete.message, /reversing the import batch/);

  const stillThere = await createDividendManualRecordRepository(client).get(
    "a",
    "pa",
    "imported-1",
  );
  assert.ok(stillThere, "the imported row must not have been deleted");

  // An owner-typed (non-imported) row's delete still succeeds.
  const ownerTyped = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(ownerTyped.ok, true);
  if (!ownerTyped.ok) return;
  const deleteOwnerTyped = await deleteDividendManualRecordWithContext(
    ctx,
    "pa",
    {
      manualRecordId: ownerTyped.id,
      expectedVersion: ownerTyped.version,
    },
  );
  assert.equal(deleteOwnerTyped.ok, true);
});

test("UI-006B: negative franking credit per share and a non-positive shares/dividend-per-share value are rejected", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const negativeFranking = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: "-0.1",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(negativeFranking.ok, false);
  if (!negativeFranking.ok) assert.equal(negativeFranking.status, 400);

  const zeroShares = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "0",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(zeroShares.ok, false);
  if (!zeroShares.ok) assert.equal(zeroShares.status, 400);

  const malformedDate = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "not-a-date",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(malformedDate.ok, false);
  if (!malformedDate.ok) assert.equal(malformedDate.status, 400);

  const remaining = await createDividendManualRecordRepository(client).list(
    "a",
    "pa",
  );
  assert.equal(
    remaining.length,
    0,
    "no invalid input should have persisted anything",
  );
});

// ---------------------------------------------------------------------------
// Rendered accessibility assertions.
// ---------------------------------------------------------------------------

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

// F4 (UI-006B review fix) added `useRouter()` calls to this component,
// which throws ("invariant expected app router to be mounted") outside a
// real Next.js App Router context. Mirrors `tests/qa-001b.test.ts`'s
// established `AppRouterContext.Provider` + stub-router workaround (used
// there for the identical reason -- `portfolio-shell.tsx`'s own
// `useRouter()` calls) rather than avoiding rendering this component.
const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(${componentName}, props),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

const baseSecurities = [
  {
    portfolioSecurityId: "psa1",
    symbol: "ALPHA",
    currencyCode: "AUD",
    providerYield: { ok: true, trailingYieldPercentDecimal: "4.2" },
    providerFrankingStatus: "unavailable",
    ownerYieldPercentDecimal: null,
    ownerFrankingPercentDecimal: null,
    ownerGrowthPercentDecimal: null,
    version: null,
  },
];

const baseProps = {
  portfolioId: "pa",
  today: "2026-08-13",
  securities: baseSecurities,
  portfolio: {
    valueGrowthPercentDecimal: null,
    portfolioDividendGrowthPercentDecimal: null,
    version: null,
  },
  fyOverrides: [],
  initialOverrideYear: null,
};

test("UI-006B: the assumptions grid renders labelled owner-editable cells with the franking unit pinned in the label", () => {
  const html = renderComponent(
    "DividendAssumptionsEditor",
    "../app/components/dividend-assumptions-editor.tsx",
    baseProps,
  );
  assert.match(html, /100 = fully franked/);
  assert.match(html, /<label/);
  assert.match(html, /ALPHA/);
  assert.match(html, /role="table"/);
  assert.match(html, /Record dividend received/);
  assert.match(html, /Override a past FY/);
  assert.match(html, /Unavailable/); // provider franking, always
});

test("UI-006B: the grid falls back to an explicit empty state with no securities held (never a fabricated row)", () => {
  const html = renderComponent(
    "DividendAssumptionsEditor",
    "../app/components/dividend-assumptions-editor.tsx",
    { ...baseProps, securities: [] },
  );
  assert.match(html, /No held securities/);
});

// B3 (UI-006B review fix): RecordDividendDialog previously rendered no
// exclude control at all and was not exported, so exclusion was
// unreachable app-wide and the DELETE handler had zero callers. Now
// exported for UI-006C's future entry point, and renders the correct
// exclude affordance for each of its three modes: a blank create (neither
// control), event-linked (a checkbox on the same save), and editing an
// existing owner-typed manual record (a delete action).

const recordDialogSecurities = [
  { portfolioSecurityId: "psa1", symbol: "ALPHA", currencyCode: "AUD" },
];

function renderRecordDialog(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "RecordDividendDialog",
    "../app/components/dividend-assumptions-editor.tsx",
    {
      dialogRef: { current: null },
      portfolioId: "pa",
      securities: recordDialogSecurities,
      maxDate: "2026-08-13",
      ...overrides,
    },
  );
}

test("UI-006B: RecordDividendDialog is exported (reachable for UI-006C's future entry point) and renders a blank create form with neither exclude control", () => {
  const html = renderRecordDialog();
  assert.match(html, /Record dividend received/);
  assert.doesNotMatch(html, /Exclude this dividend/);
});

test("UI-006B: RecordDividendDialog renders an 'Exclude this dividend' checkbox when event-linked, and disables/annotates the non-persisted payment date (F2)", () => {
  const html = renderRecordDialog({
    initialDividendEventId: "de1",
    initialPaymentDate: "2026-03-01",
    initialSharesDecimal: "50",
    initialDividendPerShareDecimal: "1",
    initialExpectedVersion: 1,
  });
  assert.match(html, /Edit this dividend/);
  assert.match(html, /Exclude this dividend/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /follows the linked dividend event/);
});

test("UI-006B: RecordDividendDialog renders an 'Exclude this dividend' delete action when editing an existing owner-typed manual record, with no exclude checkbox", () => {
  const html = renderRecordDialog({
    initialManualRecordId: "manual-1",
    initialPaymentDate: "2026-05-01",
    initialSharesDecimal: "10",
    initialDividendPerShareDecimal: "1",
    initialExpectedVersion: 3,
  });
  assert.match(html, /Exclude this dividend/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

// B4 (UI-006B review fix): mirrors income-multi-year.tsx's dialog focus
// pattern (QA-001B K3) -- focus the close control on open, capture the
// opener button at click time, and restore its focus when the dialog
// closes.
test("UI-006B: both dialogs focus their close control on open and restore the opener button's focus on close (B4, QA-001B K3)", async () => {
  const source = await readFile(
    new URL(
      "../app/components/dividend-assumptions-editor.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /recordDialogOpenerRef = useRef<HTMLButtonElement \| null>\(null\)/,
  );
  assert.match(
    source,
    /fyDialogOpenerRef = useRef<HTMLButtonElement \| null>\(null\)/,
  );
  assert.match(source, /recordDialogOpenerRef\.current = event\.currentTarget/);
  assert.match(source, /fyDialogOpenerRef\.current = event\.currentTarget/);
  const focusCloseCount = (
    source.match(
      /querySelector<HTMLButtonElement>\("\.sheet-close"\)\?\.focus\(\)/g,
    ) ?? []
  ).length;
  assert.equal(
    focusCloseCount,
    2,
    "both dialogs' open effects must focus .sheet-close",
  );
  const restoreFocusCount = (
    source.match(/OpenerRef\.current\.focus\(\)/g) ?? []
  ).length;
  assert.equal(
    restoreFocusCount,
    2,
    "both dialogs' close effects must restore the opener's focus",
  );
});

// F1 (UI-006B review fix): a successful save must switch both dialogs into
// UPDATE mode (store the returned id/version) so an accidental resubmit
// never silently creates a duplicate `dividend_manual_records` row (which
// has no uniqueness constraint to catch a resubmitted create).
test("UI-006B: a successful save stores the returned id/version so a resubmit updates rather than duplicates (F1)", async () => {
  const source = await readFile(
    new URL(
      "../app/components/dividend-assumptions-editor.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /setSavedVersion\(result\.version\)/);
  assert.match(
    source,
    /if \(result\.target === "manual_record"\) \{\s*setSavedManualRecordId\(result\.id\);/,
  );
  const setSavedVersionCallCount = (
    source.match(/setSavedVersion\(result\.version\)/g) ?? []
  ).length;
  assert.equal(
    setSavedVersionCallCount,
    2,
    "both the record dialog and the FY dialog must switch to update mode after a successful save",
  );
});

// F4 (UI-006B review fix): this page's `securities`/`portfolio`/`fyOverrides`
// props are server-rendered and would otherwise go stale in-session after a
// save -- mirrors `portfolio-shell.tsx`'s settings-save `router.refresh()`
// pattern.
test("UI-006B: successful mutations call router.refresh() so grid/FY versions never go stale in-session (F4)", async () => {
  const source = await readFile(
    new URL(
      "../app/components/dividend-assumptions-editor.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /import \{ useRouter \} from "next\/navigation";/);
  const refreshCallCount = (source.match(/router\.refresh\(\);/g) ?? []).length;
  assert.equal(
    refreshCallCount,
    4,
    "expected router.refresh() after the grid save, the record-dividend save, the record-dividend delete, and the FY-override save",
  );
});

test("UI-006B: the FY override dialog auto-opens and is pre-filled when initialOverrideYear matches an existing override (UI-006A's ?overrideYear= contract)", () => {
  const html = renderComponent(
    "DividendAssumptionsEditor",
    "../app/components/dividend-assumptions-editor.tsx",
    {
      ...baseProps,
      fyOverrides: [
        {
          financialYearEndingYear: 2025,
          grossedAmountDecimal: "1000",
          frankingAmountDecimal: "300",
          version: 1,
        },
      ],
      initialOverrideYear: 2025,
    },
  );
  assert.match(html, /Override a past financial year/);
  assert.match(html, /value="1000"/);
  assert.match(html, /overrides receipts and provider history/);
});

test("UI-006B: dividend-assumptions-editor interactive controls meet the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".dividend-assumptions-actions button",
    ".dividend-assumptions-row input",
    ".dividend-assumptions-save-bar button",
  ]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
});

test("UI-006B: the grid reflows to one block per security at mobile widths and to a dense row at the app's 700px breakpoint", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.dividend-assumptions-row \{[^}]*grid-template-columns:\s*1fr;/,
  );
  assert.match(
    styles,
    /@media \(min-width: 700px\) \{[\s\S]*\.dividend-assumptions-row \{[^}]*grid-template-columns:(?!\s*1fr;)/,
  );
});
