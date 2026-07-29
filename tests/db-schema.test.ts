import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { findValidityConflict } from "../db/security-master.ts";

async function loadMigrationSql(): Promise<string> {
  const migrationFiles = (
    await readdir(new URL("../drizzle", import.meta.url))
  ).filter((file) => file.endsWith(".sql"));

  assert.equal(
    migrationFiles.length > 0,
    true,
    "expected a generated migration",
  );

  const migrations = await Promise.all(
    migrationFiles
      .sort()
      .map((file) =>
        readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
      ),
  );
  return migrations.join("\n");
}

function createMigratedDatabase(sql: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(sql);
  return database;
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function indexNames(database: DatabaseSync, tableName: string): string[] {
  return database
    .prepare(`PRAGMA index_list('${tableName}')`)
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
}

function foreignKeys(database: DatabaseSync, tableName: string) {
  return database
    .prepare(`PRAGMA foreign_key_list('${tableName}')`)
    .all()
    .map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        id: Number(entry.id),
        seq: Number(entry.seq),
        table: String(entry.table),
        from: String(entry.from),
        to: String(entry.to),
        on_update: String(entry.on_update).toLowerCase(),
        on_delete: String(entry.on_delete).toLowerCase(),
        match: String(entry.match),
      };
    })
    .sort((left, right) => {
      const leftId = Number(left.id);
      const rightId = Number(right.id);
      if (leftId !== rightId) {
        return leftId - rightId;
      }

      return Number(left.seq) - Number(right.seq);
    });
}

