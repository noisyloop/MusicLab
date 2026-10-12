import { describe, expect, it } from 'vitest';
import { computePeaks, peakRange } from './peaks';
import { decodeWav, encodeWav } from './wav';

describe('wav', () => {
  it('encodes a valid 16-bit header and round-trips samples', () => {
    const l = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const r = Float32Array.from([0.25, -0.25, 0, 0, 0, -2]);
    const bytes = encodeWav([l, r], 44100);
    expect(bytes.length).toBe(44 + 6 * 2 * 2);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    const d = decodeWav(bytes);
    expect(d.sampleRate).toBe(44100);
    expect(d.channels).toHaveLength(2);
    expect(d.channels[0]![1]).toBeCloseTo(0.5, 3);
    expect(d.channels[0]![5]).toBeCloseTo(1, 3); // clipped
    expect(d.channels[1]![5]).toBeCloseTo(-1, 3);
  });

  it('encodes float32', () => {
    const l = Float32Array.from([0.123, -0.9]);
    const d = decodeWav(encodeWav([l], 48000, 'float32'));
    expect(d.channels[0]![0]).toBeCloseTo(0.123, 6);
  });
});

describe('peaks', () => {
  it('computes min/max per bin across channels', () => {
    const a = new Float32Array(1000);
    const b = new Float32Array(1000);
    a[10] = 0.8;
    b[300] = -0.6;
    const p = computePeaks([a, b], 1000, 256);
    expect(p.min.length).toBe(4);
    expect(p.max[0]).toBeCloseTo(0.8);
    expect(p.min[1]).toBeCloseTo(-0.6);
    expect(peakRange(p, 0, 1)).toEqual([expect.closeTo(-0.6), expect.closeTo(0.8)]);
    expect(peakRange(p, 0.6, 0.7)).toEqual([0, 0]);
  });
});
