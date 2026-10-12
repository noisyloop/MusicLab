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
      <div
        className="panel-resizer"
        title="Drag to resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const startY = e.clientY;
          const root = document.documentElement;
          const startH = parseFloat(getComputedStyle(root).getPropertyValue('--bottom-h')) || 320;
          const move = (ev: PointerEvent) => {
            const h = Math.min(window.innerHeight - 220, Math.max(140, startH + startY - ev.clientY));
            root.style.setProperty('--bottom-h', `${h}px`);
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
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
