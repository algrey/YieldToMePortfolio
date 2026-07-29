CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`target_owner_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`request_id` text NOT NULL,
	`result` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_events_result_check" CHECK("audit_events"."result" IN ('success', 'failure', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_owner_time_idx` ON `audit_events` (`target_owner_user_id`,`occurred_at`);--> statement-breakpoint
CREATE TRIGGER `audit_events_append_only_update`
BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `audit_events_append_only_delete`
BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;
