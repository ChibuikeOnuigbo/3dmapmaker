/**
 * packages/project — undo/redo history (REQUIREMENT 124, 125).
 *
 * Snapshots are structural, but we coalesce high-frequency edits (sculpt
 * strokes, gizmo drags) so a 10-second drag does not push 600 entries.
 */
import type { Project } from './schema';

export interface HistoryOptions {
  maxEntries?: number;
  /** Edits with the same tag within this window are merged into one entry. */
  coalesceMs?: number;
}

export interface HistoryEntry {
  label: string;
  tag: string | null;
  timestamp: number;
  snapshot: string;
}

export class History {
  private entries: HistoryEntry[] = [];
  private cursor = -1;
  private readonly maxEntries: number;
  private readonly coalesceMs: number;

  constructor(initial: Project, opts: HistoryOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 200;
    this.coalesceMs = opts.coalesceMs ?? 700;
    this.entries = [{ label: 'Initial', tag: null, timestamp: Date.now(), snapshot: JSON.stringify(initial) }];
    this.cursor = 0;
  }

  get canUndo() {
    return this.cursor > 0;
  }
  get canRedo() {
    return this.cursor < this.entries.length - 1;
  }
  get size() {
    return this.entries.length;
  }
  get labels() {
    return this.entries.map((e) => e.label);
  }

  /**
   * Record a new state. Pass `tag` for coalesceable interactions
   * (e.g. 'sculpt', 'transform') so a continuous gesture becomes one undo step.
   */
  push(next: Project, label: string, tag: string | null = null): void {
    const snapshot = JSON.stringify(next);
    const now = Date.now();
    const current = this.entries[this.cursor];
    if (current && current.snapshot === snapshot) return; // no-op edit

    if (tag && current && current.tag === tag && now - current.timestamp < this.coalesceMs) {
      current.snapshot = snapshot;
      current.timestamp = now;
      current.label = label;
      return;
    }

    // Drop any redo branch — a new edit invalidates it.
    this.entries = this.entries.slice(0, this.cursor + 1);
    this.entries.push({ label, tag, timestamp: now, snapshot });
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.cursor = this.entries.length - 1;
  }

  undo(): Project | null {
    if (!this.canUndo) return null;
    this.cursor--;
    return JSON.parse(this.entries[this.cursor].snapshot) as Project;
  }

  redo(): Project | null {
    if (!this.canRedo) return null;
    this.cursor++;
    return JSON.parse(this.entries[this.cursor].snapshot) as Project;
  }

  peek(): Project {
    return JSON.parse(this.entries[this.cursor].snapshot) as Project;
  }

  /** Force the next push to start a new coalescing group (e.g. pointerup). */
  breakCoalesce(): void {
    const cur = this.entries[this.cursor];
    if (cur) cur.tag = null;
  }

  clear(next: Project): void {
    this.entries = [{ label: 'Initial', tag: null, timestamp: Date.now(), snapshot: JSON.stringify(next) }];
    this.cursor = 0;
  }
}
