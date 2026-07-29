CREATE TABLE `fx_rate_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`access_scope` text NOT NULL,
	`scope_user_id` text,
	`scope_key` text NOT NULL,
	`base_currency_code` text NOT NULL,
	`quote_currency_code` text NOT NULL,
	`rate_decimal` text NOT NULL,
	`interval` text NOT NULL,
	`observed_at` text NOT NULL,
	`market_date` text NOT NULL,
	`quality` text NOT NULL,
	`ingested_at` text NOT NULL,
	`payload_sha256` text,
	FOREIGN KEY (`provider_id`) REFERENCES `market_data_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`base_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`quote_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "fx_rate_observations_access_scope_check" CHECK("fx_rate_observations"."access_scope" IN ('deployment', 'user')),
	CONSTRAINT "fx_rate_observations_scope_check" CHECK(("fx_rate_observations"."access_scope" = 'deployment' AND "fx_rate_observations"."scope_user_id" IS NULL AND "fx_rate_observations"."scope_key" = 'deployment') OR ("fx_rate_observations"."access_scope" = 'user' AND "fx_rate_observations"."scope_user_id" IS NOT NULL AND "fx_rate_observations"."scope_key" = "fx_rate_observations"."scope_user_id")),
	CONSTRAINT "fx_rate_observations_pair_check" CHECK("fx_rate_observations"."base_currency_code" <> "fx_rate_observations"."quote_currency_code"),
	CONSTRAINT "fx_rate_observations_interval_check" CHECK("fx_rate_observations"."interval" IN ('eod', 'delayed', 'intraday')),
	CONSTRAINT "fx_rate_observations_quality_check" CHECK("fx_rate_observations"."quality" IN ('observed', 'corrected', 'indicative', 'stale_candidate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fx_rate_observations_provider_scope_pair_unique` ON `fx_rate_observations` (`provider_id`,`scope_key`,`base_currency_code`,`quote_currency_code`,`interval`,`observed_at`);--> statement-breakpoint
CREATE INDEX `fx_rate_observations_pair_date_idx` ON `fx_rate_observations` (`base_currency_code`,`quote_currency_code`,`market_date`);--> statement-breakpoint
CREATE TABLE `manual_overrides` (
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
	FOREIGN KEY (`supersedes_override_id`) REFERENCES `manual_overrides`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "manual_overrides_type_check" CHECK("manual_overrides"."type" IN ('price', 'fx_rate', 'security_mapping', 'transaction_fx')),
	CONSTRAINT "manual_overrides_status_check" CHECK("manual_overrides"."status" IN ('active', 'superseded', 'revoked')),
	CONSTRAINT "manual_overrides_effective_interval_check" CHECK("manual_overrides"."effective_to" IS NULL OR "manual_overrides"."effective_to" >= "manual_overrides"."effective_from")
);
--> statement-breakpoint
CREATE INDEX `manual_overrides_active_idx` ON `manual_overrides` (`user_id`,`type`,`target_key`,`status`,`effective_from`);--> statement-breakpoint
CREATE TABLE `price_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`access_scope` text NOT NULL,
	`scope_user_id` text,
	`scope_key` text NOT NULL,
	`mapping_id` text NOT NULL,
	`security_id` text NOT NULL,
	`interval` text NOT NULL,
	`observation_at` text NOT NULL,
	`market_date` text NOT NULL,
	`market_timezone` text NOT NULL,
	`currency_code` text NOT NULL,
	`close_decimal` text NOT NULL,
	`previous_close_decimal` text,
	`adjustment_state` text NOT NULL,
	`quality` text NOT NULL,
	`delayed_minutes` integer,
	`ingested_at` text NOT NULL,
	`payload_sha256` text,
	FOREIGN KEY (`provider_id`) REFERENCES `market_data_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`mapping_id`,`provider_id`,`security_id`) REFERENCES `security_provider_mappings`(`id`,`provider_id`,`security_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "price_observations_access_scope_check" CHECK("price_observations"."access_scope" IN ('deployment', 'user')),
	CONSTRAINT "price_observations_scope_check" CHECK(("price_observations"."access_scope" = 'deployment' AND "price_observations"."scope_user_id" IS NULL AND "price_observations"."scope_key" = 'deployment') OR ("price_observations"."access_scope" = 'user' AND "price_observations"."scope_user_id" IS NOT NULL AND "price_observations"."scope_key" = "price_observations"."scope_user_id")),
	CONSTRAINT "price_observations_interval_check" CHECK("price_observations"."interval" IN ('eod', 'delayed', 'intraday')),
	CONSTRAINT "price_observations_adjustment_state_check" CHECK("price_observations"."adjustment_state" IN ('raw', 'split_adjusted', 'total_return_adjusted')),
	CONSTRAINT "price_observations_quality_check" CHECK("price_observations"."quality" IN ('observed', 'corrected', 'indicative', 'stale_candidate')),
	CONSTRAINT "price_observations_delayed_minutes_check" CHECK("price_observations"."delayed_minutes" IS NULL OR "price_observations"."delayed_minutes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_observations_provider_scope_mapping_unique` ON `price_observations` (`provider_id`,`scope_key`,`mapping_id`,`interval`,`observation_at`,`adjustment_state`);--> statement-breakpoint
CREATE INDEX `price_observations_security_date_idx` ON `price_observations` (`security_id`,`adjustment_state`,`market_date`);