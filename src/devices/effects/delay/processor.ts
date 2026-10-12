/** AudioWorklet module for the delay effect (see effectHost.ts). */
import { registerEffectProcessor } from '../effectHost';
import { DelayCore } from './core';
import { delayDefinition } from './definition';

registerEffectProcessor(delayDefinition.processorName, (sr, params) => new DelayCore(sr, params));
