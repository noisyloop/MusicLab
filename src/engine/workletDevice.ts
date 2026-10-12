/**
 * Host side of the Device interface: wraps an AudioWorkletNode running a
 * device processor and speaks the DeviceMessage protocol to it.
 */
import { getDeviceDefinition, listDeviceDefinitions } from '../devices/registry';
import type { DeviceDefinition, DeviceMessage, DeviceProcessorOptions, DeviceReply, NoteEvent, TransportEvent } from '../devices/types';
import drumkitProcessorUrl from '../devices/drumkit/processor.ts?worker&url';
import compressorProcessorUrl from '../devices/effects/compressor/processor.ts?worker&url';
import delayProcessorUrl from '../devices/effects/delay/processor.ts?worker&url';
import eq3ProcessorUrl from '../devices/effects/eq3/processor.ts?worker&url';
import filterProcessorUrl from '../devices/effects/filter/processor.ts?worker&url';
import reverbProcessorUrl from '../devices/effects/reverb/processor.ts?worker&url';
import saturatorProcessorUrl from '../devices/effects/saturator/processor.ts?worker&url';
import subsynthProcessorUrl from '../devices/subsynth/processor.ts?worker&url';

const processorUrls: Record<string, string> = {
  subsynth: subsynthProcessorUrl,
  drumkit: drumkitProcessorUrl,
  eq3: eq3ProcessorUrl,
  compressor: compressorProcessorUrl,
  saturator: saturatorProcessorUrl,
  filter: filterProcessorUrl,
  delay: delayProcessorUrl,
  reverb: reverbProcessorUrl,
};

export interface WorkletDeviceOptions {
  /** Instruments: events known up front (offline rendering). */
  initialEvents?: NoteEvent[];
  /** Effects: start bypassed (no crossfade). */
  bypass?: boolean;
  /** Effects: transport updates known up front. */
  transport?: TransportEvent[];
}

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
  private bypass: boolean;
  /** Latest meter value the processor reported (effects with a meter). */
  meterValue = 0;

  constructor(ctx: BaseAudioContext, type: string, params: Record<string, number>, options: WorkletDeviceOptions = {}) {
    const def = getDeviceDefinition(type);
    if (!def) throw new Error(`Unknown device type "${type}"`);
    this.definition = def;
    this.params = { ...params };
    this.bypass = options.bypass ?? false;
    const processorOptions: DeviceProcessorOptions = { params: this.params, events: options.initialEvents ?? [], bypass: this.bypass, transport: options.transport ?? [] };
    this.node = new AudioWorkletNode(ctx, def.processorName, {
      numberOfInputs: def.numberOfInputs,
      numberOfOutputs: 1,
      outputChannelCount: [def.outputChannelCount],
      // Effects always see stereo: mono sources are up-mixed to both channels.
      ...(def.numberOfInputs > 0 ? { channelCount: 2, channelCountMode: 'explicit' as const, channelInterpretation: 'speakers' as const } : {}),
      processorOptions,
    });
    this.node.port.onmessage = (ev: MessageEvent<DeviceReply>) => {
      if (ev.data?.type === 'meter') this.meterValue = ev.data.value;
    };
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

  /** Effects: crossfade into or out of bypass. */
  setBypass(bypass: boolean): void {
    if (bypass === this.bypass) return;
    this.bypass = bypass;
    this.post({ type: 'bypass', bypass });
  }

  /** Effects: tempo/position update. */
  sendTransport(transport: TransportEvent): void {
    this.post({ type: 'transport', transport });
  }

  dispose(): void {
    this.reset();
    this.node.disconnect();
    this.node.port.close();
  }
}
