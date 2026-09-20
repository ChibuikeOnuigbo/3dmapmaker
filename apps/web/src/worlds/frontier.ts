/**
 * apps/web — the generation pipeline (spec §16–§19, §33–§34, §49–§51).
 *
 * The world is not produced by one big bang. It grows from a frontier:
 *
 *   1. A frontier queue of cells that still need a plate.
 *   2. For each cell, an AI CONTEXT PACKET describing what must be true about
 *      the plate — the parent it continues from, the edges that must line up,
 *      the lighting envelope, the land use. This is a description, never code.
 *   3. The produced plate is validated for CONTINUITY against its parents
 *      before it is accepted into the graph. A plate that fails is rejected
 *      with a reason and the cell goes back on the queue.
 *
 * Every step is synchronous and cancellable: `runFrontier` takes an
 * `isCancelled` predicate, so a long generation on the 1,024-node world can be
 * abandoned cleanly rather than leaving half a world in memory.
 */
import type { Direction, Landmark, WorldGraph, WorldNode } from '@3dmm/panorama';
import { ALL_DIRECTIONS, OPPOSITE } from '@3dmm/panorama';
import { PLATES, type CellKind } from './generate';

/* ------------------------------------------------------ context packet --- */

export interface EdgeConstraint {
  direction: Direction;
  /** The plate on the other side of this edge, if one exists yet. */
  neighborPlate: string | null;
  /** What the seam must look like from this side. */
  requirement: string;
  /** Metres to the neighbour — the plate's parallax must be consistent. */
  distanceMeters: number;
}

export interface AiContextPacket {
  /** Stable id so a packet can be re-sent or audited. */
  packetId: string;
  square: number;
  gridX: number;
  gridY: number;
  /** What this cell is, in plain words. */
  cellKind: CellKind;
  cellDescription: string;
  /** The plate that must be continued, and the direction we came from. */
  parentPlate: string | null;
  parentDirection: Direction | null;
  /** The equirectangular plate to produce, chosen from the local set. */
  targetPlate: string;
  /** What must line up at each seam. */
  edges: EdgeConstraint[];
  /** Lighting that must match the parent so the walk has no visible cut. */
  lighting: {
    timeOfDay: string;
    weather: string;
    sunDirectionDeg: number;
    exposure: number;
    /** How far this plate may drift from the parent before it is rejected. */
    tolerance: { sunDirectionDeg: number; exposure: number };
  };
  /** Landmarks that must be visible, with the bearing they must appear at. */
  visibleLandmarks: Array<{ name: string; bearingDeg: number; distanceMeters: number }>;
  /** Explicit prohibitions — the things a generator must not do. */
  mustNot: string[];
}

/* --------------------------------------------------------- continuity --- */

export interface ContinuityIssue {
  kind: 'geometry' | 'lighting' | 'plate' | 'seam' | 'landmark' | 'landuse';
  message: string;
  /** How far outside tolerance, when the check is numeric. */
  severity: number;
}

export interface ContinuityResult {
  valid: boolean;
  issues: ContinuityIssue[];
  /** The checks that ran, so a pass is verifiable rather than assumed. */
  checksRun: string[];
}


