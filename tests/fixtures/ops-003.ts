/**
 * Shared OPS-003 export/purge fixtures, factored out of
 * `tests/ops-003b.test.ts` so other test files (e.g. `tests/db-005.test.ts`)
 * can import them without re-registering and re-running ops-003b's own
 * `node:test` suite as a side effect of the import (importing a `*.test.ts`
 * file executes every top-level `test(...)` call in it).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  ACCOUNT_PURGE_CONFIRMATION,
  createAccountLifecycleRepository,
  createSqliteSqlClient,
} from "../../db/repositories/index.ts";

export async function fixture(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const files = (await readdir(new URL("../../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files)
    db.exec(
      await readFile(new URL(`../../drizzle/${file}`, import.meta.url), "utf8"),
    );
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');
    INSERT INTO user_identities(id,user_id,issuer,subject,email_at_link,created_at,updated_at) VALUES
      ('ia','a','https://access.example','sa','a@example.test','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z'),
      ('ib','b','https://access.example','sb','b@example.test','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES('s','equity','AUD','Shared','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01'),
      ('psb','b','pb','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('ta','a','pa','psa','buy','posted','2026-08-01T00:00:00Z','2026-08-01','1','1','AUD','1','0','0','manual','a',1,'2026-08-01'),
      ('tb','b','pb','psb','buy','posted','2026-08-01T00:00:00Z','2026-08-01','2','1','AUD','2','0','0','manual','b',1,'2026-08-01');
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
    INSERT INTO security_provider_mappings(id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status,verified_by_user_id) VALUES('m','s','p','ASX','S','2026-01-01','verified','a');
    INSERT INTO price_observations(id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('oa','p','user','a','a','m','s','eod','2026-08-01T00:00:00Z','2026-08-01','Australia/Sydney','AUD','1','raw','observed','2026-08-01'),
      ('ob','p','user','b','b','m','s','eod','2026-08-01T00:00:00Z','2026-08-01','Australia/Sydney','AUD','2','raw','observed','2026-08-01');
    -- DB-005: shared dividend_events/split_events plus one row per owner in
    -- every new owner-scoped table, so the generic export/purge walk in the
    -- tests below (which iterate every classified table) actually exercise
    -- ownership scoping and deletion coverage for the new tables too.
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de','s','p','cash','paid','2026-07-01','AUD','1','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','2026-07-01');
    INSERT INTO split_events(id,security_id,provider_id,ex_date,effective_date,numerator_decimal,denominator_decimal,status,observed_at,ingested_at,created_at) VALUES
      ('se','s','p','2026-06-01','2026-06-02','2','1','effective','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z','2026-06-01');
    INSERT INTO dividend_receipts(id,user_id,portfolio_id,portfolio_security_id,dividend_event_id,shares_decimal,dividend_per_share_decimal,currency_code,payment_date,status,source,created_at,updated_at,version) VALUES
      ('dra','a','pa','psa','de','1','1','AUD','2026-07-15','actual','manual','2026-07-15','2026-07-15',1),
      ('drb','b','pb','psb','de','2','1','AUD','2026-07-15','actual','manual','2026-07-15','2026-07-15',1);
    INSERT INTO dividend_security_assumptions(id,user_id,portfolio_id,portfolio_security_id,created_at,updated_at,version) VALUES
      ('dsaa','a','pa','psa','2026-07-01','2026-07-01',1),
      ('dsab','b','pb','psb','2026-07-01','2026-07-01',1);
    INSERT INTO dividend_portfolio_assumptions(portfolio_id,user_id,created_at,updated_at,version) VALUES
      ('pa','a','2026-07-01','2026-07-01',1),
      ('pb','b','2026-07-01','2026-07-01',1);
    INSERT INTO dividend_fy_overrides(id,user_id,portfolio_id,financial_year_ending_year,grossed_amount_decimal,created_at,updated_at,version) VALUES
      ('dfoa','a','pa',2026,'1','2026-07-01','2026-07-01',1),
      ('dfob','b','pb',2026,'2','2026-07-01','2026-07-01',1);
    INSERT INTO dividend_event_overrides(id,user_id,portfolio_id,portfolio_security_id,dividend_event_id,exclude,created_at,updated_at,version) VALUES
      ('deoa','a','pa','psa','de',0,'2026-07-01','2026-07-01',1),
      ('deob','b','pb','psb','de',0,'2026-07-01','2026-07-01',1);
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,created_at,updated_at,version) VALUES
      ('dmra','a','pa','psa','2026-05-01','1','1','2026-05-01','2026-05-01',1),
      ('dmrb','b','pb','psb','2026-05-01','2','1','2026-05-01','2026-05-01',1);
    -- BRK-004: one owner row per owner in the new sync-cursor table, same
    -- purpose as the DB-005 rows above.
    INSERT INTO sharesight_sync_state(id,user_id,portfolio_id,sharesight_portfolio_id,enabled,last_synced_at,last_trade_watermark,created_at,updated_at,version) VALUES
      ('ssa','a','pa','101',1,NULL,NULL,'2026-07-01','2026-07-01',1),
      ('ssb','b','pb','202',1,NULL,NULL,'2026-07-01','2026-07-01',1);
    -- BRK-011: one owner row per owner in the new franking-override table,
    -- same purpose as the BRK-004 rows above -- referencing the existing
    -- dmra/dmrb dividend_manual_records rows (the repository layer's own
    -- "must be an imported row" business rule is not a DB constraint, so a
    -- direct-SQL seed row against these per-share rows is a valid FK target
    -- for export/purge coverage purposes).
    INSERT INTO dividend_import_franking_overrides(id,user_id,portfolio_id,portfolio_security_id,dividend_manual_record_id,franking_total_decimal,created_at,updated_at,version) VALUES
      ('difoa','a','pa','psa','dmra','1','2026-07-01','2026-07-01',1),
      ('difob','b','pb','psb','dmrb','2','2026-07-01','2026-07-01',1);
  `);
  return db;
}

export async function completedExport(db: DatabaseSync, key = "delete-key") {
  const repo = createAccountLifecycleRepository(createSqliteSqlClient(db));
  const request = await repo.request({
    userId: "a",
    actorUserId: "a",
    requestType: "deletion",
    idempotencyKey: key,
    includeExport: true,
    requestId: "request-delete",
    now: "2026-08-01T00:00:00Z",
  });
  assert.ok(request.exportJobId);
  let job = await repo.getJob("a", request.exportJobId);
  for (let i = 0; i < 500 && job?.status !== "completed"; i += 1)
    job = await repo.processExportJob(
      "a",
      request.exportJobId,
      `export-${i}`,
      "2026-08-01T00:00:00Z",
    );
  assert.equal(job?.status, "completed");
  return { repo, request, job: job! };
}

export async function finishPurge(db: DatabaseSync, key = "delete-key") {
  const repo = createAccountLifecycleRepository(createSqliteSqlClient(db));
  let result = await repo.purgeAccount("a", {
    idempotencyKey: key,
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    requestId: "purge",
    now: "2026-08-03T00:00:00Z",
  });
  for (let i = 0; i < 500 && result.ok && result.status !== "purged"; i += 1)
    result = await repo.purgeAccount("a", {
      idempotencyKey: key,
      confirmation: ACCOUNT_PURGE_CONFIRMATION,
      requestId: "purge",
      now: "2026-08-03T00:00:00Z",
    });
  return result;
}
