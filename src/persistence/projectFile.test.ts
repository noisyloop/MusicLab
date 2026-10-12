import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fixture } from '../model/testUtil';
import { parseProject, ProjectFormatError } from '../model/validate';
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
