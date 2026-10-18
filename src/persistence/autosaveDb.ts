/**
 * IndexedDB storage for crash recovery. Two object stores:
 *   sessions - one record per browser tab with unsaved changes, keyed by sessionId
 *   assets   - original audio file bytes, keyed by asset id, shared by sessions
 * Audio is written once per asset, not on every autosave; assets no session
 * references are pruned when a session is deleted.
 */
import type { Id, Project } from '../model/types';

export const AUTOSAVE_DB_NAME = 'musiclab-autosave';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const ASSETS = 'assets';

export interface AutosaveRecord {
  sessionId: string;
  /** Date.now() of the write. */
  savedAt: number;
  /** Name of the file the project was opened from or saved to, if any. */
  fileName: string | null;
  /** The project as written. Validate it with parseProject() before use. */
  project: Project;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function assetIdsOf(record: AutosaveRecord): string[] {
  const assets = (record.project as { assets?: unknown } | undefined)?.assets;
  return assets && typeof assets === 'object' ? Object.keys(assets) : [];
}

export class AutosaveDb {
  private constructor(private db: IDBDatabase) {}

  static open(factory: IDBFactory = indexedDB, name = AUTOSAVE_DB_NAME): Promise<AutosaveDb> {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
    };
    return promisify(req).then((db) => new AutosaveDb(db));
  }

  /**
   * Write a session record, plus the bytes of any asset it references that
   * the database doesn't hold yet, in one transaction.
   */
  async write(record: AutosaveRecord, bytes: (id: Id) => Uint8Array | undefined): Promise<void> {
    const tx = this.db.transaction([SESSIONS, ASSETS], 'readwrite');
    const finished = done(tx);
    const assets = tx.objectStore(ASSETS);
    for (const id of assetIdsOf(record)) {
      const req = assets.getKey(id);
      req.onsuccess = () => {
        if (req.result !== undefined) return;
        const data = bytes(id);
        if (data) assets.put(data, id);
      };
    }
    tx.objectStore(SESSIONS).put(record);
    await finished;
  }

  async sessions(): Promise<AutosaveRecord[]> {
    const tx = this.db.transaction(SESSIONS, 'readonly');
    return promisify(tx.objectStore(SESSIONS).getAll() as IDBRequest<AutosaveRecord[]>);
  }

  async session(sessionId: string): Promise<AutosaveRecord | undefined> {
    const tx = this.db.transaction(SESSIONS, 'readonly');
    return promisify(tx.objectStore(SESSIONS).get(sessionId) as IDBRequest<AutosaveRecord | undefined>);
  }

  /** Audio bytes for the given asset ids (missing ones are left out). */
  async assets(ids: Iterable<Id>): Promise<Map<Id, Uint8Array>> {
    const tx = this.db.transaction(ASSETS, 'readonly');
    const store = tx.objectStore(ASSETS);
    const out = new Map<Id, Uint8Array>();
    await Promise.all(
      [...ids].map(async (id) => {
        const data = (await promisify(store.get(id))) as Uint8Array | undefined;
        if (data) out.set(id, data);
      }),
    );
    return out;
  }

  /** Delete a session record and every asset no remaining session references. */
  async deleteSession(sessionId: string): Promise<void> {
    const tx = this.db.transaction([SESSIONS, ASSETS], 'readwrite');
    const finished = done(tx);
    const sessions = tx.objectStore(SESSIONS);
    const assets = tx.objectStore(ASSETS);
    sessions.delete(sessionId);
    const all = sessions.getAll() as IDBRequest<AutosaveRecord[]>;
    all.onsuccess = () => {
      const used = new Set(all.result.flatMap(assetIdsOf));
      const keys = assets.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) if (!used.has(String(key))) assets.delete(key);
      };
    };
    await finished;
  }

  close(): void {
    this.db.close();
  }
}
