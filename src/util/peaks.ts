/**
 * Waveform overview data: min/max pairs over fixed-size sample bins,
 * mixed down across channels.
 */
export interface Peaks {
  /** Samples per bin. */
  binSize: number;
  sampleRate: number;
  min: Float32Array;
  max: Float32Array;
}

export const PEAK_BIN_SIZE = 256;

export function computePeaks(channels: readonly Float32Array[], sampleRate: number, binSize = PEAK_BIN_SIZE): Peaks {
  const length = channels[0]?.length ?? 0;
  const bins = Math.max(1, Math.ceil(length / binSize));
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(length, (b + 1) * binSize);
    for (const ch of channels) {
      for (let i = b * binSize; i < end; i++) {
        const s = ch[i]!;
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { binSize, sampleRate, min, max };
}

/** Aggregate min/max for the time range [t0, t1) seconds. */
export function peakRange(peaks: Peaks, t0: number, t1: number): [number, number] {
  const b0 = Math.max(0, Math.floor((t0 * peaks.sampleRate) / peaks.binSize));
  const b1 = Math.min(peaks.min.length, Math.max(b0 + 1, Math.ceil((t1 * peaks.sampleRate) / peaks.binSize)));
  let lo = 0;
  let hi = 0;
  for (let b = b0; b < b1; b++) {
    if (peaks.min[b]! < lo) lo = peaks.min[b]!;
    if (peaks.max[b]! > hi) hi = peaks.max[b]!;
  }
  return [lo, hi];
}
