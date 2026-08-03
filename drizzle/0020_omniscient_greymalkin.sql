CREATE TABLE `ledger_mutation_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`portfolio_security_id` text NOT NULL,
	`valid` integer NOT NULL,
	FOREIGN KEY (`portfolio_security_id`,`user_id`,`portfolio_id`) REFERENCES `portfolio_securities`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ledger_mutation_guards_valid_check" CHECK("ledger_mutation_guards"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE `manual_ledger_mutation_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`purpose` text NOT NULL,
	`target_transaction_id` text,
	`result_transaction_id` text,
	`status` text DEFAULT 'issued' NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`portfolio_id`,`user_id`) REFERENCES `portfolios`(`id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_transaction_id`,`user_id`,`portfolio_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`result_transaction_id`,`user_id`,`portfolio_id`) REFERENCES `transactions`(`id`,`user_id`,`portfolio_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "manual_ledger_mutation_keys_purpose_check" CHECK("manual_ledger_mutation_keys"."purpose" IN ('create', 'reverse', 'supersede')),
	CONSTRAINT "manual_ledger_mutation_keys_status_check" CHECK("manual_ledger_mutation_keys"."status" IN ('issued', 'used')),
	CONSTRAINT "manual_ledger_mutation_keys_target_check" CHECK(("manual_ledger_mutation_keys"."purpose" = 'create' AND "manual_ledger_mutation_keys"."target_transaction_id" IS NULL) OR ("manual_ledger_mutation_keys"."purpose" IN ('reverse', 'supersede') AND "manual_ledger_mutation_keys"."target_transaction_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `manual_ledger_mutation_keys_owner_portfolio_idx` ON `manual_ledger_mutation_keys` (`user_id`,`portfolio_id`,`status`,`expires_at`);