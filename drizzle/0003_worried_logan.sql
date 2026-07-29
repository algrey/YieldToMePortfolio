CREATE TABLE `cash_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`currency_code` text NOT NULL,
	`completeness` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cash_accounts_completeness_check" CHECK("cash_accounts"."completeness" IN ('complete', 'opening_balance', 'incomplete')),
	CONSTRAINT "cash_accounts_status_check" CHECK("cash_accounts"."status" IN ('active', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_accounts_id_user_unique` ON `cash_accounts` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cash_accounts_id_user_portfolio_unique` ON `cash_accounts` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cash_accounts_portfolio_currency_unique` ON `cash_accounts` (`portfolio_id`,`currency_code`);--> statement-breakpoint
CREATE TABLE `cash_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`cash_account_id` text NOT NULL,
	`transaction_id` text,
	`effective_at` text NOT NULL,
	`local_effective_date` text NOT NULL,
	`type` text NOT NULL,
	`signed_amount_decimal` text NOT NULL,
	`status` text NOT NULL,
	`reverses_entry_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cash_account_id`,`user_id`,`portfolio_id`) REFERENCES `cash_accounts`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`transaction_id`,`user_id`,`portfolio_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reverses_entry_id`,`user_id`,`portfolio_id`) REFERENCES `cash_ledger_entries`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cash_entries_status_check" CHECK("cash_ledger_entries"."status" IN ('posted', 'reversed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_entries_id_user_portfolio_unique` ON `cash_ledger_entries` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cash_entries_transaction_type_unique` ON `cash_ledger_entries` (`transaction_id`,`type`);--> statement-breakpoint
CREATE INDEX `cash_entries_balance_idx` ON `cash_ledger_entries` (`cash_account_id`,`effective_at`,`id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`trade_at` text NOT NULL,
	`local_trade_date` text NOT NULL,
	`settlement_date` text,
	`quantity_decimal` text,
	`unit_price_decimal` text,
	`currency_code` text NOT NULL,
	`gross_amount_decimal` text,
	`fee_amount_decimal` text DEFAULT '0' NOT NULL,
	`tax_amount_decimal` text DEFAULT '0' NOT NULL,
	`fx_rate_to_base_decimal` text,
	`fx_rate_source` text,
	`fx_observed_at` text,
	`source_type` text NOT NULL,
	`source_reference` text,
	`import_row_id` text,
	`reverses_transaction_id` text,
	`supersedes_transaction_id` text,
	`created_by_user_id` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`created_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`currency_code`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_row_id`,`user_id`,`portfolio_id`) REFERENCES `import_rows`(`id`,`user_id`,`target_portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reverses_transaction_id`,`user_id`,`portfolio_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedes_transaction_id`,`user_id`,`portfolio_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "transactions_type_check" CHECK("transactions"."type" IN ('buy', 'sell', 'cash_deposit', 'cash_withdrawal', 'fee', 'tax', 'split', 'opening_balance')),
	CONSTRAINT "transactions_status_check" CHECK("transactions"."status" IN ('posted', 'reversed', 'superseded', 'void_pending')),
	CONSTRAINT "transactions_source_type_check" CHECK("transactions"."source_type" IN ('manual', 'csv_import', 'broker_sync', 'provider', 'system')),
	CONSTRAINT "transactions_fee_amount_check" CHECK("transactions"."fee_amount_decimal" IS NOT NULL),
	CONSTRAINT "transactions_tax_amount_check" CHECK("transactions"."tax_amount_decimal" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_id_user_unique` ON `transactions` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_id_user_portfolio_unique` ON `transactions` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_id_user_portfolio_security_unique` ON `transactions` (`id`,`user_id`,`portfolio_id`,`portfolio_security_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_portfolio_source_reference_unique` ON `transactions` (`portfolio_id`,`source_type`,`source_reference`);--> statement-breakpoint
CREATE INDEX `transactions_owner_ledger_idx` ON `transactions` (`user_id`,`portfolio_id`,`local_trade_date`,`id`);--> statement-breakpoint
CREATE INDEX `transactions_security_trade_idx` ON `transactions` (`portfolio_id`,`portfolio_security_id`,`trade_at`);