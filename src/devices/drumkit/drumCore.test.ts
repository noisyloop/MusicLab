import { describe, expect, it } from 'vitest';
import { applyEvent } from '../processorHost';
import { defaultParams, type NoteEvent } from '../types';
import { drumkitDefinition, DRUM_GROUPS } from './definition';
import { DrumCore, drumSpecForNote, MAX_DRUM_VOICES } from './drumCore';

const SR = 48000;
const params = () => defaultParams(drumkitDefinition);
const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
/** Count of samples that differ (bitwise, via Object.is); much faster than deep-equal on big arrays. */
const diffs = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) n++;
  return n;
};

function render(core: DrumCore, frames: number, block = 128): [Float32Array, Float32Array] {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i += block) core.render(l, r, i, Math.min(frames, i + block));
  return [l, r];
}

/** Render events (time in seconds) the way the worklet host does: split at each event's frame. */
function renderEvents(events: NoteEvent[], frames: number, quantum: number, p = params()): Float32Array {
  const core = new DrumCore(SR, p);
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
  const out = new Float32Array(frames * 2);
  out.set(l);
  out.set(r, frames);
  return out;
}

describe('DrumKit', () => {
  it('has a level and tune parameter per voice group', () => {
    for (const g of DRUM_GROUPS) {
      const ids = drumkitDefinition.params.filter((p) => p.group === g.name).map((p) => p.name);
      expect(ids).toEqual(['Level', 'Tune']);
    }
  });

  it('maps General MIDI drum notes to voice groups', () => {
    const group = (n: number) => drumSpecForNote(n)?.group;
    expect([35, 36].map(group)).toEqual(['kick', 'kick']);
    expect([38, 40].map(group)).toEqual(['snare', 'snare']);
    expect([42, 44, 46, 49, 51].map(group)).toEqual(['hats', 'hats', 'hats', 'hats', 'hats']);
    expect([41, 43, 45, 47, 48, 50].map(group)).toEqual(Array(6).fill('toms'));
    expect(group(37)).toBe('rim');
    expect(group(39)).toBe('clap');
    expect([56, 60, 76].map(group)).toEqual(['blips', 'blips', 'blips']);
    expect(group(10)).toBeUndefined();
    expect(group(100)).toBeUndefined();
  });

  it('is silent until hit, every mapped sound makes a bounded noise and then ends', () => {
    const core = new DrumCore(SR, params());
    expect(peak(render(core, 512)[0])).toBe(0);
    for (const n of [35, 36, 37, 38, 39, 40, 41, 42, 44, 46, 49, 51, 56, 75]) {
      const c = new DrumCore(SR, params());
      c.noteOn(n, 1);
      const [l, r] = render(c, 2400);
      expect(Math.max(peak(l), peak(r)), `note ${n}`).toBeGreaterThan(0.01);
      expect(Math.max(peak(l), peak(r)), `note ${n}`).toBeLessThan(1);
      render(c, 3 * SR);
      expect(c.activeVoices, `note ${n}`).toBe(0);
    }
    core.noteOn(100, 1); // unmapped
    expect(core.activeVoices).toBe(0);
  });

  it('ignores note-off (one-shots) and pitch bend; velocity and level scale the output', () => {
    const hit = (vel: number, level = 0.8, off = false) => {
      const c = new DrumCore(SR, { ...params(), snareLevel: level });
      c.noteOn(38, vel);
      if (off) c.noteOff(38);
      c.pitchBend(12);
      return render(c, 4800)[0];
    };
    expect(hit(1, 0.8, true)).toEqual(hit(1, 0.8, false));
    expect(peak(hit(0.3))).toBeLessThan(peak(hit(1)) * 0.5);
    expect(peak(hit(1, 0))).toBe(0);
  });

  it('tune raises the pitch of a voice group', () => {
    const crossings = (tune: number) => {
      const c = new DrumCore(SR, { ...params(), tomsTune: tune });
      c.noteOn(47, 1);
      const x = render(c, 4800)[0];
      let n = 0;
      for (let i = 1200; i < x.length; i++) if (x[i - 1]! <= 0 && x[i]! > 0) n++;
      return n;
    };
    expect(crossings(12) / crossings(0)).toBeGreaterThan(1.8);
    expect(crossings(-12) / crossings(0)).toBeLessThan(0.6);
  });

  it('closed hi-hat chokes the open hi-hat', () => {
    const open = (choke: boolean) => {
      const c = new DrumCore(SR, params());
      c.noteOn(46, 1);
      render(c, 2400);
      if (choke) c.noteOn(42, 0.01);
      render(c, 4800);
      return c.activeVoices;
    };
    expect(open(false)).toBe(1);
    expect(open(true)).toBe(0);
  });

  it('hard all-notes-off silences within a few ms; voices are limited', () => {
    const c = new DrumCore(SR, params());
    c.noteOn(49, 1);
    render(c, 1000);
    c.allNotesOff(true);
    render(c, Math.ceil(0.006 * SR));
    expect(c.activeVoices).toBe(0);
    for (let i = 0; i < MAX_DRUM_VOICES + 8; i++) c.noteOn(49, 1);
    expect(c.activeVoices).toBe(MAX_DRUM_VOICES);
  });

  it('renders bit-identically regardless of render-quantum splits and history', () => {
    const groove: NoteEvent[] = [];
    for (let i = 0; i < 8; i++) {
      const t = i * 0.125 + 0.0001 * i;
      groove.push({ type: 'noteOn', time: t, pitch: i % 4 === 0 ? 36 : i % 4 === 2 ? 38 : 42, velocity: 0.5 + i / 16 });
      if (i % 3 === 0) groove.push({ type: 'noteOn', time: t + 0.03, pitch: 39, velocity: 0.7 });
    }
    groove.sort((a, b) => a.time - b.time);
    const frames = SR * 2;
    const live = renderEvents(groove, frames, 128);
    expect(peak(live)).toBeGreaterThan(0.05);
    expect(diffs(renderEvents(groove, frames, 1000), live)).toBe(0);
    expect(diffs(renderEvents(groove, frames, 37), live)).toBe(0);
    expect(diffs(renderEvents(groove, frames, frames), live)).toBe(0); // one block, like an offline render

    // Each hit seeds its own noise, so the same note sounds the same every time.
    const c = new DrumCore(SR, params());
    c.noteOn(38, 1);
    const first = render(c, SR)[0];
    c.noteOn(42, 1);
    render(c, 777);
    render(c, SR);
    c.noteOn(38, 1);
    expect(diffs(render(c, SR)[0], first)).toBe(0);
  });
});
