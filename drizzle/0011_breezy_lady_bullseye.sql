CREATE TABLE `calculation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`range_from` text NOT NULL,
	`range_to` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`reason` text NOT NULL,
	`invalidation_source` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`ledger_high_water_start` text NOT NULL,
	`ledger_high_water_end` text,
	`processed_snapshot_count` integer DEFAULT 0 NOT NULL,
	`processed_holding_count` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`failure_category` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "calculation_runs_status_check" CHECK("calculation_runs"."status" IN ('queued', 'running', 'completed', 'failed', 'abandoned')),
	CONSTRAINT "calculation_runs_range_check" CHECK("calculation_runs"."range_to" >= "calculation_runs"."range_from"),
	CONSTRAINT "calculation_runs_attempt_check" CHECK("calculation_runs"."attempt" >= 0),
	CONSTRAINT "calculation_runs_snapshot_count_check" CHECK("calculation_runs"."processed_snapshot_count" >= 0),
	CONSTRAINT "calculation_runs_holding_count_check" CHECK("calculation_runs"."processed_holding_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calculation_runs_id_user_portfolio_unique` ON `calculation_runs` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calculation_runs_idempotency_unique` ON `calculation_runs` (`user_id`,`portfolio_id`,`calculation_version`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `calculation_runs_lease_idx` ON `calculation_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `calculation_runs_portfolio_status_idx` ON `calculation_runs` (`user_id`,`portfolio_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `holding_daily_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`portfolio_snapshot_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`quantity_decimal` text NOT NULL,
	`native_value_decimal` text,
	`base_value_decimal` text,
	`basis_decimal` text,
	`price_observation_id` text,
	`fx_observation_id` text,
	`daily_movement_decimal` text,
	`completeness` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`calculation_version` integer NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_snapshot_id`,`user_id`,`portfolio_id`,`snapshot_date`,`calculation_version`) REFERENCES `portfolio_daily_snapshots`(`id`,`user_id`,`portfolio_id`,`snapshot_date`,`calculation_version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "holding_snapshots_completeness_check" CHECK("holding_daily_snapshots"."completeness" IN ('complete', 'partial', 'incomplete')),
	CONSTRAINT "holding_snapshots_status_check" CHECK("holding_daily_snapshots"."status" IN ('ready', 'invalidated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holding_snapshots_id_user_portfolio_unique` ON `holding_daily_snapshots` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `holding_snapshots_security_date_version_unique` ON `holding_daily_snapshots` (`portfolio_id`,`portfolio_security_id`,`snapshot_date`,`calculation_version`);--> statement-breakpoint
CREATE INDEX `holding_snapshots_chart_idx` ON `holding_daily_snapshots` (`portfolio_id`,`portfolio_security_id`,`snapshot_date`);--> statement-breakpoint
CREATE TABLE `portfolio_daily_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`base_currency_code` text NOT NULL,
	`securities_value_decimal` text,
	`cash_value_decimal` text,
	`total_value_decimal` text,
	`cost_basis_decimal` text,
	`unrealised_gain_decimal` text,
	`realised_gain_to_date_decimal` text,
	`daily_movement_decimal` text,
	`coverage_json` text NOT NULL,
	`completeness` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`ledger_high_water` text NOT NULL,
	`market_data_cutoff` text,
	`calculation_version` integer NOT NULL,
	`rebuilt_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`base_currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "portfolio_snapshots_completeness_check" CHECK("portfolio_daily_snapshots"."completeness" IN ('complete', 'partial', 'incomplete')),
	CONSTRAINT "portfolio_snapshots_status_check" CHECK("portfolio_daily_snapshots"."status" IN ('ready', 'invalidated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_snapshots_id_user_portfolio_date_version_unique` ON `portfolio_daily_snapshots` (`id`,`user_id`,`portfolio_id`,`snapshot_date`,`calculation_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_snapshots_portfolio_date_version_unique` ON `portfolio_daily_snapshots` (`portfolio_id`,`snapshot_date`,`calculation_version`);--> statement-breakpoint
CREATE INDEX `portfolio_snapshots_chart_idx` ON `portfolio_daily_snapshots` (`portfolio_id`,`snapshot_date`);