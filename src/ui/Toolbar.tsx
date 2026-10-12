import { useEffect, useRef, useState } from 'react';
import { app } from '../app/controller';
import { useStore } from '../app/store';
import { setProjectName, setTempo } from '../model/commands';
import { beatsToSeconds, formatBarBeat, formatSeconds } from '../model/time';

const SNAP_OPTIONS: { label: string; value: number }[] = [
  { label: 'Auto', value: 0 },
  { label: 'Off', value: -1 },
  { label: '1 Bar', value: 4 },
  { label: '1/2', value: 2 },
  { label: '1/4', value: 1 },
  { label: '1/8', value: 0.5 },
  { label: '1/16', value: 0.25 },
  { label: '1/32', value: 0.125 },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

function PositionDisplay() {
  const ref = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      const p = app.project;
      const beat = app.position.get().beat;
      if (ref.current) ref.current.textContent = formatBarBeat(beat, p.beatsPerBar);
      if (timeRef.current) timeRef.current.textContent = formatSeconds(beatsToSeconds(beat, p.tempo));
    };
    update();
    const a = app.position.subscribe(update);
    const b = app.store.subscribe(update);
    return () => {
      a();
      b();
    };
  }, []);
  return (
    <div className="position" title="Position (bar.beat.sixteenth) and time">
      <span ref={ref} className="pos-bars" data-testid="position" />
      <span ref={timeRef} className="pos-time" />
    </div>
  );
}

function TempoInput() {
  const tempo = useStore(app.store, (s) => s.project.tempo);
  const [text, setText] = useState(String(tempo));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : String(Math.round(tempo * 100) / 100);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v > 0) app.execute(setTempo(v));
    app.endGesture();
  };
  return (
    <label className="tempo" title="Tempo (BPM). Scroll or use arrow keys to adjust.">
      <input
        aria-label="Tempo"
        data-testid="tempo"
        value={shown}
        onFocus={() => {
          setText(String(tempo));
          setFocused(true);
        }}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={() => {
          commit();
          setFocused(false);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(String(tempo));
            e.currentTarget.blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const v = Math.round(tempo) + (e.key === 'ArrowUp' ? 1 : -1);
            app.execute(setTempo(v));
            setText(String(v));
          }
        }}
        onWheel={(e) => {
          app.execute(setTempo(Math.round(tempo) + (e.deltaY < 0 ? 1 : -1)));
        }}
      />
      <span>BPM</span>
    </label>
  );
}

function ProjectName() {
  const name = useStore(app.store, (s) => s.project.name);
  const dirty = useStore(app.store, (s) => s.dirty);
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className="project-name-input"
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        defaultValue={name}
        onBlur={(e) => {
          setEditing(false);
          const v = e.currentTarget.value.trim();
          if (v && v !== name) app.execute(setProjectName(v));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
        }}
      />
    );
  }
  return (
    <span className="project-name" title="Double-click to rename the project" onDoubleClick={() => setEditing(true)}>
      {name}
      {dirty ? <span className="dirty-dot" title="Unsaved changes"> ●</span> : null}
    </span>
  );
}

export function Toolbar() {
  const playing = useStore(app.store, (s) => s.playing);
  const loopEnabled = useStore(app.store, (s) => s.project.loop.enabled);
  const canUndo = useStore(app.store, (s) => s.canUndo);
  const canRedo = useStore(app.store, (s) => s.canRedo);
  const undoLabel = useStore(app.store, (s) => s.undoLabel);
  const redoLabel = useStore(app.store, (s) => s.redoLabel);
  const snap = useStore(app.store, (s) => s.view.snap);
  const follow = useStore(app.store, (s) => s.view.followPlayhead);
  const pxPerBeat = useStore(app.store, (s) => s.view.pxPerBeat);
  const kbd = useStore(app.store, (s) => s.keyboardEnabled);
  const octave = useStore(app.store, (s) => s.keyboardOctave);
  const busy = useStore(app.store, (s) => s.busy);

  return (
    <header className="toolbar">
      <div className="group">
        <span className="logo">MusicLab</span>
        <button onClick={() => app.newProject()} title="New project">New</button>
        <button onClick={() => void app.openProject()} title="Open project (Ctrl+O)">Open</button>
        <button onClick={() => void app.saveProject()} title="Save project (Ctrl+S)">Save</button>
        <button onClick={() => void app.saveProject(true)} title="Save as… (Ctrl+Shift+S)">Save As</button>
        <button onClick={() => app.setExportOpen(true)} title="Export mix to WAV (Ctrl+Shift+E)">Export WAV</button>
        <button onClick={() => void app.openMidiImport()} title="Import a Standard MIDI File (.mid) at the playhead" data-testid="import-midi">Import MIDI</button>
        <button onClick={() => app.setMidiExportOpen(true)} title="Export MIDI tracks to a Standard MIDI File (.mid)" data-testid="export-midi">Export MIDI</button>
      </div>
      <div className="group">
        <button onClick={() => app.undo()} disabled={!canUndo} title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}>
          ↶
        </button>
        <button onClick={() => app.redo()} disabled={!canRedo} title={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}>
          ↷
        </button>
      </div>
      <div className="group transport">
        <button className={`transport-btn${playing ? ' on' : ''}`} onClick={() => void app.play()} title="Play (Space)" data-testid="play">
          ▶
        </button>
        <button className="transport-btn" onClick={() => app.stop()} title="Stop (Space). Press again to return to start." data-testid="stop">
          ■
        </button>
        <button className={`transport-btn loop${loopEnabled ? ' on' : ''}`} onClick={() => app.toggleLoop()} title="Loop on/off (Ctrl+L)" data-testid="loop">
          ⟲
        </button>
        <TempoInput />
        <PositionDisplay />
      </div>
      <div className="group">
        <label className="select-label" title="Snap grid (hold Alt while dragging to bypass)">
          Grid
          <select value={snap} onChange={(e) => app.setView({ snap: Number(e.currentTarget.value) })}>
            {SNAP_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => app.setView({ pxPerBeat: pxPerBeat / 1.5 })} title="Zoom out (-)">−</button>
        <button onClick={() => app.setView({ pxPerBeat: pxPerBeat * 1.5 })} title="Zoom in (+)">+</button>
        <button className={`toggle-text${follow ? ' on' : ''}`} onClick={() => app.setView({ followPlayhead: !follow })} title="Follow playhead">
          Follow
        </button>
        <button
          className={`toggle-text${kbd ? ' on' : ''}`}
          onClick={() => app.store.set({ keyboardEnabled: !kbd })}
          title="Computer MIDI keyboard (M): A–K play notes on the selected MIDI track, Z/X octave, C/V velocity"
        >
          ⌨ {kbd ? noteName(octave * 12 + 12) : 'off'}
        </button>
      </div>
      <div className="group right">
        {busy ? <span className="busy">{busy}</span> : null}
        <ProjectName />
      </div>
    </header>
  );
}
