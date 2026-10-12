/** AudioWorklet module for the eq3 effect (see effectHost.ts). */
import { registerEffectProcessor } from '../effectHost';
import { Eq3Core } from './core';
import { eq3Definition } from './definition';

registerEffectProcessor(eq3Definition.processorName, (sr, params) => new Eq3Core(sr, params));
