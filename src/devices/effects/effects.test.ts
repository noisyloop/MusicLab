import { describe, expect, it } from 'vitest';
import { compressorCurve, CompressorCore } from './compressor/core';
import { DelayCore } from './delay/core';
import { delayDefinition, delayTimeSeconds, DELAY_SYNC_OPTIONS } from './delay/definition';
import { gainToDb } from './dsp';
import { Eq3Core } from './eq3/core';
import { FilterCore } from './filter/core';
import { FILTER_LFO_RATES } from './filter/definition';
import { ReverbCore } from './reverb/core';
import { reverbDefinition } from './reverb/definition';
import { EffectRunner, type EffectCore } from './runner';
import { SaturatorCore, SATURATOR_LATENCY, shape } from './saturator/core';

const SR = 48000;

function sine(freq: number, frames: number, amp = 0.5): Float32Array {
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

function impulse(frames: number): Float32Array {
  const x = new Float32Array(frames);
  x[0] = 1;
  return x;
}

/** Run a core over stereo input in 128-frame blocks (or `block`). */
function run(core: EffectCore, inL: Float32Array, inR: Float32Array = inL, block = 128): [Float32Array, Float32Array] {
  const outL = new Float32Array(inL.length);
  const outR = new Float32Array(inL.length);
  for (let i = 0; i < inL.length; i += block) core.process(inL, inR, outL, outR, i, Math.min(inL.length, i + block));
  return [outL, outR];
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
};
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const diffs = (a: Float32Array, b: Float32Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) n++;
  return n;
};

/** Steady-state gain (dB) of a core for a sine at `freq`. */
function gainAt(core: EffectCore, freq: number): number {
  const n = SR / 2;
  const x = sine(freq, n);
  const [y] = run(core, x);
  return gainToDb(rms(y, n / 2) / rms(x, n / 2));
}

describe('EQ3', () => {
  it('is flat at default settings', () => {
    for (const f of [100, 1000, 8000]) expect(Math.abs(gainAt(new Eq3Core(SR), f))).toBeLessThan(0.1);
  });

  it('hits the set gain at each band’s target frequency within 0.5 dB', () => {
    expect(Math.abs(gainAt(new Eq3Core(SR, { lowFreq: 600, lowGain: 6 }), 60) - 6)).toBeLessThan(0.5);
    expect(Math.abs(gainAt(new Eq3Core(SR, { midFreq: 1000, midGain: 9, midQ: 1 }), 1000) - 9)).toBeLessThan(0.5);
    expect(Math.abs(gainAt(new Eq3Core(SR, { midFreq: 2500, midGain: -12, midQ: 4 }), 2500) + 12)).toBeLessThan(0.5);
    expect(Math.abs(gainAt(new Eq3Core(SR, { highFreq: 3000, highGain: -12 }), 16000) + 12)).toBeLessThan(0.5);
  });

  it('low-cut removes lows', () => {
    expect(gainAt(new Eq3Core(SR, { lowCut: 500 }), 50)).toBeLessThan(-30);
    expect(Math.abs(gainAt(new Eq3Core(SR, { lowCut: 500 }), 5000))).toBeLessThan(0.2);
  });
});

