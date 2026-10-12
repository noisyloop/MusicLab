/**
 * DSP for the built-in drum kit: every sound is synthesized (no samples),
 * mapped to General MIDI drum note numbers. Pure TypeScript with no Web Audio
 * dependency, like SynthCore.
 *
 * Rendering is deterministic and block-size independent: all state advances
 * per sample, and each hit seeds its own noise generator from its note
 * number. The same events therefore produce bit-identical audio in live
 * playback and offline (WAV) rendering, whatever the render-quantum splits.
 */
import type { InstrumentCore } from '../types';
import { DRUM_GROUPS, levelParam, tuneParam, type DrumGroup } from './definition';

type FilterMode = 'lp' | 'bp' | 'hp';

interface ToneSpec {
  /** Base frequency (Hz) before tuning. */
  freq: number;
  /** Extra pitch at the hit, as a multiple of freq, decaying with pitchDecay. */
  pitchDepth: number;
  /** Seconds for the pitch sweep to fall by 60 dB. */
  pitchDecay: number;
  /** Seconds for the amplitude to fall by 60 dB. */
  decay: number;
  level: number;
}

interface NoiseSpec {
  mode: FilterMode;
  /** Filter frequency (Hz) before tuning. */
  freq: number;
  q: number;
  decay: number;
  level: number;
  /** Mix of metallic square partials (0 = pure noise). */
  metal: number;
}

export interface DrumSpec {
  group: DrumGroup;
  tone?: ToneSpec;
  noise?: NoiseSpec;
  /** Hand-clap style re-triggers of the noise envelope. */
  bursts?: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** Starting this sound cuts voices with the same choke id (hi-hats). */
  choke?: number;
  /** Voices with this id are cut by a choking sound. */
  chokedBy?: number;
}

const HAT_CHOKE = 1;

const kick = (freq: number): DrumSpec => ({
  group: 'kick',
  tone: { freq, pitchDepth: 3, pitchDecay: 0.06, decay: 0.45, level: 1 },
  noise: { mode: 'bp', freq: 3000, q: 0.7, decay: 0.006, level: 0.25, metal: 0 },
  pan: 0,
});
const snare = (freq: number, noiseFreq: number, decay: number): DrumSpec => ({
  group: 'snare',
  tone: { freq, pitchDepth: 0.5, pitchDecay: 0.03, decay: 0.12, level: 0.45 },
  noise: { mode: 'bp', freq: noiseFreq, q: 0.6, decay, level: 0.75, metal: 0 },
  pan: 0.05,
});
const hat = (decay: number, freq: number, level: number, metal: number, extra: Partial<DrumSpec> = {}): DrumSpec => ({
  group: 'hats',
  noise: { mode: 'hp', freq, q: 0.8, decay, level, metal },
  pan: 0.25,
  ...extra,
});
const tom = (freq: number, pan: number): DrumSpec => ({
  group: 'toms',
  tone: { freq, pitchDepth: 0.6, pitchDecay: 0.12, decay: 0.42, level: 0.9 },
  noise: { mode: 'lp', freq: 1500, q: 0.7, decay: 0.03, level: 0.15, metal: 0 },
  pan,
});

/** General MIDI drum map (notes outside it, in 27..87, play blips). */
const GM_MAP: Record<number, DrumSpec> = {
  35: kick(45),
  36: kick(52),
  37: {
    group: 'rim',
    tone: { freq: 1700, pitchDepth: 0, pitchDecay: 0.01, decay: 0.025, level: 0.6 },
    noise: { mode: 'bp', freq: 2500, q: 2, decay: 0.03, level: 0.45, metal: 0 },
    pan: -0.1,
  },
  38: snare(185, 4000, 0.17),
  39: { group: 'clap', noise: { mode: 'bp', freq: 1200, q: 1.2, decay: 0.14, level: 1, metal: 0 }, bursts: 3, pan: -0.05 },
  40: snare(205, 5000, 0.14),
  41: tom(82, -0.4),
  42: hat(0.05, 7000, 0.6, 0.5, { choke: HAT_CHOKE }),
  43: tom(98, -0.3),
  44: hat(0.08, 7000, 0.45, 0.5, { choke: HAT_CHOKE }),
  45: tom(116, -0.15),
  46: hat(0.5, 6500, 0.55, 0.5, { chokedBy: HAT_CHOKE }),
  47: tom(138, 0),
  48: tom(164, 0.15),
  49: hat(1.5, 5000, 0.5, 0.35, { pan: -0.35 }),
  50: tom(195, 0.3),
  51: hat(1.0, 6000, 0.4, 0.7, { pan: 0.4 }),
  52: hat(1.1, 4000, 0.5, 0.5, { pan: -0.45 }),
  53: hat(0.8, 3500, 0.45, 0.9, { pan: 0.4 }),
  55: hat(0.7, 6000, 0.45, 0.35, { pan: -0.3 }),
  57: hat(1.5, 4500, 0.5, 0.35, { pan: 0.35 }),
  59: hat(1.0, 5500, 0.4, 0.7, { pan: 0.45 }),
};

