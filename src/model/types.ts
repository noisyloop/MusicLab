/**
 * Plain-data project model. Everything here is JSON-serializable and treated
 * as immutable: edits produce new objects (see commands.ts).
 *
 * All musical time is in beats (quarter notes). Conversion to seconds only
 * happens inside the audio engine (see time.ts helpers it uses).
 */

export const SCHEMA_VERSION = 3;

export type Id = string;

export interface Project {
  schemaVersion: typeof SCHEMA_VERSION;
  name: string;
  /** Beats per minute. */
  tempo: number;
  /** Beats per bar (the beat unit is always a quarter note). */
  beatsPerBar: number;
  loop: LoopRegion;
  master: MasterBus;
  tracks: Track[];
  /** Metadata for audio files embedded in the project, keyed by asset id. */
  assets: Record<Id, AudioAsset>;
}

export interface LoopRegion {
  enabled: boolean;
  /** Beats. */
  start: number;
  /** Beats, always > start. */
  end: number;
}

export interface MasterBus {
  /** Linear gain, 0..2. */
  volume: number;
  /** Master insert chain (schema 3+), processed before the master volume. */
  effects: EffectSlot[];
}

export interface AudioAsset {
  id: Id;
  /** Original file name, e.g. "kick.wav". */
  fileName: string;
  mimeType: string;
  /** Decoded duration in seconds. */
  duration: number;
  sampleRate: number;
  channels: number;
}

interface TrackBase {
  id: Id;
  name: string;
  color: string;
  /** Linear gain, 0..2 (1 = 0 dB). */
  volume: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Insert effects (schema 3+), in signal order, before volume and pan. */
  effects: EffectSlot[];
}

export interface AudioTrack extends TrackBase {
  kind: 'audio';
  clips: AudioClip[];
}

export interface MidiTrack extends TrackBase {
  kind: 'midi';
  clips: MidiClip[];
  instrument: DeviceState;
}

export type Track = AudioTrack | MidiTrack;
export type TrackKind = Track['kind'];

interface ClipBase {
  id: Id;
  name: string;
  /** Timeline position in beats. */
  start: number;
  /** Length on the timeline in beats (> 0). */
  length: number;
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  assetId: Id;
  /**
   * Where playback starts inside the source file, in seconds. Audio is never
   * time-stretched, so the source offset is naturally a time, not a beat value.
   */
  sourceOffset: number;
  /** Linear clip gain. */
  gain: number;
}

export interface MidiClip extends ClipBase {
  kind: 'midi';
  /** Beat inside the clip's note content that lines up with `start`. */
  contentOffset: number;
  notes: Note[];
  /**
   * Pitch-bend curve (schema 2+), sorted by beat. Each point holds until the
   * next one. Beats are in the same content coordinates as notes.
   */
  bends?: PitchBendPoint[];
  /** Controller changes (schema 2+), sorted by beat, content coordinates. */
  ccs?: ControlChangePoint[];
}

export type Clip = AudioClip | MidiClip;

export interface Note {
  id: Id;
  /** MIDI note number 0..127. */
  pitch: number;
  /** Beats, relative to the clip content origin. */
  start: number;
  /** Beats (> 0). */
  length: number;
  /** 0..1. */
  velocity: number;
}

export interface PitchBendPoint {
  /** Beats, relative to the clip content origin. */
  beat: number;
  /** Bend amount in semitones (the musical intent; instruments clamp to their own range). */
  semitones: number;
}

export interface ControlChangePoint {
  /** Beats, relative to the clip content origin. */
  beat: number;
  /** MIDI controller number 0..127. */
  controller: number;
  /** MIDI controller value 0..127. */
  value: number;
}

export interface DeviceState {
  /** Device type id, e.g. "subsynth". */
  type: string;
  params: Record<string, number>;
}

/** One insert effect in a chain: an effect device's state plus its own id and bypass flag. */
export interface EffectSlot extends DeviceState {
  id: Id;
  /** When true the effect passes audio through untouched. */
  bypass: boolean;
}

/** Addresses the master chain in effect commands; any other value is a track id. */
export const MASTER_CHAIN = 'master';
export type ChainId = Id;
