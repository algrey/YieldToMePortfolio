CREATE TABLE `projection_publications` (
	`user_id` text NOT NULL,
	`portfolio_id` text PRIMARY KEY NOT NULL,
	`calculation_run_id` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`ledger_high_water` text NOT NULL,
	`published_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`calculation_run_id`,`user_id`,`portfolio_id`) REFERENCES `calculation_runs`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projection_publications_owner_portfolio_unique` ON `projection_publications` (`user_id`,`portfolio_id`);--> statement-breakpoint
DROP INDEX `tax_lots_opening_transaction_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `tax_lots_opening_transaction_run_unique` ON `tax_lots` (`opening_transaction_id`,`calculation_run_id`);--> statement-breakpoint
DROP INDEX `holding_projections_portfolio_security_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `holding_projections_portfolio_security_unique` ON `holding_projections` (`portfolio_id`,`portfolio_security_id`,`calculation_run_id`);--> statement-breakpoint
DROP INDEX `lot_allocations_sell_lot_sequence_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `lot_allocations_sell_lot_sequence_unique` ON `lot_allocations` (`sell_transaction_id`,`tax_lot_id`,`allocation_sequence`,`calculation_run_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_calculation_runs` (
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
	`processed_ledger_count` integer DEFAULT 0 NOT NULL,
	`projection_cursor_security_id` text,
	`projection_active_security_id` text,
	`projection_output_offset` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`failure_category` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "calculation_runs_status_check" CHECK("__new_calculation_runs"."status" IN ('queued', 'running', 'completed', 'failed', 'abandoned')),
	CONSTRAINT "calculation_runs_range_check" CHECK("__new_calculation_runs"."range_to" >= "__new_calculation_runs"."range_from"),
	CONSTRAINT "calculation_runs_attempt_check" CHECK("__new_calculation_runs"."attempt" >= 0),
	CONSTRAINT "calculation_runs_snapshot_count_check" CHECK("__new_calculation_runs"."processed_snapshot_count" >= 0),
	CONSTRAINT "calculation_runs_holding_count_check" CHECK("__new_calculation_runs"."processed_holding_count" >= 0),
	CONSTRAINT "calculation_runs_ledger_count_check" CHECK("__new_calculation_runs"."processed_ledger_count" >= 0),
	CONSTRAINT "calculation_runs_projection_output_offset_check" CHECK("__new_calculation_runs"."projection_output_offset" >= 0)
);
--> statement-breakpoint
-- drizzle-kit emitted references to the four newly added checkpoint columns in
-- the source SELECT. Existing databases do not have those columns, so seed
-- their documented defaults explicitly while preserving every prior field.
INSERT INTO `__new_calculation_runs`("id", "user_id", "portfolio_id", "range_from", "range_to", "calculation_version", "reason", "invalidation_source", "status", "attempt", "lease_owner", "lease_expires_at", "ledger_high_water_start", "ledger_high_water_end", "processed_snapshot_count", "processed_holding_count", "processed_ledger_count", "projection_cursor_security_id", "projection_active_security_id", "projection_output_offset", "idempotency_key", "started_at", "completed_at", "failure_category", "created_at", "updated_at") SELECT "id", "user_id", "portfolio_id", "range_from", "range_to", "calculation_version", "reason", "invalidation_source", "status", "attempt", "lease_owner", "lease_expires_at", "ledger_high_water_start", "ledger_high_water_end", "processed_snapshot_count", "processed_holding_count", 0, NULL, NULL, 0, "idempotency_key", "started_at", "completed_at", "failure_category", "created_at", "updated_at" FROM `calculation_runs`;--> statement-breakpoint
DROP TABLE `calculation_runs`;--> statement-breakpoint
ALTER TABLE `__new_calculation_runs` RENAME TO `calculation_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `calculation_runs_id_user_portfolio_unique` ON `calculation_runs` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calculation_runs_idempotency_unique` ON `calculation_runs` (`user_id`,`portfolio_id`,`calculation_version`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `calculation_runs_lease_idx` ON `calculation_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `calculation_runs_portfolio_status_idx` ON `calculation_runs` (`user_id`,`portfolio_id`,`status`,`created_at`);
