/**
 * Built-in MCP servers. Like the runner, these are plain Node processes with
 * no Electron dependency. `filesystem` shipped in Phase 5, `google-drive` in 5b.
 */
export const BUILTIN_SERVERS = ['filesystem', 'google-drive'] as const;
export type BuiltinServer = (typeof BUILTIN_SERVERS)[number];

export {
  createFilesystemServer,
  parseArgs,
  type FilesystemServerOptions,
} from './filesystem/server.js';
export { GuardError, RootGuard, type Root, type RootMode } from './filesystem/RootGuard.js';
export {
  createGoogleDriveServer,
  parseArgs as parseGoogleDriveArgs,
  type GoogleDriveServerOptions,
} from './google-drive/server.js';
export { DriveApi, DriveError, DEFAULT_GOOGLE_API_BASE_URL } from './google-drive/DriveApi.js';
