import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema (docs/design.md §3.2). Migrations are generated from this file
 * with `pnpm --filter desktop db:generate` and committed. JSON columns are TEXT
 * validated by zod in repositories; dates are ISO 8601 UTC; ids are ULIDs.
 */

const json = (name: string, fallback: '[]' | '{}') =>
  text(name, { mode: 'json' })
    .notNull()
    .default(sql.raw(`'${fallback}'`));

export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['api', 'cli'] }).notNull(),
    provider: text('provider').notNull(),
    config: json('config', '{}'),
    secretRef: text('secret_ref'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // Last "Test connection" outcome, shown in the connections list.
    lastTestAt: text('last_test_at'),
    lastTestOk: integer('last_test_ok', { mode: 'boolean' }),
    lastTestLatencyMs: integer('last_test_latency_ms'),
    lastTestErrorCode: text('last_test_error_code'),
  },
  (t) => [check('connections_kind_check', sql`${t.kind} IN ('api','cli')`)],
);

export const toolServers = sqliteTable(
  'tool_servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
    command: text('command'),
    args: json('args', '[]'),
    env: json('env', '{}'),
    url: text('url'),
    headers: json('headers', '{}'),
    builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (t) => [check('tool_servers_transport_check', sql`${t.transport} IN ('stdio','http')`)],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    avatar: text('avatar').notNull(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    model: text('model'),
    role: text('role').notNull().default(''),
    params: json('params', '{}'),
    permissionPolicy: text('permission_policy').notNull().default('ask'),
    fallbackConnectionIds: json('fallback_connection_ids', '[]'),
    tags: json('tags', '[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_agents_connection').on(t.connectionId)],
);

export const agentRoots = sqliteTable(
  'agent_roots',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    mode: text('mode', { enum: ['read', 'readwrite'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.path] }),
    check('agent_roots_mode_check', sql`${t.mode} IN ('read','readwrite')`),
  ],
);

export const agentToolServers = sqliteTable(
  'agent_tool_servers',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    toolServerId: text('tool_server_id')
      .notNull()
      .references(() => toolServers.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.toolServerId] })],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title'),
    status: text('status').notNull().default('idle'),
    harnessSessionId: text('harness_session_id'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    lastActivityAt: text('last_activity_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_conversations_agent').on(t.agentId, t.archived, sql`${t.lastActivityAt} DESC`),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    content: json('content', '[]'),
    status: text('status').notNull().default('complete'),
    seq: integer('seq').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_messages_conv_seq').on(t.conversationId, t.seq),
    check('messages_role_check', sql`${t.role} IN ('user','assistant','tool')`),
  ],
);

export const toolApprovals = sqliteTable(
  'tool_approvals',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    toolServerId: text('tool_server_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolUseId: text('tool_use_id').notNull(),
    input: text('input', { mode: 'json' }).notNull(),
    decision: text('decision', { enum: ['allow', 'deny', 'allow-always'] }).notNull(),
    decidedAt: text('decided_at').notNull(),
  },
  (t) => [
    index('idx_approvals_always')
      .on(t.agentId, t.toolServerId, t.toolName)
      .where(sql`${t.decision} = 'allow-always'`),
    check('tool_approvals_decision_check', sql`${t.decision} IN ('allow','deny','allow-always')`),
  ],
);

export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').notNull(),
    agentId: text('agent_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    estimated: integer('estimated', { mode: 'boolean' }).notNull().default(false),
    costUsd: real('cost_usd'),
    latencyMs: integer('latency_ms'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_usage_conn_time').on(t.connectionId, t.createdAt),
    index('idx_usage_agent_time').on(t.agentId, t.createdAt),
  ],
);
