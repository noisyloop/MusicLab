/**
 * Reverb DSP after Freeverb (Jezar at Dreampoint): eight damped feedback
 * combs in parallel and four series allpasses per channel, the right channel
 * offset by 23 samples. Unlike Freeverb, each comb's feedback is set from the
 * Decay parameter (RT60), so the tail lasts as long as the knob says, and a
 * pre-delay line sits in front. Fully deterministic (no modulation or noise),
 * so offline renders match live playback.
 */
import { BaseEffect } from '../define';
import { reverbDefinition } from './definition';

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;
const FIXED_GAIN = 0.015;
const SCALE_WET = 3;
const MAX_PREDELAY_S = 0.2;

class Comb {
  buf: Float32Array;
  idx = 0;
  len: number;
  store = 0;
  feedback = 0;
  constructor(max: number) {
    this.buf = new Float32Array(max);
    this.len = max;
  }
  process(x: number, damp: number): number {
    const y = this.buf[this.idx]!;
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.idx] = x + this.store * this.feedback;
    if (++this.idx >= this.len) this.idx = 0;
    return y;
  }
}

class Allpass {
  buf: Float32Array;
  idx = 0;
  constructor(len: number) {
    this.buf = new Float32Array(len);
  }
  process(x: number): number {
    const b = this.buf[this.idx]!;
    this.buf[this.idx] = x + b * 0.5;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return b - x;
  }
}

export class ReverbCore extends BaseEffect {
  private combsL: Comb[];
  private combsR: Comb[];
  private apL: Allpass[];
  private apR: Allpass[];
  private pre: Float32Array;
  private preIdx = 0;
  private preLen = 1;
  private readonly scale: number;

  constructor(sampleRate: number, params: Record<string, number> = {}) {
    super(sampleRate, reverbDefinition, params);
    this.scale = sampleRate / 44100;
    // Room for the largest size (x1.6).
    const max = (n: number) => Math.ceil(n * this.scale * 1.6) + 1;
    this.combsL = COMBS.map((n) => new Comb(max(n)));
    this.combsR = COMBS.map((n) => new Comb(max(n + SPREAD)));
    this.apL = ALLPASSES.map((n) => new Allpass(Math.max(1, Math.round(n * this.scale))));
    this.apR = ALLPASSES.map((n) => new Allpass(Math.max(1, Math.round((n + SPREAD) * this.scale))));
    this.pre = new Float32Array(Math.ceil(MAX_PREDELAY_S * sampleRate) + 1);
    this.update();
  }

  protected update(): void {
    const sr = this.sampleRate;
    const sizeMul = 0.4 + 1.2 * this.p.size!;
    const decay = this.p.decay!;
    const setup = (combs: Comb[], spread: number) =>
      combs.forEach((c, i) => {
        const len = Math.min(c.buf.length, Math.max(1, Math.round((COMBS[i]! + spread) * this.scale * sizeMul)));
        if (len !== c.len) {
          c.len = len;
          if (c.idx >= len) c.idx = 0;
        }
        // -60 dB after `decay` seconds: g^(decay * sr / len) = 0.001.
        c.feedback = Math.pow(0.001, len / (decay * sr));
      });
    setup(this.combsL, 0);
    setup(this.combsR, SPREAD);
    this.preLen = Math.min(this.pre.length, Math.max(1, Math.round((this.p.preDelay! / 1000) * sr) + 1));
    if (this.preIdx >= this.preLen) this.preIdx = 0;
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const damp = this.p.damping! * 0.4;
    const mix = this.p.mix!;
    const width = this.p.width!;
    const wet1 = SCALE_WET * (width / 2 + 0.5);
    const wet2 = SCALE_WET * ((1 - width) / 2);
    for (let i = from; i < to; i++) {
      const l = inL[i]!;
      const r = inR[i]!;
      // Pre-delay (a length of 1 means none).
      this.pre[this.preIdx] = (l + r) * FIXED_GAIN;
      let readIdx = this.preIdx - (this.preLen - 1);
      if (readIdx < 0) readIdx += this.preLen;
      const x = this.pre[readIdx]!;
      if (++this.preIdx >= this.preLen) this.preIdx = 0;
      let accL = 0;
      let accR = 0;
      for (let c = 0; c < COMBS.length; c++) {
        accL += this.combsL[c]!.process(x, damp);
        accR += this.combsR[c]!.process(x, damp);
      }
      for (let a = 0; a < ALLPASSES.length; a++) {
        accL = this.apL[a]!.process(accL);
        accR = this.apR[a]!.process(accR);
      }
      outL[i] = l * (1 - mix) + (accL * wet1 + accR * wet2) * mix;
      outR[i] = r * (1 - mix) + (accR * wet1 + accL * wet2) * mix;
    }
  }

  reset(): void {
    for (const c of [...this.combsL, ...this.combsR]) {
      c.buf.fill(0);
      c.store = 0;
    }
    for (const a of [...this.apL, ...this.apR]) a.buf.fill(0);
    this.pre.fill(0);
  }
}
