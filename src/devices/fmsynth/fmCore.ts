/**
 * DSP for the built-in 4-operator FM synth. Pure TypeScript with no Web
 * Audio dependency so it can run inside an AudioWorkletProcessor and in unit
 * tests alike.
 *
 * Per voice: four sine operators, each with a frequency ratio, a level and
 * its own ADSR. The algorithm decides which operators are carriers (heard)
 * and which phase-modulate others; operator 4 can also modulate itself
 * (feedback). Velocity scales the modulator levels (Vel→Mod), so harder
 * notes are brighter, as well as the output level (Vel Sens).
 *
 * Channel-wide MIDI expression: pitch bend (clamped to the Bend Range
 * parameter) takes effect at the exact sample its event lands on, with no
 * glide. CC 1, CC 74 and the configurable Bright CC scale every modulator.
 *
 * Every value is computed per sample, so the output does not depend on how
 * the host splits rendering into blocks.
 */
import { Envelope, Stage } from '../envelope';
import { defaultParams, type InstrumentCore } from '../types';
import { fmsynthDefinition } from './definition';

export const OPERATORS = 4;

/**
 * Operator wiring per algorithm (0-based operator indices). `mods[i]` lists
 * the operators that modulate operator i. A modulator always has a higher
 * index than its target, so rendering operators 4 → 1 sees every modulator's
 * output for this sample before it is used.
 */
export const ALGORITHMS: readonly { mods: readonly (readonly number[])[]; carriers: readonly number[] }[] = [
  { mods: [[1], [2], [3], []], carriers: [0] },
  { mods: [[1], [2, 3], [], []], carriers: [0] },
  { mods: [[1, 3], [2], [], []], carriers: [0] },
  { mods: [[1, 2], [], [3], []], carriers: [0] },
  { mods: [[1], [], [3], []], carriers: [0, 2] },
  { mods: [[3], [3], [3], []], carriers: [0, 1, 2] },
  { mods: [[], [], [3], []], carriers: [0, 1, 2] },
  { mods: [[], [], [], []], carriers: [0, 1, 2, 3] },
];

/** Peak phase deviation (radians) of a modulator at Level 1, full velocity, and brightness 1 (controllers at rest). */
export const MOD_INDEX = 6;
/** Peak phase deviation (radians) of operator 4 feeding back on itself at Feedback 1. */
const FEEDBACK_INDEX = Math.PI;
/** An operator is muted rather than aliased once its frequency reaches this fraction of the sample rate. */
const MAX_OP_FREQ = 0.45;

const TABLE_BITS = 12;
const TABLE_SIZE = 1 << TABLE_BITS;
const SINE = new Float64Array(TABLE_SIZE + 1);
for (let i = 0; i <= TABLE_SIZE; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE_SIZE);

/** sin(2π·phase) for any real phase (in cycles), from a linearly interpolated table. */
export function sineCycles(phase: number): number {
  const x = (phase - Math.floor(phase)) * TABLE_SIZE;
  const whole = x | 0;
  // A tiny negative phase rounds up to exactly 1 cycle (x === TABLE_SIZE); wrap it to 0.
  const i = whole & (TABLE_SIZE - 1);
  const a = SINE[i]!;
  return a + (SINE[i + 1]! - a) * (x - whole);
}

class Voice {
  pitch = -1;
  velocity = 0;
  age = 0;
  gate = false;
  phase = new Float64Array(OPERATORS);
  env: Envelope[] = [];
  /** Operator 4's last two outputs, averaged for feedback (tames its instability). */
  fb1 = 0;
  fb2 = 0;
  /** Used for quick fade-out when a voice is stolen or hard-reset. */
  fade = 1;
  fadeStep = 0;

  constructor() {
    for (let i = 0; i < OPERATORS; i++) this.env.push(new Envelope());
  }

  /** Sounding while any carrier's envelope is running. */
  activeFor(carriers: readonly number[]): boolean {
    for (const c of carriers) if (this.env[c]!.stage !== Stage.Idle) return true;
    return false;
  }

  reset(): void {
    this.phase.fill(0);
    this.fb1 = 0;
    this.fb2 = 0;
  }

  kill(): void {
    for (const e of this.env) {
      e.stage = Stage.Idle;
      e.level = 0;
    }
  }
}

