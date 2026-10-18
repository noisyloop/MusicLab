/**
 * Linear-attack, exponential decay/release ADSR shared by the synth
 * instruments. Advanced one sample at a time with next().
 */

export const enum Stage {
  Idle,
  Attack,
  Decay,
  Sustain,
  Release,
}

export class Envelope {
  stage = Stage.Idle;
  level = 0;
  private attackInc = 0;
  private decayCoef = 0;
  private releaseCoef = 0;
  private sustain = 0;

  configure(sr: number, a: number, d: number, s: number, r: number): void {
    this.attackInc = 1 / Math.max(1, a * sr);
    // Exponential segments reaching -60 dB of their distance in the given time.
    this.decayCoef = Math.exp(Math.log(0.001) / Math.max(1, d * sr));
    this.releaseCoef = Math.exp(Math.log(0.001) / Math.max(1, r * sr));
    this.sustain = s;
  }

  gateOn(): void {
    this.stage = Stage.Attack;
  }

  gateOff(): void {
    if (this.stage !== Stage.Idle) this.stage = Stage.Release;
  }

  next(): number {
    switch (this.stage) {
      case Stage.Attack:
        this.level += this.attackInc;
        if (this.level >= 1) {
          this.level = 1;
          this.stage = Stage.Decay;
        }
        break;
      case Stage.Decay:
        this.level = this.sustain + (this.level - this.sustain) * this.decayCoef;
        if (Math.abs(this.level - this.sustain) < 1e-4) {
          this.level = this.sustain;
          this.stage = Stage.Sustain;
        }
        break;
      case Stage.Sustain:
        this.level = this.sustain;
        break;
      case Stage.Release:
        this.level *= this.releaseCoef;
        if (this.level < 1e-4) {
          this.level = 0;
          this.stage = Stage.Idle;
        }
        break;
      case Stage.Idle:
        break;
    }
    return this.level;
  }
}
