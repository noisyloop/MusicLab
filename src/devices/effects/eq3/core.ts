/** EQ3 DSP: low-cut (12 dB/oct) -> low shelf -> peaking mid -> high shelf, RBJ biquads. */
import { BaseEffect } from '../define';
import { Biquad } from '../dsp';
import { eq3Definition } from './definition';

export class Eq3Core extends BaseEffect {
  private cut = new Biquad();
  private low = new Biquad();
  private mid = new Biquad();
  private high = new Biquad();

  constructor(sampleRate: number, params: Record<string, number> = {}) {
    super(sampleRate, eq3Definition, params);
    this.update();
  }

  protected update(): void {
    const { p, sampleRate: sr } = this;
    this.cut.highpass(sr, p.lowCut!);
    this.low.lowShelf(sr, p.lowFreq!, p.lowGain!);
    this.mid.peaking(sr, p.midFreq!, p.midGain!, p.midQ!);
    this.high.highShelf(sr, p.highFreq!, p.highGain!);
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const { cut, low, mid, high } = this;
    for (let i = from; i < to; i++) {
      outL[i] = high.process(mid.process(low.process(cut.process(inL[i]!, 0), 0), 0), 0);
      outR[i] = high.process(mid.process(low.process(cut.process(inR[i]!, 1), 1), 1), 1);
    }
  }

  reset(): void {
    for (const b of [this.cut, this.low, this.mid, this.high]) b.reset();
  }
}
