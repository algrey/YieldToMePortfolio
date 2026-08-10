PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_purge_audit_guards` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`purge_job_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "account_purge_audit_guards_valid_check" CHECK("__new_account_purge_audit_guards"."valid" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_account_purge_audit_guards`("owner_user_id", "purge_job_id", "expected_version", "valid") SELECT "owner_user_id", "purge_job_id", "expected_version", "valid" FROM `account_purge_audit_guards`;--> statement-breakpoint
DROP TABLE `account_purge_audit_guards`;--> statement-breakpoint
ALTER TABLE `__new_account_purge_audit_guards` RENAME TO `account_purge_audit_guards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
DROP TRIGGER `audit_events_append_only_delete`;
--> statement-breakpoint
CREATE TRIGGER `audit_events_append_only_delete`
BEFORE DELETE ON `audit_events`
WHEN NOT EXISTS (
  SELECT 1
  FROM `account_purge_jobs` pj
  JOIN `account_purge_audit_guards` g
    ON g.`owner_user_id` = pj.`owner_user_id`
   AND g.`purge_job_id` = pj.`id`
   AND g.`expected_version` = pj.`version`
   AND g.`valid` = 1
  WHERE pj.`owner_user_id` = OLD.`target_owner_user_id`
    AND pj.`status` IN ('queued', 'running')
    AND pj.`phase` = 'purge'
)
BEGIN
  SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;
