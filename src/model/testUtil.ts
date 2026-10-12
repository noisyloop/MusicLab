import { createProject, createTrack } from './project';
import type { AudioClip, AudioTrack, MidiClip, MidiTrack, Note, Project } from './types';

/** Deterministic fixture builders for tests. */
export function audioClip(id: string, start: number, length: number, extra: Partial<AudioClip> = {}): AudioClip {
  return { id, kind: 'audio', name: id, start, length, assetId: 'a1', sourceOffset: 0, gain: 1, ...extra };
}

export function midiClip(id: string, start: number, length: number, notes: Note[] = [], extra: Partial<MidiClip> = {}): MidiClip {
  return { id, kind: 'midi', name: id, start, length, contentOffset: 0, notes, ...extra };
}

export function note(id: string, pitch: number, start: number, length: number, velocity = 0.8): Note {
  return { id, pitch, start, length, velocity };
}

export function fixture(): Project {
  const p = createProject('Test');
  const a = { ...(createTrack('audio', 'Drums', '#f00') as AudioTrack), id: 'ta' };
  const m = { ...(createTrack('midi', 'Keys', '#0f0') as MidiTrack), id: 'tm' };
  a.clips = [audioClip('c1', 0, 4), audioClip('c2', 8, 4, { sourceOffset: 1 })];
  m.clips = [midiClip('m1', 4, 4, [note('n1', 60, 0, 1), note('n2', 64, 2, 1)])];
  return {
    ...p,
    tempo: 120,
    tracks: [a, m],
    assets: { a1: { id: 'a1', fileName: 'loop.wav', mimeType: 'audio/wav', duration: 10, sampleRate: 44100, channels: 2 } },
  };
}
