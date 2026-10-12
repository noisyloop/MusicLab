import { describe, expect, it } from 'vitest';
import { drumkitDefinition } from '../devices/drumkit/definition';
import { defaultParams } from '../devices/types';
import { History } from '../model/history';
import { createProject, createTrack } from '../model/project';
import { fixture, midiClip, note } from '../model/testUtil';
import type { MidiClip, MidiTrack, Project } from '../model/types';
import { bendRangeFor, exportMidiFile, projectToSmf } from './export';
import { planMidiImport, readMidiFile, smfToTracks } from './import';
import { parseSmf, SmfError } from './smf';

const vel = (k: number) => k / 127;

function midiTrack(id: string, name: string, clips: MidiClip[], drum = false): MidiTrack {
  const t = { ...(createTrack('midi', name, '#0f0') as MidiTrack), id, clips };
  return drum ? { ...t, instrument: { type: drumkitDefinition.type, params: defaultParams(drumkitDefinition) } } : t;
}

function songProject(): Project {
  const lead = midiClip('c1', 0, 8, [note('a', 60, 0, 1, vel(100)), note('b', 64, 0.5, 1.25, vel(64)), note('c', 60, 1, 2, vel(127)), note('d', 67, 6.75, 1.25, vel(1))], {
    bends: [
      { beat: 0, semitones: 0 },
      { beat: 1.5, semitones: 0.5 },
      { beat: 2, semitones: -2 },
      { beat: 2.25, semitones: 1.5 },
      { beat: 4, semitones: 0 },
    ],
    ccs: [
      { beat: 0, controller: 1, value: 0 },
      { beat: 3.125, controller: 74, value: 100 },
      { beat: 3.125, controller: 1, value: 64 },
      { beat: 7, controller: 74, value: 64 },
    ],
  });
  const drums = midiClip('c2', 0, 4, [note('k', 36, 0, 0.25, vel(120)), note('h', 42, 0.5, 0.25, vel(80)), note('s', 38, 1, 0.25, vel(110))]);
  return { ...createProject('Song'), tempo: 133, tracks: [midiTrack('t1', 'Lead', [lead]), midiTrack('t2', 'Drums', [drums], true)] };
}

const strip = (c: MidiClip) => c.notes.map(({ id: _id, ...rest }) => rest);

