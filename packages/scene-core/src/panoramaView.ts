/**
 * packages/scene-core — the panorama view (REQUIREMENT 038, 039, 045).
 *
 * A real UV sphere rendered from the inside with an equirectangular texture.
 * The pole caps are produced in the fragment shader: above/below a blend
 * latitude the sample is mixed towards a colour that was derived from the
 * image's own pole band, so looking straight up shows a plausible sky rather
 * than a black hole or a visible cube edge.
 *
 * This is the direct replacement for the old repository's curved-plane
 * approximation, which the user correctly identified as looking like a cube.
 */
import * as THREE from 'three';

const PANO_VERTEX = /* glsl */ `
varying vec3 vDir;
varying vec2 vUv;
void main() {
  vDir = normalize(position);
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PANO_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec3 uTopCap;
uniform vec3 uBottomCap;
uniform float uCapBlend;      // blend width in normalised latitude (0..0.5)
uniform float uCapsEnabled;   // 0 or 1
uniform float uOpacity;
uniform float uExposure;
uniform float uVFovScale;     // <1 when the capture does not cover the poles
uniform float uHasMap;
uniform float uWarpYaw;       // radians; rotates the sample direction about Y
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);

  // Spatial transition warp. The sample direction is rotated about the vertical
  // axis, so moving between nodes sweeps the view rather than dissolving it.
  // This must stay in step with rotateAboutY() in packages/panorama/src/warp.ts,
  // which is the tested specification for this rotation — including the sign,
  // which is inverted relative to a textbook right-handed Y rotation because
  // this shader derives u from atan(dir.x, -dir.z).
  if (uWarpYaw != 0.0) {
    float c = cos(uWarpYaw);
    float sn = sin(uWarpYaw);
    dir = normalize(vec3(dir.x * c - dir.z * sn, dir.y, dir.x * sn + dir.z * c));
  }

  float lat = clamp(dir.y / max(uVFovScale, 0.001), -1.0, 1.0);

  // equirectangular sampling
  float u = atan(dir.x, -dir.z) / (2.0 * 3.141592653589793) + 0.5;
  float v = 0.5 - asin(lat) / 3.141592653589793;
  v = clamp(v, 0.0, 1.0);

  vec3 tex = texture2D(uMap, vec2(u, v)).rgb * uExposure;
  if (uHasMap < 0.5) tex = vec3(0.0);

  float absLat = abs(lat);
  float capStart = 1.0 - uCapBlend * 2.0;
  float w = uCapsEnabled * smoothstep(capStart, 1.0, absLat);
  vec3 cap = lat >= 0.0 ? uBottomCap : uTopCap;
  vec3 col = mix(tex, cap, clamp(w, 0.0, 1.0));

  // Never let a missing map render black: fall back to the cap gradient.
  if (uHasMap < 0.5) col = mix(cap * 0.55, cap, absLat);

  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}
`;

export interface PanoramaViewOptions {
  radius?: number;
  latSegments?: number;
  lonSegments?: number;
}

export class PanoramaView {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.SphereGeometry;
  private texture: THREE.Texture | null = null;
  private _hasMap = false;

