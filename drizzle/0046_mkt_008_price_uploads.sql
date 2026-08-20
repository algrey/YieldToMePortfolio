-- MKT-008 (HAND-AUTHORED additions to drizzle-kit's generated diff, AGENTS.md
-- disclosure): drizzle-kit generated the `price_upload_batches` CREATE TABLE
-- and the `price_observations.upload_batch_id` ADD COLUMN below from
-- db/schema.ts's diff -- no rebuild was triggered (verified by running this
-- generation and inspecting the output), so this migration touches neither
-- table's existing `account_purge_lock_price_observations_*` triggers. Three
-- things drizzle-kit's schema model has no concept of are hand-appended:
--   1. The `market_data_providers` seed row below (mirrors 0044's identical
--      Sharesight seed exactly -- see that migration's header comment for
--      the full rationale). `provider_id = 'owner-import'` is the SINGLE,
--      generic provider row for every owner-uploaded price-history source;
--      per this task's ruling the SOURCE DETAIL (e.g. "intelligent-investor")
--      is a per-upload `price_upload_batches.source_label` value, never a
--      second provider row -- a future second CSV shape/broker fits by
--      adding a new `source_label`, not a schema or seed change.
--      `status = 'enabled'` for the same reason 0044 gives: there is no
--      separate per-deployment activation gate for this provider (the real
--      gate is the owner explicitly choosing to upload a file); this row
--      alone activates nothing.
--   2. `account_purge_lock_price_upload_batches_*` triggers on the NEW
--      table, hand-appended in the SAME migration that creates it -- same
--      technique as 0045's identical `sharesight_delayed_prices` precedent
--      (no rebuild happens in this migration, so there is no
--      drop-the-trigger hazard for this brand-new table either).
--   3. `price_observations.upload_batch_id` deliberately carries NO FK
--      constraint to `price_upload_batches` -- see db/schema.ts's header
--      comment on that column for why (adding one would require rebuilding
--      `price_observations`, dropping its own purge-lock triggers, for a
--      soft attribution link the application enforces by write ORDERING
--      instead -- see that same comment for the review-corrected
--      explanation of exactly how).
INSERT INTO `market_data_providers`
  (`id`, `code`, `name`, `status`, `capabilities_json`, `rate_limit_json`)
VALUES
  ('owner-import', 'owner-import', 'Owner-uploaded price history', 'enabled', '{}', '{}')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE `price_upload_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_label` text NOT NULL,
	`format` text NOT NULL,
	`filename` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`inserted_row_count` integer DEFAULT 0 NOT NULL,
	`malformed_row_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "price_upload_batches_format_check" CHECK("price_upload_batches"."format" IN ('single', 'backup')),
	CONSTRAINT "price_upload_batches_row_count_check" CHECK("price_upload_batches"."row_count" >= 0),
	CONSTRAINT "price_upload_batches_inserted_row_count_check" CHECK("price_upload_batches"."inserted_row_count" >= 0 AND "price_upload_batches"."inserted_row_count" <= "price_upload_batches"."row_count"),
	CONSTRAINT "price_upload_batches_malformed_row_count_check" CHECK("price_upload_batches"."malformed_row_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `price_upload_batches_owner_created_idx` ON `price_upload_batches` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `price_observations` ADD `upload_batch_id` text;--> statement-breakpoint
CREATE INDEX `price_observations_upload_batch_idx` ON `price_observations` (`upload_batch_id`);--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_price_upload_batches_insert`
BEFORE INSERT ON `price_upload_batches`
WHEN NEW.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=NEW.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;
--> statement-breakpoint
CREATE TRIGGER `account_purge_lock_price_upload_batches_update`
BEFORE UPDATE ON `price_upload_batches`
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
CREATE TRIGGER `account_purge_lock_price_upload_batches_delete`
BEFORE DELETE ON `price_upload_batches`
WHEN OLD.`user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM account_purge_jobs pj WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running'))
AND NOT EXISTS (
  SELECT 1 FROM account_purge_jobs pj
  JOIN account_purge_audit_guards g ON g.owner_user_id=pj.owner_user_id AND g.purge_job_id=pj.id AND g.expected_version=pj.version AND g.valid=1
  WHERE pj.owner_user_id=OLD.`user_id` AND pj.status IN ('queued','running')
)
BEGIN SELECT RAISE(ABORT,'account_purge_source_locked'); END;