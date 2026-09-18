import type { RunnerEvent } from '@comitiva/contract';
import { LineSplitter, encodeLine } from '../util/jsonl.js';

/** JSON lines over a pair of streams. */
export class JsonLinesTransport {
  private messageHandler: (msg: unknown) => void = () => {};
  private malformedHandler: (line: string) => void = () => {};
  private closeHandler: () => void = () => {};

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    const splitter = new LineSplitter((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.malformedHandler(line);
        return;
      }
      this.messageHandler(parsed);
    });
    input.on('data', (chunk: Buffer | string) => splitter.push(chunk));
    input.on('end', () => {
      splitter.end();
      this.closeHandler();
    });
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.messageHandler = handler;
  }

  onMalformed(handler: (line: string) => void): void {
    this.malformedHandler = handler;
  }

  /** Called when the input stream ends (the shell went away). */
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** Serializes and writes one event. Never throws. */
  send(msg: RunnerEvent): void {
    try {
      this.output.write(encodeLine(msg));
    } catch {
      // Output closed: nothing useful to do, the shell is gone.
    }
  }
}