/** CC 74 ("brightness") is bipolar around this value; CC 1 and the Bright CC are unipolar from 0. */
const CC74_CENTER = 64;
/** Upper bound on the controller brightness multiplier. */
export const MAX_BRIGHTNESS = 3;

function initialControllers(): Uint8Array {
  const cc = new Uint8Array(128);
  cc[74] = CC74_CENTER;
  return cc;
}

export const MAX_VOICES = 16;

export class FmCore implements InstrumentCore {
  private voices: Voice[] = [];
  private params: Record<string, number> = defaultParams(fmsynthDefinition);
  private ageCounter = 0;
  /** Current pitch bend in semitones, before clamping to bendRange. */
  private bend = 0;
  private cc = initialControllers();

  constructor(private readonly sampleRate: number, params: Record<string, number> = {}) {
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.setParams(params);
  }

  setParams(values: Record<string, number>): void {
    const p = this.params;
    for (const [k, v] of Object.entries(values)) {
      if (k in p && Number.isFinite(v)) p[k] = v;
    }
    for (const v of this.voices) this.configureEnvelopes(v);
  }

  private configureEnvelopes(v: Voice): void {
    const p = this.params;
    for (let i = 0; i < OPERATORS; i++) {
      const n = i + 1;
      v.env[i]!.configure(this.sampleRate, p[`op${n}Attack`]!, p[`op${n}Decay`]!, p[`op${n}Sustain`]!, p[`op${n}Release`]!);
    }
  }

  private get algorithm(): (typeof ALGORITHMS)[number] {
    const i = Math.min(ALGORITHMS.length - 1, Math.max(0, Math.round(this.params.algorithm!)));
    return ALGORITHMS[i]!;
  }

  get activeVoices(): number {
    const { carriers } = this.algorithm;
    return this.voices.filter((v) => v.activeFor(carriers)).length;
  }

  noteOn(pitch: number, velocity: number): void {
    if (velocity <= 0) {
      this.noteOff(pitch);
      return;
    }
    const { carriers } = this.algorithm;
    let voice = this.voices.find((v) => v.activeFor(carriers) && v.gate && v.pitch === pitch);
    if (!voice) voice = this.voices.find((v) => !v.activeFor(carriers));
    if (!voice) {
      // Steal: prefer the oldest released voice, then the oldest overall.
      const released = this.voices.filter((v) => !v.gate);
      const pool = released.length > 0 ? released : this.voices;
      voice = pool.reduce((a, b) => (a.age <= b.age ? a : b));
      voice.kill();
    }
    if (!voice.activeFor(carriers)) voice.reset();
    voice.pitch = pitch;
    voice.velocity = velocity;
    voice.gate = true;
    voice.age = ++this.ageCounter;
    voice.fade = 1;
    voice.fadeStep = 0;
    this.configureEnvelopes(voice);
    for (const e of voice.env) e.gateOn();
  }

  noteOff(pitch: number): void {
    for (const v of this.voices) {
      if (v.gate && v.pitch === pitch) {
        v.gate = false;
        for (const e of v.env) e.gateOff();
      }
    }
  }

