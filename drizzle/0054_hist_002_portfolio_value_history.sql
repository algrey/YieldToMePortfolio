CREATE TABLE `portfolio_value_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`value_date` text NOT NULL,
	`value_decimal` text NOT NULL,
	`completeness` text NOT NULL,
	`held_security_count` integer NOT NULL,
	`priced_security_count` integer NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "portfolio_value_history_completeness_check" CHECK("portfolio_value_history"."completeness" IN ('complete', 'partial')),
	CONSTRAINT "portfolio_value_history_held_count_check" CHECK("portfolio_value_history"."held_security_count" >= 0),
	CONSTRAINT "portfolio_value_history_priced_count_check" CHECK("portfolio_value_history"."priced_security_count" >= 0 AND "portfolio_value_history"."priced_security_count" <= "portfolio_value_history"."held_security_count")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_value_history_portfolio_date_unique` ON `portfolio_value_history` (`portfolio_id`,`value_date`);--> statement-breakpoint
CREATE INDEX `portfolio_value_history_user_portfolio_idx` ON `portfolio_value_history` (`user_id`,`portfolio_id`,`value_date`);--> statement-breakpoint
-- HIST-002: account_purge_lock_* triggers for the new owner-scoped
-- portfolio_value_history table, hand-appended in the SAME migration that
-- creates the table -- same rationale as
-- 0053_div_014_income_whatif_scenarios.sql's income_whatif_scenarios
-- precedent (itself following 0051/0049's identical pattern): drizzle-kit's
-- schema model has no concept of these triggers, so it never generates
-- them; no rebuild happens in this migration, so there is no
-- drop-the-trigger hazard.
CREATE TRIGGER `account_purge_lock_portfolio_value_history_insert`
BEFORE INSERT ON `portfolio_value_history`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_portfolio_value_history_update`
BEFORE UPDATE ON `portfolio_value_history`
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
CREATE TRIGGER `account_purge_lock_portfolio_value_history_delete`
BEFORE DELETE ON `portfolio_value_history`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;