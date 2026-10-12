import { useCallback, useRef, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { adaptiveGrid, app, effectiveGrid, RULER_HEIGHT, TRACK_HEIGHT } from '../app/controller';
import { moveClips, setLoop, trimClipEnd, trimClipStart, type ClipMove, type Command } from '../model/commands';
import { findClip } from '../model/project';
import { secondsPerBeat, snapBeat, snapFloor } from '../model/time';
import type { AudioClip, Clip, Id, MidiClip, Project, Track } from '../model/types';
import { PROJECT_EXTENSION } from '../persistence/projectFile';
import { peakRange } from '../util/peaks';
import { beatToX, clipsInRect, hitTestClip, trackIndexAtY, trackTop, xToBeat, zoomAround, type Layout, type TimelineView } from './geometry';
import { shade, theme, withAlpha } from './theme';
import { useCanvas, type CanvasSize } from './useCanvas';

const layout: Layout = { rulerHeight: RULER_HEIGHT, trackHeight: TRACK_HEIGHT };
const LOOP_STRIP = 13;
const DRAG_THRESHOLD = 3;

type Drag =
  | { kind: 'pending-clip'; clipId: Id; x: number; y: number; toggled: boolean }
  | { kind: 'move'; clipIds: Id[]; anchorClipId: Id; startBeat: number; startTrack: number; command: Command | null }
  | { kind: 'trim'; clipId: Id; edge: 'start' | 'end'; command: Command | null }
  | { kind: 'scrub' }
  | { kind: 'loop'; mode: 'create' | 'move' | 'start' | 'end'; startBeat: number; x: number; moved: boolean; command: Command | null }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: Id[] }
  | { kind: 'pending-empty'; x: number; y: number; additive: boolean; trackId: Id | null };

/** Page the view when the playhead leaves it (Ableton-style follow). */
function followPlayhead(width: number): void {
  const s = app.state;
  if (!s.playing || !s.view.followPlayhead || width <= 0) return;
  const pos = app.position.get().beat;
  const visible = width / s.view.pxPerBeat;
  if (pos > s.view.scrollBeat + visible * 0.92 || pos < s.view.scrollBeat) {
    app.setView({ scrollBeat: Math.max(0, pos - visible * 0.05) });
  }
}

function grid(): number {
  return effectiveGrid(app.state.view);
}

function snap(beat: number, bypass: boolean): number {
  return bypass ? beat : snapBeat(beat, grid());
}

