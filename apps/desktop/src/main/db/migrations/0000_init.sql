CREATE TABLE `agent_roots` (
	`agent_id` text NOT NULL,
	`path` text NOT NULL,
	`mode` text NOT NULL,
	PRIMARY KEY(`agent_id`, `path`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_roots_mode_check" CHECK("agent_roots"."mode" IN ('read','readwrite'))
);
--> statement-breakpoint
CREATE TABLE `agent_tool_servers` (
	`agent_id` text NOT NULL,
	`tool_server_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_server_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_server_id`) REFERENCES `tool_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text NOT NULL,
	`connection_id` text NOT NULL,
	`model` text,
	`role` text DEFAULT '' NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`permission_policy` text DEFAULT 'ask' NOT NULL,
	`fallback_connection_ids` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_agents_connection` ON `agents` (`connection_id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secret_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "connections_kind_check" CHECK("connections"."kind" IN ('api','cli'))
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`harness_session_id` text,
	`archived` integer DEFAULT false NOT NULL,
	`last_activity_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_agent` ON `conversations` (`agent_id`,`archived`,"last_activity_at" DESC);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'complete' NOT NULL,
	`seq` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "messages_role_check" CHECK("messages"."role" IN ('user','assistant','tool'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_conv_seq` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `tool_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`tool_server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`input` text NOT NULL,
	`decision` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tool_approvals_decision_check" CHECK("tool_approvals"."decision" IN ('allow','deny','allow-always'))
);
--> statement-breakpoint
CREATE INDEX `idx_approvals_always` ON `tool_approvals` (`agent_id`,`tool_server_id`,`tool_name`) WHERE "tool_approvals"."decision" = 'allow-always';--> statement-breakpoint
CREATE TABLE `tool_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`url` text,
	`headers` text DEFAULT '{}' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "tool_servers_transport_check" CHECK("tool_servers"."transport" IN ('stdio','http'))
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`estimated` integer DEFAULT false NOT NULL,
	`cost_usd` real,
	`latency_ms` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_conn_time` ON `usage_records` (`connection_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_agent_time` ON `usage_records` (`agent_id`,`created_at`);