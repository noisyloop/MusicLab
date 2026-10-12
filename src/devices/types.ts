/**
 * The Device interface: a small, self-contained contract for instruments and
 * effects. A device is described by plain data (parameter descriptors) plus
 * an AudioWorklet processor that speaks the message protocol below. Any
 * future plugin format can be adapted by providing a DeviceDefinition and a
 * processor (or a wrapper processor) that understands DeviceMessage.
 */

export type ParamScale = 'linear' | 'log';

export interface ContinuousParam {
  kind: 'continuous';
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  scale: ParamScale;
  unit?: string;
  /** Optional group label for the device panel. */
  group: string;
}

export interface EnumParam {
  kind: 'enum';
  id: string;
  name: string;
  /** Values are the option indices 0..options.length-1. */
  options: string[];
  default: number;
  group: string;
}

export type ParamDescriptor = ContinuousParam | EnumParam;

export interface DeviceDefinition {
  /** Stable type id stored in projects, e.g. "subsynth". */
  type: string;
  name: string;
  kind: 'instrument' | 'effect';
  params: ParamDescriptor[];
  /** Name passed to registerProcessor() in the worklet module. */
  processorName: string;
  numberOfInputs: number;
  outputChannelCount: number;
}

/** A timed note/control event. `time` is in AudioContext seconds. */
export type NoteEvent =
  | { type: 'noteOn'; time: number; pitch: number; velocity: number }
  | { type: 'noteOff'; time: number; pitch: number }
  | { type: 'allNotesOff'; time: number };

/** Messages sent from the host to a device processor over its MessagePort. */
export type DeviceMessage =
  | { type: 'events'; events: NoteEvent[] }
  | { type: 'params'; values: Record<string, number> }
  /** Drop queued (future) events and release all voices immediately. */
  | { type: 'reset' };

/** Options passed to the processor constructor (processorOptions). */
export interface DeviceProcessorOptions {
  params: Record<string, number>;
  /** Events known up front (used by offline rendering). */
  events: NoteEvent[];
}

export function defaultParams(def: DeviceDefinition): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.id] = p.default;
  return out;
}

export function clampParam(p: ParamDescriptor, value: number): number {
  if (!Number.isFinite(value)) return p.default;
  if (p.kind === 'enum') return Math.min(p.options.length - 1, Math.max(0, Math.round(value)));
  return Math.min(p.max, Math.max(p.min, value));
}

/** Map a 0..1 control position to a parameter value (respecting log scale). */
export function normToValue(p: ContinuousParam, norm: number): number {
  const n = Math.min(1, Math.max(0, norm));
  if (p.scale === 'log' && p.min > 0) return p.min * Math.pow(p.max / p.min, n);
  return p.min + (p.max - p.min) * n;
}

export function valueToNorm(p: ContinuousParam, value: number): number {
  if (p.scale === 'log' && p.min > 0) return Math.log(value / p.min) / Math.log(p.max / p.min);
  return (value - p.min) / (p.max - p.min);
}
