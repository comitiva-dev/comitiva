import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quote } from '../src/google-drive/DriveApi.js';
import { createGoogleDriveServer, parseArgs } from '../src/google-drive/server.js';
import { startFakeGoogle, type FakeFile, type FakeGoogle } from '../src/testing/fakeGoogle.js';

const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const FOLDER = 'application/vnd.google-apps.folder';
const TOKEN = 'ya29.test-token';

let google: FakeGoogle;
const clients: Client[] = [];
let plan: FakeFile;
let budget: FakeFile;
let archive: FakeFile;

beforeAll(async () => {
  google = await startFakeGoogle();
  google.addToken(TOKEN);
});
afterAll(() => google.close());
beforeEach(() => {
  google.files.clear();
  google.requests.length = 0;
  plan = google.addFile({ name: 'Launch plan', mimeType: DOC, content: '# Plan\n\n- ship it\n' });
  budget = google.addFile({
    name: 'Budget 2026',
    mimeType: SHEET,
    content: 'item,cost\nads,100\n',
  });
  archive = google.addFile({ name: 'Archive', mimeType: FOLDER });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(gatedByClient = true, accessToken = TOKEN): Promise<Client> {
  const server = createGoogleDriveServer({ accessToken, apiBaseUrl: google.url, gatedByClient });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  };
  return {
    isError: r.isError === true,
    text: r.content.flatMap((c) => (c.text ? [c.text] : [])).join('\n'),
    content: r.content,
  };
}

describe('google-drive server: tools and annotations', () => {
  it('registers read tools always and write tools only when gated by the client', async () => {
    const readOnly = await connect(false);
    const names = (await readOnly.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['search', 'read']);

    const gated = await connect(true);
    const tools = (await gated.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(['search', 'read', 'create', 'update', 'move']);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.search?.readOnlyHint).toBe(true);
    expect(hints.read?.readOnlyHint).toBe(true);
    expect(hints.create).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.update).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints.move).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.every((t) => t.annotations?.openWorldHint === true)).toBe(true);
  });

  it('sends the token as a bearer on every call', async () => {
    const client = await connect();
    await call(client, 'search', {});
    expect(google.requests.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('parses --gated-by-client and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ gatedByClient: false });
    expect(parseArgs(['--gated-by-client'])).toEqual({ gatedByClient: true });
    expect(() => parseArgs(['--token', 'x'])).toThrow(/Unknown argument/);
  });
});

