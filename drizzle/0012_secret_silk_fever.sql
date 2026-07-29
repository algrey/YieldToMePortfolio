CREATE TABLE `import_mapping_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_key` text NOT NULL,
	`normalized_source_value` text NOT NULL,
	`target_id` text,
	`target_value` text,
	`scope` text NOT NULL,
	`confidence` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`batch_id`,`user_id`) REFERENCES `import_batches`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_mapping_decisions_kind_check" CHECK("import_mapping_decisions"."kind" IN ('portfolio', 'security', 'currency', 'transaction_type', 'fx')),
	CONSTRAINT "import_mapping_decisions_scope_check" CHECK("import_mapping_decisions"."scope" IN ('row', 'batch', 'user_future')),
	CONSTRAINT "import_mapping_decisions_confidence_check" CHECK("import_mapping_decisions"."confidence" IN ('user', 'exact_identifier', 'system_candidate')),
	CONSTRAINT "import_mapping_decisions_source_check" CHECK("import_mapping_decisions"."source" IN ('user', 'exact_identifier', 'system_candidate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_mapping_decisions_id_user_unique` ON `import_mapping_decisions` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_mapping_decisions_lookup_unique` ON `import_mapping_decisions` (`batch_id`,`user_id`,`kind`,`source_key`,`scope`);--> statement-breakpoint
CREATE INDEX `import_mapping_decisions_owner_batch_idx` ON `import_mapping_decisions` (`user_id`,`batch_id`,`kind`);