describe('Compressor', () => {
  it('static curve: unity below threshold, 1/ratio above, smooth knee', () => {
    expect(compressorCurve(-30, -18, 4, 0)).toBe(-30);
    expect(compressorCurve(-6, -18, 4, 0)).toBeCloseTo(-15);
    expect(compressorCurve(0, -20, 10, 0)).toBeCloseTo(-18);
    // Knee: continuous at both edges, between the two lines in the middle.
    expect(compressorCurve(-21, -18, 4, 6)).toBeCloseTo(-21);
    expect(compressorCurve(-15, -18, 4, 6)).toBeCloseTo(-18 + 3 / 4);
    expect(compressorCurve(-18, -18, 4, 6)).toBeLessThan(-18);
    expect(compressorCurve(-18, -18, 4, 6)).toBeGreaterThan(-18 - 1.5);
  });

  it('settles on the static curve for a steady signal', () => {
    const core = new CompressorCore(SR, { threshold: -18, ratio: 4, knee: 0, attack: 1, release: 50, makeup: 0 });
    const dc = new Float32Array(SR).fill(0.5); // -6.02 dBFS
    const [y] = run(core, dc);
    expect(gainToDb(y[SR - 1]!)).toBeCloseTo(-18 + (gainToDb(0.5) + 18) / 4, 2);
    expect(core.meter()).toBeCloseTo(gainToDb(0.5) - (-18 + (gainToDb(0.5) + 18) / 4), 2);
  });

  it('attack and release follow their time constants', () => {
    const core = new CompressorCore(SR, { threshold: -18, ratio: 4, knee: 0, attack: 10, release: 120, makeup: 0 });
    const target = -18 + 18 / 4; // 0 dBFS in
    const attackFrames = Math.round(0.01 * SR);
    const [y] = run(core, new Float32Array(attackFrames).fill(1));
    // After one attack time constant: 1 - 1/e of the way.
    expect(gainToDb(y[attackFrames - 1]!) / target).toBeCloseTo(1 - Math.exp(-1), 1);
    run(core, new Float32Array(SR).fill(1)); // fully compressed
    expect(core.meter()).toBeCloseTo(-target, 2);
    run(core, new Float32Array(Math.round(0.12 * SR))); // silence for one release time constant
    expect(core.meter() / -target).toBeCloseTo(Math.exp(-1), 1);
  });

  it('makeup gain adds after compression', () => {
    const quiet = new Float32Array(1000).fill(0.01); // far below threshold
    const [y] = run(new CompressorCore(SR, { makeup: 6 }), quiet);
    expect(gainToDb(y[999]! / 0.01)).toBeCloseTo(6, 3);
  });
});

describe('Delay', () => {
  const sync = (label: string) => DELAY_SYNC_OPTIONS.indexOf(label);
  const firstEcho = (core: DelayCore) => {
    const [y] = run(core, impulse(SR * 2));
    let at = 0;
    for (let i = 1; i < y.length; i++) if (Math.abs(y[i]!) > Math.abs(y[at]!)) at = i;
    return at;
  };
  const clean = { mix: 1, feedback: 0, lowpass: 20000, highpass: 20 };

  it('a synced delay lands on the note value at the tempo', () => {
    const core = new DelayCore(SR, { ...clean, sync: sync('1/4') });
    core.setTransport(0, 120, 4);
    core.reset();
    expect(Math.abs(firstEcho(core) - SR * 0.5)).toBeLessThanOrEqual(2);
    const dotted = new DelayCore(SR, { ...clean, sync: sync('1/8.') });
    dotted.setTransport(0, 100, 4);
    dotted.reset();
    expect(Math.abs(firstEcho(dotted) - SR * 0.45)).toBeLessThanOrEqual(2);
    expect(delayTimeSeconds({ sync: sync('1/8T') }, 120, 4)).toBeCloseTo(1 / 6);
    expect(delayTimeSeconds({ sync: sync('1 bar') }, 120, 3)).toBeCloseTo(1.5);
    expect(delayTimeSeconds({ sync: 0, time: 250 }, 120, 4)).toBeCloseTo(0.25);
  });

  it('follows tempo changes', () => {
    const core = new DelayCore(SR, { ...clean, sync: sync('1/4') });
    core.setTransport(0, 120, 4);
    expect(core.delaySamples).toBeCloseTo(SR * 0.5);
    core.setTransport(0, 60, 4);
    expect(core.delaySamples).toBeCloseTo(SR);
  });

  it('feeds back, and ping-pong alternates sides', () => {
    const core = new DelayCore(SR, { ...clean, sync: 0, time: 100, feedback: 0.5, pingPong: 1 });
    const [l, r] = run(core, impulse(SR), new Float32Array(SR));
    const at = (x: Float32Array, n: number) => Math.max(...Array.from(x.subarray(n * 4800 - 3, n * 4800 + 3), Math.abs));
    expect(at(l, 1)).toBeGreaterThan(0.2);
    expect(at(r, 1)).toBeLessThan(1e-6);
    expect(at(r, 2)).toBeGreaterThan(0.1);
    expect(at(l, 2)).toBeLessThan(1e-6);
  });

  it('reports a tail long enough for the feedback to die away', () => {
    const tail = delayDefinition.tailSeconds!({ sync: sync('1/4'), feedback: 0.5, mix: 0.3 }, { tempo: 120, beatsPerBar: 4 });
    expect(tail).toBeCloseTo(0.5 * (1 + Math.log(0.001) / Math.log(0.5)), 5);
    expect(delayDefinition.tailSeconds!({ sync: sync('1/4'), feedback: 0.5, mix: 0 }, { tempo: 120, beatsPerBar: 4 })).toBe(0);
  });
});

