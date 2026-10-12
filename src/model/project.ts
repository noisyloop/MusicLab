import { defaultParams } from '../devices/types';
import { subsynthDefinition } from '../devices/subsynth/definition';
import { newId } from './ids';
import {
  SCHEMA_VERSION,
  type AudioTrack,
  type Clip,
  type DeviceState,
  type Id,
  type MidiTrack,
  type Project,
  type Track,
  type TrackKind,
} from './types';

export const TRACK_COLORS = [
  '#f5a623', '#7ed321', '#4a90e2', '#bd10e0', '#50e3c2',
  '#e94e77', '#b8e986', '#f8e71c', '#9b9bff', '#ff7f50',
];

export function createProject(name = 'Untitled'): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    tempo: 120,
    beatsPerBar: 4,
    loop: { enabled: false, start: 0, end: 16 },
    master: { volume: 1 },
    tracks: [],
    assets: {},
  };
}

export function defaultInstrument(): DeviceState {
  return { type: subsynthDefinition.type, params: defaultParams(subsynthDefinition) };
}

export function createTrack(kind: TrackKind, name: string, color: string): Track {
  const base = { id: newId('t'), name, color, volume: 0.8, pan: 0, mute: false, solo: false };
  if (kind === 'audio') {
    const t: AudioTrack = { ...base, kind: 'audio', clips: [] };
    return t;
  }
  const t: MidiTrack = { ...base, kind: 'midi', clips: [], instrument: defaultInstrument() };
  return t;
}

export function nextTrackColor(project: Project): string {
  return TRACK_COLORS[project.tracks.length % TRACK_COLORS.length]!;
}

export function nextTrackName(project: Project, kind: TrackKind): string {
  const base = kind === 'audio' ? 'Audio' : 'MIDI';
  let n = project.tracks.filter((t) => t.kind === kind).length + 1;
  const names = new Set(project.tracks.map((t) => t.name));
  while (names.has(`${n} ${base}`)) n++;
  return `${n} ${base}`;
}

export function findTrack(project: Project, trackId: Id): Track | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

export interface ClipLocation {
  track: Track;
  trackIndex: number;
  clip: Clip;
}

export function findClip(project: Project, clipId: Id): ClipLocation | undefined {
  for (let i = 0; i < project.tracks.length; i++) {
    const track = project.tracks[i]!;
    const clip = (track.clips as Clip[]).find((c) => c.id === clipId);
    if (clip) return { track, trackIndex: i, clip };
  }
  return undefined;
}

export function allClips(project: Project): Clip[] {
  return project.tracks.flatMap((t) => t.clips as Clip[]);
}

export function clipEnd(clip: Clip): number {
  return clip.start + clip.length;
}

/** End of the last clip in beats (0 for an empty project). */
export function projectEndBeat(project: Project): number {
  let end = 0;
  for (const c of allClips(project)) end = Math.max(end, clipEnd(c));
  return end;
}

/** Ids of assets referenced by at least one clip. */
export function referencedAssetIds(project: Project): Set<Id> {
  const ids = new Set<Id>();
  for (const t of project.tracks) {
    if (t.kind === 'audio') for (const c of t.clips) ids.add(c.assetId);
  }
  return ids;
}

/** Whether a track is audible given mute/solo state across the project. */
export function isTrackAudible(project: Project, track: Track): boolean {
  if (track.mute) return false;
  const anySolo = project.tracks.some((t) => t.solo);
  return !anySolo || track.solo;
}
