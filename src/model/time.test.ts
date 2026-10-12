import { describe, expect, it } from 'vitest';
import { beatsToBarBeat, beatsToSeconds, clampTempo, formatBarBeat, formatSeconds, secondsToBeats, snapBeat, snapFloor } from './time';

describe('time conversion', () => {
  it('converts beats to seconds and back', () => {
    expect(beatsToSeconds(4, 120)).toBe(2);
    expect(beatsToSeconds(1, 60)).toBe(1);
    expect(secondsToBeats(2, 120)).toBe(4);
    for (const tempo of [37, 90, 128, 174.5]) {
      expect(secondsToBeats(beatsToSeconds(13.25, tempo), tempo)).toBeCloseTo(13.25, 10);
    }
  });

  it('snaps to grid', () => {
    expect(snapBeat(1.3, 0.25)).toBe(1.25);
    expect(snapBeat(1.38, 0.25)).toBe(1.5);
    expect(snapBeat(1.38, 0)).toBe(1.38);
    expect(snapFloor(1.99, 1)).toBe(1);
    expect(snapFloor(2, 1)).toBe(2);
  });

  it('formats bar.beat.sixteenth (1-based)', () => {
    expect(beatsToBarBeat(0, 4)).toEqual({ bar: 1, beat: 1, sixteenth: 1 });
    expect(formatBarBeat(5.5, 4)).toBe('2.2.3');
    expect(formatBarBeat(3.75, 3)).toBe('2.1.4');
  });

  it('formats seconds', () => {
    expect(formatSeconds(61.5)).toBe('1:01.500');
  });

  it('clamps tempo', () => {
    expect(clampTempo(1000)).toBe(400);
    expect(clampTempo(Number.NaN)).toBe(120);
  });
});
