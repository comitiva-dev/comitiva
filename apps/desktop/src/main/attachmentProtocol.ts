import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';

/**
 * `comitiva-attachment://file/<name>` serves stored attachments to the
 * renderer (images in messages and in the composer). Only names the
 * AttachmentService can locate are served: a ULID file inside the store,
 * after realpath, so no path and no symlink leads anywhere else.
 */
export const ATTACHMENT_SCHEME = 'comitiva-attachment';

/** Must run before `app.whenReady()`. */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export function handleAttachments(locate: (name: string) => string | null): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    const url = new URL(request.url);
    const path = url.host === 'file' ? locate(decodeURIComponent(url.pathname.slice(1))) : null;
    if (!path) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(path).toString());
    const headers = new Headers(res.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    return new Response(res.body, { status: res.status, headers });
  });
}
