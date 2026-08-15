CREATE TABLE `sharesight_sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`sharesight_portfolio_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_synced_at` text,
	`last_trade_watermark` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sharesight_sync_state_enabled_check" CHECK("sharesight_sync_state"."enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sharesight_sync_state_id_user_portfolio_unique` ON `sharesight_sync_state` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sharesight_sync_state_target_unique` ON `sharesight_sync_state` (`user_id`,`portfolio_id`,`sharesight_portfolio_id`);--> statement-breakpoint
CREATE INDEX `sharesight_sync_state_owner_portfolio_idx` ON `sharesight_sync_state` (`user_id`,`portfolio_id`);
--> statement-breakpoint
-- BRK-004: account_purge_lock_* triggers for the new owner-scoped
-- sharesight_sync_state table, hand-appended for the same reason every
-- other owner table's purge-lock trigger is hand-written in this migration
-- chain (see 0028_fancy_logan.sql / 0030_ambitious_wiccan.sql) -- drizzle-kit's
-- schema model has no concept of these triggers, so it never generates them;
-- they are added here in the SAME migration that creates the table, so
-- there is no rebuild-drops-the-trigger hazard (this migration only CREATEs
-- the new table -- no `__new_*`/DROP/RENAME rebuild of any existing table).
CREATE TRIGGER `account_purge_lock_sharesight_sync_state_insert`
BEFORE INSERT ON `sharesight_sync_state`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_sharesight_sync_state_update`
BEFORE UPDATE ON `sharesight_sync_state`
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
CREATE TRIGGER `account_purge_lock_sharesight_sync_state_delete`
BEFORE DELETE ON `sharesight_sync_state`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;