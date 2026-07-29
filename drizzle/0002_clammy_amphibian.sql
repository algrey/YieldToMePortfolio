CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_portfolio_id` text,
	`parser_format` text NOT NULL,
	`parser_version` text NOT NULL,
	`filename` text NOT NULL,
	`byte_size` integer NOT NULL,
	`file_sha256` text NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`blank_rows` integer DEFAULT 0 NOT NULL,
	`definition_rows` integer DEFAULT 0 NOT NULL,
	`transaction_rows` integer DEFAULT 0 NOT NULL,
	`unsupported_rows` integer DEFAULT 0 NOT NULL,
	`duplicate_rows` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`info_count` integer DEFAULT 0 NOT NULL,
	`commit_idempotency_key` text,
	`reversal_idempotency_key` text,
	`supersedes_batch_id` text,
	`failure_category` text,
	`failure_detail` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`parsed_at` text,
	`committed_at` text,
	`reversed_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_batch_id`,`user_id`) REFERENCES `import_batches`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_batches_status_check" CHECK("import_batches"."status" IN ('uploaded', 'parsed', 'needs_mapping', 'invalid', 'ready', 'committing', 'committed', 'reversing', 'reversed', 'failed')),
	CONSTRAINT "import_batches_byte_size_check" CHECK("import_batches"."byte_size" >= 0),
	CONSTRAINT "import_batches_total_rows_check" CHECK("import_batches"."total_rows" >= 0),
	CONSTRAINT "import_batches_blank_rows_check" CHECK("import_batches"."blank_rows" >= 0),
	CONSTRAINT "import_batches_definition_rows_check" CHECK("import_batches"."definition_rows" >= 0),
	CONSTRAINT "import_batches_transaction_rows_check" CHECK("import_batches"."transaction_rows" >= 0),
	CONSTRAINT "import_batches_unsupported_rows_check" CHECK("import_batches"."unsupported_rows" >= 0),
	CONSTRAINT "import_batches_duplicate_rows_check" CHECK("import_batches"."duplicate_rows" >= 0),
	CONSTRAINT "import_batches_error_count_check" CHECK("import_batches"."error_count" >= 0),
	CONSTRAINT "import_batches_warning_count_check" CHECK("import_batches"."warning_count" >= 0),
	CONSTRAINT "import_batches_info_count_check" CHECK("import_batches"."info_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_batches_user_file_parser_unique` ON `import_batches` (`user_id`,`file_sha256`,`parser_format`,`parser_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_batches_id_user_unique` ON `import_batches` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `import_batches_owner_status_updated_at_idx` ON `import_batches` (`user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `import_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`row_id` text,
	`physical_row_number` integer,
	`field` text,
	`severity` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`suggested_resolution_type` text,
	`resolved_value` text,
	`resolved_by_user_id` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`batch_id`,`user_id`) REFERENCES `import_batches`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`row_id`,`user_id`) REFERENCES `import_rows`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_issues_severity_check" CHECK("import_issues"."severity" IN ('error', 'warning', 'info'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_issues_id_user_unique` ON `import_issues` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `import_issues_batch_row_idx` ON `import_issues` (`batch_id`,`row_id`,`physical_row_number`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`physical_row_number` integer NOT NULL,
	`row_class` text NOT NULL,
	`original_fields_json` text NOT NULL,
	`normalized_fields_json` text,
	`normalized_fingerprint` text,
	`validation_status` text DEFAULT 'staged' NOT NULL,
	`target_portfolio_id` text,
	`target_portfolio_security_id` text,
	`commit_status` text DEFAULT 'staged' NOT NULL,
	`commit_transaction_id` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`info_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`batch_id`,`user_id`) REFERENCES `import_batches`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_portfolio_security_id`,`user_id`,`target_portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_rows_physical_row_number_check" CHECK("import_rows"."physical_row_number" > 1),
	CONSTRAINT "import_rows_row_class_check" CHECK("import_rows"."row_class" IN ('portfolio_security_definition', 'transaction', 'blank', 'unsupported')),
	CONSTRAINT "import_rows_validation_status_check" CHECK("import_rows"."validation_status" IN ('staged', 'valid', 'needs_mapping', 'invalid')),
	CONSTRAINT "import_rows_commit_status_check" CHECK("import_rows"."commit_status" IN ('staged', 'committed', 'skipped', 'reversed', 'failed')),
	CONSTRAINT "import_rows_error_count_check" CHECK("import_rows"."error_count" >= 0),
	CONSTRAINT "import_rows_warning_count_check" CHECK("import_rows"."warning_count" >= 0),
	CONSTRAINT "import_rows_info_count_check" CHECK("import_rows"."info_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_rows_batch_physical_row_unique` ON `import_rows` (`batch_id`,`physical_row_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_rows_id_user_unique` ON `import_rows` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_rows_id_user_portfolio_unique` ON `import_rows` (`id`,`user_id`,`target_portfolio_id`);--> statement-breakpoint
CREATE INDEX `import_rows_review_idx` ON `import_rows` (`batch_id`,`validation_status`,`physical_row_number`);--> statement-breakpoint
CREATE INDEX `import_rows_user_normalized_fingerprint_idx` ON `import_rows` (`user_id`,`normalized_fingerprint`);