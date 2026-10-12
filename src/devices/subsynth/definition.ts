import type { DeviceDefinition } from '../types';

export const SUBSYNTH_WAVES = ['Saw', 'Square', 'Triangle', 'Sine'] as const;

/** Parameter descriptors for the built-in polyphonic subtractive synth. */
export const subsynthDefinition: DeviceDefinition = {
  type: 'subsynth',
  name: 'SubSynth',
  kind: 'instrument',
  processorName: 'musiclab-subsynth',
  numberOfInputs: 0,
  outputChannelCount: 2,
  params: [
    { kind: 'enum', id: 'wave', name: 'Wave', options: [...SUBSYNTH_WAVES], default: 0, group: 'Oscillator' },
    { kind: 'continuous', id: 'osc2Mix', name: 'Osc 2', min: 0, max: 1, default: 0.5, scale: 'linear', group: 'Oscillator' },
    { kind: 'continuous', id: 'detune', name: 'Detune', min: 0, max: 50, default: 8, scale: 'linear', unit: 'ct', group: 'Oscillator' },
    { kind: 'continuous', id: 'octave', name: 'Octave', min: -2, max: 2, default: 0, scale: 'linear', group: 'Oscillator' },

    { kind: 'continuous', id: 'cutoff', name: 'Cutoff', min: 30, max: 18000, default: 2200, scale: 'log', unit: 'Hz', group: 'Filter' },
    { kind: 'continuous', id: 'resonance', name: 'Reso', min: 0, max: 1, default: 0.2, scale: 'linear', group: 'Filter' },
    { kind: 'continuous', id: 'envAmount', name: 'Env Amt', min: 0, max: 1, default: 0.4, scale: 'linear', group: 'Filter' },
    { kind: 'continuous', id: 'fAttack', name: 'F Attack', min: 0.001, max: 4, default: 0.005, scale: 'log', unit: 's', group: 'Filter Env' },
    { kind: 'continuous', id: 'fDecay', name: 'F Decay', min: 0.001, max: 4, default: 0.3, scale: 'log', unit: 's', group: 'Filter Env' },
    { kind: 'continuous', id: 'fSustain', name: 'F Sustain', min: 0, max: 1, default: 0.2, scale: 'linear', group: 'Filter Env' },
    { kind: 'continuous', id: 'fRelease', name: 'F Release', min: 0.001, max: 4, default: 0.3, scale: 'log', unit: 's', group: 'Filter Env' },

    { kind: 'continuous', id: 'attack', name: 'Attack', min: 0.001, max: 4, default: 0.005, scale: 'log', unit: 's', group: 'Amp Env' },
    { kind: 'continuous', id: 'decay', name: 'Decay', min: 0.001, max: 4, default: 0.2, scale: 'log', unit: 's', group: 'Amp Env' },
    { kind: 'continuous', id: 'sustain', name: 'Sustain', min: 0, max: 1, default: 0.7, scale: 'linear', group: 'Amp Env' },
    { kind: 'continuous', id: 'release', name: 'Release', min: 0.001, max: 4, default: 0.25, scale: 'log', unit: 's', group: 'Amp Env' },

    { kind: 'continuous', id: 'velSens', name: 'Vel Sens', min: 0, max: 1, default: 0.7, scale: 'linear', group: 'Output' },
    { kind: 'continuous', id: 'gain', name: 'Gain', min: 0, max: 1, default: 0.5, scale: 'linear', group: 'Output' },
  ],
};
