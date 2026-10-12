/**
 * DSP for the built-in polyphonic subtractive synth. Pure TypeScript with no
 * Web Audio dependency so it can run inside an AudioWorkletProcessor and in
 * unit tests alike.
 *
 * Per voice: two detuned oscillators (PolyBLEP saw/square, triangle, sine)
 * -> 12 dB/oct state-variable low-pass filter with its own ADSR -> amp ADSR.
 *
 * Channel-wide MIDI expression: pitch bend (clamped to the Bend Range
 * parameter) takes effect at the exact sample its event lands on, with no
 * glide. CC 1, CC 74 and the configurable Filter CC move the filter cutoff.
 */
import type { InstrumentCore } from '../types';

const enum Stage {
  Idle,
  Attack,
  Decay,
  Sustain,
  Release,
}

class Envelope {
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

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

function osc(wave: number, phase: number, dt: number): number {
  switch (wave) {
    case 0: // saw
      return 2 * phase - 1 - polyBlep(phase, dt);
    case 1: {
      // square
      let v = phase < 0.5 ? 1 : -1;
      v += polyBlep(phase, dt);
      v -= polyBlep((phase + 0.5) % 1, dt);
      return v;
    }
    case 2: // triangle
      return 1 - 4 * Math.abs(phase - 0.5);
    default:
      return Math.sin(2 * Math.PI * phase);
  }
}

class Voice {
  pitch = -1;
  velocity = 0;
  age = 0;
  gate = false;
  phase1 = 0;
  phase2 = 0;
  amp = new Envelope();
  fenv = new Envelope();
  ic1 = 0;
  ic2 = 0;
  /** Used for quick fade-out when a voice is stolen or hard-reset. */
  fade = 1;
  fadeStep = 0;

  get active(): boolean {
    return this.amp.stage !== 0;
  }
}

export interface SynthParams {
  wave: number;
  osc2Mix: number;
  detune: number;
  octave: number;
  cutoff: number;
  resonance: number;
  envAmount: number;
  fAttack: number;
  fDecay: number;
  fSustain: number;
  fRelease: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  velSens: number;
  gain: number;
  bendRange: number;
  filterCc: number;
}

const DEFAULTS: SynthParams = {
  wave: 0, osc2Mix: 0.5, detune: 8, octave: 0, cutoff: 2200, resonance: 0.2, envAmount: 0.4,
  fAttack: 0.005, fDecay: 0.3, fSustain: 0.2, fRelease: 0.3,
  attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.25, velSens: 0.7, gain: 0.5,
  bendRange: 12, filterCc: 20,
};

/** Octaves of cutoff movement for a full controller sweep. */
export const CC_FILTER_OCTAVES = 4;
/** CC 74 ("brightness") is bipolar around this value; CC 1 and the Filter CC are unipolar from 0. */
const CC74_CENTER = 64;

function initialControllers(): Uint8Array {
  const cc = new Uint8Array(128);
  cc[74] = CC74_CENTER;
  return cc;
}

export const MAX_VOICES = 16;
const FILTER_BLOCK = 16;

export class SynthCore implements InstrumentCore {
  private voices: Voice[] = [];
  private params: SynthParams = { ...DEFAULTS };
  private ageCounter = 0;
  /** Current pitch bend in semitones, before clamping to bendRange. */
  private bend = 0;
  private cc = initialControllers();

  constructor(private readonly sampleRate: number, params: Record<string, number> = {}) {
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.setParams(params);
  }

  setParams(values: Record<string, number>): void {
    const p = this.params as unknown as Record<string, number>; // SynthParams is a flat record of numbers
    for (const [k, v] of Object.entries(values)) {
      if (k in p && Number.isFinite(v)) p[k] = v;
    }
    for (const v of this.voices) this.configureEnvelopes(v);
  }

  private configureEnvelopes(v: Voice): void {
    const p = this.params;
    v.amp.configure(this.sampleRate, p.attack, p.decay, p.sustain, p.release);
    v.fenv.configure(this.sampleRate, p.fAttack, p.fDecay, p.fSustain, p.fRelease);
  }

  get activeVoices(): number {
    return this.voices.filter((v) => v.active).length;
  }

  noteOn(pitch: number, velocity: number): void {
    if (velocity <= 0) {
      this.noteOff(pitch);
      return;
    }
    let voice = this.voices.find((v) => v.active && v.gate && v.pitch === pitch);
    if (!voice) voice = this.voices.find((v) => !v.active);
    if (!voice) {
      // Steal: prefer the oldest released voice, then the oldest overall.
      const released = this.voices.filter((v) => !v.gate);
      const pool = released.length > 0 ? released : this.voices;
      voice = pool.reduce((a, b) => (a.age <= b.age ? a : b));
      voice.ic1 = 0;
      voice.ic2 = 0;
      voice.amp.level = 0;
      voice.fenv.level = 0;
    }
    if (!voice.active) {
      voice.phase1 = 0;
      voice.phase2 = 0.37;
      voice.ic1 = 0;
      voice.ic2 = 0;
    }
    voice.pitch = pitch;
    voice.velocity = velocity;
    voice.gate = true;
    voice.age = ++this.ageCounter;
    voice.fade = 1;
    voice.fadeStep = 0;
    this.configureEnvelopes(voice);
    voice.amp.gateOn();
    voice.fenv.gateOn();
  }

