CREATE TABLE `currencies` (
	`code` text PRIMARY KEY NOT NULL,
	`numeric_code` integer NOT NULL,
	`name` text NOT NULL,
	`minor_unit_digits` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	CONSTRAINT "currencies_minor_unit_digits_check" CHECK("currencies"."minor_unit_digits" BETWEEN 0 AND 8),
	CONSTRAINT "currencies_is_active_check" CHECK("currencies"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `portfolio_settings` (
	`portfolio_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`quote_staleness_policy` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_settings_portfolio_user_unique` ON `portfolio_settings` (`portfolio_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`base_currency_code` text NOT NULL,
	`timezone` text NOT NULL,
	`accounting_method` text DEFAULT 'fifo' NOT NULL,
	`history_complete_from` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`base_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "portfolios_accounting_method_check" CHECK("portfolios"."accounting_method" = 'fifo'),
	CONSTRAINT "portfolios_status_check" CHECK("portfolios"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_id_user_id_unique` ON `portfolios` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_user_id_code_unique` ON `portfolios` (`user_id`,`code`);--> statement-breakpoint
CREATE INDEX `portfolios_owner_status_updated_at_idx` ON `portfolios` (`user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'cloudflare_access' NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`email_at_link` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_authenticated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "user_identities_provider_check" CHECK("user_identities"."provider" = 'cloudflare_access'),
	CONSTRAINT "user_identities_status_check" CHECK("user_identities"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_issuer_subject_unique` ON `user_identities` (`provider`,`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `user_identities_user_status_idx` ON `user_identities` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`home_currency_code` text NOT NULL,
	`timezone` text NOT NULL,
	`default_holding_currency_view` text DEFAULT 'native' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`home_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "user_settings_default_holding_currency_view_check" CHECK("user_settings"."default_holding_currency_view" IN ('native', 'home'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_user_home_currency_unique` ON `user_settings` (`user_id`,`home_currency_code`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`display_name` text,
	`primary_email` text NOT NULL,
	`locale` text DEFAULT 'en-AU' NOT NULL,
	`timezone` text NOT NULL,
	`terms_accepted_at` text,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_status_check" CHECK("users"."status" IN ('pending', 'active', 'disabled', 'deletion_pending', 'purged'))
);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);