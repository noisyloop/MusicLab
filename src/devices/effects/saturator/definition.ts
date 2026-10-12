import { effectDefinition } from '../define';

export const SATURATOR_CURVES = ['Soft clip', 'Tanh', 'Wavefold'];

/** Waveshaping saturator, 2x oversampled. */
export const saturatorDefinition = effectDefinition({
  type: 'saturator',
  name: 'Saturator',
  params: [
    { kind: 'continuous', id: 'drive', name: 'Drive', min: 0, max: 36, default: 6, scale: 'linear', unit: 'dB', group: 'Saturator' },
    { kind: 'enum', id: 'curve', name: 'Curve', options: SATURATOR_CURVES, default: 0, group: 'Saturator' },
    { kind: 'continuous', id: 'tone', name: 'Tone', min: 500, max: 20000, default: 12000, scale: 'log', unit: 'Hz', group: 'Saturator' },
    { kind: 'continuous', id: 'output', name: 'Output', min: -24, max: 6, default: 0, scale: 'linear', unit: 'dB', group: 'Output' },
    { kind: 'continuous', id: 'mix', name: 'Dry/Wet', min: 0, max: 1, default: 1, scale: 'linear', group: 'Output' },
  ],
});
