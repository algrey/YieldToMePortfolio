CREATE TABLE `corporate_action_refresh_state` (
	`security_id` text PRIMARY KEY NOT NULL,
	`last_attempted_at` text NOT NULL,
	`last_status` text,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "corporate_action_refresh_state_status_check" CHECK("corporate_action_refresh_state"."last_status" IS NULL OR "corporate_action_refresh_state"."last_status" IN ('ok', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_events_active_natural_key_unique` ON `dividend_events` (`security_id`,`provider_id`,`ex_date`) WHERE "dividend_events"."status" <> 'superseded';--> statement-breakpoint
CREATE UNIQUE INDEX `split_events_active_natural_key_unique` ON `split_events` (`security_id`,`provider_id`,`effective_date`) WHERE "split_events"."status" <> 'superseded';