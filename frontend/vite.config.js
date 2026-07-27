import { defineConfig } from 'vite';

/**
 * The app is served at http://localhost:3000 exactly as the PRD requires.
 *
 * /api and /ws are proxied to the FastAPI backend on :8000, which means the
 * browser only ever talks to one origin. That matters for the hardware swap:
 * no CORS surprises, no URLs to edit when you move from simulation to the
 * real AD8232 -- the frontend never knows which one is behind the proxy.
 */
export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    // Launch the browser automatically for a human, but stay quiet when an
    // automated harness (or CI) is driving the server.
    open: process.env.ECG_NO_OPEN !== '1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  // `npm run preview` serves the production build on the same port, with the
  // same proxy. Useful for checking real-world startup cost without the dev
  // server's module-transform overhead, and for a low-CPU local run.
  preview: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    target: 'es2020',
    // Split three.js out so the app shell parses and paints before the 3D
    // engine finishes loading. Keeps first paint fast on modest hardware.
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
