import { app } from '../app/controller';
import { useStore } from '../app/store';
import { getDeviceDefinition } from '../devices/registry';
import { normToValue, valueToNorm, type ContinuousParam, type ParamDescriptor } from '../devices/types';
import { setDeviceParam } from '../model/commands';
import { findTrack } from '../model/project';

function formatValue(p: ContinuousParam, v: number): string {
  const unit = p.unit ?? '';
  if (unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`;
  if (unit === 's') return v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`;
  if (unit === 'ct') return `${v.toFixed(1)} ct`;
  if (p.id === 'octave') return `${v > 0 ? '+' : ''}${Math.round(v)}`;
  return `${Math.round(v * 100)}%`;
}

function ParamControl({ trackId, param, value }: { trackId: string; param: ParamDescriptor; value: number }) {
  const set = (v: number) => app.execute(setDeviceParam(trackId, param.id, v));
  if (param.kind === 'enum') {
    return (
      <div className="param">
        <div className="param-name">{param.name}</div>
        <div className="segmented">
          {param.options.map((o, i) => (
            <button key={o} className={i === value ? 'on' : ''} onClick={() => set(i)}>
              {o}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const stepped = param.id === 'octave';
  return (
    <div className="param">
      <div className="param-name">{param.name}</div>
      <input
        type="range"
        aria-label={param.name}
        min={0}
        max={1}
        step={stepped ? 1 / (param.max - param.min) : 0.001}
        value={valueToNorm(param, value)}
        onChange={(e) => {
          let v = normToValue(param, Number(e.currentTarget.value));
          if (stepped) v = Math.round(v);
          set(v);
        }}
        onPointerUp={() => app.endGesture()}
        onDoubleClick={() => set(param.default)}
        title="Double-click to reset"
      />
      <div className="param-value">{formatValue(param, value)}</div>
    </div>
  );
}

export function DevicePanel() {
  const trackId = useStore(app.store, (s) => s.selectedTrackId);
  const track = useStore(app.store, (s) => (s.selectedTrackId ? findTrack(s.project, s.selectedTrackId) : undefined));
  if (!trackId || !track) return <div className="empty-hint">Select a MIDI track to edit its instrument.</div>;
  if (track.kind !== 'midi') return <div className="empty-hint">“{track.name}” is an audio track; audio tracks have no instrument. Select a MIDI track.</div>;
  const def = getDeviceDefinition(track.instrument.type);
  if (!def) return <div className="empty-hint">Unknown device “{track.instrument.type}”.</div>;
  const groups = [...new Set(def.params.map((p) => p.group))];
  return (
    <div className="device">
      <div className="device-title">
        {def.name} <span className="dim">on {track.name}</span>
      </div>
      <div className="device-groups">
        {groups.map((g) => (
          <fieldset key={g} className="device-group">
            <legend>{g}</legend>
            {def.params
              .filter((p) => p.group === g)
              .map((p) => (
                <ParamControl key={p.id} trackId={track.id} param={p} value={track.instrument.params[p.id] ?? p.default} />
              ))}
          </fieldset>
        ))}
      </div>
    </div>
  );
}
