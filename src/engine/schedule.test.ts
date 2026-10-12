import { describe, expect, it } from 'vitest';
import { fixture, midiClip, note } from '../model/testUtil';
import type { MidiTrack, Project } from '../model/types';
import { beatAtTime, planWindows, scheduleWindow, type ScheduleWindow } from './schedule';

// fixture @120bpm (0.5 s/beat): audio c1 [0,4), c2 [8,12) offset 1s; midi m1 [4,8) notes n1@0 len1, n2@2 len1. asset 10s.
const win = (fromBeat: number, toBeat: number, extra: Partial<ScheduleWindow> = {}): ScheduleWindow => ({
  fromBeat, toBeat, timeAtFrom: 100, segmentStart: false, cutBeat: Infinity, ...extra,
});

describe('scheduleWindow: audio clips', () => {
  it('starts clips whose start falls inside the window', () => {
    const ev = scheduleWindow(fixture(), win(0, 1));
    expect(ev.audio).toHaveLength(1);
    expect(ev.audio[0]).toMatchObject({ when: 100, offset: 0, duration: 2 });
    expect(ev.audio[0]!.clip.id).toBe('c1');
  });

  it('maps beats to context time and source offset', () => {
    const ev = scheduleWindow(fixture(), win(7, 9));
    expect(ev.audio).toHaveLength(1);
    expect(ev.audio[0]).toMatchObject({ when: 100.5, offset: 1, duration: 2 });
  });

  it('window end is exclusive, start inclusive', () => {
    expect(scheduleWindow(fixture(), win(6, 8)).audio).toHaveLength(0);
    expect(scheduleWindow(fixture(), win(8, 8.001)).audio).toHaveLength(1);
  });

  it('does not restart clips already playing unless the window is a segment start', () => {
    expect(scheduleWindow(fixture(), win(2, 3)).audio).toHaveLength(0);
    const ev = scheduleWindow(fixture(), win(2, 3, { segmentStart: true }));
    expect(ev.audio).toHaveLength(1);
    expect(ev.audio[0]).toMatchObject({ when: 100, offset: 1, duration: 1 });
  });

  it('chases with the clip source offset', () => {
    const ev = scheduleWindow(fixture(), win(10, 11, { segmentStart: true }));
    expect(ev.audio[0]).toMatchObject({ offset: 2, duration: 1 });
  });

  it('cuts clips at the loop end', () => {
    const ev = scheduleWindow(fixture(), win(0, 1, { cutBeat: 2 }));
    expect(ev.audio[0]!.duration).toBe(1);
    expect(scheduleWindow(fixture(), win(8, 9, { cutBeat: 8 })).audio).toHaveLength(0);
  });

  it('never plays past the end of the source file', () => {
    const p = fixture();
    const short: Project = { ...p, assets: { a1: { ...p.assets.a1!, duration: 1.5 } } };
    const ev = scheduleWindow(short, win(8, 9));
    expect(ev.audio[0]!.duration).toBeCloseTo(0.5);
  });

  it('respects tempo', () => {
    const p = { ...fixture(), tempo: 60 };
    const ev = scheduleWindow(p, win(7, 9));
    expect(ev.audio[0]).toMatchObject({ when: 101, duration: 4 });
  });

  it('filters by clip id', () => {
    expect(scheduleWindow(fixture(), win(0, 100), { clipIds: new Set(['c2']) }).audio.map((a) => a.clip.id)).toEqual(['c2']);
  });
});

describe('scheduleWindow: notes', () => {
  it('schedules note on/off in context time', () => {
    const ev = scheduleWindow(fixture(), win(4, 8));
    expect(ev.notes).toEqual([
      { trackId: 'tm', clipId: 'm1', pitch: 60, velocity: 0.8, on: 100, off: 100.5 },
      { trackId: 'tm', clipId: 'm1', pitch: 64, velocity: 0.8, on: 101, off: 101.5 },
    ]);
  });

  it('chases notes on segment start, ends notes at clip end and loop end', () => {
    const p = fixture();
    const m = p.tracks[1] as MidiTrack;
    const long = { ...p, tracks: [p.tracks[0]!, { ...m, clips: [midiClip('m1', 4, 2, [note('n', 50, 0, 8)])] }] };
    const ev = scheduleWindow(long, win(5, 6, { segmentStart: true }));
    expect(ev.notes).toHaveLength(1);
    expect(ev.notes[0]).toMatchObject({ on: 100, off: 100.5 }); // clip ends at beat 6
    const cut = scheduleWindow(long, win(4, 5, { cutBeat: 4.5 }));
    expect(cut.notes[0]).toMatchObject({ on: 100, off: 100.25 });
  });

  it('honours content offset (left-trimmed clip hides earlier notes)', () => {
    const p = fixture();
    const m = p.tracks[1] as MidiTrack;
    const trimmed = { ...p, tracks: [p.tracks[0]!, { ...m, clips: [{ ...m.clips[0]!, start: 5, length: 3, contentOffset: 1 }] }] };
    const ev = scheduleWindow(trimmed, win(0, 16));
    expect(ev.notes.map((n) => n.pitch)).toEqual([64]);
    expect(ev.notes[0]!.on).toBe(100 + 6 * 0.5); // n2 at content beat 2 -> song beat 5 + 1 = 6
  });
});

describe('planWindows', () => {
  it('produces one window without loop', () => {
    const plan = planWindows({ beat: 0, time: 10, segmentStart: true }, 10.25, 120, null);
    expect(plan.windows).toEqual([{ fromBeat: 0, toBeat: 0.5, timeAtFrom: 10, segmentStart: true, cutBeat: Infinity }]);
    expect(plan.cursor).toEqual({ beat: 0.5, time: 10.25, segmentStart: false });
  });

  it('wraps at loop end and marks the new segment', () => {
    const loop = { enabled: true, start: 0, end: 1 };
    const plan = planWindows({ beat: 0.75, time: 0, segmentStart: false }, 0.5, 120, loop);
    expect(plan.windows.map((w) => [w.fromBeat, w.toBeat, w.timeAtFrom, w.segmentStart])).toEqual([
      [0.75, 1, 0, false],
      [0, 0.75, 0.125, true],
    ]);
    expect(plan.jumps).toEqual([{ time: 0.125, beat: 0 }]);
    expect(plan.cursor).toEqual({ beat: 0.75, time: 0.5, segmentStart: false });
  });

  it('ignores the loop once past its end, and when disabled', () => {
    const loop = { enabled: true, start: 0, end: 1 };
    expect(planWindows({ beat: 2, time: 0, segmentStart: false }, 0.5, 120, loop).jumps).toHaveLength(0);
    expect(planWindows({ beat: 0.9, time: 0, segmentStart: false }, 0.5, 120, { ...loop, enabled: false }).jumps).toHaveLength(0);
  });

  it('plays from before the loop into it and wraps', () => {
    const loop = { enabled: true, start: 2, end: 4 };
    const plan = planWindows({ beat: 0, time: 0, segmentStart: true }, 2.5, 120, loop);
    expect(plan.jumps).toEqual([{ time: 2, beat: 2 }]);
    expect(plan.cursor.beat).toBeCloseTo(3);
  });
});

describe('beatAtTime', () => {
  it('follows anchors', () => {
    const anchors = [{ time: 10, beat: 4 }, { time: 12, beat: 0 }];
    expect(beatAtTime(anchors, 11, 120)).toBe(6);
    expect(beatAtTime(anchors, 12.5, 120)).toBe(1);
    expect(beatAtTime(anchors, 9, 120)).toBe(4);
    expect(beatAtTime([], 9, 120)).toBe(0);
  });
});