describe('Reverb', () => {
  /** RT60 from the Schroeder energy-decay curve (T20 extrapolated). */
  function rt60(y: Float32Array): number {
    const edc = new Float64Array(y.length);
    let acc = 0;
    for (let i = y.length - 1; i >= 0; i--) edc[i] = acc += y[i]! * y[i]!;
    const db = (i: number) => 10 * Math.log10(edc[i]! / edc[0]!);
    let t5 = -1;
    let t25 = -1;
    for (let i = 0; i < y.length; i++) {
      if (t5 < 0 && db(i) <= -5) t5 = i;
      if (db(i) <= -25) {
        t25 = i;
        break;
      }
    }
    return ((t25 - t5) / SR) * 3;
  }

  it('decays in roughly the set time', () => {
    for (const decay of [1, 2.5]) {
      const core = new ReverbCore(SR, { decay, damping: 0, mix: 1, preDelay: 0, size: 0.5 });
      const [y] = run(core, impulse(SR * decay * 2));
      expect(rt60(y) / decay).toBeGreaterThan(0.75);
      expect(rt60(y) / decay).toBeLessThan(1.25);
    }
  });

  it('pre-delay holds the onset back', () => {
    const core = new ReverbCore(SR, { mix: 1, preDelay: 50, size: 0 });
    const [y] = run(core, impulse(SR / 4));
    const first = y.findIndex((v) => Math.abs(v) > 1e-9);
    expect(first).toBeGreaterThanOrEqual(0.05 * SR);
  });

  it('is deterministic and independent of block size', () => {
    const x = sine(220, SR / 2);
    const a = run(new ReverbCore(SR), x, x, 128)[0];
    const b = run(new ReverbCore(SR), x, x, 37)[0];
    expect(diffs(a, b)).toBe(0);
    expect(reverbDefinition.tailSeconds!({ mix: 0.3, preDelay: 20, decay: 3 }, { tempo: 120, beatsPerBar: 4 })).toBeCloseTo(3.02);
  });
});

describe('Saturator', () => {
  it('keeps the output bounded for any input, with every curve', () => {
    for (let curve = 0; curve < 3; curve++) {
      for (const amp of [0.5, 5, 50]) {
        const core = new SaturatorCore(SR, { drive: 36, curve, mix: 1, output: 0, tone: 20000 });
        const [y] = run(core, sine(1000, SR / 4, amp));
        expect(peak(y), `curve ${curve} amp ${amp}`).toBeLessThan(1.2);
        expect(peak(y)).toBeGreaterThan(0.3);
      }
    }
    for (const x of [-100, -1.5, -1, 0, 0.3, 1, 3.7, 1e6]) for (let c = 0; c < 3; c++) expect(Math.abs(shape(c, x))).toBeLessThanOrEqual(1);
  });

  it('dry path is the input delayed by the oversampling latency', () => {
    const x = sine(440, 4096);
    const [y] = run(new SaturatorCore(SR, { mix: 0 }), x);
    for (let i = SATURATOR_LATENCY; i < x.length; i++) expect(y[i]).toBe(x[i - SATURATOR_LATENCY]);
  });

  it('output gain scales the result', () => {
    const loud = peak(run(new SaturatorCore(SR, { output: 0 }), sine(200, 8192))[0]);
    const quiet = peak(run(new SaturatorCore(SR, { output: -12 }), sine(200, 8192))[0]);
    expect(gainToDb(quiet / loud)).toBeCloseTo(-12, 1);
  });
});

