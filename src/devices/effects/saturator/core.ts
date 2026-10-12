/**
 * Saturator DSP. Each sample is upsampled 2x (zero-stuffing plus a
 * windowed-sinc half-band FIR), driven into the curve, filtered again and
 * decimated, which keeps aliasing from the curve's harmonics down. A one-pole
 * low-pass ("Tone") follows. The dry path is delayed by the filters' latency
 * so dry/wet mixing doesn't comb-filter.
 */
import { BaseEffect } from '../define';
import { clamp, dbToGain, onePoleCoef } from '../dsp';
import { saturatorDefinition } from './definition';

const TAPS = 31;
/** Latency of the up + down filters, in base-rate samples. */
export const SATURATOR_LATENCY = (TAPS - 1) / 2;

/** Half-band low-pass FIR (cutoff at a quarter of the 2x rate), Blackman window, unity DC gain. */
function halfBand(): Float64Array {
  const h = new Float64Array(TAPS);
  const m = (TAPS - 1) / 2;
  let sum = 0;
  for (let n = 0; n < TAPS; n++) {
    const x = n - m;
    const sinc = x === 0 ? 0.5 : Math.sin(Math.PI * 0.5 * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
    h[n] = sinc * w;
    sum += h[n]!;
  }
  for (let n = 0; n < TAPS; n++) h[n]! /= sum;
  return h;
}
const H = halfBand();

/** The waveshaping curves; all map any input into [-1, 1]. */
export function shape(curve: number, x: number): number {
  switch (curve) {
    case 1:
      return Math.tanh(x);
    case 2: {
      // Triangle fold: identity on [-1, 1], reflecting beyond.
      let t = (x + 1) / 4;
      t -= Math.floor(t);
      return 1 - 4 * Math.abs(t - 0.5);
    }
    default: {
      const c = clamp(x, -1, 1);
      return 1.5 * c - 0.5 * c * c * c;
    }
  }
}

/** FIR over a circular history (stored twice so the window is contiguous). */
class Fir {
  private hist = new Float64Array(TAPS * 2);
  private pos = 0;
  push(x: number): number {
    this.hist[this.pos] = x;
    this.hist[this.pos + TAPS] = x;
    if (++this.pos === TAPS) this.pos = 0;
    let y = 0;
    // hist[pos .. pos+TAPS) is oldest -> newest.
    for (let k = 0; k < TAPS; k++) y += H[TAPS - 1 - k]! * this.hist[this.pos + k]!;
    return y;
  }
  reset(): void {
    this.hist.fill(0);
    this.pos = 0;
  }
}

export class SaturatorCore extends BaseEffect {
  private up = [new Fir(), new Fir()];
  private down = [new Fir(), new Fir()];
  private dry = [new Float32Array(SATURATOR_LATENCY + 1), new Float32Array(SATURATOR_LATENCY + 1)];
  private dryIdx = 0;
  private tone = [0, 0];
  private toneA = 1;
  private drive = 1;
  private out = 1;

  constructor(sampleRate: number, params: Record<string, number> = {}) {
    super(sampleRate, saturatorDefinition, params);
    this.update();
  }

  protected update(): void {
    this.drive = dbToGain(this.p.drive!);
    this.out = dbToGain(this.p.output!);
    this.toneA = onePoleCoef(this.sampleRate, this.p.tone!);
  }

  private wet(x: number, ch: number, curve: number): number {
    const up = this.up[ch]!;
    const down = this.down[ch]!;
    // Zero-stuffed 2x stream; x2 restores the level lost to the inserted zeros.
    const a = shape(curve, up.push(2 * x) * this.drive);
    const b = shape(curve, up.push(0) * this.drive);
    down.push(a);
    const y = down.push(b);
    return (this.tone[ch]! += this.toneA * (y - this.tone[ch]!));
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const curve = Math.round(this.p.curve!);
    const mix = this.p.mix!;
    const [dL, dR] = this.dry as [Float32Array, Float32Array];
    for (let i = from; i < to; i++) {
      const l = inL[i]!;
      const r = inR[i]!;
      const wl = this.wet(l, 0, curve);
      const wr = this.wet(r, 1, curve);
      // Dry delayed by the oversampling latency.
      dL[this.dryIdx] = l;
      dR[this.dryIdx] = r;
      const read = (this.dryIdx + 1) % dL.length;
      this.dryIdx = read;
      outL[i] = (dL[read]! * (1 - mix) + wl * mix) * this.out;
      outR[i] = (dR[read]! * (1 - mix) + wr * mix) * this.out;
    }
  }

  reset(): void {
    for (const f of [...this.up, ...this.down]) f.reset();
    for (const d of this.dry) d.fill(0);
    this.tone = [0, 0];
  }
}
