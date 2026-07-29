CREATE TABLE `exchanges` (
	`id` text PRIMARY KEY NOT NULL,
	`mic` text,
	`name` text NOT NULL,
	`country_code` text NOT NULL,
	`timezone` text NOT NULL,
	`default_currency_code` text,
	`calendar_code` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`default_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "exchanges_is_active_check" CHECK("exchanges"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchanges_mic_unique` ON `exchanges` (`mic`);--> statement-breakpoint
CREATE TABLE `market_data_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'disabled' NOT NULL,
	`capabilities_json` text NOT NULL,
	`rate_limit_json` text NOT NULL,
	`technically_reviewed_at` text,
	`operator_notes_reference` text,
	CONSTRAINT "market_data_providers_status_check" CHECK("market_data_providers"."status" IN ('disabled', 'enabled', 'suspended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_data_providers_code_unique` ON `market_data_providers` (`code`);--> statement-breakpoint
CREATE TABLE `portfolio_securities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`security_id` text,
	`source_symbol` text NOT NULL,
	`source_exchange_alias` text,
	`source_currency_code` text NOT NULL,
	`source_name` text,
	`display_symbol` text,
	`display_name` text,
	`status` text DEFAULT 'unresolved' NOT NULL,
	`first_relevant_date` text,
	`last_relevant_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "portfolio_securities_status_check" CHECK("portfolio_securities"."status" IN ('held', 'watch', 'hidden', 'unresolved')),
	CONSTRAINT "portfolio_securities_resolution_check" CHECK(("portfolio_securities"."status" = 'unresolved' AND "portfolio_securities"."security_id" IS NULL) OR ("portfolio_securities"."status" <> 'unresolved' AND "portfolio_securities"."security_id" IS NOT NULL)),
	CONSTRAINT "portfolio_securities_relevant_dates_check" CHECK("portfolio_securities"."last_relevant_date" IS NULL OR "portfolio_securities"."first_relevant_date" IS NULL OR "portfolio_securities"."last_relevant_date" >= "portfolio_securities"."first_relevant_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_securities_id_user_portfolio_unique` ON `portfolio_securities` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_securities_resolved_unique` ON `portfolio_securities` (`portfolio_id`,`security_id`) WHERE "portfolio_securities"."security_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `portfolio_securities_owner_portfolio_status_idx` ON `portfolio_securities` (`user_id`,`portfolio_id`,`status`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_type` text NOT NULL,
	`exchange_id` text,
	`primary_currency_code` text NOT NULL,
	`canonical_name` text NOT NULL,
	`isin` text,
	`status` text DEFAULT 'active' NOT NULL,
	`first_trade_date` text,
	`last_trade_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`exchange_id`) REFERENCES `exchanges`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`primary_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "securities_asset_type_check" CHECK("securities"."asset_type" IN ('equity', 'etf', 'fund')),
	CONSTRAINT "securities_status_check" CHECK("securities"."status" IN ('active', 'delisted')),
	CONSTRAINT "securities_trade_dates_check" CHECK("securities"."last_trade_date" IS NULL OR "securities"."first_trade_date" IS NULL OR "securities"."last_trade_date" >= "securities"."first_trade_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_isin_unique` ON `securities` (`isin`);--> statement-breakpoint
CREATE TABLE `security_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`security_id` text NOT NULL,
	`scheme` text NOT NULL,
	`value` text NOT NULL,
	`exchange_id` text,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`source` text NOT NULL,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`exchange_id`) REFERENCES `exchanges`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "security_identifiers_validity_check" CHECK("security_identifiers"."valid_to" IS NULL OR "security_identifiers"."valid_to" >= "security_identifiers"."valid_from")
);
--> statement-breakpoint
CREATE INDEX `security_identifiers_lookup_idx` ON `security_identifiers` (`scheme`,`value`,`exchange_id`,`valid_from`,`valid_to`);--> statement-breakpoint
CREATE TABLE `security_provider_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`security_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_exchange` text NOT NULL,
	`provider_symbol` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`verified_by_user_id` text,
	`verified_at` text,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_id`) REFERENCES `market_data_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`verified_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "security_provider_mappings_status_check" CHECK("security_provider_mappings"."status" IN ('candidate', 'verified', 'rejected', 'expired')),
	CONSTRAINT "security_provider_mappings_validity_check" CHECK("security_provider_mappings"."valid_to" IS NULL OR "security_provider_mappings"."valid_to" >= "security_provider_mappings"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_provider_mappings_provider_symbol_from_unique` ON `security_provider_mappings` (`provider_id`,`provider_exchange`,`provider_symbol`,`valid_from`);--> statement-breakpoint
CREATE UNIQUE INDEX `security_provider_mappings_id_provider_unique` ON `security_provider_mappings` (`id`,`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `security_provider_mappings_id_provider_security_unique` ON `security_provider_mappings` (`id`,`provider_id`,`security_id`);--> statement-breakpoint
CREATE INDEX `security_provider_mappings_security_provider_valid_to_idx` ON `security_provider_mappings` (`security_id`,`provider_id`,`valid_to`);