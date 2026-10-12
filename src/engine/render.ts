/**
 * Offline mixdown through the same engine code as live playback: the same
 * scheduleWindow() math decides what plays, and the same AudioEngine graph,
 * device processors, and startAudio() path produce the sound.
 */
import { secondsPerBeat } from '../model/time';
import type { Project } from '../model/types';
import { AudioEngine, type BufferLookup } from './AudioEngine';
import { notesToEvents, scheduleWindow } from './schedule';

export interface RenderRange {
  startBeat: number;
  endBeat: number;
  /** Extra seconds rendered after endBeat for release/reverb tails. */
  tailSeconds: number;
}

export async function renderProject(project: Project, getBuffer: BufferLookup, range: RenderRange, sampleRate: number): Promise<AudioBuffer> {
  const songSeconds = (range.endBeat - range.startBeat) * secondsPerBeat(project.tempo);
  const frames = Math.max(1, Math.ceil((songSeconds + range.tailSeconds) * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate });
  // One window covering the whole range, starting at context time 0.
  const events = scheduleWindow(project, {
    fromBeat: range.startBeat,
    toBeat: range.endBeat,
    timeAtFrom: 0,
    segmentStart: true,
    cutBeat: range.endBeat,
  });
  const engine = await AudioEngine.create(ctx, getBuffer, { live: false, initialNotes: notesToEvents(events.notes) });
  engine.setProject(project);
  engine.startAudio(events.audio);
  return ctx.startRendering();
}
