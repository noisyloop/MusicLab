/**
 * Crash recovery. While a project has unsaved changes, this tab's copy of it
 * is mirrored into IndexedDB (debounced). When the project becomes clean
 * (saved, opened, new, or undone back to the saved state) the copy is deleted.
 * On startup, a copy left by a tab that is no longer open is offered for
 * restore. Open tabs are told apart with Web Locks: each tab holds a lock
 * named after its session id for as long as it lives.
 */
import { pruneAssets } from '../persistence/projectFile';
import type { AutosaveDb, AutosaveRecord } from '../persistence/autosaveDb';
import type { Id, Project } from '../model/types';

export interface AutosaveSnapshot {
  project: Project;
  fileName: string | null;
}

export interface AutosaverOptions {
  /** Write this long after the last change. */
  delayMs?: number;
  /** ...but never later than this after the first unwritten change. */
  maxWaitMs?: number;
  now?: () => number;
}

const LOCK_PREFIX = 'musiclab-session:';

export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  /** Serializes writes and deletes so they land in call order. */
  private queue: Promise<void> = Promise.resolve();
  /** This session has a record in the database (or one is being written). */
  private stored = false;
  private failing = false;
  private readonly delayMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: AutosaveDb,
    readonly sessionId: string,
    /** The current unsaved state, or null when there is nothing to save. */
    private readonly snapshot: () => AutosaveSnapshot | null,
    private readonly bytes: (id: Id) => Uint8Array | undefined,
    private readonly onError: (e: unknown) => void,
    opts: AutosaverOptions = {},
  ) {
    this.delayMs = opts.delayMs ?? 1000;
    this.maxWaitMs = opts.maxWaitMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  /** Call after every change. Writes if there are unsaved changes, else deletes this session's copy. */
  changed(): void {
    if (!this.snapshot()) {
      this.clear();
      return;
    }
    const t = this.now();
    if (this.timer === null) this.firstPendingAt = t;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delayMs, this.firstPendingAt + this.maxWaitMs - t));
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  /** Write a pending change now (e.g. when the page is hidden). */
  flush(): Promise<void> {
    if (this.timer === null) return this.queue;
    clearTimeout(this.timer);
    this.timer = null;
    return this.enqueue(async () => {
      const snap = this.snapshot();
      if (!snap) return;
      const record: AutosaveRecord = {
        sessionId: this.sessionId,
        savedAt: this.now(),
        fileName: snap.fileName,
        project: pruneAssets(snap.project),
      };
      this.stored = true;
      await this.db.write(record, this.bytes);
    });
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.stored) return;
    this.stored = false;
    void this.enqueue(() => this.db.deleteSession(this.sessionId));
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job).then(
      () => {
        this.failing = false;
      },
      (e: unknown) => {
        // Report once per run of failures, not on every write.
        if (!this.failing) this.onError(e);
        this.failing = true;
      },
    );
    return this.queue;
  }
}

/**
 * The most recent record left by a session that is no longer open, if any.
 * `live` holds the session ids of open tabs (including this one).
 */
export function pickRecoverable(records: AutosaveRecord[], live: ReadonlySet<string>): AutosaveRecord | undefined {
  let best: AutosaveRecord | undefined;
  for (const r of records) if (!live.has(r.sessionId) && (!best || r.savedAt > best.savedAt)) best = r;
  return best;
}

/** Hold a Web Lock for this session's lifetime so other tabs know it is open. */
export function holdSessionLock(sessionId: string): void {
  void navigator.locks?.request(LOCK_PREFIX + sessionId, () => new Promise<never>(() => undefined));
}

/** Session ids of every open tab. Without Web Locks, only this tab's. */
export async function liveSessionIds(self: string): Promise<Set<string>> {
  const live = new Set([self]);
  try {
    const snap = await navigator.locks?.query();
    for (const l of snap?.held ?? []) if (l.name?.startsWith(LOCK_PREFIX)) live.add(l.name.slice(LOCK_PREFIX.length));
  } catch {
    // No Web Locks: any record that isn't ours is treated as recoverable.
  }
  return live;
}
