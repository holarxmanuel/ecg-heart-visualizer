/**
 * Geometry build benchmark.
 *
 *   node bench-heart.mjs
 *
 * The heart mesh is generated synchronously at page load, so its build time is
 * felt directly as startup latency. This measures it away from the browser,
 * with nothing else competing for the CPU, at all three quality levels.
 */
import { buildHeartGeometry } from './src/heartGeometry.js';

for (const q of ['low', 'medium', 'high']) {
  // One warm-up pass so we measure steady-state, not JIT compilation.
  buildHeartGeometry(q).geometry.dispose();

  const runs = [];
  let stats;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = buildHeartGeometry(q);
    runs.push(performance.now() - t);
    stats = r.stats;
    r.geometry.dispose();
  }
  const best = Math.min(...runs);
  const bytes = stats.vertices * 4 * 3 * 4 + (stats.triangles * 3 * 4);
  console.log(
    `${q.padEnd(7)} ${String(stats.triangles).padStart(7)} tris  ` +
    `${String(stats.vertices).padStart(7)} verts  ` +
    `${best.toFixed(0).padStart(5)} ms  ` +
    `${(bytes / 1048576).toFixed(2)} MB`,
  );
}
