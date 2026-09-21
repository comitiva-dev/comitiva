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
  /** Default working directories of CLI harness conversations. */
  workspaces(): string {
    return join(app.getPath('userData'), 'workspaces');
  },
  log(name: string): string {
    return join(app.getPath('userData'), 'logs', name);
  },
};
