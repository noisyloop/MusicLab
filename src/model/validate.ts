import { getDeviceDefinition } from '../devices/registry';
import { clampParam } from '../devices/types';
import {
  SCHEMA_VERSION,
  type AudioAsset,
  type AudioClip,
  type DeviceState,
  type MidiClip,
  type Note,
  type Project,
  type Track,
} from './types';

/** Thrown when a project file is malformed. */
export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ProjectFormatError(`${path}: expected object`);
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ProjectFormatError(`${path}: expected array`);
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new ProjectFormatError(`${path}: expected string`);
  return v;
}
function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProjectFormatError(`${path}: expected number`);
  if (v < min || v > max) throw new ProjectFormatError(`${path}: ${v} out of range [${min}, ${max}]`);
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new ProjectFormatError(`${path}: expected boolean`);
  return v;
}

function parseNote(v: unknown, path: string): Note {
  const o = obj(v, path);
  return {
    id: str(o.id, `${path}.id`),
    pitch: num(o.pitch, `${path}.pitch`, 0, 127),
    start: num(o.start, `${path}.start`),
    length: num(o.length, `${path}.length`, 1e-6),
    velocity: num(o.velocity, `${path}.velocity`, 0, 1),
  };
}

function parseDevice(v: unknown, path: string): DeviceState {
  const o = obj(v, path);
  const type = str(o.type, `${path}.type`);
  const def = getDeviceDefinition(type);
  if (!def) throw new ProjectFormatError(`${path}.type: unknown device "${type}"`);
  const raw = obj(o.params, `${path}.params`);
  const params: Record<string, number> = {};
  // Unknown params are dropped; missing ones get defaults, so older files keep loading.
  for (const p of def.params) {
    const val = raw[p.id];
    params[p.id] = typeof val === 'number' ? clampParam(p, val) : p.default;
  }
  return { type, params };
}

function parseTrack(v: unknown, path: string): Track {
  const o = obj(v, path);
  const kind = o.kind;
  const base = {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    color: str(o.color, `${path}.color`),
    volume: num(o.volume, `${path}.volume`, 0, 2),
    pan: num(o.pan, `${path}.pan`, -1, 1),
    mute: bool(o.mute, `${path}.mute`),
    solo: bool(o.solo, `${path}.solo`),
  };
  const clips = arr(o.clips, `${path}.clips`);
  if (kind === 'audio') {
    return {
      ...base,
      kind,
      clips: clips.map((c, i): AudioClip => {
        const p = `${path}.clips[${i}]`;
        const co = obj(c, p);
        if (co.kind !== 'audio') throw new ProjectFormatError(`${p}.kind: expected "audio"`);
        return {
          id: str(co.id, `${p}.id`),
          kind: 'audio',
          name: str(co.name, `${p}.name`),
          start: num(co.start, `${p}.start`, 0),
          length: num(co.length, `${p}.length`, 1e-6),
          assetId: str(co.assetId, `${p}.assetId`),
          sourceOffset: num(co.sourceOffset, `${p}.sourceOffset`, 0),
          gain: num(co.gain, `${p}.gain`, 0, 4),
        };
      }),
    };
  }
  if (kind === 'midi') {
    return {
      ...base,
      kind,
      instrument: parseDevice(o.instrument, `${path}.instrument`),
      clips: clips.map((c, i): MidiClip => {
        const p = `${path}.clips[${i}]`;
        const co = obj(c, p);
        if (co.kind !== 'midi') throw new ProjectFormatError(`${p}.kind: expected "midi"`);
        return {
          id: str(co.id, `${p}.id`),
          kind: 'midi',
          name: str(co.name, `${p}.name`),
          start: num(co.start, `${p}.start`, 0),
          length: num(co.length, `${p}.length`, 1e-6),
          contentOffset: num(co.contentOffset, `${p}.contentOffset`),
          notes: arr(co.notes, `${p}.notes`).map((n, j) => parseNote(n, `${p}.notes[${j}]`)),
        };
      }),
    };
  }
  throw new ProjectFormatError(`${path}.kind: expected "audio" or "midi"`);
}

function parseAsset(v: unknown, path: string): AudioAsset {
  const o = obj(v, path);
  return {
    id: str(o.id, `${path}.id`),
    fileName: str(o.fileName, `${path}.fileName`),
    mimeType: str(o.mimeType, `${path}.mimeType`),
    duration: num(o.duration, `${path}.duration`, 0),
    sampleRate: num(o.sampleRate, `${path}.sampleRate`, 1),
    channels: num(o.channels, `${path}.channels`, 1),
  };
}

/**
 * Upgrade older documents to the current schema. There is only one version
 * so far; this is the hook where future migrations go.
 */
export function migrate(doc: Obj): Obj {
  const version = doc.schemaVersion;
  if (typeof version !== 'number') throw new ProjectFormatError('schemaVersion: missing');
  if (version > SCHEMA_VERSION) {
    throw new ProjectFormatError(`This project was saved by a newer MusicLab (schema ${version}); this version supports ${SCHEMA_VERSION}.`);
  }
  return doc;
}

/** Validate untrusted JSON and turn it into a Project. Throws ProjectFormatError. */
export function parseProject(json: unknown): Project {
  const o = migrate(obj(json, 'project'));
  const loop = obj(o.loop, 'loop');
  const master = obj(o.master, 'master');
  const assetsRaw = obj(o.assets, 'assets');
  const assets: Record<string, AudioAsset> = {};
  for (const [k, v] of Object.entries(assetsRaw)) {
    const a = parseAsset(v, `assets.${k}`);
    if (a.id !== k) throw new ProjectFormatError(`assets.${k}: id mismatch`);
    assets[k] = a;
  }
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    name: str(o.name, 'name'),
    tempo: num(o.tempo, 'tempo', 20, 400),
    beatsPerBar: num(o.beatsPerBar, 'beatsPerBar', 1, 32),
    loop: {
      enabled: bool(loop.enabled, 'loop.enabled'),
      start: num(loop.start, 'loop.start', 0),
      end: num(loop.end, 'loop.end', 0),
    },
    master: { volume: num(master.volume, 'master.volume', 0, 2) },
    tracks: arr(o.tracks, 'tracks').map((t, i) => parseTrack(t, `tracks[${i}]`)),
    assets,
  };
  if (project.loop.end <= project.loop.start) throw new ProjectFormatError('loop: end must be after start');
  for (const t of project.tracks) {
    if (t.kind !== 'audio') continue;
    for (const c of t.clips) {
      if (!assets[c.assetId]) throw new ProjectFormatError(`clip ${c.id}: references missing asset ${c.assetId}`);
    }
  }
  return project;
}
