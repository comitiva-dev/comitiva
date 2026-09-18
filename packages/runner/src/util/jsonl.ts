/**
 * JSON-lines framing. One JSON value per line, `\n` terminated. Input chunks
 * may split lines anywhere (including inside multi-byte characters), so the
 * splitter buffers until it sees a newline.
 */
export class LineSplitter {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== '') this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Emits a trailing line that was not newline-terminated. */
  end(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest !== '') this.onLine(rest);
  }
}

export function encodeLine(value: unknown): string {
  // JSON.stringify escapes raw newlines inside strings, so one value is one line.
  return `${JSON.stringify(value)}\n`;
}

/** Epoch milliseconds with sub-millisecond precision, comparable across processes. */
export function preciseNow(): number {
  return performance.timeOrigin + performance.now();
}
