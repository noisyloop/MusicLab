import { useEffect, useRef, useState, type DragEvent } from 'react';
import { app } from '../app/controller';
import { useStore } from '../app/store';
import { EFFECT_DEFINITIONS, getDeviceDefinition, listDeviceDefinitions } from '../devices/registry';
import { normToValue, valueToNorm, type ContinuousParam, type DeviceDefinition, type ParamDescriptor } from '../devices/types';
import { addEffect, moveEffect, removeEffect, setDeviceParam, setEffectBypass, setEffectParam, setInstrument } from '../model/commands';
import { createEffectSlot, findTrack } from '../model/project';
import { MASTER_CHAIN, type EffectSlot, type Id } from '../model/types';

function formatValue(p: ContinuousParam, v: number): string {
  const unit = p.unit ?? '';
  if (unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`;
  if (unit === 's') return v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`;
  if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
  if (unit === 'ct') return `${v.toFixed(1)} ct`;
  if (unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  if (unit === 'ratio') return `${v.toFixed(1)}:1`;
  if (unit === 'q') return v.toFixed(2);
  if (unit === 'oct') return `${v.toFixed(2)} oct`;
  if (unit === 'st') return p.min < 0 ? `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toString()} st` : `±${Math.round(v)} st`;
  if (unit === 'cc') return `CC ${Math.round(v)}`;
  if (unit === '×') return `${Number(v.toFixed(2))}×`;
  if (p.id === 'octave') return `${v > 0 ? '+' : ''}${Math.round(v)}`;
  return `${Math.round(v * 100)}%`;
}

function ParamControl({ param, value, onChange }: { param: ParamDescriptor; value: number; onChange: (v: number) => void }) {
  if (param.kind === 'enum') {
    if (param.options.length > 4) {
      return (
        <div className="param">
          <div className="param-name">{param.name}</div>
          <select aria-label={param.name} value={value} onChange={(e) => onChange(Number(e.currentTarget.value))}>
            {param.options.map((o, i) => (
              <option key={o} value={i}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    }
    return (
      <div className="param">
        <div className="param-name">{param.name}</div>
        <div className="segmented">
          {param.options.map((o, i) => (
            <button key={o} className={i === value ? 'on' : ''} onClick={() => onChange(i)}>
              {o}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const step = param.step;
  return (
    <div className="param">
      <div className="param-name">{param.name}</div>
      <input
        type="range"
        aria-label={param.name}
        min={0}
        max={1}
        step={step && param.scale === 'linear' ? step / (param.max - param.min) : 0.001}
        value={valueToNorm(param, value)}
        onChange={(e) => onChange(normToValue(param, Number(e.currentTarget.value)))}
        onPointerUp={() => app.endGesture()}
        onDoubleClick={() => onChange(param.default)}
        title="Double-click to reset"
      />
      <div className="param-value">{formatValue(param, value)}</div>
    </div>
  );
}

function Params({ def, values, onChange }: { def: DeviceDefinition; values: Record<string, number>; onChange: (id: string, v: number) => void }) {
  const groups = [...new Set(def.params.map((p) => p.group))];
  return (
    <div className="device-groups">
      {groups.map((g) => (
        <fieldset key={g} className="device-group">
          <legend>{g}</legend>
          {def.params
            .filter((p) => p.group === g)
            .map((p) => (
              <ParamControl key={p.id} param={p} value={values[p.id] ?? p.default} onChange={(v) => onChange(p.id, v)} />
            ))}
        </fieldset>
      ))}
    </div>
  );
}

/** Live gain reduction from the compressor processor, updated every animation frame. */
function GainReduction({ slotId }: { slotId: Id }) {
  const bar = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      const gr = app.meters.get().snapshot.effects[slotId] ?? 0;
      if (bar.current) bar.current.style.width = `${Math.min(100, (gr / 24) * 100)}%`;
      if (label.current) label.current.textContent = `GR ${gr.toFixed(1)} dB`;
    };
    update();
    return app.meters.subscribe(update);
  }, [slotId]);
  return (
    <div className="gr-meter" title="Gain reduction" data-testid="gain-reduction">
      <div className="gr-track">
        <div className="gr-bar" ref={bar} />
      </div>
      <span ref={label} className="gr-label" />
    </div>
  );
}

const FX_DRAG_TYPE = 'application/x-musiclab-effect';

function EffectCard({ chain, slot, index, onDropAt }: { chain: Id; slot: EffectSlot; index: number; onDropAt: (slotId: Id, index: number) => void }) {
  const def = getDeviceDefinition(slot.type);
  const [over, setOver] = useState(false);
  if (!def) return null;
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(FX_DRAG_TYPE)) return;
    e.preventDefault();
    setOver(true);
  };
  return (
    <div
      className={`device-card effect${slot.bypass ? ' bypassed' : ''}${over ? ' drop-target' : ''}`}
      data-testid="effect-card"
      data-effect={slot.type}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(FX_DRAG_TYPE);
        if (id) {
          e.preventDefault();
          onDropAt(id, index);
        }
      }}
    >
      <div
        className="card-header"
        draggable
        title="Drag to reorder"
        onDragStart={(e) => {
          e.dataTransfer.setData(FX_DRAG_TYPE, slot.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <button
          className={`power${slot.bypass ? '' : ' on'}`}
          title={slot.bypass ? 'Enable effect' : 'Bypass effect'}
          aria-label={`${def.name} ${slot.bypass ? 'enable' : 'bypass'}`}
          data-testid="effect-bypass"
          onClick={() => app.execute(setEffectBypass(chain, slot.id, !slot.bypass))}
        >
          ⏻
        </button>
        <span className="card-title">{def.name}</span>
        <button className="icon-btn" title="Remove effect" aria-label={`Remove ${def.name}`} onClick={() => app.execute(removeEffect(chain, slot.id))}>
          ×
        </button>
      </div>
      {slot.type === 'compressor' ? <GainReduction slotId={slot.id} /> : null}
      <Params def={def} values={slot.params} onChange={(id, v) => app.execute(setEffectParam(chain, slot.id, id, v))} />
    </div>
  );
}

function AddEffect({ chain }: { chain: Id }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="add-effect">
      <button className="add-effect-btn" title="Add an effect" aria-label="Add effect" data-testid="add-effect" onClick={() => setOpen(!open)}>
        +
      </button>
      {open ? (
        <div className="add-effect-menu" role="menu">
          {EFFECT_DEFINITIONS.map((d) => (
            <button
              key={d.type}
              role="menuitem"
              onClick={() => {
                const slot = createEffectSlot(d.type);
                if (slot) app.execute(addEffect(chain, slot));
                setOpen(false);
              }}
            >
              {d.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A chain left to right: optional instrument card, effect cards, then "+". */
function Chain({ chain, effects, children }: { chain: Id; effects: EffectSlot[]; children?: React.ReactNode }) {
  const onDropAt = (slotId: Id, index: number) => {
    app.execute(moveEffect(chain, slotId, index));
  };
  return (
    <div className="chain" data-testid="device-chain">
      {children}
      {effects.map((s, i) => (
        <EffectCard key={s.id} chain={chain} slot={s} index={i} onDropAt={onDropAt} />
      ))}
      <AddEffect chain={chain} />
    </div>
  );
}

export function DevicePanel() {
  const trackId = useStore(app.store, (s) => s.selectedTrackId);
  const masterSelected = useStore(app.store, (s) => s.masterSelected && !s.selectedTrackId);
  const masterEffects = useStore(app.store, (s) => s.project.master.effects);
  const track = useStore(app.store, (s) => (s.selectedTrackId ? findTrack(s.project, s.selectedTrackId) : undefined));
  if (masterSelected) {
    return (
      <div className="device">
        <div className="device-title">
          Master <span className="dim">insert effects (before the master fader)</span>
        </div>
        <Chain chain={MASTER_CHAIN} effects={masterEffects} />
      </div>
    );
  }
  if (!trackId || !track) return <div className="empty-hint">Select a track (or the master strip in the Mixer) to edit its devices.</div>;
  let instrument: React.ReactNode = null;
  if (track.kind === 'midi') {
    const def = getDeviceDefinition(track.instrument.type);
    instrument = def ? (
      <div className="device-card instrument" data-testid="instrument-card">
        <div className="card-header">
          <select aria-label="Instrument" data-testid="instrument-select" value={def.type} onChange={(e) => app.execute(setInstrument(track.id, e.currentTarget.value))}>
            {listDeviceDefinitions()
              .filter((d) => d.kind === 'instrument')
              .map((d) => (
                <option key={d.type} value={d.type}>
                  {d.name}
                </option>
              ))}
          </select>
        </div>
        <Params def={def} values={track.instrument.params} onChange={(id, v) => app.execute(setDeviceParam(track.id, id, v))} />
      </div>
    ) : (
      <div className="empty-hint">Unknown device “{track.instrument.type}”.</div>
    );
  }
  return (
    <div className="device">
      <div className="device-title">
        {track.name} <span className="dim">{track.kind === 'midi' ? 'instrument and insert effects' : 'insert effects (before the fader)'}</span>
      </div>
      <Chain chain={track.id} effects={track.effects}>
        {instrument}
      </Chain>
    </div>
  );
}