  noteOff(pitch: number): void {
    for (const v of this.voices) {
      if (v.gate && v.pitch === pitch) {
        v.gate = false;
        v.amp.gateOff();
        v.fenv.gateOff();
      }
    }
  }

  /** Release all voices. With `hard`, fade them out within ~5 ms and reset controllers. */
  allNotesOff(hard = false): void {
    for (const v of this.voices) {
      v.gate = false;
      v.amp.gateOff();
      v.fenv.gateOff();
      if (hard && v.active) v.fadeStep = 1 / (0.005 * this.sampleRate);
    }
    if (hard) {
      this.bend = 0;
      this.cc = initialControllers();
    }
  }

  pitchBend(semitones: number): void {
    if (Number.isFinite(semitones)) this.bend = semitones;
  }

  controlChange(controller: number, value: number): void {
    if (controller >= 0 && controller < 128) this.cc[controller] = Math.min(127, Math.max(0, Math.round(value)));
  }

  /** Effective bend in semitones (clamped to the Bend Range parameter). */
  get bendSemitones(): number {
    const range = Math.max(0, this.params.bendRange);
    return Math.min(range, Math.max(-range, this.bend));
  }

  /** Cutoff offset in octaves from CC 1, CC 74 and the Filter CC. */
  get controllerCutoffOctaves(): number {
    const fcc = Math.round(this.params.filterCc);
    let oct = (this.cc[1]! / 127) * CC_FILTER_OCTAVES + ((this.cc[74]! - CC74_CENTER) / CC74_CENTER) * CC_FILTER_OCTAVES;
    if (fcc !== 1 && fcc !== 74 && fcc >= 0 && fcc < 128) oct += (this.cc[fcc]! / 127) * CC_FILTER_OCTAVES;
    return oct;
  }

  /** Add the synth output to outL/outR in the frame range [from, to). */
  render(outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const p = this.params;
    const sr = this.sampleRate;
    const nyq = sr * 0.45;
    const k = 2 - 1.96 * Math.min(1, Math.max(0, p.resonance));
    const wave = Math.round(p.wave);
    const detuneRatio = Math.pow(2, p.detune / 1200 / 2);
    // Bend is constant between events, and the host splits rendering at every
    // event's exact frame, so this applies the bend per sample with no glide.
    const octaveMul = Math.pow(2, Math.round(p.octave) + this.bendSemitones / 12);
    const cutoff = p.cutoff * Math.pow(2, this.controllerCutoffOctaves);
    const level = p.gain * 0.35;
    for (const v of this.voices) {
      if (!v.active) continue;
      const base = 440 * Math.pow(2, (v.pitch - 69) / 12) * octaveMul;
      const dt1 = Math.min(0.5, base / detuneRatio / sr);
      const dt2 = Math.min(0.5, (base * detuneRatio) / sr);
      const velGain = level * (1 - p.velSens + p.velSens * v.velocity);
      let g = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let i = from; i < to; i++) {
        if ((i - from) % FILTER_BLOCK === 0) {
          const fe = v.fenv.level;
          const fc = Math.min(nyq, Math.max(20, cutoff * Math.pow(2, p.envAmount * 7 * fe)));
          g = Math.tan((Math.PI * fc) / sr);
          a1 = 1 / (1 + g * (g + k));
          a2 = g * a1;
          a3 = g * a2;
        }
        const s = osc(wave, v.phase1, dt1) * (1 - p.osc2Mix) + osc(wave, v.phase2, dt2) * p.osc2Mix;
        v.phase1 += dt1;
        if (v.phase1 >= 1) v.phase1 -= 1;
        v.phase2 += dt2;
        if (v.phase2 >= 1) v.phase2 -= 1;
        // TPT state-variable filter, low-pass output.
        const v3 = s - v.ic2;
        const v1 = a1 * v.ic1 + a2 * v3;
        const v2 = v.ic2 + a2 * v.ic1 + a3 * v3;
        v.ic1 = 2 * v1 - v.ic1;
        v.ic2 = 2 * v2 - v.ic2;
        v.fenv.next();
        let env = v.amp.next();
        if (v.fadeStep > 0) {
          v.fade -= v.fadeStep;
          if (v.fade <= 0) {
            v.fade = 0;
            v.amp.stage = 0;
            v.amp.level = 0;
            v.fenv.stage = 0;
            v.fenv.level = 0;
          }
          env *= v.fade;
        }
        const out = v2 * env * velGain;
        outL[i] = (outL[i] ?? 0) + out;
        outR[i] = (outR[i] ?? 0) + out;
        if (!v.active) break;
      }
    }
  }
}
