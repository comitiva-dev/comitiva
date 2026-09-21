import { AppError } from '@comitiva/contract';
import type { SecretStore } from '../secrets/SecretStore';

/** An in-memory SecretStore for tests; `available = false` behaves like a keyring-less Linux. */
export class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  available = true;
  async set(ref: string, value: string) {
    if (!this.available) throw new AppError('secret_store_unavailable', 'no keyring');
    this.values.set(ref, value);
  }
  async get(ref: string) {
    if (!this.available) throw new AppError('secret_store_unavailable', 'no keyring');
    return this.values.get(ref) ?? null;
  }
  async has(ref: string) {
    return this.values.has(ref);
  }
  async delete(ref: string) {
    this.values.delete(ref);
  }
  status() {
    return { available: this.available, weak: false };
  }
}
