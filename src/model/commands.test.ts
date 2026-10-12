import { describe, expect, it } from 'vitest';
import {
  addAsset, addClip, addNotes, addTrack, batch, deleteClips, deleteNotes, duplicateClips, moveClips, moveTrack,
  removeTrack, renameClip, renameTrack, setClipGain, setDeviceParam, setLoop, setMasterVolume, setProjectName,
  setTempo, setTrackMix, splitClips, trimClipEnd, trimClipStart, updateNotes, type Command,
} from './commands';
import { History } from './history';
import { createTrack, findClip, isTrackAudible } from './project';
import { audioClip, fixture, midiClip, note } from './testUtil';
import type { AudioClip, MidiClip, MidiTrack, Project } from './types';

/** Run a command through History and check that undo restores the exact original and redo the result. */
function roundTrip(cmd: Command, start: Project = fixture()): Project {
  const frozen = structuredClone(start);
  const h = new History(start);
  expect(h.execute(cmd)).toBe(true);
  const after = h.project;
  expect(start).toEqual(frozen); // input not mutated
  expect(h.undo()).toBe(true);
  expect(h.project).toBe(start);
  expect(h.redo()).toBe(true);
  expect(h.project).toBe(after);
  return after;
}

const clip = (p: Project, id: string) => findClip(p, id)?.clip;

describe('project commands', () => {
  it('setProjectName / setTempo / setMasterVolume', () => {
    expect(roundTrip(setProjectName('New')).name).toBe('New');
    expect(roundTrip(setTempo(140)).tempo).toBe(140);
    expect(roundTrip(setTempo(9999)).tempo).toBe(400);
    expect(roundTrip(setMasterVolume(0.5)).master.volume).toBe(0.5);
  });

  it('setLoop keeps end after start', () => {
    const p = roundTrip(setLoop({ enabled: true, start: 4, end: 2 }));
    expect(p.loop.enabled).toBe(true);
    expect(p.loop.end).toBeGreaterThan(p.loop.start);
    expect(roundTrip(setLoop({ start: 8, end: 12 })).loop).toMatchObject({ start: 8, end: 12 });
  });

  it('no-op commands record nothing', () => {
    const p = fixture();
    const h = new History(p);
    expect(h.execute(setTempo(120))).toBe(false);
    expect(h.execute(renameTrack('missing', 'x'))).toBe(false);
    expect(h.canUndo).toBe(false);
    expect(h.isDirty).toBe(false);
  });
});