function blip(pitch: number): DrumSpec {
  return {
    group: 'blips',
    tone: { freq: 440 * Math.pow(2, (pitch - 57) / 12), pitchDepth: 0.25, pitchDecay: 0.015, decay: 0.1, level: 0.55 },
    pan: ((pitch % 7) - 3) / 6,
  };
}

/** The sound a note number triggers, or undefined if the kit doesn't map it. */
export function drumSpecForNote(pitch: number): DrumSpec | undefined {
  return GM_MAP[pitch] ?? (pitch >= 27 && pitch <= 87 ? blip(pitch) : undefined);
}

/** 808-style metallic partials (Hz). */
const METAL_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];

const SILENT = 1e-4;

/** Per-sample multiplier that takes an envelope down 60 dB in `seconds`. */
function decayCoef(seconds: number, sr: number): number {
  return Math.exp(Math.log(0.001) / Math.max(1, seconds * sr));
}

class DrumVoice {
  active = false;
  spec: DrumSpec = blip(60);
  age = 0;
  velocity = 0;
  t = 0;
  // tone
  phase = 0;
  toneFreq = 0;
  toneEnv = 0;
  toneCoef = 0;
  pitchEnv = 0;
  pitchCoef = 0;
  // noise
  seed = 1;
  noiseEnv = 0;
  noiseCoef = 0;
  burstInterval = 0;
  metalPhases = new Float64Array(METAL_FREQS.length);
  metalInc = new Float64Array(METAL_FREQS.length);
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  k = 1;
  // output
  panL = 1;
  panR = 1;
  fade = 1;
  fadeStep = 0;
}

export const MAX_DRUM_VOICES = 32;

export class DrumCore implements InstrumentCore {
  private voices: DrumVoice[] = [];
  private params: Record<string, number> = {};
  private ageCounter = 0;

  constructor(private readonly sampleRate: number, params: Record<string, number> = {}) {
    for (const g of DRUM_GROUPS) {
      this.params[levelParam(g.id)] = 0.8;
      this.params[tuneParam(g.id)] = 0;
    }
    for (let i = 0; i < MAX_DRUM_VOICES; i++) this.voices.push(new DrumVoice());
    this.setParams(params);
  }

  setParams(values: Record<string, number>): void {
    for (const [k, v] of Object.entries(values)) {
      if (k in this.params && Number.isFinite(v)) this.params[k] = v;
    }
  }

  get activeVoices(): number {
    return this.voices.filter((v) => v.active).length;
  }

  noteOn(pitch: number, velocity: number): void {
    if (velocity <= 0) return;
    const spec = drumSpecForNote(pitch);
    if (!spec) return;
    const sr = this.sampleRate;
    if (spec.choke !== undefined) {
      for (const v of this.voices) if (v.active && v.spec.chokedBy === spec.choke && v.fadeStep === 0) v.fadeStep = 1 / (0.005 * sr);
    }
    let voice = this.voices.find((v) => !v.active);
    if (!voice) voice = this.voices.reduce((a, b) => (a.age <= b.age ? a : b));
    const tune = Math.pow(2, (this.params[tuneParam(spec.group)] ?? 0) / 12);
    const v = voice;
    v.active = true;
    v.spec = spec;
    v.age = ++this.ageCounter;
    v.velocity = Math.min(1, velocity);
    v.t = 0;
    v.fade = 1;
    v.fadeStep = 0;
    v.phase = 0;
    if (spec.tone) {
      v.toneFreq = spec.tone.freq * tune;
      v.toneEnv = 1;
      v.toneCoef = decayCoef(spec.tone.decay, sr);
      v.pitchEnv = 1;
      v.pitchCoef = decayCoef(spec.tone.pitchDecay, sr);
    } else {
      v.toneEnv = 0;
    }
    if (spec.noise) {
      const n = spec.noise;
      v.seed = (Math.imul(pitch + 1, 0x9e3779b1) ^ 0x2545f491) >>> 0 || 1;
      v.noiseEnv = 1;
      v.noiseCoef = decayCoef(n.decay, sr);
      v.burstInterval = Math.round(0.011 * sr);
      const fc = Math.min(sr * 0.45, n.freq * tune);
      const g = Math.tan((Math.PI * fc) / sr);
      v.k = 1 / n.q;
      v.a1 = 1 / (1 + g * (g + v.k));
      v.a2 = g * v.a1;
      v.a3 = g * v.a2;
      v.ic1 = 0;
      v.ic2 = 0;
      for (let i = 0; i < METAL_FREQS.length; i++) {
        v.metalPhases[i] = 0;
        v.metalInc[i] = Math.min(0.5, (METAL_FREQS[i]! * tune) / sr);
      }
    } else {
      v.noiseEnv = 0;
    }
    // Constant-power pan.
    const angle = ((Math.min(1, Math.max(-1, spec.pan)) + 1) * Math.PI) / 4;
    v.panL = Math.cos(angle) * Math.SQRT2;
    v.panR = Math.sin(angle) * Math.SQRT2;
  }

