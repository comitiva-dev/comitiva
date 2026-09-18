/**
 * Where secret values (API keys, OAuth tokens) live. Only `secretRef`s go to
 * SQLite and IPC; values are read here and sent to the runner per request.
 */
export interface SecretStore {
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  has(ref: string): Promise<boolean>;
  delete(ref: string): Promise<void>;
  /** Whether values can be stored securely right now (see SecretStorageStatus). */
  status(): { available: boolean; weak: boolean };
}
