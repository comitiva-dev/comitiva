import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGoogle, type FakeGoogle } from '../src/testing/fakeGoogle.js';

const binPath = fileURLToPath(new URL('../dist/google-drive.cjs', import.meta.url));
let google: FakeGoogle;
let home: string;
let client: Client | undefined;

beforeAll(async () => {
  google = await startFakeGoogle();
  google.addToken('ya29.bin-token');
  home = await mkdtemp(join(tmpdir(), 'comitiva-gdrive-home-'));
});
afterAll(async () => {
  await google.close();
  await rm(home, { recursive: true, force: true });
});
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('comitiva-mcp-gdrive (dist/google-drive.cjs over stdio)', () => {
  it('takes the token from env, reads and creates, and writes nothing to disk', async () => {
    const doc = google.addFile({
      name: 'Brief',
      mimeType: 'application/vnd.google-apps.document',
      content: 'Launch on Monday',
    });
    client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [binPath, '--gated-by-client'],
        // Only what the runner passes: no HOME config, no credentials files.
        env: {
          HOME: home,
          USERPROFILE: home,
          GDRIVE_ACCESS_TOKEN: 'ya29.bin-token',
          GDRIVE_API_BASE_URL: google.url,
        },
        stderr: 'pipe',
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'search',
      'read',
      'create',
      'update',
      'move',
    ]);
    const read = (await client.callTool({ name: 'read', arguments: { fileId: doc.id } })) as {
      content: Array<{ text: string }>;
    };
    expect(read.content[0]?.text).toContain('Launch on Monday');
    await client.callTool({
      name: 'create',
      arguments: { name: 'Notes', kind: 'doc', content: '# Notes' },
    });
    expect([...google.files.values()].some((f) => f.name === 'Notes')).toBe(true);
    expect(await readdir(home)).toEqual([]);
  });

  it('exits with an error when no token is given', () => {
    const r = spawnSync(process.execPath, [binPath], {
      env: { HOME: home },
      input: '',
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GDRIVE_ACCESS_TOKEN is not set');
  });
});
