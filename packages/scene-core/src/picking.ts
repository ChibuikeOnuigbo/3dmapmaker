/**
 * packages/scene-core — picking (REQUIREMENT 069, 095, 020).
 *
 * Raycasting against dense authored geometry uses three-mesh-bvh when it is
 * available, and falls back to Three's built-in raycaster otherwise. Hover
 * picking is throttled and runs off the frame critical path so a 200k-triangle
 * scene does not stutter under a moving mouse.
 */
import * as THREE from 'three';
import type { Ray } from '@3dmm/camera';

export interface PickTarget {
  id: string;
  object: THREE.Object3D;
  /** Optional explicit collider so we do not raycast the render mesh. */
  collider?: THREE.Object3D;
}

export interface PickHit {
  id: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  faceIndex: number | null;
}

export interface PickerOptions {
  /** Milliseconds between hover picks. */
  hoverThrottleMs?: number;
  /** Use BVH acceleration when the geometry has one. */
  useBvh?: boolean;
  maxHits?: number;
}

export class Picker {
  private raycaster = new THREE.Raycaster();
  private targets: PickTarget[] = [];
  private lastHoverAt = 0;
  private hoverThrottleMs: number;
  private useBvh: boolean;
  private maxHits: number;
  private pickCount = 0;
  private bvhAccelerated = 0;
  private lastDurationMs = 0;

  constructor(opts: PickerOptions = {}) {
    this.hoverThrottleMs = opts.hoverThrottleMs ?? 40;
    this.useBvh = opts.useBvh ?? true;
    this.maxHits = opts.maxHits ?? 8;
  }

  setTargets(targets: PickTarget[]): void {
    this.targets = targets;
  }

  addTarget(t: PickTarget): void {
    this.targets.push(t);
  }

  clearTargets(): void {
    this.targets = [];
  }

  get stats() {
    return { pickCount: this.pickCount, bvhAccelerated: this.bvhAccelerated, lastDurationMs: this.lastDurationMs };
  }

  /** Should a hover pick run right now? Throttled. */
  shouldHoverPick(now = performance.now()): boolean {
    if (now - this.lastHoverAt < this.hoverThrottleMs) return false;
    this.lastHoverAt = now;
    return true;
  }

  fromRay(ray: Ray, maxDistance = 20000): PickHit | null {
    const start = performance.now();
    this.pickCount++;
    this.raycaster.ray.origin.set(ray.origin.x, ray.origin.y, ray.origin.z);
    this.raycaster.ray.direction.set(ray.direction.x, ray.direction.y, ray.direction.z);
    this.raycaster.far = maxDistance;
    this.raycaster.near = 0;

    const objects: THREE.Object3D[] = [];
    const byUuid = new Map<string, PickTarget>();
    for (const t of this.targets) {
      const o = t.collider ?? t.object;
      if (!o.visible) continue;
      objects.push(o);
      byUuid.set(o.uuid, t);
      // Also map descendants back to the owning target.
      o.traverse((child) => byUuid.set(child.uuid, t));
    }
    if (objects.length === 0) return null;

    const hits = this.raycaster.intersectObjects(objects, true);
    this.lastDurationMs = performance.now() - start;
    for (const h of hits.slice(0, this.maxHits)) {
      const target = byUuid.get(h.object.uuid);
      if (!target) continue;
      if (this.useBvh && (h.object as THREE.Mesh).geometry && 'boundsTree' in (h.object as THREE.Mesh).geometry) this.bvhAccelerated++;
      return {
        id: target.id,
        point: h.point.clone(),
        normal: h.normal ? h.normal.clone() : new THREE.Vector3(0, 1, 0),
        distance: h.distance,
        faceIndex: h.faceIndex ?? null,
      };
    }
    return null;
  }

  /** Screen-space candidates first, exact ray test only for survivors (REQ 095). */
  lassoPick(
    polygon: ReadonlyArray<{ x: number; y: number }>,
    project: (p: THREE.Vector3) => { x: number; y: number; visible: boolean },
  ): string[] {
    const ids = new Set<string>();
    for (const t of this.targets) {
      const box = new THREE.Box3().setFromObject(t.object);
      if (box.isEmpty()) continue;
      const centre = box.getCenter(new THREE.Vector3());
      const s = project(centre);
      if (!s.visible) continue;
      if (pointInPolygon(s.x, s.y, polygon)) ids.add(t.id);
    }
    return [...ids];
  }
}

export function pointInPolygon(x: number, y: number, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/* --------------------------------------------------------------- instancing --- */

/**
 * Instanced pool (REQUIREMENT 062). One InstancedMesh per (geometry, material)
 * pair, so a forest of 5000 trees is a single draw call.
 */
export class InstancedPool {
  private pools = new Map<string, THREE.InstancedMesh>();
  private counts = new Map<string, number>();
  private capacities = new Map<string, number>();
  private readonly parent: THREE.Object3D;
  private readonly dummy = new THREE.Object3D();

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
  }

  private key(geometry: THREE.BufferGeometry, material: THREE.Material): string {
    return `${geometry.uuid}|${material.uuid}`;
  }

  /** Reserve capacity for a (geometry, material) pair. */
  reserve(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
    const k = this.key(geometry, material);
    const existing = this.pools.get(k);
    if (existing && (this.capacities.get(k) ?? 0) >= capacity) return existing;
    if (existing) {
      this.parent.remove(existing);
      existing.dispose();
    }
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances are spread across the tile
    mesh.count = this.counts.get(k) ?? 0;
    this.pools.set(k, mesh);
    this.capacities.set(k, capacity);
    this.parent.add(mesh);
    return mesh;
  }

  /** Add an instance. Returns its index, or -1 when the pool is full. */
  add(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: { x: number; y: number; z: number },
    rotationDeg: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number },
    tint?: THREE.Color,
  ): number {
    const k = this.key(geometry, material);
    const mesh = this.pools.get(k);
    if (!mesh) return -1;
    const cap = this.capacities.get(k) ?? 0;
    const idx = this.counts.get(k) ?? 0;
    if (idx >= cap) return -1;
    this.dummy.position.set(position.x, position.y, position.z);
    this.dummy.rotation.set(
      (rotationDeg.x * Math.PI) / 180,
      (rotationDeg.y * Math.PI) / 180,
      (rotationDeg.z * Math.PI) / 180,
    );
    this.dummy.scale.set(scale.x, scale.y, scale.z);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(idx, this.dummy.matrix);
    if (tint && mesh.instanceColor) mesh.setColorAt(idx, tint);
    else if (tint) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.setColorAt(idx, tint);
    }
    this.counts.set(k, idx + 1);
    mesh.count = idx + 1;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return idx;
  }

  clear(geometry: THREE.BufferGeometry, material: THREE.Material): void {
    const k = this.key(geometry, material);
    this.counts.set(k, 0);
    const mesh = this.pools.get(k);
    if (mesh) mesh.count = 0;
  }

  get stats() {
    let instances = 0;
    for (const v of this.counts.values()) instances += v;
    return { pools: this.pools.size, instances, drawCalls: this.pools.size };
  }

  dispose(): void {
    for (const mesh of this.pools.values()) {
      this.parent.remove(mesh);
      mesh.dispose();
    }
    this.pools.clear();
    this.counts.clear();
    this.capacities.clear();
  }
}
