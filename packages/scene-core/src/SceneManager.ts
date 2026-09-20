/**
 * packages/scene-core — Three.js scene management (REQUIREMENT 006, 102-109).
 *
 * WebGL2 baseline with an honest WebGPU probe, GPU instancing for repeated
 * geometry, per-object frustum culling via Three's built-in path plus our own
 * tile culling, LOD via the performance package, and a single rAF loop that
 * owns the frame budget.
 *
 * Nothing here is fake: if WebGL2 is unavailable the constructor throws a
 * descriptive error that the UI surfaces, rather than silently rendering
 * nothing.
 */
import * as THREE from 'three';
import type { QualityProfile } from '@3dmm/performance';
import { Profiler } from '@3dmm/performance';

export interface SceneManagerOptions {
  canvas: HTMLCanvasElement;
  quality: QualityProfile;
  background?: number;
  antialias?: boolean;
}

// A `preferWebGPU?: boolean` option used to live here. It was declared, accepted
// by callers, and never read: `backend` was hardcoded to 'webgl2' and nothing in
// the repository constructs a WebGPU renderer. An option that silently does
// nothing is worse than no option, because it reads as a working toggle, so it is
// gone. Add it back only alongside a real WebGPU code path.

export interface RendererInfo {
  /**
   * The renderer actually in use. Always `'webgl2'` today — the other members
   * of the union are where a fallback or a real WebGPU path would report itself,
   * not a claim that either exists.
   */
  backend: 'webgl2' | 'webgl' | 'webgpu';
  maxTextureSize: number;
  maxAnisotropy: number;
  devicePixelRatio: number;
  extensions: string[];
  /**
   * Whether the browser *exposes* `navigator.gpu`. This is a probe only. The
   * scene manager never acts on it: there is no WebGPU renderer in this codebase,
   * so a `true` here means the capability exists in the browser, not that it is
   * being used.
   */
  webgpuAvailable: boolean;
}

