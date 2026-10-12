/**
 * Filter DSP: a TPT state-variable filter (low/high/band-pass) per channel.
 * The optional LFO moves the cutoff by +/- depth octaves with a sine whose
 * phase follows the song position in beats, so it lines up with the bar
 * the same way live and in an offline render.
 */
import { BaseEffect } from '../define';
import { clamp } from '../dsp';
import { FILTER_LFO_RATES, filterDefinition } from './definition';

export class FilterCore extends BaseEffect {
  private ic1 = [0, 0];
  private ic2 = [0, 0];
  private g = 0;
  private k = 2;
  private lfoPeriod = 0;
  private beatStep = 0;

  constructor(sampleRate: number, params: Record<string, number> = {}) {
    super(sampleRate, filterDefinition, params);
    this.update();
  }

  /** Cutoff (Hz) at a song position, including the LFO. */
  cutoffAt(beat: number): number {
    let fc = this.p.cutoff!;
    if (this.lfoPeriod > 0) fc *= Math.pow(2, this.p.lfoDepth! * Math.sin((2 * Math.PI * beat) / this.lfoPeriod));
    return clamp(fc, 10, this.sampleRate * 0.45);
  }

  protected update(): void {
    this.k = 2 - 1.96 * clamp(this.p.resonance!, 0, 1);
    const rate = FILTER_LFO_RATES[Math.round(this.p.lfoRate!)] ?? FILTER_LFO_RATES[0]!;
    this.lfoPeriod = rate.bars ? rate.beats * this.beatsPerBar : rate.beats;
    this.beatStep = this.bpm / 60 / this.sampleRate;
    this.g = Math.tan((Math.PI * this.cutoffAt(this.beat)) / this.sampleRate);
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const mode = Math.round(this.p.mode!);
    const k = this.k;
    const lfo = this.lfoPeriod > 0;
    let g = this.g;
    for (let i = from; i < to; i++) {
      if (lfo) g = Math.tan((Math.PI * this.cutoffAt(this.beat)) / this.sampleRate);
      this.beat += this.beatStep;
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      for (let ch = 0; ch < 2; ch++) {
        const x = ch === 0 ? inL[i]! : inR[i]!;
        const v3 = x - this.ic2[ch]!;
        const v1 = a1 * this.ic1[ch]! + a2 * v3;
        const v2 = this.ic2[ch]! + a2 * this.ic1[ch]! + a3 * v3;
        this.ic1[ch] = 2 * v1 - this.ic1[ch]!;
        this.ic2[ch] = 2 * v2 - this.ic2[ch]!;
        const y = mode === 1 ? x - k * v1 - v2 : mode === 2 ? v1 : v2;
        if (ch === 0) outL[i] = y;
        else outR[i] = y;
      }
    }
    this.g = g;
  }

  reset(): void {
    this.ic1 = [0, 0];
    this.ic2 = [0, 0];
  }
}
