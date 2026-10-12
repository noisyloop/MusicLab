import type { Command } from './commands';
import type { Project } from './types';

interface Entry {
  label: string;
  before: Project;
  after: Project;
  mergeKey?: string;
  time: number;
}

/** How long consecutive commands with the same mergeKey keep merging. */
const MERGE_WINDOW_MS = 1500;
const MAX_ENTRIES = 500;

/**
 * Undo/redo stack over immutable project snapshots. Because projects are
 * immutable with structural sharing, storing before/after states is cheap
 * and makes undo exact for every command.
 */
export class History {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private current: Project;
  private saved: Project;
  private mergeOpen = true;

  constructor(initial: Project, private now: () => number = () => Date.now()) {
    this.current = initial;
    this.saved = initial;
  }

  get project(): Project {
    return this.current;
  }

  /** Apply a command. Returns true if the project changed. */
  execute(command: Command): boolean {
    const before = this.current;
    const after = command.apply(before);
    if (after === before) return false;
    const t = this.now();
    const last = this.past[this.past.length - 1];
    if (last && this.mergeOpen && command.mergeKey && last.mergeKey === command.mergeKey && t - last.time < MERGE_WINDOW_MS) {
      last.after = after;
      last.time = t;
    } else {
      this.past.push({ label: command.label, before, after, mergeKey: command.mergeKey, time: t });
      if (this.past.length > MAX_ENTRIES) this.past.shift();
    }
    this.mergeOpen = true;
    this.future = [];
    this.current = after;
    return true;
  }

  /** Stop the next command from merging into the previous one (e.g. on pointer up). */
  closeMerge(): void {
    this.mergeOpen = false;
  }

  undo(): boolean {
    const e = this.past.pop();
    if (!e) return false;
    this.future.push(e);
    this.current = e.before;
    this.mergeOpen = false;
    return true;
  }

  redo(): boolean {
    const e = this.future.pop();
    if (!e) return false;
    this.past.push(e);
    this.current = e.after;
    this.mergeOpen = false;
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string | undefined {
    return this.past[this.past.length - 1]?.label;
  }
  get redoLabel(): string | undefined {
    return this.future[this.future.length - 1]?.label;
  }

  /** Replace everything (new/opened project). */
  reset(project: Project): void {
    this.past = [];
    this.future = [];
    this.current = project;
    this.saved = project;
  }

  markSaved(): void {
    this.saved = this.current;
  }

  get isDirty(): boolean {
    return this.current !== this.saved;
  }
}
