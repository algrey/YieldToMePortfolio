CREATE TABLE `intraday_price_points` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`security_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`price_decimal` text NOT NULL,
	`currency_code` text NOT NULL,
	`market_date` text NOT NULL,
	`market_timezone` text NOT NULL,
	`observed_at` text NOT NULL,
	`captured_at` text NOT NULL,
	`delayed_minutes` integer,
	`quality` text DEFAULT 'observed' NOT NULL,
	`provider_revision_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_id`) REFERENCES `market_data_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "intraday_price_points_provider_check" CHECK("intraday_price_points"."provider_id" IN ('sharesight', 'yahoo-compatible')),
	CONSTRAINT "intraday_price_points_quality_check" CHECK("intraday_price_points"."quality" IN ('observed', 'corrected', 'indicative', 'stale_candidate')),
	CONSTRAINT "intraday_price_points_delayed_minutes_check" CHECK("intraday_price_points"."delayed_minutes" IS NULL OR "intraday_price_points"."delayed_minutes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intraday_price_points_user_security_provider_observed_unique` ON `intraday_price_points` (`user_id`,`security_id`,`provider_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `intraday_price_points_user_provider_date_idx` ON `intraday_price_points` (`user_id`,`provider_id`,`market_date`,`security_id`);--> statement-breakpoint
ALTER TABLE `user_settings` ADD `daily_capture_source` text DEFAULT 'sharesight' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `daily_capture_interval_minutes` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
-- MKT-011A: account_purge_lock_* triggers for the new owner-scoped
-- intraday_price_points table, hand-appended in the SAME migration that
-- creates the table -- same rationale as 0034_fast_moon_knight.sql's
-- sharesight_sync_state precedent and 0045_brk_012c_sharesight_delayed_prices.sql's
-- identical sharesight_delayed_prices precedent (drizzle-kit's schema model
-- has no concept of these triggers, so it never generates them; no rebuild
-- happens in this migration, so there is no drop-the-trigger hazard). The
-- two `ALTER TABLE ... ADD` statements above are plain ADD COLUMN on the
-- EXISTING user_settings table and do not touch that table's own
-- purge-lock triggers (0028_fancy_logan.sql, re-recreated by
-- 0048_mkt_009b_price_source_preference.sql's rebuild) -- a plain ADD
-- COLUMN never drops a table's triggers, only a DROP-and-recreate rebuild
-- does.
CREATE TRIGGER `account_purge_lock_intraday_price_points_insert`
BEFORE INSERT ON `intraday_price_points`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_intraday_price_points_update`
BEFORE UPDATE ON `intraday_price_points`
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
CREATE TRIGGER `account_purge_lock_intraday_price_points_delete`
BEFORE DELETE ON `intraday_price_points`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;