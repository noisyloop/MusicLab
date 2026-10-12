/** AudioWorklet module for SubSynth (see processorHost.ts for the protocol). */
import { registerInstrumentProcessor } from '../processorHost';
import { subsynthDefinition } from './definition';
import { SynthCore } from './synthCore';

registerInstrumentProcessor(subsynthDefinition.processorName, (sr, params) => new SynthCore(sr, params));
