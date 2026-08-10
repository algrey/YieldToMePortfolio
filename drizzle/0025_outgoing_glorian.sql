CREATE TABLE `account_purge_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`deletion_request_id` text NOT NULL,
	`deletion_key_digest` text NOT NULL,
	`export_job_id` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'validate_source' NOT NULL,
	`target_index` integer DEFAULT 0 NOT NULL,
	`row_cursor` integer DEFAULT 0 NOT NULL,
	`rolling_digest` text DEFAULT '0' NOT NULL,
	`rolling_count` integer DEFAULT 0 NOT NULL,
	`chunk_table_name` text DEFAULT '' NOT NULL,
	`chunk_index` integer DEFAULT -1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_counts_json` text DEFAULT '{}' NOT NULL,
	`failure_code` text,
	`eligible_at` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "account_purge_jobs_status_check" CHECK("account_purge_jobs"."status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "account_purge_jobs_phase_check" CHECK("account_purge_jobs"."phase" IN ('validate_source', 'validate_chunks', 'purge', 'verify', 'complete')),
	CONSTRAINT "account_purge_jobs_cursor_check" CHECK("account_purge_jobs"."target_index" >= 0 AND "account_purge_jobs"."row_cursor" >= 0 AND "account_purge_jobs"."rolling_count" >= 0 AND "account_purge_jobs"."chunk_index" >= -1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_purge_jobs_deletion_request_unique` ON `account_purge_jobs` (`deletion_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_purge_jobs_owner_export_unique` ON `account_purge_jobs` (`owner_user_id`,`export_job_id`);--> statement-breakpoint
CREATE INDEX `account_purge_jobs_owner_status_idx` ON `account_purge_jobs` (`owner_user_id`,`status`,`updated_at`);