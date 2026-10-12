import type { DeviceDefinition } from './types';
import { drumkitDefinition } from './drumkit/definition';
import { compressorDefinition } from './effects/compressor/definition';
import { delayDefinition } from './effects/delay/definition';
import { eq3Definition } from './effects/eq3/definition';
import { filterDefinition } from './effects/filter/definition';
import { reverbDefinition } from './effects/reverb/definition';
import { saturatorDefinition } from './effects/saturator/definition';
import { subsynthDefinition } from './subsynth/definition';

const definitions: Record<string, DeviceDefinition> = {
  [subsynthDefinition.type]: subsynthDefinition,
  [drumkitDefinition.type]: drumkitDefinition,
};

/** Insert effects, in the order the "+" menu lists them. */
export const EFFECT_DEFINITIONS: DeviceDefinition[] = [
  eq3Definition,
  compressorDefinition,
  saturatorDefinition,
  filterDefinition,
  delayDefinition,
  reverbDefinition,
];
for (const d of EFFECT_DEFINITIONS) definitions[d.type] = d;

export function getDeviceDefinition(type: string): DeviceDefinition | undefined {
  return definitions[type];
}

export function listDeviceDefinitions(): DeviceDefinition[] {
  return Object.values(definitions);
}

export function getEffectDefinition(type: string): DeviceDefinition | undefined {
  const d = definitions[type];
  return d?.kind === 'effect' ? d : undefined;
}
