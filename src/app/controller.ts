/**
 * The app controller: owns the undo history, runtime assets and the audio
 * engine, and exposes intent-level actions to the UI. React components call
 * these methods and read state from the stores; they never touch Web Audio.
 */
import { AudioEngine, type MeterSnapshot } from '../engine/AudioEngine';
import { renderProject } from '../engine/render';
import {
  addAsset, addClip, addTrack, batch, deleteClips, duplicateClips, setLoop, splitClips, type Command,
} from '../model/commands';
import { History } from '../model/history';
import { newId } from '../model/ids';
import { createProject, createTrack, findClip, findTrack, nextTrackColor, nextTrackName, projectEndBeat, TRACK_COLORS } from '../model/project';
import { secondsToBeats, snapBeat } from '../model/time';
import type { AudioAsset, AudioClip, Clip, Id, MidiClip, Project, Track } from '../model/types';
import { PROJECT_EXTENSION, PROJECT_MIME, readProjectFile, writeProjectFile } from '../persistence/projectFile';
import { exportMidiFile } from '../midi/export';
import { planMidiImport, readMidiFile } from '../midi/import';
import { encodeWav, type WavFormat } from '../util/wav';
import { AssetStore } from './assets';
import { isAbortError, openFile, saveBytes } from './fileAccess';
import { Store } from './store';

export type BottomPanel = 'mixer' | 'editor' | 'device';
export type FocusArea = 'arrangement' | 'editor';

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  message: string;
}

export interface ViewState {
  /** Horizontal zoom. */
  pxPerBeat: number;
  /** Beat at the left edge of the timeline. */
  scrollBeat: number;
  /** Vertical scroll of the track area in px. */
  scrollY: number;
  /** Snap grid in beats; 0 = adaptive to zoom; -1 = off. */
  snap: number;
  followPlayhead: boolean;
}

export interface AppState {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
  dirty: boolean;
  fileName: string | null;
  selectedClipIds: Id[];
  selectedTrackId: Id | null;
  view: ViewState;
  playing: boolean;
  editorClipId: Id | null;
  bottomPanel: BottomPanel;
  focus: FocusArea;
  toasts: Toast[];
  keyboardEnabled: boolean;
  keyboardOctave: number;
  keyboardVelocity: number;
  busy: string | null;
  exportOpen: boolean;
  midiExportOpen: boolean;
}

export const TRACK_HEIGHT = 64;
export const RULER_HEIGHT = 34;
export const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.oga', '.m4a', '.aac', '.aif', '.aiff', '.webm'];

export const MIDI_EXTENSIONS = ['.mid', '.midi'];
export const MIDI_MIME = 'audio/midi';

export function isMidiFile(f: File): boolean {
  const name = f.name.toLowerCase();
  return MIDI_EXTENSIONS.some((e) => name.endsWith(e)) || f.type === 'audio/midi' || f.type === 'audio/x-midi';
}

export function isAudioFile(f: File): boolean {
  if (isMidiFile(f)) return false;
  const name = f.name.toLowerCase();
  return f.type.startsWith('audio/') || AUDIO_EXTENSIONS.some((e) => name.endsWith(e));
}

/** Effective snap grid in beats for a given zoom (adaptive mode picks a grid ~>= 12px). */
export function effectiveGrid(view: Pick<ViewState, 'snap' | 'pxPerBeat'>): number {
  if (view.snap > 0) return view.snap;
  if (view.snap < 0) return 0;
  return adaptiveGrid(view.pxPerBeat, 12);
}

