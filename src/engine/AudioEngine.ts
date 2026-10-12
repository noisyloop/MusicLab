/**
 * The audio engine: takes a Project plus a transport position and makes
 * sound. It owns every Web Audio node; the UI only talks to it through this
 * class's methods (via the app controller).
 *
 * Graph per track:
 *   sources/instrument -> input -> volume -> pan -> mute/solo -> meter split
 *                                                      \-> master -> destination
 */
import type { NoteEvent } from '../devices/types';
import { isTrackAudible } from '../model/project';
import { secondsPerBeat } from '../model/time';
import type { Clip, Id, Project, Track } from '../model/types';
import {
  beatAtTime,
  notesToEvents,
  planWindows,
  scheduleWindow,
  type AudioStart,
  type ScheduleWindow,
  type TimeAnchor,
  type TransportCursor,
} from './schedule';
import { loadDeviceModules, WorkletDevice } from './workletDevice';

export type BufferLookup = (assetId: Id) => AudioBuffer | undefined;

/** Stereo peak levels (linear, 0..1+). */
export type StereoLevel = [number, number];

export interface MeterSnapshot {
  master: StereoLevel;
  tracks: Record<Id, StereoLevel>;
}

interface Meter {
  split: ChannelSplitterNode;
  left: AnalyserNode;
  right: AnalyserNode;
}

interface Channel {
  track: Track;
  input: GainNode;
  volume: GainNode;
  pan: StereoPannerNode;
  gate: GainNode;
  meter: Meter;
  device?: WorkletDevice;
}

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  clipId: Id;
  trackId: Id;
}

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const START_LATENCY_S = 0.05;
const RAMP_S = 0.012;

export interface EngineOptions {
  /** Note events known up front, by track id (offline rendering). */
  initialNotes?: Map<Id, NoteEvent[]>;
  /** Live engines run a scheduler timer; offline engines don't. */
  live: boolean;
}

export class AudioEngine {
  readonly ctx: BaseAudioContext;
  private readonly getBuffer: BufferLookup;
  private readonly options: EngineOptions;
  private readonly master: GainNode;
  private readonly masterMeter: Meter;
  private readonly channels = new Map<Id, Channel>();
  private readonly active = new Set<ActiveSource>();
  private project: Project | null = null;
  private meterBuf = new Float32Array(1024);

