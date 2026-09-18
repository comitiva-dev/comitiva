import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ElectronSecretStore, type SafeStorageLike } from './ElectronSecretStore';

/** Reversible fake cipher: XOR with a byte, so plaintext never appears verbatim. */
function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => xor(Buffer.from(`enc:${s}`, 'utf8')),
    decryptString: (b) => xor(b).toString('utf8').replace(/^enc:/, ''),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    ...overrides,
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'comitiva-secrets-'));
  file = join(dir, 'secrets.bin');
});

describe('ElectronSecretStore', () => {
  it('stores, reads and deletes secrets', async () => {
    const store = new ElectronSecretStore(file, fakeSafeStorage());
    expect(await store.get('k')).toBeNull();
    await store.set('k', 'sk-ant-secret');
    expect(await store.get('k')).toBe('sk-ant-secret');
    expect(await store.has('k')).toBe(true);
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });

  it('persists across instances and never writes plaintext', async () => {
    await new ElectronSecretStore(file, fakeSafeStorage()).set('k', 'sk-ant-secret');
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('sk-ant-secret');
    expect(JSON.parse(raw)).toMatchObject({ version: 1, entries: { k: expect.any(String) } });
    expect(await new ElectronSecretStore(file, fakeSafeStorage()).get('k')).toBe('sk-ant-secret');
  });

  it('serializes concurrent writes without losing any', async () => {
    const store = new ElectronSecretStore(file, fakeSafeStorage());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.set(`k${i}`, `v${i}`)));
    const fresh = new ElectronSecretStore(file, fakeSafeStorage());
    for (let i = 0; i < 10; i++) expect(await fresh.get(`k${i}`)).toBe(`v${i}`);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to operate when encryption is unavailable', async () => {
    const store = new ElectronSecretStore(
      file,
      fakeSafeStorage({ isEncryptionAvailable: () => false }),
    );
    await expect(store.set('k', 'v')).rejects.toMatchObject({ code: 'secret_store_unavailable' });
    await expect(store.get('k')).rejects.toMatchObject({ code: 'secret_store_unavailable' });
  });

  it('flags the Linux basic_text backend as weak', () => {
    expect(new ElectronSecretStore(file, fakeSafeStorage()).isWeak()).toBe(false);
    const weak = fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' });
    expect(new ElectronSecretStore(file, weak).isWeak()).toBe(true);
  });

  it('refuses to store keys on a weak backend unless explicitly allowed', async () => {
    const weak = fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' });
    const refusing = new ElectronSecretStore(file, weak);
    expect(refusing.status()).toEqual({ available: false, weak: false });
    await expect(refusing.set('k', 'v')).rejects.toMatchObject({
      code: 'secret_store_unavailable',
    });

    const allowed = new ElectronSecretStore(file, weak, { allowWeak: true });
    expect(allowed.status()).toEqual({ available: true, weak: true });
    await allowed.set('k', 'v');
    expect(await allowed.get('k')).toBe('v');
  });

  it('reports a healthy keyring as available and not weak', () => {
    expect(new ElectronSecretStore(file, fakeSafeStorage()).status()).toEqual({
      available: true,
      weak: false,
    });
  });
});
