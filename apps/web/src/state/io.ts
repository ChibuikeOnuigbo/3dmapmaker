/**
 * apps/web — project import / export.
 *
 * Shared by the command palette, the engine's global shortcuts and the Import
 * dialog so there is exactly one code path for reading and writing documents.
 * Imported JSON is sanitised before it is parsed: only the project schema is
 * accepted, and nothing in a file can register a callback, a URL handler or
 * executable content (REQUIREMENTS 122, 123).
 */
import { validateProject, type Project } from '@3dmm/project';
import { sanitizeImportedJson } from '@3dmm/assets';
import { useStore } from './store';

export function downloadProjectFile(): void {
  const s = useStore.getState();
  const json = s.exportProject();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${s.project.name.replace(/[^\w.-]+/g, '_') || 'world'}.3dmm.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  s.notify('ok', 'Project exported as JSON.');
}

export interface ImportOutcome {
  ok: boolean;
  issues: string[];
  project?: Project;
}

/** Parse, sanitise and validate untrusted JSON. Never throws. */
export function parseImportedJson(raw: unknown): ImportOutcome {
  const issues: string[] = [];
  let candidate: unknown;
  try {
    const clean = sanitizeImportedJson(raw);
    if (!clean.ok || clean.data === undefined) {
      return { ok: false, issues: clean.errors.length ? clean.errors : ['Rejected before validation.'] };
    }
    candidate = clean.data;
  } catch (err) {
    return { ok: false, issues: [`Rejected before validation: ${(err as Error).message}`] };
  }
  const result = validateProject(candidate);
  if (!result.ok) {
    return { ok: false, issues: result.issues.slice(0, 12).map((i) => `${i.path || 'project'}: ${i.message}`) };
  }
  if (!result.project) return { ok: false, issues: ['Validation succeeded but produced no document.'] };
  return { ok: true, issues, project: result.project };
}

