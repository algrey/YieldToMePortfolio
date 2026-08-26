/**
 * DIV-016 part A -- editable dividend rows via supersession (never an
 * in-place rewrite), both per-share and BRK-005 totals mode, from the
 * holding's Dividends tab. See TASKS.md's "### DIV-016" entry.
 *
 * Fixture/context helpers duplicated from tests/ui-006b.test.ts, matching
 * this codebase's established per-test-file convention (no shared
 * migratedDatabase()/fixture() module).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import {
  createDividendEventOverrideRepository,
  createDividendManualRecordRepository,
} from "../db/repositories/dividends.ts";
import {
  saveDividendEntryWithContext,
  type DividendActionContext,
} from "../app/dividend-assumptions-actions.ts";
import { loadOwnedDividendHistory } from "../app/owned-dividend-history.ts";
import { deriveHistoryTrailingTwelveMonthDividend } from "../domain/dividends/forecast.ts";

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
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa1','buy','posted','2026-01-01T00:00:00Z','2026-01-01','100','5','AUD','500','0','0','manual','a',1,'2026-01-01');
  `);
  return db;
}

// Only the event-linked test (B2's regression pin) needs a real provider
// dividend event -- kept OUT of the base fixture() above so every other
// test in this file stays exactly what it was: a portfolio with no
// provider events at all, deriving rows purely from owner-typed manual
// records.
function seedDividendEvent(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de1','s1','p','cash','paid','2026-03-01','AUD','1','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z','2026-03-01');
  `);
}

function contextFor(
  client: ReturnType<typeof createSqliteSqlClient>,
  userId: string,
): DividendActionContext {
  return { client, userId, requestId: "req-1" };
}

// ---------------------------------------------------------------------------
// Supersession chain: editing twice leaves only the latest row counting;
// both ancestors are retained (never deleted) and excluded from evidence.
// ---------------------------------------------------------------------------

test("DIV-016A: editing a manual dividend record twice supersedes twice -- only the latest counts, both ancestors retained and excluded", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const repository = createDividendManualRecordRepository(client);

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

  const editedOnce = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "12",
    dividendPerShareDecimal: "1.1",
    frankingCreditPerShareDecimal: "0.3",
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
  });
  assert.equal(editedOnce.ok, true);
  if (!editedOnce.ok) return;
  assert.notEqual(editedOnce.id, created.id);

  const editedTwice = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "15",
    dividendPerShareDecimal: "1.2",
    frankingCreditPerShareDecimal: "0.4",
    dividendEventId: null,
    manualRecordId: editedOnce.id,
    expectedVersion: editedOnce.version,
  });
  assert.equal(editedTwice.ok, true);
  if (!editedTwice.ok) return;
  assert.notEqual(editedTwice.id, editedOnce.id);
  assert.notEqual(editedTwice.id, created.id);

  // Only the latest row is "counted" -- list() (the single choke point
  // every evidence/aggregation consumer reads through) returns exactly one
  // row for this security, and it is the newest correction.
  const list = await repository.list("a", "pa", "psa1");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, editedTwice.id);
  assert.equal(list[0]?.sharesDecimal, "15");

  // Both ancestors are RETAINED, UNMODIFIED, and excluded from list().
  const original = await repository.get("a", "pa", created.id);
  assert.equal(original?.sharesDecimal, "10");
  assert.equal(original?.dividendPerShareDecimal, "1");
  assert.equal(original?.supersededByRecordId, editedOnce.id);
  const middle = await repository.get("a", "pa", editedOnce.id);
  assert.equal(middle?.sharesDecimal, "12");
  assert.equal(middle?.dividendPerShareDecimal, "1.1");
  assert.equal(middle?.supersededByRecordId, editedTwice.id);
  const head = await repository.get("a", "pa", editedTwice.id);
  assert.equal(head?.sharesDecimal, "15");
  assert.equal(head?.supersededByRecordId, null);

  // The lineage is reconstructable end-to-end by walking the single
  // supersededByRecordId column, forward from the original.
  assert.equal(original?.supersededByRecordId, middle?.id);
  assert.equal(middle?.supersededByRecordId, head?.id);

  // Reversal/audit reconstruction: a "supersede" audit event was recorded
  // for each correction, each targeting the NEW row and recording which
  // original it superseded.
  const auditActions = db
    .prepare(
      "SELECT action, target_id, metadata_json FROM audit_events WHERE action='dividend.manual_record.supersede' ORDER BY occurred_at ASC",
    )
    .all() as { action: string; target_id: string; metadata_json: string }[];
  assert.equal(auditActions.length, 2);
  assert.equal(auditActions[0]?.target_id, editedOnce.id);
  assert.deepEqual(JSON.parse(auditActions[0]!.metadata_json), {
    supersedesRecordId: created.id,
  });
  assert.equal(auditActions[1]?.target_id, editedTwice.id);
  assert.deepEqual(JSON.parse(auditActions[1]!.metadata_json), {
    supersedesRecordId: editedOnce.id,
  });
});

// ---------------------------------------------------------------------------
// Add/edit both amount modes, including franking; evidence flows into the
// SAME forecast/lifetime-totals evidence forecast TTM and UI-046 rows read.
// ---------------------------------------------------------------------------

test("DIV-016A: a totals-mode (BRK-005 shape) manual entry is addable and editable through the owner-facing dialog action, franking included", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const repository = createDividendManualRecordRepository(client);

  const created = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    // B2 (review fix): sharesDecimal/dividendPerShareDecimal/
    // frankingCreditPerShareDecimal are STRICT (an omitted key is 400,
    // matching the pre-DIV-016/event-linked contract) -- the real dialog
    // always sends these explicitly as `null` in totals mode (never
    // omits them), so the test does the same.
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    amountMode: "totals",
    totalCashDecimal: "70",
    totalFrankingDecimal: "30",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const stored = await repository.get("a", "pa", created.id);
  assert.equal(stored?.sharesDecimal, null);
  assert.equal(stored?.dividendPerShareDecimal, null);
  assert.equal(stored?.totalCashDecimal, "70");
  assert.equal(stored?.totalFrankingDecimal, "30");

  // Editing a totals-mode row (still totals mode) supersedes exactly like
  // the per-share path -- a new row, the original retained and excluded.
  const edited = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    amountMode: "totals",
    totalCashDecimal: "90",
    totalFrankingDecimal: "40",
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
  });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.notEqual(edited.id, created.id);
  const editedStored = await repository.get("a", "pa", edited.id);
  assert.equal(editedStored?.totalCashDecimal, "90");
  assert.equal(editedStored?.totalFrankingDecimal, "40");
  const originalAfterEdit = await repository.get("a", "pa", created.id);
  assert.equal(originalAfterEdit?.totalCashDecimal, "70");
  assert.equal(originalAfterEdit?.supersededByRecordId, edited.id);

  // Evidence flows into forecast TTM and lifetime totals (the shared
  // aggregation UI-046 rows and the per-security tab both consume) --
  // counted exactly once, at the CORRECTED figure, never the superseded
  // original's figure and never both added together.
  const history = await loadOwnedDividendHistory(
    client,
    "a",
    "pa",
    new Date("2026-06-15T00:00:00Z"),
  );
  const security = history.securities.find(
    (row) => row.portfolioSecurityId === "psa1",
  );
  assert.ok(security, "security must be present in the derived history");
  assert.equal(security!.rows.length, 1);
  assert.equal(security!.rows[0]?.cashDecimal, "90");
  assert.equal(security!.rows[0]?.frankingTotalDecimal, "40");
  assert.equal(security!.lifetimeTotals.receivedCashDecimal, "90");
  assert.equal(security!.lifetimeTotals.receivedFrankingKnownDecimal, "40");
  // Forecast TTM (`domain/dividends/forecast.ts`'s history-TTM fallback,
  // the DIV-006/DIV-008 evidence leg `computeSecurityDividendForecast`
  // engages when no usable provider TTM exists -- exactly the surface
  // DIV-016's owner-confirmed "manually entered rows already contribute to
  // projection evidence" fact refers to) derives a per-share rate for this
  // totals-mode row from cash/shares-held-at-payment, and sees the
  // CORRECTED total -- 90 cash / 100 shares = 0.9/share -- never the
  // superseded original's 70/100 = 0.7.
  const ttm = deriveHistoryTrailingTwelveMonthDividend(
    security!.rows,
    security!.transactions,
    "AUD",
    "2026-06-15",
  );
  assert.equal(ttm.ok, true);
  if (ttm.ok) {
    assert.equal(ttm.ttmPerShareDecimal, "0.9");
    assert.equal(ttm.ttmFrankingPerShareDecimal, "0.4");
  }
});

test("DIV-016A: a per-share manual entry with franking is addable and editable, evidence counted exactly once after correction", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const created = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: "0.3",
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const edited = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "20",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: "0.3",
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
  });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;

  const history = await loadOwnedDividendHistory(
    client,
    "a",
    "pa",
    new Date("2026-06-15T00:00:00Z"),
  );
  const security = history.securities.find(
    (row) => row.portfolioSecurityId === "psa1",
  );
  assert.ok(security);
  assert.equal(security!.rows.length, 1);
  // 20 shares x $1 = $20 cash, never the original's $10 and never $30
  // (double-counted).
  assert.equal(security!.rows[0]?.cashDecimal, "20");
  assert.equal(security!.lifetimeTotals.receivedCashDecimal, "20");
});

// ---------------------------------------------------------------------------
// Idempotent double-submit (UI-009 mechanism extended to the correction
// path).
// ---------------------------------------------------------------------------

// B1 (BLOCKING review fix): the REAL dialog generates exactly ONE
// idempotency key per dialog OPEN (`dialogIdempotencyKey`) and sends it on
// EVERY submit in that session -- create, then any number of edits. A prior
// version of this test used distinct keys per edit (edit-key-1/edit-key-2),
// which never exercised the actual collision: storing the raw session key
// verbatim on a correction's successor row collided with
// `dividend_manual_records_security_idempotency_unique`
// (`portfolio_security_id`, `idempotency_key`) against the record's own
// CREATE (same key, same security), aborting the whole `supersede()` batch
// with an opaque 503 and silently losing the correction. This test drives
// ONE key through create -> edit -> second edit exactly like the dialog
// does, asserting both edits succeed, AND that a genuine double-submit of
// the SAME edit still dedupes.
test("DIV-016A: one dialog-session idempotency key driven through create -> edit -> second edit all succeed; a true double-submit of the same edit still dedupes", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const repository = createDividendManualRecordRepository(client);
  const sessionKey = "dialog-session-key-1";

  const created = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: null,
    expectedVersion: null,
    idempotencyKey: sessionKey,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // First edit in the SAME dialog session -- same raw key as the create
  // above. This is exactly the create-then-edit flow B1 broke: the
  // successor's stored key must be derived (lineage-scoped), never the raw
  // session key, or this INSERT collides with the create's own row.
  const firstEditInput = {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "12",
    dividendPerShareDecimal: "1.1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
    idempotencyKey: sessionKey,
  };
  const firstEdit = await saveDividendEntryWithContext(
    ctx,
    "pa",
    firstEditInput,
  );
  assert.equal(firstEdit.ok, true);
  if (!firstEdit.ok) return;
  assert.notEqual(firstEdit.id, created.id);

  // A true double-submit of THIS SAME edit (identical target id/version,
  // identical raw session key) must dedupe to the SAME successor, never
  // create a second row.
  const retryOfFirstEdit = await saveDividendEntryWithContext(
    ctx,
    "pa",
    firstEditInput,
  );
  assert.equal(retryOfFirstEdit.ok, true);
  if (!retryOfFirstEdit.ok) return;
  assert.equal(retryOfFirstEdit.id, firstEdit.id);
  assert.equal(retryOfFirstEdit.deduped, true);

  // A genuinely SECOND, distinct edit in the SAME dialog session (the
  // dialog reuses the identical raw key -- `dialogIdempotencyKey` never
  // changes within one open) must still succeed, targeting the current
  // head (`firstEdit.id`), and must never be treated as a retry of the
  // first edit even though the raw key is byte-identical.
  const secondEditInput = {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "13",
    dividendPerShareDecimal: "1.2",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: firstEdit.id,
    expectedVersion: firstEdit.version,
    idempotencyKey: sessionKey,
  };
  const secondEdit = await saveDividendEntryWithContext(
    ctx,
    "pa",
    secondEditInput,
  );
  assert.equal(secondEdit.ok, true);
  if (!secondEdit.ok) return;
  assert.notEqual(secondEdit.id, firstEdit.id);
  assert.equal(secondEdit.deduped, false);

  // A true double-submit of the SECOND edit (same raw key, same target id)
  // dedupes too -- never confused with the first edit's own dedupe entry.
  const retryOfSecondEdit = await saveDividendEntryWithContext(
    ctx,
    "pa",
    secondEditInput,
  );
  assert.equal(retryOfSecondEdit.ok, true);
  if (!retryOfSecondEdit.ok) return;
  assert.equal(retryOfSecondEdit.id, secondEdit.id);
  assert.equal(retryOfSecondEdit.deduped, true);

  const list = await repository.list("a", "pa", "psa1");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, secondEdit.id);
  assert.equal(list[0]?.sharesDecimal, "13");
});

// UI-009 disclosure parity (review follow-up 1): a deduped retry of a
// correction whose form was edited between the original attempt and the
// retry must disclose the divergence (storedDiffers/storedRecord), exactly
// like the CREATE path already does.
test("DIV-016A: a correction dedupe retry whose form changed since the original attempt discloses storedDiffers/storedRecord (UI-009 disclosure parity)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");
  const sessionKey = "dialog-session-key-2";

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

  const edit = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "12",
    dividendPerShareDecimal: "1.1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
    idempotencyKey: sessionKey,
  });
  assert.equal(edit.ok, true);
  if (!edit.ok) return;

  // The SAME edit request (same target id/version/key) but with a DIFFERENT
  // sharesDecimal -- as if the owner edited the form again after the first
  // save actually committed but before seeing a response (a client-visible
  // timeout), then a retry fired with the NEW value.
  const retryWithChangedForm = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "999",
    dividendPerShareDecimal: "1.1",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
    idempotencyKey: sessionKey,
  });
  assert.equal(retryWithChangedForm.ok, true);
  if (!retryWithChangedForm.ok) return;
  assert.equal(retryWithChangedForm.id, edit.id);
  assert.equal(retryWithChangedForm.deduped, true);
  assert.equal(retryWithChangedForm.storedDiffers, true);
  assert.equal(retryWithChangedForm.storedRecord?.sharesDecimal, "12");
});

// B2 (BLOCKING review fix): sharesDecimal/dividendPerShareDecimal/
// frankingCreditPerShareDecimal keep the ORIGINAL strict "an omitted key is
// malformed" contract on the EVENT-LINKED save path -- a prior version of
// this change loosened all three uniformly (to tolerate the new totals
// fields' omission), which let an event-linked save with an OMITTED
// sharesDecimal silently read as "no override for shares" and CLEAR the
// stored override's shares field via the repository's hasOwn tri-state,
// instead of failing closed with 400.
test("DIV-016A: an event-linked override save with an OMITTED sharesDecimal is rejected as malformed (400), never clears the stored override", async () => {
  const db = await fixture();
  seedDividendEvent(db);
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const created = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-01",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: "0.3",
    dividendEventId: "de1",
    manualRecordId: null,
    expectedVersion: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.target, "event_override");

  // Omit sharesDecimal entirely (not even `null`) -- must be 400, never
  // silently accepted as "leave shares unset" for an event-linked save.
  const omitted = {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-03-01",
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: "0.3",
    dividendEventId: "de1",
    manualRecordId: null,
    expectedVersion: created.version,
  };
  const rejected = await saveDividendEntryWithContext(ctx, "pa", omitted);
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.status, 400);

  const overrideRepository = createDividendEventOverrideRepository(client);
  const stillStored = await overrideRepository.get("a", "pa", "psa1", "de1");
  assert.equal(stillStored?.sharesDecimal, "10");
  assert.equal(stillStored?.version, created.version);
});

// ---------------------------------------------------------------------------
// Ownership: a client-supplied row id is verified owned before superseding.
// ---------------------------------------------------------------------------

test("DIV-016A: cross-user probe -- superseding another owner's manual dividend record id is rejected as not_found, and the target row is untouched", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ownerA = contextFor(client, "a");
  const ownerB = contextFor(client, "b");

  const created = await saveDividendEntryWithContext(ownerA, "pa", {
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

  // Owner "b" probes owner "a"'s row id under b's own portfolio ("pb") --
  // the repository's ownership check is `userId`/`portfolioId`-scoped
  // (never trusting the client-supplied row id alone), so this must read
  // as "not found", never leak/mutate owner "a"'s record.
  const probe = await saveDividendEntryWithContext(ownerB, "pb", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "999",
    dividendPerShareDecimal: "999",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
  });
  assert.equal(probe.ok, false);
  if (probe.ok) return;
  assert.equal(probe.status, 404);

  // Also probe under owner "b" with owner "a"'s OWN portfolio id ("pa") --
  // still denied, since the repository's context is authenticated as "b".
  const probeSamePortfolio = await saveDividendEntryWithContext(ownerB, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-05-01",
    sharesDecimal: "999",
    dividendPerShareDecimal: "999",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: created.id,
    expectedVersion: created.version,
  });
  assert.equal(probeSamePortfolio.ok, false);

  const repository = createDividendManualRecordRepository(client);
  const unchanged = await repository.get("a", "pa", created.id);
  assert.equal(unchanged?.sharesDecimal, "10");
  assert.equal(unchanged?.version, 1);
  assert.equal(unchanged?.supersededByRecordId, null);
});

// ---------------------------------------------------------------------------
// Reversal/audit reconstruction against the imported-row immutability guard.
// ---------------------------------------------------------------------------

test("DIV-016A: an imported (CSV-batch) manual record can never be superseded through the owner-facing edit path", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
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
  const ctx = contextFor(client, "a");
  const denied = await saveDividendEntryWithContext(ctx, "pa", {
    portfolioSecurityId: "psa1",
    paymentDate: "2026-04-01",
    sharesDecimal: "99",
    dividendPerShareDecimal: "9",
    frankingCreditPerShareDecimal: null,
    dividendEventId: null,
    manualRecordId: "imported-1",
    expectedVersion: 1,
  });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.status, 409);

  const repository = createDividendManualRecordRepository(client);
  const unchanged = await repository.get("a", "pa", "imported-1");
  assert.equal(unchanged?.sharesDecimal, "10");
  assert.equal(unchanged?.supersededByRecordId, null);
});
