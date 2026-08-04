CREATE TABLE `snapshot_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`calculation_run_id` text NOT NULL,
	`ledger_high_water` text NOT NULL,
	`published_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`calculation_run_id`,`user_id`,`portfolio_id`) REFERENCES `calculation_runs`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_publications_owner_version_unique` ON `snapshot_publications` (`user_id`,`portfolio_id`,`calculation_version`);--> statement-breakpoint
CREATE INDEX `snapshot_publications_owner_portfolio_idx` ON `snapshot_publications` (`user_id`,`portfolio_id`,`published_at`);--> statement-breakpoint
DROP INDEX `holding_snapshots_security_date_version_unique`;--> statement-breakpoint
ALTER TABLE `holding_daily_snapshots` ADD `calculation_run_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `holding_snapshots_security_date_version_unique` ON `holding_daily_snapshots` (`portfolio_id`,`portfolio_security_id`,`snapshot_date`,`calculation_version`,`calculation_run_id`);--> statement-breakpoint
DROP INDEX `portfolio_snapshots_portfolio_date_version_unique`;--> statement-breakpoint
ALTER TABLE `portfolio_daily_snapshots` ADD `calculation_run_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_snapshots_portfolio_date_version_unique` ON `portfolio_daily_snapshots` (`portfolio_id`,`snapshot_date`,`calculation_version`,`calculation_run_id`);--> statement-breakpoint
ALTER TABLE `calculation_runs` ADD `market_data_cutoff` text;