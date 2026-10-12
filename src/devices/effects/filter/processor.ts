/** AudioWorklet module for the filter effect (see effectHost.ts). */
import { registerEffectProcessor } from '../effectHost';
import { FilterCore } from './core';
import { filterDefinition } from './definition';

registerEffectProcessor(filterDefinition.processorName, (sr, params) => new FilterCore(sr, params));
