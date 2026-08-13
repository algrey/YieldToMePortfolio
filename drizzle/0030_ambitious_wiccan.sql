CREATE TABLE `dividend_event_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`dividend_event_id` text NOT NULL,
	`shares_decimal` text,
	`dividend_per_share_decimal` text,
	`franking_credit_per_share_decimal` text,
	`exclude` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dividend_event_id`) REFERENCES `dividend_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dividend_event_overrides_exclude_check" CHECK("dividend_event_overrides"."exclude" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_event_overrides_id_user_portfolio_unique` ON `dividend_event_overrides` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_event_overrides_target_unique` ON `dividend_event_overrides` (`user_id`,`portfolio_id`,`portfolio_security_id`,`dividend_event_id`);--> statement-breakpoint
CREATE TABLE `dividend_events` (
	`id` text PRIMARY KEY NOT NULL,
	`security_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`ex_date` text,
	`record_date` text,
	`payment_date` text,
	`declaration_date` text,
	`currency_code` text NOT NULL,
	`gross_per_share_decimal` text,
	`franking_percent_decimal` text,
	`franking_credit_per_share_decimal` text,
	`observed_at` text NOT NULL,
	`ingested_at` text NOT NULL,
	`estimate_method` text,
	`estimate_as_of` text,
	`supersedes_event_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_id`) REFERENCES `market_data_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_event_id`) REFERENCES `dividend_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dividend_events_kind_check" CHECK("dividend_events"."kind" IN ('cash', 'special', 'capital_return')),
	CONSTRAINT "dividend_events_status_check" CHECK("dividend_events"."status" IN ('estimated', 'declared', 'paid', 'cancelled', 'superseded')),
	CONSTRAINT "dividend_events_amount_check" CHECK("dividend_events"."status" NOT IN ('declared', 'paid') OR "dividend_events"."gross_per_share_decimal" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `dividend_events_security_status_idx` ON `dividend_events` (`security_id`,`status`,`ex_date`);--> statement-breakpoint
CREATE TABLE `dividend_fy_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`financial_year_ending_year` integer NOT NULL,
	`grossed_amount_decimal` text NOT NULL,
	`franking_amount_decimal` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dividend_fy_overrides_year_check" CHECK("dividend_fy_overrides"."financial_year_ending_year" BETWEEN 1900 AND 2999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_fy_overrides_id_user_portfolio_unique` ON `dividend_fy_overrides` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_fy_overrides_portfolio_year_unique` ON `dividend_fy_overrides` (`portfolio_id`,`financial_year_ending_year`);--> statement-breakpoint
CREATE TABLE `dividend_manual_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`payment_date` text NOT NULL,
	`shares_decimal` text NOT NULL,
	`dividend_per_share_decimal` text NOT NULL,
	`franking_credit_per_share_decimal` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_id_user_portfolio_unique` ON `dividend_manual_records` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE INDEX `dividend_manual_records_owner_portfolio_security_idx` ON `dividend_manual_records` (`user_id`,`portfolio_id`,`portfolio_security_id`,`payment_date`);--> statement-breakpoint
