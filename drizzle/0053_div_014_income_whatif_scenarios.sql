CREATE TABLE `income_whatif_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`name` text NOT NULL,
	`capital_rows_json` text NOT NULL,
	`reinvest_dividends` integer NOT NULL,
	`value_growth_percent_decimal` text,
	`dividend_growth_percent_decimal` text,
	`created_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "income_whatif_scenarios_name_check" CHECK(length(trim("income_whatif_scenarios"."name")) > 0),
	CONSTRAINT "income_whatif_scenarios_reinvest_dividends_check" CHECK("income_whatif_scenarios"."reinvest_dividends" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `income_whatif_scenarios_portfolio_user_idx` ON `income_whatif_scenarios` (`portfolio_id`,`user_id`,`created_at`);
--> statement-breakpoint
-- DIV-014: account_purge_lock_* triggers for the new owner-scoped
-- income_whatif_scenarios table, hand-appended in the SAME migration that
-- creates the table -- same rationale as
-- 0051_wlt_001_watchlist_entries.sql's watchlist_entries precedent (itself
-- following 0049_mkt_011a_daily_price_capture.sql's intraday_price_points
-- precedent): drizzle-kit's schema model has no concept of these triggers,
-- so it never generates them; no rebuild happens in this migration, so
-- there is no drop-the-trigger hazard.
CREATE TRIGGER `account_purge_lock_income_whatif_scenarios_insert`
BEFORE INSERT ON `income_whatif_scenarios`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_income_whatif_scenarios_update`
BEFORE UPDATE ON `income_whatif_scenarios`
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
CREATE TRIGGER `account_purge_lock_income_whatif_scenarios_delete`
BEFORE DELETE ON `income_whatif_scenarios`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;