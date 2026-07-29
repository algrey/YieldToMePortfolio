PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_manual_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text,
	`security_id` text,
	`type` text NOT NULL,
	`target_key` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`value_json` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`supersedes_override_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_override_id`,`user_id`) REFERENCES `manual_overrides`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "manual_overrides_type_check" CHECK("__new_manual_overrides"."type" IN ('price', 'fx_rate', 'security_mapping', 'transaction_fx')),
	CONSTRAINT "manual_overrides_status_check" CHECK("__new_manual_overrides"."status" IN ('active', 'superseded', 'revoked')),
	CONSTRAINT "manual_overrides_effective_interval_check" CHECK("__new_manual_overrides"."effective_to" IS NULL OR "__new_manual_overrides"."effective_to" >= "__new_manual_overrides"."effective_from")
);
--> statement-breakpoint
INSERT INTO `__new_manual_overrides`("id", "user_id", "portfolio_id", "security_id", "type", "target_key", "effective_from", "effective_to", "value_json", "reason", "status", "supersedes_override_id", "created_at") SELECT "id", "user_id", "portfolio_id", "security_id", "type", "target_key", "effective_from", "effective_to", "value_json", "reason", "status", "supersedes_override_id", "created_at" FROM `manual_overrides`;--> statement-breakpoint
DROP TABLE `manual_overrides`;--> statement-breakpoint
ALTER TABLE `__new_manual_overrides` RENAME TO `manual_overrides`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `manual_overrides_active_idx` ON `manual_overrides` (`user_id`,`type`,`target_key`,`status`,`effective_from`);--> statement-breakpoint
CREATE UNIQUE INDEX `manual_overrides_id_user_unique` ON `manual_overrides` (`id`,`user_id`);