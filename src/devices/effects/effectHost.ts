/**
 * Shared AudioWorkletProcessor for insert effects. Reads one stereo input
 * (a missing or mono input counts as silence / both channels), runs the
 * effect through an EffectRunner (bypass), applies transport updates at
 * their exact frame, and reports the core's meter value back to the host
 * about every 20 ms. It never stops processing, so delay and reverb tails
 * ring out after clips end and through transport stop.
 */
import type { DeviceMessage, DeviceProcessorOptions, DeviceReply, TransportEvent } from '../types';
import { EffectRunner, type EffectCore } from './runner';

// AudioWorkletGlobalScope declarations (not part of the DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(name: string, ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

const METER_EVERY = 8; // render quanta (~21 ms at 48 kHz)

export function registerEffectProcessor(name: string, createCore: (sampleRate: number, params: Record<string, number>) => EffectCore): void {
  class EffectProcessor extends AudioWorkletProcessor {
    private runner: EffectRunner;
    private queue: TransportEvent[] = [];
    private silence = new Float32Array(128);
    private quanta = 0;

    constructor(options: AudioWorkletNodeOptions) {
      super(options);
      const opts = options.processorOptions as DeviceProcessorOptions | undefined; // set by WorkletDevice
      this.runner = new EffectRunner(createCore(sampleRate, opts?.params ?? {}), sampleRate, opts?.bypass ?? false);
      for (const t of opts?.transport ?? []) this.enqueue(t);
      this.port.onmessage = (ev: MessageEvent<DeviceMessage>) => this.onMessage(ev.data);
    }

    private enqueue(t: TransportEvent): void {
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1]!.time > t.time) i--;
      this.queue.splice(i, 0, t);
    }

    private onMessage(msg: DeviceMessage): void {
      switch (msg.type) {
        case 'params':
          this.runner.core.setParams(msg.values);
          break;
        case 'bypass':
          this.runner.setBypass(msg.bypass);
          break;
        case 'transport':
          this.enqueue(msg.transport);
          break;
        default:
          break;
      }
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const out = outputs[0];
      const outL = out?.[0];
      if (!out || !outL) return true;
      const outR = out[1] ?? outL;
      const frames = outL.length;
      if (this.silence.length < frames) this.silence = new Float32Array(frames);
      const input = inputs[0];
      const inL = input?.[0] ?? this.silence;
      const inR = input?.[1] ?? inL;
      let pos = 0;
      while (this.queue.length > 0) {
        const t = this.queue[0]!;
        const frame = Math.round((t.time - currentTime) * sampleRate);
        if (frame >= frames) break;
        const at = Math.max(pos, Math.min(frames, frame));
        if (at > pos) this.runner.process(inL, inR, outL, outR, pos, at);
        pos = at;
        this.queue.shift();
        // A late update lands now, at the beat it would have reached by now.
        const lateBeats = frame < 0 ? (currentTime - t.time) * (t.bpm / 60) : 0;
        this.runner.core.setTransport(t.beat + lateBeats, t.bpm, t.beatsPerBar);
      }
      if (pos < frames) this.runner.process(inL, inR, outL, outR, pos, frames);
      const meter = this.runner.core.meter;
      if (meter && ++this.quanta % METER_EVERY === 0) {
        const reply: DeviceReply = { type: 'meter', value: this.runner.bypassed ? 0 : meter.call(this.runner.core) };
        this.port.postMessage(reply);
      }
      return true;
    }
  }
  registerProcessor(name, EffectProcessor);
}
