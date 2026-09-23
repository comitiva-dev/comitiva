import {
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_LIMITS,
  cliProviderDescriptors,
  providerDescriptors,
  type CliProviderDescriptor,
  type ProviderDescriptor,
  type ProviderId,
  type AttachmentBlock,
  type ErrorCode,
  type UserContent,
} from '@comitiva/contract';

/** A file the user picked, dropped or pasted, before it is stored. */
export interface PickedFile {
  name: string;
  /** What the OS says; main sniffs images and checks text itself. */
  type: string;
  size: number;
  /** The bytes as base64, read only when the file passes the quick checks. */
  read(): Promise<string>;
}

/** An attachment in a draft: uploading, stored (with its block) or refused. */
export interface DraftAttachment {
  id: string;
  name: string;
  size: number;
  isImage: boolean;
  status: 'uploading' | 'ready' | 'failed';
  block?: AttachmentBlock;
  error?: ErrorCode;
}

export const isImageType = (type: string) =>
  (ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());

/**
 * The check the composer can make without reading the file: its size
 * against the limit for its kind. Main makes the real checks.
 */
export function precheck(file: Pick<PickedFile, 'type' | 'size'>): ErrorCode | null {
  const limit = isImageType(file.type) ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.textBytes;
  return file.size > limit ? 'attachment_too_large' : null;
}

/** How many more files a draft takes. */
export function room(attachments: readonly DraftAttachment[]): number {
  return Math.max(
    0,
    ATTACHMENT_LIMITS.perMessage - attachments.filter((a) => a.status !== 'failed').length,
  );
}

/** A draft can be sent when nothing is still uploading and it has text or a stored file. */
export function canSendDraft(text: string, attachments: readonly DraftAttachment[]): boolean {
  if (attachments.some((a) => a.status === 'uploading')) return false;
  return text.trim() !== '' || attachments.some((a) => a.status === 'ready');
}

/** What a draft sends: its text, then its stored files in the order they were added. */
export function draftContent(text: string, attachments: readonly DraftAttachment[]): UserContent {
  const blocks: UserContent = [];
  if (text.trim() !== '') blocks.push({ type: 'text', text: text.trim() });
  for (const a of attachments) if (a.status === 'ready' && a.block) blocks.push(a.block);
  return blocks;
}

/** Bytes as the composer shows them. */
export function formatSize(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** Reads a browser File as a PickedFile. */
export function pickedFromFile(file: File): PickedFile {
  return {
    name: file.name || 'pasted',
    type: file.type,
    size: file.size,
    read: async () => toBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Whether a connection's provider takes images (the others get their names only). */
export function acceptsImages(provider: ProviderId): boolean {
  const d =
    (providerDescriptors as Record<string, ProviderDescriptor | undefined>)[provider] ??
    (cliProviderDescriptors as Record<string, CliProviderDescriptor | undefined>)[provider];
  return d?.capabilities.images ?? false;
}
