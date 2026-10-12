/** Global keyboard shortcuts and the computer MIDI keyboard. */
import { moveClips } from '../model/commands';
import { findClip, findTrack, projectEndBeat } from '../model/project';
import type { Id } from '../model/types';
import { effectiveGrid, type AppController } from './controller';

/** Physical key -> semitone offset from the keyboard's base C (Ableton-style layout). */
export const NOTE_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !['range', 'checkbox', 'radio', 'button'].includes(target.type);
  return false;
}

export function installKeyboard(app: AppController): () => void {
  const held = new Map<string, { trackId: Id; pitch: number }>();

  const releaseAll = () => {
    for (const { trackId, pitch } of held.values()) app.liveNote(trackId, pitch, false);
    held.clear();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTextEntry(e.target)) return;
    const s = app.state;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (s.exportOpen || s.midiExportOpen) {
      if (e.key === 'Escape') {
        app.setExportOpen(false);
        app.setMidiExportOpen(false);
      }
      return;
    }

    if (mod) {
      let handled = true;
      if (key === 'z' && !e.shiftKey) app.undo();
      else if ((key === 'z' && e.shiftKey) || key === 'y') app.redo();
      else if (key === 's') void app.saveProject(e.shiftKey);
      else if (key === 'o') void app.openProject();
      else if (key === 'e' && e.shiftKey) app.setExportOpen(true);
      else if (key === 'e') app.splitAtPlayhead();
      else if (key === 'd') {
        // In the piano roll, Ctrl+D duplicates notes (handled there); never the clip.
        if (s.focus === 'arrangement') app.duplicateSelectedClips();
      }
      else if (key === 'a') app.selectAllClips();
      else if (key === 'l') app.toggleLoop();
      else if (key === 'm' && e.shiftKey) app.insertMidiClipAtPlayhead();
      else handled = false;
      if (handled) e.preventDefault();
      return;
    }
    if (e.altKey) return;

    // Computer MIDI keyboard
    if (s.keyboardEnabled && !e.shiftKey) {
      const track = s.selectedTrackId ? findTrack(app.project, s.selectedTrackId) : undefined;
      const offset = NOTE_KEYS[e.code];
      if (offset !== undefined && track?.kind === 'midi') {
        e.preventDefault();
        if (e.repeat || held.has(e.code)) return;
        const pitch = Math.min(127, s.keyboardOctave * 12 + 12 + offset);
        held.set(e.code, { trackId: track.id, pitch });
        app.liveNote(track.id, pitch, true);
        return;
      }
      if (e.code === 'KeyZ' || e.code === 'KeyX') {
        e.preventDefault();
        app.store.set({ keyboardOctave: Math.min(8, Math.max(0, s.keyboardOctave + (e.code === 'KeyX' ? 1 : -1))) });
        return;
      }
      if (e.code === 'KeyC' || e.code === 'KeyV') {
        e.preventDefault();
        const v = Math.round((s.keyboardVelocity + (e.code === 'KeyV' ? 0.1 : -0.1)) * 10) / 10;
        app.store.set({ keyboardVelocity: Math.min(1, Math.max(0.1, v)) });
        app.toast(`Keyboard velocity ${Math.round(Math.min(1, Math.max(0.1, v)) * 127)}`, 'info');
        return;
      }
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!e.repeat) app.togglePlay();
        return;
      case 'Delete':
      case 'Backspace':
        if (s.focus === 'arrangement') {
          e.preventDefault();
          app.deleteSelectedClips();
        }
        return;
      case 'Escape':
        app.selectClips([]);
        return;
      case 'Home':
        e.preventDefault();
        app.seek(0);
        return;
      case 'End':
        e.preventDefault();
        app.seek(projectEndBeat(app.project));
        return;
      case '+':
      case '=':
        app.setView({ pxPerBeat: s.view.pxPerBeat * 1.25 });
        return;
      case '-':
      case '_':
        app.setView({ pxPerBeat: s.view.pxPerBeat / 1.25 });
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (s.focus !== 'arrangement' || s.selectedClipIds.length === 0) return;
        e.preventDefault();
        const step = (effectiveGrid(s.view) || 0.25) * (e.key === 'ArrowLeft' ? -1 : 1);
        const moves = s.selectedClipIds
          .map((id) => findClip(app.project, id))
          .filter((l) => l !== undefined)
          .map((l) => ({ clipId: l.clip.id, trackId: l.track.id, start: l.clip.start + step }));
        app.execute(moveClips(moves));
        return;
      }
    }
    if (e.code === 'KeyM' && !e.shiftKey) {
      releaseAll();
      app.store.set({ keyboardEnabled: !s.keyboardEnabled });
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const h = held.get(e.code);
    if (h) {
      held.delete(e.code);
      app.liveNote(h.trackId, h.pitch, false);
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', releaseAll);
    releaseAll();
  };
}
