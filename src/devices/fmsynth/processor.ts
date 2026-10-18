/** AudioWorklet module for FMSynth (see processorHost.ts for the protocol). */
import { registerInstrumentProcessor } from '../processorHost';
import { fmsynthDefinition } from './definition';
import { FmCore } from './fmCore';

registerInstrumentProcessor(fmsynthDefinition.processorName, (sr, params) => new FmCore(sr, params));
