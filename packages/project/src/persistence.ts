/**
 * packages/project — persistence (REQUIREMENT 124, 125, 127).
 *
 * - Debounced writes: we never serialise the scene on every frame.
 * - Autosave is a separate, more frequent slot so a crash loses at most a few
 *   seconds even when the user has not triggered a save.
 * - Every write is versioned; every read validates + migrates before use.
 * - All storage is localStorage/IndexedDB. Nothing is uploaded (REQ 120).
 */
import type { Project } from './schema';
import { SCHEMA_VERSION, loadProject, validateProject } from './schema';

export const PROJECT_KEY = '3dmm.project';
export const AUTOSAVE_KEY = '3dmm.autosave';
export const AUTOSAVE_META_KEY = '3dmm.autosave.meta';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory fallback so tests and SSR do not explode on a missing localStorage. */
export function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export function resolveStorage(preferred?: StorageLike | null): StorageLike {
  if (preferred) return preferred;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* privacy mode / sandboxed iframe */
  }
  return memoryStorage();
}

/* ---------------------------------------------------------- debounced save --- */

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface SaveControllerEvents {
  onStatus?(status: SaveStatus, detail?: string): void;
  onAutosave?(at: number): void;
}

export class SaveController {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private lastSavedAt = 0;
  private status: SaveStatus = 'idle';
  private storage: StorageLike;

  constructor(
    private readonly events: SaveControllerEvents = {},
    storage?: StorageLike | null,
    private readonly debounceMs = 800,
    private readonly autosaveMs = 5000,
  ) {
    this.storage = resolveStorage(storage);
  }

  getStatus(): SaveStatus {
    return this.status;
  }
  getLastSavedAt(): number {
    return this.lastSavedAt;
  }
  isDirty(): boolean {
    return this.dirty;
  }

  private setStatus(s: SaveStatus, detail?: string) {
    this.status = s;
    this.events.onStatus?.(s, detail);
  }

  markDirty(): void {
    this.dirty = true;
    this.setStatus('pending');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Immediately persist. Returns false + an actionable error on failure. */
  flush(project?: Project): boolean {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!project) {
      this.dirty = false;
      return true;
    }
    this.setStatus('saving');
    try {
      const validation = validateProject(project);
      if (!validation.ok) {
        const first = validation.issues[0];
        this.setStatus('error', `${first.code} at ${first.path}: ${first.message}`);
        return false;
      }
      const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, savedAt: Date.now(), project });
      this.storage.setItem(PROJECT_KEY, payload);
      this.dirty = false;
      this.lastSavedAt = Date.now();
      this.setStatus('saved');
      return true;
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  startAutosave(getProject: () => Project): void {
    this.stopAutosave();
    this.autosaveTimer = setInterval(() => {
      const project = getProject();
      try {
        const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, savedAt: Date.now(), project });
        this.storage.setItem(AUTOSAVE_KEY, payload);
        this.storage.setItem(AUTOSAVE_META_KEY, JSON.stringify({ savedAt: Date.now(), name: project.name }));
        this.events.onAutosave?.(Date.now());
      } catch (err) {
        this.setStatus('error', `Autosave failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.autosaveMs);
  }

  stopAutosave(): void {
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  dispose(): void {
    this.stopAutosave();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
}

/* ----------------------------------------------------------------- loading --- */

export interface LoadResult {
  project: Project;
  source: 'project' | 'autosave' | 'none';
  savedAt: number;
  appliedMigrations: number[];
  issues: string[];
}

export function readSaved(storage: StorageLike, key: string): LoadResult | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { project?: unknown; savedAt?: number };
    const { project, appliedMigrations } = loadProject(parsed.project ?? parsed);
    const validation = validateProject(project);
    return {
      project,
      source: key === AUTOSAVE_KEY ? 'autosave' : 'project',
      savedAt: parsed.savedAt ?? 0,
      appliedMigrations,
      issues: validation.issues.map((i) => `${i.code}: ${i.message}`),
    };
  } catch (err) {
    // Corrupt blob: never throw at the caller, they need an actionable error.
    return {
      project: null as unknown as Project,
      source: 'none',
      savedAt: 0,
      appliedMigrations: [],
      issues: [`Unreadable ${key}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Recovery order used on cold start: explicit save first, then autosave.
 * A corrupt explicit save falls through to the autosave slot instead of
 * losing the user's work.
 */
export function recover(storage: StorageLike): { result: LoadResult | null; warnings: string[] } {
  const warnings: string[] = [];
  const primary = readSaved(storage, PROJECT_KEY);
  if (primary && primary.project) return { result: primary, warnings };
  if (primary) warnings.push(...primary.issues);

  const autosave = readSaved(storage, AUTOSAVE_KEY);
  if (autosave && autosave.project) {
    warnings.push('Recovered from autosave because the last explicit save was unreadable.');
    warnings.push(...autosave.issues);
    return { result: autosave, warnings };
  }
  if (autosave) warnings.push(...autosave.issues);
  return { result: null, warnings };
}

export function clearAutosave(storage: StorageLike): void {
  storage.removeItem(AUTOSAVE_KEY);
  storage.removeItem(AUTOSAVE_META_KEY);
}
