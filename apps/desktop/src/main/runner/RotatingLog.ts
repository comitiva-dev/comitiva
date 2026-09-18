import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Append-only log file that rotates to `<file>.1` past a size limit. */
export class RotatingLog {
  private size: number;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    try {
      this.size = statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  write(chunk: Buffer | string): void {
    try {
      if (this.size + chunk.length > this.maxBytes) {
        renameSync(this.file, `${this.file}.1`);
        this.size = 0;
      }
      appendFileSync(this.file, chunk);
      this.size += chunk.length;
    } catch {
      // Logging must never take the app down.
    }
  }
}
