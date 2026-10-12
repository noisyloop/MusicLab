/**
 * Pure scheduling math shared by live playback and offline (WAV) rendering.
 * Given a window of song time in beats and the AudioContext time at which
 * that window starts, compute which audio clip segments and notes to start.
 * This is the only place where beats become seconds for playback.
 */
import type { NoteEvent } from '../devices/types';
import type { AudioClip, Id, LoopRegion, Project } from '../model/types';
import { secondsPerBeat } from '../model/time';

export interface ScheduleWindow {
  /** Song position (beats) at the start of the window. */
  fromBeat: number;
  /** Song position (beats) at the end of the window (exclusive). */
  toBeat: number;
  /** AudioContext time (seconds) corresponding to fromBeat. */
  timeAtFrom: number;
  /**
   * True if playback jumped to fromBeat (play start, seek, loop wrap). Clips
   * and notes already in progress at fromBeat are then started mid-way.
   */
  segmentStart: boolean;
  /** Everything is cut at this beat (loop end), or Infinity. */
  cutBeat: number;
}

export interface AudioStart {
  trackId: Id;
  clip: AudioClip;
  /** AudioContext time to start. */
  when: number;
  /** Offset into the source buffer, seconds. */
  offset: number;
  /** How long to play, seconds. */
  duration: number;
}

export interface NoteStart {
  trackId: Id;
  clipId: Id;
  pitch: number;
  velocity: number;
  /** AudioContext times. */
  on: number;
  off: number;
}

/** Pitch bend or controller change, as scheduled. */
export type ControlValue = { kind: 'bend'; semitones: number } | { kind: 'cc'; controller: number; value: number };

export type ControlStart = ControlValue & {
  trackId: Id;
  clipId: Id;
  /** AudioContext time. */
  time: number;
  /** True for a state restore at a clip start / play start (not a point stored at this time). */
  chase: boolean;
};

export interface WindowEvents {
  audio: AudioStart[];
  notes: NoteStart[];
  controls: ControlStart[];
}

const EPS = 1e-9;

export interface ScheduleFilter {
  /** Restrict to these clip ids (used to re-chase edited clips during playback). */
  clipIds?: ReadonlySet<Id>;
}

/** The beat-domain part of a ScheduleWindow (no clock attached). */
export type BeatWindow = Omit<ScheduleWindow, 'timeAtFrom'>;

export interface BeatNote {
  trackId: Id;
  clipId: Id;
  pitch: number;
  velocity: number;
  /** Song beats. */
  onBeat: number;
  offBeat: number;
}

export type BeatControl = ControlValue & {
  trackId: Id;
  clipId: Id;
  /** Song beat. */
  beat: number;
  chase: boolean;
};

export interface MidiWindowEvents {
  notes: BeatNote[];
  controls: BeatControl[];
}

/** Returns the beat at which an event spanning [start, end) begins in this window, or null. */
function beginIn(w: BeatWindow, start: number, end: number): number | null {
  if (start >= w.fromBeat - EPS && start < w.toBeat - EPS) return Math.max(start, w.fromBeat);
  if (w.segmentStart && start < w.fromBeat && end > w.fromBeat + EPS) return w.fromBeat;
  return null;
}

/**
 * Which MIDI notes and controller events of the project fall into a window,
 * in song beats. Shared by playback (scheduleWindow) and MIDI export, so an
 * exported file contains exactly what plays.
 *
 * Only notes and controller points inside a clip's visible content play.
 * When a clip begins in the window (or is entered mid-way at a segment
 * start), the controller state it would have reached from its hidden content
 * is restored first ("chased"): the last earlier bend (or 0 when none, on
 * tracks that use bends at all, so a bent clip doesn't leave the next one
 * bent), and the last earlier value of each controller the clip uses.
 */
