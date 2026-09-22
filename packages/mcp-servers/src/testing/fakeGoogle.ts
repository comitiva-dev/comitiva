import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One local HTTP server that fakes Google's OAuth endpoints and a subset of
 * Drive REST v3, for the Drive server tests, the desktop OAuth tests and the
 * e2e (msw cannot reach another process). Use `url` as both the OAuth base and
 * the API base.
 *
 * | part  | routes                                                                   |
 * |-------|--------------------------------------------------------------------------|
 * | OAuth | GET /o/oauth2/v2/auth (302 to redirect_uri), POST /token, POST /revoke   |
 * | Drive | GET /drive/v3/about, GET/POST /drive/v3/files, GET/PATCH /drive/v3/files/:id, |
 * |       | GET /drive/v3/files/:id/export, POST/PATCH /upload/drive/v3/files[/:id]  |
 *
 * OAuth checks what Google checks: the client id (and secret, when one is
 * set), the redirect URI, single-use codes and PKCE S256. Drive accepts only
 * unexpired access tokens it issued (or added with `addToken`). Google Docs
 * are stored as their Markdown, Sheets as CSV; export returns them as is.
 */
export interface FakeGoogleOptions {
  clientId?: string;
  /** When set, /token requires it. */
  clientSecret?: string;
  email?: string;
  /** Access token lifetime in seconds (default 3599). */
  expiresIn?: number;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  modifiedTime: string;
  trashed: boolean;
}

export interface FakeGoogleRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  range: string | undefined;
  body: string;
}

export interface FakeGoogle {
  url: string;
  readonly requests: FakeGoogleRequest[];
  readonly files: Map<string, FakeFile>;
  /** Scripted OAuth behavior; change between tests. */
  oauth: {
    /** The consent page answers `error=access_denied`. */
    deny: boolean;
    /** Scopes granted (default: what was asked). */
    grantScopes: string | null;
    /** Refresh grants fail with invalid_grant. */
    failRefresh: boolean;
    /** Tokens seen by /revoke. */
    readonly revoked: string[];
    /** Refresh grants served. */
    refreshCount: number;
  };
  addFile(file: {
    name: string;
    mimeType: string;
    content?: string | Buffer;
    parents?: string[];
    id?: string;
  }): FakeFile;
  /** Accept this bearer token on Drive routes (without going through OAuth). */
  addToken(token: string): void;
  /** The next Drive call answers this error (Google's JSON error shape). */
  failNext(status: number, reason?: string): void;
  /** Expire every access token issued so far. */
  expireTokens(): void;
  close(): Promise<void>;
}

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';
const EXPORTABLE: Record<string, string[]> = {
  [DOC]: ['text/markdown', 'text/plain', 'text/html'],
  [SHEET]: ['text/csv'],
  [SLIDES]: ['text/plain'],
};

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  used: boolean;
}

