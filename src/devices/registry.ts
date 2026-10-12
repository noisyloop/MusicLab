import type { DeviceDefinition } from './types';
import { subsynthDefinition } from './subsynth/definition';

const definitions: Record<string, DeviceDefinition> = {
  [subsynthDefinition.type]: subsynthDefinition,
};

export function getDeviceDefinition(type: string): DeviceDefinition | undefined {
  return definitions[type];
}

export function listDeviceDefinitions(): DeviceDefinition[] {
  return Object.values(definitions);
}
