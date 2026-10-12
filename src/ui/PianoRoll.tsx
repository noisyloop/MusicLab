import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { adaptiveGrid, app } from '../app/controller';
import { useStore } from '../app/store';
import { addNotes, deleteNotes, renameClip, trimClipEnd, updateNotes, type Command } from '../model/commands';
import { newId } from '../model/ids';
import { findClip } from '../model/project';
import { snapBeat, snapFloor } from '../model/time';
import type { Id, MidiClip, Note } from '../model/types';
import { shade, theme } from './theme';
import { noteName } from './Toolbar';
import { useCanvas, type CanvasSize } from './useCanvas';

const KEYS_W = 52;
const RULER_H = 20;
const VEL_H = 64;
const EDGE = 6;
const BLACK = new Set([1, 3, 6, 8, 10]);

interface PRView {
  pxPerBeat: number;
  scrollBeat: number;
  keyH: number;
  /** Pitch at the top edge of the note area. */
  topPitch: number;
}

type Drag =
  | { kind: 'move'; noteIds: Id[]; anchor: Note; startBeat: number; startPitch: number; command: Command | null; lastPitch: number }
  | { kind: 'resize'; noteIds: Id[]; anchor: Note; command: Command | null }
  | { kind: 'velocity'; noteIds: Id[]; command: Command | null }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: Id[] }
  | { kind: 'key'; pitch: number };

const GRID_OPTIONS = [
  { label: '1/4', value: 1 },
  { label: '1/8', value: 0.5 },
  { label: '1/16', value: 0.25 },
  { label: '1/32', value: 0.125 },
  { label: 'Off', value: 0 },
];

export function PianoRoll() {
  const clipId = useStore(app.store, (s) => s.editorClipId);
  const clip = useStore(app.store, (s) => (s.editorClipId ? findClip(s.project, s.editorClipId)?.clip : undefined));
  if (!clipId || !clip || clip.kind !== 'midi') {
    return <div className="empty-hint">Double-click a MIDI clip to edit its notes. Double-click an empty spot on a MIDI track to create a clip (or Ctrl+Shift+M).</div>;
  }
  return <PianoRollEditor key={clipId} clipId={clipId} />;
}

