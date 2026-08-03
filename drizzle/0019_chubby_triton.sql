CREATE TABLE `import_commit_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`commit_idempotency_key` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`first_physical_row` integer NOT NULL,
	`last_physical_row` integer NOT NULL,
	`committed_row_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`,`user_id`) REFERENCES `import_batches`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_commit_chunks_chunk_index_check" CHECK("import_commit_chunks"."chunk_index" >= 0),
	CONSTRAINT "import_commit_chunks_row_range_check" CHECK("import_commit_chunks"."last_physical_row" >= "import_commit_chunks"."first_physical_row"),
	CONSTRAINT "import_commit_chunks_committed_row_count_check" CHECK("import_commit_chunks"."committed_row_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_commit_chunks_batch_key_index_unique` ON `import_commit_chunks` (`batch_id`,`user_id`,`commit_idempotency_key`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `import_commit_chunks_owner_batch_idx` ON `import_commit_chunks` (`user_id`,`batch_id`,`chunk_index`);--> statement-breakpoint
ALTER TABLE `import_batches` ADD `commit_high_water_row` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `import_batches_commit_idempotency_unique` ON `import_batches` (`user_id`,`commit_idempotency_key`) WHERE "import_batches"."commit_idempotency_key" IS NOT NULL;