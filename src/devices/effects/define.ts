import { defaultParams, type DeviceDefinition, type ParamDescriptor } from '../types';
import type { EffectCore } from './runner';

/** Build an insert-effect definition: one stereo input, one stereo output. */
export function effectDefinition(d: { type: string; name: string; params: ParamDescriptor[]; tailSeconds?: DeviceDefinition['tailSeconds'] }): DeviceDefinition {
  return {
    type: d.type,
    name: d.name,
    kind: 'effect',
    processorName: `musiclab-fx-${d.type}`,
    numberOfInputs: 1,
    outputChannelCount: 2,
    params: d.params,
    tailSeconds: d.tailSeconds,
  };
}

/**
 * Common plumbing for effect cores: parameter storage (defaults, then
 * overrides; unknown or non-finite values ignored) and transport state.
 * Subclasses recompute derived coefficients in update().
 */
export abstract class BaseEffect implements EffectCore {
  protected readonly p: Record<string, number>;
  protected bpm = 120;
  protected beatsPerBar = 4;
  protected beat = 0;

  constructor(protected readonly sampleRate: number, def: DeviceDefinition, params: Record<string, number>) {
    this.p = defaultParams(def);
    this.assign(params);
  }

  private assign(values: Record<string, number>): void {
    for (const [k, v] of Object.entries(values)) if (k in this.p && Number.isFinite(v)) this.p[k] = v;
  }

  setParams(values: Record<string, number>): void {
    this.assign(values);
    this.update();
  }

  setTransport(beat: number, bpm: number, beatsPerBar: number): void {
    this.beat = beat;
    if (Number.isFinite(bpm) && bpm > 0) this.bpm = bpm;
    if (Number.isFinite(beatsPerBar) && beatsPerBar > 0) this.beatsPerBar = beatsPerBar;
    this.update();
  }

  /** Recompute coefficients from params and transport. Called after any change. */
  protected abstract update(): void;
  abstract process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void;
  abstract reset(): void;
}