function PianoRollEditor({ clipId }: { clipId: Id }) {
  const clip = useStore(app.store, (s) => findClip(s.project, clipId)?.clip as MidiClip | undefined);
  const [gridValue, setGridValue] = useState(0.25);
  const gridRef = useRef(gridValue);
  gridRef.current = gridValue;
  const selection = useRef<Set<Id>>(new Set());
  const lastLength = useRef(0.25);
  const drag = useRef<Drag | null>(null);
  const view = useRef<PRView>({ pxPerBeat: 60, scrollBeat: (clip?.contentOffset ?? 0) - 0.25, keyH: 12, topPitch: 84 });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);

  const getClip = () => findClip(app.project, clipId)?.clip as MidiClip | undefined;
  const trackId = () => findClip(app.project, clipId)?.track.id;

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, size: CanvasSize) => {
      const c = getClip();
      if (!c) return;
      const d = drag.current;
      const shown = d && 'command' in d && d.command ? (findClip(d.command.apply(app.project), clipId)?.clip as MidiClip | undefined) : c;
      drawPianoRoll(ctx, size, shown ?? c, view.current, selection.current, d, gridRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getClip reads live state by id
    [clipId],
  );
  const subscribe = useCallback((inv: () => void) => {
    const a = app.store.subscribe(inv);
    const b = app.position.subscribe(inv);
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
  const v = () => view.current;
  const xToBeat = (x: number) => (x - KEYS_W) / v().pxPerBeat + v().scrollBeat;
  const beatToX = (b: number) => KEYS_W + (b - v().scrollBeat) * v().pxPerBeat;
  const yToPitch = (y: number) => Math.floor(v().topPitch - (y - RULER_H) / v().keyH) + 1;
  const noteAreaBottom = () => sizeRef.current.height - VEL_H;
  const snapB = (b: number, bypass: boolean) => (bypass || gridRef.current <= 0 ? b : snapBeat(b, gridRef.current));

  function hitNote(c: MidiClip, x: number, y: number): { note: Note; zone: 'body' | 'end' } | null {
    const pitch = yToPitch(y);
    for (let i = c.notes.length - 1; i >= 0; i--) {
      const n = c.notes[i]!;
      if (n.pitch !== pitch) continue;
      const x0 = beatToX(n.start);
      const x1 = beatToX(n.start + n.length);
      if (x >= x0 && x <= x1) return { note: n, zone: x1 - x <= Math.min(EDGE, (x1 - x0) / 3) ? 'end' : 'body' };
    }
    return null;
  }

  function hitVelocity(c: MidiClip, x: number): Note | null {
    let best: Note | null = null;
    for (const n of c.notes) {
      const nx = beatToX(n.start);
      if (Math.abs(x - nx) <= 4 && (!best || selection.current.has(n.id))) best = n;
    }
    return best;
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    const c = getClip();
    const tid = trackId();
    if (!c || !tid) return;
    app.setFocus('editor');
    const { x, y } = local(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (y < RULER_H) {
      // Click in the ruler sets the song position at this clip-relative beat.
      app.seek(c.start + (snapB(xToBeat(x), e.altKey) - c.contentOffset));
      return;
    }
    if (y >= noteAreaBottom()) {
      const n = hitVelocity(c, x);
      if (n) {
        const ids = selection.current.has(n.id) ? [...selection.current] : [n.id];
        drag.current = { kind: 'velocity', noteIds: ids, command: null };
        onPointerMove(e);
      }
      return;
    }
    if (x < KEYS_W) {
      const pitch = yToPitch(y);
      drag.current = { kind: 'key', pitch };
      app.liveNote(tid, pitch, true, 0.8);
      return;
    }
    const hit = hitNote(c, x, y);
    if (hit) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (additive) {
        if (selection.current.has(hit.note.id)) selection.current.delete(hit.note.id);
        else selection.current.add(hit.note.id);
      } else if (!selection.current.has(hit.note.id)) {
        selection.current = new Set([hit.note.id]);
      }
      const ids = selection.current.has(hit.note.id) ? [...selection.current] : [hit.note.id];
      lastLength.current = hit.note.length;
      if (hit.zone === 'end') drag.current = { kind: 'resize', noteIds: ids, anchor: hit.note, command: null };
      else {
        drag.current = { kind: 'move', noteIds: ids, anchor: hit.note, startBeat: xToBeat(x), startPitch: yToPitch(y), command: null, lastPitch: hit.note.pitch };
        app.previewNote(tid, hit.note.pitch, hit.note.velocity);
      }
      invalidate();
      return;
    }
    if (e.shiftKey) {
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: [...selection.current] };
      return;
    }
    // Draw a new note, then let the drag resize it.
    const pitch = yToPitch(y);
    const g = gridRef.current;
    const start = e.altKey || g <= 0 ? xToBeat(x) : snapFloor(xToBeat(x), g);
    const note: Note = { id: newId('n'), pitch, start, length: lastLength.current || g || 0.25, velocity: 0.8 };
    app.execute(addNotes(clipId, [note]));
    selection.current = new Set([note.id]);
    drag.current = { kind: 'resize', noteIds: [note.id], anchor: note, command: null };
    app.previewNote(tid, pitch, 0.8);
    invalidate();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const { x, y } = local(e);
    hoverRef.current = { x, y };
    const d = drag.current;
    const c = getClip();
    if (!c) return;
    if (!d) {
      const canvas = canvasRef.current!;
      let cursor = 'default';
      if (y >= RULER_H && y < noteAreaBottom() && x >= KEYS_W) {
        const hit = hitNote(c, x, y);
        cursor = hit ? (hit.zone === 'end' ? 'ew-resize' : 'grab') : 'crosshair';
      } else if (y >= noteAreaBottom()) cursor = hitVelocity(c, x) ? 'ns-resize' : 'default';
      else if (x < KEYS_W) cursor = 'pointer';
      canvas.style.cursor = cursor;
      return;
    }
    const byId = new Map(c.notes.map((n) => [n.id, n]));
    const notes = (ids: Id[]) => ids.map((id) => byId.get(id)).filter((n) => n !== undefined);
    switch (d.kind) {
      case 'move': {
        const newStart = snapB(d.anchor.start + xToBeat(x) - d.startBeat, e.altKey);
        const dBeat = newStart - d.anchor.start;
        const dPitch = yToPitch(y) - d.startPitch;
        const moved = notes(d.noteIds).map((n) => ({ ...n, start: n.start + dBeat, pitch: Math.min(127, Math.max(0, n.pitch + dPitch)) }));
        d.command = updateNotes(clipId, moved, 'Move notes');
        const p = d.anchor.pitch + dPitch;
        if (p !== d.lastPitch) {
          d.lastPitch = p;
          const tid = trackId();
          if (tid) app.previewNote(tid, p, d.anchor.velocity);
        }
        break;
      }
      case 'resize': {
        const g = gridRef.current;
        const minLen = g > 0 && !e.altKey ? g : 1 / 64;
        const end = snapB(xToBeat(x), e.altKey);
        const newLen = Math.max(minLen, end - d.anchor.start);
        const dLen = newLen - d.anchor.length;
        const resized = notes(d.noteIds).map((n) => ({ ...n, length: Math.max(minLen, n.length + dLen) }));
        lastLength.current = newLen;
        d.command = updateNotes(clipId, resized, 'Resize notes');
        break;
      }
      case 'velocity': {
        const h = VEL_H - 8;
        const vel = Math.min(1, Math.max(0.01, (sizeRef.current.height - 4 - y) / h));
        d.command = updateNotes(clipId, notes(d.noteIds).map((n) => ({ ...n, velocity: vel })), 'Change velocity');
        break;
      }
      case 'marquee': {
        d.x1 = x;
        d.y1 = y;
        const b0 = xToBeat(Math.min(d.x0, d.x1));
        const b1 = xToBeat(Math.max(d.x0, d.x1));
        const p0 = yToPitch(Math.max(d.y0, d.y1));
        const p1 = yToPitch(Math.min(d.y0, d.y1));
        const ids = c.notes.filter((n) => n.pitch >= p0 && n.pitch <= p1 && n.start + n.length >= b0 && n.start <= b1).map((n) => n.id);
        selection.current = new Set([...d.base, ...ids]);
        break;
      }
      case 'key': {
        const p = yToPitch(y);
        const tid = trackId();
        if (p !== d.pitch && tid) {
          app.liveNote(tid, d.pitch, false);
          app.liveNote(tid, p, true, 0.8);
          d.pitch = p;
        }
        break;
      }
    }
    invalidate();
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'key') {
      const tid = trackId();
      if (tid) app.liveNote(tid, d.pitch, false);
    } else if ('command' in d && d.command) {
      app.execute(d.command);
    }
    app.endGesture();
    invalidate();
  }

  function onDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const c = getClip();
    if (!c) return;
    const { x, y } = local(e);
    if (y < RULER_H || y >= noteAreaBottom() || x < KEYS_W) return;
    const hit = hitNote(c, x, y);
    if (hit) {
      app.execute(deleteNotes(clipId, [hit.note.id]));
      selection.current.delete(hit.note.id);
      invalidate();
    }
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    const vw = view.current;
    if (e.ctrlKey || e.metaKey) {
      const { x } = local(e);
      const beat = xToBeat(x);
      vw.pxPerBeat = Math.min(800, Math.max(8, vw.pxPerBeat * Math.exp(-e.deltaY * 0.002)));
      vw.scrollBeat = beat - (x - KEYS_W) / vw.pxPerBeat;
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      vw.scrollBeat += (e.shiftKey ? e.deltaY : e.deltaX) / vw.pxPerBeat;
    } else {
      const visibleKeys = (noteAreaBottom() - RULER_H) / vw.keyH;
      vw.topPitch = Math.min(127, Math.max(visibleKeys - 1, vw.topPitch - e.deltaY / vw.keyH / 2));
    }
    invalidate();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const c = getClip();
    if (!c) return;
    const sel = c.notes.filter((n) => selection.current.has(n.id));
    const mod = e.ctrlKey || e.metaKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length > 0) {
      app.execute(deleteNotes(clipId, sel.map((n) => n.id)));
      selection.current.clear();
    } else if (mod && e.key.toLowerCase() === 'a') {
      selection.current = new Set(c.notes.map((n) => n.id));
    } else if (mod && e.key.toLowerCase() === 'd' && sel.length > 0) {
      const span = Math.max(...sel.map((n) => n.start + n.length)) - Math.min(...sel.map((n) => n.start));
      const copies = sel.map((n) => ({ ...n, id: newId('n'), start: n.start + span }));
      app.execute(addNotes(clipId, copies));
      selection.current = new Set(copies.map((n) => n.id));
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.length > 0) {
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      app.execute(updateNotes(clipId, sel.map((n) => ({ ...n, pitch: n.pitch + d })), 'Transpose notes'));
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel.length > 0) {
      const step = gridRef.current || 0.25;
      const d = e.key === 'ArrowRight' ? step : -step;
      app.execute(updateNotes(clipId, sel.map((n) => ({ ...n, start: n.start + d })), 'Move notes'));
    } else if (e.key === 'Escape') {
      selection.current.clear();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    invalidate();
  }

  if (!clip) return null;
  return (
    <div className="piano-roll" tabIndex={0} onKeyDown={onKeyDown} data-testid="piano-roll">
      <div className="pr-header">
        <input
          className="clip-name-input"
          value={clip.name}
          aria-label="Clip name"
          onChange={(e) => app.execute({ ...renameClip(clipId, e.currentTarget.value), mergeKey: `clip-name:${clipId}` })}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <label className="select-label">
          Grid
          <select value={gridValue} onChange={(e) => setGridValue(Number(e.currentTarget.value))}>
            {GRID_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="select-label" title="Clip length in bars">
          Length
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={Math.round((clip.length / app.project.beatsPerBar) * 1000) / 1000}
            onChange={(e) => {
              const bars = Number(e.currentTarget.value);
              if (bars > 0) app.execute(trimClipEnd(clipId, bars * app.project.beatsPerBar));
            }}
            onKeyDown={(e) => e.stopPropagation()}
          />
          bars
        </label>
        <span className="dim hint">Click to draw · drag to move · drag right edge to resize · double-click deletes · Shift-drag selects · ↑↓ transpose</span>
        <button className="icon-btn" title="Close editor" onClick={() => app.store.set({ editorClipId: null })}>
          ×
        </button>
      </div>
      <div className="pr-canvas">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            hoverRef.current = null;
          }}
          onDoubleClick={onDoubleClick}
          onWheel={onWheel}
        />
      </div>
    </div>
  );
}

