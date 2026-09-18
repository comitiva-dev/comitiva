ALTER TABLE `connections` ADD `last_test_at` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `last_test_ok` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `last_test_latency_ms` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `last_test_error_code` text;