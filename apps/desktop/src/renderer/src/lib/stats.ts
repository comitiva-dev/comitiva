export interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function latencyStats(samples: number[]): LatencyStats | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1)! };
}
