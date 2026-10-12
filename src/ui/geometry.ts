/** Pure coordinate math for the arrangement canvas. */
import type { Clip, Project, Track } from '../model/types';

export interface TimelineView {
  pxPerBeat: number;
  scrollBeat: number;
  scrollY: number;
}

export interface Layout {
  rulerHeight: number;
  trackHeight: number;
}

export function beatToX(beat: number, v: TimelineView): number {
  return (beat - v.scrollBeat) * v.pxPerBeat;
}

export function xToBeat(x: number, v: TimelineView): number {
  return x / v.pxPerBeat + v.scrollBeat;
}

export function trackTop(index: number, v: TimelineView, l: Layout): number {
  return l.rulerHeight + index * l.trackHeight - v.scrollY;
}

/** Track index under y, or -1 for the ruler / empty space below the last track. */
export function trackIndexAtY(y: number, trackCount: number, v: TimelineView, l: Layout): number {
  if (y < l.rulerHeight) return -1;
  const i = Math.floor((y - l.rulerHeight + v.scrollY) / l.trackHeight);
  return i >= 0 && i < trackCount ? i : -1;
}

export type ClipZone = 'body' | 'start' | 'end';

export interface ClipHit {
  track: Track;
  trackIndex: number;
  clip: Clip;
  zone: ClipZone;
}

export const EDGE_PX = 6;

/** Find the clip under (x, y). Later clips in a track are drawn on top, so they win. */
export function hitTestClip(project: Project, x: number, y: number, v: TimelineView, l: Layout): ClipHit | null {
  const ti = trackIndexAtY(y, project.tracks.length, v, l);
  if (ti < 0) return null;
  const track = project.tracks[ti]!;
  const clips = track.clips as Clip[];
  for (let i = clips.length - 1; i >= 0; i--) {
    const clip = clips[i]!;
    const x0 = beatToX(clip.start, v);
    const x1 = beatToX(clip.start + clip.length, v);
    if (x < x0 || x > x1) continue;
    const edge = Math.min(EDGE_PX, (x1 - x0) / 4);
    const zone: ClipZone = x - x0 <= edge ? 'start' : x1 - x <= edge ? 'end' : 'body';
    return { track, trackIndex: ti, clip, zone };
  }
  return null;
}

/** Clips intersecting a rectangle (marquee selection). */
export function clipsInRect(project: Project, x0: number, y0: number, x1: number, y1: number, v: TimelineView, l: Layout): string[] {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
  const out: string[] = [];
  project.tracks.forEach((t, i) => {
    const top = trackTop(i, v, l);
    if (top + l.trackHeight < ay || top > by) return;
    for (const c of t.clips as Clip[]) {
      const cx0 = beatToX(c.start, v);
      const cx1 = beatToX(c.start + c.length, v);
      if (cx1 >= ax && cx0 <= bx) out.push(c.id);
    }
  });
  return out;
}

/** Zoom keeping the beat under `anchorX` fixed. */
export function zoomAround(v: TimelineView, factor: number, anchorX: number, min = 2, max = 400): TimelineView {
  const beat = xToBeat(anchorX, v);
  const pxPerBeat = Math.min(max, Math.max(min, v.pxPerBeat * factor));
  return { ...v, pxPerBeat, scrollBeat: Math.max(0, beat - anchorX / pxPerBeat) };
}

/** Gain (linear) <-> fader position (0..1), with +6 dB at the top. */
export function gainToFader(gain: number): number {
  if (gain <= 0) return 0;
  const db = 20 * Math.log10(gain);
  if (db <= -60) return 0;
  return Math.min(1, Math.max(0, 1 - Math.sqrt((6 - db) / 66)));
}

export function faderToGain(pos: number): number {
  if (pos <= 0) return 0;
  const db = 6 - 66 * (1 - pos) ** 2;
  return Math.min(2, Math.pow(10, db / 20));
}

export function formatDb(gain: number): string {
  if (gain <= 0.000001) return '-inf';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
}
