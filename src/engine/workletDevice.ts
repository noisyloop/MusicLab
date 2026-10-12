/**
 * Host side of the Device interface: wraps an AudioWorkletNode running a
 * device processor and speaks the DeviceMessage protocol to it.
 */
import { getDeviceDefinition, listDeviceDefinitions } from '../devices/registry';
import type { DeviceDefinition, DeviceMessage, DeviceProcessorOptions, NoteEvent } from '../devices/types';
import drumkitProcessorUrl from '../devices/drumkit/processor.ts?worker&url';
import subsynthProcessorUrl from '../devices/subsynth/processor.ts?worker&url';

const processorUrls: Record<string, string> = {
  subsynth: subsynthProcessorUrl,
  drumkit: drumkitProcessorUrl,
};

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load every registered device's worklet module into the context (once per context). */
export function loadDeviceModules(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    p = Promise.all(
      listDeviceDefinitions().map((d) => {
        const url = processorUrls[d.type];
        if (!url) throw new Error(`No processor module for device "${d.type}"`);
        return ctx.audioWorklet.addModule(url);
      }),
    ).then(() => undefined);
    loaded.set(ctx, p);
  }
  return p;
}

export class WorkletDevice {
  readonly node: AudioWorkletNode;
  readonly definition: DeviceDefinition;
  private params: Record<string, number>;

  constructor(ctx: BaseAudioContext, type: string, params: Record<string, number>, initialEvents: NoteEvent[] = []) {
    const def = getDeviceDefinition(type);
    if (!def) throw new Error(`Unknown device type "${type}"`);
    this.definition = def;
    this.params = { ...params };
    const processorOptions: DeviceProcessorOptions = { params: this.params, events: initialEvents };
    this.node = new AudioWorkletNode(ctx, def.processorName, {
      numberOfInputs: def.numberOfInputs,
      numberOfOutputs: 1,
      outputChannelCount: [def.outputChannelCount],
      processorOptions,
    });
  }

  private post(msg: DeviceMessage): void {
    this.node.port.postMessage(msg);
  }

  sendEvents(events: NoteEvent[]): void {
    if (events.length > 0) this.post({ type: 'events', events });
  }

  /** Send only the parameters that changed. */
  setParams(values: Record<string, number>): void {
    const changed: Record<string, number> = {};
    let any = false;
    for (const [k, v] of Object.entries(values)) {
      if (this.params[k] !== v) {
        changed[k] = v;
        this.params[k] = v;
        any = true;
      }
    }
    if (any) this.post({ type: 'params', values: changed });
  }

  reset(): void {
    this.post({ type: 'reset' });
  }

  dispose(): void {
    this.reset();
    this.node.disconnect();
    this.node.port.close();
  }
}
