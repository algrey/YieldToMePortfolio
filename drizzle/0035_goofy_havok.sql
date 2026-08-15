-- BRK-005: relaxes `shares_decimal`/`dividend_per_share_decimal` to nullable
-- and adds `total_cash_decimal`/`total_franking_decimal` so a Sharesight
-- payout (which reports only a TOTAL cash amount and total franking
-- credits, never a share count) can be stored without fabricating a
-- per-share figure. SQLite cannot relax an existing NOT NULL constraint via
-- ALTER TABLE, so -- unlike every prior `dividend_manual_records` migration
-- (0032/0033, plain ADD COLUMN) -- this one is a genuine table rebuild
-- (`__new_dividend_manual_records` / INSERT...SELECT / DROP / RENAME),
-- which drops every index AND every hand-appended trigger drizzle-kit does
-- not know about. Both are recreated below: the four indexes drizzle-kit
-- itself regenerated correctly, and the three `account_purge_lock_*`
-- triggers, which it does NOT know exist, are hand-appended again after the
-- RENAME (see that comment further down). The CHECK constraint below
-- enforces the amount-mode invariant (either the per-share trio is set and
-- both total_* columns are NULL, or the reverse) at the database layer, on
-- top of `db/repositories/dividends.ts`'s own repository-level validation --
-- belt-and-suspenders, not a claim that either guard alone is untrustworthy
-- (see `docs/DATA_MODEL.md`'s `dividend_manual_records` entry for the exact
-- wording: this repo has not independently verified CHECK-constraint
-- enforcement against a live Cloudflare D1 instance, only against this
-- migration-testing shim's local `node:sqlite`, so the application-layer
-- validation is what this codebase actually relies on).
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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
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
      )
);
--> statement-breakpoint
-- HAND EDIT (AGENTS.md disclosure): drizzle-kit's own generated
-- `INSERT ... SELECT` selected `"total_cash_decimal", "total_franking_decimal"`
-- FROM THE OLD TABLE in its SELECT list -- but the OLD (pre-migration)
-- `dividend_manual_records` does not have those columns yet, so running it
-- as generated fails closed with `no such column: total_cash_decimal`
-- (verified). Corrected below to select literal `NULL, NULL` for those two
-- columns in the SELECT list instead (every existing row is per-share, so
-- both new columns are genuinely NULL for all of them regardless); the
-- INSERT's own target column list is unchanged from drizzle-kit's output.
-- Re-verified end-to-end by replaying every migration file against a fresh
-- `node:sqlite` database (`tests/brk-005.test.ts`, `tests/db-schema.test.ts`).
INSERT INTO `__new_dividend_manual_records`("id", "user_id", "portfolio_id", "portfolio_security_id", "payment_date", "shares_decimal", "dividend_per_share_decimal", "franking_credit_per_share_decimal", "import_batch_id", "source_reference", "idempotency_key", "total_cash_decimal", "total_franking_decimal", "created_at", "updated_at", "version") SELECT "id", "user_id", "portfolio_id", "portfolio_security_id", "payment_date", "shares_decimal", "dividend_per_share_decimal", "franking_credit_per_share_decimal", "import_batch_id", "source_reference", "idempotency_key", NULL, NULL, "created_at", "updated_at", "version" FROM `dividend_manual_records`;--> statement-breakpoint
DROP TABLE `dividend_manual_records`;--> statement-breakpoint
ALTER TABLE `__new_dividend_manual_records` RENAME TO `dividend_manual_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_id_user_portfolio_unique` ON `dividend_manual_records` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE INDEX `dividend_manual_records_owner_portfolio_security_idx` ON `dividend_manual_records` (`user_id`,`portfolio_id`,`portfolio_security_id`,`payment_date`);--> statement-breakpoint
CREATE INDEX `dividend_manual_records_import_batch_idx` ON `dividend_manual_records` (`user_id`,`import_batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_portfolio_source_reference_unique` ON `dividend_manual_records` (`portfolio_id`,`source_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_security_idempotency_unique` ON `dividend_manual_records` (`portfolio_security_id`,`idempotency_key`);--> statement-breakpoint
-- BRK-005: account_purge_lock_* triggers for `dividend_manual_records`,
-- hand-appended for the same reason every other owner table's purge-lock
-- trigger is hand-written in this migration chain (see
-- 0028_fancy_logan.sql / 0030_ambitious_wiccan.sql / 0034_fast_moon_knight.sql)
-- -- drizzle-kit's schema model has no concept of these triggers, so it
-- never generates them. UNLIKE 0030/0034 (both CREATE-only migrations with
-- no rebuild-drops-the-trigger hazard), THIS migration DOES rebuild the
-- table (`__new_dividend_manual_records` / DROP / RENAME above), which
-- silently drops any trigger attached to the OLD table -- so, unlike those
-- two migrations' "no hazard" note, this one had a REAL hazard: without
-- re-adding these three triggers here, the totals-columns migration would
-- have shipped with purge-lock enforcement silently gone from this table.
-- Verified: byte-identical to the trigger bodies 0030_ambitious_wiccan.sql
-- originally created, re-tested for actual enforcement (not just presence)
-- after this migration in `tests/brk-005.test.ts` and `tests/db-schema.test.ts`.
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