export function Timeline() {
  const drag = useRef<Drag | null>(null);
  const dropHint = useRef<{ beat: number; trackIndex: number } | null>(null);
  const widthRef = useRef(0);

  const draw = useCallback((ctx: CanvasRenderingContext2D, size: CanvasSize) => {
    widthRef.current = size.width;
    const d = drag.current;
    const preview = d && (d.kind === 'move' || d.kind === 'trim' || d.kind === 'loop') && d.command ? d.command.apply(app.project) : null;
    drawTimeline(ctx, size, preview ?? app.project, d, dropHint.current);
  }, []);

  const subscribe = useCallback((invalidate: () => void) => {
    const a = app.store.subscribe(invalidate);
    const b = app.position.subscribe(() => {
      invalidate();
      followPlayhead(widthRef.current);
    });
    return () => {
      a();
      b();
    };
  }, []);

  const { canvasRef, sizeRef, invalidate } = useCanvas(draw, subscribe);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const view = (): TimelineView => app.state.view;

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    const project = app.project;
    const v = view();
    app.setFocus('arrangement');
    e.currentTarget.setPointerCapture(e.pointerId);

    if (y < RULER_HEIGHT) {
      const beat = xToBeat(x, v);
      if (y < LOOP_STRIP) {
        const loop = project.loop;
        const lx0 = beatToX(loop.start, v);
        const lx1 = beatToX(loop.end, v);
        // With the loop on: edges resize, inside moves, outside draws a new region.
        // With it off, any drag draws a new region; a click inside toggles it.
        let mode: 'create' | 'move' | 'start' | 'end' = 'create';
        if (loop.enabled && Math.abs(x - lx0) <= 5) mode = 'start';
        else if (loop.enabled && Math.abs(x - lx1) <= 5) mode = 'end';
        else if (x > lx0 && x < lx1) mode = 'move';
        drag.current = { kind: 'loop', mode, startBeat: beat, x, moved: false, command: null };
      } else {
        app.seek(snap(beat, e.altKey));
        drag.current = { kind: 'scrub' };
      }
      invalidate();
      return;
    }

    const hit = hitTestClip(project, x, y, v, layout);
    if (hit) {
      app.selectTrack(hit.track.id);
      const sel = app.state.selectedClipIds;
      const isSelected = sel.includes(hit.clip.id);
      let toggled = false;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        app.selectClips(isSelected ? sel.filter((id) => id !== hit.clip.id) : [...sel, hit.clip.id]);
        toggled = true;
      } else if (!isSelected) {
        app.selectClips([hit.clip.id]);
      }
      if (hit.zone !== 'body' && !toggled) {
        app.selectClips([hit.clip.id]);
        drag.current = { kind: 'trim', clipId: hit.clip.id, edge: hit.zone, command: null };
      } else {
        drag.current = { kind: 'pending-clip', clipId: hit.clip.id, x, y, toggled };
      }
      return;
    }

    const ti = trackIndexAtY(y, project.tracks.length, v, layout);
    const trackId = ti >= 0 ? project.tracks[ti]!.id : null;
    if (trackId) app.selectTrack(trackId);
    drag.current = { kind: 'pending-empty', x, y, additive: e.shiftKey || e.ctrlKey || e.metaKey, trackId };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const { x, y } = local(e);
    const v = view();
    const d = drag.current;
    const project = app.project;
    if (!d) {
      updateCursor(x, y);
      return;
    }
    const beat = xToBeat(x, v);
    switch (d.kind) {
      case 'pending-clip': {
        if (Math.hypot(x - d.x, y - d.y) < DRAG_THRESHOLD) return;
        if (d.toggled && !app.state.selectedClipIds.includes(d.clipId)) {
          drag.current = null;
          return;
        }
        const ti = trackIndexAtY(d.y, project.tracks.length, v, layout);
        drag.current = { kind: 'move', clipIds: app.state.selectedClipIds, anchorClipId: d.clipId, startBeat: xToBeat(d.x, v), startTrack: ti, command: null };
        onPointerMove(e);
        return;
      }
      case 'move': {
        const anchor = findClip(project, d.anchorClipId)?.clip;
        if (!anchor) return;
        let delta = snap(anchor.start + beat - d.startBeat, e.altKey) - anchor.start;
        const ti = trackIndexAtY(Math.max(RULER_HEIGHT, y), project.tracks.length, v, layout);
        let dTrack = ti < 0 ? 0 : ti - d.startTrack;
        const locs = d.clipIds.map((id) => findClip(project, id)).filter((l) => l !== undefined);
        const minStart = Math.min(...locs.map((l) => l.clip.start));
        if (minStart + delta < 0) delta = -minStart;
        const valid = locs.every((l) => project.tracks[l.trackIndex + dTrack]?.kind === l.clip.kind);
        if (!valid) dTrack = 0;
        const moves: ClipMove[] = locs.map((l) => ({ clipId: l.clip.id, trackId: project.tracks[l.trackIndex + dTrack]!.id, start: l.clip.start + delta }));
        d.command = moveClips(moves);
        break;
      }
      case 'trim': {
        const b = snap(beat, e.altKey);
        const loc = findClip(project, d.clipId);
        if (!loc) return;
        d.command = d.edge === 'start' ? trimClipStart(d.clipId, b) : trimClipEnd(d.clipId, b - loc.clip.start);
        break;
      }
      case 'scrub':
        app.seek(snap(Math.max(0, beat), e.altKey));
        break;
      case 'loop': {
        if (!d.moved && Math.abs(x - d.x) < DRAG_THRESHOLD) return;
        d.moved = true;
        const loop = project.loop;
        const b = snap(beat, e.altKey);
        const g = grid() || 1 / 16;
        if (d.mode === 'create' || (d.mode === 'move' && !loop.enabled)) {
          const a = snap(d.startBeat, e.altKey);
          const [s, en] = a < b ? [a, b] : [b, a];
          d.command = setLoop({ enabled: true, start: s, end: Math.max(en, s + g) });
        } else if (d.mode === 'start') {
          d.command = setLoop({ start: Math.min(b, loop.end - g) });
        } else if (d.mode === 'end') {
          d.command = setLoop({ end: Math.max(b, loop.start + g) });
        } else {
          const len = loop.end - loop.start;
          const s = Math.max(0, snap(loop.start + beat - d.startBeat, e.altKey));
          d.command = setLoop({ start: s, end: s + len });
        }
        break;
      }
      case 'pending-empty': {
        if (Math.hypot(x - d.x, y - d.y) < DRAG_THRESHOLD) return;
        drag.current = { kind: 'marquee', x0: d.x, y0: d.y, x1: x, y1: y, base: d.additive ? app.state.selectedClipIds : [] };
        onPointerMove(e);
        return;
      }
      case 'marquee': {
        d.x1 = x;
        d.y1 = y;
        const ids = clipsInRect(project, d.x0, d.y0, d.x1, d.y1, v, layout);
        app.selectClips([...new Set([...d.base, ...ids])]);
        break;
      }
    }
    invalidate();
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    switch (d.kind) {
      case 'pending-clip':
        if (!d.toggled) app.selectClips([d.clipId]);
        break;
      case 'move':
      case 'trim':
        if (d.command) app.execute(d.command);
        break;
      case 'loop':
        if (d.command) app.execute(d.command);
        else if (!d.moved && d.mode === 'move') app.toggleLoop();
        break;
      case 'pending-empty':
        if (!d.additive) app.selectClips([]);
        if (!app.state.playing) app.seek(snap(xToBeat(d.x, view()), e.altKey));
        break;
      default:
        break;
    }
    app.endGesture();
    invalidate();
  }

  function onDoubleClick(e: React.MouseEvent<HTMLCanvasElement>): void {
    const { x, y } = local(e);
    const project = app.project;
    const v = view();
    if (y < RULER_HEIGHT) return;
    const hit = hitTestClip(project, x, y, v, layout);
    if (hit) {
      if (hit.clip.kind === 'midi') app.openEditor(hit.clip.id);
      return;
    }
    const ti = trackIndexAtY(y, project.tracks.length, v, layout);
    const track = project.tracks[ti];
    if (track?.kind === 'midi') {
      app.createMidiClip(track.id, snapFloor(xToBeat(x, v), Math.max(1, grid())));
    }
  }

  function updateCursor(x: number, y: number): void {
    const canvas = canvasRef.current!;
    const v = view();
    let cursor = 'default';
    if (y < RULER_HEIGHT) {
      if (y < LOOP_STRIP) {
        const lx0 = beatToX(app.project.loop.start, v);
        const lx1 = beatToX(app.project.loop.end, v);
        const on = app.project.loop.enabled;
        cursor = on && (Math.abs(x - lx0) <= 5 || Math.abs(x - lx1) <= 5) ? 'ew-resize' : on && x > lx0 && x < lx1 ? 'grab' : 'crosshair';
      } else cursor = 'text';
    } else {
      const hit = hitTestClip(app.project, x, y, v, layout);
      if (hit) cursor = hit.zone === 'body' ? 'grab' : 'ew-resize';
    }
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>): void {
    const v = view();
    if (e.ctrlKey || e.metaKey) {
      const { x } = local(e);
      const z = zoomAround(v, Math.exp(-e.deltaY * 0.002), x);
      app.setView({ pxPerBeat: z.pxPerBeat, scrollBeat: z.scrollBeat });
      return;
    }
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    const dy = e.shiftKey ? 0 : e.deltaY;
    app.trackViewportHeight = sizeRef.current.height - RULER_HEIGHT;
    if (dx) app.setView({ scrollBeat: v.scrollBeat + dx / v.pxPerBeat });
    if (dy) app.scrollTracksBy(dy);
  }

  // ---- file drop ----
  function onDragOver(e: DragEvent<HTMLCanvasElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { x, y } = local(e);
    const v = view();
    dropHint.current = { beat: Math.max(0, snap(xToBeat(x, v), e.altKey)), trackIndex: trackIndexAtY(y, app.project.tracks.length, v, layout) };
    invalidate();
  }

  function onDragLeave(): void {
    dropHint.current = null;
    invalidate();
  }

  function onDrop(e: DragEvent<HTMLCanvasElement>): void {
    e.preventDefault();
    e.stopPropagation();
    const hint = dropHint.current;
    dropHint.current = null;
    invalidate();
    const files = [...e.dataTransfer.files];
    const projectFile = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXTENSION));
    if (projectFile) {
      void app.openProjectFile(projectFile, null);
      return;
    }
    const { x, y } = local(e);
    const v = view();
    const beat = hint?.beat ?? Math.max(0, snap(xToBeat(x, v), false));
    const ti = trackIndexAtY(y, app.project.tracks.length, v, layout);
    const trackId = ti >= 0 ? app.project.tracks[ti]!.id : null;
    void app.importAudioFiles(files, trackId, beat);
  }

  return (
    <div className="timeline">
      <canvas
        ref={canvasRef}
        data-testid="timeline"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// drawing

function drawTimeline(ctx: CanvasRenderingContext2D, size: CanvasSize, project: Project, d: Drag | null, dropHint: { beat: number; trackIndex: number } | null): void {
  const s = app.state;
  const v = s.view;
  const { width, height } = size;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);

  // lanes
  project.tracks.forEach((t, i) => {
    const top = trackTop(i, v, layout);
    if (top > height || top + TRACK_HEIGHT < RULER_HEIGHT) return;
    ctx.fillStyle = t.id === s.selectedTrackId ? theme.laneSelected : i % 2 ? theme.laneAlt : theme.lane;
    ctx.fillRect(0, top, width, TRACK_HEIGHT - 1);
  });

  drawGrid(ctx, width, height, project, v);

  // loop overlay on lanes
  const loop = project.loop;
  if (loop.enabled) {
    const x0 = beatToX(loop.start, v);
    const x1 = beatToX(loop.end, v);
    ctx.fillStyle = theme.loopOverlay;
    ctx.fillRect(x0, RULER_HEIGHT, x1 - x0, height - RULER_HEIGHT);
  }

  // drop target highlight
  if (dropHint) {
    const x = beatToX(dropHint.beat, v);
    ctx.fillStyle = theme.drop;
    if (dropHint.trackIndex >= 0) ctx.fillRect(x, trackTop(dropHint.trackIndex, v, layout), width - x, TRACK_HEIGHT - 1);
    else {
      const top = trackTop(project.tracks.length, v, layout);
      ctx.fillRect(x, top, width - x, TRACK_HEIGHT - 1);
    }
    ctx.fillStyle = '#7cc8ff';
    ctx.fillRect(x - 1, RULER_HEIGHT, 2, height);
  }

  // clips
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
  ctx.clip();
  const selected = new Set(s.selectedClipIds);
  project.tracks.forEach((t, i) => {
    const top = trackTop(i, v, layout);
    if (top > height || top + TRACK_HEIGHT < RULER_HEIGHT) return;
    for (const c of t.clips as Clip[]) drawClip(ctx, project, t, c, top, v, width, selected.has(c.id));
  });
  if (d?.kind === 'marquee') {
    ctx.fillStyle = theme.marquee;
    ctx.strokeStyle = theme.marqueeBorder;
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }
  ctx.restore();

  drawRuler(ctx, width, project, v);

  // playhead
  const px = beatToX(app.position.get().beat, v);
  if (px >= -1 && px <= width + 1) {
    ctx.fillStyle = theme.playhead;
    ctx.fillRect(Math.round(px) - 0.5, LOOP_STRIP, 1, height);
    ctx.beginPath();
    ctx.moveTo(px - 5, LOOP_STRIP);
    ctx.lineTo(px + 5, LOOP_STRIP);
    ctx.lineTo(px, LOOP_STRIP + 7);
    ctx.fill();
  }

  if (project.tracks.length === 0) {
    ctx.fillStyle = theme.textDim;
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Drop audio files here, or add a track with the buttons on the left.', width / 2, RULER_HEIGHT + 80);
    ctx.textAlign = 'left';
  }
}

