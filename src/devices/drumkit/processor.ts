/** AudioWorklet module for DrumKit (see processorHost.ts for the protocol). */
import { registerInstrumentProcessor } from '../processorHost';
import { drumkitDefinition } from './definition';
import { DrumCore } from './drumCore';

registerInstrumentProcessor(drumkitDefinition.processorName, (sr, params) => new DrumCore(sr, params));
