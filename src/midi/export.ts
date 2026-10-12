/**
 * Project -> format-1 Standard MIDI File: a tempo track plus one track per
 * MIDI track (audio tracks are skipped). Which notes, bends and controller
 * changes are written is decided by collectMidi(), the same code playback
 * uses, so the file contains exactly what plays in the chosen range.
 */
import { drumkitDefinition } from '../devices/drumkit/definition';
import { collectMidi } from '../engine/schedule';
import type { Id, MidiTrack, Project } from '../model/types';
import { beatsToTicks, microsFromBpm, writeSmf, type Smf, type SmfEvent } from './smf';
import { DRUM_CHANNEL } from './import';

/** Ticks per quarter note written to exported files. */
export const EXPORT_PPQ = 960;

export interface MidiExportRange {
  startBeat: number;
  endBeat: number;
}

/** Largest positive 14-bit bend step, as a fraction of the range. */
const MAX_UP = 8191 / 8192;

/**
 * Pick the bend range (whole semitones, written as RPN 0) for a track's bends:
 * among the ranges that reach every bend, the one with the smallest
 * 14-bit quantization error, preferring the smallest. Bends that came from a
 * MIDI file come back with their original range, so they survive exactly.
 */
export function bendRangeFor(semitones: readonly number[]): number {
  const up = Math.max(0, ...semitones);
  const down = Math.max(0, ...semitones.map((s) => -s));
  let best = 96;
  let bestErr = Infinity;
  for (let r = 2; r <= 96; r++) {
    if (up > r * MAX_UP + 1e-9 || down > r + 1e-9) continue;
    let err = 0;
    for (const s of semitones) {
      const steps = (s / r) * 8192;
      err = Math.max(err, (Math.abs(steps - Math.round(steps)) * r) / 8192);
    }
    if (err < bestErr - 1e-12) {
      best = r;
      bestErr = err;
      if (err < 1e-9) break;
    }
  }
  return best;
}

function rank(e: SmfEvent): number {
  return e.type === 'trackName' ? -1 : e.type === 'noteOff' ? 0 : e.type === 'noteOn' ? 2 : 1;
}

/** Channels for melodic tracks: every channel except the drum channel, reused cyclically. */
function assignChannels(tracks: MidiTrack[]): Map<Id, number> {
  const melodic = Array.from({ length: 16 }, (_, i) => i).filter((c) => c !== DRUM_CHANNEL);
  const out = new Map<Id, number>();
  let next = 0;
  for (const t of tracks) {
    if (t.instrument.type === drumkitDefinition.type) out.set(t.id, DRUM_CHANNEL);
    else out.set(t.id, melodic[next++ % melodic.length]!);
  }
  return out;
}

export function projectToSmf(project: Project, range: MidiExportRange, ppq = EXPORT_PPQ): Smf {
  const { startBeat, endBeat } = range;
  const tick = (beat: number) => beatsToTicks(beat - startBeat, ppq);
  const endTick = tick(endBeat);
  const tempoTrack: SmfEvent[] = [
    { type: 'trackName', tick: 0, name: project.name },
    { type: 'timeSignature', tick: 0, numerator: project.beatsPerBar, denominator: 4 },
    { type: 'tempo', tick: 0, microsPerQuarter: microsFromBpm(project.tempo) },
    { type: 'endOfTrack', tick: endTick },
  ];

  const midiTracks = project.tracks.filter((t): t is MidiTrack => t.kind === 'midi');
  const channels = assignChannels(midiTracks);
  const events = collectMidi(project, { fromBeat: startBeat, toBeat: endBeat, segmentStart: true, cutBeat: endBeat });

  const tracks = midiTracks.map((track) => {
    const channel = channels.get(track.id)!;
    const out: SmfEvent[] = [{ type: 'trackName', tick: 0, name: track.name }];
    const controls = events.controls.filter((c) => c.trackId === track.id);
    const bendValues = controls.flatMap((c) => (c.kind === 'bend' ? [c.semitones] : []));
    const bendRange = bendRangeFor(bendValues);
    if (bendValues.length > 0) {
      // RPN 0 (pitch-bend sensitivity), then the null RPN.
      for (const [controller, value] of [[101, 0], [100, 0], [6, bendRange], [38, 0], [101, 127], [100, 127]] as const) {
        out.push({ type: 'controlChange', tick: 0, channel, controller, value });
      }
    }
    // Chased state is only written when it changes what the receiver already
    // has, so a file doesn't gain a redundant bend 0 at every clip start.
    let bend = 0;
    const ccState = new Map<number, number>();
    for (const c of controls) {
      if (c.kind === 'bend') {
        if (c.chase && c.semitones === bend) continue;
        bend = c.semitones;
        const value = 8192 + Math.round((c.semitones / bendRange) * 8192);
        out.push({ type: 'pitchBend', tick: tick(c.beat), channel, value: Math.min(16383, Math.max(0, value)) });
      } else {
        if (c.chase && ccState.get(c.controller) === c.value) continue;
        ccState.set(c.controller, c.value);
        out.push({ type: 'controlChange', tick: tick(c.beat), channel, controller: c.controller, value: c.value });
      }
    }
    for (const n of events.notes) {
      if (n.trackId !== track.id) continue;
      const velocity = Math.min(127, Math.max(1, Math.round(n.velocity * 127)));
      out.push({ type: 'noteOn', tick: tick(n.onBeat), channel, pitch: n.pitch, velocity });
      out.push({ type: 'noteOff', tick: tick(n.offBeat), channel, pitch: n.pitch, velocity: 64 });
    }
    // Stable sort: same-tick order is note-offs, controllers, note-ons.
    out.sort((a, b) => a.tick - b.tick || rank(a) - rank(b));
    const last = out.length > 0 ? out[out.length - 1]!.tick : 0;
    out.push({ type: 'endOfTrack', tick: Math.max(endTick, last) });
    return { events: out };
  });

  return { format: 1, ppq, tracks: [{ events: tempoTrack }, ...tracks] };
}

export function exportMidiFile(project: Project, range: MidiExportRange): Uint8Array {
  return writeSmf(projectToSmf(project, range));
}
