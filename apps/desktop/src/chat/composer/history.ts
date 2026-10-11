// Undo/redo for the live editor. The browser's own stack is useless here because every edit is applied (and re-rendered) by us.
import type { EditKind } from './edit';

export interface Snapshot {
  value: string;
  start: number;
  end: number;
}

interface Entry {
  before: Snapshot;
  after: Snapshot;
  kind: EditKind;
  at: number;
}

const COALESCE_MS = 1000;
const MAX_ENTRIES = 200;

const same = (a: Snapshot, b: Snapshot) => a.value === b.value && a.start === b.start && a.end === b.end;

export class EditHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  /** Record one edit. Typing (and consecutive deletes) within a second of each other merges into the previous entry. */
  record(before: Snapshot, after: Snapshot, kind: EditKind, now: number): void {
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && now - top.at < COALESCE_MS && same(top.after, before)) {
      // a space or newline closes the word group it ends; the next character starts a new one
      const closes = kind === 'typeBreak' && top.kind === 'type';
      if (closes || ((kind === 'type' || kind === 'delete') && top.kind === kind)) {
        top.after = after;
        top.at = now;
        if (closes) top.kind = 'typeBreak';
        return;
      }
    }
    this.undoStack.push({ before, after, kind, at: now });
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
  }

  /** The state to go back to, or null. */
  undo(): Snapshot | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry.before;
  }

  redo(): Snapshot | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry.after;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
