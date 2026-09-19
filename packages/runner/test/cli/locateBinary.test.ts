import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { locateBinary } from '../../src/providers/cli/locateBinary.js';

const root = mkdtempSync(join(tmpdir(), 'comitiva-locate-'));
const onPath = join(root, 'path');
const installed = join(root, 'installed');
mkdirSync(onPath);
mkdirSync(installed);
const make = (path: string, mode = 0o755) => {
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, mode);
  return path;
};

describe.skipIf(process.platform === 'win32')('locateBinary', () => {
  it('uses an explicit path when it is executable', async () => {
    const bin = make(join(root, 'my-claude'));
    await expect(
      locateBinary({ name: 'claude', label: 'Claude Code', explicit: bin }),
    ).resolves.toBe(bin);
  });

  it('says where it looked when the explicit path is wrong', async () => {
    const notExec = make(join(root, 'not-exec'), 0o644);
    await expect(
      locateBinary({ name: 'claude', label: 'Claude Code', explicit: notExec }),
    ).rejects.toMatchObject({
      code: 'binary_not_found',
      message: `Claude Code not found at ${notExec}`,
    });
    await expect(
      locateBinary({ name: 'claude', label: 'Claude Code', explicit: 'relative/claude' }),
    ).rejects.toMatchObject({ code: 'binary_not_found', message: /must be absolute/ });
  });

  it('searches PATH first, then the install dirs', async () => {
    const env = { PATH: onPath };
    const late = make(join(installed, 'codex'));
    await expect(
      locateBinary({ name: 'codex', label: 'Codex', env, extraDirs: [installed] }),
    ).resolves.toBe(late);
    const early = make(join(onPath, 'codex'));
    await expect(
      locateBinary({ name: 'codex', label: 'Codex', env, extraDirs: [installed] }),
    ).resolves.toBe(early);
  });

  it('fails with an actionable message when nothing is found', async () => {
    await expect(
      locateBinary({ name: 'nothing-here', label: 'X', env: { PATH: onPath }, extraDirs: [] }),
    ).rejects.toMatchObject({ code: 'binary_not_found', message: /set the binary path/ });
  });
});
