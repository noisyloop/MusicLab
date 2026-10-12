import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { app, RULER_HEIGHT, TRACK_HEIGHT } from '../app/controller';
import { useStore } from '../app/store';
import { moveTrack, removeTrack, renameTrack, setTrackMix } from '../model/commands';
import type { Track } from '../model/types';
import { faderToGain, formatDb, gainToFader } from './geometry';
import { Meter } from './Meter';

export function TrackHeaders() {
  const tracks = useStore(app.store, (s) => s.project.tracks);
  const scrollY = useStore(app.store, (s) => s.view.scrollY);
  const selected = useStore(app.store, (s) => s.selectedTrackId);
  const [dragging, setDragging] = useState<{ id: string; offset: number; target: number } | null>(null);
  const startY = useRef(0);

  function onGripDown(e: ReactPointerEvent<HTMLDivElement>, t: Track, index: number) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    setDragging({ id: t.id, offset: 0, target: index });
  }
  function onGripMove(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    if (!dragging) return;
    const offset = e.clientY - startY.current;
    const target = Math.max(0, Math.min(tracks.length - 1, index + Math.round(offset / TRACK_HEIGHT)));
    setDragging({ ...dragging, offset, target });
  }
  function onGripUp() {
    if (dragging) app.execute(moveTrack(dragging.id, dragging.target));
    setDragging(null);
  }

  return (
    <div className="track-headers" onWheel={(e) => app.scrollTracksBy(e.deltaY)}>
      <div className="track-headers-top" style={{ height: RULER_HEIGHT }}>
        <button onClick={() => app.addTrack('audio')} title="Add an audio track">+ Audio</button>
        <button onClick={() => app.addTrack('midi')} title="Add a MIDI track with SubSynth">+ MIDI</button>
      </div>
      <div className="track-headers-body">
        <div style={{ transform: `translateY(${-scrollY}px)` }}>
          {tracks.map((t, i) => (
            <TrackHeader
              key={t.id}
              track={t}
              index={i}
              selected={t.id === selected}
              dragOffset={dragging?.id === t.id ? dragging.offset : 0}
              dropTarget={dragging && dragging.id !== t.id && dragging.target === i}
              onGripDown={onGripDown}
              onGripMove={onGripMove}
              onGripUp={onGripUp}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface HeaderProps {
  track: Track;
  index: number;
  selected: boolean;
  dragOffset: number;
  dropTarget: boolean | null;
  onGripDown: (e: ReactPointerEvent<HTMLDivElement>, t: Track, index: number) => void;
  onGripMove: (e: ReactPointerEvent<HTMLDivElement>, index: number) => void;
  onGripUp: () => void;
}

function TrackHeader({ track: t, index, selected, dragOffset, dropTarget, onGripDown, onGripMove, onGripUp }: HeaderProps) {
  const [editing, setEditing] = useState(false);

  function commitName(value: string) {
    setEditing(false);
    const name = value.trim();
    if (name && name !== t.name) app.execute(renameTrack(t.id, name));
  }

  return (
    <div
      className={`track-header${selected ? ' selected' : ''}${dropTarget ? ' drop-target' : ''}${dragOffset ? ' dragging' : ''}`}
      style={{ height: TRACK_HEIGHT, transform: dragOffset ? `translateY(${dragOffset}px)` : undefined }}
      onPointerDown={() => app.selectTrack(t.id)}
      data-testid={`track-header-${index}`}
    >
      <div
        className="track-grip"
        style={{ background: t.color }}
        title="Drag to reorder"
        onPointerDown={(e) => onGripDown(e, t, index)}
        onPointerMove={(e) => onGripMove(e, index)}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      />
      <div className="track-main">
        <div className="track-title-row">
          <span className="track-kind" title={t.kind === 'audio' ? 'Audio track' : 'MIDI track'}>{t.kind === 'audio' ? '∿' : '♪'}</span>
          {editing ? (
            <input
              className="track-name-input"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              defaultValue={t.name}
              onBlur={(e) => commitName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName(e.currentTarget.value);
                if (e.key === 'Escape') setEditing(false);
                e.stopPropagation();
              }}
            />
          ) : (
            <span className="track-name" title="Double-click to rename" onDoubleClick={() => setEditing(true)}>
              {t.name}
            </span>
          )}
          <button
            className="icon-btn track-duplicate"
            title="Duplicate track (with its clips and effects)"
            onClick={(e) => {
              e.stopPropagation();
              app.duplicateTrack(t.id);
            }}
          >
            ⧉
          </button>
          <button
            className="icon-btn track-delete"
            title="Delete track"
            onClick={(e) => {
              e.stopPropagation();
              app.execute(removeTrack(t.id));
            }}
          >
            ×
          </button>
        </div>
        <div className="track-controls">
          <button className={`toggle mute${t.mute ? ' on' : ''}`} title="Mute" onClick={() => app.execute(setTrackMix(t.id, { mute: !t.mute }))}>
            M
          </button>
          <button className={`toggle solo${t.solo ? ' on' : ''}`} title="Solo" onClick={() => app.execute(setTrackMix(t.id, { solo: !t.solo }))}>
            S
          </button>
          <input
            type="range"
            className="mini-vol"
            min={0}
            max={1}
            step={0.001}
            value={gainToFader(t.volume)}
            title={`Volume ${formatDb(t.volume)} dB`}
            onChange={(e) => app.execute(setTrackMix(t.id, { volume: faderToGain(Number(e.currentTarget.value)) }))}
            onPointerUp={() => app.endGesture()}
          />
          <Meter source={t.id} orientation="horizontal" />
        </div>
      </div>
    </div>
  );
}
