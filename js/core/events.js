/**
 * Panorama Maps — core/events.js
 * Tiny synchronous event emitter. No dependencies.
 */
export class EventBus {
  constructor() { this._listeners = new Map(); }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => { off(); fn(payload); });
    return off;
  }

  off(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[events] listener for "${type}" failed`, err); }
    }
  }

  clear() { this._listeners.clear(); }
}
