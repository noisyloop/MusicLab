/**
 * AudioWorkletProcessor for SubSynth. Speaks the generic DeviceMessage
 * protocol: timed note events are queued and applied at their exact sample
 * frame inside each 128-frame render quantum.
 */
import type { DeviceMessage, DeviceProcessorOptions, NoteEvent } from '../types';
import { subsynthDefinition } from './definition';
import { SynthCore } from './synthCore';

// AudioWorkletGlobalScope declarations (not part of the DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(name: string, ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

function insertSorted(queue: NoteEvent[], e: NoteEvent): void {
  let i = queue.length;
  while (i > 0 && queue[i - 1]!.time > e.time) i--;
  queue.splice(i, 0, e);
}

class SubSynthProcessor extends AudioWorkletProcessor {
  private core: SynthCore;
  private queue: NoteEvent[] = [];

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const opts = options.processorOptions as DeviceProcessorOptions | undefined; // set by WorkletDevice
    this.core = new SynthCore(sampleRate, opts?.params ?? {});
    for (const e of opts?.events ?? []) insertSorted(this.queue, e);
    this.port.onmessage = (ev: MessageEvent<DeviceMessage>) => this.onMessage(ev.data);
  }

  private onMessage(msg: DeviceMessage): void {
    switch (msg.type) {
      case 'events':
        for (const e of msg.events) insertSorted(this.queue, e);
        break;
      case 'params':
        this.core.setParams(msg.values);
        break;
      case 'reset':
        this.queue = [];
        this.core.allNotesOff(true);
        break;
    }
  }

  private apply(e: NoteEvent): void {
    if (e.type === 'noteOn') this.core.noteOn(e.pitch, e.velocity);
    else if (e.type === 'noteOff') this.core.noteOff(e.pitch);
    else this.core.allNotesOff(false);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out?.[0];
    if (!out || !left) return true;
    const right = out[1] ?? left;
    const frames = left.length;
    let pos = 0;
    while (this.queue.length > 0) {
      const e = this.queue[0]!;
      const frame = Math.round((e.time - currentTime) * sampleRate);
      if (frame >= frames) break;
      const at = Math.max(pos, Math.min(frames, frame));
      if (at > pos) this.core.render(left, right, pos, at);
      pos = at;
      this.queue.shift();
      this.apply(e);
    }
    if (pos < frames) this.core.render(left, right, pos, frames);
    return true;
  }
}

registerProcessor(subsynthDefinition.processorName, SubSynthProcessor);
