/**
 * packages/scene-core — material library (REQUIREMENT 063, 064).
 *
 * One registry, so repeated objects genuinely share materials and textures
 * (REQUIREMENT 062) instead of each mesh creating its own program.
 */
import * as THREE from 'three';

export interface MaterialKey {
  kind:
    | 'standard'
    | 'terrain'
    | 'water'
    | 'road'
    | 'building'
    | 'vegetation'
    | 'transparent'
    | 'unlit'
    | 'panorama';
  color: string;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  emissive?: string;
}

export function materialKey(k: MaterialKey): string {
  return [k.kind, k.color, k.roughness ?? -1, k.metalness ?? -1, k.opacity ?? -1, k.emissive ?? '-'].join('|');
}

export class MaterialLibrary {
  private materials = new Map<string, THREE.Material>();
  private textures = new Map<string, THREE.Texture>();
  private refCounts = new Map<string, number>();

  get size(): number {
    return this.materials.size;
  }
  get textureCount(): number {
    return this.textures.size;
  }

  /** Get or create a shared material. Identical descriptors share one program. */
  get(key: MaterialKey): THREE.Material {
    const id = materialKey(key);
    const existing = this.materials.get(id);
    if (existing) {
      this.refCounts.set(id, (this.refCounts.get(id) ?? 0) + 1);
      return existing;
    }
    const mat = this.create(key);
    this.materials.set(id, mat);
    this.refCounts.set(id, 1);
    return mat;
  }

  release(key: MaterialKey): void {
    const id = materialKey(key);
    const n = (this.refCounts.get(id) ?? 0) - 1;
    if (n > 0) {
      this.refCounts.set(id, n);
      return;
    }
    this.refCounts.delete(id);
    const m = this.materials.get(id);
    if (m) {
      m.dispose();
      this.materials.delete(id);
    }
  }

  private create(key: MaterialKey): THREE.Material {
    const base = {
      color: new THREE.Color(key.color),
      roughness: key.roughness ?? 0.85,
      metalness: key.metalness ?? 0.0,
    };
    switch (key.kind) {
      case 'unlit':
        return new THREE.MeshBasicMaterial({ color: base.color });
      case 'transparent':
        return new THREE.MeshStandardMaterial({
          ...base,
          transparent: true,
          opacity: key.opacity ?? 0.5,
          depthWrite: false,
        });
      case 'water':
        return new THREE.MeshStandardMaterial({
          color: base.color,
          roughness: 0.08,
          metalness: 0.0,
          transparent: true,
          opacity: key.opacity ?? 0.72,
        });
      case 'panorama':
        return new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, depthWrite: false, toneMapped: false });
      case 'terrain':
      case 'road':
      case 'building':
      case 'vegetation':
      case 'standard':
      default:
        return new THREE.MeshStandardMaterial({
          ...base,
          emissive: new THREE.Color(key.emissive ?? 0x000000),
          flatShading: key.kind === 'vegetation',
        });
    }
  }

  /** Texture cache with anisotropy + mipmaps, keyed by URL (REQUIREMENT 064). */
  getTexture(url: string, opts: { anisotropy?: number; srgb?: boolean; flipY?: boolean } = {}): THREE.Texture {
    const id = `${url}|${opts.anisotropy ?? 1}|${opts.srgb ?? true}`;
    const existing = this.textures.get(id);
    if (existing) return existing;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const tex = loader.load(url);
    tex.anisotropy = Math.max(1, opts.anisotropy ?? 1);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.flipY = opts.flipY ?? true;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    this.textures.set(id, tex);
    return tex;
  }

  /** Procedurally generated texture — used for demo assets (REQUIREMENT 138). */
  getGeneratedTexture(
    id: string,
    size: number,
    paint: (ctx: CanvasRenderingContext2D, size: number) => void,
    srgb = true,
  ): THREE.Texture {
    const key = `gen:${id}:${size}`;
    const existing = this.textures.get(key);
    if (existing) return existing;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable — cannot generate procedural texture');
    paint(ctx, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this.textures.set(key, tex);
    return tex;
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.materials.clear();
    this.textures.clear();
    this.refCounts.clear();
  }
}

/* --------------------------------------------------------- texture budget --- */

/**
 * Choose a resolution tier from a byte budget (REQUIREMENT 064). Keeps large
 * imports from silently exhausting GPU memory on low-end hardware.
 */
export function textureTierForBytes(bytes: number, quality: 'low' | 'normal' | 'high'): number {
  const cap = quality === 'low' ? 512 : quality === 'normal' ? 2048 : 4096;
  const approx = Math.sqrt(bytes / 4); // RGBA8
  const pow2 = Math.pow(2, Math.ceil(Math.log2(Math.max(64, approx))));
  return Math.min(cap, pow2);
}
