import { effectDefinition } from '../define';

/** Three-band EQ (low shelf, peaking mid, high shelf) plus a low-cut. */
export const eq3Definition = effectDefinition({
  type: 'eq3',
  name: 'EQ3',
  params: [
    { kind: 'continuous', id: 'lowCut', name: 'Low Cut', min: 20, max: 1000, default: 20, scale: 'log', unit: 'Hz', group: 'Low Cut' },
    { kind: 'continuous', id: 'lowFreq', name: 'Low Freq', min: 30, max: 1000, default: 120, scale: 'log', unit: 'Hz', group: 'Low' },
    { kind: 'continuous', id: 'lowGain', name: 'Low Gain', min: -18, max: 18, default: 0, scale: 'linear', unit: 'dB', group: 'Low' },
    { kind: 'continuous', id: 'midFreq', name: 'Mid Freq', min: 100, max: 10000, default: 1000, scale: 'log', unit: 'Hz', group: 'Mid' },
    { kind: 'continuous', id: 'midGain', name: 'Mid Gain', min: -18, max: 18, default: 0, scale: 'linear', unit: 'dB', group: 'Mid' },
    { kind: 'continuous', id: 'midQ', name: 'Mid Q', min: 0.2, max: 8, default: 1, scale: 'log', unit: 'q', group: 'Mid' },
    { kind: 'continuous', id: 'highFreq', name: 'High Freq', min: 1000, max: 18000, default: 6000, scale: 'log', unit: 'Hz', group: 'High' },
    { kind: 'continuous', id: 'highGain', name: 'High Gain', min: -18, max: 18, default: 0, scale: 'linear', unit: 'dB', group: 'High' },
  ],
});
