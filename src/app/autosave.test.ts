import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { setTempo } from '../model/commands';
import { History } from '../model/history';
import { fixture } from '../model/testUtil';
import type { Project } from '../model/types';
import { AutosaveDb, type AutosaveRecord } from '../persistence/autosaveDb';
import { Autosaver, pickRecoverable } from './autosave';

const bytesA1 = Uint8Array.from([1, 2, 3]);
const rec = (sessionId: string, savedAt: number, project: Project = fixture()): AutosaveRecord => ({ sessionId, savedAt, fileName: null, project });

describe('AutosaveDb', () => {
  let db: AutosaveDb;
  beforeEach(async () => {
    db = await AutosaveDb.open(new IDBFactory());
  });
  afterEach(() => db.close());

  it('stores sessions and writes each asset only once', async () => {
    const bytes = vi.fn(() => bytesA1);
    await db.write(rec('s1', 1), bytes);
    await db.write(rec('s1', 2), bytes);
    expect(bytes).toHaveBeenCalledTimes(1);
    const sessions = await db.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.savedAt).toBe(2);
    expect(sessions[0]!.project).toEqual(fixture());
    expect((await db.assets(['a1', 'nope'])).get('a1')).toEqual(bytesA1);
    expect(await db.session('s1')).toBeDefined();
    expect(await db.session('s2')).toBeUndefined();
  });

  it('deleting a session prunes only the assets no other session uses', async () => {
    const other: Project = { ...fixture(), assets: { ...fixture().assets, a2: { ...fixture().assets.a1!, id: 'a2' } } };
    await db.write(rec('s1', 1), () => bytesA1);
    await db.write(rec('s2', 1, other), () => bytesA1);
    await db.deleteSession('s2');
    expect([...(await db.assets(['a1', 'a2'])).keys()]).toEqual(['a1']);
    await db.deleteSession('s1');
    expect((await db.assets(['a1'])).size).toBe(0);
    expect(await db.sessions()).toEqual([]);
  });

  it('rewrites an asset that was pruned while a session still needs it', async () => {
    await db.write(rec('s1', 1), () => bytesA1);
    await db.deleteSession('s1');
    await db.write(rec('s2', 2), () => bytesA1);
    expect((await db.assets(['a1'])).get('a1')).toEqual(bytesA1);
  });
});

describe('Autosaver', () => {
  let t = 0;
  let dirty: Project | null;
  let db: { write: ReturnType<typeof vi.fn>; deleteSession: ReturnType<typeof vi.fn> };
  let onError: Mock<(e: unknown) => void>;
  let saver: Autosaver;

  beforeEach(() => {
    vi.useFakeTimers();
    t = 0;
    dirty = fixture();
    db = { write: vi.fn(() => Promise.resolve()), deleteSession: vi.fn(() => Promise.resolve()) };
    onError = vi.fn();
    saver = new Autosaver(
      db as unknown as AutosaveDb,
      's1',
      () => (dirty ? { project: dirty, fileName: 'x.musiclab' } : null),
      () => bytesA1,
      onError,
      { delayMs: 1000, maxWaitMs: 5000, now: () => t },
    );
  });
  afterEach(() => vi.useRealTimers());

  const advance = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('debounces writes', async () => {
    saver.changed();
    await advance(500);
    saver.changed();
    await advance(900);
    expect(db.write).not.toHaveBeenCalled();
    await advance(100);
    expect(db.write).toHaveBeenCalledTimes(1);
    const [record] = db.write.mock.calls[0]!;
    expect(record).toMatchObject({ sessionId: 's1', savedAt: 1500, fileName: 'x.musiclab' });
  });

  it('writes at least every maxWait during continuous edits', async () => {
    for (let i = 0; i < 20; i++) {
      saver.changed();
      await advance(400);
    }
    // 8 s of edits 400 ms apart: writes at 5 s, then again 5 s after the next change.
    expect(db.write).toHaveBeenCalledTimes(1);
  });

  it('deletes its record when the project becomes clean, and only if one was written', async () => {
    dirty = null;
    saver.changed();
    expect(db.deleteSession).not.toHaveBeenCalled();
    dirty = fixture();
    saver.changed();
    await saver.flush();
    dirty = null;
    saver.changed();
    saver.changed();
    await advance(0);
    expect(db.deleteSession).toHaveBeenCalledTimes(1);
    expect(db.deleteSession).toHaveBeenCalledWith('s1');
  });

  it('cancels a pending write when the project becomes clean', async () => {
    saver.changed();
    dirty = null;
    saver.changed();
    await advance(2000);
    expect(db.write).not.toHaveBeenCalled();
  });

  it('reports a run of failures once', async () => {
    db.write.mockRejectedValue(new Error('quota'));
    for (let i = 0; i < 3; i++) {
      saver.changed();
      await saver.flush();
    }
    expect(onError).toHaveBeenCalledTimes(1);
    db.write.mockResolvedValue(undefined);
    saver.changed();
    await saver.flush();
    db.write.mockRejectedValue(new Error('quota'));
    saver.changed();
    await saver.flush();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('drops unreferenced assets from the written project', async () => {
    dirty = { ...fixture(), assets: { ...fixture().assets, gone: { ...fixture().assets.a1!, id: 'gone' } } };
    saver.changed();
    await saver.flush();
    expect(Object.keys((db.write.mock.calls[0]![0] as AutosaveRecord).project.assets)).toEqual(['a1']);
  });
});

describe('pickRecoverable', () => {
  it('picks the newest record of a session that is not open', () => {
    const records = [rec('old', 1), rec('open', 9), rec('closed', 5)];
    expect(pickRecoverable(records, new Set(['open']))?.sessionId).toBe('closed');
    expect(pickRecoverable(records, new Set(['open', 'closed', 'old']))).toBeUndefined();
    expect(pickRecoverable([], new Set())).toBeUndefined();
  });
});

describe('History.reset', () => {
  it('can start dirty (a restored autosave) until saved', () => {
    const h = new History(fixture());
    h.reset(fixture(), false);
    expect(h.isDirty).toBe(true);
    h.execute(setTempo(100));
    h.undo();
    expect(h.isDirty).toBe(true);
    h.markSaved();
    expect(h.isDirty).toBe(false);
  });
});
