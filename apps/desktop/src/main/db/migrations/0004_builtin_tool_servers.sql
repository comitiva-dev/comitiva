-- Phase 5: the built-in filesystem MCP server, enabled by default. Its launch
-- command is resolved by the shell at run time (the app's own Node binary and
-- the bundled filesystem.cjs), so `command` stays NULL here. The id is fixed
-- (FILESYSTEM_TOOL_SERVER_ID in @comitiva/contract).
INSERT OR IGNORE INTO `tool_servers` (`id`, `name`, `transport`, `command`, `args`, `env`, `url`, `headers`, `builtin`, `enabled`, `created_at`)
VALUES ('filesystem', 'Files', 'stdio', NULL, '[]', '{}', NULL, '{}', 1, 1, '2026-09-21T00:00:00.000Z');
