/** Small DSP building blocks shared by the effect cores. Pure TypeScript. */

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-12, g));
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Stereo biquad (transposed direct form II) with coefficient setters from
 * Robert Bristow-Johnson's "Audio EQ Cookbook".
 */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = [0, 0];
  private z2 = [0, 0];

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  private static w0(sr: number, f: number) {
    const w = (2 * Math.PI * clamp(f, 1, sr * 0.49)) / sr;
    return { cos: Math.cos(w), sin: Math.sin(w) };
  }

  /** Low shelf with slope S = 1. */
  lowShelf(sr: number, f: number, gainDb: number): this {
    const A = Math.pow(10, gainDb / 40);
    const { cos, sin } = Biquad.w0(sr, f);
    const sa = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
    this.set(
      A * (A + 1 - (A - 1) * cos + sa),
      2 * A * (A - 1 - (A + 1) * cos),
      A * (A + 1 - (A - 1) * cos - sa),
      A + 1 + (A - 1) * cos + sa,
      -2 * (A - 1 + (A + 1) * cos),
      A + 1 + (A - 1) * cos - sa,
    );
    return this;
  }

  /** High shelf with slope S = 1. */
  highShelf(sr: number, f: number, gainDb: number): this {
    const A = Math.pow(10, gainDb / 40);
    const { cos, sin } = Biquad.w0(sr, f);
    const sa = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
    this.set(
      A * (A + 1 + (A - 1) * cos + sa),
      -2 * A * (A - 1 + (A + 1) * cos),
      A * (A + 1 + (A - 1) * cos - sa),
      A + 1 - (A - 1) * cos + sa,
      2 * (A - 1 - (A + 1) * cos),
      A + 1 - (A - 1) * cos - sa,
    );
    return this;
  }

  peaking(sr: number, f: number, gainDb: number, q: number): this {
    const A = Math.pow(10, gainDb / 40);
    const { cos, sin } = Biquad.w0(sr, f);
    const alpha = sin / (2 * Math.max(0.05, q));
    this.set(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
    return this;
  }

  highpass(sr: number, f: number, q = Math.SQRT1_2): this {
    const { cos, sin } = Biquad.w0(sr, f);
    const alpha = sin / (2 * q);
    this.set((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
    return this;
  }

  /** Process one sample of channel `ch` (0 or 1). */
  process(x: number, ch: number): number {
    const y = this.b0 * x + this.z1[ch]!;
    this.z1[ch] = this.b1 * x - this.a1 * y + this.z2[ch]!;
    this.z2[ch] = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = [0, 0];
    this.z2 = [0, 0];
  }
}

/** One-pole low-pass smoother/filter: y += a * (x - y). */
export function onePoleCoef(sr: number, cutoffHz: number): number {
  return 1 - Math.exp((-2 * Math.PI * clamp(cutoffHz, 0.01, sr * 0.49)) / sr);
}

/** Per-sample coefficient for an exponential approach with time constant `seconds`. */
export function timeCoef(sr: number, seconds: number): number {
  return Math.exp(-1 / Math.max(1, seconds * sr));
}

/** Note values for tempo-synced times, in beats (quarter notes). `bar` uses the project's beats per bar. */
export interface SyncDivision {
  label: string;
  beats: number | 'bar';
}

export const DELAY_DIVISIONS: SyncDivision[] = [
  { label: '1/16', beats: 0.25 },
  { label: '1/16.', beats: 0.375 },
  { label: '1/16T', beats: 0.25 * (2 / 3) },
  { label: '1/8', beats: 0.5 },
  { label: '1/8.', beats: 0.75 },
  { label: '1/8T', beats: 0.5 * (2 / 3) },
  { label: '1/4', beats: 1 },
  { label: '1/4.', beats: 1.5 },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/2', beats: 2 },
  { label: '1/2.', beats: 3 },
  { label: '1/2T', beats: 4 / 3 },
  { label: '1 bar', beats: 'bar' },
];

export function divisionBeats(d: SyncDivision, beatsPerBar: number): number {
  return d.beats === 'bar' ? beatsPerBar : d.beats;
}

/** Transport context an effect needs for tempo sync. */
export interface TransportState {
  /** Song position in beats at the current sample. */
  beat: number;
  bpm: number;
  beatsPerBar: number;
}
