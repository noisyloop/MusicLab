import { app } from '../app/controller';
import { useStore } from '../app/store';

function formatSavedAt(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `today at ${time}` : `${d.toLocaleDateString()} at ${time}`;
}

/** Offers unsaved work autosaved by a tab that was closed or crashed. */
export function RecoveryBanner() {
  const recovery = useStore(app.store, (s) => s.recovery);
  const busy = useStore(app.store, (s) => s.busy);
  if (!recovery) return null;
  return (
    <div className="recovery" role="alertdialog" aria-labelledby="recovery-text" data-testid="recovery">
      <span id="recovery-text">
        Found unsaved work on <b>{recovery.projectName}</b>
        {recovery.fileName ? <span className="dim"> ({recovery.fileName})</span> : null}, autosaved {formatSavedAt(recovery.savedAt)}.
      </span>
      <button className="primary" disabled={busy !== null} onClick={() => void app.restoreRecovery()} data-testid="recovery-restore">
        Restore
      </button>
      <button disabled={busy !== null} onClick={() => void app.discardRecovery()} data-testid="recovery-discard">
        Discard
      </button>
    </div>
  );
}
