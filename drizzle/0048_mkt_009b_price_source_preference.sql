PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`home_currency_code` text NOT NULL,
	`timezone` text NOT NULL,
	`default_holding_currency_view` text DEFAULT 'native' NOT NULL,
	`financial_year_start_month` integer DEFAULT 7 NOT NULL,
	`price_source_preference` text DEFAULT 'sharesight_delayed' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`home_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "user_settings_default_holding_currency_view_check" CHECK("__new_user_settings"."default_holding_currency_view" IN ('native', 'home')),
	CONSTRAINT "user_settings_financial_year_start_month_check" CHECK("__new_user_settings"."financial_year_start_month" BETWEEN 1 AND 12),
	CONSTRAINT "user_settings_price_source_preference_check" CHECK("__new_user_settings"."price_source_preference" IN ('yahoo_authenticated', 'yahoo_anonymous', 'sharesight_delayed'))
);
--> statement-breakpoint
-- Hand-fixed (MKT-009B), mirroring FY-001A's 0029_bouncy_virginia_dare.sql
-- precedent exactly -- same two issues, same fix:
--
-- 1. drizzle-kit generated an INSERT that selects `price_source_preference`
--    from the pre-migration `user_settings` table, but that column does not
--    exist until this migration creates it, so the generated SQL failed with
--    "no such column: price_source_preference". The column is intentionally
--    omitted from the INSERT below so every existing row picks up the new
--    column's `DEFAULT 'sharesight_delayed'` with no data rewrite -- see
--    `db/schema.ts`'s `priceSourcePreference` doc comment for why that
--    default is a no-op for an owner with no Sharesight link (Sharesight
--    never writes a row for them, so selection falls straight through to
--    Yahoo, matching pre-migration behaviour byte-for-byte) and matches
--    BRK-012C's existing intent for an owner who does have one.
-- 2. drizzle-kit's rebuild (CREATE __new_user_settings -> copy -> DROP TABLE
--    user_settings -> RENAME) does not know about the hand-written
--    account-purge-lock triggers 0028_fancy_logan.sql attached to
--    `user_settings` (`account_purge_lock_user_settings_insert/update/
--    delete`, guarding every insert/update/delete against an in-flight
--    account purge). SQLite drops a table's triggers when the table itself
--    is dropped, and drizzle-kit's generator has no model of triggers it
--    didn't create, so the generated migration silently produced a
--    `user_settings` table with the purge lock gone -- caught by
--    tests/ops-003b.test.ts's "closes the validation window" assertion no
--    longer throwing `account_purge_source_locked`. The three trigger
--    definitions below are copied verbatim from drizzle/0028_fancy_logan.sql
--    (the same source 0029 copied from -- re-grepped the full drizzle/
--    chain for other `ON \`user_settings\`` triggers; 0028 remains the only
--    migration that defines any) and recreated after the rename so the
--    purge lock is restored on the rebuilt table.
INSERT INTO `__new_user_settings`("user_id", "home_currency_code", "timezone", "default_holding_currency_view", "financial_year_start_month", "created_at", "updated_at", "version") SELECT "user_id", "home_currency_code", "timezone", "default_holding_currency_view", "financial_year_start_month", "created_at", "updated_at", "version" FROM `user_settings`;--> statement-breakpoint
DROP TABLE `user_settings`;--> statement-breakpoint
ALTER TABLE `__new_user_settings` RENAME TO `user_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_user_home_currency_unique` ON `user_settings` (`user_id`,`home_currency_code`);--> statement-breakpoint
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
