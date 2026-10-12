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
});
