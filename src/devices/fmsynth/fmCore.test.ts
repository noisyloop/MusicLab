import { describe, expect, it } from 'vitest';
import { applyEvent } from '../processorHost';
import { defaultParams, type NoteEvent } from '../types';
import { FM_ALGORITHMS, fmsynthDefinition } from './definition';
import { ALGORITHMS, FmCore, MAX_VOICES, OPERATORS, sineCycles } from './fmCore';

const SR = 48000;

function renderFrames(core: FmCore, frames: number, block = 128): Float32Array {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i += block) core.render(l, r, i, Math.min(frames, i + block));
  return l;
}

const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/** Magnitude of frequency `f` in `x` (Goertzel), normalized so a unit sine reads ~1. */
function magnitudeAt(x: Float32Array, f: number, from = 0): number {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < x.length; i++) {
    const s = x[i]! + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const n = x.length - from;
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / n;
}

/** High-frequency energy (first difference), a cheap brightness measure. */
function hf(x: Float32Array): number {
  let e = 0;
  for (let i = 1; i < x.length; i++) e += (x[i]! - x[i - 1]!) ** 2;
  return e;
}

const params = (extra: Record<string, number> = {}) => ({ ...defaultParams(fmsynthDefinition), ...extra });

/** Output amplitude of one carrier at Level 1 in algorithm 8 with Gain 1: 0.35 split over its four carriers. */
const SINGLE_AMP = 0.35 / 4;

/** Operator `op` (1-based) alone as a sustained sine at Level 1: algorithm 8, the others silent. */
function single(op: number, extra: Record<string, number> = {}) {
  const p: Record<string, number> = { algorithm: 7, velSens: 0, gain: 1 };
  for (let n = 1; n <= OPERATORS; n++) {
    p[`op${n}Level`] = n === op ? 1 : 0;
    p[`op${n}Ratio`] = 1;
    p[`op${n}Sustain`] = 1;
  }
  return new FmCore(SR, params({ ...p, ...extra }));
}

/** Operator 1 as carrier and operator 2 as its only modulator (algorithm 5, operators 3 and 4 silent). */
function pair(modLevel: number, extra: Record<string, number> = {}) {
  return new FmCore(
    SR,
    params({
      algorithm: 4, velSens: 0, velMod: 0,
      op1Ratio: 1, op1Level: 1, op1Sustain: 1,
      op2Ratio: 1, op2Level: modLevel, op2Sustain: 1,
      op3Level: 0, op4Level: 0,
      ...extra,
    }),
  );
}

