import { effectDefinition } from '../define';

export const FILTER_MODES = ['Low-pass', 'High-pass', 'Band-pass'];
/** LFO periods in beats ('bar' = the project's beats per bar). */
export const FILTER_LFO_RATES: { label: string; beats: number; bars: boolean }[] = [
  { label: 'Off', beats: 0, bars: false },
  { label: '1/16', beats: 0.25, bars: false },
  { label: '1/8', beats: 0.5, bars: false },
  { label: '1/4', beats: 1, bars: false },
  { label: '1/2', beats: 2, bars: false },
  { label: '1 bar', beats: 1, bars: true },
  { label: '2 bars', beats: 2, bars: true },
  { label: '4 bars', beats: 4, bars: true },
];

/** State-variable filter with an optional tempo-synced LFO on cutoff. */
export const filterDefinition = effectDefinition({
  type: 'filter',
  name: 'Filter',
  params: [
    { kind: 'enum', id: 'mode', name: 'Mode', options: FILTER_MODES, default: 0, group: 'Filter' },
    { kind: 'continuous', id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, default: 1000, scale: 'log', unit: 'Hz', group: 'Filter' },
    { kind: 'continuous', id: 'resonance', name: 'Resonance', min: 0, max: 1, default: 0.3, scale: 'linear', group: 'Filter' },
    { kind: 'enum', id: 'lfoRate', name: 'LFO Rate', options: FILTER_LFO_RATES.map((r) => r.label), default: 0, group: 'LFO' },
    { kind: 'continuous', id: 'lfoDepth', name: 'LFO Depth', min: 0, max: 4, default: 1, scale: 'linear', unit: 'oct', group: 'LFO' },
  ],
});
