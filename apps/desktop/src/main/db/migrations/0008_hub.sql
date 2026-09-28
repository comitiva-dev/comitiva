CREATE TABLE `hub_agent_links` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text,
	`roots` text DEFAULT '[]' NOT NULL,
	`tool_server_ids` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hub_always_allowed` (
	`agent_id` text NOT NULL,
	`tool_server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`decided_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_server_id`, `tool_name`)
);
--> statement-breakpoint
CREATE TABLE `hub_harness_sessions` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`harness_session_id` text NOT NULL,
	`connection_id` text NOT NULL
);
