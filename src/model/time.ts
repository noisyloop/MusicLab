/** Beat <-> second conversion and musical-grid helpers. */

export function secondsPerBeat(tempo: number): number {
  return 60 / tempo;
}

export function beatsToSeconds(beats: number, tempo: number): number {
  return beats * secondsPerBeat(tempo);
}

export function secondsToBeats(seconds: number, tempo: number): number {
  return seconds / secondsPerBeat(tempo);
}

/** Snap a beat value to the nearest multiple of `grid` (grid <= 0 disables snapping). */
export function snapBeat(beat: number, grid: number): number {
  if (grid <= 0) return beat;
  return Math.round(beat / grid) * grid;
}

/** Snap down to the grid line at or before `beat`. */
export function snapFloor(beat: number, grid: number): number {
  if (grid <= 0) return beat;
  return Math.floor(beat / grid + 1e-9) * grid;
}

export interface BarBeatTick {
  bar: number;
  beat: number;
  sixteenth: number;
}

/** 1-based bar.beat.sixteenth position like most DAWs display. */
export function beatsToBarBeat(beats: number, beatsPerBar: number): BarBeatTick {
  const b = Math.max(0, beats);
  const bar = Math.floor(b / beatsPerBar + 1e-9);
  const inBar = b - bar * beatsPerBar;
  const beat = Math.floor(inBar + 1e-9);
  const sixteenth = Math.floor((inBar - beat) * 4 + 1e-9);
  return { bar: bar + 1, beat: beat + 1, sixteenth: sixteenth + 1 };
}

export function formatBarBeat(beats: number, beatsPerBar: number): string {
  const p = beatsToBarBeat(beats, beatsPerBar);
  return `${p.bar}.${p.beat}.${p.sixteenth}`;
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, '0')}`;
}

export const MIN_TEMPO = 20;
export const MAX_TEMPO = 400;

export function clampTempo(t: number): number {
  if (!Number.isFinite(t)) return 120;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, t));
}
