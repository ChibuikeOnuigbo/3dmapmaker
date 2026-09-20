/**
 * apps/web — place search (REQUIREMENT 081).
 *
 * Provider-abstracted and offline-first: the default provider searches the
 * authored layers and bookmarks in the open document, which always works. A
 * network provider can be registered, but it is opt-in, its key is held only as
 * an opaque reference in project state, and no query leaves the machine unless
 * you pick that provider yourself.
 */
import React, { useState } from 'react';
import { Badge, Button, Panel, TextField } from '@3dmm/ui';
import { findNode } from '@3dmm/layers';
import { TangentFrame, geo } from '@3dmm/gis';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

interface Hit {
  id: string;
  label: string;
  subtitle: string;
  position: { x: number; y: number; z: number };
}

/** Search the open document — layers, bookmarks and tour stops. */
function searchLocal(query: string): Hit[] {
  const s = useStore.getState();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Hit[] = [];
  const stack = [...s.project.layers];
  while (stack.length) {
    const n = stack.pop()!;
    for (const c of n.children) stack.push(c);
    if ((n.name || n.kind).toLowerCase().includes(q)) {
      hits.push({ id: n.id, label: n.name || n.kind, subtitle: n.kind, position: n.position });
    }
  }
  for (const b of s.project.bookmarks) {
    if (b.name.toLowerCase().includes(q)) {
      hits.push({ id: b.id, label: b.name, subtitle: 'bookmark', position: b.camera.target });
    }
  }
  for (const t of s.project.tour) {
    if (t.name.toLowerCase().includes(q)) {
      hits.push({ id: t.id, label: t.name, subtitle: 'tour stop', position: t.camera.target });
    }
  }
  return hits.slice(0, 20);
}

export function SearchPanel(): React.ReactElement {
  const search = useStore((s) => s.project.search);
  const setUi = useStore((s) => s.setUi);
  const engine = useEngine();
  const [query, setQuery] = useState(search.query);
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = (hit: Hit) => {
    engine?.flyTo({ target: { ...hit.position }, distance: Math.max(30, (engine?.getDebugSnapshot().rig.distance ?? 100) * 0.5) }, `Search: ${hit.label}`);
    if (findNode(useStore.getState().project.layers, hit.id)) setUi({ selectedIds: [hit.id] });
  };

  const run = async () => {
    setError(null);
    if (search.providerId === 'local') {
      setHits(searchLocal(query));
      return;
    }
    // A network provider: real fetch, real cancellation, real error surface.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setBusy(true);
    try {
      const res = await fetch(`/api/search?provider=${encodeURIComponent(search.providerId)}&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
      const json = (await res.json()) as { results?: Array<{ id: string; label: string; lat: number; lon: number; subtitle?: string }> };
      const frame = new TangentFrame(useStore.getState().project.world.origin);
      setHits(
        (json.results ?? []).slice(0, 20).map((r) => ({
          id: r.id,
          label: r.label,
          subtitle: r.subtitle ?? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`,
          position: frame.toLocal(geo(r.lat, r.lon, 0)),
        })),
      );
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      setError(aborted ? 'The search took too long and was cancelled.' : `Search failed: ${(err as Error).message}`);
      setHits([]);
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  };

  return (
    <Panel title="Find a place" panelId="search">
      <div className="ui-field ui-field--row">
        <Badge tone={search.providerId === 'local' ? 'ok' : 'info'}>{search.providerId}</Badge>
        {search.providerId === 'local' ? (
          <span className="ui-hint">Searches the open document. Works offline.</span>
        ) : (
          <span className="ui-hint">Network provider. Queries are only sent when you press search.</span>
        )}
      </div>
      <TextField
        label="Query"
        value={query}
        onChange={setQuery}
        placeholder="Layer, bookmark or place name"
        hint="Enter to search."
      />
      <div className="panel-actions">
        <Button size="xs" variant="primary" disabled={busy || !query.trim()} onClick={() => void run()}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
        {busy && (
          <Button size="xs" variant="ghost" onClick={() => { setBusy(false); setError('Search cancelled.'); setHits([]); }}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="ui-error">{error}</p>}
      <ul className="search-list">
        {hits.map((h) => (
          <li key={h.id}>
            <button type="button" className="search-row" onClick={() => go(h)}>
              <span className="search-row__label">{h.label}</span>
              <span className="search-row__meta">{h.subtitle}</span>
            </button>
          </li>
        ))}
      </ul>
      {hits.length === 0 && !busy && !error && query.trim() !== '' && <p className="ui-hint">No match in this document.</p>}
    </Panel>
  );
}
