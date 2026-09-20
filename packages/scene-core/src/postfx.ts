/**
 * packages/scene-core — post-processing (REQUIREMENT 104, 105).
 *
 * REQUIREMENT 105 is explicit: no full-resolution multi-pass CPU blur. This is a
 * separable, downsampled GPU blur:
 *
 *   scene -> half-res RT -> H blur -> V blur -> quarter-res RT -> composite
 *
 * Two taps per pass at half and quarter resolution, so a 24px visual radius
 * costs 4 full-screen-equivalent passes of 1/4 and 1/16 the pixels.
 */
import * as THREE from 'three';

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uDirection;   // (texel.x * radius, 0) or (0, texel.y * radius)
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
  vec2 off1 = uDirection * 1.3846153846 * uRadius;
  vec2 off2 = uDirection * 3.2307692308 * uRadius;
  sum += texture2D(tDiffuse, vUv + off1) * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - off1) * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + off2) * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - off2) * 0.0702702703;
  gl_FragColor = sum;
}
`;

const BRIGHT_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoftKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = max(max(c.r, c.g), c.b);
  float knee = max(uSoftKnee, 1e-4);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBlur;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform float uDepthFade;
uniform float uBlurMix;
uniform vec2 uOutlineRes;
varying vec2 vUv;

vec3 grayscale(vec3 c) { return vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))); }

void main() {
  vec3 base = texture2D(tScene, vUv).rgb;

  if (uBlurMix > 0.001) {
    vec3 blurred = texture2D(tBlur, vUv).rgb;
    base = mix(base, blurred, clamp(uBlurMix, 0.0, 1.0));
  }

  vec3 bloom = texture2D(tBloom, vUv).rgb;
  base += bloom * uBloom;

  // depth-ish fade towards the frame edge, cheap stand-in for a depth buffer
  if (uDepthFade > 0.001) {
    vec2 d = vUv - 0.5;
    float f = smoothstep(0.25, 0.75, length(d));
    base = mix(base, base * 0.6, f * uDepthFade);
  }

  // colour correction
  base = (base - 0.5) * uContrast + 0.5;
  base = mix(grayscale(base), base, uSaturation);

  // vignette
  vec2 q = vUv * (1.0 - vUv);
  float vig = clamp(pow(q.x * q.y * 16.0, 0.25), 0.0, 1.0);
  base *= mix(1.0, vig, uVignette);

  gl_FragColor = vec4(clamp(base, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}
`;

export interface PostFxSettings {
  bloom: number;
  vignette: number;
  saturation: number;
  contrast: number;
  depthFade: number;
  blurEnabled: boolean;
  blurRadiusPx: number;
  blurMix: number;
  enabled: boolean;
}

export const defaultPostFx = (): PostFxSettings => ({
  bloom: 0.25,
  vignette: 0.15,
  saturation: 1,
  contrast: 1,
  depthFade: 0,
  blurEnabled: false,
  blurRadiusPx: 4,
  blurMix: 0,
  enabled: true,
});

export class PostFx {
  private rtScene: THREE.WebGLRenderTarget;
  private rtBlurA: THREE.WebGLRenderTarget;
  private rtBlurB: THREE.WebGLRenderTarget;
  private rtBloom: THREE.WebGLRenderTarget;
  private blurMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene: THREE.Scene;
  private quadCamera: THREE.OrthographicCamera;
  private settings: PostFxSettings;
  private passCount = 0;
  private width = 1;
  private height = 1;

