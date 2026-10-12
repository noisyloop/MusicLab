/** AudioWorklet module for the compressor effect (see effectHost.ts). */
import { registerEffectProcessor } from '../effectHost';
import { CompressorCore } from './core';
import { compressorDefinition } from './definition';

registerEffectProcessor(compressorDefinition.processorName, (sr, params) => new CompressorCore(sr, params));