describe('Filter', () => {
  it('low-pass, high-pass and band-pass respond around the cutoff', () => {
    const lp = (f: number) => gainAt(new FilterCore(SR, { mode: 0, cutoff: 1000, resonance: 0 }), f);
    expect(Math.abs(lp(100))).toBeLessThan(0.5);
    expect(lp(1000)).toBeCloseTo(-6, 0); // Q 0.5: -6 dB at the cutoff
    expect(lp(10000)).toBeLessThan(-35);
    const hp = (f: number) => gainAt(new FilterCore(SR, { mode: 1, cutoff: 1000, resonance: 0 }), f);
    expect(Math.abs(hp(10000))).toBeLessThan(0.5);
    expect(hp(100)).toBeLessThan(-35);
    const bp = (f: number) => gainAt(new FilterCore(SR, { mode: 2, cutoff: 1000, resonance: 0.8 }), f);
    expect(bp(1000)).toBeGreaterThan(bp(100) + 15);
    expect(bp(1000)).toBeGreaterThan(bp(10000) + 15);
  });

  it('resonance boosts at the cutoff', () => {
    const at = (resonance: number) => gainAt(new FilterCore(SR, { cutoff: 1000, resonance }), 1000);
    expect(at(0.9)).toBeGreaterThan(at(0) + 15);
  });

  it('the LFO follows the song position', () => {
    const rate = FILTER_LFO_RATES.findIndex((r) => r.label === '1/4');
    const core = new FilterCore(SR, { cutoff: 1000, lfoRate: rate, lfoDepth: 1 });
    expect(core.cutoffAt(0)).toBeCloseTo(1000);
    expect(core.cutoffAt(0.25)).toBeCloseTo(2000); // a quarter of the 1-beat cycle: +1 octave
    expect(core.cutoffAt(0.75)).toBeCloseTo(500);
    const bar = new FilterCore(SR, { cutoff: 1000, lfoRate: FILTER_LFO_RATES.findIndex((r) => r.label === '1 bar'), lfoDepth: 2 });
    bar.setTransport(0, 120, 3);
    expect(bar.cutoffAt(0.75)).toBeCloseTo(4000);
    // Same transport, same output, whatever the block size.
    const x = sine(300, SR / 2);
    const a = new FilterCore(SR, { lfoRate: rate });
    const b = new FilterCore(SR, { lfoRate: rate });
    a.setTransport(3.5, 97, 4);
    b.setTransport(3.5, 97, 4);
    expect(diffs(run(a, x, x, 128)[0], run(b, x, x, 41)[0])).toBe(0);
  });
});

describe('bypass', () => {
  const makers: [string, () => EffectCore][] = [
    ['eq3', () => new Eq3Core(SR, { lowGain: 12, midGain: -9 })],
    ['compressor', () => new CompressorCore(SR, { threshold: -40, makeup: 12 })],
    ['saturator', () => new SaturatorCore(SR, { drive: 30 })],
    ['filter', () => new FilterCore(SR, { cutoff: 300 })],
    ['delay', () => new DelayCore(SR, { mix: 1 })],
    ['reverb', () => new ReverbCore(SR, { mix: 1 })],
  ];

  function runner(r: EffectRunner, inL: Float32Array, inR: Float32Array): [Float32Array, Float32Array] {
    const outL = new Float32Array(inL.length);
    const outR = new Float32Array(inL.length);
    for (let i = 0; i < inL.length; i += 128) r.process(inL, inR, outL, outR, i, Math.min(inL.length, i + 128));
    return [outL, outR];
  }

  it.each(makers)('%s: bypassed output is bit-identical to the input', (_name, make) => {
    const inL = sine(330, SR / 4, 0.7);
    const inR = sine(550, SR / 4, 0.3);
    const r = new EffectRunner(make(), SR, true);
    const [l, rr] = runner(r, inL, inR);
    expect(diffs(l, inL)).toBe(0);
    expect(diffs(rr, inR)).toBe(0);
    // Enable, then bypass again: once the 10 ms crossfade is over, untouched again.
    r.setBypass(false);
    runner(r, inL, inR);
    r.setBypass(true);
    runner(r, inL.subarray(0, 1024), inR.subarray(0, 1024)); // fade out
    const [l2] = runner(r, inL, inR);
    expect(diffs(l2, inL)).toBe(0);
  });

  it('crossfades over 10 ms instead of switching', () => {
    const x = new Float32Array(SR / 10).fill(0.5);
    const r = new EffectRunner(new CompressorCore(SR, { threshold: -40, ratio: 20, attack: 0.1, knee: 0 }), SR, false);
    runner(r, x, x); // compressing hard
    r.setBypass(true);
    const [y] = runner(r, x, x);
    const fade = Math.round(0.01 * SR);
    expect(y[0]!).toBeLessThan(0.1); // still the compressed level
    expect(y[Math.round(fade / 2)]!).toBeGreaterThan(y[0]! + 0.1); // halfway there
    expect(y[fade + 1]).toBe(0.5); // dry after the fade
    let maxStep = 0;
    for (let i = 1; i < y.length; i++) maxStep = Math.max(maxStep, Math.abs(y[i]! - y[i - 1]!));
    expect(maxStep).toBeLessThan(0.002); // ~0.49 spread over 480 samples; a hard switch would jump 0.49
  });
});
