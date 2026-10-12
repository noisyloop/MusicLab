/**
 * Standard MIDI File -> project model. parseSmf() does the byte-level work;
 * this module turns tick-based events into notes, bends and controller
 * points in beats, and builds the single Command that adds the tracks.
 */
import { drumkitDefinition } from '../devices/drumkit/definition';
import { defaultParams } from '../devices/types';
import { addClip, addTrack, batch, setBeatsPerBar, setTempo, type Command } from '../model/commands';
import { newId } from '../model/ids';
import { allClips, createTrack, TRACK_COLORS } from '../model/project';
import type { ControlChangePoint, Id, MidiClip, MidiTrack, Note, PitchBendPoint, Project } from '../model/types';
import { bpmFromMicros, parseSmf, SmfError, ticksToBeats, type Smf, type SmfEvent } from './smf';

/** MIDI channel 10 (0-based 9) is the General MIDI drum channel. */
export const DRUM_CHANNEL = 9;
/** General MIDI default pitch-bend range, used until a file sets RPN 0. */
export const DEFAULT_BEND_RANGE = 2;
/** Controllers that carry RPN/NRPN plumbing. They are consumed (bend range), not stored. */
const PARAMETER_CCS = new Set([6, 38, 96, 97, 98, 99, 100, 101]);

export interface ImportedTrack {
  name: string;
  /** Main channel (0-based): the channel most of its notes are on. */
  channel: number;
  drum: boolean;
  notes: Note[];
  bends: PitchBendPoint[];
  ccs: ControlChangePoint[];
  /** Beat where the last event ends. */
  endBeat: number;
}

export interface ImportedMidi {
  /** BPM of the first tempo event, if any. */
  tempo: number | null;
  /** Beats per bar from the first time signature, if it is a whole number of quarter notes. */
  beatsPerBar: number | null;
  tracks: ImportedTrack[];
}

type ChannelEvent = Extract<SmfEvent, { channel: number }>;

interface Group {
  name: string | null;
  events: SmfEvent[];
  /** Last tick of the SMF track the group came from (its end-of-track). */
  endTick: number;
}

const lastTick = (events: SmfEvent[]) => events.reduce((m, e) => Math.max(m, e.tick), 0);

function isChannelEvent(e: SmfEvent): e is ChannelEvent {
  return 'channel' in e;
}

function firstEvent<T extends SmfEvent['type']>(smf: Smf, type: T): Extract<SmfEvent, { type: T }> | undefined {
  let best: Extract<SmfEvent, { type: T }> | undefined;
  for (const t of smf.tracks) {
    for (const e of t.events) {
      if (e.type !== type) continue;
      if (!best || e.tick < best.tick) best = e as Extract<SmfEvent, { type: T }>;
      break; // events within a track are in tick order
    }
  }
  return best;
}

function trackName(events: SmfEvent[]): string | null {
  const e = events.find((x) => x.type === 'trackName');
  const name = e?.type === 'trackName' ? e.name.replace(/\0/g, '').trim() : '';
  return name || null;
}

/**
 * Format 1 and 2: one group per SMF track. Format 0: the single track is
 * split by channel (in channel order).
 */
function groups(smf: Smf): Group[] {
  if (smf.format !== 0) return smf.tracks.map((t) => ({ name: trackName(t.events), events: t.events, endTick: lastTick(t.events) }));
  const out: Group[] = [];
  for (const t of smf.tracks) {
    const name = trackName(t.events);
    const byChannel = new Map<number, SmfEvent[]>();
    for (const e of t.events) {
      if (!isChannelEvent(e)) continue;
      let list = byChannel.get(e.channel);
      if (!list) byChannel.set(e.channel, (list = []));
      list.push(e);
    }
    const channels = [...byChannel.keys()].sort((a, b) => a - b);
    const notesOn = (ch: number) => byChannel.get(ch)!.some((e) => e.type === 'noteOn');
    const multi = channels.filter(notesOn).length > 1;
    for (const ch of channels) {
      out.push({ name: name && multi ? `${name} (Ch ${ch + 1})` : name, events: byChannel.get(ch)!, endTick: lastTick(t.events) });
    }
  }
  return out;
}

interface Pending {
  tick: number;
  velocity: number;
}