export async function startFakeGoogle(opts: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const clientId = opts.clientId ?? 'fake-client.apps.googleusercontent.com';
  const email = opts.email ?? 'test@example.com';
  const expiresIn = opts.expiresIn ?? 3599;
  const requests: FakeGoogleRequest[] = [];
  const files = new Map<string, FakeFile>();
  const codes = new Map<string, Code>();
  const access = new Map<string, number>(); // token → expires at (ms)
  const refresh = new Map<string, string>(); // refresh token → scope
  let failure: { status: number; reason?: string | undefined } | null = null;
  let seq = 0;
  const oauth: FakeGoogle['oauth'] = {
    deny: false,
    grantScopes: null,
    failRefresh: false,
    revoked: [],
    refreshCount: 0,
  };

  const nextId = (prefix: string) => `${prefix}${++seq}`;

  function addFile(f: Parameters<FakeGoogle['addFile']>[0]): FakeFile {
    const file: FakeFile = {
      id: f.id ?? nextId('file'),
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents ?? ['root'],
      content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content ?? '', 'utf8'),
      modifiedTime: new Date(Date.UTC(2026, 8, 1, 12, 0, seq)).toISOString(),
      trashed: false,
    };
    files.set(file.id, file);
    return file;
  }

  function issue(scope: string): { access_token: string; expires_in: number; scope: string } {
    const token = `ya29.fake-${randomBytes(6).toString('hex')}`;
    access.set(token, Date.now() + expiresIn * 1000);
    return { access_token: token, expires_in: expiresIn, scope };
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { error: { code: 500, message: String(err) } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const body = await readBody(req);
    const query = Object.fromEntries(url.searchParams);
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query,
      authorization: req.headers.authorization,
      range: req.headers.range,
      body: body.toString('utf8'),
    });
    const path = url.pathname;

    // ---- OAuth ----
    if (req.method === 'GET' && path === '/o/oauth2/v2/auth') return authorize(query, res);
    if (req.method === 'POST' && path === '/token') {
      return token(new URLSearchParams(body.toString('utf8')), res);
    }
    if (req.method === 'POST' && path === '/revoke') {
      const t = url.searchParams.get('token') ?? new URLSearchParams(body.toString()).get('token');
      if (t) {
        oauth.revoked.push(t);
        refresh.delete(t);
        access.delete(t);
      }
      return send(res, 200, {});
    }

    // ---- Drive ----
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const expiry = bearer ? access.get(bearer) : undefined;
    if (expiry === undefined || expiry < Date.now()) {
      return driveError(res, 401, 'Invalid Credentials', 'authError');
    }
    if (failure) {
      const f = failure;
      failure = null;
      return driveError(res, f.status, `scripted ${f.status}`, f.reason);
    }
    if (req.method === 'GET' && path === '/drive/v3/about') {
      return send(res, 200, { user: { emailAddress: email, displayName: 'Test User' } });
    }
    if (req.method === 'GET' && path === '/drive/v3/files') return list(query, res);
    if (req.method === 'POST' && path === '/drive/v3/files') {
      const meta = JSON.parse(body.toString('utf8') || '{}') as Partial<FakeFile>;
      return send(res, 200, view(createFile(meta, Buffer.alloc(0))));
    }
    if (req.method === 'POST' && path === '/upload/drive/v3/files') {
      const { meta, media } = parseMultipart(req, body);
      return send(res, 200, view(createFile(meta, media)));
    }
    const m = /^\/(upload\/)?drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path);
    const file = m ? files.get(decodeURIComponent(m[2]!)) : undefined;
    if (!m) return driveError(res, 404, `no route ${req.method} ${path}`);
    if (!file) return driveError(res, 404, `File not found: ${m[2]}.`, 'notFound');
    if (m[3]) {
      const wanted = query.mimeType ?? '';
      if (!EXPORTABLE[file.mimeType]?.includes(wanted)) {
        return driveError(res, 400, `Export to ${wanted} is not supported`, 'badRequest');
      }
      res.writeHead(200, { 'Content-Type': wanted });
      return void res.end(file.content);
    }
    if (req.method === 'GET' && query.alt === 'media') {
      if (file.mimeType.startsWith('application/vnd.google-apps.')) {
        return driveError(
          res,
          403,
          'Only files with binary content can be downloaded',
          'fileNotDownloadable',
        );
      }
      const range = /^bytes=0-(\d+)$/.exec(req.headers.range ?? '');
      if (range) {
        const part = file.content.subarray(0, Number(range[1]) + 1);
        res.writeHead(206, {
          'Content-Type': file.mimeType,
          'Content-Range': `bytes 0-${part.length - 1}/${file.content.length}`,
        });
        return void res.end(part);
      }
      res.writeHead(200, { 'Content-Type': file.mimeType });
      return void res.end(file.content);
    }
    if (req.method === 'GET') return send(res, 200, view(file));
    if (req.method === 'PATCH' && m[1]) {
      const { meta, media } = parseMultipart(req, body);
      file.content = media;
      if (meta.name) file.name = meta.name;
      file.modifiedTime = new Date().toISOString();
      return send(res, 200, view(file));
    }
    if (req.method === 'PATCH') {
      const meta = JSON.parse(body.toString('utf8') || '{}') as Partial<FakeFile>;
      if (meta.name) file.name = meta.name;
      if (query.addParents) {
        const target = query.addParents;
        if (target !== 'root' && files.get(target)?.mimeType !== FOLDER) {
          return driveError(res, 404, `File not found: ${target}.`, 'notFound');
        }
        const remove = new Set((query.removeParents ?? '').split(',').filter(Boolean));
        file.parents = [...file.parents.filter((p) => !remove.has(p)), target];
      }
      file.modifiedTime = new Date().toISOString();
      return send(res, 200, view(file));
    }
    return driveError(res, 404, `no route ${req.method} ${path}`);
  }

  function authorize(q: Record<string, string>, res: ServerResponse): void {
    if (q.client_id !== clientId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return void res.end('Error 401: invalid_client');
    }
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return void res.end('Error 400: invalid_request');
    }
    const redirect = new URL(q.redirect_uri ?? '');
    if (oauth.deny) {
      redirect.searchParams.set('error', 'access_denied');
    } else {
      const code = `4/fake-${randomBytes(6).toString('hex')}`;
      codes.set(code, {
        clientId: q.client_id,
        redirectUri: q.redirect_uri!,
        challenge: q.code_challenge,
        scope: oauth.grantScopes ?? q.scope ?? '',
        used: false,
      });
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('scope', oauth.grantScopes ?? q.scope ?? '');
    }
    if (q.state) redirect.searchParams.set('state', q.state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
  }

  function token(p: URLSearchParams, res: ServerResponse): void {
    const bad = (error: string, description: string) =>
      send(res, 400, { error, error_description: description });
    if (p.get('client_id') !== clientId)
      return bad('invalid_client', 'The OAuth client was not found.');
    if (opts.clientSecret !== undefined && p.get('client_secret') !== opts.clientSecret) {
      return bad('invalid_client', 'Unauthorized');
    }
    if (p.get('grant_type') === 'authorization_code') {
      const code = codes.get(p.get('code') ?? '');
      if (!code || code.used) return bad('invalid_grant', 'Malformed auth code.');
      code.used = true;
      if (code.redirectUri !== p.get('redirect_uri'))
        return bad('redirect_uri_mismatch', 'Bad Request');
      const verifier = p.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== code.challenge) return bad('invalid_grant', 'Invalid code verifier.');
      const refreshToken = `1//fake-${randomBytes(6).toString('hex')}`;
      refresh.set(refreshToken, code.scope);
      return send(res, 200, {
        ...issue(code.scope),
        refresh_token: refreshToken,
        token_type: 'Bearer',
      });
    }
    if (p.get('grant_type') === 'refresh_token') {
      const scope = refresh.get(p.get('refresh_token') ?? '');
      if (oauth.failRefresh || scope === undefined) {
        return bad('invalid_grant', 'Token has been expired or revoked.');
      }
      oauth.refreshCount++;
      return send(res, 200, { ...issue(scope), token_type: 'Bearer' });
    }
    return bad('unsupported_grant_type', 'Invalid grant_type');
  }

  function list(q: Record<string, string>, res: ServerResponse): void {
    let filter: (f: FakeFile) => boolean;
    try {
      filter = compileQuery(q.q ?? '');
    } catch (err) {
      return driveError(res, 400, `Invalid Value: ${(err as Error).message}`, 'invalid');
    }
    if (q.orderBy && /fullText/.test(q.q ?? '')) {
      return driveError(
        res,
        400,
        'Sorting is not supported for queries with fullText terms.',
        'invalid',
      );
    }
    const all = [...files.values()].filter(filter);
    if (q.orderBy === 'modifiedTime desc')
      all.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
    const start = Number(q.pageToken ?? 0);
    const size = Number(q.pageSize ?? 100);
    const page = all.slice(start, start + size);
    send(res, 200, {
      files: page.map(view),
      ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
    });
  }

  function createFile(meta: Partial<FakeFile>, media: Buffer): FakeFile {
    return addFile({
      name: meta.name ?? 'Untitled',
      mimeType: meta.mimeType ?? 'application/octet-stream',
      parents: meta.parents?.length ? meta.parents : ['root'],
      content: media,
    });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    files,
    oauth,
    addFile,
    addToken: (t) => void access.set(t, Number.MAX_SAFE_INTEGER),
    failNext: (status, reason) => void (failure = { status, reason }),
    expireTokens: () => {
      for (const t of access.keys()) access.set(t, 0);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function view(f: FakeFile) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parents: f.parents,
    modifiedTime: f.modifiedTime,
    webViewLink: `https://drive.example.test/${f.id}`,
    ...(f.mimeType.startsWith('application/vnd.google-apps.')
      ? {}
      : { size: String(f.content.length) }),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function driveError(res: ServerResponse, status: number, message: string, reason?: string): void {
  send(res, status, {
    error: { code: status, message, errors: [{ message, reason: reason ?? 'error' }] },
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(
  req: IncomingMessage,
  body: Buffer,
): { meta: Partial<FakeFile>; media: Buffer } {
  const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
  if (!boundary) throw new Error('multipart without boundary');
  const parts = body
    .toString('utf8')
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => {
      const split = p.indexOf('\r\n\r\n');
      return p.slice(split + 4).replace(/\r\n$/, '');
    });
  return {
    meta: JSON.parse(parts[0] ?? '{}') as Partial<FakeFile>,
    media: Buffer.from(parts[1] ?? '', 'utf8'),
  };
}

// ---- A tiny Drive query language: terms joined by and/or, with parentheses ----

type Tok = { t: 'str'; v: string } | { t: 'word'; v: string } | { t: 'op'; v: string };

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "'") {
      let v = '';
      i++;
      while (i < q.length && q[i] !== "'") {
        if (q[i] === '\\') i++;
        v += q[i++];
      }
      if (q[i] !== "'") throw new Error('unterminated string');
      i++;
      out.push({ t: 'str', v });
    } else if (c === '(' || c === ')' || c === '=') {
      out.push({ t: 'op', v: c });
      i++;
    } else if (q.startsWith('!=', i)) {
      out.push({ t: 'op', v: '!=' });
      i += 2;
    } else {
      const m = /^[A-Za-z]+/.exec(q.slice(i));
      if (!m) throw new Error(`unexpected ${c}`);
      out.push({ t: 'word', v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

function compileQuery(q: string): (f: FakeFile) => boolean {
  const toks = tokenize(q);
  let i = 0;
  const peek = () => toks[i];
  const next = () => {
    const t = toks[i++];
    if (!t) throw new Error('unexpected end');
    return t;
  };
  type Pred = (f: FakeFile) => boolean;
  const expr = (): Pred => {
    let left = term();
    while (peek()?.t === 'word' && (peek()!.v === 'and' || peek()!.v === 'or')) {
      const op = next().v;
      const right = term();
      const l = left;
      left = op === 'and' ? (f) => l(f) && right(f) : (f) => l(f) || right(f);
    }
    return left;
  };
  const term = (): Pred => {
    const t = next();
    if (t.t === 'op' && t.v === '(') {
      const e = expr();
      if (next().v !== ')') throw new Error('missing )');
      return e;
    }
    if (t.t === 'str') {
      if (next().v !== 'in' || next().v !== 'parents') throw new Error('expected in parents');
      return (f) => f.parents.includes(t.v);
    }
    const field = t.v;
    const op = next().v;
    const value = next();
    const v = value.v;
    if (field === 'trashed') return (f) => String(f.trashed) === v;
    if (field === 'mimeType' && op === '=') return (f) => f.mimeType === v;
    if (field === 'mimeType' && op === '!=') return (f) => f.mimeType !== v;
    if (field === 'name' && op === 'contains') {
      return (f) => f.name.toLowerCase().includes(v.toLowerCase());
    }
    if (field === 'fullText' && op === 'contains') {
      return (f) =>
        f.name.toLowerCase().includes(v.toLowerCase()) ||
        f.content.toString('utf8').toLowerCase().includes(v.toLowerCase());
    }
    throw new Error(`unsupported term ${field} ${op}`);
  };
  if (toks.length === 0) return () => true;
  const pred = expr();
  if (i !== toks.length) throw new Error('trailing tokens');
  return pred;
}
