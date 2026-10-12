/** AudioWorklet module for the reverb effect (see effectHost.ts). */
import { registerEffectProcessor } from '../effectHost';
import { ReverbCore } from './core';
import { reverbDefinition } from './definition';

registerEffectProcessor(reverbDefinition.processorName, (sr, params) => new ReverbCore(sr, params));
