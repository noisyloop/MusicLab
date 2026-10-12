import { app, type BottomPanel as Panel } from '../app/controller';
import { useStore } from '../app/store';
import { DevicePanel } from './DevicePanel';
import { Mixer } from './Mixer';
import { PianoRoll } from './PianoRoll';

const TABS: { id: Panel; label: string }[] = [
  { id: 'mixer', label: 'Mixer' },
  { id: 'editor', label: 'Piano Roll' },
  { id: 'device', label: 'Device' },
];

export function BottomPanel() {
  const panel = useStore(app.store, (s) => s.bottomPanel);
  return (
    <section className="bottom-panel">
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={panel === t.id ? 'on' : ''} onClick={() => app.setBottomPanel(t.id)} data-testid={`tab-${t.id}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="panel-body">
        {panel === 'mixer' ? <Mixer /> : panel === 'editor' ? <PianoRoll /> : <DevicePanel />}
      </div>
    </section>
  );
}
