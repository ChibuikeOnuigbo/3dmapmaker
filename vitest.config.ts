import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@3dmm/gis': r('packages/gis/src/index.ts'),
      '@3dmm/project': r('packages/project/src/index.ts'),
      '@3dmm/layers': r('packages/layers/src/index.ts'),
      '@3dmm/terrain': r('packages/terrain/src/index.ts'),
      '@3dmm/camera': r('packages/camera/src/index.ts'),
      '@3dmm/input': r('packages/input/src/index.ts'),
      '@3dmm/panorama': r('packages/panorama/src/index.ts'),
      '@3dmm/scene-core': r('packages/scene-core/src/index.ts'),
      '@3dmm/world': r('packages/world/src/index.ts'),
      '@3dmm/assets': r('packages/assets/src/index.ts'),
      '@3dmm/physics': r('packages/physics/src/index.ts'),
      '@3dmm/performance': r('packages/performance/src/index.ts'),
      '@3dmm/tutorial': r('packages/tutorial/src/index.ts'),
      '@3dmm/ui': r('packages/ui/src/index.tsx'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [r('vitest.setup.ts')],
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx', 'apps/web/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
    reporters: ['default'],
    testTimeout: 30000,
  },
});
