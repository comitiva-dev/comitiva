CREATE TABLE `agent_guidelines` (
	`agent_id` text NOT NULL,
	`guideline_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `guideline_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guideline_id`) REFERENCES `guidelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `guidelines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT 'agents' NOT NULL,
	`agent_tags` text DEFAULT '[]' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "guidelines_scope_check" CHECK("guidelines"."scope" IN ('all','tags','agents'))
);
