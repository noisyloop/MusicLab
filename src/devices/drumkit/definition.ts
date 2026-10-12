import type { DeviceDefinition, ParamDescriptor } from '../types';

/** Voice groups of the DrumKit; each gets a Level and a Tune knob. */
export const DRUM_GROUPS = [
  { id: 'kick', name: 'Kick' },
  { id: 'snare', name: 'Snare' },
  { id: 'hats', name: 'Hats' },
  { id: 'toms', name: 'Toms' },
  { id: 'rim', name: 'Rim' },
  { id: 'clap', name: 'Clap' },
  { id: 'blips', name: 'Blips' },
] as const;

export type DrumGroup = (typeof DRUM_GROUPS)[number]['id'];

export const levelParam = (g: DrumGroup) => `${g}Level`;
export const tuneParam = (g: DrumGroup) => `${g}Tune`;

/** Parameter descriptors for the built-in synthesized General MIDI drum kit. */
export const drumkitDefinition: DeviceDefinition = {
  type: 'drumkit',
  name: 'DrumKit',
  kind: 'instrument',
  processorName: 'musiclab-drumkit',
  numberOfInputs: 0,
  outputChannelCount: 2,
  params: DRUM_GROUPS.flatMap((g): ParamDescriptor[] => [
    { kind: 'continuous', id: levelParam(g.id), name: 'Level', min: 0, max: 1, default: 0.8, scale: 'linear', group: g.name },
    { kind: 'continuous', id: tuneParam(g.id), name: 'Tune', min: -12, max: 12, default: 0, scale: 'linear', unit: 'st', group: g.name },
  ]),
};
