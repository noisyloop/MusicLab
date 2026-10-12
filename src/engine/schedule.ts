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

export interface WindowEvents {
  audio: AudioStart[];
  notes: NoteStart[];
}

const EPS = 1e-9;

export interface ScheduleFilter {
  /** Restrict to these clip ids (used to re-chase edited clips during playback). */
  clipIds?: ReadonlySet<Id>;
}

export function scheduleWindow(project: Project, w: ScheduleWindow, filter: ScheduleFilter = {}): WindowEvents {
  const spb = secondsPerBeat(project.tempo);
  const timeOf = (beat: number) => w.timeAtFrom + (beat - w.fromBeat) * spb;
  const out: WindowEvents = { audio: [], notes: [] };
  /** Returns the beat at which an event spanning [start, end) begins in this window, or null. */
  const beginIn = (start: number, end: number): number | null => {
    if (start >= w.fromBeat - EPS && start < w.toBeat - EPS) return Math.max(start, w.fromBeat);
    if (w.segmentStart && start < w.fromBeat && end > w.fromBeat + EPS) return w.fromBeat;
    return null;
  };

  for (const track of project.tracks) {
    if (track.kind === 'audio') {
      for (const clip of track.clips) {
        if (filter.clipIds && !filter.clipIds.has(clip.id)) continue;
        const end = Math.min(clip.start + clip.length, w.cutBeat);
        const begin = beginIn(clip.start, end);
        if (begin === null || begin >= end - EPS) continue;
        const offset = clip.sourceOffset + (begin - clip.start) * spb;
        let duration = (end - begin) * spb;
        const asset = project.assets[clip.assetId];
        if (asset) duration = Math.min(duration, asset.duration - offset);
        if (duration <= EPS) continue;
        out.audio.push({ trackId: track.id, clip, when: timeOf(begin), offset, duration });
      }
    } else {
      for (const clip of track.clips) {
        if (filter.clipIds && !filter.clipIds.has(clip.id)) continue;
        const clipEnd = Math.min(clip.start + clip.length, w.cutBeat);
        for (const n of clip.notes) {
          // Only notes that begin inside the clip's visible content play.
          if (n.start < clip.contentOffset - EPS || n.start >= clip.contentOffset + clip.length - EPS) continue;
          const nb = clip.start + (n.start - clip.contentOffset);
          const ne = Math.min(nb + n.length, clipEnd);
          const begin = beginIn(nb, ne);
          if (begin === null || begin >= ne - EPS) continue;
          out.notes.push({ trackId: track.id, clipId: clip.id, pitch: n.pitch, velocity: n.velocity, on: timeOf(begin), off: timeOf(ne) });
        }
      }
    }
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

/** Group scheduled notes into per-track device events. */
export function notesToEvents(notes: readonly NoteStart[]): Map<Id, NoteEvent[]> {
  const out = new Map<Id, NoteEvent[]>();
  for (const n of notes) {
    let list = out.get(n.trackId);
    if (!list) out.set(n.trackId, (list = []));
    list.push({ type: 'noteOn', time: n.on, pitch: n.pitch, velocity: n.velocity });
    list.push({ type: 'noteOff', time: n.off, pitch: n.pitch });
  }
  // Note-offs sort before note-ons at the same instant so repeated notes retrigger.
  for (const list of out.values()) list.sort((a, b) => a.time - b.time || (a.type === 'noteOff' ? -1 : 1));
  return out;
}
