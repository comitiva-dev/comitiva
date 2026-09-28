import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';

/**
 * `comitiva-attachment://file/<name>` serves stored attachments to the
 * renderer (images in messages and in the composer). Only names the
 * AttachmentService can locate are served: a ULID file inside the store,
 * after realpath, so no path and no symlink leads anywhere else.
 */
export const ATTACHMENT_SCHEME = 'comitiva-attachment';

/**
 * `comitiva-hub-attachment://file/<id>` serves attachments of workspace
 * messages, fetched from the hub by main with the device token (which never
 * reaches the renderer) and cached (hub/HubAttachments).
 */
export const HUB_ATTACHMENT_SCHEME = 'comitiva-hub-attachment';

/** Must run before `app.whenReady()`. */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: HUB_ATTACHMENT_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export function handleHubAttachments(
  get: (id: string) => Promise<{ bytes: Buffer; contentType: string } | null>,
): void {
  protocol.handle(HUB_ATTACHMENT_SCHEME, async (request) => {
    const url = new URL(request.url);
    const id = url.host === 'file' ? decodeURIComponent(url.pathname.slice(1)) : '';
    const file = await get(id).catch(() => null);
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  });
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
