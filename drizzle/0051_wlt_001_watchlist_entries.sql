CREATE TABLE `watchlist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`security_id` text,
	`base_currency_code` text,
	`quote_currency_code` text,
	`display_order` integer NOT NULL,
	`created_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`base_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`quote_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "watchlist_entries_kind_check" CHECK("watchlist_entries"."kind" IN ('security', 'currency_pair')),
	CONSTRAINT "watchlist_entries_shape_check" CHECK(("watchlist_entries"."kind" = 'security' AND "watchlist_entries"."security_id" IS NOT NULL AND "watchlist_entries"."base_currency_code" IS NULL AND "watchlist_entries"."quote_currency_code" IS NULL)
          OR ("watchlist_entries"."kind" = 'currency_pair' AND "watchlist_entries"."security_id" IS NULL AND "watchlist_entries"."base_currency_code" IS NOT NULL AND "watchlist_entries"."quote_currency_code" IS NOT NULL AND "watchlist_entries"."base_currency_code" <> "watchlist_entries"."quote_currency_code"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_entries_user_security_unique` ON `watchlist_entries` (`user_id`,`security_id`) WHERE "watchlist_entries"."kind" = 'security';--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_entries_user_pair_unique` ON `watchlist_entries` (`user_id`,`base_currency_code`,`quote_currency_code`) WHERE "watchlist_entries"."kind" = 'currency_pair';--> statement-breakpoint
CREATE INDEX `watchlist_entries_user_order_idx` ON `watchlist_entries` (`user_id`,`display_order`);--> statement-breakpoint
-- WLT-001: account_purge_lock_* triggers for the new owner-scoped
-- watchlist_entries table, hand-appended in the SAME migration that creates
-- the table -- same rationale as 0049_mkt_011a_daily_price_capture.sql's
-- intraday_price_points precedent (drizzle-kit's schema model has no
-- concept of these triggers, so it never generates them; no rebuild happens
-- in this migration, so there is no drop-the-trigger hazard).
CREATE TRIGGER `account_purge_lock_watchlist_entries_insert`
BEFORE INSERT ON `watchlist_entries`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_watchlist_entries_update`
BEFORE UPDATE ON `watchlist_entries`
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
CREATE TRIGGER `account_purge_lock_watchlist_entries_delete`
BEFORE DELETE ON `watchlist_entries`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;