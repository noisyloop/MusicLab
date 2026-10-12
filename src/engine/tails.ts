/** How long a WAV export keeps rendering after the last beat. */
import { getEffectDefinition } from '../devices/registry';
import type { EffectSlot, Project } from '../model/types';

/** Room for instrument releases when no effect needs more. */
export const BASE_TAIL_S = 2;
/** Upper bound on the export tail, however long the effects ring. */
export const MAX_TAIL_S = 10;

/** Tail (seconds) of a chain: effects in series, so their active tails add up. */
export function chainTailSeconds(effects: readonly EffectSlot[], tempo: number, beatsPerBar: number): number {
  let total = 0;
  for (const e of effects) {
    if (e.bypass) continue;
    const t = getEffectDefinition(e.type)?.tailSeconds?.(e.params, { tempo, beatsPerBar }) ?? 0;
    if (Number.isFinite(t) && t > 0) total += t;
  }
  return total;
}

/**
 * Export tail: the base 2 s plus the longest track-chain tail plus the master
 * chain's tail (a track's echoes still pass through the master reverb),
 * capped at 10 s.
 */
export function exportTailSeconds(project: Project): number {
  const { tempo, beatsPerBar } = project;
  let tracks = 0;
  for (const t of project.tracks) tracks = Math.max(tracks, chainTailSeconds(t.effects, tempo, beatsPerBar));
  const master = chainTailSeconds(project.master.effects, tempo, beatsPerBar);
  return Math.min(MAX_TAIL_S, BASE_TAIL_S + tracks + master);
}