export async function importProjectFromFile(file: File): Promise<ImportOutcome> {
  if (file.size > 32 * 1024 * 1024) {
    return { ok: false, issues: ['That file is larger than 32 MB. 3DMapMaker project files should be far smaller.'] };
  }
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    return { ok: false, issues: [`Could not read the file: ${(err as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: [`Not valid JSON: ${(err as Error).message}`] };
  }
  return parseImportedJson(raw);
}

/** Import a GeoJSON FeatureCollection as authored layers. */
export interface GeoImportOutcome {
  ok: boolean;
  added: number;
  issues: string[];
}

export function importGeoJson(raw: unknown): GeoImportOutcome {
  const issues: string[] = [];
  const fc = raw as { type?: string; features?: Array<Record<string, unknown>> };
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    return { ok: false, added: 0, issues: ['Expected a GeoJSON FeatureCollection.'] };
  }
  const s = useStore.getState();
  let added = 0;
  for (const feature of fc.features) {
    const geometry = feature.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!geometry || typeof geometry.type !== 'string') {
      issues.push('Skipped a feature with no geometry.');
      continue;
    }
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const name = typeof props.name === 'string' ? props.name : `${geometry.type} ${added + 1}`;
    const coords = geometry.coordinates as number[][][] | number[][];
    if (!Array.isArray(coords)) {
      issues.push(`Skipped "${name}": unsupported coordinates.`);
      continue;
    }
    // GeoJSON is [lon, lat]; project layers are local metres in the tangent
    // frame anchored at project.world.origin.
    const frame = makeLocalFrame(s.project);
    if (geometry.type === 'Point') {
      const c = coords as unknown as number[];
      const p = frame(c[1], c[0], c[2] ?? 0);
      s.addLayer({
        id: newLayerId('marker'),
        kind: 'markers',
        name,
        visible: true,
        locked: false,
        position: p,
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        anchor: { type: 'terrain', offset: 0 },
        data: { imported: 'geojson' },
        children: [],
      });
      added++;
    } else if (geometry.type === 'LineString') {
      const pts = (coords as number[][]).map((c) => {
        const p = frame(c[1], c[0], c[2] ?? 0);
        return { x: p.x, y: p.z };
      });
      s.addLayer({
        id: newLayerId('road'),
        kind: 'roads',
        name,
        visible: true,
        locked: false,
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        anchor: { type: 'world' },
        data: { points: pts, width: 8, sidewalkWidth: 0, smoothing: 0.4, imported: 'geojson' },
        children: [],
      });
      added++;
    } else if (geometry.type === 'Polygon') {
      const rings = coords as number[][][];
      const ring = (rings[0] ?? []).map((c) => {
        const p = frame(c[1], c[0], c[2] ?? 0);
        return { x: p.x, y: p.z };
      });
      if (ring.length < 3) {
        issues.push(`Skipped "${name}": a polygon ring needs at least 3 points.`);
        continue;
      }
      s.addLayer({
        id: newLayerId('poly'),
        kind: 'polygons',
        name,
        visible: true,
        locked: false,
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        anchor: { type: 'world' },
        data: { ring, color: '#8a9bb0', imported: 'geojson' },
        children: [],
      });
      added++;
    } else {
      issues.push(`Skipped "${name}": ${geometry.type} is not supported yet.`);
    }
  }
  if (added > 0) s.notify('ok', `Imported ${added} feature${added === 1 ? '' : 's'} from GeoJSON.`);
  return { ok: added > 0, added, issues };
}

/** Export the authored layers back to GeoJSON. */
export function exportGeoJson(): string {
  const s = useStore.getState();
  const origin = s.project.world.origin;
  const toGeo = makeGeoFrame(s.project);
  const features: Array<Record<string, unknown>> = [];
  const stack = [...s.project.layers];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const c of n.children) stack.push(c);
    if (n.kind === 'markers') {
      const g = toGeo(n.position.x, n.position.y, n.position.z);
      features.push({
        type: 'Feature',
        properties: { id: n.id, name: n.name, kind: n.kind },
        geometry: { type: 'Point', coordinates: [g.lon, g.lat, g.alt + origin.alt] },
      });
    } else if (n.kind === 'roads' || n.kind === 'paths') {
      const pts = (n.data.points as Array<{ x: number; y: number }>) ?? [];
      if (pts.length < 2) continue;
      const g = pts.map((p) => {
        const w = toGeo(p.x, 0, p.y);
        return [w.lon, w.lat];
      });
      features.push({
        type: 'Feature',
        properties: { id: n.id, name: n.name, kind: n.kind },
        geometry: { type: 'LineString', coordinates: g },
      });
    } else if (n.kind === 'polygons') {
      const ring = (n.data.ring as Array<{ x: number; y: number }>) ?? [];
      if (ring.length < 3) continue;
      const g = ring.map((p) => {
        const w = toGeo(p.x, 0, p.y);
        return [w.lon, w.lat];
      });
      g.push(g[0]);
      features.push({
        type: 'Feature',
        properties: { id: n.id, name: n.name, kind: n.kind },
        geometry: { type: 'Polygon', coordinates: [g] },
      });
    }
  }
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------ helpers --- */

import { TangentFrame, enuToScene, sceneToEnu } from '@3dmm/gis';
import { newId } from '@3dmm/project';

function newLayerId(prefix: string): string {
  return newId(prefix);
}

const frameCache = new WeakMap<object, TangentFrame>();

function frameFor(project: Project): TangentFrame {
  const key = project.world;
  let f = frameCache.get(key);
  if (!f) {
    f = new TangentFrame(project.world.origin);
    frameCache.set(key, f);
  }
  return f;
}

/** geo -> scene metres in the project's tangent frame. */
function makeLocalFrame(project: Project): (lat: number, lon: number, alt: number) => { x: number; y: number; z: number } {
  const f = frameFor(project);
  return (lat, lon, alt) => enuToScene(f.toLocal({ lat, lon, alt }));
}

/** scene metres -> geo, the exact inverse of the above. */
function makeGeoFrame(project: Project): (x: number, y: number, z: number) => { lat: number; lon: number; alt: number } {
  const f = frameFor(project);
  return (x, y, z) => f.toGeo(sceneToEnu({ x, y, z }));
}