  /** Release all voices. With `hard`, fade them out within ~5 ms and reset controllers. */
  allNotesOff(hard = false): void {
    const { carriers } = this.algorithm;
    for (const v of this.voices) {
      v.gate = false;
      for (const e of v.env) e.gateOff();
      if (hard && v.activeFor(carriers)) v.fadeStep = 1 / (0.005 * this.sampleRate);
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
    const range = Math.max(0, this.params.bendRange!);
    return Math.min(range, Math.max(-range, this.bend));
  }

  /**
   * Multiplier on every modulator's level from CC 1, CC 74 and the Bright CC:
   * 1 with controllers at rest, 0 (pure sines) with CC 74 at 0.
   */
  get brightness(): number {
    const bcc = Math.round(this.params.brightCc!);
    let b = 1 + this.cc[1]! / 127 + (this.cc[74]! - CC74_CENTER) / CC74_CENTER;
    if (bcc !== 1 && bcc !== 74 && bcc >= 0 && bcc < 128) b += this.cc[bcc]! / 127;
    return Math.min(MAX_BRIGHTNESS, Math.max(0, b));
  }

  /** Add the synth output to outL/outR in the frame range [from, to). */
  render(outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const p = this.params;
    const sr = this.sampleRate;
    const { mods, carriers } = this.algorithm;
    // Bend is constant between events, and the host splits rendering at every
    // event's exact frame, so this applies the bend per sample with no glide.
    const pitchMul = Math.pow(2, Math.round(p.octave!) + this.bendSemitones / 12);
    const modDepth = (MOD_INDEX / (2 * Math.PI)) * this.brightness;
    const fbDepth = (FEEDBACK_INDEX / (2 * Math.PI)) * Math.min(1, Math.max(0, p.feedback!));
    const carrierMix = (p.gain! * 0.35) / carriers.length;
    // 1 where operator m modulates operator t, and where an operator is heard.
    const wired = (t: number, m: number) => (mods[t]!.includes(m) ? 1 : 0);
    const w01 = wired(0, 1), w02 = wired(0, 2), w03 = wired(0, 3), w12 = wired(1, 2), w13 = wired(1, 3), w23 = wired(2, 3);
    const heard = (op: number) => (carriers.includes(op) ? 1 : 0);
    const c0 = heard(0), c1 = heard(1), c2 = heard(2), c3 = heard(3);
    const level = (op: number, dt: number) => (dt < MAX_OP_FREQ ? p[`op${op + 1}Level`]! : 0);
    for (const v of this.voices) {
      if (!v.activeFor(carriers)) continue;
      const base = (440 * Math.pow(2, (v.pitch - 69) / 12) * pitchMul) / sr;
      const dt0 = base * p.op1Ratio!, dt1 = base * p.op2Ratio!, dt2 = base * p.op3Ratio!, dt3 = base * p.op4Ratio!;
      // An operator that would alias is silent instead.
      const l0 = level(0, dt0), l1 = level(1, dt1), l2 = level(2, dt2), l3 = level(3, dt3);
      // A modulator's output, in cycles of phase deviation for its targets.
      const ms = (1 - p.velMod! + p.velMod! * v.velocity) * modDepth;
      const m01 = w01 * ms, m02 = w02 * ms, m03 = w03 * ms, m12 = w12 * ms, m13 = w13 * ms, m23 = w23 * ms;
      const velGain = carrierMix * (1 - p.velSens! + p.velSens! * v.velocity);
      const { phase, env } = v;
      const e0 = env[0]!, e1 = env[1]!, e2 = env[2]!, e3 = env[3]!;
      let ph0 = phase[0]!, ph1 = phase[1]!, ph2 = phase[2]!, ph3 = phase[3]!;
      for (let i = from; i < to; i++) {
        // Operators 4 -> 1: every modulator has a higher index than its target.
        const o3 = sineCycles(ph3 + fbDepth * 0.5 * (v.fb1 + v.fb2)) * e3.next() * l3;
        const o2 = sineCycles(ph2 + m23 * o3) * e2.next() * l2;
        const o1 = sineCycles(ph1 + m12 * o2 + m13 * o3) * e1.next() * l1;
        const o0 = sineCycles(ph0 + m01 * o1 + m02 * o2 + m03 * o3) * e0.next() * l0;
        const sum = c0 * o0 + c1 * o1 + c2 * o2 + c3 * o3;
        v.fb2 = v.fb1;
        v.fb1 = o3;
        ph0 += dt0;
        if (ph0 >= 1) ph0 -= 1;
        ph1 += dt1;
        if (ph1 >= 1) ph1 -= 1;
        ph2 += dt2;
        if (ph2 >= 1) ph2 -= 1;
        ph3 += dt3;
        if (ph3 >= 1) ph3 -= 1;
        let gain = velGain;
        if (v.fadeStep > 0) {
          v.fade -= v.fadeStep;
          if (v.fade <= 0) {
            v.fade = 0;
            v.kill();
          }
          gain *= v.fade;
        }
        const s = sum * gain;
        outL[i] = (outL[i] ?? 0) + s;
        outR[i] = (outR[i] ?? 0) + s;
        // Inline activeFor(carriers): this runs every sample.
        if ((c0 === 0 || e0.stage === Stage.Idle) && (c1 === 0 || e1.stage === Stage.Idle) && (c2 === 0 || e2.stage === Stage.Idle) && (c3 === 0 || e3.stage === Stage.Idle)) break;
      }
      phase[0] = ph0;
      phase[1] = ph1;
      phase[2] = ph2;
      phase[3] = ph3;
    }
  }
}
