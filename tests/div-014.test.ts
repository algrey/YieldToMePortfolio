/**
 * DIV-014 -- "Save Scenario" (owner directive, 2026-08-24): saved multi-year
 * income what-if scenarios, built on DIV-013's capital-change parcels
 * (`app/income-whatif.ts`, `app/components/income-multi-year.tsx`).
 *
 * Covers: the new `income_whatif_scenarios` migration/purge-lock triggers
 * and CHECK constraints, the repository's create/list/get/delete +
 * ownership isolation + audit trail, the CSRF-gated action layer's
 * validation, and the pure UI helpers (row-summary derivation, the
 * untouched/touched blank-follows-portfolio load contract, and a "tiny
 * faithful reproduction" of the load-scraps-current/session-write-on-load
 * effect wiring -- the SAME no-jsdom testing convention `tests/div-013.test.ts`
 * documents in its own header: this harness has no interactive DOM, so
 * component-level behaviour is pinned via `renderToStaticMarkup` (structure)
 * plus source-text pins (handler wiring) rather than simulated clicks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createIncomeScenarioRepository,
  createSqliteSqlClient,
  type IncomeScenarioRecord,
  type SqlClient,
} from "../db/repositories/index.ts";
import type { CapitalEventInput } from "../domain/dividends/projection.ts";
import {
  deleteIncomeScenarioWithContext,
  saveIncomeScenarioWithContext,
  type IncomeScenarioActionContext,
} from "../app/income-scenario-actions.ts";
import {
  POST as scenariosPost,
  DELETE as scenariosDelete,
} from "../app/api/portfolios/[portfolioId]/income-scenarios/route.ts";
import {
  capitalEventInputToRow,
  capitalEventRowToDomainInput,
  capitalEventsStorageKey,
  deriveIncomeScenarioYieldSummary,
  INCOME_SCENARIO_MAX_ROWS,
  INCOME_SCENARIO_NAME_MAX_LENGTH,
  isValidCapitalEventInputRow,
  loadCapitalEventsSession,
  resolveLoadedScenarioGrowthField,
  saveCapitalEventsSession,
  sumCapitalEventAmounts,
  type CapitalEventRowState,
  type StorageLike,
} from "../app/income-whatif.ts";
import {
  formatIncomeMoney,
  formatIncomePercent,
} from "../app/income-format.ts";

class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// a. Pure helpers -- capitalEventInputToRow round trip, row validation,
//    blank-follows-portfolio load contract, row-summary derivation.
// ---------------------------------------------------------------------------

const sampleInput: CapitalEventInput = {
  id: "row-1",
  name: "House sale",
  amountDecimal: "1200.50",
  month: 3,
  year: 2027,
  yieldPercentDecimal: "4.5",
  capitalGrowthPercentDecimal: null,
  dividendGrowthPercentDecimal: "2",
};

test("DIV-014: capitalEventInputToRow / capitalEventRowToDomainInput compose to the identity in both directions -- structurally identical shapes, never a lossy conversion", () => {
  const row = capitalEventInputToRow(sampleInput);
  assert.deepEqual(row, sampleInput);
  const backToInput = capitalEventRowToDomainInput(row);
  assert.deepEqual(backToInput, sampleInput);
});

test("DIV-014: isValidCapitalEventInputRow accepts a well-formed row (incl. null blank-follow growth fields) and rejects every malformed shape", () => {
  assert.equal(isValidCapitalEventInputRow(sampleInput), true);
  assert.equal(
    isValidCapitalEventInputRow({
      ...sampleInput,
      capitalGrowthPercentDecimal: "3",
    }),
    true,
  );
  assert.equal(isValidCapitalEventInputRow(null), false);
  assert.equal(isValidCapitalEventInputRow("not an object"), false);
  assert.equal(isValidCapitalEventInputRow({ ...sampleInput, id: "" }), false);
  assert.equal(
    isValidCapitalEventInputRow({ ...sampleInput, name: "   " }),
    false,
  );
  assert.equal(
    isValidCapitalEventInputRow({ ...sampleInput, amountDecimal: "abc" }),
    false,
  );
  assert.equal(
    isValidCapitalEventInputRow({ ...sampleInput, month: 13 }),
    false,
  );
  assert.equal(
    isValidCapitalEventInputRow({ ...sampleInput, month: 0 }),
    false,
  );
  assert.equal(
    isValidCapitalEventInputRow({ ...sampleInput, year: 1899 }),
    false,
  );
  assert.equal(
    isValidCapitalEventInputRow({
      ...sampleInput,
      yieldPercentDecimal: "12%",
    }),
    false,
  );
  assert.equal(
    isValidCapitalEventInputRow({
      ...sampleInput,
      capitalGrowthPercentDecimal: "not-a-number",
    }),
    false,
  );
  assert.equal(
    isValidCapitalEventInputRow({
      ...sampleInput,
      dividendGrowthPercentDecimal: "not-a-number",
    }),
    false,
  );
});

test("DIV-014 (owner ruling): resolveLoadedScenarioGrowthField -- a NULL stored axis resolves touched:false to the CURRENT portfolio assumption (live-follows, recomputes when that assumption changes); a non-null stored axis resolves touched:true to the frozen owner-edited value", () => {
  assert.deepEqual(resolveLoadedScenarioGrowthField(null, "7"), {
    input: "7",
    touched: false,
  });
  assert.deepEqual(resolveLoadedScenarioGrowthField("4.5", "7"), {
    input: "4.5",
    touched: true,
  });
  // The portfolio assumption changed since the scenario was saved -- an
  // untouched axis follows the NEW value, never a frozen copy of whatever
  // it happened to be at save time.
  assert.deepEqual(resolveLoadedScenarioGrowthField(null, "9"), {
    input: "9",
    touched: false,
  });
  // A touched axis stays frozen regardless of the current portfolio value.
  assert.deepEqual(resolveLoadedScenarioGrowthField("4.5", "9"), {
    input: "4.5",
    touched: true,
  });
});

test("DIV-014 (owner ruling, negative amounts): sumCapitalEventAmounts nets removals against additions -- an honest NET figure, never a fabricated gross total", () => {
  assert.equal(sumCapitalEventAmounts([]), "0");
  assert.equal(
    sumCapitalEventAmounts([
      { ...sampleInput, amountDecimal: "1000" },
      { ...sampleInput, amountDecimal: "500" },
    ]),
    "1500",
  );
  assert.equal(
    sumCapitalEventAmounts([
      { ...sampleInput, amountDecimal: "1000" },
      { ...sampleInput, amountDecimal: "-300" },
    ]),
    "700",
  );
  assert.equal(
    sumCapitalEventAmounts([
      { ...sampleInput, amountDecimal: "-1000" },
      { ...sampleInput, amountDecimal: "-500" },
    ]),
    "-1500",
  );
});

test("DIV-014 (owner ruling 2026-08-24, superseding round-1 'Mixed'): deriveIncomeScenarioYieldSummary is 'none' with no parcels, 'single' when every parcel shares the identical yield (compared as decimal VALUES, not raw strings), the net-amount-weighted 'average' otherwise, and 'indeterminate' when the net amount is exactly zero", () => {
  assert.deepEqual(deriveIncomeScenarioYieldSummary([]), { kind: "none" });
  assert.deepEqual(
    deriveIncomeScenarioYieldSummary([
      { ...sampleInput, yieldPercentDecimal: "2" },
      { ...sampleInput, yieldPercentDecimal: "2" },
    ]),
    { kind: "single", yieldPercentDecimal: "2" },
  );
  // "2" and "2.00" are the SAME decimal value -- still a single common yield.
  assert.deepEqual(
    deriveIncomeScenarioYieldSummary([
      { ...sampleInput, yieldPercentDecimal: "2" },
      { ...sampleInput, yieldPercentDecimal: "2.00" },
    ]),
    { kind: "single", yieldPercentDecimal: "2" },
  );
  // Differing yields blend as the net-amount-weighted average (owner:
  // "the total average portfolio yield for the scenario"): equal amounts
  // at 2% and 3% -> exactly 2.5%.
  assert.deepEqual(
    deriveIncomeScenarioYieldSummary([
      { ...sampleInput, amountDecimal: "1000", yieldPercentDecimal: "2" },
      { ...sampleInput, amountDecimal: "1000", yieldPercentDecimal: "3" },
    ]),
    { kind: "average", yieldPercentDecimal: "2.5" },
  );
  // Signed weighting: +10000 @ 4% with -2500 @ 5.5% -> net 7500,
  // (10000*4 - 2500*5.5) / 7500 = 26250/7500 = 3.5%.
  assert.deepEqual(
    deriveIncomeScenarioYieldSummary([
      { ...sampleInput, amountDecimal: "10000", yieldPercentDecimal: "4" },
      { ...sampleInput, amountDecimal: "-2500", yieldPercentDecimal: "5.5" },
    ]),
    { kind: "average", yieldPercentDecimal: "3.5" },
  );
  // A net-zero scenario has no meaningful blended yield -- honest
  // indeterminate (em-dash), never a divide-by-zero or fabricated figure.
  assert.deepEqual(
    deriveIncomeScenarioYieldSummary([
      { ...sampleInput, amountDecimal: "5000", yieldPercentDecimal: "2" },
      { ...sampleInput, amountDecimal: "-5000", yieldPercentDecimal: "3" },
    ]),
    { kind: "indeterminate" },
  );
});

// ---------------------------------------------------------------------------
// b. Load-scraps-current / session-write-on-load -- a tiny faithful
//    reproduction of `handleLoadScenario` + the DIV-013 save effect, the
//    identical no-DOM testing convention `tests/div-013.test.ts`'s own B3
//    drill uses for effect-ordering behaviour.
// ---------------------------------------------------------------------------

test("DIV-014 (load-scraps-current, session-write-on-load): loading a saved scenario replaces the CURRENT capital rows/reinvest flag WHOLESALE (never merged), and the replacement is written into sessionStorage via the SAME DIV-013 save mechanism -- immediately, no debounce", () => {
  const storage = new FakeStorage();
  const portfolioId = "portfolio-x";
  const key = capitalEventsStorageKey(portfolioId);
  // Mirrors the component post-mount: hydratedKeyRef already matches this
  // portfolio's key, so the save effect is live.
  const hydratedKeyRef: { current: string | null } = { current: key };
  let capitalRows: CapitalEventRowState[] = [
    {
      id: "current-1",
      name: "Current parcel",
      amountDecimal: "500",
      month: 3,
      year: 2027,
      yieldPercentDecimal: "4",
      capitalGrowthPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
    },
  ];
  let reinvestDividends = true;
  function runSaveEffect() {
    if (hydratedKeyRef.current !== key) return;
    saveCapitalEventsSession(storage, key, {
      rows: capitalRows,
      reinvestDividends,
    });
  }
  runSaveEffect();
  assert.deepEqual(loadCapitalEventsSession(storage, key).rows, capitalRows);

  const scenario: IncomeScenarioRecord = {
    id: "scenario-1",
    userId: "user-a",
    portfolioId,
    name: "Loaded scenario",
    rows: [
      {
        id: "saved-1",
        name: "Saved parcel",
        amountDecimal: "-1000",
        month: 6,
        year: 2028,
        yieldPercentDecimal: "3",
        capitalGrowthPercentDecimal: "5",
        dividendGrowthPercentDecimal: null,
      },
    ],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: "6",
    createdAt: "2026-08-24T00:00:00Z",
    version: 1,
  };
  // A faithful reproduction of `handleLoadScenario`'s state-replacement body
  // (the two `setCapitalRows`/`setReinvestDividends` calls).
  capitalRows = scenario.rows.map(capitalEventInputToRow);
  reinvestDividends = scenario.reinvestDividends;
  runSaveEffect();

  assert.equal(capitalRows.length, 1);
  assert.equal(
    capitalRows[0]!.id,
    "saved-1",
    "the CURRENT row must be entirely GONE, never merged alongside the loaded one",
  );
  assert.equal(reinvestDividends, false);
  assert.deepEqual(loadCapitalEventsSession(storage, key), {
    rows: scenario.rows.map(capitalEventInputToRow),
    reinvestDividends: false,
  });
});

// ---------------------------------------------------------------------------
// c. Migration -- table shape, purge-lock triggers, CHECK constraints, the
//    composite FK.
// ---------------------------------------------------------------------------

async function loadMigrationSql(): Promise<string> {
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const contents = await Promise.all(
    files.map((file) =>
      readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    ),
  );
  return contents.join("\n");
}

async function database(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(await loadMigrationSql());
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-24', '2026-08-24', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-24', '2026-08-24', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at)
    VALUES ('pa', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-24', '2026-08-24'),
           ('pb', 'user-b', 'B', 'B portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-24', '2026-08-24');
  `);
  return db;
}

function actionContext(
  client: SqlClient,
  userId: string,
): IncomeScenarioActionContext {
  return { client, userId, requestId: `request-${userId}` };
}

test("DIV-014 migration: income_whatif_scenarios has its three purge-lock triggers", async () => {
  const db = await database();
  const triggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'income_whatif_scenarios' ORDER BY name",
    )
    .all() as { name: string }[];
  assert.deepEqual(
    triggers.map((row) => row.name),
    [
      "account_purge_lock_income_whatif_scenarios_delete",
      "account_purge_lock_income_whatif_scenarios_insert",
      "account_purge_lock_income_whatif_scenarios_update",
    ],
  );
  db.close();
});

test("DIV-014 migration: the purge-lock trigger actually fires -- an in-flight purge job blocks an income_whatif_scenarios insert", async () => {
  const db = await database();
  db.exec(`
    INSERT INTO account_purge_jobs (
      id, owner_user_id, deletion_request_id, deletion_key_digest,
      export_job_id, manifest_digest, status, phase, eligible_at,
      confirmed_at, created_at, updated_at
    ) VALUES (
      'purge-a', 'user-a', 'request-a', 'key-digest', 'export-a',
      'manifest-a', 'running', 'validate_source', '2026-08-24', '2026-08-24',
      '2026-08-24', '2026-08-24'
    );
  `);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO income_whatif_scenarios (id, user_id, portfolio_id, name, capital_rows_json, reinvest_dividends, created_at, version)
       VALUES ('scenario-locked', 'user-a', 'pa', 'Locked', '[]', 0, '2026-08-24', 1)`,
    ).run();
  }, /account_purge_source_locked/);
  db.close();
});

test("DIV-014 schema: the name CHECK rejects an empty or whitespace-only name", async () => {
  const db = await database();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO income_whatif_scenarios (id, user_id, portfolio_id, name, capital_rows_json, reinvest_dividends, created_at, version)
       VALUES ('bad-a', 'user-a', 'pa', '', '[]', 0, '2026-08-24', 1)`,
    ).run();
  }, /CHECK constraint failed/);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO income_whatif_scenarios (id, user_id, portfolio_id, name, capital_rows_json, reinvest_dividends, created_at, version)
       VALUES ('bad-b', 'user-a', 'pa', '   ', '[]', 0, '2026-08-24', 1)`,
    ).run();
  }, /CHECK constraint failed/);
  db.close();
});

test("DIV-014 schema: the reinvest_dividends CHECK rejects any value outside (0, 1)", async () => {
  const db = await database();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO income_whatif_scenarios (id, user_id, portfolio_id, name, capital_rows_json, reinvest_dividends, created_at, version)
       VALUES ('bad-c', 'user-a', 'pa', 'Name', '[]', 2, '2026-08-24', 1)`,
    ).run();
  }, /CHECK constraint failed/);
  db.close();
});

test("DIV-014 schema: the composite (portfolio_id, user_id) FK rejects a portfolio/owner mismatch -- a row can never claim a portfolio it does not own", async () => {
  const db = await database();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO income_whatif_scenarios (id, user_id, portfolio_id, name, capital_rows_json, reinvest_dividends, created_at, version)
       VALUES ('bad-d', 'user-b', 'pa', 'Name', '[]', 0, '2026-08-24', 1)`,
    ).run();
  }, /FOREIGN KEY constraint failed/);
  db.close();
});

// ---------------------------------------------------------------------------
// d. Repository: create/list/get/delete, ownership isolation, audit trail.
// ---------------------------------------------------------------------------

test("DIV-014 repository: save creates a row and round-trips every field (incl. null blank-follow growth axes and JSON-encoded parcel rows) exactly", async () => {
  const db = await database();
  const repo = createIncomeScenarioRepository(createSqliteSqlClient(db));
  const result = await repo.save("user-a", "pa", {
    name: "My scenario",
    rows: [sampleInput],
    reinvestDividends: true,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: "8",
    requestId: "req-1",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.scenario.name, "My scenario");
  assert.deepEqual(result.scenario.rows, [sampleInput]);
  assert.equal(result.scenario.reinvestDividends, true);
  assert.equal(result.scenario.valueGrowthPercentDecimal, null);
  assert.equal(result.scenario.dividendGrowthPercentDecimal, "8");
  assert.equal(result.scenario.version, 1);
  const fetched = await repo.get("user-a", "pa", result.scenario.id);
  assert.deepEqual(fetched, result.scenario);
  db.close();
});

test("DIV-014 repository: save is rejected for a portfolio the caller does not own", async () => {
  const db = await database();
  const repo = createIncomeScenarioRepository(createSqliteSqlClient(db));
  const result = await repo.save("user-b", "pa", {
    name: "Not mine",
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    requestId: "req-1",
  });
  assert.deepEqual(result, { ok: false, reason: "not_found" });
  db.close();
});

test("DIV-014 repository: list orders most-recently-saved first", async () => {
  const db = await database();
  // Reviewer fix: `save`'s default `now` (`new Date().toISOString()`) can
  // land both calls in the SAME millisecond under real wall-clock timing,
  // making `created_at` tie and the ordering fall through to `id DESC` --
  // a random UUID comparison, flaky ~1-in-5. Inject a deterministic clock
  // with two strictly increasing timestamps instead of loosening the
  // assertion.
  let tick = 0;
  const deterministicNow = (): string => {
    tick += 1;
    return `2026-08-24T00:00:0${tick}.000Z`;
  };
  const repo = createIncomeScenarioRepository(
    createSqliteSqlClient(db),
    deterministicNow,
  );
  const first = await repo.save("user-a", "pa", {
    name: "First",
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    requestId: "req-1",
  });
  const second = await repo.save("user-a", "pa", {
    name: "Second",
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    requestId: "req-2",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const rows = await repo.list("user-a", "pa");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.name, "Second");
  assert.equal(rows[1]!.name, "First");
  db.close();
});

test("DIV-014 ownership isolation: cross-user cannot list, load, or delete another owner's saved scenarios -- the only channel a client ever loads scenario data through is this SAME user_id-scoped list/get", async () => {
  const db = await database();
  const repo = createIncomeScenarioRepository(createSqliteSqlClient(db));
  const saved = await repo.save("user-a", "pa", {
    name: "A's scenario",
    rows: [sampleInput],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    requestId: "req-1",
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error("unreachable");

  // Cross-user list under user B's OWN portfolio never surfaces A's row.
  assert.deepEqual(await repo.list("user-b", "pb"), []);
  // Cross-user get (even quoting A's real portfolio id) returns null.
  assert.equal(await repo.get("user-b", "pa", saved.scenario.id), null);
  // Cross-user delete (even with the correct id/version) is a not_found,
  // never a conflict that would leak the row's existence.
  const removed = await repo.remove(
    "user-b",
    "pa",
    saved.scenario.id,
    saved.scenario.version,
    "req-2",
  );
  assert.deepEqual(removed, { ok: false, reason: "not_found" });
  // The row is untouched -- still there for its real owner.
  assert.notEqual(await repo.get("user-a", "pa", saved.scenario.id), null);
  db.close();
});

test("DIV-014 repository: delete removes the row, requires the exact version (conflict on a stale version), and writes an audit row", async () => {
  const db = await database();
  const repo = createIncomeScenarioRepository(createSqliteSqlClient(db));
  const saved = await repo.save("user-a", "pa", {
    name: "To delete",
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
    requestId: "req-1",
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error("unreachable");

  const staleAttempt = await repo.remove(
    "user-a",
    "pa",
    saved.scenario.id,
    saved.scenario.version + 1,
    "req-2",
  );
  assert.deepEqual(staleAttempt, { ok: false, reason: "conflict" });

  const removed = await repo.remove(
    "user-a",
    "pa",
    saved.scenario.id,
    saved.scenario.version,
    "req-3",
  );
  assert.deepEqual(removed, { ok: true });
  assert.equal(await repo.get("user-a", "pa", saved.scenario.id), null);

  const auditRows = db
    .prepare(
      `SELECT action, target_owner_user_id, target_id, result FROM audit_events
       WHERE target_type = 'income_whatif_scenario' AND action = 'income_whatif_scenario.delete'`,
    )
    .all() as {
    action: string;
    target_owner_user_id: string;
    target_id: string;
    result: string;
  }[];
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0]!.target_owner_user_id, "user-a");
  assert.equal(auditRows[0]!.target_id, saved.scenario.id);
  assert.equal(auditRows[0]!.result, "success");
  // The stale/conflicting attempt above must NOT have written a spurious
  // success audit row (conditional-audit-insert precedent).
  const saveAuditRows = db
    .prepare(
      `SELECT action FROM audit_events WHERE target_type = 'income_whatif_scenario' AND action = 'income_whatif_scenario.save'`,
    )
    .all() as { action: string }[];
  assert.equal(saveAuditRows.length, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// e. Action layer: name/row/growth-input validation.
// ---------------------------------------------------------------------------

test("DIV-014 actions: saveIncomeScenario requires a non-empty name and valid capital-change rows", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");

  const emptyName = await saveIncomeScenarioWithContext(context, "pa", {
    name: "   ",
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(emptyName.ok, false);
  if (!emptyName.ok) assert.equal(emptyName.status, 400);

  const tooLongName = await saveIncomeScenarioWithContext(context, "pa", {
    name: "x".repeat(INCOME_SCENARIO_NAME_MAX_LENGTH + 1),
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(tooLongName.ok, false);
  if (!tooLongName.ok) assert.equal(tooLongName.status, 400);

  const notAnArray = await saveIncomeScenarioWithContext(context, "pa", {
    name: "Valid name",
    rows: "not-an-array",
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(notAnArray.ok, false);
  if (!notAnArray.ok) assert.equal(notAnArray.status, 400);

  const tooManyRows = await saveIncomeScenarioWithContext(context, "pa", {
    name: "Valid name",
    rows: Array.from({ length: INCOME_SCENARIO_MAX_ROWS + 1 }, (_, index) => ({
      ...sampleInput,
      id: `row-${index}`,
    })),
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(tooManyRows.ok, false);
  if (!tooManyRows.ok) assert.equal(tooManyRows.status, 400);

  const malformedRow = await saveIncomeScenarioWithContext(context, "pa", {
    name: "Valid name",
    rows: [{ ...sampleInput, month: 99 }],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(malformedRow.ok, false);
  if (!malformedRow.ok) assert.equal(malformedRow.status, 400);

  const invalidGrowth = await saveIncomeScenarioWithContext(context, "pa", {
    name: "Valid name",
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: "not-a-number",
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(invalidGrowth.ok, false);
  if (!invalidGrowth.ok) assert.equal(invalidGrowth.status, 400);

  const valid = await saveIncomeScenarioWithContext(context, "pa", {
    name: "  Valid name  ",
    rows: [sampleInput],
    reinvestDividends: true,
    valueGrowthPercentDecimal: "5",
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.scenario.name, "Valid name");
    assert.deepEqual(valid.scenario.rows, [sampleInput]);
  }
  db.close();
});

test("DIV-014 actions: saveIncomeScenario against a portfolio the caller does not own returns 404", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-b");
  const result = await saveIncomeScenarioWithContext(context, "pa", {
    name: "Not mine",
    rows: [],
    reinvestDividends: false,
    valueGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 404);
  db.close();
});

test("DIV-014 actions: deleteIncomeScenario requires an id and version, and reports a stale version as a conflict", async () => {
  const db = await database();
  const client = createSqliteSqlClient(db);
  const context = actionContext(client, "user-a");
  const saved = await createIncomeScenarioRepository(client).save(
    "user-a",
    "pa",
    {
      name: "To delete",
      rows: [],
      reinvestDividends: false,
      valueGrowthPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
      requestId: "req-1",
    },
  );
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error("unreachable");

  const missingFields = await deleteIncomeScenarioWithContext(
    context,
    "pa",
    {},
  );
  assert.equal(missingFields.ok, false);
  if (!missingFields.ok) assert.equal(missingFields.status, 400);

  const staleVersion = await deleteIncomeScenarioWithContext(context, "pa", {
    id: saved.scenario.id,
    expectedVersion: saved.scenario.version + 1,
  });
  assert.equal(staleVersion.ok, false);
  if (!staleVersion.ok) assert.equal(staleVersion.status, 409);

  const notFound = await deleteIncomeScenarioWithContext(context, "pa", {
    id: "does-not-exist",
    expectedVersion: 1,
  });
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.equal(notFound.status, 404);

  const success = await deleteIncomeScenarioWithContext(context, "pa", {
    id: saved.scenario.id,
    expectedVersion: saved.scenario.version,
  });
  assert.equal(success.ok, true);
  db.close();
});

// ---------------------------------------------------------------------------
// f. Route CSRF.
// ---------------------------------------------------------------------------

test("DIV-014 routes: mutation endpoints reject cross-site browser requests", async () => {
  const params = Promise.resolve({ portfolioId: "pa" });
  for (const handler of [scenariosPost, scenariosDelete]) {
    const response = await handler(
      new Request(
        "https://yieldtome.example/api/portfolios/pa/income-scenarios",
        {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
            "content-type": "application/json",
          },
          body: "{}",
        },
      ),
      { params },
    );
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Cross-site mutation/i);
  }
});

// ---------------------------------------------------------------------------
// g. Component: fresh-mount structural/rendered pins + wiring.
// ---------------------------------------------------------------------------

// DIV-014 added a `useRouter()` call (`router.refresh()` after save/delete),
// so -- unlike `tests/div-012.test.ts`/`tests/div-013.test.ts`'s plain
// `renderToStaticMarkup` (no router calls existed in this component before
// this task) -- a bare render now throws "invariant expected app router to
// be mounted". Mirrors `tests/wlt-001.test.ts`'s identical
// `AppRouterContext.Provider` stub wrapping for `portfolio-shell.tsx`
// (also a `useRouter()` consumer).
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

function renderMultiYear(props: Record<string, unknown>) {
  return renderComponent(
    "IncomeMultiYear",
    "../app/components/income-multi-year.tsx",
    props,
  );
}

async function readComponentSource(): Promise<string> {
  return readFile(
    new URL("../app/components/income-multi-year.tsx", import.meta.url),
    "utf8",
  );
}

const freshMountProps = {
  portfolioId: "portfolio-a",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
  baseCurrencyCode: "AUD",
  pastFinancialYears: { ok: true, rows: [] },
  currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  multiYear: { ok: false, reason: "portfolio_value_unavailable" },
  multiYearBaselineInput: null,
  portfolioValueGrowthPercentDecimal: "10",
  portfolioDividendGrowthPercentDecimal: "5",
  financialYearStartMonth: 7,
  yearsBack: 0,
  yearsForward: 2,
  initialScenarios: [],
  scenariosUnavailable: false,
};

test("DIV-014: the 'Save scenario' section is a SEPARATE sibling <section> placed AFTER '.income-capital-events' and BEFORE the range-controls form", () => {
  const html = renderMultiYear(freshMountProps);
  assert.match(
    html,
    /<section class="income-capital-events"[\s\S]*?<\/section>\s*<section class="income-saved-scenarios"[\s\S]*?<\/section>\s*<form class="income-range-controls"/,
  );
});

test("DIV-014: on a fresh mount with no scenarios, the Save button is disabled (empty name) and 'No saved scenarios yet.' renders -- no table", () => {
  const html = renderMultiYear(freshMountProps);
  assert.match(html, /Save scenario<\/p>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Save scenario<\/button>/);
  assert.match(html, /No saved scenarios yet\./);
  assert.doesNotMatch(
    html,
    /class="income-fy-table income-saved-scenarios-rows"/,
  );
});

test("DIV-014: scenariosUnavailable renders an honest 'temporarily unavailable' disclosure -- takes precedence over rendering a table even when scenarios were also passed", () => {
  const html = renderMultiYear({
    ...freshMountProps,
    scenariosUnavailable: true,
  });
  assert.match(html, /Saved scenarios are temporarily unavailable\./);
  assert.doesNotMatch(html, /No saved scenarios yet\./);
  assert.doesNotMatch(
    html,
    /class="income-fy-table income-saved-scenarios-rows"/,
  );
});

const singleYieldScenario: IncomeScenarioRecord = {
  id: "scenario-single",
  userId: "user-a",
  portfolioId: "portfolio-a",
  name: "Single yield",
  rows: [
    {
      ...sampleInput,
      id: "r1",
      amountDecimal: "1000",
      yieldPercentDecimal: "3",
    },
    {
      ...sampleInput,
      id: "r2",
      amountDecimal: "-400",
      yieldPercentDecimal: "3",
    },
  ],
  reinvestDividends: false,
  valueGrowthPercentDecimal: "7",
  dividendGrowthPercentDecimal: null,
  createdAt: "2026-08-24T00:00:00Z",
  version: 1,
};

const mixedYieldScenario: IncomeScenarioRecord = {
  id: "scenario-mixed",
  userId: "user-a",
  portfolioId: "portfolio-a",
  name: "Mixed yield",
  rows: [
    {
      ...sampleInput,
      id: "r3",
      amountDecimal: "200",
      yieldPercentDecimal: "3",
    },
    {
      ...sampleInput,
      id: "r4",
      amountDecimal: "200",
      yieldPercentDecimal: "5",
    },
  ],
  reinvestDividends: true,
  valueGrowthPercentDecimal: null,
  dividendGrowthPercentDecimal: "4",
  createdAt: "2026-08-24T00:00:00Z",
  version: 2,
};

const noParcelScenario: IncomeScenarioRecord = {
  id: "scenario-empty",
  userId: "user-a",
  portfolioId: "portfolio-a",
  name: "No parcels",
  rows: [],
  reinvestDividends: false,
  valueGrowthPercentDecimal: null,
  dividendGrowthPercentDecimal: null,
  createdAt: "2026-08-24T00:00:00Z",
  version: 1,
};

test("DIV-014: the saved-scenario row summary derivation renders honestly -- net amount invested (negatives net against positives), single vs mixed vs absent yield, and 'Follows portfolio' for a null scenario-level growth axis", () => {
  const html = renderMultiYear({
    ...freshMountProps,
    initialScenarios: [
      singleYieldScenario,
      mixedYieldScenario,
      noParcelScenario,
    ],
  });

  // Single-yield scenario: net 1000 - 400 = 600, yield 3%, value-growth 7%,
  // dividend-growth follows portfolio (null).
  assert.match(html, />Single yield<\/button>/);
  assert.match(
    html,
    new RegExp(
      formatIncomeMoney("AUD", "AUD", "600", { signed: true }).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
    ),
  );
  assert.match(html, new RegExp(formatIncomePercent("3")));
  assert.match(html, new RegExp(formatIncomePercent("7")));

  // Mixed-yield scenario: net 400, weighted-average yield (owner ruling
  // 2026-08-24: never "Mixed" — 200@3% + 200@5% blends to exactly 4%),
  // capital growth follows portfolio (null), dividend growth 4%.
  assert.match(html, />Mixed yield<\/button>/);
  assert.match(
    html,
    new RegExp(
      formatIncomeMoney("AUD", "AUD", "400", { signed: true }).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
    ),
  );
  assert.doesNotMatch(html, />Mixed<\/td>/);
  // The blended 4% (weighted average) and the 4% dividend-growth cell both
  // render as the same formatted percent string.
  assert.match(html, new RegExp(formatIncomePercent("4")));

  // No-parcel scenario: net "0", yield em-dash, both growth axes follow
  // portfolio.
  assert.match(html, />No parcels<\/button>/);
  assert.match(html, />—<\/td>/);
  // Table-cell TEXT occurrences only (`>Follows portfolio<`) -- the
  // "Add/Remove Capital" draft inputs also carry a `placeholder="Follows
  // portfolio"` attribute (2 of them, unconditional on every render), which
  // a bare substring match would double-count.
  const followsCount = (html.match(/>Follows portfolio</g) ?? []).length;
  // single-yield (dividend axis null) + mixed (capital axis null) +
  // no-parcel (both axes null) = 1 + 1 + 2 = 4 occurrences.
  assert.equal(followsCount, 4);
});

test("DIV-014: handleSaveScenario/handleLoadScenario/handleDeleteScenario are wired through the pure helpers and the income-scenarios route -- structural pin, since this harness cannot simulate a click", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /rows: sortedCapitalRows\.map\(capitalEventRowToDomainInput\)/,
  );
  assert.match(
    source,
    /valueGrowthPercentDecimal: valueGrowthTouched\s*\n?\s*\?\s*resolvedValueGrowthPercentDecimal\s*\n?\s*: null/,
  );
  assert.match(source, /scenario\.rows\.map\(capitalEventInputToRow\)/);
  assert.match(
    source,
    /resolveLoadedScenarioGrowthField\(\s*\n?\s*scenario\.valueGrowthPercentDecimal/,
  );
  assert.match(
    source,
    /`\/api\/portfolios\/\$\{portfolioId\}\/income-scenarios`/g,
  );
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /router\.refresh\(\)/);
});

test("DIV-014: 'Save scenario' is disabled while a name is untouched (empty), consistent with the sole gate `handleSaveScenario` checks -- structural pin", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /disabled=\{scenarioName\.trim\(\)\.length === 0 \|\| scenarioSavePending\}/,
  );
});
