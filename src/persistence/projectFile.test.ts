import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createEffectSlot } from '../model/project';
import { fixture } from '../model/testUtil';
import { SCHEMA_VERSION, type MidiTrack, type Project } from '../model/types';
import { migrate, parseProject, ProjectFormatError } from '../model/validate';
import { readProjectFile, writeProjectFile } from './projectFile';

const audio = () => new Map([['a1', Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4, 250])]]);

describe('.musiclab round trip', () => {
  it('save -> open yields an identical project and audio bytes', () => {
    const project = fixture();
    const bytes = writeProjectFile({ project, audio: audio() });
    const opened = readProjectFile(bytes);
    expect(opened.project).toEqual(project);
    expect(opened.audio.get('a1')).toEqual(audio().get('a1'));
    // and again: stable
    const again = readProjectFile(writeProjectFile(opened));
    expect(again.project).toEqual(project);
  });

  it('drops unreferenced assets on save', () => {
    const project = fixture();
    const withExtra = { ...project, assets: { ...project.assets, z: { id: 'z', fileName: 'z.wav', mimeType: 'audio/wav', duration: 1, sampleRate: 1, channels: 1 } } };
    const opened = readProjectFile(writeProjectFile({ project: withExtra, audio: audio() }));
    expect(Object.keys(opened.project.assets)).toEqual(['a1']);
  });

  it('rejects garbage and missing pieces', () => {
    expect(() => readProjectFile(Uint8Array.from([1, 2, 3]))).toThrow(ProjectFormatError);
    expect(() => readProjectFile(zipSync({ 'x.txt': strToU8('hi') }))).toThrow(/project.json missing/);
    expect(() => readProjectFile(zipSync({ 'project.json': strToU8(JSON.stringify(fixture())) }))).toThrow(/missing from the archive/);
    expect(() => readProjectFile(zipSync({ 'project.json': strToU8('{nope') }))).toThrow(/not valid JSON/);
  });
});

describe('parseProject', () => {
  it('accepts a valid project', () => {
    expect(parseProject(JSON.parse(JSON.stringify(fixture())))).toEqual(fixture());
  });

  it('rejects newer schema versions and bad fields', () => {
    expect(() => parseProject({ ...fixture(), schemaVersion: 99 })).toThrow(/newer MusicLab/);
    expect(() => parseProject({ ...fixture(), tempo: 'fast' })).toThrow(/tempo/);
    const p = fixture();
    expect(() => parseProject({ ...p, assets: {} })).toThrow(/missing asset/);
    expect(() => parseProject({ ...p, loop: { enabled: true, start: 4, end: 2 } })).toThrow(/loop/);
  });

  it('fills missing device params with defaults', () => {
    const raw = JSON.parse(JSON.stringify(fixture()));
    delete raw.tracks[1].instrument.params.cutoff;
    raw.tracks[1].instrument.params.bogus = 3;
    const p = parseProject(raw);
    const inst = (p.tracks[1] as { instrument: { params: Record<string, number> } }).instrument.params;
    expect(inst.cutoff).toBe(2200);
    expect(inst.bogus).toBeUndefined();
  });
});

describe('schema migration', () => {
  /** A project.json exactly as schema 1 wrote it. */
  const v1 = () => {
    const raw = JSON.parse(JSON.stringify(fixture()));
    raw.schemaVersion = 1;
    return raw;
  };

  it('upgrades a schema 1 document to the current schema without changing its content', () => {
    const doc = v1();
    const frozen = structuredClone(doc);
    const migrated = migrate(doc);
    expect(doc).toEqual(frozen); // input not mutated
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parseProject(doc)).toEqual(fixture());
  });

  it('drops stray expression keys from schema 1 MIDI clips', () => {
    const doc = v1();
    doc.tracks[1].clips[0].bends = 'not a list';
    doc.tracks[1].clips[0].ccs = [{ junk: true }];
    const p = parseProject(doc);
    const clip = (p.tracks[1] as MidiTrack).clips[0]!;
    expect('bends' in clip).toBe(false);
    expect('ccs' in clip).toBe(false);
  });

  it('opens a schema 1 .musiclab file', () => {
    const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(v1())), 'audio/a1/loop.wav': audio().get('a1')! });
    expect(readProjectFile(bytes).project).toEqual(fixture());
  });

  it('rejects a missing or nonsensical version', () => {
    const { schemaVersion: _v, ...rest } = fixture();
    expect(() => parseProject(rest)).toThrow(/schemaVersion/);
    expect(() => parseProject({ ...fixture(), schemaVersion: 0 })).toThrow(/schemaVersion/);
  });
});