  /** Drums are one-shots: note-offs are ignored. */
  noteOff(_pitch: number): void {}

  allNotesOff(hard = false): void {
    if (!hard) return;
    for (const v of this.voices) if (v.active) v.fadeStep = 1 / (0.005 * this.sampleRate);
  }

  pitchBend(_semitones: number): void {}

  controlChange(_controller: number, _value: number): void {}

  render(outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const twoPi = 2 * Math.PI;
    const invSr = 1 / this.sampleRate;
    for (const v of this.voices) {
      if (!v.active) continue;
      const spec = v.spec;
      const gain = 0.5 * v.velocity * (this.params[levelParam(spec.group)] ?? 0.8);
      const tone = spec.tone;
      const noise = spec.noise;
      const bursts = spec.bursts ?? 0;
      for (let i = from; i < to; i++) {
        let s = 0;
        if (tone) {
          s += Math.sin(twoPi * v.phase) * v.toneEnv * tone.level;
          v.phase += v.toneFreq * (1 + tone.pitchDepth * v.pitchEnv) * invSr;
          v.phase -= Math.floor(v.phase);
          v.toneEnv *= v.toneCoef;
          v.pitchEnv *= v.pitchCoef;
        }
        if (noise) {
          if (bursts > 0 && v.t > 0 && v.t <= bursts * v.burstInterval && v.t % v.burstInterval === 0) v.noiseEnv = 1;
          // xorshift32 white noise in [-1, 1).
          let x = v.seed;
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          v.seed = x >>> 0;
          let src = (v.seed / 0x80000000 - 1) * (1 - noise.metal);
          if (noise.metal > 0) {
            let m = 0;
            for (let j = 0; j < METAL_FREQS.length; j++) {
              m += v.metalPhases[j]! < 0.5 ? 1 : -1;
              const ph = v.metalPhases[j]! + v.metalInc[j]!;
              v.metalPhases[j] = ph >= 1 ? ph - 1 : ph;
            }
            src += (m / METAL_FREQS.length) * noise.metal;
          }
          // TPT state-variable filter.
          const v3 = src - v.ic2;
          const v1 = v.a1 * v.ic1 + v.a2 * v3;
          const v2 = v.ic2 + v.a2 * v.ic1 + v.a3 * v3;
          v.ic1 = 2 * v1 - v.ic1;
          v.ic2 = 2 * v2 - v.ic2;
          const f = noise.mode === 'lp' ? v2 : noise.mode === 'bp' ? v1 : src - v.k * v1 - v2;
          s += f * v.noiseEnv * noise.level;
          v.noiseEnv *= v.noiseCoef;
        }
        v.t++;
        if (v.fadeStep > 0) {
          v.fade -= v.fadeStep;
          if (v.fade < 0) v.fade = 0;
          s *= v.fade;
        }
        const out = s * gain;
        outL[i] = (outL[i] ?? 0) + out * v.panL;
        outR[i] = (outR[i] ?? 0) + out * v.panR;
        const burstsPending = bursts > 0 && v.t <= bursts * v.burstInterval;
        if (v.fade <= 0 || (!burstsPending && v.toneEnv < SILENT && v.noiseEnv < SILENT)) {
          v.active = false;
          break;
        }
      }
    }
  }
}
