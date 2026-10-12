import { useEffect } from 'react';
import { app } from '../app/controller';
import { installKeyboard } from '../app/keyboard';
import { PROJECT_EXTENSION } from '../persistence/projectFile';
import { BottomPanel } from './BottomPanel';
import { ExportDialog } from './ExportDialog';
import { Timeline } from './Timeline';
import { Toasts } from './Toasts';
import { Toolbar } from './Toolbar';
import { TrackHeaders } from './TrackHeaders';

export function App() {
  useEffect(() => {
    const uninstall = installKeyboard(app);
    // Audio may only start after a user gesture; start the engine on the first one.
    const startAudio = () => {
      void app.ensureEngine().catch(() => undefined);
    };
    window.addEventListener('pointerdown', startAudio, { capture: true, once: true });
    window.addEventListener('keydown', startAudio, { capture: true, once: true });

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!app.state.dirty) return;
      e.preventDefault();
      e.returnValue = ''; // legacy browsers need returnValue set
    };
    window.addEventListener('beforeunload', beforeUnload);

    // Dropping files outside the timeline must not navigate away; .musiclab files open anywhere.
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXTENSION));
      if (project) void app.openProjectFile(project, null);
      else if (files.length > 0) app.toast('Drop audio files onto the arrangement timeline.', 'info');
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      uninstall();
      window.removeEventListener('pointerdown', startAudio, { capture: true });
      window.removeEventListener('keydown', startAudio, { capture: true });
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <main className="arrangement">
        <TrackHeaders />
        <Timeline />
      </main>
      <BottomPanel />
      <ExportDialog />
      <Toasts />
    </div>
  );
}