export function collectMidi(project: Project, w: BeatWindow, filter: ScheduleFilter = {}): MidiWindowEvents {
  const out: MidiWindowEvents = { notes: [], controls: [] };
  for (const track of project.tracks) {
    if (track.kind !== 'midi') continue;
    const trackUsesBends = track.clips.some((c) => (c.bends?.length ?? 0) > 0);
    for (const clip of track.clips) {
      if (filter.clipIds && !filter.clipIds.has(clip.id)) continue;
      const clipEnd = Math.min(clip.start + clip.length, w.cutBeat);
      const visibleFrom = clip.contentOffset - EPS;
      const visibleTo = clip.contentOffset + clip.length - EPS;
      const toSong = (contentBeat: number) => clip.start + (contentBeat - clip.contentOffset);
      const base = { trackId: track.id, clipId: clip.id };

      const clipBegin = beginIn(w, clip.start, clipEnd);
      if (clipBegin !== null && clipBegin < clipEnd - EPS) {
        const at = clipBegin - clip.start + clip.contentOffset;
        if (trackUsesBends) {
          let semitones = 0;
          for (const b of clip.bends ?? []) if (b.beat < at - EPS) semitones = b.semitones;
          out.controls.push({ ...base, beat: clipBegin, chase: true, kind: 'bend', semitones });
        }
        const lastCc = new Map<number, number>();
        for (const c of clip.ccs ?? []) if (c.beat < at - EPS) lastCc.set(c.controller, c.value);
        for (const [controller, value] of lastCc) out.controls.push({ ...base, beat: clipBegin, chase: true, kind: 'cc', controller, value });
      }
      const inWindow = (contentBeat: number): number | null => {
        if (contentBeat < visibleFrom || contentBeat >= visibleTo) return null;
        const sb = toSong(contentBeat);
        return sb >= w.fromBeat - EPS && sb < w.toBeat - EPS && sb < clipEnd - EPS ? Math.max(sb, w.fromBeat) : null;
      };
      for (const b of clip.bends ?? []) {
        const beat = inWindow(b.beat);
        if (beat !== null) out.controls.push({ ...base, beat, chase: false, kind: 'bend', semitones: b.semitones });
      }
      for (const c of clip.ccs ?? []) {
        const beat = inWindow(c.beat);
        if (beat !== null) out.controls.push({ ...base, beat, chase: false, kind: 'cc', controller: c.controller, value: c.value });
      }

      for (const n of clip.notes) {
        // Only notes that begin inside the clip's visible content play.
        if (n.start < visibleFrom || n.start >= visibleTo) continue;
        const nb = toSong(n.start);
        const ne = Math.min(nb + n.length, clipEnd);
        const begin = beginIn(w, nb, ne);
        if (begin === null || begin >= ne - EPS) continue;
        out.notes.push({ ...base, pitch: n.pitch, velocity: n.velocity, onBeat: begin, offBeat: ne });
      }
    }
  }
  return out;
}

export function scheduleWindow(project: Project, w: ScheduleWindow, filter: ScheduleFilter = {}): WindowEvents {
  const spb = secondsPerBeat(project.tempo);
  const timeOf = (beat: number) => w.timeAtFrom + (beat - w.fromBeat) * spb;
  const out: WindowEvents = { audio: [], notes: [], controls: [] };

  for (const track of project.tracks) {
    if (track.kind !== 'audio') continue;
    for (const clip of track.clips) {
      if (filter.clipIds && !filter.clipIds.has(clip.id)) continue;
      const end = Math.min(clip.start + clip.length, w.cutBeat);
      const begin = beginIn(w, clip.start, end);
      if (begin === null || begin >= end - EPS) continue;
      const offset = clip.sourceOffset + (begin - clip.start) * spb;
      let duration = (end - begin) * spb;
      const asset = project.assets[clip.assetId];
      if (asset) duration = Math.min(duration, asset.duration - offset);
      if (duration <= EPS) continue;
      out.audio.push({ trackId: track.id, clip, when: timeOf(begin), offset, duration });
    }
  }

  const midi = collectMidi(project, w, filter);
  for (const n of midi.notes) {
    out.notes.push({ trackId: n.trackId, clipId: n.clipId, pitch: n.pitch, velocity: n.velocity, on: timeOf(n.onBeat), off: timeOf(n.offBeat) });
  }
  for (const c of midi.controls) {
    const { beat, ...rest } = c;
    out.controls.push({ ...rest, time: timeOf(beat) });
  }
  return out;
}

