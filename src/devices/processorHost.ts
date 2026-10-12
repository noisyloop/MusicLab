/**
 * Shared AudioWorkletProcessor for instruments. Speaks the generic
 * DeviceMessage protocol: timed events are queued and applied at their exact
 * sample frame inside each 128-frame render quantum, so live playback and
 * offline rendering feed the core identical event sequences.
 *
 * Each device's processor module calls registerInstrumentProcessor() once.
 */
import type { DeviceMessage, DeviceProcessorOptions, InstrumentCore, NoteEvent } from './types';

// AudioWorkletGlobalScope declarations (not part of the DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(name: string, ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

export function insertSorted(queue: NoteEvent[], e: NoteEvent): void {
  let i = queue.length;
  while (i > 0 && queue[i - 1]!.time > e.time) i--;
  queue.splice(i, 0, e);
}

export function applyEvent(core: InstrumentCore, e: NoteEvent): void {
  switch (e.type) {
    case 'noteOn':
      core.noteOn(e.pitch, e.velocity);
      break;
    case 'noteOff':
      core.noteOff(e.pitch);
      break;
    case 'allNotesOff':
      core.allNotesOff(false);
      break;
    case 'pitchBend':
      core.pitchBend(e.semitones);
      break;
    case 'cc':
      core.controlChange(e.controller, e.value);
      break;
  }
}

export function registerInstrumentProcessor(name: string, createCore: (sampleRate: number, params: Record<string, number>) => InstrumentCore): void {
  class InstrumentProcessor extends AudioWorkletProcessor {
    private core: InstrumentCore;
    private queue: NoteEvent[] = [];

    constructor(options: AudioWorkletNodeOptions) {
      super(options);
      const opts = options.processorOptions as DeviceProcessorOptions | undefined; // set by WorkletDevice
      this.core = createCore(sampleRate, opts?.params ?? {});
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
        applyEvent(this.core, e);
      }
      if (pos < frames) this.core.render(left, right, pos, frames);
      return true;
    }
  }
  registerProcessor(name, InstrumentProcessor);
}
