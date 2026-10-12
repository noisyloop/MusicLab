import { describe, expect, it } from 'vitest';
import { beatsToTicks, bpmFromMicros, microsFromBpm, parseSmf, SmfError, ticksToBeats, writeSmf, type Smf } from './smf';
import { smfToTracks } from './import';

/** Hand-assembled SMF bytes, so the parser is tested against the spec rather than our writer. */
function smfBytes(format: number, ppq: number, tracks: number[][]): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  out.push(...[...'MThd'].map((c) => c.charCodeAt(0)));
  u32(6);
  out.push(0, format, 0, tracks.length, ppq >> 8, ppq & 255);
  for (const t of tracks) {
    out.push(...[...'MTrk'].map((c) => c.charCodeAt(0)));
    u32(t.length);
    out.push(...t);
  }
  return Uint8Array.from(out);
}

const EOT = [0x00, 0xff, 0x2f, 0x00];
const name = (s: string) => [0x00, 0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))];

describe('tick <-> beat', () => {
  it('converts with the file PPQ', () => {
    expect(ticksToBeats(480, 480)).toBe(1);
    expect(ticksToBeats(120, 480)).toBe(0.25);
    expect(ticksToBeats(96 * 3, 96)).toBe(3);
    expect(beatsToTicks(1.5, 960)).toBe(1440);
    expect(beatsToTicks(1 / 3, 960)).toBe(320);
    expect(beatsToTicks(0.0001, 96)).toBe(0); // nearest tick
    for (const ppq of [24, 96, 480, 960]) {
      for (const t of [0, 1, 7, ppq, 12345]) expect(beatsToTicks(ticksToBeats(t, ppq), ppq)).toBe(t);
    }
  });

  it('converts tempo', () => {
    expect(bpmFromMicros(500000)).toBe(120);
    expect(microsFromBpm(120)).toBe(500000);
    expect(bpmFromMicros(microsFromBpm(97))).toBeCloseTo(97, 3);
  });
});