function drawPianoRoll(ctx: CanvasRenderingContext2D, size: CanvasSize, c: MidiClip, v: PRView, selection: Set<Id>, d: Drag | null, gridValue: number) {
  const { width, height } = size;
  const noteBottom = height - VEL_H;
  const bx = (b: number) => KEYS_W + (b - v.scrollBeat) * v.pxPerBeat;
  const py = (p: number) => RULER_H + (v.topPitch - p) * v.keyH;
  const track = findClip(app.project, c.id)?.track;
  const color = track?.color ?? '#f5a623';
  const bpb = app.project.beatsPerBar;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);

  // rows
  const lowPitch = Math.floor(v.topPitch - (noteBottom - RULER_H) / v.keyH);
  for (let p = Math.ceil(v.topPitch); p >= lowPitch; p--) {
    const y = py(p);
    ctx.fillStyle = BLACK.has(p % 12) ? '#1e2025' : '#25282e';
    ctx.fillRect(KEYS_W, y, width - KEYS_W, v.keyH);
    if (p % 12 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(KEYS_W, y + v.keyH - 1, width - KEYS_W, 1);
    }
  }

  // clip region shading
  const cx0 = bx(c.contentOffset);
  const cx1 = bx(c.contentOffset + c.length);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  if (cx0 > KEYS_W) ctx.fillRect(KEYS_W, RULER_H, cx0 - KEYS_W, noteBottom - RULER_H);
  if (cx1 < width) ctx.fillRect(Math.max(KEYS_W, cx1), RULER_H, width - cx1, noteBottom - RULER_H);

  // grid
  const g = gridValue > 0 ? Math.max(gridValue, adaptiveGrid(v.pxPerBeat, 6)) : adaptiveGrid(v.pxPerBeat, 12);
  const first = Math.floor(v.scrollBeat / g) * g;
  for (let b = first; bx(b) < width; b += g) {
    const x = Math.round(bx(b)) + 0.5;
    if (x < KEYS_W) continue;
    const rel = b - c.contentOffset;
    const isBar = Math.abs(rel / bpb - Math.round(rel / bpb)) < 1e-6;
    const isBeat = Math.abs(rel - Math.round(rel)) < 1e-6;
    ctx.strokeStyle = isBar ? theme.gridBar : isBeat ? theme.gridBeat : theme.gridSub;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // notes
  ctx.save();
  ctx.beginPath();
  ctx.rect(KEYS_W, RULER_H, width - KEYS_W, noteBottom - RULER_H);
  ctx.clip();
  for (const n of c.notes) {
    const x0 = bx(n.start);
    const w = Math.max(3, n.length * v.pxPerBeat - 1);
    const y = py(n.pitch);
    const sel = selection.has(n.id);
    const outside = n.start < c.contentOffset || n.start >= c.contentOffset + c.length;
    ctx.globalAlpha = outside ? 0.35 : 1;
    ctx.fillStyle = sel ? shade(color, 0.45) : shade(color, -0.2 + n.velocity * 0.25);
    ctx.fillRect(x0, y + 1, w, v.keyH - 2);
    ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.6)';
    ctx.strokeRect(x0 + 0.5, y + 1.5, w - 1, v.keyH - 3);
    if (w > 30 && v.keyH >= 10) {
      ctx.fillStyle = '#111';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(noteName(n.pitch), x0 + 3, y + v.keyH / 2);
    }
  }
  ctx.globalAlpha = 1;
  if (d?.kind === 'marquee') {
    ctx.fillStyle = theme.marquee;
    ctx.strokeStyle = theme.marqueeBorder;
    ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    ctx.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }
  ctx.restore();

  // keyboard
  for (let p = Math.ceil(v.topPitch); p >= lowPitch; p--) {
    const y = py(p);
    if (y > noteBottom) break;
    const black = BLACK.has(p % 12);
    ctx.fillStyle = black ? '#2a2a2a' : '#d8d8d8';
    ctx.fillRect(0, y, KEYS_W, v.keyH);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, y + v.keyH - 1, KEYS_W, 1);
    if (p % 12 === 0 && v.keyH >= 8) {
      ctx.fillStyle = '#333';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(noteName(p), 4, y + v.keyH / 2);
    }
  }
  if (d?.kind === 'key') {
    ctx.fillStyle = 'rgba(245,166,35,0.7)';
    ctx.fillRect(0, py(d.pitch), KEYS_W, v.keyH);
  }

  // ruler (clip-relative bars)
  ctx.fillStyle = theme.ruler;
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.fillStyle = theme.rulerText;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  let barStep = 1;
  while (barStep * bpb * v.pxPerBeat < 40) barStep *= 2;
  const firstBar = Math.floor((v.scrollBeat - c.contentOffset) / bpb / barStep) * barStep;
  for (let bar = firstBar; ; bar += barStep) {
    const x = bx(c.contentOffset + bar * bpb);
    if (x > width) break;
    if (x >= KEYS_W) {
      ctx.fillRect(Math.round(x), 8, 1, RULER_H - 8);
      ctx.fillText(String(bar + 1), x + 3, RULER_H / 2);
    }
  }
  // clip bounds markers
  ctx.fillStyle = color;
  if (cx0 >= KEYS_W) ctx.fillRect(cx0, 0, 2, RULER_H);
  if (cx1 >= KEYS_W) ctx.fillRect(cx1 - 2, 0, 2, RULER_H);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(0, RULER_H - 1, width, 1);

  // playhead (song position mapped into the clip)
  const songBeat = app.position.get().beat;
  const rel = songBeat - c.start + c.contentOffset;
  if (songBeat >= c.start && songBeat <= c.start + c.length) {
    const x = bx(rel);
    if (x >= KEYS_W) {
      ctx.fillStyle = theme.playhead;
      ctx.fillRect(Math.round(x), 0, 1, height);
    }
  }

  // velocity lane
  ctx.fillStyle = '#16181c';
  ctx.fillRect(0, noteBottom, width, VEL_H);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(0, noteBottom, width, 1);
  ctx.fillStyle = theme.textDim;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('Velocity', 4, noteBottom + 12);
  ctx.save();
  ctx.beginPath();
  ctx.rect(KEYS_W, noteBottom, width - KEYS_W, VEL_H);
  ctx.clip();
  const vh = VEL_H - 8;
  for (const n of c.notes) {
    const x = bx(n.start);
    const h = n.velocity * vh;
    const sel = selection.has(n.id);
    ctx.fillStyle = sel ? shade(color, 0.45) : color;
    ctx.fillRect(x, height - 4 - h, 3, h);
    ctx.fillRect(x - 2, height - 4 - h, 7, 2);
  }
  ctx.restore();
}
