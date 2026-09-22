CREATE TABLE `model_prices` (
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_per_1m` real NOT NULL,
	`output_per_1m` real NOT NULL,
	`cache_read_per_1m` real,
	`cache_write_per_1m` real,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`provider`, `model`)
);
--> statement-breakpoint
ALTER TABLE `usage_records` ADD `provider` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `cost_source` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `cost_estimated` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_usage_time` ON `usage_records` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_model_time` ON `usage_records` (`provider`,`model`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_conv` ON `usage_records` (`conversation_id`);
--> statement-breakpoint
-- Phase 6. Rows written before this migration have no provider of their own;
-- take it from the connection they were charged to. A connection deleted
-- since then leaves the row with '', which the dashboard shows as unpriced.
UPDATE `usage_records`
SET `provider` = COALESCE(
  (SELECT `provider` FROM `connections` WHERE `connections`.`id` = `usage_records`.`connection_id`),
  ''
)
WHERE `provider` = '';
