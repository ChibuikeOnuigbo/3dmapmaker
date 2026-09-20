/**
 * packages/gis — slippy / quadtree tile math (REQUIREMENT 009, 010, 047).
 *
 * One shared TileKey representation is used by the terrain tile scheduler, the
 * imagery layer and the LOD selector so they can never disagree about which
 * tile is which.
 */
import type { GeoCoord } from './coordinates';
import { WGS84 } from './coordinates';

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export type TileKey = string;

export function tileKey(t: TileCoord): TileKey {
  return `${t.z}/${t.x}/${t.y}`;
}

export function parseTileKey(key: TileKey): TileCoord | null {
  const m = /^(\d+)\/(-?\d+)\/(-?\d+)$/.exec(key);
  if (!m) return null;
  return { z: +m[1], x: +m[2], y: +m[3] };
}

export function tileCount(z: number) {
  return Math.pow(2, z);
}

/** Wrap tile x into [0, 2^z) so panning across the antimeridian stays valid. */
export function wrapX(x: number, z: number) {
  const n = tileCount(z);
  return ((x % n) + n) % n;
}

export function clampY(y: number, z: number) {
  const n = tileCount(z);
  return Math.max(0, Math.min(n - 1, y));
}

export function isValidTile(t: TileCoord) {
  if (!Number.isInteger(t.z) || !Number.isInteger(t.x) || !Number.isInteger(t.y)) return false;
  if (t.z < 0 || t.z > 24) return false;
  const n = tileCount(t.z);
  return t.x >= 0 && t.x < n && t.y >= 0 && t.y < n;
}

export function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * tileCount(z);
}

export function latToTileY(lat: number, z: number) {
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * tileCount(z);
}

export function tileXToLon(x: number, z: number) {
  return (x / tileCount(z)) * 360 - 180;
}

export function tileYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / tileCount(z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function clampLat(lat: number) {
  // web mercator is undefined beyond ~85.0511 deg
  return Math.max(-85.05112877980659, Math.min(85.05112877980659, lat));
}

export function geoToTile(g: GeoCoord, z: number): TileCoord {
  return {
    z,
    x: Math.floor(lonToTileX(g.lon, z)),
    y: Math.floor(latToTileY(g.lat, z)),
  };
}

export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function tileBounds(t: TileCoord): TileBounds {
  const n = tileCount(t.z);
  return {
    west: tileXToLon(t.x, t.z),
    east: tileXToLon(t.x + 1, t.z),
    north: tileYToLat(t.y, t.z),
    south: tileYToLat(t.y + 1, t.z),
  };
}

export function tileCenter(t: TileCoord): GeoCoord {
  const b = tileBounds(t);
  return { lat: (b.north + b.south) / 2, lon: (b.west + b.east) / 2, alt: 0 };
}

/** Ground metres per tile edge at this zoom/latitude (used for LOD selection). */
export function tileGroundSize(t: TileCoord, lat: number) {
  const b = tileBounds(t);
  const dLat = (b.north - b.south) * (Math.PI / 180) * WGS84.a;
  const dLon =
    (b.east - b.west) *
    (Math.PI / 180) *
    WGS84.a *
    Math.cos((lat * Math.PI) / 180);
  return { x: dLon, y: dLat };
}

/**
 * All tiles at zoom `z` intersecting a geographic bounding box.
 * Bounded by `maxTiles` so a bad bbox can never produce an unbounded loop
 * (REQUIREMENT: main-thread cost is bounded).
 */
export function tilesInBounds(bounds: TileBounds, z: number, maxTiles = 512): TileCoord[] {
  const x0 = Math.floor(lonToTileX(bounds.west, z));
  const x1 = Math.floor(lonToTileX(bounds.east, z));
  const y0 = Math.floor(latToTileY(bounds.north, z));
  const y1 = Math.floor(latToTileY(bounds.south, z));
  const out: TileCoord[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = { z, x: wrapX(x, z), y: clampY(y, z) };
      if (isValidTile(t)) out.push(t);
      if (out.length >= maxTiles) return out;
    }
  }
  return out;
}

export function parentTile(t: TileCoord): TileCoord | null {
  if (t.z <= 0) return null;
  return { z: t.z - 1, x: Math.floor(t.x / 2), y: Math.floor(t.y / 2) };
}

export function childTiles(t: TileCoord): TileCoord[] {
  const z = t.z + 1;
  return [
    { z, x: t.x * 2, y: t.y * 2 },
    { z, x: t.x * 2 + 1, y: t.y * 2 },
    { z, x: t.x * 2, y: t.y * 2 + 1 },
    { z, x: t.x * 2 + 1, y: t.y * 2 + 1 },
  ];
}

export function tileSiblings(t: TileCoord): TileCoord[] {
  const out: TileCoord[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const n = { z: t.z, x: t.x + dx, y: t.y + dy };
      if (isValidTile(n)) out.push(n);
    }
  }
  return out;
}
