/**
 * apps/web — physics & surfaces (REQUIREMENTS 111-114).
 *
 * The character controller runs on a fixed timestep in the engine and the
 * renderer interpolates between physics states, so visual smoothness never
 * depends on the simulation rate. Everything here edits canonical state.
 */
import React from 'react';
import { Button, NumberScrub, Panel, Slider, StatRow, Switch, TextField } from '@3dmm/ui';
import { SURFACES, type SurfaceKind } from '@3dmm/physics';
import { useStore } from '../../state/store';

export function PhysicsPanel(): React.ReactElement {
  const physics = useStore((s) => s.project.physics);
  const setPhysics = useStore((s) => s.setPhysics);
  const setSurface = useStore((s) => s.setPhysicsSurface);
  const upsertProxy = useStore((s) => s.upsertCollisionProxy);
  const removeProxy = useStore((s) => s.removeCollisionProxy);
  const [proxyId, setProxyId] = React.useState('');

  const setChar = (patch: Partial<typeof physics.character>) => setPhysics({ character: { ...physics.character, ...patch } });

  return (
    <div className="panels" data-testid="physics-panel">
      <Panel title="Simulation" panelId="physics-sim">
        <Switch label="Physics enabled" description="Walk mode, triggers and stretch physics all depend on this." checked={physics.enabled} onChange={(v) => setPhysics({ enabled: v })} />
        <Slider label="Gravity" value={physics.gravity} onValueChange={(v) => setPhysics({ gravity: v })} min={-30} max={0} step={0.01} format={(v) => `${v.toFixed(2)} m/s²`} />
        <Slider label="Fixed step rate" value={physics.fixedHz} onValueChange={(v) => setPhysics({ fixedHz: Math.round(v) })} min={20} max={240} step={1} format={(v) => `${v.toFixed(0)} Hz`} />
        <Slider label="Max substeps per frame" value={physics.maxSubsteps} onValueChange={(v) => setPhysics({ maxSubsteps: Math.round(v) })} min={1} max={8} step={1} format={(v) => v.toFixed(0)} />
        <StatRow label="Step interval" value={`${(1000 / physics.fixedHz).toFixed(2)} ms`} />
        <p className="ui-hint">
          The renderer interpolates between fixed steps, so a frame-rate dip slows the visual update but never changes the
          simulation result.
        </p>
      </Panel>

      <Panel title="Character controller" panelId="physics-character">
        <NumberScrub label="Capsule radius" value={physics.character.radius} onChange={(v) => setChar({ radius: Math.max(0.05, v) })} min={0.05} max={2} step={0.01} precision={2} suffix="m" />
        <NumberScrub label="Height" value={physics.character.height} onChange={(v) => setChar({ height: Math.max(0.3, v) })} min={0.3} max={3} step={0.01} precision={2} suffix="m" />
        <NumberScrub label="Mass" value={physics.character.mass} onChange={(v) => setChar({ mass: Math.max(1, v) })} min={1} max={500} step={1} precision={1} suffix="kg" />
        <Slider label="Walk speed" value={physics.character.walkSpeed} onValueChange={(v) => setChar({ walkSpeed: v })} min={0.5} max={20} step={0.1} format={(v) => `${v.toFixed(1)} m/s`} />
        <Slider label="Run speed" value={physics.character.runSpeed} onValueChange={(v) => setChar({ runSpeed: v })} min={1} max={40} step={0.1} format={(v) => `${v.toFixed(1)} m/s`} />
        <Slider label="Jump speed" value={physics.character.jumpSpeed} onValueChange={(v) => setChar({ jumpSpeed: v })} min={0} max={20} step={0.1} format={(v) => `${v.toFixed(1)} m/s`} />
        <Slider label="Slope limit" value={physics.character.slopeLimitDeg} onValueChange={(v) => setChar({ slopeLimitDeg: v })} min={0} max={89} step={1} format={(v) => `${v.toFixed(0)}°`} />
        <Slider label="Step height" value={physics.character.stepHeight} onValueChange={(v) => setChar({ stepHeight: v })} min={0} max={2} step={0.05} format={(v) => `${v.toFixed(2)} m`} />
        <Slider label="Ground snap" value={physics.character.groundSnap} onValueChange={(v) => setChar({ groundSnap: v })} min={0} max={2} step={0.05} format={(v) => `${v.toFixed(2)} m`} />
        <StatRow
          label="Jump height"
          value={`${((physics.character.jumpSpeed * physics.character.jumpSpeed) / (2 * Math.abs(physics.gravity))).toFixed(2)} m`}
        />
      </Panel>

      <Panel title="Surfaces" panelId="physics-surfaces">
        <p className="ui-hint">Layer data can name a surface with <code>surface: &quot;road&quot;</code>. Unknown names fall back to the defaults below.</p>
        {(Object.keys(SURFACES) as SurfaceKind[]).map((builtin) => {
          const live = physics.surfaces[builtin] ?? {
            friction: SURFACES[builtin].friction,
            restitution: 0,
            speedFactor: 1,
            stiffness: 140,
            damping: 3,
          };
          return (
            <div className="surface-row" key={builtin}>
              <div className="surface-row__head">
                <strong>{builtin}</strong>
                <Button size="xs" variant="ghost" onClick={() => setSurface(builtin, { friction: SURFACES[builtin].friction, restitution: 0 })}>
                  Reset
                </Button>
              </div>
              <Slider label="Friction" value={live.friction} onValueChange={(v) => setSurface(builtin, { friction: v })} min={0} max={2} step={0.01} format={(v) => v.toFixed(2)} />
              <Slider label="Restitution" value={live.restitution} onValueChange={(v) => setSurface(builtin, { restitution: v })} min={0} max={1} step={0.01} format={(v) => v.toFixed(2)} />
              <Slider label="Speed factor" value={live.speedFactor} onValueChange={(v) => setSurface(builtin, { speedFactor: Math.max(0.05, v) })} min={0.05} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} />
              <Slider label="Stretch stiffness" value={live.stiffness} onValueChange={(v) => setSurface(builtin, { stiffness: v })} min={1} max={600} step={1} format={(v) => v.toFixed(0)} />
              <Slider label="Stretch damping" value={live.damping} onValueChange={(v) => setSurface(builtin, { damping: v })} min={0} max={40} step={0.5} format={(v) => v.toFixed(1)} />
            </div>
          );
        })}
        <p className="ui-hint">
          Stretch physics is a spring solver, separate from cloth: stiffness and damping here drive squash-and-stretch on
          props, not a fabric simulation.
        </p>
      </Panel>

      <Panel title="Collision proxies" panelId="physics-proxies">
        <div className="ui-field">
          <span className="ui-label">New proxy id</span>
          <TextField label="Id" value={proxyId} onChange={setProxyId} placeholder="e.g. gate-post" />
        </div>
        <div className="panel-actions">
          <Button
            size="xs"
            disabled={!proxyId.trim()}
            onClick={() => {
              upsertProxy(proxyId.trim(), { shape: 'box', size: { x: 1, y: 2, z: 1 } });
              setProxyId('');
            }}
          >
            Add box proxy
          </Button>
          <Button size="xs" disabled={!proxyId.trim()} onClick={() => { upsertProxy(proxyId.trim(), { shape: 'capsule', radius: 0.4, height: 1.8 }); setProxyId(''); }}>
            Add capsule
          </Button>
          <Button
            size="xs"
            disabled={!proxyId.trim()}
            onClick={() => {
              upsertProxy(proxyId.trim(), {
                shape: 'convex',
                points: [
                  { x: -0.5, y: 0, z: -0.5 },
                  { x: 0.5, y: 0, z: -0.5 },
                  { x: 0.5, y: 0, z: 0.5 },
                  { x: -0.5, y: 0, z: 0.5 },
                  { x: 0, y: 1, z: 0 },
                ],
              });
              setProxyId('');
            }}
          >
            Add convex hull
          </Button>
        </div>
        <StatRow label="Proxies" value={Object.keys(physics.proxies).length} />
        <ul className="proxy-list">
          {Object.entries(physics.proxies).map(([id, proxy]) => (
            <li key={id} className="proxy-row">
              <span className="proxy-row__id">{id}</span>
              <span className="proxy-row__shape">{proxy.shape}</span>
              <Button size="xs" variant="ghost" onClick={() => removeProxy(id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <Switch
          label="Navigation mesh"
          description="Builds a walkable-cell raster for local routing. Off by default because it costs memory."
          checked={physics.navmesh.enabled}
          onChange={(v) => setPhysics({ navmesh: { ...physics.navmesh, enabled: v } })}
        />
        {physics.navmesh.enabled && (
          <Slider label="Cell size" value={physics.navmesh.cellSize} onValueChange={(v) => setPhysics({ navmesh: { ...physics.navmesh, cellSize: Math.max(0.25, v) } })} min={0.25} max={20} step={0.25} format={(v) => `${v.toFixed(2)} m`} />
        )}
      </Panel>
    </div>
  );
}
