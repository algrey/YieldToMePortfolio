CREATE TABLE `account_purge_audit_guards` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`purge_job_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "account_purge_audit_guards_valid_check" CHECK("account_purge_audit_guards"."valid" = 1)
);