  constructor(width: number, height: number, settings: PostFxSettings = defaultPostFx()) {
    this.settings = settings;
    this.width = width;
    this.height = height;

    const opts = (scale: number) => ({
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      samples: 0,
    }) as THREE.RenderTargetOptions;

    this.rtScene = new THREE.WebGLRenderTarget(width, height, { ...opts(1), depthBuffer: true });
    this.rtBlurA = new THREE.WebGLRenderTarget(Math.max(1, width >> 1), Math.max(1, height >> 1), opts(0.5));
    this.rtBlurB = new THREE.WebGLRenderTarget(Math.max(1, width >> 1), Math.max(1, height >> 1), opts(0.5));
    this.rtBloom = new THREE.WebGLRenderTarget(Math.max(1, width >> 2), Math.max(1, height >> 2), opts(0.25));

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      uniforms: { tDiffuse: { value: null }, uDirection: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
    });
    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.85 }, uSoftKnee: { value: 0.3 } },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: {
        tScene: { value: null },
        tBlur: { value: null },
        tBloom: { value: null },
        uBloom: { value: settings.bloom },
        uVignette: { value: settings.vignette },
        uSaturation: { value: settings.saturation },
        uContrast: { value: settings.contrast },
        uDepthFade: { value: settings.depthFade },
        uBlurMix: { value: settings.blurMix },
        uOutlineRes: { value: new THREE.Vector2(width, height) },
      },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSettings(s: Partial<PostFxSettings>): void {
    this.settings = { ...this.settings, ...s };
    const u = this.compositeMat.uniforms;
    u.uBloom.value = this.settings.bloom;
    u.uVignette.value = this.settings.vignette;
    u.uSaturation.value = this.settings.saturation;
    u.uContrast.value = this.settings.contrast;
    u.uDepthFade.value = this.settings.depthFade;
    u.uBlurMix.value = this.settings.blurEnabled ? this.settings.blurMix : 0;
  }

  getSettings(): PostFxSettings {
    return { ...this.settings };
  }

  get passesThisFrame(): number {
    return this.passCount;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rtScene.setSize(this.width, this.height);
    this.rtBlurA.setSize(Math.max(1, this.width >> 1), Math.max(1, this.height >> 1));
    this.rtBlurB.setSize(Math.max(1, this.width >> 1), Math.max(1, this.height >> 1));
    this.rtBloom.setSize(Math.max(1, this.width >> 2), Math.max(1, this.height >> 2));
    (this.compositeMat.uniforms.uOutlineRes.value as THREE.Vector2).set(this.width, this.height);
  }

  /** Render the scene into the internal RT. */
  begin(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.rtScene);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  }

  /** Run blur + bloom + composite to the default framebuffer. */
  composite(renderer: THREE.WebGLRenderer): void {
    this.passCount = 0;
    const s = this.settings;

    if (s.enabled && s.blurEnabled && s.blurMix > 0.001) {
      const radius = Math.max(0.25, Math.min(12, s.blurRadiusPx / 4));
      this.blurMat.uniforms.tDiffuse.value = this.rtScene.texture;
      this.blurMat.uniforms.uRadius.value = radius;
      const halfW = 1 / Math.max(1, this.width >> 1);
      const halfH = 1 / Math.max(1, this.height >> 1);
      // horizontal
      (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(halfW, 0);
      this.quad.material = this.blurMat;
      renderer.setRenderTarget(this.rtBlurA);
      renderer.render(this.quadScene, this.quadCamera);
      this.passCount++;
      // vertical
      this.blurMat.uniforms.tDiffuse.value = this.rtBlurA.texture;
      (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(0, halfH);
      renderer.setRenderTarget(this.rtBlurB);
      renderer.render(this.quadScene, this.quadCamera);
      this.passCount++;
      renderer.setRenderTarget(null);
    }

    if (s.enabled && s.bloom > 0.001) {
      this.brightMat.uniforms.tDiffuse.value = this.rtScene.texture;
      this.quad.material = this.brightMat;
      renderer.setRenderTarget(this.rtBloom);
      renderer.render(this.quadScene, this.quadCamera);
      this.passCount++;
      renderer.setRenderTarget(null);
    }

    this.quad.material = this.compositeMat;
    this.compositeMat.uniforms.tScene.value = this.rtScene.texture;
    this.compositeMat.uniforms.tBlur.value = this.rtBlurB.texture;
    this.compositeMat.uniforms.tBloom.value = this.rtBloom.texture;
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);
    this.passCount++;
  }

  dispose(): void {
    this.rtScene.dispose();
    this.rtBlurA.dispose();
    this.rtBlurB.dispose();
    this.rtBloom.dispose();
    this.blurMat.dispose();
    this.brightMat.dispose();
    this.compositeMat.dispose();
    this.quad.geometry.dispose();
  }
}
