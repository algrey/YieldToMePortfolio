PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_calculation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`range_from` text NOT NULL,
	`range_to` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`reason` text NOT NULL,
	`invalidation_source` text,
	`pipeline` text DEFAULT 'projection' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`ledger_high_water_start` text NOT NULL,
	`ledger_high_water_end` text,
	`market_data_cutoff` text,
	`calendar_evidence_json` text,
	`processed_snapshot_count` integer DEFAULT 0 NOT NULL,
	`processed_holding_count` integer DEFAULT 0 NOT NULL,
	`processed_ledger_count` integer DEFAULT 0 NOT NULL,
	`projection_cursor_security_id` text,
	`projection_active_security_id` text,
	`projection_output_offset` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`failure_category` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "calculation_runs_status_check" CHECK("__new_calculation_runs"."status" IN ('queued', 'running', 'completed', 'failed', 'abandoned')),
	CONSTRAINT "calculation_runs_pipeline_check" CHECK("__new_calculation_runs"."pipeline" IN ('projection', 'snapshot')),
	CONSTRAINT "calculation_runs_range_check" CHECK("__new_calculation_runs"."range_to" >= "__new_calculation_runs"."range_from"),
	CONSTRAINT "calculation_runs_attempt_check" CHECK("__new_calculation_runs"."attempt" >= 0),
	CONSTRAINT "calculation_runs_snapshot_count_check" CHECK("__new_calculation_runs"."processed_snapshot_count" >= 0),
	CONSTRAINT "calculation_runs_holding_count_check" CHECK("__new_calculation_runs"."processed_holding_count" >= 0),
	CONSTRAINT "calculation_runs_ledger_count_check" CHECK("__new_calculation_runs"."processed_ledger_count" >= 0),
	CONSTRAINT "calculation_runs_projection_output_offset_check" CHECK("__new_calculation_runs"."projection_output_offset" >= 0)
);
--> statement-breakpoint
-- CALC-004 hand-edit disclosure (standing convention, see MKT-007's 0037):
-- drizzle-kit's generated copy-statement below selected the NEW `pipeline`
-- column BY NAME from the OLD `calculation_runs` table, which does not have
-- it yet (a drizzle-kit generation defect for this ADD-COLUMN-with-DEFAULT
-- recreate-table shape) -- verified this fails with "no such column:
-- pipeline" against the pre-migration table. Hand-replaced with the
-- column's own DEFAULT literal ('projection') so every pre-existing row
-- backfills to the correct, pre-CALC-004-behavior pipeline identity.
INSERT INTO `__new_calculation_runs`("id", "user_id", "portfolio_id", "range_from", "range_to", "calculation_version", "reason", "invalidation_source", "pipeline", "status", "attempt", "lease_owner", "lease_expires_at", "ledger_high_water_start", "ledger_high_water_end", "market_data_cutoff", "calendar_evidence_json", "processed_snapshot_count", "processed_holding_count", "processed_ledger_count", "projection_cursor_security_id", "projection_active_security_id", "projection_output_offset", "idempotency_key", "started_at", "completed_at", "failure_category", "created_at", "updated_at") SELECT "id", "user_id", "portfolio_id", "range_from", "range_to", "calculation_version", "reason", "invalidation_source", 'projection', "status", "attempt", "lease_owner", "lease_expires_at", "ledger_high_water_start", "ledger_high_water_end", "market_data_cutoff", "calendar_evidence_json", "processed_snapshot_count", "processed_holding_count", "processed_ledger_count", "projection_cursor_security_id", "projection_active_security_id", "projection_output_offset", "idempotency_key", "started_at", "completed_at", "failure_category", "created_at", "updated_at" FROM `calculation_runs`;--> statement-breakpoint
DROP TABLE `calculation_runs`;--> statement-breakpoint
ALTER TABLE `__new_calculation_runs` RENAME TO `calculation_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `calculation_runs_id_user_portfolio_unique` ON `calculation_runs` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calculation_runs_idempotency_unique` ON `calculation_runs` (`user_id`,`portfolio_id`,`calculation_version`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `calculation_runs_lease_idx` ON `calculation_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `calculation_runs_portfolio_status_idx` ON `calculation_runs` (`user_id`,`portfolio_id`,`status`,`created_at`);--> statement-breakpoint
-- CALC-004 trigger-hazard fix: drizzle-kit's ADD-COLUMN-with-new-CHECK path
-- for SQLite recreates this table (CREATE __new_calculation_runs, copy,
-- DROP TABLE calculation_runs, RENAME) rather than an in-place ALTER TABLE
-- ADD COLUMN. Per the standing hand-edit disclosure convention (see
-- MKT-007's 0037 migration), this file is hand-amended after generation:
-- SQLite drops a table's triggers automatically when the table itself is
-- dropped, so the DROP TABLE above silently deleted the three
-- `account_purge_lock_calculation_runs_*` triggers from migration 0028
-- (the account-purge fail-closed lock that blocks writes to a user's
-- in-flight-purge data). These CREATE TRIGGER statements are byte-identical
-- to 0028's originals, reattached to the renamed table, so the purge lock
-- is never silently weakened by this schema change. Verified: `grep -c
-- CREATE TRIGGER` against the full migration chain's calculation_runs
-- triggers is unchanged before/after this migration (3).
CREATE TRIGGER `account_purge_lock_calculation_runs_insert`
BEFORE INSERT ON `calculation_runs`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_calculation_runs_update`
BEFORE UPDATE ON `calculation_runs`
WHEN (OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
))
OR (NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
))
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_calculation_runs_delete`
BEFORE DELETE ON `calculation_runs`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;