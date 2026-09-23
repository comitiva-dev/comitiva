import { app } from 'electron';
import { join } from 'node:path';

/** Resolves bundled resources in dev (monorepo) and in packaged builds. */
export const paths = {
  runnerEntry(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'runner', 'bin.cjs')
      : join(app.getAppPath(), '..', '..', 'packages', 'runner', 'dist', 'bin.cjs');
  },
  /** The built-in filesystem MCP server, run with the app's own binary in Node mode. */
  filesystemServer(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'mcp-servers', 'filesystem.cjs')
      : join(app.getAppPath(), '..', '..', 'packages', 'mcp-servers', 'dist', 'filesystem.cjs');
  },
  /** The built-in Google Drive MCP server, run the same way. */
  googleDriveServer(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'mcp-servers', 'google-drive.cjs')
      : join(app.getAppPath(), '..', '..', 'packages', 'mcp-servers', 'dist', 'google-drive.cjs');
  },
  migrations(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'migrations')
      : join(app.getAppPath(), 'src', 'main', 'db', 'migrations');
  },
  database(): string {
    return join(app.getPath('userData'), 'comitiva.db');
  },
  secrets(): string {
    return join(app.getPath('userData'), 'secrets.bin');
  },
  /** Files attached in the composer (ADR 0012). */
  attachments(): string {
    return join(app.getPath('userData'), 'attachments');
  },
  /** Default working directories of CLI harness conversations. */
  workspaces(): string {
    return join(app.getPath('userData'), 'workspaces');
  },
  log(name: string): string {
    return join(app.getPath('userData'), 'logs', name);
  },
};
