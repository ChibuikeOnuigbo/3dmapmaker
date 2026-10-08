/**
 * Panorama Maps — gen/context.js
 *
 * GenerationContextBuilder (Spec §17, §21, §40–§42). Assembles the FULL
 * context for every panorama generation: where the user was, where they are
 * going, what must persist, what may change, plus previous image history
 * (references, hashes, features metadata) — the anti-random-scene contract.
 */
import { bearingDeg } from '../core/world-graph.js';

const PROMPT_RULES = [
  'DO NOT INVENT A NEW LOCATION.',
  'DO NOT REPLACE EXISTING LANDMARKS.',
  'DO NOT TELEPORT THE USER.',
  'DO NOT CHANGE BUILDING IDENTITY.',
  'DO NOT CHANGE ROAD GEOMETRY WITHOUT A MAP JUSTIFICATION.',
  'DO NOT INTRODUCE A NEW MAJOR LANDMARK UNLESS THE WORLD GRAPH REQUIRES IT.',
];

export class GenerationContextBuilder {
  /**
   * @param {WorldGraph} graph
   * @param {PanoramaCache} cache  provides meta history for previousImages
   */
  constructor(graph, cache) {
    this.graph = graph;
    this.cache = cache;
  }

  /**
   * @param {object} args
   * @param {string} args.targetNodeId
   * @param {string|null} args.fromNodeId
   * @param {object|null} args.movement  {direction, distanceM, distancePx, bearing}
   * @param {object} args.camera         {yawDeg, pitchDeg, fovDeg, height}
   */
  build({ targetNodeId, fromNodeId = null, movement = null, camera = {} }) {
    const g = this.graph;
    const target = g.getNode(targetNodeId);
    const scale = g.scale;

    const zoneIds = g.zones.zonesAt(target.x, target.y);
    const zones = zoneIds.map(id => {
      const z = g.zones.get(id);
      return {
        id: z.id, name: z.name,
        distanceToBoundaryM: g.zones.distanceToBoundaryM(id, target.x, target.y),
        boundary: z.shape === 'circle' ? { radiusM: scale.pxToM(z.radiusPx) } : undefined,
        meta: z.meta || undefined,
      };
    });

    const landmarks = [...g.landmarks.values()].map(lm => ({
      id: lm.id, type: lm.type, name: lm.name, importance: lm.importance,
      position: [lm.x, lm.y],
      distanceM: scale.pxToM(Math.hypot(lm.x - target.x, lm.y - target.y)),
      bearingDeg: bearingDeg(target.x, target.y, lm.x, lm.y),
    })).sort((a, b) => a.distanceM - b.distanceM);

    // Previous-image context: immediate previous node + up to 4 recent history
    // metas (hashes, seeds, validation) — identity chain (Spec §18, §41).
    const previousImages = [];
    if (fromNodeId && fromNodeId !== targetNodeId) {
      const prevMeta = this.cache.metaOf(fromNodeId);
      const prevNode = g.getNode(fromNodeId);
      previousImages.push({
        nodeId: fromNodeId, role: 'immediate-previous',
        worldPosition: prevNode ? [prevNode.x, prevNode.y] : null,
        phash: prevMeta?.phash ?? null, seed: prevMeta?.seed ?? null,
        validation: prevMeta?.validation ?? null,
      });
    }
    const recent = this.cache.recentMetas(4);
    for (const m of recent) {
      if (!previousImages.some(p => p.nodeId === m.nodeId)) previousImages.push({
        nodeId: m.nodeId, role: 'history',
        phash: m.phash, seed: m.seed, validation: m.validation ?? null,
      });
    }

    const neighbors = g.edgesOf(targetNodeId).map(e => {
      const o = g.otherEnd(e, targetNodeId);
      const on = g.getNode(o);
      return {
        nodeId: o, direction: e.dirNameAB,
        bearingDeg: g.edgeBearing(e, targetNodeId),
        distanceM: e.distM, blocked: e.blocked,
        name: on?.name,
      };
    });

    return {
      worldId: g.id,
      worldName: g.name,
      mapScale: { pixelsPerMeter: scale.pixelsPerMeter, stepPixels: scale.movement.stepPixels },
      currentNode: fromNodeId,
      targetNode: targetNodeId,
      targetWorldCoordinate: { x: target.x, y: target.y, xMeters: scale.pxToM(target.x), yMeters: scale.pxToM(target.y) },
      movement: movement ? {
        direction: movement.direction ?? null,
        bearingDeg: movement.bearing ?? null,
        distanceMeters: movement.distanceM,
        distancePixels: scale.mToPx(movement.distanceM),
      } : null,
      zones,
      landmarks: landmarks.filter(l => l.distanceM <= 800),
      roads: (g.environment.features || []).filter(f => f.type === 'road').map(r => ({ id: r.id, widthM: r.widthM, name: r.name })),
      buildings: (g.environment.features || []).filter(f => f.type === 'building').map(b => ({ id: b.id, kind: b.kind, name: b.name })),
      environment: { ...g.environment, features: undefined },
      lighting: { timeOfDay: g.environment.timeOfDay, sunAzimuthDeg: g.environment.sunAzimuthDeg, sunElevationDeg: g.environment.sunElevationDeg },
      weather: { condition: g.environment.weather },
      camera: {
        yawDeg: camera.yawDeg ?? 0, pitchDeg: camera.pitchDeg ?? 0,
        fov: camera.fovDeg ?? 75, height: camera.height ?? 1.7,
      },
      previousImages,
      neighbors,
      worldMemory: {
        nodeCount: g.nodes.size, edgeCount: g.edges.size,
        landmarkCount: g.landmarks.size,
        description: g.environment.description,
      },
      promptVersion: 1,
      promptText: this._promptText({ target, zones, landmarks, movement }),
      forbiddenChanges: [...PROMPT_RULES],
    };
  }

  _promptText({ target, zones, landmarks, movement }) {
    const zone = zones[0];
    const near = landmarks.slice(0, 4)
      .map(l => `${l.name ?? l.id} (${l.type}) ${l.distanceM.toFixed(0)}m bearing ${l.bearingDeg.toFixed(0)}°`)
      .join('; ');
    return [
      `Render the 360-degree panorama for node ${target.id} "${target.name}" of world "${this.graph.name}".`,
      zone ? `Camera stands in zone "${zone.name}", ${zone.distanceToBoundaryM?.toFixed(1) ?? '?'}m from its boundary — scenery MUST remain consistent with this zone.` : '',
      movement ? `Movement: ${movement.distanceM.toFixed(1)}m ${movement.direction ?? ''}. Show the SAME environment one step ahead, not a new one.` : 'Initial capture at this node.',
      near ? `Persistent landmarks in view range: ${near}.` : '',
      ...PROMPT_RULES,
    ].filter(Boolean).join(' ');
  }
}
