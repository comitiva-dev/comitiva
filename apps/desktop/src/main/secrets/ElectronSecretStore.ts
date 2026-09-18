import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from '@comitiva/contract';
import type { SecretStore } from './SecretStore';

/** The subset of Electron's `safeStorage` this store needs (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

interface FileFormat {
  version: 1;
  entries: Record<string, string>; // ref → base64(ciphertext)
}

/**
 * Secrets encrypted with `safeStorage` (OS keychain) and stored as a JSON map
 * of base64 blobs in `<userData>/secrets.bin`. Writes are atomic (tmp + rename)
 * and serialized. Refuses to operate when encryption is unavailable.
 */
export class ElectronSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private readonly allowWeak: boolean;

  /**
   * `allowWeak` accepts Linux's `basic_text` backend (obfuscation only). Main
   * sets it only with COMITIVA_ALLOW_WEAK_SECRET_STORAGE=1 (tests and CI):
   * without a keyring the product refuses to store keys (SPEC §7).
   */
  constructor(
    private readonly filePath: string,
    private readonly crypto: SafeStorageLike,
    opts: { allowWeak?: boolean } = {},
  ) {
    this.allowWeak = opts.allowWeak ?? false;
  }

  /**
   * True on Linux when no keyring is available and Chromium falls back to
   * `basic_text`: values are then only obfuscated with a fixed key.
   */
  isWeak(): boolean {
    return this.crypto.getSelectedStorageBackend?.() === 'basic_text';
  }

  status(): { available: boolean; weak: boolean } {
    const weak = this.isWeak();
    const available = this.crypto.isEncryptionAvailable() && (!weak || this.allowWeak);
    return { available, weak: available && weak };
  }

  async get(ref: string): Promise<string | null> {
    this.assertAvailable();
    const entries = await this.load();
    const blob = entries[ref];
    if (blob === undefined) return null;
    return this.crypto.decryptString(Buffer.from(blob, 'base64'));
  }

  async has(ref: string): Promise<boolean> {
    return (await this.load())[ref] !== undefined;
  }

  async set(ref: string, value: string): Promise<void> {
    this.assertAvailable();
    await this.mutate((entries) => {
      entries[ref] = this.crypto.encryptString(value).toString('base64');
    });
  }

  async delete(ref: string): Promise<void> {
    await this.mutate((entries) => {
      delete entries[ref];
    });
  }

  private assertAvailable(): void {
    if (!this.status().available) {
      throw new AppError(
        'secret_store_unavailable',
        this.isWeak()
          ? 'No OS keyring is available: keys would only be obfuscated'
          : 'OS encryption is not available',
      );
    }
  }

  private mutate(fn: (entries: Record<string, string>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const entries = { ...(await this.load()) };
      fn(entries);
      await this.persist(entries);
      this.cache = entries;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as FileFormat;
      this.cache = parsed.entries ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.cache = {};
    }
    return this.cache;
  }

  private async persist(entries: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`;
    const body: FileFormat = { version: 1, entries };
    try {
      await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
      await rename(tmp, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => {});
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