describe('track commands', () => {
  it('addTrack appends or inserts', () => {
    const t = { ...createTrack('audio', 'New', '#fff'), id: 'tn' };
    expect(roundTrip(addTrack(t)).tracks.map((x) => x.id)).toEqual(['ta', 'tm', 'tn']);
    expect(roundTrip(addTrack(t, 0)).tracks.map((x) => x.id)).toEqual(['tn', 'ta', 'tm']);
  });

  it('removeTrack', () => {
    expect(roundTrip(removeTrack('ta')).tracks.map((x) => x.id)).toEqual(['tm']);
  });

  it('renameTrack', () => {
    expect(roundTrip(renameTrack('tm', 'Lead')).tracks[1]!.name).toBe('Lead');
  });

  it('moveTrack', () => {
    expect(roundTrip(moveTrack('ta', 1)).tracks.map((x) => x.id)).toEqual(['tm', 'ta']);
    expect(roundTrip(moveTrack('tm', -5)).tracks.map((x) => x.id)).toEqual(['tm', 'ta']);
  });

  it('setTrackMix clamps and toggles', () => {
    const p = roundTrip(setTrackMix('ta', { volume: 5, pan: -3 }));
    expect(p.tracks[0]).toMatchObject({ volume: 2, pan: -1 });
    const s = roundTrip(setTrackMix('tm', { solo: true }));
    expect(isTrackAudible(s, s.tracks[0]!)).toBe(false);
    expect(isTrackAudible(s, s.tracks[1]!)).toBe(true);
    const m = roundTrip(setTrackMix('ta', { mute: true }));
    expect(isTrackAudible(m, m.tracks[0]!)).toBe(false);
  });

  it('setDeviceParam clamps to descriptor range', () => {
    const p = roundTrip(setDeviceParam('tm', 'cutoff', 1e9));
    expect((p.tracks[1] as MidiTrack).instrument.params.cutoff).toBe(18000);
    const h = new History(fixture());
    expect(h.execute(setDeviceParam('tm', 'nope', 1))).toBe(false);
    expect(h.execute(setDeviceParam('ta', 'cutoff', 1))).toBe(false);
  });

  it('merges continuous edits with the same key into one undo step', () => {
    let t = 0;
    const h = new History(fixture(), () => t);
    h.execute(setTrackMix('ta', { volume: 0.1 }));
    t += 100;
    h.execute(setTrackMix('ta', { volume: 0.2 }));
    t += 100;
    h.execute(setTrackMix('ta', { volume: 0.3 }));
    h.undo();
    expect(h.project.tracks[0]!.volume).toBe(0.8);
    expect(h.canUndo).toBe(false);
    h.redo();
    h.closeMerge();
    h.execute(setTrackMix('ta', { volume: 0.4 }));
    h.undo();
    expect(h.project.tracks[0]!.volume).toBe(0.3);
  });

  it('tracks dirty state against the saved snapshot', () => {
    const h = new History(fixture());
    h.execute(setTempo(100));
    expect(h.isDirty).toBe(true);
    h.markSaved();
    expect(h.isDirty).toBe(false);
    h.undo();
    expect(h.isDirty).toBe(true);
    h.redo();
    expect(h.isDirty).toBe(false);
  });
});

