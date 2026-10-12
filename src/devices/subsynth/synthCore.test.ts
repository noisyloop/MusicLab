import { describe, expect, it } from 'vitest';
import { defaultParams } from '../types';
import { subsynthDefinition } from './definition';
import { MAX_VOICES, SynthCore } from './synthCore';

const SR = 48000;

function renderFrames(core: SynthCore, frames: number): Float32Array {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) core.render(l, r, i, Math.min(frames, i + 128));
  return l;
}

const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

describe('SynthCore', () => {
  it('is silent with no notes', () => {
    const core = new SynthCore(SR, defaultParams(subsynthDefinition));
    expect(peak(renderFrames(core, 1024))).toBe(0);
  });

  it('produces sound for a note and decays to silence after release', () => {
    for (let wave = 0; wave < 4; wave++) {
      const core = new SynthCore(SR, { ...defaultParams(subsynthDefinition), wave, release: 0.05 });
      core.noteOn(60, 1);
      const on = renderFrames(core, 4800);
      expect(peak(on)).toBeGreaterThan(0.01);
      expect(peak(on)).toBeLessThan(1);
      core.noteOff(60);
      renderFrames(core, SR); // 1s >> 50ms release
      expect(core.activeVoices).toBe(0);
      expect(peak(renderFrames(core, 512))).toBe(0);
    }
  });

  it('louder with higher velocity', () => {
    const a = new SynthCore(SR, defaultParams(subsynthDefinition));
    const b = new SynthCore(SR, defaultParams(subsynthDefinition));
    a.noteOn(60, 0.2);
    b.noteOn(60, 1);
    expect(peak(renderFrames(b, 4800))).toBeGreaterThan(peak(renderFrames(a, 4800)));
  });

  it('is polyphonic and steals voices beyond the limit', () => {
    const core = new SynthCore(SR, defaultParams(subsynthDefinition));
    for (let i = 0; i < MAX_VOICES + 4; i++) core.noteOn(40 + i, 0.8);
    renderFrames(core, 256);
    expect(core.activeVoices).toBe(MAX_VOICES);
  });

  it('hard allNotesOff silences quickly', () => {
    const core = new SynthCore(SR, { ...defaultParams(subsynthDefinition), release: 4 });
    core.noteOn(60, 1);
    core.noteOn(64, 1);
    renderFrames(core, 1000);
    core.allNotesOff(true);
    renderFrames(core, Math.ceil(0.006 * SR));
    expect(core.activeVoices).toBe(0);
  });

  it('lower cutoff reduces high-frequency energy', () => {
    const hf = (cutoff: number) => {
      const core = new SynthCore(SR, { ...defaultParams(subsynthDefinition), cutoff, envAmount: 0 });
      core.noteOn(48, 1);
      const x = renderFrames(core, 9600);
      let e = 0;
      for (let i = 1; i < x.length; i++) e += (x[i]! - x[i - 1]!) ** 2;
      return e;
    };
    expect(hf(200)).toBeLessThan(hf(8000) * 0.5);
  });

  /** Estimated frequency from upward zero crossings of a pure sine voice. */
  const freqOf = (core: SynthCore, frames = SR) => {
    const x = renderFrames(core, frames);
    let crossings = 0;
    for (let i = 2400; i < x.length; i++) if (x[i - 1]! <= 0 && x[i]! > 0) crossings++;
    return crossings / ((x.length - 2400) / SR);
  };
  const sine = (extra: Record<string, number> = {}) =>
    new SynthCore(SR, { ...defaultParams(subsynthDefinition), wave: 3, osc2Mix: 0, detune: 0, cutoff: 18000, envAmount: 0, sustain: 1, ...extra });

  it('applies pitch bend, clamped to the bend range', () => {
    const a = sine();
    a.noteOn(69, 1);
    expect(freqOf(a)).toBeCloseTo(440, -1);
    const b = sine();
    b.pitchBend(12);
    b.noteOn(69, 1);
    expect(freqOf(b)).toBeCloseTo(880, -1);
    const c = sine({ bendRange: 2 });
    c.pitchBend(12); // clamped to +2
    c.noteOn(69, 1);
    expect(freqOf(c)).toBeCloseTo(440 * Math.pow(2, 2 / 12), -1);
    expect(c.bendSemitones).toBe(2);
  });

  it('bends sounding notes immediately (no glide) and hard reset clears the bend', () => {
    const core = sine();
    core.noteOn(69, 1);
    renderFrames(core, 4800);
    core.pitchBend(-12);
    expect(freqOf(core, 9600)).toBeCloseTo(220, -1);
    core.allNotesOff(true);
    expect(core.bendSemitones).toBe(0);
  });

  it('maps CC 1, CC 74 and the Filter CC to cutoff', () => {
    const core = new SynthCore(SR, defaultParams(subsynthDefinition));
    expect(core.controllerCutoffOctaves).toBe(0);
    core.controlChange(1, 127);
    expect(core.controllerCutoffOctaves).toBeCloseTo(4);
    core.controlChange(74, 0);
    expect(core.controllerCutoffOctaves).toBeCloseTo(0);
    core.controlChange(20, 127); // default Filter CC
    expect(core.controllerCutoffOctaves).toBeCloseTo(4);
    core.setParams({ filterCc: 21 });
    expect(core.controllerCutoffOctaves).toBeCloseTo(0);
    core.controlChange(7, 127); // unmapped controller
    expect(core.controllerCutoffOctaves).toBeCloseTo(0);

    const hf = (cc: number) => {
      const s = new SynthCore(SR, { ...defaultParams(subsynthDefinition), cutoff: 300, envAmount: 0 });
      s.controlChange(74, cc);
      s.noteOn(48, 1);
      const x = renderFrames(s, 9600);
      let e = 0;
      for (let i = 1; i < x.length; i++) e += (x[i]! - x[i - 1]!) ** 2;
      return e;
    };
    expect(hf(127)).toBeGreaterThan(hf(64) * 2);
  });
});