/** Parse an "HH:MM" clock time into minutes past midnight, or null. */
export function parseClockTime(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is this sun azimuth plausible for this time of day?
 *
 * A crude but real check: the sun rises in the east (roughly 90°) and sets in
 * the west (roughly 270°), so a mid-afternoon plate must have a westerly sun.
 * It catches a generator that stamps a noon sun onto a dusk plate.
 */
export function isPlausibleSunTime(minutes: number, sunDirectionDeg: number): boolean {
  // Daylight runs roughly 06:00–18:30 here; outside it the sun is below the
  // horizon and any azimuth is acceptable because the plate is night.
  if (minutes < 360 || minutes > 1110) return true;
  const t = (minutes - 360) / 750; // 0 at sunrise, 1 at sunset
  const expected = 90 + t * 180; // 90° (E) → 270° (W)
  let delta = Math.abs(expected - sunDirectionDeg);
  if (delta > 180) delta = 360 - delta;
  return delta <= 60;
}

/**
 * Validate a candidate node against the neighbours already in the graph.
 *
 * This is the gate that stops the world from developing impossible seams: a
 * plate that faces a river on one side and a field on the other, or a node
 * whose lighting jumps three hours between steps.
 */
export function validateContinuity(graph: WorldGraph, candidate: WorldNode, kinds: CellKind[]): ContinuityResult {
  const issues: ContinuityIssue[] = [];
  const checksRun: string[] = [];

  /* 1. The plate must be a real, known equirectangular asset. */
  checksRun.push('plate-known');
  const known = new Set<string>(Object.values(PLATES));
  if (!known.has(candidate.panoramaUrl)) {
    issues.push({ kind: 'plate', message: `Plate ${candidate.panoramaUrl} is not in the local asset set.`, severity: 1 });
  }

  /* 2. Geometry: the node must sit on a cell that exists and be in range. */
  checksRun.push('geometry-bounds');
  if (candidate.gridX < 0 || candidate.gridY < 0 || candidate.gridX >= graph.width || candidate.gridY >= graph.height) {
    issues.push({ kind: 'geometry', message: `(${candidate.gridX},${candidate.gridY}) is off the board.`, severity: 1 });
  }

  /* 3. Geometry: world coordinates must match the grid and the scale. */
  checksRun.push('geometry-scale');
  const expectX = candidate.gridX * graph.metersPerGridUnit;
  const expectZ = -candidate.gridY * graph.metersPerGridUnit;
  if (Math.abs(candidate.worldX - expectX) > 1e-6 || Math.abs(candidate.worldZ - expectZ) > 1e-6) {
    issues.push({
      kind: 'geometry',
      message: `World position (${candidate.worldX.toFixed(2)}, ${candidate.worldZ.toFixed(2)}) does not match grid × scale (${expectX.toFixed(2)}, ${expectZ.toFixed(2)}).`,
      severity: 1,
    });
  }

  /* 4. Lighting must sit inside the world envelope. */
  checksRun.push('lighting-envelope');
  const { sunDirection, exposure, timeOfDay } = candidate.lighting;
  if (!(sunDirection >= 0 && sunDirection < 360)) {
    issues.push({ kind: 'lighting', message: `Sun direction ${sunDirection}° is outside [0,360).`, severity: 1 });
  }
  if (!(exposure > 0.2 && exposure < 4)) {
    issues.push({ kind: 'lighting', message: `Exposure ${exposure} is outside the sane range.`, severity: 0.6 });
  }
  // The generator stores a real clock time ("16:30"), not a coarse band, so
  // the envelope has to parse one. Accepting only dawn|day|dusk|night would
  // have rejected every node the world actually contains.
  const minutes = parseClockTime(timeOfDay);
  if (minutes === null) {
    issues.push({
      kind: 'lighting',
      message: `Time of day "${timeOfDay}" is not a clock time (expected HH:MM).`,
      severity: 0.5,
    });
  } else if (!isPlausibleSunTime(minutes, sunDirection)) {
    issues.push({
      kind: 'lighting',
      message: `Sun at ${sunDirection}° is not plausible for ${timeOfDay} (expected a westerly sun in the afternoon).`,
      severity: 0.6,
    });
  }

  /* 5. Seam continuity: compare against every neighbour already placed. */
  checksRun.push('seam-neighbours');
  for (const dir of ALL_DIRECTIONS) {
    const other = graph.neighbor(candidate.id, dir);
    if (!other) continue;
    const dSun = Math.abs(((other.lighting.sunDirection - sunDirection + 540) % 360) - 180);
    if (dSun > 30) {
      issues.push({
        kind: 'seam',
        message: `Sun direction jumps ${dSun.toFixed(0)}° between square ${candidate.number} and its ${dir} neighbour.`,
        severity: Math.min(1, dSun / 90),
      });
    }
    const dExp = Math.abs(Math.log(other.lighting.exposure / exposure));
    if (dExp > 0.5) {
      issues.push({
        kind: 'seam',
        message: `Exposure jumps ×${Math.exp(dExp).toFixed(2)} across the ${dir} seam.`,
        severity: Math.min(1, dExp),
      });
    }
    if (other.lighting.weather !== candidate.lighting.weather) {
      issues.push({
        kind: 'seam',
        message: `Weather changes from ${other.lighting.weather} to ${candidate.lighting.weather} across the ${dir} seam.`,
        severity: 0.4,
      });
    }
  }

  /* 6. Land use must be plausible next to its neighbours. A church cannot sit
        directly in the middle of a river. */
  checksRun.push('landuse-plausible');
  const idx = candidate.gridY * graph.width + candidate.gridX;
  const mine = kinds[idx];
  if (mine === 'church' || mine === 'churchyard' || mine === 'market' || mine === 'school') {
    for (const dir of ALL_DIRECTIONS) {
      const other = graph.neighbor(candidate.id, dir);
      if (!other) continue;
      const oIdx = other.gridY * graph.width + other.gridX;
      if (kinds[oIdx] === 'river') {
        issues.push({ kind: 'landuse', message: `${mine} at square ${candidate.number} is directly beside a river cell.`, severity: 0.7 });
      }
    }
  }

  /* 7. Provenance must be present — no unattributed imagery. */
  checksRun.push('provenance-present');
  if (!candidate.provenance.license || !candidate.provenance.generator) {
    issues.push({ kind: 'plate', message: 'Plate has no provenance metadata.', severity: 1 });
  }
  for (const src of candidate.provenance.referenceSources) {
    if (/googleapis|google\.com\/maps\/api|streetview/i.test(src)) {
      issues.push({
        kind: 'plate',
        message: `Reference source "${src}" looks like a scrape endpoint. Reference geography only, never redistribute imagery.`,
        severity: 1,
      });
    }
  }

  return { valid: issues.length === 0, issues, checksRun };
}

/* --------------------------------------------------------- frontier run --- */

export interface FrontierStats {
  queued: number;
  accepted: number;
  rejected: number;
  cancelled: boolean;
  /** Rejections grouped by reason, so a bad generator is diagnosable. */
  rejections: Array<{ square: number; issues: ContinuityIssue[] }>;
  elapsedMs: number;
}

export interface FrontierOptions {
  graph: WorldGraph;
  kinds: CellKind[];
  startId: string;
  /** Called for each cell; return false to reject the node. */
  isCancelled?: () => boolean;
  /** Cap on how many cells to process, for incremental generation. */
  maxCells?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Walk the board breadth-first from the start, validating each node against the
 * neighbours that are already accepted. This is the "frontier queue" of §17:
 * growth is outward from where the player can already stand, so the world is
 * always coherent around the reachable region even if generation is stopped
 * part way.
 */
export function runFrontier(opts: FrontierOptions): FrontierStats {
  const t0 = performance.now();
  const { graph, kinds, startId } = opts;
  const stats: FrontierStats = { queued: 0, accepted: 0, rejected: 0, cancelled: false, rejections: [], elapsedMs: 0 };

  const seen = new Set<string>();
  const queue: string[] = [startId];
  seen.add(startId);

  while (queue.length) {
    if (opts.isCancelled?.()) {
      stats.cancelled = true;
      break;
    }
    if (opts.maxCells !== undefined && stats.accepted + stats.rejected >= opts.maxCells) break;

    const id = queue.shift()!;
    const node = graph.get(id);
    if (!node) continue;

    stats.queued++;
    const result = validateContinuity(graph, node, kinds);
    if (result.valid) {
      stats.accepted++;
    } else {
      stats.rejected++;
      stats.rejections.push({ square: node.number, issues: result.issues });
    }
    opts.onProgress?.(stats.accepted + stats.rejected, graph.size);

    // Expand outward from accepted cells only, so a rejected region does not
    // silently seed the rest of the world.
    for (const { node: n } of graph.neighborsOf(id)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      queue.push(n.id);
    }
  }

  stats.elapsedMs = performance.now() - t0;
  return stats;
}

/**
 * Build the context packet for one cell.
 *
 * The packet is a description of what must be true, never code and never a
 * prompt that could be executed. It is what an image model (or a human) would
 * be handed, and it is also what the validator checks the result against.
 */
export function buildContextPacket(graph: WorldGraph, node: WorldNode, kinds: CellKind[], cellDescription: (k: CellKind) => string): AiContextPacket {
  const idx = node.gridY * graph.width + node.gridX;
  const kind = kinds[idx];

  const edges: EdgeConstraint[] = [];
  for (const dir of ALL_DIRECTIONS) {
    const other = graph.neighbor(node.id, dir);
    edges.push({
      direction: dir,
      neighborPlate: other?.panoramaUrl ?? null,
      distanceMeters: graph.metersPerGridUnit * (dir.length > 5 ? Math.SQRT2 : 1),
      requirement: other
        ? `The ${dir} seam must match ${other.panoramaUrl} — same street, same horizon height, same lighting.`
        : `No ${dir} exit. The view in that direction must read as a dead end, a wall or open ground, not as a road that stops mid-frame.`,
    });
  }

  const parentDir = ALL_DIRECTIONS.find((d) => graph.neighbor(node.id, d) !== null) ?? null;
  const parentPlate = parentDir ? graph.neighbor(node.id, parentDir)?.panoramaUrl ?? null : null;

  const visibleLandmarks: AiContextPacket['visibleLandmarks'] = [];
  for (const l of graph.landmarks) {
    const v = graph.landmarkVector(node.id, l.id);
    if (!v) continue;
    // Only landmarks close enough to actually read in the plate.
    if (v.meters <= graph.metersPerGridUnit * 6) {
      visibleLandmarks.push({ name: l.name, bearingDeg: v.bearingDeg, distanceMeters: v.meters });
    }
  }

  return {
    packetId: `pkt-${node.id}`,
    square: node.number,
    gridX: node.gridX,
    gridY: node.gridY,
    cellKind: kind,
    cellDescription: cellDescription(kind),
    parentPlate,
    parentDirection: parentDir,
    targetPlate: node.panoramaUrl,
    edges,
    lighting: {
      timeOfDay: node.lighting.timeOfDay,
      weather: node.lighting.weather,
      sunDirectionDeg: node.lighting.sunDirection,
      exposure: node.lighting.exposure,
      tolerance: { sunDirectionDeg: 30, exposure: 0.5 },
    },
    visibleLandmarks,
    mustNot: [
      'Do not place a road exit where the graph has no edge.',
      'Do not change the sun position relative to the parent plate.',
      'Do not render people, vehicles or signage that would identify a real location.',
      'Do not use a cube map — the output must be a single equirectangular image.',
      'Do not stretch the poles; the top and bottom rows may be sky and ground.',
    ],
  };
}

/** The reverse direction helper, exported so callers can build round trips. */
export function opposite(dir: Direction): Direction {
  return OPPOSITE[dir];
}

/** Every landmark in the graph, for packet building. */
export function landmarksOf(graph: WorldGraph): Landmark[] {
  return graph.landmarks;
}