  private playing = false;
  private cursor: TransportCursor = { beat: 0, time: 0, segmentStart: true };
  private anchors: TimeAnchor[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(ctx: BaseAudioContext, getBuffer: BufferLookup, options: EngineOptions) {
    this.ctx = ctx;
    this.getBuffer = getBuffer;
    this.options = options;
    this.master = ctx.createGain();
    this.masterMeter = this.createMeter();
    this.master.connect(this.masterMeter.split);
    this.master.connect(ctx.destination);
  }

  static async create(ctx: BaseAudioContext, getBuffer: BufferLookup, options: EngineOptions): Promise<AudioEngine> {
    await loadDeviceModules(ctx);
    return new AudioEngine(ctx, getBuffer, options);
  }

  private createMeter(): Meter {
    const split = this.ctx.createChannelSplitter(2);
    const left = this.ctx.createAnalyser();
    const right = this.ctx.createAnalyser();
    left.fftSize = right.fftSize = 1024;
    split.connect(left, 0);
    split.connect(right, 1);
    return { split, left, right };
  }

  private setParam(param: AudioParam, value: number): void {
    if (this.options.live) param.setTargetAtTime(value, this.ctx.currentTime, RAMP_S / 3);
    else param.value = value;
  }

  // -------------------------------------------------------------------------
  // project sync

  /** Bring the graph in line with `project`. Cheap when little changed. */
  setProject(project: Project): void {
    const prev = this.project;
    this.project = project;
    if (prev === project) return;
    this.setParam(this.master.gain, project.master.volume);

    const live = new Set(project.tracks.map((t) => t.id));
    for (const [id, ch] of this.channels) {
      if (!live.has(id)) this.disposeChannel(id, ch);
    }
    for (const track of project.tracks) {
      let ch = this.channels.get(track.id);
      if (!ch || ch.track.kind !== track.kind) {
        if (ch) this.disposeChannel(track.id, ch);
        ch = this.createChannel(track);
      }
      this.updateChannel(ch, track, project);
    }

    if (this.playing && prev) {
      if (prev.tempo !== project.tempo) {
        // Everything already scheduled is at the wrong time: restart in place.
        this.play(this.positionBeats());
        return;
      }
      this.resyncChangedClips(prev, project);
    }
  }

  private createChannel(track: Track): Channel {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const volume = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const gate = ctx.createGain();
    const meter = this.createMeter();
    input.connect(volume).connect(pan).connect(gate);
    gate.connect(meter.split);
    gate.connect(this.master);
    const ch: Channel = { track, input, volume, pan, gate, meter };
    if (track.kind === 'midi') {
      ch.device = new WorkletDevice(ctx, track.instrument.type, track.instrument.params, this.options.initialNotes?.get(track.id) ?? []);
      ch.device.node.connect(input);
    }
    volume.gain.value = track.volume;
    pan.pan.value = track.pan;
    this.channels.set(track.id, ch);
    return ch;
  }

  private updateChannel(ch: Channel, track: Track, project: Project): void {
    ch.track = track;
    this.setParam(ch.volume.gain, track.volume);
    this.setParam(ch.pan.pan, track.pan);
    this.setParam(ch.gate.gain, isTrackAudible(project, track) ? 1 : 0);
    if (track.kind === 'midi' && ch.device) {
      if (ch.device.definition.type !== track.instrument.type) {
        ch.device.dispose();
        ch.device = new WorkletDevice(this.ctx, track.instrument.type, track.instrument.params);
        ch.device.node.connect(ch.input);
      } else {
        ch.device.setParams(track.instrument.params);
      }
    }
  }

  private disposeChannel(id: Id, ch: Channel): void {
    for (const a of this.active) if (a.trackId === id) this.stopSource(a, this.ctx.currentTime);
    ch.device?.dispose();
    ch.gate.disconnect();
    ch.input.disconnect();
    this.channels.delete(id);
  }

  // -------------------------------------------------------------------------
  // transport

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Current song position in beats (what the playhead shows). */
  positionBeats(): number {
    if (!this.project) return 0;
    if (!this.playing) return this.cursor.beat;
    return beatAtTime(this.anchors, this.ctx.currentTime, this.project.tempo);
  }

  play(fromBeat: number): void {
    if (!this.project) return;
    this.stopAllSound();
    const t0 = this.ctx.currentTime + START_LATENCY_S;
    this.cursor = { beat: Math.max(0, fromBeat), time: t0, segmentStart: true };
    this.anchors = [{ time: t0, beat: this.cursor.beat }];
    this.playing = true;
    this.tick();
    if (this.options.live && this.timer === null) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Stop playback; position stays where it was. */
  stop(): void {
    const pos = this.positionBeats();
    this.playing = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stopAllSound();
    this.cursor = { beat: pos, time: 0, segmentStart: true };
  }

  /** Set position while stopped (while playing, restarts from there). */
  seek(beat: number): void {
    if (this.playing) this.play(beat);
    else this.cursor = { beat: Math.max(0, beat), time: 0, segmentStart: true };
  }

  private tick(): void {
    const project = this.project;
    if (!this.playing || !project) return;
    const now = this.ctx.currentTime;
    const plan = planWindows(this.cursor, now + LOOKAHEAD_S, project.tempo, project.loop);
    this.cursor = plan.cursor;
    this.anchors.push(...plan.jumps);
    // Keep only the anchor in effect now plus future ones.
    while (this.anchors.length > 1 && this.anchors[1]!.time <= now) this.anchors.shift();
    for (const w of plan.windows) this.runWindow(project, w);
  }

  private runWindow(project: Project, w: ScheduleWindow, clipIds?: ReadonlySet<Id>): void {
    const events = scheduleWindow(project, w, { clipIds });
    this.startAudio(events.audio);
    for (const [trackId, list] of notesToEvents(events.notes)) this.channels.get(trackId)?.device?.sendEvents(list);
  }

  /** Create buffer sources for scheduled audio-clip segments (live and offline). */
  startAudio(starts: readonly AudioStart[]): void {
    for (const s of starts) {
      const ch = this.channels.get(s.trackId);
      const buffer = this.getBuffer(s.clip.assetId);
      if (!ch || !buffer) continue;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = s.clip.gain;
      source.connect(gain).connect(ch.input);
      const when = Math.max(s.when, this.ctx.currentTime);
      // If we're late, skip ahead in the source so it stays in time.
      const late = when - s.when;
      const offset = s.offset + late;
      const duration = s.duration - late;
      if (duration <= 0 || offset >= buffer.duration) continue;
      source.start(when, offset, duration);
      const entry: ActiveSource = { source, gain, clipId: s.clip.id, trackId: s.trackId };
      this.active.add(entry);
      source.onended = () => {
        this.active.delete(entry);
        gain.disconnect();
      };
    }
  }

  private stopSource(a: ActiveSource, at: number): void {
    if (this.options.live) {
      a.gain.gain.setTargetAtTime(0, at, 0.004);
      try {
        a.source.stop(at + 0.03);
      } catch {
        // stop() throws if the source was never started; nothing to do.
      }
    } else {
      a.source.stop();
    }
    this.active.delete(a);
  }

  private stopAllSound(): void {
    const now = this.ctx.currentTime;
    for (const a of [...this.active]) this.stopSource(a, now);
    for (const ch of this.channels.values()) ch.device?.reset();
  }

  /**
   * After an edit during playback, stop sounds belonging to clips that changed
   * and re-schedule those clips from "now" up to where the scheduler has got to.
   */
  private resyncChangedClips(prev: Project, next: Project): void {
    const prevClips = new Map<Id, Clip>();
    for (const t of prev.tracks) for (const c of t.clips as Clip[]) prevClips.set(c.id, c);
    const changed = new Set<Id>();
    const midiTracksToReset = new Set<Id>();
    const nextIds = new Set<Id>();
    for (const t of next.tracks) {
      for (const c of t.clips as Clip[]) nextIds.add(c.id);
      const prevTrack = prev.tracks.find((x) => x.id === t.id);
      if (prevTrack?.clips === t.clips) continue;
      // Notes for a track all go to one device, so a MIDI edit re-chases the whole track.
      if (t.kind === 'midi') midiTracksToReset.add(t.id);
      for (const c of t.clips as Clip[]) if (prevClips.get(c.id) !== c) changed.add(c.id);
    }
    for (const id of prevClips.keys()) if (!nextIds.has(id)) changed.add(id);
    if (changed.size === 0 && midiTracksToReset.size === 0) return;

    const t0 = this.ctx.currentTime + 0.01;
    for (const a of [...this.active]) if (changed.has(a.clipId)) this.stopSource(a, t0);
    const rechase = new Set<Id>(changed);
    for (const trackId of midiTracksToReset) {
      const t = next.tracks.find((x) => x.id === trackId);
      this.channels.get(trackId)?.device?.reset();
      if (t) for (const c of t.clips) rechase.add(c.id);
    }
    for (const w of this.windowsSince(t0, next)) this.runWindow(next, w, rechase);
  }

  /** Windows covering [t0, cursor.time): what has already been scheduled from t0 on. */
  private windowsSince(t0: number, project: Project): ScheduleWindow[] {
    const spb = secondsPerBeat(project.tempo);
    const cutFor = (from: number) => (project.loop.enabled && from < project.loop.end ? project.loop.end : Infinity);
    const out: ScheduleWindow[] = [];
    let beat = beatAtTime(this.anchors, t0, project.tempo);
    let time = t0;
    for (const a of this.anchors) {
      if (a.time <= t0) continue;
      out.push({ fromBeat: beat, toBeat: beat + (a.time - time) / spb, timeAtFrom: time, segmentStart: true, cutBeat: cutFor(beat) });
      beat = a.beat;
      time = a.time;
    }
    if (this.cursor.time > time) out.push({ fromBeat: beat, toBeat: this.cursor.beat, timeAtFrom: time, segmentStart: true, cutBeat: cutFor(beat) });
    return out.filter((w) => w.toBeat > w.fromBeat);
  }

  // -------------------------------------------------------------------------
  // live input & metering

  /** Play a note immediately on a MIDI track (computer keyboard, piano-roll preview). */
  liveNote(trackId: Id, pitch: number, velocity: number, on: boolean): void {
    const dev = this.channels.get(trackId)?.device;
    if (!dev) return;
    dev.sendEvents([on ? { type: 'noteOn', time: 0, pitch, velocity } : { type: 'noteOff', time: 0, pitch }]);
  }

  private readMeter(m: Meter): StereoLevel {
    const buf = this.meterBuf;
    const peak = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]!);
        if (v > p) p = v;
      }
      return p;
    };
    return [peak(m.left), peak(m.right)];
  }

  meters(): MeterSnapshot {
    const tracks: Record<Id, StereoLevel> = {};
    for (const [id, ch] of this.channels) tracks[id] = this.readMeter(ch.meter);
    return { master: this.readMeter(this.masterMeter), tracks };
  }

  dispose(): void {
    this.stop();
    for (const [id, ch] of this.channels) this.disposeChannel(id, ch);
    this.master.disconnect();
  }
}