describe('MIDI expression in project files', () => {
  const expressive = (): Project => {
    const p = fixture();
    const m = p.tracks[1] as MidiTrack;
    const clip = { ...m.clips[0]!, bends: [{ beat: 0.5, semitones: -1.25 }, { beat: 1, semitones: 0 }], ccs: [{ beat: 0, controller: 74, value: 127 }] };
    return { ...p, tracks: [p.tracks[0]!, { ...m, clips: [clip] }] };
  };

  it('save -> open keeps bends and CCs', () => {
    const project = expressive();
    expect(readProjectFile(writeProjectFile({ project, audio: audio() })).project).toEqual(project);
  });

  it('validates bends and CCs', () => {
    const bad = (patch: object) => {
      const raw = JSON.parse(JSON.stringify(expressive()));
      Object.assign(raw.tracks[1].clips[0], patch);
      return () => parseProject(raw);
    };
    expect(bad({ bends: [{ beat: 0, semitones: 'up' }] })).toThrow(/semitones/);
    expect(bad({ ccs: [{ beat: 0, controller: 128, value: 1 }] })).toThrow(/controller/);
    expect(bad({ ccs: [{ beat: 0, controller: 1, value: 1.5 }] })).toThrow(/integer/);
    expect(bad({ bends: {} })).toThrow(/bends/);
  });
});

describe('insert effects in project files', () => {
  const withChains = (): Project => {
    const p = fixture();
    return {
      ...p,
      master: { ...p.master, effects: [{ id: 'fx1', type: 'reverb', params: { ...createEffectSlot('reverb')!.params, decay: 4.5 }, bypass: false }] },
      tracks: p.tracks.map((t, i) => ({
        ...t,
        effects: i === 0 ? [] : [
          { id: 'fx2', type: 'eq3', params: createEffectSlot('eq3')!.params, bypass: true },
          { id: 'fx3', type: 'delay', params: { ...createEffectSlot('delay')!.params, feedback: 0.7 }, bypass: false },
        ],
      })),
    };
  };

  /** project.json exactly as schema 2 wrote it: no effect chains anywhere. */
  const v2 = () => {
    const raw = JSON.parse(JSON.stringify(fixture()));
    raw.schemaVersion = 2;
    delete raw.master.effects;
    for (const t of raw.tracks) delete t.effects;
    return raw;
  };

  it('migrates schema 2 by giving every track and the master an empty chain', () => {
    const doc = v2();
    const frozen = structuredClone(doc);
    const migrated = migrate(doc);
    expect(doc).toEqual(frozen);
    expect(migrated.schemaVersion).toBe(3);
    expect((migrated.master as { effects: unknown[] }).effects).toEqual([]);
    expect((migrated.tracks as { effects: unknown[] }[]).every((t) => Array.isArray(t.effects) && t.effects.length === 0)).toBe(true);
    expect(parseProject(doc)).toEqual(fixture());
  });

  it('save -> open keeps chains, order, params and bypass', () => {
    const project = withChains();
    const opened = readProjectFile(writeProjectFile({ project, audio: audio() })).project;
    expect(opened).toEqual(project);
    expect(opened.tracks[1]!.effects.map((e) => e.id)).toEqual(['fx2', 'fx3']);
  });

  it('rejects unknown effect types and other bad slots with a clear message', () => {
    const bad = (mutate: (raw: ReturnType<typeof v2>) => void) => {
      const raw = JSON.parse(JSON.stringify(withChains()));
      mutate(raw);
      return () => parseProject(raw);
    };
    expect(bad((r) => (r.tracks[1].effects[0].type = 'flanger'))).toThrow('tracks[1].effects[0].type: unknown effect type "flanger"');
    expect(bad((r) => (r.master.effects[0].type = 'subsynth'))).toThrow('unknown effect type "subsynth"');
    expect(bad((r) => (r.tracks[1].effects[1].id = 'fx2'))).toThrow(/duplicate effect id/);
    expect(bad((r) => delete r.tracks[0].effects)).toThrow(/tracks\[0\]\.effects: expected array/);
    expect(bad((r) => (r.tracks[1].effects[0].bypass = 'yes'))).toThrow(/bypass/);
    expect(bad((r) => (r.tracks[1].instrument.type = 'reverb'))).toThrow(/not an instrument/);
  });

  it('clamps out-of-range effect params and fills missing ones', () => {
    const raw = JSON.parse(JSON.stringify(withChains()));
    raw.tracks[1].effects[1].params.feedback = 5;
    delete raw.tracks[1].effects[1].params.mix;
    const p = parseProject(raw);
    expect(p.tracks[1]!.effects[1]!.params.feedback).toBe(0.95);
    expect(p.tracks[1]!.effects[1]!.params.mix).toBe(0.3);
  });
});
