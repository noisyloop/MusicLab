/**
 * Every edit to a Project is expressed as a Command: a labelled, pure
 * function from one immutable project state to the next. The History keeps
 * the before/after states so undo/redo covers every edit uniformly.
 *
 * Commands must never mutate their input. If a command does not apply (for
 * example, an id that no longer exists) it returns the same project object,
 * and History records nothing.
 */
import { getDeviceDefinition, getEffectDefinition } from '../devices/registry';
import { clampParam, defaultParams } from '../devices/types';
import { newId } from './ids';
import { findClip, findTrack } from './project';
import { clampTempo, secondsPerBeat } from './time';
import type {
  AudioAsset,
  AudioClip,
  Clip,
  EffectSlot,
  Id,
  LoopRegion,
  MidiClip,
  Note,
  Project,
  Track,
} from './types';
import { MASTER_CHAIN } from './types';

export interface Command {
  label: string;
  /** Consecutive commands with the same mergeKey collapse into one undo step. */
  mergeKey?: string;
  apply(project: Project): Project;
}

/** Shortest clip/note length allowed by edits, in beats. */
export const MIN_LENGTH = 1 / 64;

// ---------------------------------------------------------------------------
// helpers

function mapTrack(project: Project, trackId: Id, fn: (t: Track) => Track): Project {
  let changed = false;
  const tracks = project.tracks.map((t) => {
    if (t.id !== trackId) return t;
    const n = fn(t);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? { ...project, tracks } : project;
}

function withClips(track: Track, clips: Clip[]): Track {
  if (track.kind === 'audio') return { ...track, clips: clips.filter((c): c is AudioClip => c.kind === 'audio') };
  return { ...track, clips: clips.filter((c): c is MidiClip => c.kind === 'midi') };
}

function mapClip(project: Project, clipId: Id, fn: (c: Clip, track: Track) => Clip): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  return mapTrack(project, loc.track.id, (t) => {
    let changed = false;
    const clips = (t.clips as Clip[]).map((c) => {
      if (c.id !== clipId) return c;
      const n = fn(c, t);
      if (n !== c) changed = true;
      return n;
    });
    return changed ? withClips(t, clips) : t;
  });
}

function mapMidiClip(project: Project, clipId: Id, fn: (c: MidiClip) => MidiClip): Project {
  return mapClip(project, clipId, (c) => (c.kind === 'midi' ? fn(c) : c));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function sanitizeNote(n: Note): Note {
  return {
    ...n,
    pitch: clamp(Math.round(n.pitch), 0, 127),
    length: Math.max(MIN_LENGTH, n.length),
    velocity: clamp(n.velocity, 0, 1),
  };
}

// ---------------------------------------------------------------------------
// project-level

export function setProjectName(name: string): Command {
  return {
    label: 'Rename project',
    apply: (p) => (p.name === name ? p : { ...p, name }),
  };
}

export function setTempo(tempo: number): Command {
  const t = clampTempo(tempo);
  return {
    label: 'Change tempo',
    mergeKey: 'tempo',
    apply: (p) => (p.tempo === t ? p : { ...p, tempo: t }),
  };
}

export function setBeatsPerBar(beatsPerBar: number): Command {
  const b = clamp(Math.round(beatsPerBar), 1, 32);
  return {
    label: 'Change time signature',
    apply: (p) => (p.beatsPerBar === b ? p : { ...p, beatsPerBar: b }),
  };
}

export function setLoop(patch: Partial<LoopRegion>, mergeKey?: string): Command {
  return {
    label: patch.enabled !== undefined && patch.start === undefined ? 'Toggle loop' : 'Set loop region',
    mergeKey,
    apply: (p) => {
      const next = { ...p.loop, ...patch };
      next.start = Math.max(0, next.start);
      if (next.end - next.start < MIN_LENGTH) next.end = next.start + MIN_LENGTH;
      if (next.enabled === p.loop.enabled && next.start === p.loop.start && next.end === p.loop.end) return p;
      return { ...p, loop: next };
    },
  };
}

export function setMasterVolume(volume: number): Command {
  const v = clamp(volume, 0, 2);
  return {
    label: 'Master volume',
    mergeKey: 'master-volume',
    apply: (p) => (p.master.volume === v ? p : { ...p, master: { ...p.master, volume: v } }),
  };
}

// ---------------------------------------------------------------------------
// tracks

export function addTrack(track: Track, index?: number): Command {
  return {
    label: `Add track "${track.name}"`,
    apply: (p) => {
      if (p.tracks.some((t) => t.id === track.id)) return p;
      const tracks = [...p.tracks];
      const at = index === undefined ? tracks.length : clamp(index, 0, tracks.length);
      tracks.splice(at, 0, track);
      return { ...p, tracks };
    },
  };
}

export function removeTrack(trackId: Id): Command {
  return {
    label: 'Delete track',
    apply: (p) => {
      const tracks = p.tracks.filter((t) => t.id !== trackId);
      return tracks.length === p.tracks.length ? p : { ...p, tracks };
    },
  };
}

export function renameTrack(trackId: Id, name: string): Command {
  return {
    label: 'Rename track',
    apply: (p) => mapTrack(p, trackId, (t) => (t.name === name ? t : { ...t, name })),
  };
}

export function moveTrack(trackId: Id, toIndex: number): Command {
  return {
    label: 'Reorder track',
    apply: (p) => {
      const from = p.tracks.findIndex((t) => t.id === trackId);
      if (from < 0) return p;
      const to = clamp(Math.round(toIndex), 0, p.tracks.length - 1);
      if (from === to) return p;
      const tracks = [...p.tracks];
      const [t] = tracks.splice(from, 1);
      tracks.splice(to, 0, t!);
      return { ...p, tracks };
    },
  };
}

export interface TrackMixPatch {
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  color?: string;
}

export function setTrackMix(trackId: Id, patch: TrackMixPatch): Command {
  const keys = Object.keys(patch).sort().join(',');
  const continuous = patch.volume !== undefined || patch.pan !== undefined;
  const label =
    patch.mute !== undefined ? 'Toggle mute' : patch.solo !== undefined ? 'Toggle solo' : patch.volume !== undefined ? 'Track volume' : patch.pan !== undefined ? 'Track pan' : 'Track color';
  return {
    label,
    mergeKey: continuous ? `mix:${trackId}:${keys}` : undefined,
    apply: (p) =>
      mapTrack(p, trackId, (t) => {
        const next = { ...t };
        if (patch.volume !== undefined) next.volume = clamp(patch.volume, 0, 2);
        if (patch.pan !== undefined) next.pan = clamp(patch.pan, -1, 1);
        if (patch.mute !== undefined) next.mute = patch.mute;
        if (patch.solo !== undefined) next.solo = patch.solo;
        if (patch.color !== undefined) next.color = patch.color;
        const same = next.volume === t.volume && next.pan === t.pan && next.mute === t.mute && next.solo === t.solo && next.color === t.color;
        return same ? t : next;
      }),
  };
}

export function setDeviceParam(trackId: Id, paramId: string, value: number): Command {
  return {
    label: 'Change device parameter',
    mergeKey: `param:${trackId}:${paramId}`,
    apply: (p) =>
      mapTrack(p, trackId, (t) => {
        if (t.kind !== 'midi') return t;
        const def = getDeviceDefinition(t.instrument.type);
        const desc = def?.params.find((d) => d.id === paramId);
        if (!desc) return t;
        const v = clampParam(desc, value);
        if (t.instrument.params[paramId] === v) return t;
        return { ...t, instrument: { ...t.instrument, params: { ...t.instrument.params, [paramId]: v } } };
      }),
  };
}

/** Swap a MIDI track's instrument for a fresh instance of another device type. */
export function setInstrument(trackId: Id, type: string): Command {
  return {
    label: 'Change instrument',
    apply: (p) =>
      mapTrack(p, trackId, (t) => {
        const def = getDeviceDefinition(type);
        if (t.kind !== 'midi' || !def || t.instrument.type === type) return t;
        return { ...t, instrument: { type, params: defaultParams(def) } };
      }),
  };
}

/**
 * Copy a track right below itself: new track, clip and effect-slot ids, same
 * content. Returns the command and the copy's id.
 */
export function duplicateTrack(project: Project, trackId: Id): { command: Command; newId: Id | null } {
  const t = findTrack(project, trackId);
  if (!t) return { command: { label: 'Duplicate track', apply: (p) => p }, newId: null };
  const effects = t.effects.map((e) => ({ ...e, id: newId('fx'), params: { ...e.params } }));
  const base = { ...t, id: newId('t'), name: `${t.name} copy`, effects };
  const copy: Track =
    t.kind === 'audio' ? { ...base, kind: 'audio', clips: t.clips.map((c) => ({ ...c, id: newId('c') })) } : { ...base, kind: 'midi', clips: t.clips.map((c) => ({ ...c, id: newId('c') })), instrument: t.instrument };
  const index = project.tracks.indexOf(t) + 1;
  return { command: { ...addTrack(copy, index), label: 'Duplicate track' }, newId: copy.id };
}

// ---------------------------------------------------------------------------
// effect chains (chain = MASTER_CHAIN or a track id)

function mapChain(project: Project, chain: Id, fn: (effects: EffectSlot[]) => EffectSlot[]): Project {
  if (chain === MASTER_CHAIN) {
    const effects = fn(project.master.effects);
    return effects === project.master.effects ? project : { ...project, master: { ...project.master, effects } };
  }
  return mapTrack(project, chain, (t) => {
    const effects = fn(t.effects);
    return effects === t.effects ? t : { ...t, effects };
  });
}

function mapSlot(project: Project, chain: Id, slotId: Id, fn: (s: EffectSlot) => EffectSlot): Project {
  return mapChain(project, chain, (effects) => {
    let changed = false;
    const next = effects.map((e) => {
      if (e.id !== slotId) return e;
      const n = fn(e);
      if (n !== e) changed = true;
      return n;
    });
    return changed ? next : effects;
  });
}

/** Insert an effect slot into a chain at `index` (default: the end). */
export function addEffect(chain: Id, slot: EffectSlot, index?: number): Command {
  const def = getEffectDefinition(slot.type);
  return {
    label: `Add ${def?.name ?? 'effect'}`,
    apply: (p) =>
      mapChain(p, chain, (effects) => {
        if (!def || effects.some((e) => e.id === slot.id)) return effects;
        const next = [...effects];
        next.splice(index === undefined ? next.length : clamp(Math.round(index), 0, next.length), 0, slot);
        return next;
      }),
  };
}

export function removeEffect(chain: Id, slotId: Id): Command {
  return {
    label: 'Remove effect',
    apply: (p) =>
      mapChain(p, chain, (effects) => {
        const next = effects.filter((e) => e.id !== slotId);
        return next.length === effects.length ? effects : next;
      }),
  };
}

/** Move an effect to position `toIndex` within its chain. */
export function moveEffect(chain: Id, slotId: Id, toIndex: number): Command {
  return {
    label: 'Reorder effects',
    apply: (p) =>
      mapChain(p, chain, (effects) => {
        const from = effects.findIndex((e) => e.id === slotId);
        if (from < 0) return effects;
        const to = clamp(Math.round(toIndex), 0, effects.length - 1);
        if (to === from) return effects;
        const next = [...effects];
        const [slot] = next.splice(from, 1);
        next.splice(to, 0, slot!);
        return next;
      }),
  };
}

export function setEffectBypass(chain: Id, slotId: Id, bypass: boolean): Command {
  return {
    label: bypass ? 'Bypass effect' : 'Enable effect',
    apply: (p) => mapSlot(p, chain, slotId, (s) => (s.bypass === bypass ? s : { ...s, bypass })),
  };
}

export function setEffectParam(chain: Id, slotId: Id, paramId: string, value: number): Command {
  return {
    label: 'Change effect parameter',
    mergeKey: `fx:${chain}:${slotId}:${paramId}`,
    apply: (p) =>
      mapSlot(p, chain, slotId, (s) => {
        const desc = getEffectDefinition(s.type)?.params.find((d) => d.id === paramId);
        if (!desc) return s;
        const v = clampParam(desc, value);
        return s.params[paramId] === v ? s : { ...s, params: { ...s.params, [paramId]: v } };
      }),
  };
}

// ---------------------------------------------------------------------------
// assets & clips

export function addAsset(asset: AudioAsset): Command {
  return {
    label: 'Add audio file',
    apply: (p) => (p.assets[asset.id] ? p : { ...p, assets: { ...p.assets, [asset.id]: asset } }),
  };
}

export function addClip(trackId: Id, clip: Clip): Command {
  return {
    label: 'Add clip',
    apply: (p) =>
      mapTrack(p, trackId, (t) => {
        if (t.kind !== clip.kind) return t;
        if ((t.clips as Clip[]).some((c) => c.id === clip.id)) return t;
        return withClips(t, [...(t.clips as Clip[]), { ...clip, start: Math.max(0, clip.start) }]);
      }),
  };
}

export function deleteClips(clipIds: Id[]): Command {
  const ids = new Set(clipIds);
  return {
    label: clipIds.length > 1 ? 'Delete clips' : 'Delete clip',
    apply: (p) => {
      let changed = false;
      const tracks = p.tracks.map((t) => {
        const clips = (t.clips as Clip[]).filter((c) => !ids.has(c.id));
        if (clips.length === t.clips.length) return t;
        changed = true;
        return withClips(t, clips);
      });
      return changed ? { ...p, tracks } : p;
    },
  };
}

export interface ClipMove {
  clipId: Id;
  trackId: Id;
  start: number;
}

/** Move clips in time and/or to other tracks. Moves to a track of the wrong kind are ignored. */
export function moveClips(moves: ClipMove[]): Command {
  return {
    label: moves.length > 1 ? 'Move clips' : 'Move clip',
    apply: (p) => {
      const plan: { clip: Clip; from: Id; to: Id }[] = [];
      for (const m of moves) {
        const loc = findClip(p, m.clipId);
        const dest = p.tracks.find((t) => t.id === m.trackId);
        if (!loc || !dest || dest.kind !== loc.clip.kind) continue;
        const start = Math.max(0, m.start);
        if (start === loc.clip.start && dest.id === loc.track.id) continue;
        plan.push({ clip: { ...loc.clip, start }, from: loc.track.id, to: dest.id });
      }
      if (plan.length === 0) return p;
      const moved = new Set(plan.map((x) => x.clip.id));
      const tracks = p.tracks.map((t) => {
        const kept = (t.clips as Clip[]).filter((c) => !moved.has(c.id));
        const incoming = plan.filter((x) => x.to === t.id).map((x) => x.clip);
        if (kept.length === t.clips.length && incoming.length === 0) return t;
        return withClips(t, [...kept, ...incoming]);
      });
      return { ...p, tracks };
    },
  };
}

/**
 * Move a clip's left edge to `newStart` (beats), keeping the content anchored
 * in time. Audio clips cannot extend before the beginning of their file.
 */
export function trimClipStart(clipId: Id, newStart: number): Command {
  return {
    label: 'Trim clip',
    apply: (p) =>
      mapClip(p, clipId, (c) => {
        const end = c.start + c.length;
        let start = Math.min(Math.max(0, newStart), end - MIN_LENGTH);
        if (c.kind === 'audio') {
          const spb = secondsPerBeat(p.tempo);
          const earliest = c.start - c.sourceOffset / spb;
          start = Math.max(start, earliest);
          if (start === c.start) return c;
          const delta = start - c.start;
          return { ...c, start, length: end - start, sourceOffset: Math.max(0, c.sourceOffset + delta * spb) };
        }
        if (start === c.start) return c;
        const delta = start - c.start;
        return { ...c, start, length: end - start, contentOffset: c.contentOffset + delta };
      }),
  };
}

/** Set a clip's length (moving its right edge). Audio clips cannot extend past the end of their file. */
export function trimClipEnd(clipId: Id, newLength: number): Command {
  return {
    label: 'Trim clip',
    apply: (p) =>
      mapClip(p, clipId, (c) => {
        let length = Math.max(MIN_LENGTH, newLength);
        if (c.kind === 'audio') {
          const asset = p.assets[c.assetId];
          if (asset) {
            const maxLen = (asset.duration - c.sourceOffset) / secondsPerBeat(p.tempo);
            length = Math.max(MIN_LENGTH, Math.min(length, maxLen));
          }
        }
        return length === c.length ? c : { ...c, length };
      }),
  };
}

/** Split each given clip that strictly contains `beat` into two clips. */
export function splitClips(clipIds: Id[], beat: number, newIds?: Id[]): Command {
  const ids = newIds ?? clipIds.map(() => newId('c'));
  return {
    label: 'Split',
    apply: (p) => {
      let next = p;
      clipIds.forEach((clipId, i) => {
        const loc = findClip(next, clipId);
        if (!loc) return;
        const c = loc.clip;
        if (beat - c.start < MIN_LENGTH || c.start + c.length - beat < MIN_LENGTH) return;
        const leftLen = beat - c.start;
        const left: Clip = { ...c, length: leftLen };
        let right: Clip;
        if (c.kind === 'audio') {
          right = { ...c, id: ids[i]!, start: beat, length: c.length - leftLen, sourceOffset: c.sourceOffset + leftLen * secondsPerBeat(next.tempo) };
        } else {
          right = { ...c, id: ids[i]!, start: beat, length: c.length - leftLen, contentOffset: c.contentOffset + leftLen };
        }
        next = mapTrack(next, loc.track.id, (t) => {
          const clips = (t.clips as Clip[]).flatMap((x) => (x.id === clipId ? [left, right] : [x]));
          return withClips(t, clips);
        });
      });
      return next;
    },
  };
}

/**
 * Duplicate clips; copies are placed right after the selection's time span
 * (the same track each). Returns the command and the ids of the copies.
 */
export function duplicateClips(project: Project, clipIds: Id[]): { command: Command; newIds: Id[] } {
  const locs = clipIds.map((id) => findClip(project, id)).filter((l) => l !== undefined);
  if (locs.length === 0) return { command: { label: 'Duplicate', apply: (p) => p }, newIds: [] };
  const spanStart = Math.min(...locs.map((l) => l.clip.start));
  const spanEnd = Math.max(...locs.map((l) => l.clip.start + l.clip.length));
  const shift = spanEnd - spanStart;
  const copies = locs.map((l) => ({ trackId: l.track.id, clip: { ...l.clip, id: newId('c'), start: l.clip.start + shift } as Clip }));
  return {
    newIds: copies.map((c) => c.clip.id),
    command: batch(clipIds.length > 1 ? 'Duplicate clips' : 'Duplicate clip', copies.map((c) => addClip(c.trackId, c.clip))),
  };
}

export function renameClip(clipId: Id, name: string): Command {
  return {
    label: 'Rename clip',
    apply: (p) => mapClip(p, clipId, (c) => (c.name === name ? c : { ...c, name })),
  };
}

export function setClipGain(clipId: Id, gain: number): Command {
  const g = clamp(gain, 0, 4);
  return {
    label: 'Clip gain',
    mergeKey: `clip-gain:${clipId}`,
    apply: (p) => mapClip(p, clipId, (c) => (c.kind === 'audio' && c.gain !== g ? { ...c, gain: g } : c)),
  };
}

// ---------------------------------------------------------------------------
// MIDI notes

export function addNotes(clipId: Id, notes: Note[]): Command {
  return {
    label: notes.length > 1 ? 'Add notes' : 'Add note',
    apply: (p) =>
      mapMidiClip(p, clipId, (c) => {
        const existing = new Set(c.notes.map((n) => n.id));
        const fresh = notes.filter((n) => !existing.has(n.id)).map(sanitizeNote);
        return fresh.length === 0 ? c : { ...c, notes: [...c.notes, ...fresh] };
      }),
  };
}

/** Replace notes (matched by id) with the given versions. */
export function updateNotes(clipId: Id, notes: Note[], label = 'Edit notes', mergeKey?: string): Command {
  const byId = new Map(notes.map((n) => [n.id, sanitizeNote(n)]));
  return {
    label,
    mergeKey,
    apply: (p) =>
      mapMidiClip(p, clipId, (c) => {
        let changed = false;
        const next = c.notes.map((n) => {
          const u = byId.get(n.id);
          if (!u) return n;
          if (u.pitch === n.pitch && u.start === n.start && u.length === n.length && u.velocity === n.velocity) return n;
          changed = true;
          return u;
        });
        return changed ? { ...c, notes: next } : c;
      }),
  };
}

export function deleteNotes(clipId: Id, noteIds: Id[]): Command {
  const ids = new Set(noteIds);
  return {
    label: noteIds.length > 1 ? 'Delete notes' : 'Delete note',
    apply: (p) =>
      mapMidiClip(p, clipId, (c) => {
        const notes = c.notes.filter((n) => !ids.has(n.id));
        return notes.length === c.notes.length ? c : { ...c, notes };
      }),
  };
}

// ---------------------------------------------------------------------------
// composition

export function batch(label: string, commands: Command[]): Command {
  return {
    label,
    apply: (p) => commands.reduce((acc, c) => c.apply(acc), p),
  };
}
