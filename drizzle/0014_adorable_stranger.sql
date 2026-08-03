CREATE TABLE `holding_projections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`quantity_decimal` text NOT NULL,
	`native_open_basis_decimal` text,
	`base_open_basis_decimal` text,
	`average_base_cost_decimal` text,
	`completeness` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`last_ledger_high_water` text NOT NULL,
	`calculation_run_id` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`rebuilt_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`calculation_run_id`,`user_id`,`portfolio_id`) REFERENCES `calculation_runs`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "holding_projections_completeness_check" CHECK("holding_projections"."completeness" IN ('complete', 'partial', 'incomplete')),
	CONSTRAINT "holding_projections_status_check" CHECK("holding_projections"."status" IN ('ready', 'invalidated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holding_projections_id_user_portfolio_unique` ON `holding_projections` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `holding_projections_portfolio_security_unique` ON `holding_projections` (`portfolio_id`,`portfolio_security_id`);--> statement-breakpoint
CREATE INDEX `holding_projections_owner_portfolio_idx` ON `holding_projections` (`user_id`,`portfolio_id`,`status`);--> statement-breakpoint
CREATE TABLE `lot_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`sell_transaction_id` text NOT NULL,
	`tax_lot_id` text NOT NULL,
	`allocation_sequence` integer NOT NULL,
	`matched_quantity_decimal` text NOT NULL,
	`allocated_base_basis_decimal` text,
	`base_net_proceeds_decimal` text,
	`fee_base_decimal` text,
	`tax_base_decimal` text,
	`base_realised_gain_decimal` text,
	`basis_status` text NOT NULL,
	`calculation_run_id` text NOT NULL,
	`calculation_version` integer NOT NULL,
	FOREIGN KEY (`sell_transaction_id`,`user_id`,`portfolio_id`,`portfolio_security_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`,`portfolio_security_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tax_lot_id`,`user_id`,`portfolio_id`,`portfolio_security_id`) REFERENCES `tax_lots`(`id`,`user_id`,`portfolio_id`,`portfolio_security_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`calculation_run_id`,`user_id`,`portfolio_id`) REFERENCES `calculation_runs`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "lot_allocations_basis_status_check" CHECK("lot_allocations"."basis_status" IN ('complete', 'incomplete_fx', 'incomplete_basis'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lot_allocations_sell_lot_sequence_unique` ON `lot_allocations` (`sell_transaction_id`,`tax_lot_id`,`allocation_sequence`);--> statement-breakpoint
CREATE INDEX `lot_allocations_owner_sell_idx` ON `lot_allocations` (`user_id`,`portfolio_id`,`sell_transaction_id`);--> statement-breakpoint
CREATE TABLE `tax_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`opening_transaction_id` text NOT NULL,
	`acquired_at` text NOT NULL,
	`original_quantity_decimal` text NOT NULL,
	`open_quantity_decimal` text NOT NULL,
	`native_basis_decimal` text,
	`base_basis_decimal` text,
	`basis_status` text NOT NULL,
	`status` text NOT NULL,
	`calculation_run_id` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`rebuilt_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`opening_transaction_id`,`user_id`,`portfolio_id`,`portfolio_security_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`,`portfolio_security_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`calculation_run_id`,`user_id`,`portfolio_id`) REFERENCES `calculation_runs`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tax_lots_basis_status_check" CHECK("tax_lots"."basis_status" IN ('complete', 'incomplete_fx', 'incomplete_basis')),
	CONSTRAINT "tax_lots_status_check" CHECK("tax_lots"."status" IN ('open', 'closed', 'incomplete'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_lots_id_user_unique` ON `tax_lots` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tax_lots_opening_transaction_unique` ON `tax_lots` (`opening_transaction_id`);--> statement-breakpoint
CREATE INDEX `tax_lots_fifo_idx` ON `tax_lots` (`portfolio_id`,`portfolio_security_id`,`acquired_at`,`id`);