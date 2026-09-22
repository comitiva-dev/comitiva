/**
 * A thin Drive REST v3 client over fetch (no googleapis dependency). It only
 * knows the calls the built-in server makes, and turns HTTP failures into
 * DriveError with a stable AppError code.
 */

export const DEFAULT_GOOGLE_API_BASE_URL = 'https://www.googleapis.com';

export const MIME = {
  folder: 'application/vnd.google-apps.folder',
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
} as const;

/** `code` is a stable AppError code, sent back to the model first (`not_found: …`). */
export class DriveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  size?: string;
}

export interface DriveApiOptions {
  token: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,parents,size';
const ALL_DRIVES = { supportsAllDrives: 'true' };

export class DriveApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DriveApiOptions) {
    this.base = (opts.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async list(params: {
    q: string;
    pageSize: number;
    pageToken?: string | undefined;
    orderBy?: string | undefined;
  }): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const res = await this.call('GET', '/drive/v3/files', {
      query: {
        ...ALL_DRIVES,
        includeItemsFromAllDrives: 'true',
        q: params.q,
        pageSize: String(params.pageSize),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
        ...(params.orderBy ? { orderBy: params.orderBy } : {}),
      },
    });
    return (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
  }

  async get(fileId: string): Promise<DriveFile> {
    const res = await this.call('GET', `/drive/v3/files/${enc(fileId)}`, {
      query: { ...ALL_DRIVES, fields: FILE_FIELDS },
    });
    return (await res.json()) as DriveFile;
  }

  /** Exports a Google Workspace file (Docs, Sheets, Slides) to `mimeType`. */
  async export(fileId: string, mimeType: string, maxBytes: number): Promise<Capped> {
    const res = await this.call('GET', `/drive/v3/files/${enc(fileId)}/export`, {
      query: { mimeType },
    });
    return readCapped(res, maxBytes);
  }

  /**
   * Downloads a regular file's content, at most `maxBytes`. `ranged` asks for
   * only the first bytes (for files known to be larger; an empty file would
   * answer 416 to a range).
   */
  async download(fileId: string, maxBytes: number, ranged: boolean): Promise<Capped> {
    const res = await this.call('GET', `/drive/v3/files/${enc(fileId)}`, {
      query: { ...ALL_DRIVES, alt: 'media' },
      headers: ranged ? { Range: `bytes=0-${maxBytes - 1}` } : {},
    });
    return readCapped(res, maxBytes);
  }

  /** Creates a file (with content, converted when `metadata.mimeType` is a Google type) or a folder. */
  async create(
    metadata: { name: string; mimeType: string; parents?: string[] | undefined },
    media?: { contentType: string; body: string },
  ): Promise<DriveFile> {
    const query = { ...ALL_DRIVES, fields: FILE_FIELDS };
    const res = media
      ? await this.call('POST', '/upload/drive/v3/files', {
          query: { ...query, uploadType: 'multipart' },
          multipart: { metadata, media },
        })
      : await this.call('POST', '/drive/v3/files', { query, json: metadata });
    return (await res.json()) as DriveFile;
  }

  /** Replaces a file's content (and optionally renames it). */
  async updateContent(
    fileId: string,
    media: { contentType: string; body: string },
    metadata: { name?: string | undefined } = {},
  ): Promise<DriveFile> {
    const res = await this.call('PATCH', `/upload/drive/v3/files/${enc(fileId)}`, {
      query: { ...ALL_DRIVES, uploadType: 'multipart', fields: FILE_FIELDS },
      multipart: { metadata, media },
    });
    return (await res.json()) as DriveFile;
  }

  /** Changes metadata: rename, or move with addParents/removeParents. */
  async patch(
    fileId: string,
    metadata: { name?: string | undefined },
    parents: { add?: string; remove?: string[] } = {},
  ): Promise<DriveFile> {
    const res = await this.call('PATCH', `/drive/v3/files/${enc(fileId)}`, {
      query: {
        ...ALL_DRIVES,
        fields: FILE_FIELDS,
        ...(parents.add ? { addParents: parents.add } : {}),
        ...(parents.remove?.length ? { removeParents: parents.remove.join(',') } : {}),
      },
      json: metadata,
    });
    return (await res.json()) as DriveFile;
  }

  private async call(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      json?: unknown;
      multipart?: { metadata: unknown; media: { contentType: string; body: string } };
    },
  ): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(opts.json);
    } else if (opts.multipart) {
      const boundary = `comitiva-${Math.random().toString(36).slice(2)}`;
      headers['Content-Type'] = `multipart/related; boundary=${boundary}`;
      body = multipartBody(boundary, opts.multipart.metadata, opts.multipart.media);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }) });
    } catch (err) {
      throw new DriveError('tool_failed', `Google Drive is unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw await toDriveError(res);
    return res;
  }
}

export interface Capped {
  bytes: Buffer;
  truncated: boolean;
}

async function readCapped(res: Response, maxBytes: number): Promise<Capped> {
  const buf = Buffer.from(await res.arrayBuffer());
  const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? buf.length);
  return buf.length > maxBytes
    ? { bytes: buf.subarray(0, maxBytes), truncated: true }
    : { bytes: buf, truncated: total > buf.length };
}

function multipartBody(
  boundary: string,
  metadata: unknown,
  media: { contentType: string; body: string },
): string {
  return (
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${media.contentType}\r\n\r\n` +
    `${media.body}\r\n--${boundary}--`
  );
}

async function toDriveError(res: Response): Promise<DriveError> {
  let message = `HTTP ${res.status}`;
  let reason = '';
  try {
    const body = (await res.json()) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    message = body.error?.message ?? message;
    reason = body.error?.errors?.[0]?.reason ?? '';
  } catch {
    // not JSON: keep the status
  }
  if (res.status === 401) {
    return new DriveError(
      'auth_failed',
      `Google rejected the access token (${message}). Retry; if it keeps failing, reconnect Google Drive in Comitiva's Tools screen.`,
    );
  }
  if (res.status === 429 || (res.status === 403 && /rateLimit/i.test(reason))) {
    return new DriveError('rate_limited', `Google Drive rate limit: ${message}`);
  }
  if (res.status === 404) return new DriveError('not_found', message);
  if (res.status === 400) return new DriveError('invalid_request', message);
  return new DriveError('tool_failed', `Google Drive error ${res.status}: ${message}`);
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Escapes a value for a Drive query string literal ('…'). */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