export function adaptiveGrid(pxPerBeat: number, minPx: number): number {
  let g = 1 / 16;
  while (g * pxPerBeat < minPx && g < 64) g *= 2;
  return g;
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export class AppController {
  readonly store: Store<AppState>;
  /** Transport position in beats; updated every animation frame while playing. */
  readonly position = new Store<{ beat: number }>({ beat: 0 });
  /** Latest meter levels; updated every animation frame. */
  readonly meters = new Store<{ snapshot: MeterSnapshot }>({ snapshot: { master: [0, 0], tracks: {} } });
  readonly assets = new AssetStore();

  private history: History;
  private engine: AudioEngine | null = null;
  private enginePromise: Promise<AudioEngine> | null = null;
  private context: AudioContext | null = null;
  private fileHandle: FileSystemFileHandle | null = null;
  private toastId = 0;
  private rafId = 0;
  private stoppedPosition = 0;

  constructor() {
    const project = createProject('Untitled');
    this.history = new History(project);
    this.store = new Store<AppState>({
      project,
      canUndo: false,
      canRedo: false,
      undoLabel: undefined,
      redoLabel: undefined,
      dirty: false,
      fileName: null,
      selectedClipIds: [],
      selectedTrackId: null,
      view: { pxPerBeat: 24, scrollBeat: 0, scrollY: 0, snap: 0, followPlayhead: true },
      playing: false,
      editorClipId: null,
      bottomPanel: 'mixer',
      focus: 'arrangement',
      toasts: [],
      keyboardEnabled: true,
      keyboardOctave: 4,
      keyboardVelocity: 0.8,
      busy: null,
      exportOpen: false,
      midiExportOpen: false,
    });
    this.startAnimationLoop();
  }

  get state(): AppState {
    return this.store.get();
  }

  get project(): Project {
    return this.history.project;
  }

  // -------------------------------------------------------------------------
  // history

  private syncHistory(): void {
    const h = this.history;
    const project = h.project;
    // Drop selections that point at things that no longer exist.
    const s = this.state;
    const selectedClipIds = s.selectedClipIds.filter((id) => findClip(project, id));
    const selectedTrackId = s.selectedTrackId && findTrack(project, s.selectedTrackId) ? s.selectedTrackId : null;
    const editorClip = s.editorClipId ? findClip(project, s.editorClipId) : undefined;
    this.store.set({
      project,
      canUndo: h.canUndo,
      canRedo: h.canRedo,
      undoLabel: h.undoLabel,
      redoLabel: h.redoLabel,
      dirty: h.isDirty,
      selectedClipIds: selectedClipIds.length === s.selectedClipIds.length ? s.selectedClipIds : selectedClipIds,
      selectedTrackId,
      editorClipId: editorClip?.clip.kind === 'midi' ? s.editorClipId : null,
    });
    this.engine?.setProject(project);
  }

  execute(cmd: Command): boolean {
    const changed = this.history.execute(cmd);
    if (changed) this.syncHistory();
    return changed;
  }

  /** End a continuous gesture so the next edit starts a new undo step. */
  endGesture(): void {
    this.history.closeMerge();
  }

  undo(): void {
    if (this.history.undo()) this.syncHistory();
  }

  redo(): void {
    if (this.history.redo()) this.syncHistory();
  }

  // -------------------------------------------------------------------------
  // toasts & UI state

  toast(message: string, kind: Toast['kind'] = 'error'): void {
    const id = ++this.toastId;
    this.store.set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => this.dismissToast(id), kind === 'error' ? 8000 : 4000);
  }

  dismissToast(id: number): void {
    this.store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  setView(patch: Partial<ViewState>): void {
    const v = { ...this.state.view, ...patch };
    v.pxPerBeat = Math.min(400, Math.max(2, v.pxPerBeat));
    v.scrollBeat = Math.max(0, v.scrollBeat);
    v.scrollY = Math.max(0, v.scrollY);
    this.store.set({ view: v });
  }

  /** Height of the visible track area (set by the timeline), for scroll clamping. */
  trackViewportHeight = 400;

  scrollTracksBy(dy: number): void {
    const maxY = Math.max(0, this.project.tracks.length * TRACK_HEIGHT + 120 - this.trackViewportHeight);
    this.setView({ scrollY: Math.min(maxY, Math.max(0, this.state.view.scrollY + dy)) });
  }

  selectClips(ids: Id[]): void {
    this.store.set({ selectedClipIds: ids, focus: 'arrangement' });
  }

  selectTrack(id: Id | null): void {
    this.store.set({ selectedTrackId: id });
  }

  setFocus(focus: FocusArea): void {
    this.store.set({ focus });
  }

  setBottomPanel(panel: BottomPanel): void {
    this.store.set({ bottomPanel: panel });
  }

  openEditor(clipId: Id): void {
    const loc = findClip(this.project, clipId);
    if (!loc || loc.clip.kind !== 'midi') return;
    this.store.set({ editorClipId: clipId, bottomPanel: 'editor', selectedTrackId: loc.track.id, selectedClipIds: [clipId], focus: 'editor' });
  }

  // -------------------------------------------------------------------------
  // engine

  /** Create the AudioContext and engine (must first run from a user gesture). */
  ensureEngine(): Promise<AudioEngine> {
    if (this.engine) {
      if (this.context?.state === 'suspended') void this.context.resume();
      return Promise.resolve(this.engine);
    }
    if (!this.enginePromise) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.context = ctx;
      this.enginePromise = AudioEngine.create(ctx, (id) => this.assets.get(id)?.buffer, { live: true })
        .then((engine) => {
          this.engine = engine;
          engine.setProject(this.project);
          engine.seek(this.stoppedPosition);
          return engine;
        })
        .catch((e: unknown) => {
          this.enginePromise = null;
          this.toast(`Audio engine failed to start: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        });
    }
    if (ctxSuspended(this.context)) void this.context!.resume();
    return this.enginePromise;
  }

  private startAnimationLoop(): void {
    const frame = () => {
      this.rafId = requestAnimationFrame(frame);
      const engine = this.engine;
      if (!engine) return;
      if (engine.isPlaying) this.position.set({ beat: engine.positionBeats() });
      this.meters.set({ snapshot: engine.meters() });
    };
    this.rafId = requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------------
  // transport

  async play(fromBeat?: number): Promise<void> {
    const engine = await this.ensureEngine();
    const from = fromBeat ?? this.position.get().beat;
    engine.play(from);
    this.store.set({ playing: true });
  }

  stop(): void {
    if (!this.state.playing) {
      // Stop while stopped returns to the start (or loop start).
      const target = this.project.loop.enabled && this.position.get().beat > this.project.loop.start ? this.project.loop.start : 0;
      this.seek(target);
      return;
    }
    this.engine?.stop();
    const beat = this.engine?.positionBeats() ?? this.position.get().beat;
    this.stoppedPosition = beat;
    this.position.set({ beat });
    this.store.set({ playing: false });
  }

  togglePlay(): void {
    if (this.state.playing) this.stop();
    else void this.play();
  }

  seek(beat: number): void {
    const b = Math.max(0, beat);
    this.stoppedPosition = b;
    this.position.set({ beat: b });
    this.engine?.seek(b);
  }

  toggleLoop(): void {
    this.execute(setLoop({ enabled: !this.project.loop.enabled }));
  }

  // -------------------------------------------------------------------------
  // computer keyboard / note preview

  liveNote(trackId: Id, pitch: number, on: boolean, velocity = this.state.keyboardVelocity): void {
    if (on) {
      void this.ensureEngine().then((e) => e.liveNote(trackId, pitch, velocity, true));
    } else {
      this.engine?.liveNote(trackId, pitch, velocity, false);
    }
  }

  /** Short audition of a note (piano roll clicks). */
  previewNote(trackId: Id, pitch: number, velocity = 0.8): void {
    this.liveNote(trackId, pitch, true, velocity);
    setTimeout(() => this.liveNote(trackId, pitch, false), 220);
  }

  // -------------------------------------------------------------------------
  // tracks & clips

  addTrack(kind: Track['kind']): void {
    const p = this.project;
    const track = createTrack(kind, nextTrackName(p, kind), nextTrackColor(p));
    const sel = this.state.selectedTrackId;
    const idx = sel ? p.tracks.findIndex((t) => t.id === sel) + 1 : undefined;
    this.execute(addTrack(track, idx));
    this.store.set({ selectedTrackId: track.id });
  }

  /** Create an empty one-bar MIDI clip at `beat` on a MIDI track, and open it. */
  createMidiClip(trackId: Id, beat: number, length?: number): void {
    const track = findTrack(this.project, trackId);
    if (!track || track.kind !== 'midi') return;
    const clip: MidiClip = {
      id: newId('c'),
      kind: 'midi',
      name: track.name,
      start: Math.max(0, beat),
      length: length ?? this.project.beatsPerBar,
      contentOffset: 0,
      notes: [],
    };
    if (this.execute(addClip(trackId, clip))) this.openEditor(clip.id);
  }

  /** Ableton-style "insert MIDI clip": at the playhead on the selected MIDI track. */
  insertMidiClipAtPlayhead(): void {
    const t = this.state.selectedTrackId ? findTrack(this.project, this.state.selectedTrackId) : undefined;
    if (!t || t.kind !== 'midi') {
      this.toast('Select a MIDI track first.', 'info');
      return;
    }
    const grid = effectiveGrid(this.state.view) || 1;
    this.createMidiClip(t.id, snapBeat(this.position.get().beat, grid));
  }

  deleteSelectedClips(): void {
    const ids = this.state.selectedClipIds;
    if (ids.length === 0) return;
    this.execute(deleteClips(ids));
    this.store.set({ selectedClipIds: [] });
  }

  duplicateSelectedClips(): void {
    const ids = this.state.selectedClipIds;
    if (ids.length === 0) return;
    const { command, newIds } = duplicateClips(this.project, ids);
    if (this.execute(command)) this.store.set({ selectedClipIds: newIds });
  }

  /** Split selected clips at the playhead; with no selection, split every clip under it. */
  splitAtPlayhead(): void {
    const beat = this.position.get().beat;
    let ids = this.state.selectedClipIds;
    if (ids.length === 0) ids = this.project.tracks.flatMap((t) => (t.clips as Clip[]).filter((c) => c.start < beat && c.start + c.length > beat).map((c) => c.id));
    if (ids.length === 0) return;
    this.execute(splitClips(ids, beat));
  }

  selectAllClips(): void {
    this.selectClips(this.project.tracks.flatMap((t) => (t.clips as Clip[]).map((c) => c.id)));
  }

  // -------------------------------------------------------------------------
  // audio import

  /**
   * Decode dropped audio files and create clips at `beat`. The first file goes
   * onto `trackId` if it is an audio track; the others (or all, when dropped
   * on empty space or a MIDI track) get new audio tracks stacked below.
   */
  async importAudioFiles(files: File[], trackId: Id | null, beat: number): Promise<void> {
    const audioFiles = files.filter((f) => {
      if (isAudioFile(f)) return true;
      if (!f.name.toLowerCase().endsWith(PROJECT_EXTENSION) && !isMidiFile(f)) this.toast(`"${f.name}" is not an audio file.`);
      return false;
    });
    if (audioFiles.length === 0) return;
    let engine: AudioEngine;
    try {
      engine = await this.ensureEngine();
    } catch {
      return;
    }
    this.store.set({ busy: `Decoding ${audioFiles.length} file${audioFiles.length > 1 ? 's' : ''}…` });
    const decoded: { file: File; asset: AudioAsset }[] = [];
    try {
      const results = await Promise.all(
        audioFiles.map(async (file) => {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            // decodeAudioData detaches the buffer it gets, so give it a copy.
            const buffer = await engine.ctx.decodeAudioData(bytes.slice().buffer);
            const id = newId('a');
            this.assets.add(id, bytes, buffer);
            const asset: AudioAsset = {
              id,
              fileName: file.name,
              mimeType: file.type || 'application/octet-stream',
              duration: buffer.duration,
              sampleRate: buffer.sampleRate,
              channels: buffer.numberOfChannels,
            };
            return { file, asset };
          } catch {
            this.toast(`Could not decode "${file.name}". The format may be unsupported by this browser.`);
            return null;
          }
        }),
      );
      for (const r of results) if (r) decoded.push(r);
    } finally {
      this.store.set({ busy: null });
    }
    if (decoded.length === 0) return;

    const p = this.project;
    const cmds: Command[] = [];
    const target = trackId ? findTrack(p, trackId) : undefined;
    let insertAt = target ? p.tracks.indexOf(target) + 1 : p.tracks.length;
    let colorIdx = p.tracks.length;
    const clipIds: Id[] = [];
    const start = Math.max(0, beat);
    decoded.forEach(({ file, asset }, i) => {
      cmds.push(addAsset(asset));
      let destId: Id;
      if (i === 0 && target?.kind === 'audio') {
        destId = target.id;
      } else {
        const color = TRACK_COLORS[colorIdx++ % TRACK_COLORS.length]!;
        const track = createTrack('audio', stripExtension(file.name), color);
        cmds.push(addTrack(track, insertAt++));
        destId = track.id;
      }
      const clip: AudioClip = {
        id: newId('c'),
        kind: 'audio',
        name: stripExtension(file.name),
        start,
        length: secondsToBeats(asset.duration, p.tempo),
        assetId: asset.id,
        sourceOffset: 0,
        gain: 1,
      };
      clipIds.push(clip.id);
      cmds.push(addClip(destId, clip));
    });
    this.execute(batch(decoded.length > 1 ? `Import ${decoded.length} audio files` : 'Import audio file', cmds));
    this.store.set({ selectedClipIds: clipIds });
  }

  // -------------------------------------------------------------------------
  // MIDI files

  /**
   * Import a Standard MIDI File as new MIDI tracks (one undo step), with
   * clips starting at `beat`. New tracks go below `trackId` if given, else at
   * the end. A malformed file shows an error toast and changes nothing.
   */
  async importMidiFile(file: File, beat: number, trackId: Id | null = null): Promise<void> {
    let plan;
    try {
      const imported = readMidiFile(new Uint8Array(await file.arrayBuffer()));
      const p = this.project;
      const target = trackId ? findTrack(p, trackId) : undefined;
      plan = planMidiImport(p, imported, {
        beat,
        insertIndex: target ? p.tracks.indexOf(target) + 1 : undefined,
        label: `Import MIDI "${stripExtension(file.name)}"`,
      });
    } catch (e) {
      this.toast(`Could not import "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.execute(plan.command)) {
      this.store.set({ selectedClipIds: plan.clipIds, selectedTrackId: plan.trackIds[0] ?? null });
    }
  }

  /** File → Import MIDI: pick a file and import it at the playhead. */
  async openMidiImport(): Promise<void> {
    let picked;
    try {
      picked = await openFile({ extension: MIDI_EXTENSIONS, mime: MIDI_MIME, description: 'MIDI file' });
    } catch (e) {
      this.toast(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!picked) return;
    const grid = effectiveGrid(this.state.view) || 1;
    await this.importMidiFile(picked.file, snapBeat(this.position.get().beat, grid), this.state.selectedTrackId);
  }

  setMidiExportOpen(open: boolean): void {
    this.store.set({ midiExportOpen: open });
  }

  /** File → Export MIDI: a format-1 .mid of the MIDI tracks (whole song or loop region). */
  async exportMidi(range: 'song' | 'loop'): Promise<void> {
    const project = this.project;
    this.store.set({ midiExportOpen: false });
    if (!project.tracks.some((t) => t.kind === 'midi')) {
      this.toast('Nothing to export: the project has no MIDI tracks.');
      return;
    }
    const startBeat = range === 'loop' ? project.loop.start : 0;
    const endBeat = range === 'loop' ? project.loop.end : projectEndBeat(project);
    if (endBeat <= startBeat) {
      this.toast('Nothing to export: the project has no clips.');
      return;
    }
    const safeName = (project.name.trim() || 'Untitled').replace(/[\\/:*?"<>|]/g, '_');
    try {
      const bytes = exportMidiFile(project, { startBeat, endBeat });
      const result = await saveBytes(bytes, { suggestedName: `${safeName}.mid`, mime: MIDI_MIME, extension: '.mid', description: 'MIDI file' });
      if (result) this.toast(`Exported ${result.name}`, 'info');
    } catch (e) {
      if (!isAbortError(e)) this.toast(`MIDI export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // project files

  /** Ask before discarding unsaved changes. */
  private confirmDiscard(): boolean {
    return !this.history.isDirty || window.confirm('You have unsaved changes. Discard them?');
  }

  private loadProject(project: Project, fileName: string | null): void {
    this.engine?.stop();
    this.history.reset(project);
    this.fileHandle = null;
    this.stoppedPosition = 0;
    this.position.set({ beat: 0 });
    this.store.set({
      fileName,
      playing: false,
      selectedClipIds: [],
      selectedTrackId: project.tracks[0]?.id ?? null,
      editorClipId: null,
      view: { ...this.state.view, scrollBeat: 0, scrollY: 0 },
    });
    this.syncHistory();
    this.engine?.seek(0);
  }

  newProject(): void {
    if (!this.confirmDiscard()) return;
    this.assets.clear();
    this.loadProject(createProject('Untitled'), null);
  }

  async openProject(): Promise<void> {
    if (!this.confirmDiscard()) return;
    let picked;
    try {
      picked = await openFile({ extension: PROJECT_EXTENSION, mime: PROJECT_MIME, description: 'MusicLab project' });
    } catch (e) {
      this.toast(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!picked) return;
    await this.openProjectFile(picked.file, picked.handle, false);
  }

  /** Load a .musiclab File (from the picker or a drop). */
  async openProjectFile(file: File, handle: FileSystemFileHandle | null, confirm = true): Promise<void> {
    if (confirm && !this.confirmDiscard()) return;
    this.store.set({ busy: `Opening ${file.name}…` });
    try {
      const bundle = readProjectFile(new Uint8Array(await file.arrayBuffer()));
      const engine = await this.ensureEngine();
      const fresh = new AssetStore();
      for (const asset of Object.values(bundle.project.assets)) {
        const bytes = bundle.audio.get(asset.id)!;
        let buffer: AudioBuffer;
        try {
          buffer = await engine.ctx.decodeAudioData(bytes.slice().buffer);
        } catch {
          throw new Error(`Could not decode embedded audio "${asset.fileName}".`);
        }
        fresh.add(asset.id, bytes, buffer);
      }
      this.assets.clear();
      for (const asset of Object.values(bundle.project.assets)) {
        const a = fresh.get(asset.id)!;
        this.assets.add(asset.id, a.bytes, a.buffer);
      }
      this.loadProject(bundle.project, file.name);
      this.fileHandle = handle;
      this.toast(`Opened ${file.name}`, 'info');
    } catch (e) {
      this.toast(`Could not open "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.store.set({ busy: null });
    }
  }

  async saveProject(saveAs = false): Promise<void> {
    const project = this.project;
    let bytes: Uint8Array;
    try {
      bytes = writeProjectFile({ project, audio: this.assets.bytesMap() });
    } catch (e) {
      this.toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const safeName = (project.name.trim() || 'Untitled').replace(/[\\/:*?"<>|]/g, '_');
    try {
      const result = await saveBytes(bytes, {
        suggestedName: `${safeName}${PROJECT_EXTENSION}`,
        mime: PROJECT_MIME,
        extension: PROJECT_EXTENSION,
        description: 'MusicLab project',
        handle: saveAs ? null : this.fileHandle,
      });
      if (!result) return;
      this.fileHandle = result.handle;
      // Only mark saved if nothing changed while we were writing.
      if (this.history.project === project) this.history.markSaved();
      this.store.set({ fileName: result.name, dirty: this.history.isDirty });
      this.toast(`Saved ${result.name}`, 'info');
    } catch (e) {
      if (isAbortError(e)) return;
      this.toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // WAV export

  setExportOpen(open: boolean): void {
    this.store.set({ exportOpen: open });
  }

  async exportWav(range: 'song' | 'loop', format: WavFormat): Promise<void> {
    const project = this.project;
    const startBeat = range === 'loop' ? project.loop.start : 0;
    const endBeat = range === 'loop' ? project.loop.end : projectEndBeat(project);
    if (endBeat <= startBeat) {
      this.toast('Nothing to export: the project has no clips.');
      return;
    }
    let sampleRate = 44100;
    try {
      sampleRate = (await this.ensureEngine()).ctx.sampleRate;
    } catch {
      return;
    }
    this.store.set({ busy: 'Rendering mix…', exportOpen: false });
    try {
      const rendered = await renderProject(project, (id) => this.assets.get(id)?.buffer, { startBeat, endBeat, tailSeconds: 2 }, sampleRate);
      const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
      const wav = encodeWav(channels, rendered.sampleRate, format);
      const safeName = (project.name.trim() || 'Untitled').replace(/[\\/:*?"<>|]/g, '_');
      const result = await saveBytes(wav, { suggestedName: `${safeName}.wav`, mime: 'audio/wav', extension: '.wav', description: 'WAV audio' });
      if (result) this.toast(`Exported ${result.name}`, 'info');
    } catch (e) {
      if (!isAbortError(e)) this.toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.store.set({ busy: null });
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.engine?.dispose();
    void this.context?.close();
  }
}

function ctxSuspended(ctx: AudioContext | null): boolean {
  return ctx !== null && ctx.state === 'suspended';
}

export const app = new AppController();
// Exposed for debugging and automated browser checks.
(window as unknown as { musiclab: AppController }).musiclab = app; // deliberate global for devtools