test("generated migration applies cleanly with foreign keys enabled", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());

  const foreignKeysEnabled = database.prepare("PRAGMA foreign_keys;").get() as {
    foreign_keys: number;
  };
  assert.equal(foreignKeysEnabled.foreign_keys, 1);
  assert.deepEqual(tableNames(database), [
    "audit_events",
    "calculation_runs",
    "cash_accounts",
    "cash_ledger_entries",
    "currencies",
    "exchanges",
    "fx_rate_observations",
    "holding_daily_snapshots",
    "import_batches",
    "import_issues",
    "import_mapping_decisions",
    "import_rows",
    "manual_overrides",
    "market_data_providers",
    "portfolio_daily_snapshots",
    "portfolio_securities",
    "portfolio_settings",
    "portfolios",
    "price_observations",
    "securities",
    "security_identifiers",
    "security_provider_mappings",
    "transactions",
    "user_identities",
    "user_settings",
    "users",
  ]);
  assert.deepEqual(indexNames(database, "audit_events"), [
    "audit_events_owner_time_idx",
  ]);
  assert.deepEqual(indexNames(database, "calculation_runs"), [
    "calculation_runs_id_user_portfolio_unique",
    "calculation_runs_idempotency_unique",
    "calculation_runs_lease_idx",
    "calculation_runs_portfolio_status_idx",
  ]);
  assert.deepEqual(indexNames(database, "portfolio_daily_snapshots"), [
    "portfolio_snapshots_chart_idx",
    "portfolio_snapshots_id_user_portfolio_date_version_unique",
    "portfolio_snapshots_portfolio_date_version_unique",
  ]);
  assert.deepEqual(indexNames(database, "holding_daily_snapshots"), [
    "holding_snapshots_chart_idx",
    "holding_snapshots_id_user_portfolio_unique",
    "holding_snapshots_security_date_version_unique",
  ]);
  assert.deepEqual(indexNames(database, "portfolios"), [
    "portfolios_id_user_id_unique",
    "portfolios_owner_status_updated_at_idx",
    "portfolios_user_id_code_unique",
  ]);
  assert.deepEqual(indexNames(database, "cash_accounts"), [
    "cash_accounts_id_user_portfolio_unique",
    "cash_accounts_id_user_unique",
    "cash_accounts_portfolio_currency_unique",
  ]);
  assert.deepEqual(indexNames(database, "cash_ledger_entries"), [
    "cash_entries_balance_idx",
    "cash_entries_id_user_portfolio_unique",
    "cash_entries_transaction_type_unique",
  ]);
  assert.deepEqual(indexNames(database, "price_observations"), [
    "price_observations_provider_scope_mapping_unique",
    "price_observations_security_date_idx",
  ]);
  assert.deepEqual(indexNames(database, "fx_rate_observations"), [
    "fx_rate_observations_pair_date_idx",
    "fx_rate_observations_provider_scope_pair_unique",
  ]);
  assert.deepEqual(indexNames(database, "manual_overrides"), [
    "manual_overrides_active_idx",
    "manual_overrides_id_user_unique",
  ]);
  assert.deepEqual(indexNames(database, "import_batches"), [
    "import_batches_id_user_unique",
    "import_batches_owner_status_updated_at_idx",
    "import_batches_user_file_parser_unique",
  ]);
  assert.deepEqual(indexNames(database, "import_rows"), [
    "import_rows_batch_physical_row_unique",
    "import_rows_id_user_portfolio_unique",
    "import_rows_id_user_unique",
    "import_rows_review_idx",
    "import_rows_user_normalized_fingerprint_idx",
  ]);
  assert.deepEqual(indexNames(database, "import_issues"), [
    "import_issues_batch_row_idx",
    "import_issues_id_user_unique",
  ]);
  assert.deepEqual(indexNames(database, "user_identities"), [
    "user_identities_provider_issuer_subject_unique",
    "user_identities_user_status_idx",
  ]);
  assert.deepEqual(indexNames(database, "transactions"), [
    "transactions_id_user_portfolio_security_unique",
    "transactions_id_user_portfolio_unique",
    "transactions_id_user_unique",
    "transactions_one_reversal_unique",
    "transactions_one_supersession_unique",
    "transactions_owner_ledger_idx",
    "transactions_portfolio_source_reference_unique",
    "transactions_security_trade_idx",
  ]);

  assert.deepEqual(foreignKeys(database, "user_settings"), [
    {
      id: 0,
      seq: 0,
      table: "currencies",
      from: "home_currency_code",
      to: "code",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 0,
      table: "users",
      from: "user_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
  ]);
  assert.deepEqual(foreignKeys(database, "portfolio_settings"), [
    {
      id: 0,
      seq: 0,
      table: "portfolios",
      from: "portfolio_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 0,
      seq: 1,
      table: "portfolios",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
  ]);
  assert.deepEqual(foreignKeys(database, "import_batches"), [
    {
      id: 0,
      seq: 0,
      table: "import_batches",
      from: "supersedes_batch_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 0,
      seq: 1,
      table: "import_batches",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 0,
      table: "portfolios",
      from: "target_portfolio_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 1,
      table: "portfolios",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 2,
      seq: 0,
      table: "users",
      from: "user_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
  ]);
  assert.deepEqual(foreignKeys(database, "import_rows"), [
    {
      id: 0,
      seq: 0,
      table: "portfolio_securities",
      from: "target_portfolio_security_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 0,
      seq: 1,
      table: "portfolio_securities",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 0,
      seq: 2,
      table: "portfolio_securities",
      from: "target_portfolio_id",
      to: "portfolio_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 0,
      table: "portfolios",
      from: "target_portfolio_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 1,
      table: "portfolios",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 2,
      seq: 0,
      table: "import_batches",
      from: "batch_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 2,
      seq: 1,
      table: "import_batches",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
  ]);
  assert.deepEqual(foreignKeys(database, "import_issues"), [
    {
      id: 0,
      seq: 0,
      table: "users",
      from: "resolved_by_user_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 0,
      table: "import_rows",
      from: "row_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 1,
      seq: 1,
      table: "import_rows",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 2,
      seq: 0,
      table: "import_batches",
      from: "batch_id",
      to: "id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
    {
      id: 2,
      seq: 1,
      table: "import_batches",
      from: "user_id",
      to: "user_id",
      on_update: "no action",
      on_delete: "restrict",
      match: "NONE",
    },
  ]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check;").all(), []);
});

function seedSecurityMasterFixture(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1), ('USD', 840, 'US dollar', 2, 1);

    INSERT INTO users (
      id, status, display_name, primary_email, locale, timezone,
      terms_accepted_at, last_seen_at, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'active', 'Alice', 'alice@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'active', 'Bob', 'bob@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone, accounting_method,
      history_complete_from, status, created_at, updated_at, version
    )
    VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice Portfolio', 'AUD', 'Australia/Sydney', 'fifo', NULL, 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('portfolio-b', 'user-b', 'B', 'Bob Portfolio', 'USD', 'Australia/Sydney', 'fifo', NULL, 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO exchanges (
      id, mic, name, country_code, timezone, default_currency_code, calendar_code, is_active
    ) VALUES ('asx', 'XASX', 'Australian Securities Exchange', 'AU', 'Australia/Sydney', 'AUD', 'ASX', 1);

    INSERT INTO market_data_providers (
      id, code, name, status, capabilities_json, rate_limit_json,
      technically_reviewed_at, operator_notes_reference
    ) VALUES ('provider-yahoo', 'yahoo_compatible', 'Yahoo-compatible', 'disabled', '{}', '{}', NULL, NULL);

    INSERT INTO securities (
      id, asset_type, exchange_id, primary_currency_code, canonical_name, isin,
      status, first_trade_date, last_trade_date, created_at, updated_at
    ) VALUES ('security-bhp', 'equity', 'asx', 'AUD', 'BHP Group Limited', 'AU000000BHP4', 'active', '2001-01-01', NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z');
  `);
}

test("security master keeps unresolved candidates private and enforces portfolio ownership", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedSecurityMasterFixture(database);

  database.exec(`
    INSERT INTO portfolio_securities (
      id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
      source_currency_code, source_name, display_symbol, display_name, status,
      first_relevant_date, last_relevant_date, created_at, updated_at
    ) VALUES (
      'candidate-a', 'user-a', 'portfolio-a', NULL, 'BHP', 'ASX', 'AUD',
      'Imported BHP', 'BHP', NULL, 'unresolved', '2020-01-01', NULL,
      '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z'
    );
  `);

  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM securities").get() as {
        count: number;
      }
    ).count,
    1,
  );
  assert.deepEqual(
    Object.assign(
      {},
      database
        .prepare(
          "SELECT security_id, status FROM portfolio_securities WHERE id = 'candidate-a'",
        )
        .get(),
    ),
    { security_id: null, status: "unresolved" },
  );

  assert.throws(() => {
    database.exec(`
      INSERT INTO portfolio_securities (
        id, user_id, portfolio_id, security_id, source_symbol, source_currency_code,
        status, created_at, updated_at
      ) VALUES ('candidate-cross-owner', 'user-b', 'portfolio-a', NULL, 'BHP', 'AUD', 'unresolved', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z');
    `);
  }, /FOREIGN KEY constraint failed/);

  assert.throws(() => {
    database.exec(`
      INSERT INTO portfolio_securities (
        id, user_id, portfolio_id, security_id, source_symbol, source_currency_code,
        status, created_at, updated_at
      ) VALUES ('candidate-invalid-resolution', 'user-a', 'portfolio-a', 'security-bhp', 'BHP', 'AUD', 'unresolved', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z');
    `);
  }, /CHECK constraint failed: portfolio_securities_resolution_check/);
});

test("mapping validity conflicts are deterministic and ticker history is retained", async () => {
  assert.deepEqual(
    findValidityConflict(
      { id: "new", validFrom: "2025-01-01", validTo: null },
      [{ id: "old", validFrom: "2020-01-01", validTo: "2024-12-31" }],
    ),
    null,
  );
  assert.deepEqual(
    findValidityConflict(
      { id: "new", validFrom: "2024-12-31", validTo: null },
      [{ id: "old", validFrom: "2020-01-01", validTo: "2024-12-31" }],
    ),
    { conflictingMappingId: "old", reason: "overlapping-validity" },
  );

  const database = createMigratedDatabase(await loadMigrationSql());
  seedSecurityMasterFixture(database);
  database.exec(`
    INSERT INTO security_identifiers (
      id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
    ) VALUES
      ('ticker-old', 'security-bhp', 'ticker', 'BHP', 'asx', '2001-01-01', '2025-06-30', 'reference'),
      ('ticker-new', 'security-bhp', 'ticker', 'BHP.AX', 'asx', '2025-07-01', NULL, 'reference');

    INSERT INTO security_provider_mappings (
      id, security_id, provider_id, provider_exchange, provider_symbol, valid_from,
      valid_to, status, verified_by_user_id, verified_at
    ) VALUES
      ('mapping-old', 'security-bhp', 'provider-yahoo', 'ASX', 'BHP.AX', '2001-01-01', '2025-06-30', 'verified', 'user-a', '2026-07-29T00:00:00Z'),
      ('mapping-new', 'security-bhp', 'provider-yahoo', 'ASX', 'BHP1.AX', '2025-07-01', NULL, 'verified', 'user-a', '2026-07-29T00:00:00Z');

    UPDATE securities SET status = 'delisted', last_trade_date = '2026-07-01' WHERE id = 'security-bhp';
  `);

  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM security_identifiers WHERE security_id = 'security-bhp'",
        )
        .get() as { count: number }
    ).count,
    2,
  );
  assert.equal(
    (
      database
        .prepare("SELECT status FROM securities WHERE id = 'security-bhp'")
        .get() as { status: string }
    ).status,
    "delisted",
  );
});

test("provider registry has ordinary technical configuration only", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  const columns = database
    .prepare("PRAGMA table_info('market_data_providers')")
    .all()
    .map((row) => String((row as { name: string }).name));

  assert.deepEqual(columns, [
    "id",
    "code",
    "name",
    "status",
    "capabilities_json",
    "rate_limit_json",
    "technically_reviewed_at",
    "operator_notes_reference",
  ]);
});

test("market observations preserve scope, provenance, direction, and idempotency", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedSecurityMasterFixture(database);
  database.exec(`
    INSERT INTO security_provider_mappings (
      id, security_id, provider_id, provider_exchange, provider_symbol,
      valid_from, valid_to, status, verified_by_user_id, verified_at
    ) VALUES (
      'mapping-bhp', 'security-bhp', 'provider-yahoo', 'ASX', 'BHP.AX',
      '2020-01-01', NULL, 'verified', 'user-a', '2026-07-29T00:00:00Z'
    );

    INSERT INTO price_observations (
      id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
      security_id, interval, observation_at, market_date, market_timezone,
      currency_code, close_decimal, previous_close_decimal, adjustment_state,
      quality, delayed_minutes, ingested_at, provider_revision_id, payload_sha256
    ) VALUES (
      'price-deployment', 'provider-yahoo', 'deployment', NULL, 'deployment',
      'mapping-bhp', 'security-bhp', 'eod', '2026-07-29T06:00:00Z',
      '2026-07-29', 'Australia/Sydney', 'AUD', '42.10', '41.90', 'raw',
      'observed', NULL, '2026-07-29T06:01:00Z', 'revision-1', 'hash-1'
    ), (
      'price-user', 'provider-yahoo', 'user', 'user-a', 'user-a', 'mapping-bhp',
      'security-bhp', 'delayed', '2026-07-29T06:05:00Z', '2026-07-29',
      'Australia/Sydney', 'AUD', '42.11', '42.00', 'raw', 'corrected', 15,
      '2026-07-29T06:06:00Z', 'revision-2', 'hash-2'
    );

    INSERT INTO fx_rate_observations (
      id, provider_id, access_scope, scope_user_id, scope_key,
      base_currency_code, quote_currency_code, rate_decimal, interval,
      observed_at, market_date, quality, ingested_at, payload_sha256
    ) VALUES (
      'fx-aud-usd', 'provider-yahoo', 'deployment', NULL, 'deployment',
      'AUD', 'USD', '0.6600', 'eod', '2026-07-29T06:00:00Z', '2026-07-29',
      'observed', '2026-07-29T06:01:00Z', 'fx-hash-1'
    ), (
      'fx-usd-aud', 'provider-yahoo', 'deployment', NULL, 'deployment',
      'USD', 'AUD', '1.5151', 'eod', '2026-07-29T06:00:00Z', '2026-07-29',
      'observed', '2026-07-29T06:01:00Z', 'fx-hash-2'
    );
  `);

  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM price_observations")
        .get() as { count: number }
    ).count,
    2,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT base_currency_code, quote_currency_code FROM fx_rate_observations WHERE id = 'fx-aud-usd'",
        )
        .get() as { base_currency_code: string; quote_currency_code: string }
    ).base_currency_code,
    "AUD",
  );

  assert.throws(() => {
    database.exec(`
      INSERT INTO price_observations (
        id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
        security_id, interval, observation_at, market_date, market_timezone,
        currency_code, close_decimal, adjustment_state, quality, ingested_at
      ) VALUES (
        'price-duplicate', 'provider-yahoo', 'deployment', NULL, 'deployment',
        'mapping-bhp', 'security-bhp', 'eod', '2026-07-29T06:00:00Z',
        '2026-07-29', 'Australia/Sydney', 'AUD', '42.10', 'raw', 'observed',
        '2026-07-29T06:02:00Z'
      );
    `);
  }, /UNIQUE constraint failed/);

  assert.throws(() => {
    database.exec(`
      INSERT INTO price_observations (
        id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
        security_id, interval, observation_at, market_date, market_timezone,
        currency_code, close_decimal, adjustment_state, quality, ingested_at
      ) VALUES (
        'price-invalid-scope', 'provider-yahoo', 'deployment', 'user-a', 'user-a',
        'mapping-bhp', 'security-bhp', 'eod', '2026-07-30T06:00:00Z',
        '2026-07-30', 'Australia/Sydney', 'AUD', '42.20', 'raw', 'observed',
        '2026-07-30T06:01:00Z'
      );
    `);
  }, /CHECK constraint failed: price_observations_scope_check/);

  assert.throws(() => {
    database.exec(`
      INSERT INTO fx_rate_observations (
        id, provider_id, access_scope, scope_user_id, scope_key,
        base_currency_code, quote_currency_code, rate_decimal, interval,
        observed_at, market_date, quality, ingested_at
      ) VALUES (
        'fx-identity', 'provider-yahoo', 'deployment', NULL, 'deployment',
        'AUD', 'AUD', '1', 'eod', '2026-07-29T06:00:00Z', '2026-07-29',
        'observed', '2026-07-29T06:01:00Z'
      );
    `);
  }, /CHECK constraint failed: fx_rate_observations_pair_check/);
});

test("manual overrides are owner-scoped, versionable, and interval constrained", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedSecurityMasterFixture(database);

  database.exec(`
    INSERT INTO manual_overrides (
      id, user_id, portfolio_id, security_id, type, target_key, effective_from,
      effective_to, value_json, reason, status, created_at
    ) VALUES (
      'override-1', 'user-a', 'portfolio-a', 'security-bhp', 'price',
      'security-bhp', '2026-07-29', NULL, '{"close":"42.10"}',
      'Corrected exchange close', 'active', '2026-07-29T07:00:00Z'
    );
    INSERT INTO manual_overrides (
      id, user_id, portfolio_id, security_id, type, target_key, effective_from,
      effective_to, value_json, reason, status, supersedes_override_id, created_at
    ) VALUES (
      'override-2', 'user-a', 'portfolio-a', 'security-bhp', 'price',
      'security-bhp', '2026-07-29', NULL, '{"close":"42.11"}',
      'New corrected close', 'active', 'override-1', '2026-07-29T08:00:00Z'
    );
    UPDATE manual_overrides SET status = 'superseded' WHERE id = 'override-1';
  `);

  assert.equal(
    (
      database
        .prepare(
          "SELECT supersedes_override_id, status FROM manual_overrides WHERE id = 'override-2'",
        )
        .get() as { supersedes_override_id: string; status: string }
    ).supersedes_override_id,
    "override-1",
  );

  assert.throws(() => {
    database.exec(`
      INSERT INTO manual_overrides (
        id, user_id, portfolio_id, type, target_key, effective_from,
        effective_to, value_json, reason, status, created_at
      ) VALUES (
        'override-invalid-interval', 'user-a', 'portfolio-a', 'fx_rate',
        'AUD/USD', '2026-07-30', '2026-07-29', '{}', 'Invalid interval',
        'active', '2026-07-29T09:00:00Z'
      );
    `);
  }, /CHECK constraint failed: manual_overrides_effective_interval_check/);

  assert.throws(() => {
    database.exec(`
      INSERT INTO manual_overrides (
        id, user_id, portfolio_id, type, target_key, effective_from,
        value_json, reason, status, created_at
      ) VALUES (
        'override-cross-owner', 'user-b', 'portfolio-a', 'price',
        'security-bhp', '2026-07-29', '{}', 'Cross-owner attempt', 'active',
        '2026-07-29T09:00:00Z'
      );
    `);
  }, /FOREIGN KEY constraint failed/);

  assert.throws(() => {
    database.exec(`
      INSERT INTO manual_overrides (
        id, user_id, portfolio_id, type, target_key, effective_from,
        value_json, reason, status, supersedes_override_id, created_at
      ) VALUES (
        'override-cross-user-supersession', 'user-b', 'portfolio-a', 'price',
        'security-bhp', '2026-07-29', '{}', 'Cross-user supersession', 'active',
        'override-1', '2026-07-29T10:00:00Z'
      );
    `);
  }, /FOREIGN KEY constraint failed/);
});

test("schema rejects duplicate identities, invalid enums, and cross-owner composite references", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());

  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1), ('USD', 840, 'US dollar', 2, 1);

    INSERT INTO users (
      id, status, display_name, primary_email, locale, timezone,
      terms_accepted_at, last_seen_at, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'active', 'Alice', 'alice@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'active', 'Bob', 'bob@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    )
    VALUES ('user-a', 'AUD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone, accounting_method,
      history_complete_from, status, created_at, updated_at, version
    )
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice Portfolio', 'AUD', 'Australia/Sydney', 'fifo', NULL, 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);

  assert.throws(() => {
    database.exec(`
        INSERT INTO user_identities (
          id, user_id, provider, issuer, subject, email_at_link,
          status, last_authenticated_at, created_at, updated_at, version
        )
        VALUES
          ('identity-a', 'user-a', 'cloudflare_access', 'https://example.cloudflareaccess.com', 'subject-a', 'alice@example.com', 'active', NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
          ('identity-b', 'user-b', 'cloudflare_access', 'https://example.cloudflareaccess.com', 'subject-a', 'bob@example.com', 'active', NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
      `);
  }, /UNIQUE constraint failed: user_identities\.provider, user_identities\.issuer, user_identities\.subject/);

  assert.throws(() => {
    database.exec(`
        INSERT INTO users (
          id, status, display_name, primary_email, locale, timezone,
          terms_accepted_at, last_seen_at, created_at, updated_at, version
        )
        VALUES
          ('user-c', 'unknown', 'Charlie', 'charlie@example.com', 'en-AU', 'Australia/Sydney', NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
      `);
  }, /CHECK constraint failed: users_status_check/);

  assert.throws(() => {
    database.exec(`
        INSERT INTO portfolio_settings (
          portfolio_id, user_id, quote_staleness_policy,
          created_at, updated_at, version
        )
        VALUES ('portfolio-a', 'user-b', 'eod_standard', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
      `);
  }, /FOREIGN KEY constraint failed/);
});
