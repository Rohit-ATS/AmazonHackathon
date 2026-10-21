import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The API is proxied rather than called cross-origin, so the browser sees one origin and
 * the SSE connection is not subject to CORS preflight. It also means the frontend code has
 * no base URL to configure — relative paths work in dev and in a static deployment behind
 * the same host.
 */
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@careflow/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/events': { target: 'http://localhost:8787', changeOrigin: true, ws: false },
      '/healthz': { target: 'http://localhost:8787', changeOrigin: true },
      '/ring': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
