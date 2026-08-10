PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_events_append_only_delete`;--> statement-breakpoint
CREATE TABLE `__new_account_purge_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`deletion_request_id` text NOT NULL,
	`deletion_key_digest` text NOT NULL,
	`export_job_id` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'validate_source' NOT NULL,
	`target_index` integer DEFAULT 0 NOT NULL,
	`row_cursor` integer DEFAULT 0 NOT NULL,
	`rolling_digest` text DEFAULT '0' NOT NULL,
	`rolling_count` integer DEFAULT 0 NOT NULL,
	`chunk_table_name` text DEFAULT '' NOT NULL,
	`chunk_index` integer DEFAULT -1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_counts_json` text DEFAULT '{}' NOT NULL,
	`failure_code` text,
	`eligible_at` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "account_purge_jobs_status_check" CHECK("__new_account_purge_jobs"."status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "account_purge_jobs_phase_check" CHECK("__new_account_purge_jobs"."phase" IN ('validate_source', 'validate_chunks', 'purge', 'verify', 'cleanup', 'complete')),
	CONSTRAINT "account_purge_jobs_cursor_check" CHECK("__new_account_purge_jobs"."target_index" >= 0 AND "__new_account_purge_jobs"."row_cursor" >= 0 AND "__new_account_purge_jobs"."rolling_count" >= 0 AND "__new_account_purge_jobs"."chunk_index" >= -1)
);
--> statement-breakpoint
INSERT INTO `__new_account_purge_jobs`("id", "owner_user_id", "deletion_request_id", "deletion_key_digest", "export_job_id", "manifest_digest", "status", "phase", "target_index", "row_cursor", "rolling_digest", "rolling_count", "chunk_table_name", "chunk_index", "version", "deleted_counts_json", "failure_code", "eligible_at", "confirmed_at", "completed_at", "created_at", "updated_at") SELECT "id", "owner_user_id", "deletion_request_id", "deletion_key_digest", "export_job_id", "manifest_digest", "status", "phase", "target_index", "row_cursor", "rolling_digest", "rolling_count", "chunk_table_name", "chunk_index", "version", "deleted_counts_json", "failure_code", "eligible_at", "confirmed_at", "completed_at", "created_at", "updated_at" FROM `account_purge_jobs`;--> statement-breakpoint
DROP TABLE `account_purge_jobs`;--> statement-breakpoint
ALTER TABLE `__new_account_purge_jobs` RENAME TO `account_purge_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `account_purge_jobs_deletion_request_unique` ON `account_purge_jobs` (`deletion_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_purge_jobs_owner_export_unique` ON `account_purge_jobs` (`owner_user_id`,`export_job_id`);--> statement-breakpoint
CREATE INDEX `account_purge_jobs_owner_status_idx` ON `account_purge_jobs` (`owner_user_id`,`status`,`updated_at`);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_events_append_only_delete`;
--> statement-breakpoint
CREATE TRIGGER `audit_events_append_only_delete`
BEFORE DELETE ON `audit_events`
WHEN NOT EXISTS (
 SELECT 1 FROM account_purge_jobs pj JOIN account_purge_audit_guards g
 ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
 WHERE pj.owner_user_id=OLD.target_owner_user_id AND pj.status IN ('queued','running') AND pj.phase IN ('purge','cleanup')
)
BEGIN SELECT RAISE(ABORT,'audit_events_are_append_only'); END;
--> statement-breakpoint
DROP TRIGGER `account_lifecycle_requests_append_only_delete`;
--> statement-breakpoint
CREATE TRIGGER `account_lifecycle_requests_append_only_delete`
BEFORE DELETE ON `account_lifecycle_requests`
WHEN EXISTS (
 SELECT 1 FROM account_purge_jobs exact_job
 WHERE exact_job.deletion_request_id=OLD.id
) OR NOT EXISTS (
 SELECT 1 FROM account_purge_jobs pj JOIN account_purge_audit_guards g
 ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
 WHERE pj.owner_user_id=OLD.user_id AND pj.status IN ('queued','running') AND pj.phase='cleanup' AND pj.deletion_request_id<>OLD.id
)
BEGIN SELECT RAISE(ABORT,'account_lifecycle_requests_are_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_user_settings_insert`
BEFORE INSERT ON `user_settings`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_user_settings_update`
BEFORE UPDATE ON `user_settings`
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
CREATE TRIGGER `account_purge_lock_user_settings_delete`
BEFORE DELETE ON `user_settings`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_user_identities_insert`
BEFORE INSERT ON `user_identities`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_user_identities_update`
BEFORE UPDATE ON `user_identities`
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
CREATE TRIGGER `account_purge_lock_user_identities_delete`
BEFORE DELETE ON `user_identities`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolios_insert`
BEFORE INSERT ON `portfolios`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolios_update`
BEFORE UPDATE ON `portfolios`
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
CREATE TRIGGER `account_purge_lock_portfolios_delete`
BEFORE DELETE ON `portfolios`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolio_settings_insert`
BEFORE INSERT ON `portfolio_settings`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolio_settings_update`
BEFORE UPDATE ON `portfolio_settings`
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
CREATE TRIGGER `account_purge_lock_portfolio_settings_delete`
BEFORE DELETE ON `portfolio_settings`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolio_securities_insert`
BEFORE INSERT ON `portfolio_securities`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolio_securities_update`
BEFORE UPDATE ON `portfolio_securities`
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
CREATE TRIGGER `account_purge_lock_portfolio_securities_delete`
BEFORE DELETE ON `portfolio_securities`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_batches_insert`
BEFORE INSERT ON `import_batches`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_batches_update`
BEFORE UPDATE ON `import_batches`
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
CREATE TRIGGER `account_purge_lock_import_batches_delete`
BEFORE DELETE ON `import_batches`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_commit_chunks_insert`
BEFORE INSERT ON `import_commit_chunks`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_commit_chunks_update`
BEFORE UPDATE ON `import_commit_chunks`
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
CREATE TRIGGER `account_purge_lock_import_commit_chunks_delete`
BEFORE DELETE ON `import_commit_chunks`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_rows_insert`
BEFORE INSERT ON `import_rows`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_rows_update`
BEFORE UPDATE ON `import_rows`
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
CREATE TRIGGER `account_purge_lock_import_rows_delete`
BEFORE DELETE ON `import_rows`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_issues_insert`
BEFORE INSERT ON `import_issues`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_issues_update`
BEFORE UPDATE ON `import_issues`
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
CREATE TRIGGER `account_purge_lock_import_issues_delete`
BEFORE DELETE ON `import_issues`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_mapping_decisions_insert`
BEFORE INSERT ON `import_mapping_decisions`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_import_mapping_decisions_update`
BEFORE UPDATE ON `import_mapping_decisions`
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
CREATE TRIGGER `account_purge_lock_import_mapping_decisions_delete`
BEFORE DELETE ON `import_mapping_decisions`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_transactions_insert`
BEFORE INSERT ON `transactions`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_transactions_update`
BEFORE UPDATE ON `transactions`
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
CREATE TRIGGER `account_purge_lock_transactions_delete`
BEFORE DELETE ON `transactions`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_ledger_mutation_guards_insert`
BEFORE INSERT ON `ledger_mutation_guards`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_ledger_mutation_guards_update`
BEFORE UPDATE ON `ledger_mutation_guards`
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
CREATE TRIGGER `account_purge_lock_ledger_mutation_guards_delete`
BEFORE DELETE ON `ledger_mutation_guards`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_manual_ledger_mutation_keys_insert`
BEFORE INSERT ON `manual_ledger_mutation_keys`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_manual_ledger_mutation_keys_update`
BEFORE UPDATE ON `manual_ledger_mutation_keys`
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
CREATE TRIGGER `account_purge_lock_manual_ledger_mutation_keys_delete`
BEFORE DELETE ON `manual_ledger_mutation_keys`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_cash_accounts_insert`
BEFORE INSERT ON `cash_accounts`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_cash_accounts_update`
BEFORE UPDATE ON `cash_accounts`
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
CREATE TRIGGER `account_purge_lock_cash_accounts_delete`
BEFORE DELETE ON `cash_accounts`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_cash_ledger_entries_insert`
BEFORE INSERT ON `cash_ledger_entries`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_cash_ledger_entries_update`
BEFORE UPDATE ON `cash_ledger_entries`
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
CREATE TRIGGER `account_purge_lock_cash_ledger_entries_delete`
BEFORE DELETE ON `cash_ledger_entries`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_manual_overrides_insert`
BEFORE INSERT ON `manual_overrides`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_manual_overrides_update`
BEFORE UPDATE ON `manual_overrides`
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
CREATE TRIGGER `account_purge_lock_manual_overrides_delete`
BEFORE DELETE ON `manual_overrides`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolio_daily_snapshots_insert`
BEFORE INSERT ON `portfolio_daily_snapshots`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolio_daily_snapshots_update`
BEFORE UPDATE ON `portfolio_daily_snapshots`
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
CREATE TRIGGER `account_purge_lock_portfolio_daily_snapshots_delete`
BEFORE DELETE ON `portfolio_daily_snapshots`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_holding_daily_snapshots_insert`
BEFORE INSERT ON `holding_daily_snapshots`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_holding_daily_snapshots_update`
BEFORE UPDATE ON `holding_daily_snapshots`
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
CREATE TRIGGER `account_purge_lock_holding_daily_snapshots_delete`
BEFORE DELETE ON `holding_daily_snapshots`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_snapshot_publications_insert`
BEFORE INSERT ON `snapshot_publications`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_snapshot_publications_update`
BEFORE UPDATE ON `snapshot_publications`
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
CREATE TRIGGER `account_purge_lock_snapshot_publications_delete`
BEFORE DELETE ON `snapshot_publications`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_projection_publications_insert`
BEFORE INSERT ON `projection_publications`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_projection_publications_update`
BEFORE UPDATE ON `projection_publications`
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
CREATE TRIGGER `account_purge_lock_projection_publications_delete`
BEFORE DELETE ON `projection_publications`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_tax_lots_insert`
BEFORE INSERT ON `tax_lots`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_tax_lots_update`
BEFORE UPDATE ON `tax_lots`
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
CREATE TRIGGER `account_purge_lock_tax_lots_delete`
BEFORE DELETE ON `tax_lots`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_lot_allocations_insert`
BEFORE INSERT ON `lot_allocations`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_lot_allocations_update`
BEFORE UPDATE ON `lot_allocations`
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
CREATE TRIGGER `account_purge_lock_lot_allocations_delete`
BEFORE DELETE ON `lot_allocations`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_holding_projections_insert`
BEFORE INSERT ON `holding_projections`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_holding_projections_update`
BEFORE UPDATE ON `holding_projections`
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
CREATE TRIGGER `account_purge_lock_holding_projections_delete`
BEFORE DELETE ON `holding_projections`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_users_insert`
BEFORE INSERT ON `users`
WHEN NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_users_update`
BEFORE UPDATE ON `users`
WHEN (OLD.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`id` AND pj.status IN ('queued','running')
))
OR (NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`id` AND pj.status IN ('queued','running')
))
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_users_delete`
BEFORE DELETE ON `users`
WHEN OLD.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_price_observations_insert`
BEFORE INSERT ON `price_observations`
WHEN NEW.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_price_observations_update`
BEFORE UPDATE ON `price_observations`
WHEN (OLD.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running')
))
OR (NEW.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running')
))
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_price_observations_delete`
BEFORE DELETE ON `price_observations`
WHEN OLD.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_fx_rate_observations_insert`
BEFORE INSERT ON `fx_rate_observations`
WHEN NEW.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_fx_rate_observations_update`
BEFORE UPDATE ON `fx_rate_observations`
WHEN (OLD.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running')
))
OR (NEW.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running')
))
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_fx_rate_observations_delete`
BEFORE DELETE ON `fx_rate_observations`
WHEN OLD.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_market_data_refresh_jobs_insert`
BEFORE INSERT ON `market_data_refresh_jobs`
WHEN NEW.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_market_data_refresh_jobs_update`
BEFORE UPDATE ON `market_data_refresh_jobs`
WHEN (OLD.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running')
))
OR (NEW.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`scope_user_id` AND pj.status IN ('queued','running')
))
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_market_data_refresh_jobs_delete`
BEFORE DELETE ON `market_data_refresh_jobs`
WHEN OLD.`scope_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`scope_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_security_provider_mappings_insert`
BEFORE INSERT ON `security_provider_mappings`
WHEN NEW.`verified_by_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`verified_by_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`verified_by_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_security_provider_mappings_update`
BEFORE UPDATE ON `security_provider_mappings`
WHEN (OLD.`verified_by_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`verified_by_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`verified_by_user_id` AND pj.status IN ('queued','running')
))
OR (NEW.`verified_by_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`verified_by_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`verified_by_user_id` AND pj.status IN ('queued','running')
))
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_security_provider_mappings_delete`
BEFORE DELETE ON `security_provider_mappings`
WHEN OLD.`verified_by_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`verified_by_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`verified_by_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_jobs_insert`
BEFORE INSERT ON `account_export_jobs`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_jobs_update`
BEFORE UPDATE ON `account_export_jobs`
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
CREATE TRIGGER `account_purge_lock_account_export_jobs_delete`
BEFORE DELETE ON `account_export_jobs`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_manifest_insert`
BEFORE INSERT ON `account_export_manifest`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_manifest_update`
BEFORE UPDATE ON `account_export_manifest`
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
CREATE TRIGGER `account_purge_lock_account_export_manifest_delete`
BEFORE DELETE ON `account_export_manifest`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_chunks_insert`
BEFORE INSERT ON `account_export_chunks`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_chunks_update`
BEFORE UPDATE ON `account_export_chunks`
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
CREATE TRIGGER `account_purge_lock_account_export_chunks_delete`
BEFORE DELETE ON `account_export_chunks`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_checkpoint_guards_insert`
BEFORE INSERT ON `account_export_checkpoint_guards`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_export_checkpoint_guards_update`
BEFORE UPDATE ON `account_export_checkpoint_guards`
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
CREATE TRIGGER `account_purge_lock_account_export_checkpoint_guards_delete`
BEFORE DELETE ON `account_export_checkpoint_guards`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_audit_events_insert`
BEFORE INSERT ON `audit_events`
WHEN NEW.target_owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`target_owner_user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`target_owner_user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_account_lifecycle_requests_insert`
BEFORE INSERT ON `account_lifecycle_requests`
WHEN EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
