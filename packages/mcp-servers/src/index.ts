/**
 * Built-in MCP servers. Like the runner, these are plain Node processes with
 * no Electron dependency. `filesystem` ships in Phase 5; `google-drive` in 5b.
 */
export const BUILTIN_SERVERS = ['filesystem', 'google-drive'] as const;
export type BuiltinServer = (typeof BUILTIN_SERVERS)[number];

export {
  createFilesystemServer,
  parseArgs,
  type FilesystemServerOptions,
} from './filesystem/server.js';
export { GuardError, RootGuard, type Root, type RootMode } from './filesystem/RootGuard.js';
