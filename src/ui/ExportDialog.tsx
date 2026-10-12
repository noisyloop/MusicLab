import { useState } from 'react';
import { app } from '../app/controller';
import { useStore } from '../app/store';
import { projectEndBeat } from '../model/project';
import { exportTailSeconds } from '../engine/tails';
import { beatsToSeconds, formatSeconds } from '../model/time';
import type { WavFormat } from '../util/wav';

export function ExportDialog() {
  const open = useStore(app.store, (s) => s.exportOpen);
  const project = useStore(app.store, (s) => s.project);
  const [range, setRange] = useState<'song' | 'loop'>('song');
  const [format, setFormat] = useState<WavFormat>('pcm16');
  if (!open) return null;
  const songEnd = projectEndBeat(project);
  const len = range === 'song' ? songEnd : project.loop.end - project.loop.start;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && app.setExportOpen(false)}>
      <div className="modal" role="dialog" aria-label="Export WAV">
        <h2>Export mix to WAV</h2>
        <fieldset>
          <legend>Range</legend>
          <label>
            <input type="radio" checked={range === 'song'} onChange={() => setRange('song')} /> Whole song (to the end of the last clip)
          </label>
          <label>
            <input type="radio" checked={range === 'loop'} onChange={() => setRange('loop')} /> Loop region
          </label>
          <div className="dim">Length {formatSeconds(beatsToSeconds(Math.max(0, len), project.tempo))} + {Math.round(exportTailSeconds(project) * 10) / 10} s tail (instrument release and effect tails)</div>
        </fieldset>
        <fieldset>
          <legend>Format</legend>
          <label>
            <input type="radio" checked={format === 'pcm16'} onChange={() => setFormat('pcm16')} /> 16-bit PCM
          </label>
          <label>
            <input type="radio" checked={format === 'float32'} onChange={() => setFormat('float32')} /> 32-bit float
          </label>
        </fieldset>
        <div className="modal-buttons">
          <button onClick={() => app.setExportOpen(false)}>Cancel</button>
          <button className="primary" disabled={len <= 0} onClick={() => void app.exportWav(range, format)} data-testid="export-confirm">
            Export
          </button>
        </div>
      </div>
    </div>
  );
}

export function MidiExportDialog() {
  const open = useStore(app.store, (s) => s.midiExportOpen);
  const project = useStore(app.store, (s) => s.project);
  const [range, setRange] = useState<'song' | 'loop'>('song');
  if (!open) return null;
  const len = range === 'song' ? projectEndBeat(project) : project.loop.end - project.loop.start;
  const midiTracks = project.tracks.filter((t) => t.kind === 'midi').length;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && app.setMidiExportOpen(false)}>
      <div className="modal" role="dialog" aria-label="Export MIDI">
        <h2>Export MIDI file</h2>
        <fieldset>
          <legend>Range</legend>
          <label>
            <input type="radio" checked={range === 'song'} onChange={() => setRange('song')} /> Whole song (to the end of the last clip)
          </label>
          <label>
            <input type="radio" checked={range === 'loop'} onChange={() => setRange('loop')} /> Loop region
          </label>
          <div className="dim">
            Format 1, a tempo track plus {midiTracks} MIDI track{midiTracks === 1 ? '' : 's'} with notes, pitch bend and controllers. Audio tracks are skipped.
          </div>
        </fieldset>
        <div className="modal-buttons">
          <button onClick={() => app.setMidiExportOpen(false)}>Cancel</button>
          <button className="primary" disabled={len <= 0 || midiTracks === 0} onClick={() => void app.exportMidi(range)} data-testid="export-midi-confirm">
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