/** Where the transport's scheduler has got to. */
export interface TransportCursor {
  beat: number;
  time: number;
  segmentStart: boolean;
}

export interface TimeAnchor {
  time: number;
  beat: number;
}

export interface WindowPlan {
  windows: ScheduleWindow[];
  cursor: TransportCursor;
  /** Loop wraps that happen inside the planned range (for the playhead). */
  jumps: TimeAnchor[];
}

/**
 * Split the time from cursor.time to horizonTime into schedule windows,
 * wrapping at the loop end. Loop applies while the cursor is before loop.end.
 */
export function planWindows(cursor: TransportCursor, horizonTime: number, tempo: number, loop: LoopRegion | null): WindowPlan {
  const spb = secondsPerBeat(tempo);
  const windows: ScheduleWindow[] = [];
  const jumps: TimeAnchor[] = [];
  let c = { ...cursor };
  for (let guard = 0; c.time < horizonTime - EPS && guard < 10000; guard++) {
    const target = c.beat + (horizonTime - c.time) / spb;
    const looping = loop !== null && loop.enabled && c.beat < loop.end - EPS && loop.end - loop.start > EPS;
    const end = looping ? Math.min(target, loop.end) : target;
    windows.push({ fromBeat: c.beat, toBeat: end, timeAtFrom: c.time, segmentStart: c.segmentStart, cutBeat: looping ? loop.end : Infinity });
    const t = c.time + (end - c.beat) * spb;
    if (looping && end >= loop.end - EPS) {
      c = { beat: loop.start, time: t, segmentStart: true };
      jumps.push({ time: t, beat: loop.start });
    } else {
      c = { beat: end, time: t, segmentStart: false };
    }
  }
  return { windows, cursor: c, jumps };
}

/** Song position at `time`, given anchors sorted by time (first anchor = play start). */
export function beatAtTime(anchors: readonly TimeAnchor[], time: number, tempo: number): number {
  let a = anchors[0];
  if (!a) return 0;
  for (const x of anchors) {
    if (x.time <= time) a = x;
    else break;
  }
  return a.beat + Math.max(0, time - a.time) / secondsPerBeat(tempo);
}

/** Order of events at the same instant: note-offs, then controllers, then note-ons. */
function eventRank(e: NoteEvent): number {
  return e.type === 'noteOff' || e.type === 'allNotesOff' ? 0 : e.type === 'noteOn' ? 2 : 1;
}

/**
 * Group scheduled notes and controller changes into per-track device events.
 * At the same instant, note-offs come first (so repeated notes retrigger),
 * then controllers (so a note starts with the bend already applied), then
 * note-ons. The sort is stable, so chased state precedes stored points.
 */
export function notesToEvents(notes: readonly NoteStart[], controls: readonly ControlStart[] = []): Map<Id, NoteEvent[]> {
  const out = new Map<Id, NoteEvent[]>();
  const listFor = (trackId: Id) => {
    let list = out.get(trackId);
    if (!list) out.set(trackId, (list = []));
    return list;
  };
  for (const c of controls) {
    listFor(c.trackId).push(
      c.kind === 'bend' ? { type: 'pitchBend', time: c.time, semitones: c.semitones } : { type: 'cc', time: c.time, controller: c.controller, value: c.value },
    );
  }
  for (const n of notes) {
    const list = listFor(n.trackId);
    list.push({ type: 'noteOn', time: n.on, pitch: n.pitch, velocity: n.velocity });
    list.push({ type: 'noteOff', time: n.off, pitch: n.pitch });
  }
  for (const list of out.values()) list.sort((a, b) => a.time - b.time || eventRank(a) - eventRank(b));
  return out;
}
