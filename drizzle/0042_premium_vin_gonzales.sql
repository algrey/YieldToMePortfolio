-- BRK-010: adds nullable `currency_code` (FK `currencies`),
-- `fx_rate_to_portfolio_decimal`, and `fx_rate_source` so a foreign-currency
-- dividend payout (e.g. an ASX-listed security trading in AUD that pays a
-- USD dividend) can be recorded honestly instead of silently counted at
-- 1:1 -- see `db/schema.ts`'s `dividendManualRecords` header note.
-- drizzle-kit generated a genuine table REBUILD here (not a plain ADD
-- COLUMN) because this migration also adds two new CHECK constraints
-- (`dividend_manual_records_fx_provenance_check`,
-- `dividend_manual_records_fx_rate_source_check`), which SQLite cannot add
-- via ALTER TABLE -- same trigger-hazard shape as 0035 (BRK-005) before it:
-- the rebuild (`__new_dividend_manual_records` / INSERT...SELECT / DROP /
-- RENAME) drops every index AND every hand-appended trigger drizzle-kit
-- does not know about. Both are recreated below: the five indexes
-- drizzle-kit itself regenerated correctly, and the three
-- `account_purge_lock_*` triggers -- which it does NOT know exist -- are
-- hand-appended again after the RENAME, byte-identical to the bodies 0035
-- last re-verified (themselves byte-identical to 0030's originals).
-- `tests/db-schema.test.ts` checks the three trigger NAMES survive this
-- rebuild; it does NOT re-probe actual purge-lock ENFORCEMENT -- see
-- `tests/db-005.test.ts`'s "purge-lock triggers fire for every new owner
-- table while a purge job is active" drill for the enforcement coverage
-- this schema relies on (unchanged by this migration). A second hand-edit
-- was also required: see the INSERT...SELECT statement's own disclosure
-- comment below.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dividend_manual_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`payment_date` text NOT NULL,
	`shares_decimal` text,
	`dividend_per_share_decimal` text,
	`franking_credit_per_share_decimal` text,
	`import_batch_id` text,
	`source_reference` text,
	`idempotency_key` text,
	`total_cash_decimal` text,
	`total_franking_decimal` text,
	`currency_code` text,
	`fx_rate_to_portfolio_decimal` text,
	`fx_rate_source` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dividend_manual_records_amount_mode_check" CHECK(
        (
          "__new_dividend_manual_records"."shares_decimal" IS NOT NULL
          AND "__new_dividend_manual_records"."dividend_per_share_decimal" IS NOT NULL
          AND "__new_dividend_manual_records"."total_cash_decimal" IS NULL
          AND "__new_dividend_manual_records"."total_franking_decimal" IS NULL
        )
        OR
        (
          "__new_dividend_manual_records"."shares_decimal" IS NULL
          AND "__new_dividend_manual_records"."dividend_per_share_decimal" IS NULL
          AND "__new_dividend_manual_records"."franking_credit_per_share_decimal" IS NULL
          AND "__new_dividend_manual_records"."total_cash_decimal" IS NOT NULL
        )
      ),
	CONSTRAINT "dividend_manual_records_fx_provenance_check" CHECK(
        ("__new_dividend_manual_records"."fx_rate_to_portfolio_decimal" IS NULL) = ("__new_dividend_manual_records"."fx_rate_source" IS NULL)
        AND (
          "__new_dividend_manual_records"."fx_rate_to_portfolio_decimal" IS NULL
          OR "__new_dividend_manual_records"."currency_code" IS NOT NULL
        )
      ),
	CONSTRAINT "dividend_manual_records_fx_rate_source_check" CHECK("__new_dividend_manual_records"."fx_rate_source" IS NULL OR "__new_dividend_manual_records"."fx_rate_source" IN ('sharesight'))
);
--> statement-breakpoint
-- Hand-edit disclosure (AGENTS.md): drizzle-kit's auto-generated SELECT list
-- referenced the three brand-new columns (`currency_code`,
-- `fx_rate_to_portfolio_decimal`, `fx_rate_source`) BY NAME against the OLD
-- (pre-migration) table, which does not have them yet -- the identical
-- generation defect 0035/0040 already disclosed and hand-fixed the same way.
-- Corrected to select literal `NULL` for all three instead (every existing
-- row is legacy/native by construction, which is exactly what NULL means
-- for these columns -- see the table's header note).
INSERT INTO `__new_dividend_manual_records`("id", "user_id", "portfolio_id", "portfolio_security_id", "payment_date", "shares_decimal", "dividend_per_share_decimal", "franking_credit_per_share_decimal", "import_batch_id", "source_reference", "idempotency_key", "total_cash_decimal", "total_franking_decimal", "currency_code", "fx_rate_to_portfolio_decimal", "fx_rate_source", "created_at", "updated_at", "version") SELECT "id", "user_id", "portfolio_id", "portfolio_security_id", "payment_date", "shares_decimal", "dividend_per_share_decimal", "franking_credit_per_share_decimal", "import_batch_id", "source_reference", "idempotency_key", "total_cash_decimal", "total_franking_decimal", NULL, NULL, NULL, "created_at", "updated_at", "version" FROM `dividend_manual_records`;--> statement-breakpoint
DROP TABLE `dividend_manual_records`;--> statement-breakpoint
ALTER TABLE `__new_dividend_manual_records` RENAME TO `dividend_manual_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_id_user_portfolio_unique` ON `dividend_manual_records` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE INDEX `dividend_manual_records_owner_portfolio_security_idx` ON `dividend_manual_records` (`user_id`,`portfolio_id`,`portfolio_security_id`,`payment_date`);--> statement-breakpoint
CREATE INDEX `dividend_manual_records_import_batch_idx` ON `dividend_manual_records` (`user_id`,`import_batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_portfolio_source_reference_unique` ON `dividend_manual_records` (`portfolio_id`,`source_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_security_idempotency_unique` ON `dividend_manual_records` (`portfolio_security_id`,`idempotency_key`);--> statement-breakpoint
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