function gridSteps(pxPerBeat: number, beatsPerBar: number): { minor: number; showBeats: boolean } {
  const minor = adaptiveGrid(pxPerBeat, 10);
  return { minor: Math.min(minor, beatsPerBar * 64), showBeats: pxPerBeat >= 6 };
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, project: Project, v: TimelineView): void {
  const bpb = project.beatsPerBar;
  const { minor } = gridSteps(v.pxPerBeat, bpb);
  const first = Math.floor(v.scrollBeat / minor) * minor;
  const last = xToBeat(width, v);
  for (let b = first; b <= last; b += minor) {
    const x = Math.round(beatToX(b, v)) + 0.5;
    const isBar = Math.abs(b / bpb - Math.round(b / bpb)) < 1e-6;
    const isBeat = Math.abs(b - Math.round(b)) < 1e-6;
    ctx.strokeStyle = isBar ? theme.gridBar : isBeat ? theme.gridBeat : theme.gridSub;
    ctx.beginPath();
    ctx.moveTo(x, RULER_HEIGHT);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawRuler(ctx: CanvasRenderingContext2D, width: number, project: Project, v: TimelineView): void {
  ctx.fillStyle = theme.ruler;
  ctx.fillRect(0, 0, width, RULER_HEIGHT);
  ctx.fillStyle = '#25282e';
  ctx.fillRect(0, 0, width, LOOP_STRIP);
  // loop brace
  const loop = project.loop;
  const lx0 = beatToX(loop.start, v);
  const lx1 = beatToX(loop.end, v);
  ctx.fillStyle = loop.enabled ? theme.loop : theme.loopDim;
  ctx.fillRect(lx0, 2, lx1 - lx0, LOOP_STRIP - 4);
  // bar numbers
  const bpb = project.beatsPerBar;
  const barPx = bpb * v.pxPerBeat;
  let barStep = 1;
  while (barStep * barPx < 44) barStep *= 2;
  const firstBar = Math.floor(v.scrollBeat / bpb / barStep) * barStep;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let bar = firstBar; ; bar += barStep) {
    const x = beatToX(bar * bpb, v);
    if (x > width) break;
    ctx.fillStyle = theme.rulerText;
    ctx.fillRect(Math.round(x), LOOP_STRIP, 1, RULER_HEIGHT - LOOP_STRIP);
    ctx.fillText(String(bar + 1), x + 4, LOOP_STRIP + (RULER_HEIGHT - LOOP_STRIP) / 2);
    // beat ticks
    if (barStep === 1 && v.pxPerBeat >= 8) {
      for (let b = 1; b < bpb; b++) {
        const bx = Math.round(beatToX(bar * bpb + b, v));
        ctx.fillRect(bx, RULER_HEIGHT - 6, 1, 6);
      }
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
}

function drawClip(ctx: CanvasRenderingContext2D, project: Project, track: Track, c: Clip, top: number, v: TimelineView, width: number, selected: boolean): void {
  const x0 = beatToX(c.start, v);
  const x1 = beatToX(c.start + c.length, v);
  if (x1 < 0 || x0 > width) return;
  const y = top + 1;
  const h = TRACK_HEIGHT - 3;
  const w = Math.max(2, x1 - x0);
  const headerH = 14;
  ctx.fillStyle = shade(track.color, -0.55);
  ctx.fillRect(x0, y, w, h);
  ctx.fillStyle = selected ? shade(track.color, 0.2) : track.color;
  ctx.fillRect(x0, y, w, headerH);
  // name
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y, w, h);
  ctx.clip();
  ctx.fillStyle = '#111';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(c.name, Math.max(x0, 0) + 4, y + headerH / 2 + 0.5);
  const bodyTop = y + headerH;
  const bodyH = h - headerH;
  const color = withAlpha(track.color, 0.9);
  if (c.kind === 'audio') drawWaveform(ctx, project, c, x0, x1, bodyTop, bodyH, v, width, color);
  else drawMiniNotes(ctx, c, x0, bodyTop, bodyH, v, color);
  ctx.restore();
  ctx.strokeStyle = selected ? theme.selection : 'rgba(0,0,0,0.6)';
  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.strokeRect(x0 + 0.5, y + 0.5, w - 1, h - 1);
  ctx.lineWidth = 1;
}

function drawWaveform(ctx: CanvasRenderingContext2D, project: Project, c: AudioClip, x0: number, x1: number, top: number, h: number, v: TimelineView, width: number, color: string): void {
  const asset = app.assets.get(c.assetId);
  if (!asset) return;
  const spb = secondsPerBeat(project.tempo);
  const secPerPx = spb / v.pxPerBeat;
  const mid = top + h / 2;
  const amp = (h / 2 - 2) * Math.min(2, c.gain);
  ctx.fillStyle = color;
  const start = Math.max(0, Math.floor(x0));
  const end = Math.min(width, Math.ceil(x1));
  const srcEnd = asset.buffer.duration;
  for (let x = start; x < end; x++) {
    const t = c.sourceOffset + (x - x0) * secPerPx;
    if (t >= srcEnd) break;
    const [lo, hi] = peakRange(asset.peaks, t, t + secPerPx);
    const yTop = mid - hi * amp;
    const yBot = mid - lo * amp;
    ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
  }
}

function drawMiniNotes(ctx: CanvasRenderingContext2D, c: MidiClip, x0: number, top: number, h: number, v: TimelineView, color: string): void {
  if (c.notes.length === 0) return;
  let lo = 127;
  let hi = 0;
  for (const n of c.notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  lo -= 2;
  hi += 2;
  const rowH = Math.max(1.5, Math.min(6, (h - 4) / (hi - lo + 1)));
  const span = (hi - lo + 1) * rowH;
  const offY = top + (h - span) / 2;
  ctx.fillStyle = color;
  for (const n of c.notes) {
    if (n.start < c.contentOffset || n.start >= c.contentOffset + c.length) continue;
    const nx = x0 + (n.start - c.contentOffset) * v.pxPerBeat;
    const len = Math.min(n.length, c.contentOffset + c.length - n.start);
    const ny = offY + (hi - n.pitch) * rowH;
    ctx.fillRect(nx, ny, Math.max(1, len * v.pxPerBeat - 1), Math.max(1, rowH - 0.5));
  }
}
