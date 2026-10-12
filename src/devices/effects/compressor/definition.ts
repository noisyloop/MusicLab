import { effectDefinition } from '../define';

/** Feed-forward stereo-linked compressor with a soft knee. */
export const compressorDefinition = effectDefinition({
  type: 'compressor',
  name: 'Compressor',
  params: [
    { kind: 'continuous', id: 'threshold', name: 'Threshold', min: -60, max: 0, default: -18, scale: 'linear', unit: 'dB', group: 'Compressor' },
    { kind: 'continuous', id: 'ratio', name: 'Ratio', min: 1, max: 20, default: 4, scale: 'log', unit: 'ratio', group: 'Compressor' },
    { kind: 'continuous', id: 'attack', name: 'Attack', min: 0.1, max: 100, default: 10, scale: 'log', unit: 'ms', group: 'Compressor' },
    { kind: 'continuous', id: 'release', name: 'Release', min: 10, max: 1000, default: 120, scale: 'log', unit: 'ms', group: 'Compressor' },
    { kind: 'continuous', id: 'knee', name: 'Knee', min: 0, max: 24, default: 6, scale: 'linear', unit: 'dB', group: 'Compressor' },
    { kind: 'continuous', id: 'makeup', name: 'Makeup', min: 0, max: 24, default: 0, scale: 'linear', unit: 'dB', group: 'Compressor' },
  ],
});
