/**
 * Delay DSP: one line per channel with a linearly interpolated read. The wet
 * signal goes through one-pole low- and high-pass filters, and that filtered
 * signal is what feeds back. Ping-pong feeds a mono sum into the left line
 * and crosses the feedback between channels. The delay time glides (50 ms)
 * when it changes, e.g. when a synced delay follows a tempo change.
 */
import { BaseEffect } from '../define';
import { onePoleCoef, timeCoef } from '../dsp';
import { delayDefinition, delayTimeSeconds, MAX_DELAY_S } from './definition';

export class DelayCore extends BaseEffect {
  private readonly len: number;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private write = 0;
  private current = -1;
  private target = 1;
  private readonly glide: number;
  private lpA = 0;
  private hpA = 0;
  private lp = [0, 0];
  private hpLow = [0, 0];

  constructor(sampleRate: number, params: Record<string, number> = {}) {
    super(sampleRate, delayDefinition, params);
    this.len = Math.ceil(MAX_DELAY_S * sampleRate) + 4;
    this.bufL = new Float32Array(this.len);
    this.bufR = new Float32Array(this.len);
    this.glide = timeCoef(sampleRate, 0.05);
    this.update();
  }

  /** Current target delay in samples. */
  get delaySamples(): number {
    return this.target;
  }

  protected update(): void {
    const sr = this.sampleRate;
    this.target = Math.min(this.len - 3, Math.max(1, delayTimeSeconds(this.p, this.bpm, this.beatsPerBar) * sr));
    if (this.current < 0) this.current = this.target;
    this.lpA = onePoleCoef(sr, this.p.lowpass!);
    this.hpA = onePoleCoef(sr, this.p.highpass!);
  }

  private read(buf: Float32Array, delay: number): number {
    let pos = this.write - delay;
    if (pos < 0) pos += this.len;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = buf[i]!;
    const b = buf[i + 1 === this.len ? 0 : i + 1]!;
    return a + (b - a) * frac;
  }

  private filter(x: number, ch: number): number {
    const lp = (this.lp[ch]! += this.lpA * (x - this.lp[ch]!));
    const low = (this.hpLow[ch]! += this.hpA * (lp - this.hpLow[ch]!));
    return lp - low;
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const fb = this.p.feedback!;
    const mix = this.p.mix!;
    const ping = Math.round(this.p.pingPong!) === 1;
    for (let i = from; i < to; i++) {
      this.current = this.target + (this.current - this.target) * this.glide;
      const wl = this.filter(this.read(this.bufL, this.current), 0);
      const wr = this.filter(this.read(this.bufR, this.current), 1);
      const l = inL[i]!;
      const r = inR[i]!;
      if (ping) {
        this.bufL[this.write] = (l + r) * 0.5 + fb * wr;
        this.bufR[this.write] = fb * wl;
      } else {
        this.bufL[this.write] = l + fb * wl;
        this.bufR[this.write] = r + fb * wr;
      }
      if (++this.write === this.len) this.write = 0;
      outL[i] = l * (1 - mix) + wl * mix;
      outR[i] = r * (1 - mix) + wr * mix;
    }
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.lp = [0, 0];
    this.hpLow = [0, 0];
    this.current = this.target;
  }
}
