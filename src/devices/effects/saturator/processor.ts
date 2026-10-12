/** AudioWorklet module for the saturator effect (see effectHost.ts). */
import { registerEffectProcessor } from '../effectHost';
import { SaturatorCore } from './core';
import { saturatorDefinition } from './definition';

registerEffectProcessor(saturatorDefinition.processorName, (sr, params) => new SaturatorCore(sr, params));
