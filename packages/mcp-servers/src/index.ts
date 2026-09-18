/**
 * Built-in MCP servers. Phase 0 only reserves the package; the `filesystem`
 * server (with RootGuard) lands in Phase 5 and `google-drive` in Phase 5b.
 * Like the runner, these are plain Node processes with no Electron dependency.
 */
export const BUILTIN_SERVERS = ['filesystem', 'google-drive'] as const;
export type BuiltinServer = (typeof BUILTIN_SERVERS)[number];
