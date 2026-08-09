CREATE TABLE `account_export_checkpoint_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`export_job_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`valid` integer NOT NULL,
	FOREIGN KEY (`export_job_id`,`user_id`) REFERENCES `account_export_jobs`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "account_export_checkpoint_guards_valid_check" CHECK("account_export_checkpoint_guards"."valid" = 1)
);
--> statement-breakpoint
CREATE INDEX `account_export_checkpoint_guards_owner_job_idx` ON `account_export_checkpoint_guards` (`user_id`,`export_job_id`);--> statement-breakpoint
CREATE TABLE `account_export_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`export_job_id` text NOT NULL,
	`user_id` text NOT NULL,
	`table_name` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload_json` text NOT NULL,
	`row_count` integer NOT NULL,
	`digest` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`export_job_id`,`user_id`) REFERENCES `account_export_jobs`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "account_export_chunks_index_check" CHECK("account_export_chunks"."chunk_index" >= 0 AND "account_export_chunks"."row_count" BETWEEN 1 AND 8)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_export_chunks_job_table_index_unique` ON `account_export_chunks` (`export_job_id`,`table_name`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `account_export_chunks_owner_job_idx` ON `account_export_chunks` (`user_id`,`export_job_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `account_export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`lifecycle_request_id` text NOT NULL,
	`phase` text DEFAULT 'capture' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`table_index` integer DEFAULT 0 NOT NULL,
	`row_cursor` integer DEFAULT 0 NOT NULL,
	`reconcile_table_index` integer DEFAULT 0 NOT NULL,
	`reconcile_row_cursor` integer DEFAULT 0 NOT NULL,
	`reconcile_digest` text DEFAULT '0' NOT NULL,
	`reconcile_row_count` integer DEFAULT 0 NOT NULL,
	`capture_fragment_offset` integer DEFAULT 0 NOT NULL,
	`finalize_table_name` text DEFAULT '' NOT NULL,
	`finalize_chunk_index` integer DEFAULT -1 NOT NULL,
	`finalize_digest` text DEFAULT '0' NOT NULL,
	`operational_audit_high_water` integer DEFAULT 0 NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`object_count` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`manifest_digest` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lifecycle_request_id`,`user_id`) REFERENCES `account_lifecycle_requests`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "account_export_jobs_phase_check" CHECK("account_export_jobs"."phase" IN ('capture', 'reconcile', 'finalize')),
	CONSTRAINT "account_export_jobs_status_check" CHECK("account_export_jobs"."status" IN ('queued', 'running', 'completed', 'failed', 'expired')),
	CONSTRAINT "account_export_jobs_cursor_check" CHECK("account_export_jobs"."table_index" >= 0 AND "account_export_jobs"."row_cursor" >= 0),
	CONSTRAINT "account_export_jobs_reconcile_cursor_check" CHECK("account_export_jobs"."reconcile_table_index" >= 0 AND "account_export_jobs"."reconcile_row_cursor" >= 0),
	CONSTRAINT "account_export_jobs_count_check" CHECK("account_export_jobs"."row_count" >= 0 AND "account_export_jobs"."object_count" >= 0 AND "account_export_jobs"."reconcile_row_count" >= 0 AND "account_export_jobs"."capture_fragment_offset" >= 0 AND "account_export_jobs"."finalize_chunk_index" >= -1 AND "account_export_jobs"."operational_audit_high_water" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_export_jobs_request_unique` ON `account_export_jobs` (`lifecycle_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_export_jobs_id_owner_unique` ON `account_export_jobs` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `account_export_jobs_owner_status_idx` ON `account_export_jobs` (`user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `account_export_manifest` (
	`id` text PRIMARY KEY NOT NULL,
	`export_job_id` text NOT NULL,
	`user_id` text NOT NULL,
	`table_name` text NOT NULL,
	`classification` text NOT NULL,
	`retention` text NOT NULL,
	`reason` text NOT NULL,
	`source_row_count` integer DEFAULT 0 NOT NULL,
	`captured_row_count` integer DEFAULT 0 NOT NULL,
	`object_count` integer DEFAULT 0 NOT NULL,
	`digest` text DEFAULT '0' NOT NULL,
	`cutoff_cursor` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`export_job_id`,`user_id`) REFERENCES `account_export_jobs`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_export_manifest_job_table_unique` ON `account_export_manifest` (`export_job_id`,`table_name`);--> statement-breakpoint
CREATE INDEX `account_export_manifest_owner_job_idx` ON `account_export_manifest` (`user_id`,`export_job_id`);--> statement-breakpoint
CREATE TABLE `account_lifecycle_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor_user_id` text,
	`request_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`include_export` integer DEFAULT false NOT NULL,
	`export_job_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "account_lifecycle_requests_type_check" CHECK("account_lifecycle_requests"."request_type" IN ('disable', 'deletion', 'export')),
	CONSTRAINT "account_lifecycle_requests_status_check" CHECK("account_lifecycle_requests"."status" IN ('completed')),
	CONSTRAINT "account_lifecycle_requests_include_export_check" CHECK("account_lifecycle_requests"."include_export" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_lifecycle_requests_owner_type_key_unique` ON `account_lifecycle_requests` (`user_id`,`request_type`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_lifecycle_requests_id_owner_unique` ON `account_lifecycle_requests` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `account_lifecycle_requests_owner_type_created_idx` ON `account_lifecycle_requests` (`user_id`,`request_type`,`created_at`);
--> statement-breakpoint
-- Drizzle cannot express append-only lifecycle intent in its table schema. These
-- triggers are deliberately appended after generation and must remain covered by
-- migration tests so retries cannot rewrite or remove an immutable request.
CREATE TRIGGER account_lifecycle_requests_append_only_update
BEFORE UPDATE ON account_lifecycle_requests
BEGIN
  SELECT RAISE(ABORT, 'account_lifecycle_requests_are_immutable');
END;--> statement-breakpoint
CREATE TRIGGER account_lifecycle_requests_append_only_delete
BEFORE DELETE ON account_lifecycle_requests
BEGIN
  SELECT RAISE(ABORT, 'account_lifecycle_requests_are_immutable');
END;