describe('MIDI export -> import round trip', () => {
  it('yields identical notes, bends and CCs', () => {
    const project = songProject();
    const imported = readMidiFile(exportMidiFile(project, { startBeat: 0, endBeat: 8 }));
    expect(imported.tempo).toBeCloseTo(133, 3);
    expect(imported.beatsPerBar).toBe(4);
    expect(imported.tracks.map((t) => [t.name, t.drum])).toEqual([
      ['Lead', false],
      ['Drums', true],
    ]);
    const lead = (project.tracks[0] as MidiTrack).clips[0]!;
    const drums = (project.tracks[1] as MidiTrack).clips[0]!;
    expect(imported.tracks[0]!.notes.map(({ id: _id, ...rest }) => rest)).toEqual(strip(lead));
    expect(imported.tracks[0]!.bends).toEqual(lead.bends);
    expect(imported.tracks[0]!.ccs).toEqual(lead.ccs);
    expect(imported.tracks[1]!.notes.map(({ id: _id, ...rest }) => rest)).toEqual(strip(drums));
    expect(imported.tracks[1]!.bends).toEqual([]);
  });

  it('round-trips bends that came from a file with another bend range exactly', () => {
    const step = 12 / 8192; // one 14-bit step at a range of 12 semitones
    const bends = [8191, -8192, 1, -4097, 0].map((v, i) => ({ beat: i / 4, semitones: v * step }));
    const clip = midiClip('c', 0, 4, [note('n', 40, 0, 1)], { bends });
    const p: Project = { ...createProject(), tracks: [midiTrack('t', 'T', [clip])] };
    expect(readMidiFile(exportMidiFile(p, { startBeat: 0, endBeat: 4 })).tracks[0]!.bends).toEqual(bends);
  });

  it('picks the bend range with the least quantization error', () => {
    expect(bendRangeFor([])).toBe(2);
    expect(bendRangeFor([1, -2, 0.5])).toBe(2); // -2 fits; +2 would not
    expect(bendRangeFor([2])).toBe(4);
    expect(bendRangeFor([12 * (8191 / 8192)])).toBe(12);
    expect(bendRangeFor([7])).toBe(8);
    expect(bendRangeFor([200])).toBe(96);
  });

  it('writes format 1 with a tempo track, drums on channel 10, and skips audio tracks', () => {
    const p = fixture(); // one audio track + one MIDI track
    const smf = parseSmf(exportMidiFile({ ...songProject(), tracks: [...p.tracks, ...songProject().tracks] }, { startBeat: 0, endBeat: 8 }));
    expect(smf.format).toBe(1);
    expect(smf.tracks).toHaveLength(4); // tempo + Keys + Lead + Drums
    expect(smf.tracks[0]!.events.some((e) => e.type === 'tempo')).toBe(true);
    const channels = smf.tracks.slice(1).map((t) => new Set(t.events.flatMap((e) => ('channel' in e ? [e.channel] : []))));
    expect(channels.map((c) => [...c])).toEqual([[0], [1], [9]]); // Keys, Lead, Drums
  });

  it('exports only what plays: visible clip content, shifted to the range start', () => {
    // Clip at beat 8, left-trimmed by 1 beat: note at content 0 is hidden, bend state before it is chased.
    const clip = midiClip('c', 8, 3, [note('x', 50, 0, 1), note('y', 52, 1, 1, vel(90)), note('z', 53, 2, 4, vel(90))], {
      contentOffset: 1,
      bends: [{ beat: 0.5, semitones: 1 }],
    });
    const p: Project = { ...createProject(), tracks: [midiTrack('t', 'T', [clip])] };
    const imported = smfToTracks(projectToSmf(p, { startBeat: 8, endBeat: 12 }));
    const t = imported.tracks[0]!;
    expect(t.notes.map((n) => [n.pitch, n.start, n.length])).toEqual([
      [52, 0, 1],
      [53, 1, 2], // cut at the clip end
    ]);
    expect(t.bends).toEqual([{ beat: 0, semitones: 1 }]);
  });

  it('writes the loop region only', () => {
    const p = { ...songProject(), loop: { enabled: true, start: 1, end: 3 } };
    const t = smfToTracks(projectToSmf(p, { startBeat: 1, endBeat: 3 })).tracks[0]!;
    // Notes already sounding at the range start are chased, as in WAV export.
    expect(t.notes.map((n) => [n.pitch, n.start, n.length])).toEqual([
      [60, 0, 2],
      [64, 0, 0.75],
    ]);
  });
});

describe('planMidiImport', () => {
  const file = () => exportMidiFile(songProject(), { startBeat: 0, endBeat: 8 });

  it('adds one track and clip per imported track as a single undo step', () => {
    const start = { ...createProject(), tempo: 90 };
    const plan = planMidiImport(start, readMidiFile(file()), { beat: 4, label: 'Import MIDI' });
    const h = new History(start);
    expect(h.execute(plan.command)).toBe(true);
    const p = h.project;
    expect(p.tracks.map((t) => t.name)).toEqual(['Lead', 'Drums']);
    expect(p.tracks.map((t) => (t.kind === 'midi' ? t.instrument.type : ''))).toEqual(['subsynth', 'drumkit']);
    const clips = p.tracks.map((t) => (t as MidiTrack).clips[0]!);
    expect(clips.map((c) => [c.start, c.length, c.contentOffset])).toEqual([
      [4, 8, 0],
      [4, 4, 0],
    ]);
    expect(clips[0]!.bends).toHaveLength(5);
    expect(clips[1]!.bends).toBeUndefined();
    // The empty project adopts the file tempo.
    expect(p.tempo).toBeCloseTo(133, 3);
    expect(h.undo()).toBe(true);
    expect(h.project).toBe(start);
    expect(h.canUndo).toBe(false);
  });

  it('keeps the tempo of a project that already has clips, and inserts below a given track', () => {
    const start = fixture();
    const plan = planMidiImport(start, readMidiFile(file()), { beat: 0, insertIndex: 1, label: 'Import MIDI' });
    const p = plan.command.apply(start);
    expect(p.tempo).toBe(120);
    expect(p.tracks.map((t) => t.name)).toEqual(['Drums', 'Lead', 'Drums', 'Keys']);
  });

  it('rejects files without notes', () => {
    const empty = exportMidiFile(createProject(), { startBeat: 0, endBeat: 4 });
    expect(() => readMidiFile(empty)).toThrow(SmfError);
  });
});
