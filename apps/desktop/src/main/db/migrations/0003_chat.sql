ALTER TABLE `conversations` ADD `harness_connection_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `last_read_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `error` text;