CREATE TABLE `dividend_portfolio_assumptions` (
	`portfolio_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`value_growth_percent_decimal` text,
	`portfolio_dividend_growth_percent_decimal` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_portfolio_assumptions_portfolio_user_unique` ON `dividend_portfolio_assumptions` (`portfolio_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `dividend_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`dividend_event_id` text NOT NULL,
	`transaction_id` text,
	`shares_decimal` text NOT NULL,
	`dividend_per_share_decimal` text NOT NULL,
	`franking_per_share_decimal` text,
	`currency_code` text NOT NULL,
	`payment_date` text NOT NULL,
	`status` text DEFAULT 'actual' NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dividend_event_id`) REFERENCES `dividend_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`transaction_id`,`user_id`,`portfolio_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dividend_receipts_status_check" CHECK("dividend_receipts"."status" = 'actual'),
	CONSTRAINT "dividend_receipts_source_check" CHECK("dividend_receipts"."source" IN ('manual', 'csv_import', 'broker_sync'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_receipts_id_user_portfolio_unique` ON `dividend_receipts` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE INDEX `dividend_receipts_owner_portfolio_security_idx` ON `dividend_receipts` (`user_id`,`portfolio_id`,`portfolio_security_id`);--> statement-breakpoint
CREATE TABLE `dividend_security_assumptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`dividend_yield_percent_decimal` text,
	`franking_percent_decimal` text,
	`dividend_growth_percent_decimal` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_security_assumptions_id_user_portfolio_unique` ON `dividend_security_assumptions` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_security_assumptions_portfolio_security_unique` ON `dividend_security_assumptions` (`portfolio_security_id`);--> statement-breakpoint
CREATE INDEX `dividend_security_assumptions_owner_portfolio_idx` ON `dividend_security_assumptions` (`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE TABLE `split_events` (
	`id` text PRIMARY KEY NOT NULL,
	`security_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`ex_date` text NOT NULL,
	`effective_date` text NOT NULL,
	`numerator_decimal` text NOT NULL,
	`denominator_decimal` text NOT NULL,
	`status` text NOT NULL,
	`observed_at` text NOT NULL,
	`ingested_at` text NOT NULL,
	`supersedes_event_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_id`) REFERENCES `market_data_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_event_id`) REFERENCES `split_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "split_events_status_check" CHECK("split_events"."status" IN ('declared', 'effective', 'cancelled', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX `split_events_security_status_idx` ON `split_events` (`security_id`,`status`,`ex_date`);
--> statement-breakpoint
-- DB-005: account_purge_lock_* triggers for the six new owner-scoped tables
-- (dividend_receipts and friends), hand-appended for the same reason every
-- other owner table's purge-lock trigger is hand-written in this migration
-- chain (see 0028_fancy_logan.sql) -- drizzle-kit's schema model has no
-- concept of these triggers, so it never generates them; they are added
-- here in the SAME migration that creates the tables, so there is no
-- rebuild-drops-the-trigger hazard (0030_ambitious_wiccan.sql only CREATEs
-- new tables -- no `__new_*`/DROP/RENAME rebuild of any existing table).
-- Shared, non-owner tables (dividend_events, split_events) intentionally
-- get no purge-lock trigger, mirroring `securities`.
CREATE TRIGGER `account_purge_lock_dividend_receipts_insert`
BEFORE INSERT ON `dividend_receipts`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_receipts_update`
BEFORE UPDATE ON `dividend_receipts`
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
CREATE TRIGGER `account_purge_lock_dividend_receipts_delete`
BEFORE DELETE ON `dividend_receipts`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_security_assumptions_insert`
BEFORE INSERT ON `dividend_security_assumptions`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_security_assumptions_update`
BEFORE UPDATE ON `dividend_security_assumptions`
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
CREATE TRIGGER `account_purge_lock_dividend_security_assumptions_delete`
BEFORE DELETE ON `dividend_security_assumptions`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_portfolio_assumptions_insert`
BEFORE INSERT ON `dividend_portfolio_assumptions`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_portfolio_assumptions_update`
BEFORE UPDATE ON `dividend_portfolio_assumptions`
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
CREATE TRIGGER `account_purge_lock_dividend_portfolio_assumptions_delete`
BEFORE DELETE ON `dividend_portfolio_assumptions`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_fy_overrides_insert`
BEFORE INSERT ON `dividend_fy_overrides`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_fy_overrides_update`
BEFORE UPDATE ON `dividend_fy_overrides`
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
CREATE TRIGGER `account_purge_lock_dividend_fy_overrides_delete`
BEFORE DELETE ON `dividend_fy_overrides`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_event_overrides_insert`
BEFORE INSERT ON `dividend_event_overrides`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_event_overrides_update`
BEFORE UPDATE ON `dividend_event_overrides`
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
CREATE TRIGGER `account_purge_lock_dividend_event_overrides_delete`
BEFORE DELETE ON `dividend_event_overrides`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_manual_records_insert`
BEFORE INSERT ON `dividend_manual_records`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_dividend_manual_records_update`
BEFORE UPDATE ON `dividend_manual_records`
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
CREATE TRIGGER `account_purge_lock_dividend_manual_records_delete`
BEFORE DELETE ON `dividend_manual_records`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
