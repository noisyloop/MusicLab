import type { DeviceDefinition, ParamDescriptor } from '../types';

/** Algorithm names: how the four operators connect (→ means "modulates"). */
export const FM_ALGORITHMS = [
  '1: 4→3→2→1',
  '2: 3+4→2→1',
  '3: 3→2→1, 4→1',
  '4: 4→3→1, 2→1',
  '5: 2→1, 4→3',
  '6: 4→1, 2, 3',
  '7: 4→3, 1, 2',
  '8: 1, 2, 3, 4',
] as const;

interface OperatorDefaults {
  ratio: number;
  level: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

function operatorParams(n: number, d: OperatorDefaults): ParamDescriptor[] {
  const group = `Op ${n}`;
  return [
    { kind: 'continuous', id: `op${n}Ratio`, name: 'Ratio', min: 0.5, max: 16, default: d.ratio, scale: 'log', unit: '×', step: 0.5, group },
    { kind: 'continuous', id: `op${n}Level`, name: 'Level', min: 0, max: 1, default: d.level, scale: 'linear', group },
    { kind: 'continuous', id: `op${n}Attack`, name: 'Attack', min: 0.001, max: 4, default: d.attack, scale: 'log', unit: 's', group },
    { kind: 'continuous', id: `op${n}Decay`, name: 'Decay', min: 0.001, max: 8, default: d.decay, scale: 'log', unit: 's', group },
    { kind: 'continuous', id: `op${n}Sustain`, name: 'Sustain', min: 0, max: 1, default: d.sustain, scale: 'linear', group },
    { kind: 'continuous', id: `op${n}Release`, name: 'Release', min: 0.001, max: 4, default: d.release, scale: 'log', unit: 's', group },
  ];
}

/**
 * Parameter descriptors for the built-in 4-operator FM synth. The defaults
 * are an electric piano: a 1:1 pair for the body and a 1:14 pair for the
 * tine's attack, both brighter the harder you play.
 */
export const fmsynthDefinition: DeviceDefinition = {
  type: 'fmsynth',
  name: 'FMSynth',
  kind: 'instrument',
  processorName: 'musiclab-fmsynth',
  numberOfInputs: 0,
  outputChannelCount: 2,
  params: [
    { kind: 'enum', id: 'algorithm', name: 'Algorithm', options: [...FM_ALGORITHMS], default: 4, group: 'Algorithm' },
    { kind: 'continuous', id: 'feedback', name: 'Feedback', min: 0, max: 1, default: 0, scale: 'linear', group: 'Algorithm' },
    { kind: 'continuous', id: 'octave', name: 'Octave', min: -2, max: 2, default: 0, scale: 'linear', step: 1, group: 'Algorithm' },

    ...operatorParams(1, { ratio: 1, level: 0.8, attack: 0.002, decay: 3, sustain: 0, release: 0.5 }),
    ...operatorParams(2, { ratio: 1, level: 0.35, attack: 0.002, decay: 1.2, sustain: 0.1, release: 0.5 }),
    ...operatorParams(3, { ratio: 1, level: 0.5, attack: 0.002, decay: 1, sustain: 0, release: 0.4 }),
    ...operatorParams(4, { ratio: 14, level: 0.2, attack: 0.001, decay: 0.25, sustain: 0, release: 0.2 }),

    { kind: 'continuous', id: 'velMod', name: 'Vel→Mod', min: 0, max: 1, default: 0.8, scale: 'linear', group: 'Output' },
    { kind: 'continuous', id: 'velSens', name: 'Vel Sens', min: 0, max: 1, default: 0.6, scale: 'linear', group: 'Output' },
    { kind: 'continuous', id: 'gain', name: 'Gain', min: 0, max: 1, default: 0.5, scale: 'linear', group: 'Output' },

    { kind: 'continuous', id: 'bendRange', name: 'Bend Range', min: 0, max: 24, default: 2, scale: 'linear', unit: 'st', step: 1, group: 'MIDI' },
    { kind: 'continuous', id: 'brightCc', name: 'Bright CC', min: 0, max: 127, default: 20, scale: 'linear', unit: 'cc', step: 1, group: 'MIDI' },
  ],
};