describe('parseSmf', () => {
  it('reads a format 0 file with running status and splits it by channel', () => {
    const bytes = smfBytes(0, 96, [
      [
        ...name('Song'),
        0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo 500000 = 120 BPM
        0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08, // 3/4
        0x00, 0x90, 60, 100, // ch1 C4 on
        0x00, 64, 90, // running status: ch1 E4 on
        0x00, 0x99, 36, 120, // ch10 kick on
        0x30, 0x89, 36, 0, // ch10 kick off (48 ticks)
        0x30, 0x90, 60, 0, // ch1 note-on velocity 0 = note off at 96
        0x00, 64, 0, // running status, velocity 0 = note off
        ...EOT,
      ],
    ]);
    const smf = parseSmf(bytes);
    expect(smf.format).toBe(0);
    expect(smf.ppq).toBe(96);
    const imported = smfToTracks(smf);
    expect(imported.tempo).toBe(120);
    expect(imported.beatsPerBar).toBe(3);
    expect(imported.tracks.map((t) => [t.name, t.channel, t.drum])).toEqual([
      ['Song (Ch 1)', 0, false],
      ['Song (Ch 10)', 9, true],
    ]);
    const strip = (notes: { pitch: number; start: number; length: number; velocity: number }[]) =>
      notes.map((n) => [n.pitch, n.start, n.length, Math.round(n.velocity * 127)]);
    expect(strip(imported.tracks[0]!.notes)).toEqual([
      [60, 0, 1, 100],
      [64, 0, 1, 90],
    ]);
    expect(strip(imported.tracks[1]!.notes)).toEqual([[36, 0, 0.5, 120]]);
  });

  it('reads a format 1 file: one track per SMF track, names with fallback, tempo track skipped', () => {
    const bytes = smfBytes(1, 480, [
      [0x00, 0xff, 0x51, 0x03, 0x09, 0x27, 0xc0, ...EOT], // 100 BPM, conductor track
      [...name('Bass'), 0x00, 0x91, 40, 64, 0x83, 0x60, 0x81, 40, 64, ...EOT], // 480 ticks later
      [0x00, 0x92, 72, 127, 0x81, 0x70, 0x92, 72, 0, ...EOT], // unnamed, 240 ticks
    ]);
    const imported = smfToTracks(parseSmf(bytes));
    expect(imported.tempo).toBeCloseTo(100, 6);
    expect(imported.beatsPerBar).toBeNull();
    expect(imported.tracks.map((t) => t.name)).toEqual(['Bass', 'MIDI 2']);
    expect(imported.tracks[0]!.notes[0]).toMatchObject({ pitch: 40, start: 0, length: 1 });
    expect(imported.tracks[1]!.notes[0]).toMatchObject({ pitch: 72, start: 0, length: 0.5, velocity: 1 });
  });

  it('treats note-on with velocity 0 as note-off', () => {
    const smf = parseSmf(smfBytes(0, 4, [[0x00, 0x90, 60, 80, 0x02, 0x90, 60, 0, ...EOT]]));
    expect(smf.tracks[0]!.events.map((e) => e.type)).toEqual(['noteOn', 'noteOff', 'endOfTrack']);
    expect(smfToTracks(smf).tracks[0]!.notes).toMatchObject([{ pitch: 60, start: 0, length: 0.5 }]);
  });

  it('pairs overlapping notes of the same pitch first-in first-out', () => {
    // on@0, on@1 beat, off@2, off@3 -> [0..2] and [1..3]
    const smf = parseSmf(smfBytes(0, 1, [[0x00, 0x90, 60, 100, 0x01, 0x90, 60, 50, 0x01, 0x80, 60, 0, 0x01, 0x80, 60, 0, ...EOT]]));
    const notes = smfToTracks(smf).tracks[0]!.notes;
    expect(notes.map((n) => [n.start, n.length, Math.round(n.velocity * 127)])).toEqual([
      [0, 2, 100],
      [1, 2, 50],
    ]);
  });

  it('closes notes still held at the end of the track', () => {
    const smf = parseSmf(smfBytes(0, 4, [[0x00, 0x90, 60, 80, 0x08, 0xff, 0x2f, 0x00]]));
    expect(smfToTracks(smf).tracks[0]!.notes).toMatchObject([{ start: 0, length: 2 }]);
  });

  it('keeps pitch bend (using the RPN 0 range) and CCs, drops sysex, program change and unknown meta', () => {
    const bytes = smfBytes(0, 4, [
      [
        0x00, 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7, // GM reset sysex
        0x00, 0xff, 0x01, 0x02, 0x68, 0x69, // text meta
        0x00, 0xc0, 0x05, // program change
        0x00, 0xb0, 101, 0, // RPN 0 select
        0x00, 100, 0, // running status
        0x00, 6, 12, // bend range 12 semitones
        0x00, 0xb0, 74, 30,
        0x00, 0x90, 60, 100,
        0x02, 0xe0, 0x00, 0x60, // bend 0x3000 = 12288 -> +6 st
        0x02, 0xe0, 0x00, 0x40, // centre
        0x00, 0xb0, 1, 127,
        0x00, 0x80, 60, 0,
        ...EOT,
      ],
    ]);
    const t = smfToTracks(parseSmf(bytes)).tracks[0]!;
    expect(t.bends).toEqual([
      { beat: 0.5, semitones: 6 },
      { beat: 1, semitones: 0 },
    ]);
    expect(t.ccs).toEqual([
      { beat: 0, controller: 74, value: 30 },
      { beat: 1, controller: 1, value: 127 },
    ]);
  });

  it('uses the General MIDI default bend range of 2 semitones', () => {
    const bytes = smfBytes(0, 4, [[0x00, 0x90, 60, 100, 0x00, 0xe0, 0x7f, 0x7f, 0x04, 0x80, 60, 0, ...EOT]]);
    expect(smfToTracks(parseSmf(bytes)).tracks[0]!.bends[0]!.semitones).toBeCloseTo(2 * (8191 / 8192), 9);
  });

  it('skips unknown chunks', () => {
    const base = smfBytes(0, 4, [[0x00, 0x90, 60, 100, 0x04, 0x80, 60, 0, ...EOT]]);
    const junk = [...'XFIH'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 2, 9, 9]);
    const bytes = Uint8Array.from([...base.slice(0, 14), ...junk, ...base.slice(14)]);
    expect(parseSmf(bytes).tracks).toHaveLength(1);
  });

  it('rejects malformed files', () => {
    const good = smfBytes(0, 4, [[0x00, 0x90, 60, 100, 0x04, 0x80, 60, 0, ...EOT]]);
    expect(() => parseSmf(Uint8Array.from([1, 2, 3]))).toThrow(SmfError);
    expect(() => parseSmf(new TextEncoder().encode('RIFF....WAVEfmt nothing here'))).toThrow(/MThd/);
    expect(() => parseSmf(good.slice(0, good.length - 3))).toThrow(/truncated/);
    expect(() => parseSmf(smfBytes(0, 4, [[0x00, 60, 100, ...EOT]]))).toThrow(/without a status/);
    expect(() => parseSmf(smfBytes(0, 4, [[0x00, 0x90, 60]]))).toThrow(/Unexpected end/);
    expect(() => parseSmf(smfBytes(0, 4, [[0x00, 0x90, 0x90, 1, ...EOT]]))).toThrow(/data byte/);
    expect(() => parseSmf(smfBytes(0, 0, [EOT]))).toThrow(/division/);
    const smpte = smfBytes(0, 4, [EOT]);
    smpte[12] = 0xe7;
    expect(() => parseSmf(smpte)).toThrow(/SMPTE/);
    const missing = smfBytes(1, 4, [EOT]);
    missing[11] = 3; // declares 3 tracks
    expect(() => parseSmf(missing)).toThrow(/declares 3 tracks/);
    expect(() => parseSmf(smfBytes(0, 4, [[0x80, 0x80, 0x80, 0x80, 0x00, ...EOT]]))).toThrow(/longer than 4 bytes/);
  });
});

describe('writeSmf', () => {
  it('writes what parseSmf reads back', () => {
    const smf: Smf = {
      format: 1,
      ppq: 960,
      tracks: [
        { events: [{ type: 'trackName', tick: 0, name: 'Tempo ♪' }, { type: 'timeSignature', tick: 0, numerator: 6, denominator: 8 }, { type: 'tempo', tick: 0, microsPerQuarter: 428571 }, { type: 'endOfTrack', tick: 3840 }] },
        {
          events: [
            { type: 'controlChange', tick: 0, channel: 3, controller: 74, value: 99 },
            { type: 'noteOn', tick: 0, channel: 3, pitch: 61, velocity: 77 },
            { type: 'pitchBend', tick: 200_000, channel: 3, value: 16383 }, // multi-byte delta
            { type: 'noteOff', tick: 200_001, channel: 3, pitch: 61, velocity: 64 },
            { type: 'endOfTrack', tick: 200_001 },
          ],
        },
      ],
    };
    expect(parseSmf(writeSmf(smf))).toEqual(smf);
  });

  it('appends end-of-track when missing', () => {
    const bytes = writeSmf({ format: 0, ppq: 96, tracks: [{ events: [{ type: 'noteOn', tick: 5, channel: 0, pitch: 1, velocity: 1 }] }] });
    expect(parseSmf(bytes).tracks[0]!.events.at(-1)).toEqual({ type: 'endOfTrack', tick: 5 });
  });
});
