import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const binPath = fileURLToPath(new URL('../dist/filesystem.cjs', import.meta.url));
let dir: string;
let client: Client | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-fs-bin-')));
});
afterEach(async () => {
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('comitiva-mcp-filesystem (dist/filesystem.cjs over stdio)', () => {
  it('serves its roots and writes when gated by the client', async () => {
    client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [binPath, '--root', `${dir}:readwrite`, '--gated-by-client'],
        stderr: 'pipe',
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(7);
    await client.callTool({ name: 'write_file', arguments: { path: 'hi.txt', content: 'hi' } });
    expect(await readFile(join(dir, 'hi.txt'), 'utf8')).toBe('hi');
    const out = (await client.callTool({
      name: 'read_file',
      arguments: { path: '/etc/hostname' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toMatch(/^outside_roots/);
  });
});
