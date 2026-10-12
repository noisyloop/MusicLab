/**
 * The effect half of the Device interface: a pure-TypeScript DSP core plus
 * EffectRunner, which adds click-free bypass. The worklet host
 * (effectHost.ts) only moves samples and messages; everything audible
 * happens here, so it is unit-tested in Node.
 */

export interface EffectCore {
  setParams(values: Record<string, number>): void;
  /** Tempo and song position (beats) at the next processed sample. */
  setTransport(beat: number, bpm: number, beatsPerBar: number): void;
  /** Write the processed input into out (not add) for frames [from, to). */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void;
  /** Clear all internal state (delay lines, filters, envelopes). */
  reset(): void;
  /** A value to show in the UI (e.g. gain reduction in dB), if the effect has one. */
  meter?(): number;
}

/** Bypass crossfade length. */
export const BYPASS_FADE_S = 0.01;

/**
 * Runs an EffectCore with bypass. Fully bypassed, the input is copied to the
 * output untouched (bit-identical) and the core does no work. Toggling
 * crossfades between the processed and the dry signal over 10 ms. A core
 * coming back from full bypass starts from a clean state.
 */
export class EffectRunner {
  /** 0 = processed, 1 = bypassed. */
  private mix: number;
  private target: number;
  private readonly step: number;
  private scratchL = new Float32Array(128);
  private scratchR = new Float32Array(128);

  constructor(readonly core: EffectCore, sampleRate: number, bypass = false) {
    this.mix = this.target = bypass ? 1 : 0;
    this.step = 1 / Math.max(1, BYPASS_FADE_S * sampleRate);
  }

  get bypassed(): boolean {
    return this.target === 1;
  }

  /** Toggle bypass; `immediate` skips the crossfade (initial state). */
  setBypass(bypass: boolean, immediate = false): void {
    const t = bypass ? 1 : 0;
    if (t === 0 && this.mix === 1) this.core.reset();
    this.target = t;
    if (immediate) this.mix = t;
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    if (this.mix === 1 && this.target === 1) {
      outL.set(inL.subarray(from, to), from);
      outR.set(inR.subarray(from, to), from);
      return;
    }
    if (this.mix === 0 && this.target === 0) {
      this.core.process(inL, inR, outL, outR, from, to);
      return;
    }
    if (this.scratchL.length < to) {
      this.scratchL = new Float32Array(to);
      this.scratchR = new Float32Array(to);
    }
    this.core.process(inL, inR, this.scratchL, this.scratchR, from, to);
    for (let i = from; i < to; i++) {
      if (this.mix < this.target) this.mix = Math.min(this.target, this.mix + this.step);
      else if (this.mix > this.target) this.mix = Math.max(this.target, this.mix - this.step);
      const m = this.mix;
      outL[i] = this.scratchL[i]! * (1 - m) + inL[i]! * m;
      outR[i] = this.scratchR[i]! * (1 - m) + inR[i]! * m;
    }
  }
}