describe('clip commands', () => {
  it('addAsset + addClip (kind must match track)', () => {
    const p = roundTrip(
      batch('drop', [
        addAsset({ id: 'a2', fileName: 'x.wav', mimeType: 'audio/wav', duration: 2, sampleRate: 48000, channels: 1 }),
        addClip('ta', audioClip('c9', 16, 4, { assetId: 'a2' })),
      ]),
    );
    expect(p.assets.a2).toBeDefined();
    expect(clip(p, 'c9')).toBeDefined();
    const h = new History(fixture());
    expect(h.execute(addClip('tm', audioClip('c9', 0, 1)))).toBe(false);
  });

  it('deleteClips', () => {
    const p = roundTrip(deleteClips(['c1', 'm1']));
    expect(clip(p, 'c1')).toBeUndefined();
    expect(clip(p, 'm1')).toBeUndefined();
    expect(clip(p, 'c2')).toBeDefined();
  });

  it('moveClips in time and across tracks of the same kind', () => {
    const base = fixture();
    const extra = { ...createTrack('audio', 'Other', '#00f'), id: 'tb' };
    const start = { ...base, tracks: [...base.tracks, extra] };
    const p = roundTrip(moveClips([{ clipId: 'c1', trackId: 'tb', start: 2 }, { clipId: 'm1', trackId: 'tm', start: 6 }]), start);
    expect(findClip(p, 'c1')).toMatchObject({ track: { id: 'tb' }, clip: { start: 2 } });
    expect(clip(p, 'm1')!.start).toBe(6);
    // wrong kind is ignored, negative start clamps to 0
    const h = new History(start);
    expect(h.execute(moveClips([{ clipId: 'c1', trackId: 'tm', start: 0 }]))).toBe(false);
    h.execute(moveClips([{ clipId: 'c2', trackId: 'ta', start: -3 }]));
    expect(clip(h.project, 'c2')!.start).toBe(0);
  });

  it('trimClipStart keeps audio anchored and respects file start', () => {
    // c2: start 8, sourceOffset 1s => at 120bpm (0.5s/beat) can extend left by 2 beats
    const p = roundTrip(trimClipStart('c2', 9));
    expect(clip(p, 'c2')).toMatchObject({ start: 9, length: 3, sourceOffset: 1.5 });
    const q = roundTrip(trimClipStart('c2', 0));
    expect(clip(q, 'c2')).toMatchObject({ start: 6, length: 6, sourceOffset: 0 });
  });

  it('trimClipStart on MIDI shifts content offset', () => {
    const p = roundTrip(trimClipStart('m1', 5));
    expect(clip(p, 'm1')).toMatchObject({ start: 5, length: 3, contentOffset: 1 });
  });

  it('trimClipEnd clamps audio to source length', () => {
    // asset 10s, c2 offset 1s => max 9s = 18 beats
    expect(clip(roundTrip(trimClipEnd('c2', 100)), 'c2')!.length).toBe(18);
    expect(clip(roundTrip(trimClipEnd('m1', 2)), 'm1')!.length).toBe(2);
    expect(clip(roundTrip(trimClipEnd('m1', -1)), 'm1')!.length).toBeGreaterThan(0);
  });

  it('splitClips divides clips at a beat', () => {
    const p = roundTrip(splitClips(['c2', 'm1', 'c1'], 9, ['r1', 'r2', 'r3']));
    expect(clip(p, 'c2')).toMatchObject({ start: 8, length: 1 });
    expect(clip(p, 'r1')).toMatchObject({ start: 9, length: 3, sourceOffset: 1.5 });
    // m1 is 4..8 so 9 is outside; c1 is 0..4 also outside
    expect(clip(p, 'r2')).toBeUndefined();
    expect(clip(p, 'r3')).toBeUndefined();
    const q = roundTrip(splitClips(['m1'], 6, ['r4']));
    expect(clip(q, 'm1')).toMatchObject({ start: 4, length: 2, contentOffset: 0 });
    expect(clip(q, 'r4')).toMatchObject({ start: 6, length: 2, contentOffset: 2 });
  });

  it('duplicateClips places copies after the selection', () => {
    const start = fixture();
    const { command, newIds } = duplicateClips(start, ['c1', 'm1']);
    const p = roundTrip(command, start);
    expect(newIds).toHaveLength(2);
    // selection spans 0..8 => shift by 8
    expect(clip(p, newIds[0]!)).toMatchObject({ start: 8, kind: 'audio' });
    expect(findClip(p, newIds[1]!)).toMatchObject({ track: { id: 'tm' }, clip: { start: 12 } });
  });

  it('renameClip / setClipGain', () => {
    expect(clip(roundTrip(renameClip('c1', 'Kick')), 'c1')!.name).toBe('Kick');
    expect((clip(roundTrip(setClipGain('c1', 9)), 'c1') as AudioClip).gain).toBe(4);
  });
});

describe('note commands', () => {
  const notesOf = (p: Project) => (clip(p, 'm1') as MidiClip).notes;

  it('addNotes sanitizes values', () => {
    const p = roundTrip(addNotes('m1', [note('n3', 200, 1, 0, 3)]));
    expect(notesOf(p).find((n) => n.id === 'n3')).toMatchObject({ pitch: 127, velocity: 1 });
    expect(notesOf(p).find((n) => n.id === 'n3')!.length).toBeGreaterThan(0);
  });

  it('updateNotes replaces by id', () => {
    const p = roundTrip(updateNotes('m1', [note('n1', 61, 0.5, 2, 0.3)]));
    expect(notesOf(p)[0]).toEqual(note('n1', 61, 0.5, 2, 0.3));
    expect(notesOf(p)[1]).toEqual(notesOf(fixture())[1]);
  });

  it('deleteNotes', () => {
    expect(notesOf(roundTrip(deleteNotes('m1', ['n1']))).map((n) => n.id)).toEqual(['n2']);
  });

  it('note commands ignore audio clips', () => {
    const h = new History(fixture());
    expect(h.execute(addNotes('c1', [note('x', 60, 0, 1)]))).toBe(false);
    expect(h.execute(addNotes('m1', [note('n1', 60, 0, 1)]))).toBe(false); // duplicate id
  });

  it('works with fresh midi clip', () => {
    const p = roundTrip(addClip('tm', midiClip('m2', 16, 4)));
    expect(clip(p, 'm2')).toBeDefined();
  });
});
