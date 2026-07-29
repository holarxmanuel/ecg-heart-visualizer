/**
 * Post-build step: generate dist/sw.js and dist/version.json.
 *
 * Run automatically by `npm run build`. It walks the finished dist/ tree, so
 * the precache list always matches exactly what Vite emitted -- a hand-written
 * list drifts the moment a chunk is renamed, and the failure is silent until
 * someone is offline.
 *
 * The build id is the git commit when available, falling back to a content
 * hash of dist/. Either way it changes whenever the app changes, which is what
 * drives both the service-worker cache swap and the in-app update prompt.
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('./dist/', import.meta.url).pathname;
const ROOT = new URL('../', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(DIST);

// Precache the shell: HTML, JS, CSS, the manifest and the icons. Deliberately
// not source maps or anything large that is not needed to render offline.
const precache = files
  .map((f) => '/' + relative(DIST, f).split('\\').join('/'))
  .filter((p) => /\.(html|js|css|webmanifest|png|svg|woff2?)$/i.test(p))
  .filter((p) => !p.endsWith('.map') && p !== '/sw.js');

// Always include the root path -- a navigation to "/" must resolve offline,
// and it is not the same cache key as "/index.html".
if (!precache.includes('/index.html')) precache.push('/index.html');
precache.push('/');

let version = '0.0.0';
try {
  version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
} catch {
  /* VERSION is optional in a bare checkout */
}

let commit = null;
try {
  commit = execSync('git rev-parse --short=9 HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* not a git checkout */
}

// Content hash of everything we are about to ship. This is what makes the
// build id move during development, when the commit has not changed yet.
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(readFileSync(f));
const contentHash = hash.digest('hex').slice(0, 9);

const buildId = commit ? `${version}+${commit}.${contentHash}` : `${version}+${contentHash}`;

const template = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8');
// replaceAll, not replace: a single replace substitutes only the first
// occurrence, so any mention of a placeholder earlier in the file (a comment,
// say) silently eats the substitution and leaves the real token in the output.
// The service worker then throws on install and every client loses offline
// support -- with no build error to point at it.
const sw = template
  .replaceAll('__BUILD_ID__', buildId)
  .replaceAll('__PRECACHE__', JSON.stringify([...new Set(precache)].sort(), null, 2));

if (sw.includes('__BUILD_ID__') || sw.includes('__PRECACHE__')) {
  throw new Error('sw.js still contains unsubstituted placeholders');
}

writeFileSync(join(DIST, 'sw.js'), sw);

// Served with no-store (see the Caddyfile) so a client always sees the truth.
writeFileSync(
  join(DIST, 'version.json'),
  JSON.stringify(
    { version, commit, contentHash, buildId, builtAt: new Date().toISOString() },
    null,
    2
  )
);

console.log(`sw.js      build ${buildId}`);
console.log(`           ${precache.length} files precached`);
