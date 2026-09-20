import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { PanoramaView, PanoramaCrossfade } from './panoramaView';

/**
 * Texture ownership during a crossfade.
 *
 * The two spheres deliberately share the outgoing texture while a fade runs.
 * If either sphere disposes what the other is still rendering, the first half
 * of the transition goes black — the exact "jarring black screen" the spec
 * forbids. These tests pin that behaviour down.
 */

function makeTex(): THREE.Texture & { dispose: ReturnType<typeof vi.fn> } {
  const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, THREE.RGBAFormat) as unknown as THREE.Texture & {
    dispose: ReturnType<typeof vi.fn>;
  };
  tex.dispose = vi.fn();
  return tex;
}

describe('PanoramaView.setTexture — disposal is opt-in', () => {
  it('disposes the previous texture by default', () => {
    const view = new PanoramaView();
    const a = makeTex();
    const b = makeTex();
    view.setTexture(a);
    view.setTexture(b);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
    view.dispose();
  });

  it('does NOT dispose the previous texture when disposePrevious is false', () => {
    const view = new PanoramaView();
    const a = makeTex();
    const b = makeTex();
    view.setTexture(a, false);
    view.setTexture(b, false);
    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
    view.dispose();
  });

  it('never disposes a texture it is being handed again', () => {
    const view = new PanoramaView();
    const a = makeTex();
    view.setTexture(a);
    view.setTexture(a);
    expect(a.dispose).not.toHaveBeenCalled();
    view.dispose();
  });

  it('reports hasMap truthfully', () => {
    const view = new PanoramaView();
    expect(view.hasMap).toBe(false);
    view.setTexture(makeTex(), false);
    expect(view.hasMap).toBe(true);
    view.setTexture(null, false);
    expect(view.hasMap).toBe(false);
    view.dispose();
  });
});

describe('PanoramaCrossfade — the shared outgoing texture survives the swap', () => {
  it('a shared texture is not disposed by either sphere when disposePrevious is false', () => {
    const cf = new PanoramaCrossfade();
    const shared = makeTex();
    cf.incoming.setTexture(shared, false);
    cf.outgoing.setTexture(shared, false);
    expect(shared.dispose).not.toHaveBeenCalled();
    // Both spheres must still be pointing at it.
    expect((cf.incoming as unknown as { texture: THREE.Texture }).texture).toBe(shared);
    expect((cf.outgoing as unknown as { texture: THREE.Texture }).texture).toBe(shared);
    cf.dispose();
  });

  it('simulates a full two-step walk without blacking out the outgoing view', () => {
    const cf = new PanoramaCrossfade();

    // Step 1: arrive on plate A.
    const texA = makeTex();
    cf.incoming.setTexture(texA, false);
    cf.outgoing.setTexture(texA, false);

    // Step 2: walk to plate B. The outgoing sphere must keep showing A while B
    // loads onto the incoming one — and A must not be disposed underneath it.
    const texB = makeTex();
    cf.incoming.setTexture(texB, false);
    cf.outgoing.setTexture(texA, false);
    expect(texA.dispose).not.toHaveBeenCalled();
    expect((cf.outgoing as unknown as { texture: THREE.Texture }).texture).toBe(texA);
    expect((cf.incoming as unknown as { texture: THREE.Texture }).texture).toBe(texB);

    // Mid-fade both spheres are live and opaque somewhere in the range.
    cf.setProgress(0.25, false, 0);
    expect((cf.outgoing.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(1);
    expect((cf.incoming.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(0);
    cf.setProgress(0.75, false, 0);
    expect((cf.outgoing.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(0);
    expect((cf.incoming.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(1);

    // Step 3: walk to plate C. Now A is on neither sphere and may be released;
    // B must survive because the outgoing sphere still holds it.
    const texC = makeTex();
    const prevOutgoing = texA;
    const prevIncoming = texB;
    cf.incoming.setTexture(texC, false);
    cf.outgoing.setTexture(texB, false);
    for (const old of [prevOutgoing, prevIncoming]) {
      if (old !== texC && old !== texB) old.dispose();
    }
    expect(texA.dispose).toHaveBeenCalledTimes(1); // released, on neither sphere
    expect(texB.dispose).not.toHaveBeenCalled(); // still the outgoing view
    expect(texC.dispose).not.toHaveBeenCalled();
    cf.dispose();
  });

  it('a hard cut at the halfway point means no frame where both spheres are invisible', () => {
    const cf = new PanoramaCrossfade();
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      cf.setProgress(t, false, 0);
      const out = (cf.outgoing.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value as number;
      const inc = (cf.incoming.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value as number;
      // Exactly one sphere is fully visible at every sample — never both dark.
      expect(out + inc).toBeGreaterThan(0.999);
    }
    cf.dispose();
  });

  it('clamps progress outside 0..1', () => {
    const cf = new PanoramaCrossfade();
    cf.setProgress(-1, false, 0);
    expect((cf.outgoing.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(1);
    cf.setProgress(2, false, 0);
    expect((cf.incoming.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(1);
    cf.dispose();
  });
});
