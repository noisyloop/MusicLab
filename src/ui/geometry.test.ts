import { describe, expect, it } from 'vitest';
import { fixture } from '../model/testUtil';
import { beatToX, clipsInRect, faderToGain, formatDb, gainToFader, hitTestClip, trackIndexAtY, xToBeat, zoomAround } from './geometry';

const v = { pxPerBeat: 20, scrollBeat: 2, scrollY: 0 };
const l = { rulerHeight: 30, trackHeight: 60 };

describe('timeline geometry', () => {
  it('maps beats and x', () => {
    expect(beatToX(2, v)).toBe(0);
    expect(beatToX(4, v)).toBe(40);
    expect(xToBeat(40, v)).toBe(4);
  });

  it('finds tracks by y', () => {
    expect(trackIndexAtY(10, 2, v, l)).toBe(-1);
    expect(trackIndexAtY(35, 2, v, l)).toBe(0);
    expect(trackIndexAtY(95, 2, v, l)).toBe(1);
    expect(trackIndexAtY(155, 2, v, l)).toBe(-1);
    expect(trackIndexAtY(35, 2, { ...v, scrollY: 60 }, l)).toBe(1);
  });

  it('hit tests clips and edges', () => {
    const p = fixture(); // c1 [0,4) on track 0 => x -40..40
    expect(hitTestClip(p, 0, 40, v, l)).toMatchObject({ clip: { id: 'c1' }, zone: 'body' });
    expect(hitTestClip(p, 38, 40, v, l)).toMatchObject({ zone: 'end' });
    expect(hitTestClip(p, 100, 40, v, l)).toBeNull();
    // m1 [4,8) on track 1 => x 40..120; left edge
    expect(hitTestClip(p, 42, 100, v, l)).toMatchObject({ clip: { id: 'm1' }, zone: 'start' });
  });

  it('marquee selects intersecting clips', () => {
    const p = fixture();
    expect(clipsInRect(p, 0, 31, 50, 100, v, l).sort()).toEqual(['c1', 'm1']);
    expect(clipsInRect(p, 300, 31, 210, 40, v, l)).toEqual([]);
  });

  it('zooms around an anchor', () => {
    const z = zoomAround(v, 2, 40);
    expect(xToBeat(40, z)).toBeCloseTo(4);
    expect(z.pxPerBeat).toBe(40);
  });

  it('fader mapping round-trips and hits unity', () => {
    expect(faderToGain(0)).toBe(0);
    expect(faderToGain(1)).toBeCloseTo(Math.pow(10, 6 / 20));
    for (const g of [0.01, 0.25, 1, 1.5]) expect(faderToGain(gainToFader(g))).toBeCloseTo(g, 6);
    expect(formatDb(1)).toBe('+0.0');
    expect(formatDb(0)).toBe('-inf');
  });
});
