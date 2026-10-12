import { app } from '../app/controller';
import { useStore } from '../app/store';
import { setMasterVolume, setTrackMix } from '../model/commands';
import type { Track } from '../model/types';
import { faderToGain, formatDb, gainToFader } from './geometry';
import { Meter } from './Meter';

function Fader({ gain, onChange, label }: { gain: number; onChange: (g: number) => void; label: string }) {
  return (
    <div className="fader-wrap">
      <input
        type="range"
        className="fader"
        aria-label={label}
        min={0}
        max={1}
        step={0.001}
        value={gainToFader(gain)}
        onChange={(e) => onChange(faderToGain(Number(e.currentTarget.value)))}
        onPointerUp={() => app.endGesture()}
        onDoubleClick={() => onChange(1)}
        title="Double-click for 0 dB"
      />
    </div>
  );
}

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.005) return 'C';
  return `${Math.round(Math.abs(pan) * 50)}${pan < 0 ? 'L' : 'R'}`;
}

function Strip({ track, selected }: { track: Track; selected: boolean }) {
  return (
    <div className={`strip${selected ? ' selected' : ''}`} onPointerDown={() => app.selectTrack(track.id)} data-testid="mixer-strip">
      <div className="strip-name" style={{ borderTopColor: track.color }} title={track.name}>
        {track.name}
      </div>
      <div className="pan-row">
        <input
          type="range"
          className="pan"
          aria-label={`${track.name} pan`}
          min={-1}
          max={1}
          step={0.01}
          value={track.pan}
          onChange={(e) => app.execute(setTrackMix(track.id, { pan: Number(e.currentTarget.value) }))}
          onPointerUp={() => app.endGesture()}
          onDoubleClick={() => app.execute(setTrackMix(track.id, { pan: 0 }))}
          title="Pan (double-click to center)"
        />
        <span className="pan-label">{panLabel(track.pan)}</span>
      </div>
      <div className="strip-body">
        <Fader gain={track.volume} label={`${track.name} volume`} onChange={(g) => app.execute(setTrackMix(track.id, { volume: g }))} />
        <Meter source={track.id} />
      </div>
      <div className="db-readout">{formatDb(track.volume)} dB</div>
      <div className="strip-buttons">
        <button className={`toggle mute${track.mute ? ' on' : ''}`} onClick={() => app.execute(setTrackMix(track.id, { mute: !track.mute }))} title="Mute">
          M
        </button>
        <button className={`toggle solo${track.solo ? ' on' : ''}`} onClick={() => app.execute(setTrackMix(track.id, { solo: !track.solo }))} title="Solo">
          S
        </button>
      </div>
    </div>
  );
}

export function Mixer() {
  const tracks = useStore(app.store, (s) => s.project.tracks);
  const master = useStore(app.store, (s) => s.project.master.volume);
  const selected = useStore(app.store, (s) => s.selectedTrackId);
  return (
    <div className="mixer">
      <div className="strips">
        {tracks.length === 0 ? <div className="empty-hint">No tracks yet.</div> : null}
        {tracks.map((t) => (
          <Strip key={t.id} track={t} selected={t.id === selected} />
        ))}
      </div>
      <div className="strip master" data-testid="master-strip">
        <div className="strip-name">Master</div>
        <div className="pan-row" />
        <div className="strip-body">
          <Fader gain={master} label="Master volume" onChange={(g) => app.execute(setMasterVolume(g))} />
          <Meter source="master" />
        </div>
        <div className="db-readout">{formatDb(master)} dB</div>
        <div className="strip-buttons" />
      </div>
    </div>
  );
}
