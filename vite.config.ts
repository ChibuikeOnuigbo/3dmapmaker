/**
 * Repo-root Vite config.
 *
 * The real configuration lives in `apps/web/vite.config.ts`, because
 * `npm run dev -w @3dmm/web` runs Vite with `apps/web` as the working
 * directory and Vite only auto-discovers a config there. This file exists so
 * that running Vite from the repository root resolves to the same settings
 * rather than to Vite's defaults.
 */
export { default } from './apps/web/vite.config';
