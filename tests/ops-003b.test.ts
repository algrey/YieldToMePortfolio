/** OPS-003B — exact, bounded, resumable and verified account deletion. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Miniflare } from "miniflare";
import { rejectCrossSiteMutation } from "../app/mutation-request.ts";
import { createD1SqlClient } from "../db/d1-sql-client.ts";
import {
  ACCOUNT_PURGE_CONFIRMATION,
  ACCOUNT_PURGE_LIMITS,
  createAccountLifecycleRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";

async function fixture(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files)
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
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
  `);
  return db;
}

async function applyMigrationsToD1(database: D1Database): Promise<void> {
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(
      new URL(`../drizzle/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      const copied = statement.match(
        /\bINSERT INTO `__new_[A-Za-z0-9_]+`[\s\S]+ FROM `([A-Za-z0-9_]+)`;?\s*$/,
      )?.[1];
      if (copied) {
        const source = await database
          .prepare(`SELECT COUNT(*) AS count FROM "${copied}"`)
          .first<{ count: number }>();
        if (Number(source?.count ?? -1) !== 0)
          throw new Error(`non_empty_rebuild:${copied}`);
        continue;
      }
      await database.prepare(statement).run();
    }
  }
}

async function completedExport(db: DatabaseSync, key = "delete-key") {
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

async function finishPurge(db: DatabaseSync, key = "delete-key") {
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

test("requires exact deletion key, cooling-off, final typed confirmation, completed unexpired exact export", async () => {
  const db = await fixture();
  const { repo } = await completedExport(db);
  assert.equal(
    (
      await repo.purgeAccount("a", {
        idempotencyKey: "wrong",
        confirmation: ACCOUNT_PURGE_CONFIRMATION,
        now: "2026-08-03T00:00:00Z",
      })
    ).ok,
    false,
  );
  const unconfirmed = await repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok)
    assert.equal(unconfirmed.reason, "confirmation-required");
  const cooling = await repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-01T12:00:00Z",
  });
  assert.equal(cooling.ok, false);
  if (!cooling.ok) assert.equal(cooling.reason, "cooling-off");
});

test("a completed pre-OPS-003B manifest remains exact and purge-compatible after migration", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files.filter((name) => name <= "0024_zzzz.sql"))
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('a','active','a@example.invalid','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_identities(id,user_id,issuer,subject,email_at_link,created_at,updated_at) VALUES('ia','a','https://access.invalid','sa','a@example.invalid','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pa','a','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,type,status,trade_at,local_trade_date,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES('ta','a','pa','cash_deposit','posted','2026-08-01T00:00:00Z','2026-08-01','AUD','1','0','0','manual','a',1,'2026-08-01');
  `);
  const repo = createAccountLifecycleRepository(createSqliteSqlClient(db));
  const request = await repo.request({
    userId: "a",
    actorUserId: "a",
    requestType: "deletion",
    idempotencyKey: "delete-key",
    includeExport: true,
    requestId: "pre-ops003b",
    now: "2026-08-01T00:00:00Z",
  });
  let job = await repo.getJob("a", request.exportJobId!);
  for (let i = 0; i < 500 && job?.status !== "completed"; i += 1)
    job = await repo.processExportJob(
      "a",
      request.exportJobId!,
      `pre-ops003b-${i}`,
      "2026-08-01T00:00:00Z",
    );
  assert.equal(job?.status, "completed");
  const controls = db
    .prepare(
      "SELECT table_name FROM account_export_manifest WHERE export_job_id=? AND table_name IN ('account_purge_jobs','account_purge_audit_guards')",
    )
    .all(job.id);
  assert.equal(controls.length, 0);
  for (const file of files.filter((name) => name > "0024_zzzz.sql"))
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  const result = await finishPurge(db);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "purged");
});

test("manifest/source mismatch fails closed before any deletion", async () => {
  const db = await fixture();
  const { repo } = await completedExport(db);
  db.exec("UPDATE transactions SET gross_amount_decimal='99' WHERE id='ta'");
  let result = await repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  });
  for (let i = 0; i < 300 && result.ok; i += 1)
    result = await repo.purgeAccount("a", {
      idempotencyKey: "delete-key",
      confirmation: ACCOUNT_PURGE_CONFIRMATION,
      now: "2026-08-03T00:00:00Z",
    });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "terminal-failure");
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id='a'").get()
      ?.n,
    1,
  );
});

test("purge binds the deletion request export, never a newer independent export, and rejects expiry", async () => {
  const db = await fixture();
  const { repo, job } = await completedExport(db);
  const independent = await repo.request({
    userId: "a",
    actorUserId: "a",
    requestType: "export",
    idempotencyKey: "later-export",
    includeExport: true,
    requestId: "later",
    now: "2026-08-02T00:00:00Z",
  });
  assert.ok(independent.exportJobId);
  let later = await repo.getJob("a", independent.exportJobId);
  for (let i = 0; i < 500 && later?.status !== "completed"; i += 1)
    later = await repo.processExportJob(
      "a",
      independent.exportJobId,
      `later-${i}`,
      "2026-08-02T00:00:00Z",
    );
  const started = await repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.manifestDigest, job.manifestDigest);

  const expiredDb = await fixture();
  const expired = await completedExport(expiredDb);
  expiredDb
    .prepare("UPDATE account_export_jobs SET expires_at=? WHERE id=?")
    .run("2026-08-02T00:00:00Z", expired.job.id);
  const rejected = await expired.repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "export-expired");
});

test("concurrent retries use one CAS checkpoint and deletion batches never exceed the row bound", async () => {
  const db = await fixture();
  for (let i = 0; i < 105; i += 1)
    db.prepare(
      "INSERT INTO audit_events(id,actor_user_id,target_owner_user_id,action,target_type,request_id,result,occurred_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      `bulk-${i}`,
      "a",
      "a",
      "bulk.test",
      "user",
      `bulk-${i}`,
      "success",
      "2026-08-01T00:00:00Z",
    );
  const { repo } = await completedExport(db);
  const options = {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  } as const;
  await repo.purgeAccount("a", options);
  const before = Number(
    db
      .prepare("SELECT version FROM account_purge_jobs WHERE owner_user_id='a'")
      .get()?.version,
  );
  const concurrent = await Promise.all([
    repo.purgeAccount("a", options),
    createAccountLifecycleRepository(createSqliteSqlClient(db)).purgeAccount(
      "a",
      options,
    ),
  ]);
  assert.ok(concurrent.every((entry) => entry.ok));
  const after = Number(
    db
      .prepare("SELECT version FROM account_purge_jobs WHERE owner_user_id='a'")
      .get()?.version,
  );
  assert.ok(after >= before + 1 && after <= before + 2);

  let previousAuditDeletes = 0;
  for (let i = 0; i < 600; i += 1) {
    const step = await repo.purgeAccount("a", options);
    assert.equal(step.ok, true);
    if (!step.ok) break;
    const auditDeletes = step.purgedTableCounts.audit_events ?? 0;
    assert.ok(
      auditDeletes - previousAuditDeletes <=
        ACCOUNT_PURGE_LIMITS.maxRowsPerStep,
    );
    previousAuditDeletes = auditDeletes;
    if (step.status === "purged") break;
  }
  assert.ok(previousAuditDeletes >= 105);
});

test("active purge lock closes the validation window for owner and provider source mutations", async () => {
  const db = await fixture();
  db.exec(
    "INSERT INTO user_settings(user_id,home_currency_code,timezone,created_at,updated_at) VALUES('a','AUD','Australia/Sydney','2026-08-01','2026-08-01')",
  );
  const { repo } = await completedExport(db);
  const started = await repo.purgeAccount("a", {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(started.ok, true);
  assert.throws(
    () =>
      db.exec("UPDATE transactions SET gross_amount_decimal='9' WHERE id='ta'"),
    /account_purge_source_locked/,
  );
  assert.throws(
    () => db.exec("UPDATE user_settings SET user_id='b' WHERE user_id='a'"),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec("UPDATE price_observations SET scope_user_id='b' WHERE id='oa'"),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec("UPDATE price_observations SET scope_user_id='a' WHERE id='ob'"),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE security_provider_mappings SET verified_by_user_id='b' WHERE id='m'",
      ),
    /account_purge_source_locked/,
  );
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO audit_events(id,actor_user_id,target_owner_user_id,action,target_type,request_id,result,occurred_at) VALUES('late-a','a','a','late','user','late','success','2026-08-03')",
      ),
    /account_purge_source_locked/,
  );
  db.exec("UPDATE transactions SET gross_amount_decimal='3' WHERE id='tb'");
  assert.equal(
    db
      .prepare("SELECT gross_amount_decimal FROM transactions WHERE id='tb'")
      .get()?.gross_amount_decimal,
    "3",
  );
  const aJob = db
    .prepare(
      "SELECT id,version FROM account_purge_jobs WHERE owner_user_id='a'",
    )
    .get() as { id: string; version: number } | undefined;
  assert.ok(aJob);
  db.exec(
    "INSERT INTO account_purge_jobs(id,owner_user_id,deletion_request_id,deletion_key_digest,export_job_id,manifest_digest,status,phase,eligible_at,confirmed_at,created_at,updated_at) VALUES('b-job','b','b-request','b-key','b-export','b-manifest','running','validate_source','2026-08-01','2026-08-01','2026-08-01','2026-08-01')",
  );
  db.prepare(
    "INSERT INTO account_purge_audit_guards(owner_user_id,purge_job_id,expected_version,valid) VALUES(?,?,?,1)",
  ).run("a", aJob.id, aJob.version);
  assert.throws(
    () => db.exec("UPDATE user_settings SET user_id='b' WHERE user_id='a'"),
    /account_purge_source_locked/,
    "an exact A guard must not authorize moving a row into separately locked B",
  );
});

test("export cleanup is bounded and retains only the exact deletion lifecycle intent", async () => {
  const db = await fixture();
  const repo = createAccountLifecycleRepository(createSqliteSqlClient(db));
  await repo.request({
    userId: "a",
    actorUserId: "a",
    requestType: "disable",
    idempotencyKey: "old-disable",
    requestId: "old-disable",
    now: "2026-07-31T00:00:00Z",
  });
  const unrelated = await repo.request({
    userId: "a",
    actorUserId: "a",
    requestType: "export",
    idempotencyKey: "old-export",
    requestId: "old-export",
    now: "2026-07-31T01:00:00Z",
  });
  assert.ok(unrelated.exportJobId);
  const insertChunk = db.prepare(
    "INSERT INTO account_export_chunks(id,export_job_id,user_id,table_name,chunk_index,payload_json,row_count,digest,expires_at,created_at) VALUES(?,?,?,?,?,'{}',1,'digest','2026-09-01','2026-07-31')",
  );
  for (let i = 0; i < 205; i += 1)
    insertChunk.run(
      `old-chunk-${i}`,
      unrelated.exportJobId,
      "a",
      "synthetic",
      i,
    );
  await completedExport(db);
  const options = {
    idempotencyKey: "delete-key",
    confirmation: ACCOUNT_PURGE_CONFIRMATION,
    now: "2026-08-03T00:00:00Z",
  } as const;
  let previous = 0;
  let completed = false;
  for (let i = 0; i < 1_000; i += 1) {
    const step = await repo.purgeAccount("a", options);
    assert.equal(step.ok, true);
    if (!step.ok) break;
    const deleted = step.purgedTableCounts.account_export_chunks ?? 0;
    assert.ok(deleted - previous <= ACCOUNT_PURGE_LIMITS.maxRowsPerStep);
    previous = deleted;
    if (step.status === "purged") {
      completed = true;
      break;
    }
  }
  assert.equal(completed, true);
  assert.ok(previous >= 205);
  const retained = db
    .prepare(
      "SELECT request_type,idempotency_key FROM account_lifecycle_requests WHERE user_id='a'",
    )
    .all();
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.request_type, "deletion");
  assert.equal(retained[0]?.idempotency_key, "delete-key");
});

test("bounded checkpoints resume, verify every target, retain minimal proof, and repeat safely", async () => {
  const db = await fixture();
  const { job } = await completedExport(db);
  assert.equal(ACCOUNT_PURGE_LIMITS.maxRowsPerStep, 100);
  const result = await finishPurge(db);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "purged");
  assert.equal(result.manifestDigest, job.manifestDigest);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id='a'").get()
      ?.n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM price_observations WHERE scope_user_id='a'",
      )
      .get()?.n,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM account_export_jobs WHERE user_id='a'")
      .get()?.n,
    0,
  );
  assert.equal(
    db.prepare("SELECT status FROM users WHERE id='a'").get()?.status,
    "purged",
  );
  const identity = db
    .prepare(
      "SELECT email_at_link,last_authenticated_at,status FROM user_identities WHERE user_id='a'",
    )
    .get();
  assert.equal(identity?.email_at_link, null);
  assert.equal(identity?.last_authenticated_at, null);
  assert.equal(identity?.status, "revoked");
  const proof = db
    .prepare(
      "SELECT status,manifest_digest,completed_at FROM account_purge_jobs WHERE owner_user_id='a'",
    )
    .get();
  assert.equal(proof?.status, "completed");
  assert.equal(proof?.manifest_digest, job.manifestDigest);
  assert.ok(proof?.completed_at);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM audit_events WHERE action='account.purge'",
      )
      .get()?.n,
    1,
  );
  const repeated = await finishPurge(db);
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.status, "purged");
});

test("another owner and shared provider mapping remain byte-for-byte unchanged", async () => {
  const db = await fixture();
  db.exec(
    "INSERT INTO audit_events(id,actor_user_id,target_owner_user_id,action,target_type,request_id,result,metadata_json,occurred_at) VALUES('cross-a-b','a','b','support.action','user','cross-request','success','{\"owner\":\"b\"}','2026-08-01T00:00:00Z')",
  );
  const before = {
    user: db.prepare("SELECT * FROM users WHERE id='b'").get(),
    identity: db
      .prepare("SELECT * FROM user_identities WHERE user_id='b'")
      .get(),
    portfolio: db.prepare("SELECT * FROM portfolios WHERE user_id='b'").get(),
    transaction: db
      .prepare("SELECT * FROM transactions WHERE user_id='b'")
      .get(),
    observation: db
      .prepare("SELECT * FROM price_observations WHERE scope_user_id='b'")
      .get(),
    mapping: db
      .prepare("SELECT * FROM security_provider_mappings WHERE id='m'")
      .get(),
    crossAudit: db
      .prepare("SELECT * FROM audit_events WHERE id='cross-a-b'")
      .get(),
  };
  await completedExport(db);
  const result = await finishPurge(db);
  assert.equal(result.ok, true);
  assert.deepEqual(
    db.prepare("SELECT * FROM users WHERE id='b'").get(),
    before.user,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM user_identities WHERE user_id='b'").get(),
    before.identity,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM portfolios WHERE user_id='b'").get(),
    before.portfolio,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM transactions WHERE user_id='b'").get(),
    before.transaction,
  );
  assert.deepEqual(
    db
      .prepare("SELECT * FROM price_observations WHERE scope_user_id='b'")
      .get(),
    before.observation,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM security_provider_mappings WHERE id='m'").get(),
    before.mapping,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM audit_events WHERE id='cross-a-b'").get(),
    before.crossAudit,
  );
});

test("migration keeps audit append-only unless a valid purge checkpoint is present", async () => {
  const db = await fixture();
  db.exec(
    "INSERT INTO audit_events(id,actor_user_id,target_owner_user_id,action,target_type,request_id,result,occurred_at) VALUES('audit','a','a','test','user','r','success','2026-08-01')",
  );
  assert.throws(
    () => db.exec("DELETE FROM audit_events WHERE id='audit'"),
    /audit_events_are_append_only/,
  );
  assert.throws(() =>
    db.exec(
      "INSERT INTO account_purge_audit_guards(owner_user_id,purge_job_id,expected_version,valid) VALUES('a','bad',1,0)",
    ),
  );
  db.exec(
    "INSERT INTO account_purge_audit_guards(owner_user_id,purge_job_id,expected_version,valid) VALUES('a','nonexistent',999,1)",
  );
  assert.throws(
    () => db.exec("DELETE FROM audit_events WHERE id='audit'"),
    /audit_events_are_append_only/,
  );
  db.exec("DELETE FROM account_purge_audit_guards WHERE owner_user_id='a'");
  db.exec(
    "INSERT INTO account_purge_jobs(id,owner_user_id,deletion_request_id,deletion_key_digest,export_job_id,manifest_digest,status,phase,version,eligible_at,confirmed_at,created_at,updated_at) VALUES('real-job','a','request','key-digest','export','manifest','running','purge',5,'2026-08-01','2026-08-01','2026-08-01','2026-08-01')",
  );
  db.exec(
    "INSERT INTO account_purge_audit_guards(owner_user_id,purge_job_id,expected_version,valid) VALUES('a','real-job',4,1)",
  );
  assert.throws(
    () => db.exec("DELETE FROM audit_events WHERE id='audit'"),
    /audit_events_are_append_only/,
  );
});

test("migration chain is fail-closed at the 0027 intermediate checkpoint", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql") && name <= "0027_zzzz.sql")
    .sort();
  for (const file of files)
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  db.exec(
    "INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('a','deletion_pending','a@example.invalid','Australia/Sydney','2026-08-01','2026-08-01')",
  );
  db.exec(
    "INSERT INTO audit_events(id,actor_user_id,target_owner_user_id,action,target_type,request_id,result,occurred_at) VALUES('audit-27','a','a','test','user','r','success','2026-08-01')",
  );
  db.exec(
    "INSERT INTO account_purge_audit_guards(owner_user_id,purge_job_id,expected_version,valid) VALUES('a','nonexistent',999,1)",
  );
  assert.throws(
    () => db.exec("DELETE FROM audit_events WHERE id='audit-27'"),
    /audit_events_are_append_only/,
  );
});

test("lifecycle route applies CSRF before auth, bounded body, and no-store", async () => {
  const crossSite = rejectCrossSiteMutation(
    new Request("https://app.example/api/account/lifecycle", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "purge",
        idempotencyKey: "delete-key",
        confirmation: ACCOUNT_PURGE_CONFIRMATION,
      }),
    }),
  );
  assert.equal(crossSite?.status, 403);
  assert.equal(crossSite?.headers.get("cache-control"), "private, no-store");
  const route = await readFile(
    new URL("../app/api/account/lifecycle/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    route.indexOf("rejectCrossSiteMutation(request)") <
      route.indexOf("readBoundedJson(request)"),
  );
  assert.match(route, /bytes > 4096/);
  assert.match(route, /private, no-store/);
});

test("deletion UI contains cooling-off, recovery disclosure, and deliberate typed confirmation", async () => {
  const source = await readFile(
    new URL(
      "../app/components/account-lifecycle-recovery.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /24-hour cooling-off/);
  assert.match(source, /not used to selectively restore a purged account/);
  assert.match(source, /PERMANENTLY DELETE MY ACCOUNT/);
  assert.match(source, /Permanently delete account/);
});

test("isolated loopback D1 deletion drill completes and preserves the other owner", async (context) => {
  if (process.env.OPS003B_D1_DRILL !== "1") {
    context.skip("set OPS003B_D1_DRILL=1 for the isolated loopback drill");
    return;
  }
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "ops-003b-synthetic-drill" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await applyMigrationsToD1(d1);
    const client = createD1SqlClient(d1);
    for (const sql of [
      "INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2)",
      "INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('a','active','a@example.invalid','Australia/Sydney','2026-08-01','2026-08-01'),('b','active','b@example.invalid','Australia/Sydney','2026-08-01','2026-08-01')",
      "INSERT INTO user_identities(id,user_id,issuer,subject,email_at_link,created_at,updated_at) VALUES('ia','a','https://access.invalid','sa','a@example.invalid','2026-08-01','2026-08-01')",
      "INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pa','a','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),('pb','b','B','B','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01')",
      "INSERT INTO transactions(id,user_id,portfolio_id,type,status,trade_at,local_trade_date,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES('ta','a','pa','cash_deposit','posted','2026-08-01T00:00:00Z','2026-08-01','AUD','1','0','0','manual','a',1,'2026-08-01'),('tb','b','pb','cash_deposit','posted','2026-08-01T00:00:00Z','2026-08-01','AUD','2','0','0','manual','b',1,'2026-08-01')",
    ])
      await client.run(sql);
    const repo = createAccountLifecycleRepository(client);
    const request = await repo.request({
      userId: "a",
      actorUserId: "a",
      requestType: "deletion",
      idempotencyKey: "drill-delete",
      includeExport: true,
      requestId: "drill-request",
      now: "2026-08-01T00:00:00Z",
    });
    let exportJob = await repo.getJob("a", request.exportJobId!);
    for (let i = 0; i < 500 && exportJob?.status !== "completed"; i += 1)
      exportJob = await repo.processExportJob(
        "a",
        request.exportJobId!,
        `drill-export-${i}`,
        "2026-08-01T00:00:00Z",
      );
    let purge = await repo.purgeAccount("a", {
      idempotencyKey: "drill-delete",
      confirmation: ACCOUNT_PURGE_CONFIRMATION,
      now: "2026-08-03T00:00:00Z",
    });
    for (let i = 0; i < 500 && purge.ok && purge.status !== "purged"; i += 1)
      purge = await repo.purgeAccount("a", {
        idempotencyKey: "drill-delete",
        confirmation: ACCOUNT_PURGE_CONFIRMATION,
        now: "2026-08-03T00:00:00Z",
      });
    assert.equal(purge.ok, true);
    if (purge.ok) assert.equal(purge.status, "purged");
    assert.equal(
      (
        await client.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM transactions WHERE user_id='a'",
        )
      )?.count,
      0,
    );
    assert.equal(
      (
        await client.get<{ gross_amount_decimal: string }>(
          "SELECT gross_amount_decimal FROM transactions WHERE id='tb'",
        )
      )?.gross_amount_decimal,
      "2",
    );
  } finally {
    await miniflare.dispose();
  }
});
