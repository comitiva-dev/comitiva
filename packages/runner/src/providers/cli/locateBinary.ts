import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { AppError } from '@comitiva/contract';

/**
 * Finds a harness binary. An explicit path must exist and be executable.
 * Otherwise PATH is searched, then the usual install locations: an app
 * launched from the desktop often gets a shorter PATH than a terminal.
 */
export async function locateBinary(opts: {
  name: string;
  label: string;
  explicit?: string | undefined;
  env?: NodeJS.ProcessEnv;
  extraDirs?: string[];
}): Promise<string> {
  const env = opts.env ?? process.env;
  const explicit = opts.explicit?.trim();
  if (explicit) {
    const path = expandHome(explicit);
    if (!isAbsolute(path)) {
      throw new AppError(
        'binary_not_found',
        `${opts.label} binary path must be absolute: ${explicit}`,
      );
    }
    if (await isExecutable(path)) return path;
    throw new AppError('binary_not_found', `${opts.label} not found at ${path}`);
  }

  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
    ...(opts.extraDirs ?? defaultInstallDirs(env)),
  ];
  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, opts.name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  throw new AppError(
    'binary_not_found',
    `\`${opts.name}\` was not found on PATH or in the usual install locations; set the binary path`,
  );
}

/** Where installers put the binaries when they are not on a GUI app's PATH. */
export function defaultInstallDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [join(appData, 'npm'), join(home, '.local', 'bin')];
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}
