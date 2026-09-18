import { app } from 'electron';
import { join } from 'node:path';

/** Resolves bundled resources in dev (monorepo) and in packaged builds. */
export const paths = {
  runnerEntry(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'runner', 'bin.cjs')
      : join(app.getAppPath(), '..', '..', 'packages', 'runner', 'dist', 'bin.cjs');
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
  log(name: string): string {
    return join(app.getPath('userData'), 'logs', name);
  },
};
