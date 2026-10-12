import { useSyncExternalStore } from 'react';

/** Minimal external store for React (no dependencies). */
export class Store<T extends object> {
  private state: T;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  set(patch: Partial<T> | ((s: T) => Partial<T>)): void {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof T)[]) {
      if (this.state[k] !== p[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** Subscribe a component to a slice of a store. The selector must return a stable value. */
export function useStore<T extends object, R>(store: Store<T>, selector: (s: T) => R): R {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
