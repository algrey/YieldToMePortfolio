CREATE TABLE `sharesight_pending_payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text,
	`source_reference` text NOT NULL,
	`sharesight_holding_id` text NOT NULL,
	`sharesight_instrument_id` text,
	`sharesight_payout_id` text,
	`symbol` text NOT NULL,
	`market_code` text NOT NULL,
	`currency_code` text NOT NULL,
	`payment_date` text NOT NULL,
	`ex_date` text,
	`total_cash_decimal` text NOT NULL,
	`gross_amount_decimal` text NOT NULL,
	`total_franking_decimal` text,
	`resident_withholding_tax_decimal` text,
	`non_resident_withholding_tax_decimal` text,
	`fx_rate_to_portfolio_decimal` text,
	`fx_rate_source` text,
	`first_observed_at` text NOT NULL,
	`last_observed_at` text NOT NULL,
	`withdrawn_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sharesight_pending_payouts_fx_provenance_check" CHECK(("sharesight_pending_payouts"."fx_rate_to_portfolio_decimal" IS NULL) = ("sharesight_pending_payouts"."fx_rate_source" IS NULL)),
	CONSTRAINT "sharesight_pending_payouts_fx_rate_source_check" CHECK("sharesight_pending_payouts"."fx_rate_source" IS NULL OR "sharesight_pending_payouts"."fx_rate_source" IN ('sharesight'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sharesight_pending_payouts_portfolio_source_reference_unique` ON `sharesight_pending_payouts` (`portfolio_id`,`source_reference`);--> statement-breakpoint
CREATE INDEX `sharesight_pending_payouts_owner_portfolio_withdrawn_idx` ON `sharesight_pending_payouts` (`user_id`,`portfolio_id`,`withdrawn_at`);--> statement-breakpoint
CREATE INDEX `sharesight_pending_payouts_owner_portfolio_security_idx` ON `sharesight_pending_payouts` (`user_id`,`portfolio_id`,`portfolio_security_id`);--> statement-breakpoint
-- BRK-022: account_purge_lock_* triggers for the new owner-scoped
-- sharesight_pending_payouts table, hand-appended in the SAME migration
-- that creates the table -- same rationale as 0045_brk_012c's
-- sharesight_delayed_prices precedent (drizzle-kit's schema model has no
-- concept of these triggers, so it never generates them; no rebuild
-- happens in this migration, so there is no drop-the-trigger hazard).
CREATE TRIGGER `account_purge_lock_sharesight_pending_payouts_insert`
BEFORE INSERT ON `sharesight_pending_payouts`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_sharesight_pending_payouts_update`
BEFORE UPDATE ON `sharesight_pending_payouts`
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
CREATE TRIGGER `account_purge_lock_sharesight_pending_payouts_delete`
BEFORE DELETE ON `sharesight_pending_payouts`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;