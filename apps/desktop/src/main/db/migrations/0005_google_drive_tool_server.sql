-- Phase 5b: the built-in Google Drive MCP server, enabled by default (it does
-- nothing until the user connects an account on the Tools screen). Like the
-- filesystem server, its launch is resolved by the shell at run time (the
-- app's own Node binary, the bundled google-drive.cjs and a fresh access
-- token), so `command` stays NULL here. The id is fixed
-- (GOOGLE_DRIVE_TOOL_SERVER_ID in @comitiva/contract).
INSERT OR IGNORE INTO `tool_servers` (`id`, `name`, `transport`, `command`, `args`, `env`, `url`, `headers`, `builtin`, `enabled`, `created_at`)
VALUES ('google-drive', 'Google Drive', 'stdio', NULL, '[]', '{}', NULL, '{}', 1, 1, '2026-09-22T00:00:00.000Z');