describe('search', () => {
  it('finds by name or content, newest first without a query', async () => {
    const client = await connect();
    const byText = await call(client, 'search', { query: 'ship' });
    expect(byText.text).toContain('"Launch plan"');
    expect(byText.text).toContain(`id ${plan.id}`);
    expect(byText.text).toContain('Google Doc');
    expect(byText.text).not.toContain('Budget');
    const q = google.requests.at(-1)!.query;
    expect(q.q).toBe("trashed = false and (name contains 'ship' or fullText contains 'ship')");
    expect(q.orderBy).toBeUndefined();
    expect(q.supportsAllDrives).toBe('true');
    expect(q.includeItemsFromAllDrives).toBe('true');

    const all = await call(client, 'search', {});
    expect(google.requests.at(-1)!.query.orderBy).toBe('modifiedTime desc');
    expect(all.text.indexOf('Archive')).toBeLessThan(all.text.indexOf('Launch plan'));
  });

  it('filters by type and folder, and pages', async () => {
    const inside = google.addFile({
      name: 'Old notes',
      mimeType: 'text/plain',
      parents: [archive.id],
    });
    const client = await connect();
    const sheets = await call(client, 'search', { type: 'sheet' });
    expect(sheets.text).toContain('Budget 2026');
    expect(sheets.text).not.toContain('Launch plan');
    const folder = await call(client, 'search', { folderId: archive.id });
    expect(folder.text).toContain(inside.name);
    expect(folder.text).not.toContain('Budget');
    const first = await call(client, 'search', { pageSize: 2 });
    const token = /pageToken (\S+)/.exec(first.text)?.[1];
    expect(token).toBeDefined();
    const second = await call(client, 'search', { pageSize: 2, pageToken: token });
    expect(second.text).not.toContain('pageToken');
    expect(await call(client, 'search', { query: 'nothing like this' })).toMatchObject({
      text: 'No files found.',
    });
  });

  it('escapes quotes and backslashes in the query', async () => {
    google.addFile({ name: "Ana's \\ notes", mimeType: 'text/plain' });
    const client = await connect();
    const r = await call(client, 'search', { query: "Ana's \\" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Ana's \\ notes");
    expect(google.requests.at(-1)!.query.q).toContain("'Ana\\'s \\\\'");
    expect(quote("a'b\\c")).toBe("'a\\'b\\\\c'");
  });
});

describe('read', () => {
  it('reads a Google Doc as Markdown and a Sheet as CSV', async () => {
    const client = await connect();
    const doc = await call(client, 'read', { fileId: plan.id });
    expect(doc.isError).toBe(false);
    expect(doc.text).toContain('# Plan\n\n- ship it');
    expect(google.requests.at(-1)!.query.mimeType).toBe('text/markdown');
    const sheet = await call(client, 'read', { fileId: budget.id });
    expect(sheet.text).toContain('item,cost\nads,100');
    expect(google.requests.at(-1)!.query.mimeType).toBe('text/csv');
  });

  it('reads text files, caps large ones, and returns images as images', async () => {
    const notes = google.addFile({ name: 'notes.md', mimeType: 'text/markdown', content: 'hello' });
    const big = google.addFile({
      name: 'big.log',
      mimeType: 'text/plain',
      content: 'x'.repeat(1024 * 1024 + 10),
    });
    const png = google.addFile({
      name: 'logo.png',
      mimeType: 'image/png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const client = await connect();
    expect((await call(client, 'read', { fileId: notes.id })).text).toContain('hello');
    expect(google.requests.at(-1)!.range).toBeUndefined();
    const capped = await call(client, 'read', { fileId: big.id });
    expect(capped.text).toContain('[truncated at 1 MB]');
    expect(google.requests.at(-1)!.range).toBe(`bytes=0-${1024 * 1024 - 1}`);
    const image = await call(client, 'read', { fileId: png.id });
    expect(image.content[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBORw==',
    });
  });

  it('refuses folders, binaries and unknown ids with stable codes', async () => {
    const pdf = google.addFile({ name: 'scan.pdf', mimeType: 'application/pdf', content: '%PDF' });
    const client = await connect();
    expect((await call(client, 'read', { fileId: archive.id })).text).toMatch(/^invalid_request: /);
    expect((await call(client, 'read', { fileId: pdf.id })).text).toMatch(/^unsupported_content: /);
    const missing = await call(client, 'read', { fileId: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^not_found: /);
  });
});

describe('create, update, move', () => {
  it('creates a Google Doc from Markdown in a folder', async () => {
    const client = await connect();
    const r = await call(client, 'create', {
      name: 'Summary',
      kind: 'doc',
      content: '# Summary\n\nAll good.',
      parentId: archive.id,
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Created "Summary" · id \S+ · Google Doc/);
    const created = [...google.files.values()].find((f) => f.name === 'Summary')!;
    expect(created.mimeType).toBe(DOC);
    expect(created.parents).toEqual([archive.id]);
    expect(created.content.toString()).toBe('# Summary\n\nAll good.');
    const req = google.requests.at(-1)!;
    expect(req.path).toBe('/upload/drive/v3/files');
    expect(req.query.uploadType).toBe('multipart');
    expect(req.body).toContain('Content-Type: text/markdown; charset=UTF-8');
  });

  it('creates a sheet from CSV, a text file and a folder', async () => {
    const client = await connect();
    await call(client, 'create', { name: 'Costs', kind: 'sheet', content: 'a,b\n1,2' });
    await call(client, 'create', {
      name: 'a.json',
      kind: 'text',
      mimeType: 'application/json',
      content: '{}',
    });
    await call(client, 'create', { name: 'Reports', kind: 'folder' });
    const byName = (n: string) => [...google.files.values()].find((f) => f.name === n)!;
    expect(byName('Costs').mimeType).toBe(SHEET);
    expect(byName('a.json').mimeType).toBe('application/json');
    expect(byName('Reports')).toMatchObject({ mimeType: FOLDER, parents: ['root'] });
    expect(
      (await call(client, 'create', { name: 'x', kind: 'text', mimeType: 'application/zip' })).text,
    ).toMatch(/^invalid_request: /);
    expect(
      (await call(client, 'create', { name: 'F', kind: 'folder', content: 'x' })).text,
    ).toMatch(/^invalid_request: /);
  });

  it("replaces a Doc's content and renames it", async () => {
    const client = await connect();
    const r = await call(client, 'update', {
      fileId: plan.id,
      content: '# New plan',
      name: 'Plan v2',
    });
    expect(r.text).toMatch(/^Updated "Plan v2"/);
    expect(plan.content.toString()).toBe('# New plan');
    expect(google.requests.at(-1)!.body).toContain('Content-Type: text/markdown; charset=UTF-8');
    await call(client, 'update', { fileId: plan.id, name: 'Plan v3' });
    expect(plan.name).toBe('Plan v3');
    expect((await call(client, 'update', { fileId: plan.id })).text).toMatch(/^invalid_request: /);
    expect((await call(client, 'update', { fileId: archive.id, content: 'x' })).text).toMatch(
      /^invalid_request: /,
    );
  });

  it('moves a file between folders', async () => {
    const client = await connect();
    const r = await call(client, 'move', { fileId: plan.id, toFolderId: archive.id });
    expect(r.text).toMatch(/^Moved "Launch plan"/);
    expect(plan.parents).toEqual([archive.id]);
    const req = google.requests.at(-1)!;
    expect(req.query).toMatchObject({ addParents: archive.id, removeParents: 'root' });
    expect((await call(client, 'move', { fileId: plan.id, toFolderId: 'nope' })).text).toMatch(
      /^not_found: /,
    );
  });
});

describe('errors', () => {
  it('maps Google failures to stable codes', async () => {
    const client = await connect();
    google.failNext(429, 'rateLimitExceeded');
    expect((await call(client, 'search', {})).text).toMatch(/^rate_limited: /);
    google.failNext(403, 'userRateLimitExceeded');
    expect((await call(client, 'search', {})).text).toMatch(/^rate_limited: /);
    google.failNext(403, 'insufficientFilePermissions');
    expect((await call(client, 'search', {})).text).toMatch(/^tool_failed: Google Drive error 403/);
    google.failNext(500);
    expect((await call(client, 'search', {})).text).toMatch(/^tool_failed: /);
  });

  it('reports a rejected token as auth_failed with what to do', async () => {
    const client = await connect(true, 'expired-token');
    const r = await call(client, 'search', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^auth_failed: .*reconnect Google Drive/);
    expect(r.text).not.toContain('expired-token');
  });

  it('reports an unreachable API as tool_failed', async () => {
    const server = createGoogleDriveServer({
      accessToken: TOKEN,
      apiBaseUrl: 'http://127.0.0.1:1',
      gatedByClient: false,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    expect((await call(client, 'search', {})).text).toMatch(
      /^tool_failed: Google Drive is unreachable/,
    );
  });
});