  constructor(opts: PanoramaViewOptions = {}) {
    const radius = opts.radius ?? 500;
    this.geometry = new THREE.SphereGeometry(
      radius,
      opts.lonSegments ?? 96,
      opts.latSegments ?? 64,
    );
    // Invert so we see the inside of the sphere with correct UV winding.
    this.geometry.scale(-1, 1, 1);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PANO_VERTEX,
      fragmentShader: PANO_FRAGMENT,
      side: THREE.FrontSide,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      uniforms: {
        uMap: { value: new THREE.DataTexture(new Uint8Array([40, 48, 58, 255]), 1, 1, THREE.RGBAFormat) },
        uTopCap: { value: new THREE.Color('#8fb8e8') },
        uBottomCap: { value: new THREE.Color('#4a4a45') },
        uCapBlend: { value: 0.1 },
        uCapsEnabled: { value: 1 },
        uOpacity: { value: 1 },
        uExposure: { value: 1 },
        uVFovScale: { value: 1 },
        uHasMap: { value: 0 },
        uWarpYaw: { value: 0 },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'panorama-view';
  }

  get hasMap(): boolean {
    return this._hasMap;
  }

  /**
   * Swap the equirectangular map.
   *
   * `disposePrevious` defaults to true, which is right when a single sphere
   * owns its textures. During a crossfade the two spheres deliberately share
   * the outgoing texture, so the caller must pass false and manage disposal
   * itself — otherwise the incoming sphere disposes a texture the outgoing
   * sphere is still rendering, and the first half of the fade goes black.
   */
  setTexture(tex: THREE.Texture | null, disposePrevious = true): void {
    if (disposePrevious && this.texture && this.texture !== tex) this.texture.dispose();
    this.texture = tex;
    this.material.uniforms.uMap.value = tex ?? new THREE.DataTexture(new Uint8Array([40, 48, 58, 255]), 1, 1, THREE.RGBAFormat);
    this._hasMap = tex !== null;
    this.material.uniforms.uHasMap.value = tex ? 1 : 0;
    this.material.needsUpdate = true;
  }

  /**
   * Set the transition warp, in degrees of yaw.
   *
   * Zero means unwarped. See `packages/panorama/src/warp.ts` for the maths this
   * mirrors and the tests that pin it.
   */
  setWarpYaw(deg: number): void {
    const v = Number.isFinite(deg) ? deg : 0;
    this.material.uniforms.uWarpYaw.value = (v * Math.PI) / 180;
  }

  setCaps(opts: { enabled: boolean; top: string; bottom: string; blendDeg: number }): void {
    this.material.uniforms.uCapsEnabled.value = opts.enabled ? 1 : 0;
    (this.material.uniforms.uTopCap.value as THREE.Color).set(opts.top);
    (this.material.uniforms.uBottomCap.value as THREE.Color).set(opts.bottom);
    // blendDeg is measured from the pole; convert to a normalised latitude band
    this.material.uniforms.uCapBlend.value = Math.max(0.001, Math.min(0.45, opts.blendDeg / 180));
  }

  setOpacity(o: number): void {
    this.material.uniforms.uOpacity.value = Math.max(0, Math.min(1, o));
    this.material.transparent = o < 0.999;
  }

  setExposure(e: number): void {
    this.material.uniforms.uExposure.value = Math.max(0.05, e);
  }

  /** Captures that do not cover the full vertical FOV get a compressed V range. */
  setVFovScale(vfovDeg: number): void {
    this.material.uniforms.uVFovScale.value = Math.max(0.05, Math.min(1, vfovDeg / 180));
  }

  /** Keep the sphere centred on the camera so parallax is always zero. */
  follow(cameraPosition: THREE.Vector3): void {
    this.mesh.position.copy(cameraPosition);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    if (this.texture) this.texture.dispose();
  }
}

/**
 * Second panorama sphere used for the crossfade during node transitions.
 * Kept as a separate object rather than a shader uniform so interruption is
 * exact: setting opacity to 0 instantly removes the outgoing view.
 */
export class PanoramaCrossfade {
  readonly incoming: PanoramaView;
  readonly outgoing: PanoramaView;
  readonly group = new THREE.Group();

  constructor() {
    this.incoming = new PanoramaView();
    this.outgoing = new PanoramaView();
    this.outgoing.setOpacity(0);
    this.group.add(this.outgoing.mesh);
    this.group.add(this.incoming.mesh);
  }

  /** Drive the crossfade from a 0..1 progress value plus persistence strength. */
  setProgress(progress: number, persistenceEnabled: boolean, strength: number): void {
    const t = Math.max(0, Math.min(1, progress));
    if (!persistenceEnabled) {
      // hard cut at the halfway point — no ghosting when persistence is off
      this.outgoing.setOpacity(t < 0.5 ? 1 : 0);
      this.incoming.setOpacity(t < 0.5 ? 0 : 1);
      return;
    }
    const eased = 1 - t * t;
    this.outgoing.setOpacity(Math.max(0, eased * strength));
    this.incoming.setOpacity(Math.min(1, t * 1.25));
  }

  follow(cameraPosition: THREE.Vector3): void {
    this.incoming.follow(cameraPosition);
    this.outgoing.follow(cameraPosition);
  }

  dispose(): void {
    this.incoming.dispose();
    this.outgoing.dispose();
  }
}
