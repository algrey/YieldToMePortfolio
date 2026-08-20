CREATE TABLE `sharesight_delayed_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`security_id` text NOT NULL,
	`price_decimal` text NOT NULL,
	`currency_code` text NOT NULL,
	`quote_at` text,
	`fetched_at` text NOT NULL,
	`provider_id` text DEFAULT 'sharesight' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sharesight_delayed_prices_provider_check" CHECK("sharesight_delayed_prices"."provider_id" = 'sharesight')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sharesight_delayed_prices_user_security_unique` ON `sharesight_delayed_prices` (`user_id`,`security_id`);--> statement-breakpoint
CREATE INDEX `sharesight_delayed_prices_user_idx` ON `sharesight_delayed_prices` (`user_id`);--> statement-breakpoint
ALTER TABLE `sharesight_sync_state` ADD `price_refresh_lease_owner` text;--> statement-breakpoint
ALTER TABLE `sharesight_sync_state` ADD `price_refresh_lease_expires_at` text;--> statement-breakpoint
-- BRK-012C: account_purge_lock_* triggers for the new owner-scoped
-- sharesight_delayed_prices table, hand-appended in the SAME migration that
-- creates the table -- same rationale as 0034_fast_moon_knight.sql's
-- identical sharesight_sync_state precedent (drizzle-kit's schema model has
-- no concept of these triggers, so it never generates them; no rebuild
-- happens in this migration, so there is no drop-the-trigger hazard). The
-- two `ALTER TABLE ... ADD` statements above are plain ADD COLUMN on the
-- EXISTING sharesight_sync_state table and do not touch that table's own
-- purge-lock triggers (see db/schema.ts's identical disclosure for the
-- BRK-012B `lastPriceRefreshAt` trio).
CREATE TRIGGER `account_purge_lock_sharesight_delayed_prices_insert`
BEFORE INSERT ON `sharesight_delayed_prices`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_sharesight_delayed_prices_update`
BEFORE UPDATE ON `sharesight_delayed_prices`
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
CREATE TRIGGER `account_purge_lock_sharesight_delayed_prices_delete`
BEFORE DELETE ON `sharesight_delayed_prices`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;