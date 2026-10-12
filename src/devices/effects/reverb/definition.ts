import { effectDefinition } from '../define';

/** Freeverb-style algorithmic reverb with an RT60 decay control. */
export const reverbDefinition = effectDefinition({
  type: 'reverb',
  name: 'Reverb',
  params: [
    { kind: 'continuous', id: 'size', name: 'Size', min: 0, max: 1, default: 0.5, scale: 'linear', group: 'Reverb' },
    { kind: 'continuous', id: 'decay', name: 'Decay', min: 0.2, max: 20, default: 2.5, scale: 'log', unit: 's', group: 'Reverb' },
    { kind: 'continuous', id: 'preDelay', name: 'Pre-delay', min: 0, max: 200, default: 10, scale: 'linear', unit: 'ms', group: 'Reverb' },
    { kind: 'continuous', id: 'damping', name: 'Damping', min: 0, max: 1, default: 0.4, scale: 'linear', group: 'Tone' },
    { kind: 'continuous', id: 'width', name: 'Width', min: 0, max: 1, default: 1, scale: 'linear', group: 'Tone' },
    { kind: 'continuous', id: 'mix', name: 'Dry/Wet', min: 0, max: 1, default: 0.25, scale: 'linear', group: 'Output' },
  ],
  tailSeconds: (p) => ((p.mix ?? 0) > 0 ? (p.preDelay ?? 0) / 1000 + (p.decay ?? 0) : 0),
});
