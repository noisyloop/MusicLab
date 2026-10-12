import { describe, expect, it } from 'vitest';
import { createEffectSlot } from '../model/project';
import { fixture } from '../model/testUtil';
import type { EffectSlot, Project } from '../model/types';
import { diffChain } from './effectChain';
import { BASE_TAIL_S, chainTailSeconds, exportTailSeconds, MAX_TAIL_S } from './tails';

const slot = (id: string, type = 'eq3', extra: Partial<EffectSlot> = {}): EffectSlot => ({ ...createEffectSlot(type)!, id, ...extra });

describe('diffChain', () => {
  const a = slot('a');
  const b = slot('b', 'delay');
  const c = slot('c', 'reverb');

  it('a param change only updates params; bypass only toggles bypass', () => {
    const next = [{ ...a, params: { ...a.params, midGain: 3 } }, b];
    expect(diffChain([a, b], next)).toEqual({ added: [], removed: [], params: [{ id: 'a', values: { midGain: 3 } }], bypass: [], rewire: false });
    expect(diffChain([a, b], [a, { ...b, bypass: true }])).toEqual({ added: [], removed: [], params: [], bypass: [{ id: 'b', bypass: true }], rewire: false });
    expect(diffChain([a, b], [a, b]).rewire).toBe(false);
  });

  it('add, remove and reorder rewire', () => {
    expect(diffChain([a], [a, c])).toMatchObject({ added: [c], removed: [], rewire: true });
    expect(diffChain([a, b], [b])).toMatchObject({ added: [], removed: ['a'], rewire: true });
    expect(diffChain([a, b], [b, a])).toMatchObject({ added: [], removed: [], params: [], rewire: true });
    expect(diffChain([a], [{ ...a, type: 'delay' }])).toMatchObject({ removed: ['a'], added: [{ id: 'a', type: 'delay' }], rewire: true });
  });
});

describe('export tail', () => {
  const tempo = 120;
  it('is the base tail without active time-based effects', () => {
    expect(exportTailSeconds(fixture())).toBe(BASE_TAIL_S);
    const p: Project = { ...fixture(), master: { volume: 1, effects: [slot('r', 'reverb', { bypass: true }), slot('e')] } };
    expect(exportTailSeconds(p)).toBe(BASE_TAIL_S);
  });

  it('grows with the longest track chain plus the master chain, capped at 10 s', () => {
    const delay = slot('d', 'delay', { params: { ...createEffectSlot('delay')!.params, sync: 7, feedback: 0.5 } }); // 1/4 at 120 = 0.5 s
    const delayTail = 0.5 * (1 + Math.log(0.001) / Math.log(0.5));
    expect(chainTailSeconds([delay], tempo, 4)).toBeCloseTo(delayTail);
    const reverb = slot('r', 'reverb', { params: { ...createEffectSlot('reverb')!.params, decay: 2, preDelay: 0 } });
    const p = fixture();
    const q: Project = { ...p, tracks: [{ ...p.tracks[0]!, effects: [delay] }, { ...p.tracks[1]!, effects: [reverb] }], master: { volume: 1, effects: [reverb] } };
    expect(exportTailSeconds(q)).toBeCloseTo(BASE_TAIL_S + Math.max(delayTail, 2) + 2);
    const huge: Project = { ...q, master: { volume: 1, effects: [slot('x', 'reverb', { params: { ...reverb.params, decay: 20 } })] } };
    expect(exportTailSeconds(huge)).toBe(MAX_TAIL_S);
  });
});
