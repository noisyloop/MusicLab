/**
 * Compressor DSP (Giannoulis, Massberg & Reiss, "Digital Dynamic Range
 * Compressor Design"): a peak detector on max(|L|, |R|), a soft-knee static
 * curve in dB, and attack/release smoothing of the gain reduction.
 */
import { BaseEffect } from '../define';
import { dbToGain, gainToDb, timeCoef } from '../dsp';
import { compressorDefinition } from './definition';

/** Output level (dB) for an input level (dB) through the static curve. */
export function compressorCurve(xDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
  const over = xDb - thresholdDb;
  if (kneeDb > 0 && Math.abs(over) <= kneeDb / 2) {
    const d = over + kneeDb / 2;
    return xDb + ((1 / ratio - 1) * d * d) / (2 * kneeDb);
  }
  return over > 0 ? thresholdDb + over / ratio : xDb;
}

export class CompressorCore extends BaseEffect {
  /** Smoothed gain change in dB (<= 0). */
  private reductionDb = 0;
  private attackCoef = 0;
  private releaseCoef = 0;
  private makeupGain = 1;

  constructor(sampleRate: number, params: Record<string, number> = {}) {
    super(sampleRate, compressorDefinition, params);
    this.update();
  }

  protected update(): void {
    this.attackCoef = timeCoef(this.sampleRate, this.p.attack! / 1000);
    this.releaseCoef = timeCoef(this.sampleRate, this.p.release! / 1000);
    this.makeupGain = dbToGain(this.p.makeup!);
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const { threshold, ratio, knee } = this.p as { threshold: number; ratio: number; knee: number };
    let y = this.reductionDb;
    for (let i = from; i < to; i++) {
      const l = inL[i]!;
      const r = inR[i]!;
      const xDb = gainToDb(Math.max(Math.abs(l), Math.abs(r)));
      const target = compressorCurve(xDb, threshold, ratio, knee) - xDb;
      const a = target < y ? this.attackCoef : this.releaseCoef;
      y = a * y + (1 - a) * target;
      const g = dbToGain(y) * this.makeupGain;
      outL[i] = l * g;
      outR[i] = r * g;
    }
    this.reductionDb = y;
  }

  /** Current gain reduction in dB (positive). */
  meter(): number {
    return -this.reductionDb;
  }

  reset(): void {
    this.reductionDb = 0;
  }
}
