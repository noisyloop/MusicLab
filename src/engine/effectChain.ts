/**
 * One insert-effect chain (a track's or the master's): input -> effect 1 ->
 * ... -> effect N -> output. update() diffs the model's slots against what is
 * running:
 *   - parameter changes only post a `params` message;
 *   - bypass changes post `bypass` (the processor crossfades, no rewire);
 *   - adding, removing or reordering effects rewires this chain only. Live,
 *     the output ducks to silence over 5 ms, the chain is rewired, and it
 *     fades back in over 5 ms, so the change is click-free. Effects that stay
 *     keep their state (delay and reverb tails continue).
 * Effect nodes are never reset on transport stop, so tails ring out.
 */
import type { TransportEvent } from '../devices/types';
import type { EffectSlot, Id } from '../model/types';
import { WorkletDevice } from './workletDevice';

/** Duck time on each side of a rewire. */
export const REWIRE_FADE_S = 0.005;
/** Wall-clock wait before rewiring, so the duck has reached silence. */
const REWIRE_WAIT_MS = 12;

export interface ChainDiff {
  added: EffectSlot[];
  removed: Id[];
  params: { id: Id; values: Record<string, number> }[];
  bypass: { id: Id; bypass: boolean }[];
  /** True when the signal order changed (add, remove or reorder). */
  rewire: boolean;
}

/** What has to happen to turn the running chain `prev` into `next`. Pure. */
export function diffChain(prev: readonly EffectSlot[], next: readonly EffectSlot[]): ChainDiff {
  const before = new Map(prev.map((s) => [s.id, s]));
  const after = new Set(next.map((s) => s.id));
  const diff: ChainDiff = { added: [], removed: [], params: [], bypass: [], rewire: false };
  for (const s of prev) if (!after.has(s.id)) diff.removed.push(s.id);
  for (const s of next) {
    const old = before.get(s.id);
    // A slot whose type changed is a different device: replace it.
    if (!old || old.type !== s.type) {
      if (old) diff.removed.push(s.id);
      diff.added.push(s);
      continue;
    }
    if (old.params !== s.params) {
      const values: Record<string, number> = {};
      let any = false;
      for (const [k, v] of Object.entries(s.params)) {
        if (old.params[k] !== v) {
          values[k] = v;
          any = true;
        }
      }
      if (any) diff.params.push({ id: s.id, values });
    }
    if (old.bypass !== s.bypass) diff.bypass.push({ id: s.id, bypass: s.bypass });
  }
  diff.rewire = diff.added.length > 0 || diff.removed.length > 0 || prev.map((s) => s.id).join('|') !== next.map((s) => s.id).join('|');
  return diff;
}

export class EffectChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private devices = new Map<Id, WorkletDevice>();
  private slots: readonly EffectSlot[] = [];
  private retired: WorkletDevice[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly live: boolean,
    slots: readonly EffectSlot[],
    /** Transport updates a newly created effect starts from. */
    private readonly transport: () => TransportEvent[],
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    for (const s of slots) this.devices.set(s.id, this.createDevice(s));
    this.slots = slots;
    this.wire();
  }

  private createDevice(s: EffectSlot): WorkletDevice {
    return new WorkletDevice(this.ctx, s.type, s.params, { bypass: s.bypass, transport: this.transport() });
  }

  update(next: readonly EffectSlot[]): void {
    if (next === this.slots) return;
    const diff = diffChain(this.slots, next);
    for (const id of diff.removed) {
      const d = this.devices.get(id);
      if (d) this.retired.push(d);
      this.devices.delete(id);
    }
    for (const s of diff.added) this.devices.set(s.id, this.createDevice(s));
    for (const p of diff.params) this.devices.get(p.id)?.setParams(p.values);
    for (const b of diff.bypass) this.devices.get(b.id)?.setBypass(b.bypass);
    this.slots = next;
    if (diff.rewire) this.scheduleRewire();
  }

  private scheduleRewire(): void {
    if (!this.live) {
      this.wire();
      return;
    }
    if (this.timer !== null) return; // the pending rewire will use the latest slots
    const g = this.output.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + REWIRE_FADE_S);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wire();
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(1, t + REWIRE_FADE_S);
    }, REWIRE_WAIT_MS);
  }

  /** Connect input -> effects (model order) -> output, and drop removed devices. */
  private wire(): void {
    this.input.disconnect();
    for (const d of this.devices.values()) d.node.disconnect();
    for (const d of this.retired) d.dispose();
    this.retired = [];
    let prev: AudioNode = this.input;
    for (const s of this.slots) {
      const d = this.devices.get(s.id);
      if (!d) continue;
      prev.connect(d.node);
      prev = d.node;
    }
    prev.connect(this.output);
  }

  sendTransport(t: TransportEvent): void {
    for (const d of this.devices.values()) d.sendTransport(t);
  }

  /** Latest meter values reported by effects that have one (e.g. compressor gain reduction). */
  collectMeters(into: Record<Id, number>): void {
    for (const [id, d] of this.devices) into[id] = d.meterValue;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const d of [...this.devices.values(), ...this.retired]) d.dispose();
    this.devices.clear();
    this.retired = [];
    this.input.disconnect();
    this.output.disconnect();
  }
}