export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly root = new THREE.Group();
  readonly profiler = new Profiler();
  private quality: QualityProfile;
  private canvas: HTMLCanvasElement;
  private raf = 0;
  private running = false;
  private lastTime = 0;
  private frameCallbacks: Array<(dt: number, elapsed: number) => void> = [];
  private resizeObserver: ResizeObserver | null = null;
  private dprListeners: Array<() => void> = [];
  private disposed = false;
  private readonly info: RendererInfo;
  private framesRendered = 0;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private _pixelRatio = 1;

  constructor(opts: SceneManagerOptions) {
    this.canvas = opts.canvas;
    this.quality = opts.quality;

    const gl2 = typeof WebGL2RenderingContext !== 'undefined';
    if (!gl2) {
      throw new Error(
        'WebGL2 is required but not available in this browser. Enable hardware acceleration or try a recent Chrome, Edge, Firefox or Safari.',
      );
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: opts.canvas,
        antialias: opts.quality.antialias,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        // Keep the drawing buffer only when we actually snapshot (tours/export).
        preserveDrawingBuffer: false,
      });
    } catch (err) {
      throw new Error(
        `Failed to create a WebGL2 context: ${err instanceof Error ? err.message : String(err)}. ` +
          'This usually means the GPU is blocked or the browser is out of context slots.',
      );
    }
    this.renderer = renderer;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.quality.pixelRatioCap));
    this._pixelRatio = this.renderer.getPixelRatio();
    this.renderer.shadowMap.enabled = opts.quality.shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

    this.info = {
      backend: 'webgl2',
      maxTextureSize: renderer.capabilities.maxTextureSize,
      maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      devicePixelRatio: window.devicePixelRatio || 1,
      extensions: Object.keys(renderer.extensions?.get?.('WEBGL_debug_renderer_info') ?? {}),
      webgpuAvailable,
    };

    this.scene = new THREE.Scene();
    this.scene.add(this.root);
    this.scene.background = new THREE.Color(opts.background ?? 0x0f1418);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.2, 40000);
    this.camera.position.set(0, 120, 220);

    this.hemi = new THREE.HemisphereLight(0xbcd6f5, 0x3a3527, 0.55);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
    this.sun.position.set(300, 500, 200);
    this.sun.castShadow = opts.quality.shadowsEnabled;
    this.sun.shadow.mapSize.set(opts.quality.shadowMapSize, opts.quality.shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 3000;
    const s = 600;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.setupResize();
  }

  getInfo(): RendererInfo {
    return { ...this.info, devicePixelRatio: window.devicePixelRatio || 1 };
  }

  getQuality(): QualityProfile {
    return this.quality;
  }

  setQuality(q: QualityProfile): void {
    const dprChanged = q.pixelRatioCap !== this.quality.pixelRatioCap;
    const shadowChanged = q.shadowsEnabled !== this.quality.shadowsEnabled || q.shadowMapSize !== this.quality.shadowMapSize;
    this.quality = q;
    if (dprChanged) this.applyPixelRatio();
    if (shadowChanged) {
      this.renderer.shadowMap.enabled = q.shadowsEnabled;
      this.sun.castShadow = q.shadowsEnabled;
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      // force the shadow map to rebuild at the new resolution
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (m) {
          const arr = Array.isArray(m) ? m : [m];
          for (const mat of arr) mat.needsUpdate = true;
        }
      });
    }
  }

  private applyPixelRatio(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatioCap);
    this.renderer.setPixelRatio(dpr);
    this._pixelRatio = dpr;
    this.resize();
  }

  /** Handle a devicePixelRatio change (monitor switch, browser zoom). */
  watchDevicePixelRatio(): () => void {
    if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
    const update = () => {
      this.info.devicePixelRatio = window.devicePixelRatio || 1;
      this.applyPixelRatio();
    };
    // Re-register whenever the DPR actually changes; the media query only fires
    // at discrete resolution steps, so we also poll cheaply on resize.
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const handler = () => {
      update();
      rebind();
    };
    const rebind = () => {
      mq.removeEventListener?.('change', handler);
      const next = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      next.addEventListener?.('change', handler);
    };
    mq.addEventListener?.('change', handler);
    this.dprListeners.push(update);
    return () => {
      mq.removeEventListener?.('change', handler);
      this.dprListeners = this.dprListeners.filter((f) => f !== update);
    };
  }

  private setupResize(): void {
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.handleWindowResize);
  }

  private handleWindowResize = () => {
    for (const f of this.dprListeners) f();
    this.resize();
  };

  resize(width?: number, height?: number): void {
    const w = Math.max(1, Math.floor(width ?? this.canvas.clientWidth ?? this.canvas.width));
    const h = Math.max(1, Math.floor(height ?? this.canvas.clientHeight ?? this.canvas.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get viewportSize(): { width: number; height: number } {
    return {
      width: Math.max(1, this.canvas.clientWidth || 1),
      height: Math.max(1, this.canvas.clientHeight || 1),
    };
  }

  /** Register a per-frame callback. Returns an unsubscribe function. */
  onFrame(cb: (dt: number, elapsed: number) => void): () => void {
    this.frameCallbacks.push(cb);
    return () => {
      this.frameCallbacks = this.frameCallbacks.filter((f) => f !== cb);
    };
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      const cpuStart = performance.now();
      for (const cb of this.frameCallbacks) cb(dt, now / 1000);
      this.renderer.render(this.scene, this.camera);
      this.framesRendered++;
      this.profiler.endFrame(now, cpuStart, {
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        programs: this.renderer.info.programs?.length ?? 0,
      });
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }
  get frameCount(): number {
    return this.framesRendered;
  }

  /** One-off render, used for thumbnails and tour exports. */
  renderOnce(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------------------------------------ lighting --- */

  setSun(azimuthDeg: number, elevationDeg: number, intensity: number, distance = 900): void {
    const az = ((azimuthDeg - 90) * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    const r = distance * Math.cos(el);
    this.sun.position.set(Math.cos(az) * r, Math.max(1, Math.sin(el) * distance), Math.sin(az) * r);
    this.sun.intensity = intensity;
    // Sun colour warms near the horizon — a real atmospheric effect, cheap.
    const t = Math.max(0, Math.min(1, elevationDeg / 30));
    this.sun.color.setHSL(0.09 + 0.03 * t, 0.55 * (1 - t) + 0.12, 0.55 + 0.15 * t);
  }

  setSunTarget(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
    const spread = 600;
    this.sun.shadow.camera.left = -spread;
    this.sun.shadow.camera.right = spread;
    this.sun.shadow.camera.top = spread;
    this.sun.shadow.camera.bottom = -spread;
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  setAmbient(skyColor: number, groundColor: number, intensity: number): void {
    this.hemi.color.setHex(skyColor);
    this.hemi.groundColor.setHex(groundColor);
    this.hemi.intensity = intensity;
  }

  setFog(mode: 'none' | 'linear' | 'exponential' | 'height', color: string, near: number, far: number, density: number): void {
    if (mode === 'none') {
      this.scene.fog = null;
      return;
    }
    const c = new THREE.Color(color);
    if (mode === 'linear') this.scene.fog = new THREE.Fog(c, near, far);
    else if (mode === 'exponential') this.scene.fog = new THREE.FogExp2(c, density);
    else {
      // Height fog is implemented as exponential fog plus a ground haze plane;
      // the plane is added by the world layer.
      this.scene.fog = new THREE.FogExp2(c, density * 1.6);
    }
    (this.scene.background as THREE.Color | null)?.set?.(color);
  }

  /* ------------------------------------------------------------- cleanup --- */

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.handleWindowResize);
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) {
        const arr = Array.isArray(mat) ? mat : [mat];
        for (const m of arr) {
          for (const value of Object.values(m)) {
            if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
          }
          m.dispose();
        }
      }
    });
    this.renderer.dispose();
  }
}
