PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cash_ledger_entries` (
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
	CONSTRAINT "cash_entries_status_check" CHECK("__new_cash_ledger_entries"."status" IN ('posted', 'reversed')),
	CONSTRAINT "cash_entries_type_check" CHECK("__new_cash_ledger_entries"."type" IN ('cash_deposit', 'cash_withdrawal', 'fee', 'tax', 'opening_balance', 'split'))
);
--> statement-breakpoint
INSERT INTO `__new_cash_ledger_entries`("id", "user_id", "portfolio_id", "cash_account_id", "transaction_id", "effective_at", "local_effective_date", "type", "signed_amount_decimal", "status", "reverses_entry_id", "created_at") SELECT "id", "user_id", "portfolio_id", "cash_account_id", "transaction_id", "effective_at", "local_effective_date", "type", "signed_amount_decimal", "status", "reverses_entry_id", "created_at" FROM `cash_ledger_entries`;--> statement-breakpoint
DROP TABLE `cash_ledger_entries`;--> statement-breakpoint
ALTER TABLE `__new_cash_ledger_entries` RENAME TO `cash_ledger_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cash_entries_id_user_portfolio_unique` ON `cash_ledger_entries` (`id`,`user_id`,`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cash_entries_transaction_type_unique` ON `cash_ledger_entries` (`transaction_id`,`type`);--> statement-breakpoint
CREATE INDEX `cash_entries_balance_idx` ON `cash_ledger_entries` (`cash_account_id`,`effective_at`,`id`);