describe('FmCore', () => {
  it('has a valid wiring for every algorithm the panel lists', () => {
    expect(ALGORITHMS.length).toBe(FM_ALGORITHMS.length);
    for (const a of ALGORITHMS) {
      expect(a.mods.length).toBe(OPERATORS);
      expect(a.carriers).toContain(0);
      a.mods.forEach((mods, target) => {
        // Rendering runs operators 4 -> 1, so modulators must come later.
        for (const m of mods) expect(m).toBeGreaterThan(target);
      });
    }
  });

  it('interpolates its sine table accurately', () => {
    let err = 0;
    for (let i = 0; i < 10000; i++) {
      const ph = i / 7919 - 0.6;
      err = Math.max(err, Math.abs(sineCycles(ph) - Math.sin(2 * Math.PI * ph)));
    }
    expect(err).toBeLessThan(1e-6);
    // Phases a hair below a whole cycle round up to exactly 1 in floating point.
    for (const ph of [-1e-20, -1e-17, -3 - 1e-17, 1 - 1e-17]) expect(Math.abs(sineCycles(ph))).toBeLessThan(1e-6);
  });

  it('is silent with no notes', () => {
    const core = new FmCore(SR, params());
    expect(peak(renderFrames(core, 1024))).toBe(0);
  });

  it('produces sound for a note in every algorithm and decays to silence after release', () => {
    for (let algorithm = 0; algorithm < ALGORITHMS.length; algorithm++) {
      const core = new FmCore(SR, params({ algorithm, op1Release: 0.05, op2Release: 0.05, op3Release: 0.05, op4Release: 0.05 }));
      core.noteOn(60, 1);
      const on = renderFrames(core, 4800);
      expect(peak(on)).toBeGreaterThan(0.01);
      expect(peak(on)).toBeLessThan(1);
      core.noteOff(60);
      renderFrames(core, SR); // 1 s >> 50 ms release
      expect(core.activeVoices).toBe(0);
      expect(peak(renderFrames(core, 512))).toBe(0);
    }
  });

  it('is louder with higher velocity', () => {
    const a = new FmCore(SR, params());
    const b = new FmCore(SR, params());
    a.noteOn(60, 0.2);
    b.noteOn(60, 1);
    expect(peak(renderFrames(b, 4800))).toBeGreaterThan(peak(renderFrames(a, 4800)));
  });

  it('is brighter with higher velocity through Vel→Mod', () => {
    const at = (velocity: number) => {
      const core = pair(0.5, { velMod: 1 });
      core.noteOn(57, velocity);
      return hf(renderFrames(core, 9600));
    };
    expect(at(1)).toBeGreaterThan(at(0.2) * 2);
  });

  it('is polyphonic and steals voices beyond the limit', () => {
    const core = new FmCore(SR, params());
    for (let i = 0; i < MAX_VOICES + 4; i++) core.noteOn(40 + i, 0.8);
    renderFrames(core, 256);
    expect(core.activeVoices).toBe(MAX_VOICES);
  });

  it('hard allNotesOff silences quickly', () => {
    const core = new FmCore(SR, params({ op1Release: 4, op3Release: 4 }));
    core.noteOn(60, 1);
    core.noteOn(64, 1);
    renderFrames(core, 1000);
    core.allNotesOff(true);
    renderFrames(core, Math.ceil(0.006 * SR));
    expect(core.activeVoices).toBe(0);
  });

  it('plays each operator at its ratio, with octave and pitch bend clamped to the bend range', () => {
    const freq = (core: FmCore, f: number) => {
      core.noteOn(69, 1);
      return magnitudeAt(renderFrames(core, SR), f, 2400);
    };
    for (let op = 1; op <= OPERATORS; op++) expect(freq(single(op), 440)).toBeCloseTo(SINGLE_AMP, 3);
    expect(freq(single(1, { op1Ratio: 2 }), 880)).toBeCloseTo(SINGLE_AMP, 3);
    expect(freq(single(1, { op1Ratio: 2 }), 440)).toBeLessThan(1e-3);
    expect(freq(single(1, { octave: -1 }), 220)).toBeCloseTo(SINGLE_AMP, 3);
    const bent = single(1, { bendRange: 12 });
    bent.pitchBend(12);
    expect(freq(bent, 880)).toBeCloseTo(SINGLE_AMP, 3);
    const clamped = single(1, { bendRange: 2 });
    clamped.pitchBend(12); // clamped to +2
    expect(clamped.bendSemitones).toBe(2);
    expect(freq(clamped, 440 * Math.pow(2, 2 / 12))).toBeCloseTo(SINGLE_AMP, 3);
  });

  it('bends sounding notes immediately and hard reset clears the bend', () => {
    const core = single(1, { bendRange: 12 });
    core.noteOn(69, 1);
    renderFrames(core, 4800);
    core.pitchBend(-12);
    const x = renderFrames(core, 9600);
    expect(magnitudeAt(x, 220)).toBeCloseTo(SINGLE_AMP, 3);
    expect(magnitudeAt(x, 440)).toBeLessThan(1e-3);
    core.allNotesOff(true);
    expect(core.bendSemitones).toBe(0);
  });

  it('modulation adds harmonics that an unmodulated carrier lacks', () => {
    const harmonics = (modLevel: number) => {
      const core = pair(modLevel);
      core.noteOn(57, 1); // 220 Hz
      const x = renderFrames(core, SR);
      return { fundamental: magnitudeAt(x, 220, 2400), second: magnitudeAt(x, 440, 2400), third: magnitudeAt(x, 660, 2400) };
    };
    const pure = harmonics(0);
    expect(pure.fundamental).toBeGreaterThan(0.05);
    expect(pure.second).toBeLessThan(1e-4);
    const modulated = harmonics(0.5);
    expect(modulated.second).toBeGreaterThan(0.01);
    expect(modulated.third).toBeGreaterThan(0.01);
  });

  it('feedback adds harmonics to operator 4', () => {
    const second = (feedback: number) => {
      const core = single(4, { feedback });
      core.noteOn(57, 1);
      return magnitudeAt(renderFrames(core, SR), 440, 2400);
    };
    expect(second(0)).toBeLessThan(1e-4);
    expect(second(1)).toBeGreaterThan(0.01);
  });

  it('mutes operators that would alias', () => {
    const core = single(1, { op1Ratio: 16 });
    core.noteOn(108, 1); // C8 x 16 is far above Nyquist
    expect(peak(renderFrames(core, 4800))).toBe(0);
  });

  it('maps CC 1, CC 74 and the Bright CC to modulator brightness', () => {
    const core = new FmCore(SR, params());
    expect(core.brightness).toBe(1);
    core.controlChange(1, 127);
    expect(core.brightness).toBeCloseTo(2);
    core.controlChange(74, 0);
    expect(core.brightness).toBeCloseTo(1);
    core.controlChange(20, 127); // default Bright CC
    expect(core.brightness).toBeCloseTo(2);
    core.setParams({ brightCc: 21 });
    expect(core.brightness).toBeCloseTo(1);
    core.controlChange(7, 127); // unmapped controller
    expect(core.brightness).toBeCloseTo(1);

    const render = (cc74: number) => {
      const c = pair(0.5);
      c.controlChange(74, cc74);
      c.noteOn(57, 1);
      return renderFrames(c, SR);
    };
    expect(magnitudeAt(render(0), 440, 2400)).toBeLessThan(1e-4); // no modulation at all
    // A higher index spreads energy into higher harmonics (not always the 2nd).
    expect(hf(render(127))).toBeGreaterThan(hf(render(64)) * 2);
  });

  /** Render events (time in seconds) the way the worklet host does: split at each event's frame. */
  function renderEvents(events: NoteEvent[], frames: number, quantum: number): Float32Array {
    const core = new FmCore(SR, params({ feedback: 0.6 }));
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    const queue = [...events];
    for (let q = 0; q < frames; q += quantum) {
      const end = Math.min(frames, q + quantum);
      let pos = q;
      while (queue.length > 0) {
        const frame = Math.round(queue[0]!.time * SR);
        if (frame >= end) break;
        const at = Math.max(pos, frame);
        if (at > pos) core.render(l, r, pos, at);
        pos = at;
        applyEvent(core, queue.shift()!);
      }
      if (pos < end) core.render(l, r, pos, end);
    }
    return l;
  }

  it('renders bit-identically regardless of render-quantum splits', () => {
    const events: NoteEvent[] = [];
    for (let i = 0; i < 8; i++) {
      const t = i * 0.11 + 0.0001 * i;
      events.push({ type: 'noteOn', time: t, pitch: 52 + ((i * 5) % 17), velocity: 0.4 + i / 14 });
      events.push({ type: 'noteOff', time: t + 0.2, pitch: 52 + ((i * 5) % 17) });
    }
    events.push({ type: 'pitchBend', time: 0.3, semitones: 1.5 });
    events.push({ type: 'cc', time: 0.5, controller: 1, value: 90 });
    events.sort((a, b) => a.time - b.time);
    const frames = SR * 2;
    const live = renderEvents(events, frames, 128);
    expect(peak(live)).toBeGreaterThan(0.05);
    const diffs = (a: Float32Array) => a.reduce((n, x, i) => n + (x === live[i] ? 0 : 1), 0);
    expect(diffs(renderEvents(events, frames, 1000))).toBe(0);
    expect(diffs(renderEvents(events, frames, 37))).toBe(0);
    expect(diffs(renderEvents(events, frames, frames))).toBe(0); // one block, like an offline render
  });
});
