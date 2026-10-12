import type { DeviceDefinition } from './types';
import { drumkitDefinition } from './drumkit/definition';
import { subsynthDefinition } from './subsynth/definition';

const definitions: Record<string, DeviceDefinition> = {
  [subsynthDefinition.type]: subsynthDefinition,
  [drumkitDefinition.type]: drumkitDefinition,
};

export function getDeviceDefinition(type: string): DeviceDefinition | undefined {
  return definitions[type];
}

export function listDeviceDefinitions(): DeviceDefinition[] {
  return Object.values(definitions);
}
