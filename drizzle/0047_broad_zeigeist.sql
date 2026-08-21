CREATE TABLE `dividend_import_franking_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`dividend_manual_record_id` text NOT NULL,
	`franking_total_decimal` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dividend_manual_record_id`,`user_id`,`portfolio_id`) REFERENCES `dividend_manual_records`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_import_franking_overrides_id_user_portfolio_unique` ON `dividend_import_franking_overrides` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_import_franking_overrides_target_unique` ON `dividend_import_franking_overrides` (`user_id`,`portfolio_id`,`dividend_manual_record_id`);--> statement-breakpoint
CREATE INDEX `dividend_import_franking_overrides_owner_portfolio_security_idx` ON `dividend_import_franking_overrides` (`user_id`,`portfolio_id`,`portfolio_security_id`);
--> statement-breakpoint
-- BRK-011: account_purge_lock_* triggers for the new owner-scoped
-- dividend_import_franking_overrides table, hand-appended for the same
-- reason every other owner table's purge-lock trigger is hand-written in
-- this migration chain (see 0028_fancy_logan.sql / 0030_ambitious_wiccan.sql
-- / 0034_fast_moon_knight.sql) -- drizzle-kit's schema model has no concept
-- of these triggers, so it never generates them; they are added here in the
-- SAME migration that creates the table, so there is no
-- rebuild-drops-the-trigger hazard (this migration only CREATEs the new
-- table -- no `__new_*`/DROP/RENAME rebuild of any existing table).
CREATE TRIGGER `account_purge_lock_dividend_import_franking_overrides_insert`
BEFORE INSERT ON `dividend_import_franking_overrides`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_import_franking_overrides_update`
BEFORE UPDATE ON `dividend_import_franking_overrides`
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
CREATE TRIGGER `account_purge_lock_dividend_import_franking_overrides_delete`
BEFORE DELETE ON `dividend_import_franking_overrides`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;