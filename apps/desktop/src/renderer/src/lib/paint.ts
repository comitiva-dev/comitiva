/** Epoch milliseconds with sub-ms precision; comparable with the runner's `ts`. */
export function preciseNow(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Calls `cb` right after the next paint: rAF runs before the frame is
 * painted, and a message posted from it is delivered after.
 */
export function afterNextPaint(cb: () => void): void {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      cb();
    };
    channel.port2.postMessage(null);
  });
}
