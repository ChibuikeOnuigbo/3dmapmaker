/**
 * apps/web — the authoritative Vite config.
 *
 * This file lives next to the app because `npm run dev -w @3dmm/web` runs Vite
 * with `apps/web` as the working directory, and Vite only auto-discovers a
 * config in that directory. Keeping the real config here means the dev server,
 * the build and the preview all get the same aliases, worker plugin and host
 * allow-list. The repo-root `vite.config.ts` simply re-exports this one.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/** Resolve a path relative to the monorepo root (two levels up from here). */
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/**
 * Source aliases for every workspace package. Pointing straight at the sources
 * means a change in `packages/*` hot-reloads without a build step, and it keeps
 * one copy of each module — a symlinked `node_modules` entry would otherwise
 * give three.js two module instances.
 */
const workspaceAliases = {
  '@3dmm/gis': root('packages/gis/src/index.ts'),
  '@3dmm/project': root('packages/project/src/index.ts'),
  '@3dmm/layers': root('packages/layers/src/index.ts'),
  '@3dmm/terrain': root('packages/terrain/src/index.ts'),
  '@3dmm/camera': root('packages/camera/src/index.ts'),
  '@3dmm/input': root('packages/input/src/index.ts'),
  '@3dmm/panorama': root('packages/panorama/src/index.ts'),
  '@3dmm/scene-core': root('packages/scene-core/src/index.ts'),
  '@3dmm/world': root('packages/world/src/index.ts'),
  '@3dmm/assets': root('packages/assets/src/index.ts'),
  '@3dmm/physics': root('packages/physics/src/index.ts'),
  '@3dmm/performance': root('packages/performance/src/index.ts'),
  '@3dmm/tutorial': root('packages/tutorial/src/index.ts'),
  '@3dmm/ui': root('packages/ui/src/index.tsx'),
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases },
  worker: {
    format: 'es',
    // Workers do not inherit `resolve.alias`, so repeat the ones they import.
    plugins: () => [
      {
        name: 'worker-alias',
        config: () => ({
          resolve: {
            alias: {
              '@3dmm/gis': root('packages/gis/src/index.ts'),
              '@3dmm/terrain': root('packages/terrain/src/index.ts'),
              '@3dmm/performance': root('packages/performance/src/index.ts'),
            },
          },
        }),
      },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The Arena preview proxies this app under a generated host, so the
    // allow-list has to accept it. `true` allows any host.
    allowedHosts: true,
    hmr: { clientPort: 443, protocol: 'wss' },
    fs: {
      // The app imports from `../../packages`, which is outside the app root.
      allow: [root('.'), root('apps/web')],
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          geotiff: ['geotiff'],
        },
      },
    },
  },
});