function convertGroup(group: Group, ppq: number): Omit<ImportedTrack, 'name'> & { name: string | null } {
  const notes: Note[] = [];
  const bends: PitchBendPoint[] = [];
  const ccs: ControlChangePoint[] = [];
  const pending = new Map<number, Pending[]>(); // key: channel * 128 + pitch
  const bendRange = new Array<number>(16).fill(DEFAULT_BEND_RANGE);
  const bendCents = new Array<number>(16).fill(0);
  const rpn = new Array<number>(16).fill(-1); // selected RPN (msb*128+lsb), -1 = none / NRPN
  const rpnMsb = new Array<number>(16).fill(127);
  const rpnLsb = new Array<number>(16).fill(127);
  const channelNotes = new Array<number>(16).fill(0);
  const beat = (tick: number) => ticksToBeats(tick, ppq);

  const close = (key: number, endTick: number, minTicks: number) => {
    const queue = pending.get(key);
    const on = queue?.shift();
    if (!on) return;
    notes.push({
      id: newId('n'),
      pitch: key % 128,
      start: beat(on.tick),
      length: beat(Math.max(endTick - on.tick, minTicks)),
      velocity: on.velocity / 127,
    });
  };

  for (const e of group.events) {
    if (!isChannelEvent(e)) continue;
    const ch = e.channel;
    switch (e.type) {
      case 'noteOn': {
        const key = ch * 128 + e.pitch;
        let queue = pending.get(key);
        if (!queue) pending.set(key, (queue = []));
        queue.push({ tick: e.tick, velocity: e.velocity });
        channelNotes[ch]!++;
        break;
      }
      case 'noteOff':
        // Overlapping notes of the same pitch pair first-in, first-out.
        close(ch * 128 + e.pitch, e.tick, 1);
        break;
      case 'controlChange': {
        const c = e.controller;
        if (c === 101 || c === 100) {
          if (c === 101) rpnMsb[ch] = e.value;
          else rpnLsb[ch] = e.value;
          rpn[ch] = rpnMsb[ch] === 127 && rpnLsb[ch] === 127 ? -1 : rpnMsb[ch]! * 128 + rpnLsb[ch]!;
        } else if (c === 99 || c === 98) {
          rpn[ch] = -1; // NRPN selected: data entry no longer targets an RPN
        } else if (c === 6 && rpn[ch] === 0) {
          bendRange[ch] = e.value;
          bendCents[ch] = 0;
        } else if (c === 38 && rpn[ch] === 0) {
          bendCents[ch] = e.value;
        }
        if (!PARAMETER_CCS.has(c)) ccs.push({ beat: beat(e.tick), controller: c, value: e.value });
        break;
      }
      case 'pitchBend': {
        const range = bendRange[ch]! + bendCents[ch]! / 100;
        bends.push({ beat: beat(e.tick), semitones: ((e.value - 8192) / 8192) * range });
        break;
      }
      default:
        // Program changes and aftertouch are dropped.
        break;
    }
  }
  // Notes still held at the end of the track last until it ends (at least a sixteenth).
  for (const [key, queue] of pending) while (queue.length > 0) close(key, group.endTick, Math.max(1, Math.round(ppq / 4)));

  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  let channel = 0;
  for (let c = 1; c < 16; c++) if (channelNotes[c]! > channelNotes[channel]!) channel = c;
  let endBeat = 0;
  for (const n of notes) endBeat = Math.max(endBeat, n.start + n.length);
  for (const b of bends) endBeat = Math.max(endBeat, b.beat);
  for (const c of ccs) endBeat = Math.max(endBeat, c.beat);
  return { name: group.name, channel, drum: channel === DRUM_CHANNEL, notes, bends, ccs, endBeat };
}

/** Convert a parsed SMF into tracks of notes/bends/CCs in beats. Tracks without notes are skipped. */
export function smfToTracks(smf: Smf): ImportedMidi {
  const tempoEvent = firstEvent(smf, 'tempo');
  const ts = firstEvent(smf, 'timeSignature');
  const bpb = ts ? (ts.numerator * 4) / ts.denominator : null;
  const tracks: ImportedTrack[] = [];
  for (const g of groups(smf)) {
    const t = convertGroup(g, smf.ppq);
    if (t.notes.length === 0) continue;
    tracks.push({ ...t, name: t.name ?? `MIDI ${tracks.length + 1}` });
  }
  return {
    tempo: tempoEvent ? bpmFromMicros(tempoEvent.microsPerQuarter) : null,
    beatsPerBar: bpb !== null && Number.isInteger(bpb) && bpb >= 1 && bpb <= 32 ? bpb : null,
    tracks,
  };
}

/** Parse SMF bytes into tracks. Throws SmfError for malformed files or files without notes. */
export function readMidiFile(bytes: Uint8Array): ImportedMidi {
  const imported = smfToTracks(parseSmf(bytes));
  if (imported.tracks.length === 0) throw new SmfError('The file contains no notes.');
  return imported;
}

export interface MidiImportPlan {
  command: Command;
  trackIds: Id[];
  clipIds: Id[];
}

/**
 * Build the single undoable Command that imports `imported` into `project`:
 * one MIDI track per imported track (DrumKit for channel 10, SubSynth
 * otherwise), each with one clip starting at `beat`. An empty project (no
 * clips) adopts the file's first tempo and time signature; otherwise the
 * project's own tempo stays and the file's tempo map is ignored.
 */
export function planMidiImport(project: Project, imported: ImportedMidi, opts: { beat: number; insertIndex?: number; label: string }): MidiImportPlan {
  const cmds: Command[] = [];
  const empty = allClips(project).length === 0;
  let beatsPerBar = project.beatsPerBar;
  if (empty && imported.tempo !== null) cmds.push(setTempo(imported.tempo));
  if (empty && imported.beatsPerBar !== null) {
    cmds.push(setBeatsPerBar(imported.beatsPerBar));
    beatsPerBar = imported.beatsPerBar;
  }
  let insertAt = opts.insertIndex ?? project.tracks.length;
  let colorIdx = project.tracks.length;
  const trackIds: Id[] = [];
  const clipIds: Id[] = [];
  const start = Math.max(0, opts.beat);
  for (const t of imported.tracks) {
    const track = createTrack('midi', t.name, TRACK_COLORS[colorIdx++ % TRACK_COLORS.length]!) as MidiTrack;
    const withInstrument: MidiTrack = t.drum ? { ...track, instrument: { type: drumkitDefinition.type, params: defaultParams(drumkitDefinition) } } : track;
    const bars = Math.max(1, Math.ceil(t.endBeat / beatsPerBar - 1e-9));
    const clip: MidiClip = {
      id: newId('c'),
      kind: 'midi',
      name: t.name,
      start,
      length: bars * beatsPerBar,
      contentOffset: 0,
      notes: t.notes,
    };
    if (t.bends.length > 0) clip.bends = t.bends;
    if (t.ccs.length > 0) clip.ccs = t.ccs;
    cmds.push(addTrack(withInstrument, insertAt++), addClip(withInstrument.id, clip));
    trackIds.push(withInstrument.id);
    clipIds.push(clip.id);
  }
  return { command: batch(opts.label, cmds), trackIds, clipIds };
}
