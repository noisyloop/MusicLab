import { effectDefinition } from '../define';
import { DELAY_DIVISIONS, divisionBeats } from '../dsp';

export const DELAY_SYNC_OPTIONS = ['Free', ...DELAY_DIVISIONS.map((d) => d.label)];
/** Longest delay time the line can hold. */
export const MAX_DELAY_S = 5;

/** Delay time in seconds for these params at a tempo. */
export function delayTimeSeconds(params: Record<string, number>, tempo: number, beatsPerBar: number): number {
  const sync = Math.round(params.sync ?? 0);
  const div = DELAY_DIVISIONS[sync - 1];
  const s = div ? (divisionBeats(div, beatsPerBar) * 60) / tempo : (params.time ?? 375) / 1000;
  return Math.min(MAX_DELAY_S, Math.max(0.001, s));
}

/** Tempo-syncable stereo / ping-pong delay with filters in the feedback path. */
export const delayDefinition = effectDefinition({
  type: 'delay',
  name: 'Delay',
  params: [
    { kind: 'enum', id: 'sync', name: 'Sync', options: DELAY_SYNC_OPTIONS, default: DELAY_SYNC_OPTIONS.indexOf('1/8.'), group: 'Time' },
    { kind: 'continuous', id: 'time', name: 'Time', min: 1, max: 2000, default: 375, scale: 'log', unit: 'ms', group: 'Time' },
    { kind: 'continuous', id: 'feedback', name: 'Feedback', min: 0, max: 0.95, default: 0.4, scale: 'linear', group: 'Time' },
    { kind: 'enum', id: 'pingPong', name: 'Ping-Pong', options: ['Off', 'On'], default: 0, group: 'Time' },
    { kind: 'continuous', id: 'lowpass', name: 'Low-pass', min: 200, max: 20000, default: 8000, scale: 'log', unit: 'Hz', group: 'Filter' },
    { kind: 'continuous', id: 'highpass', name: 'High-pass', min: 20, max: 2000, default: 60, scale: 'log', unit: 'Hz', group: 'Filter' },
    { kind: 'continuous', id: 'mix', name: 'Dry/Wet', min: 0, max: 1, default: 0.3, scale: 'linear', group: 'Output' },
  ],
  tailSeconds: (params, { tempo, beatsPerBar }) => {
    const t = delayTimeSeconds(params, tempo, beatsPerBar);
    const fb = params.feedback ?? 0;
    // Echoes until the feedback has decayed by 60 dB.
    const repeats = fb > 0.001 ? Math.log(0.001) / Math.log(fb) : 0;
    return (params.mix ?? 0) > 0 ? t * (1 + repeats) : 0;
  },
});
