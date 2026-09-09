/**
 * Service worker: makes the app survive losing the network, and makes updates
 * arrive without anyone being stranded on a stale build.
 *
 * The build id and precache list below are substituted by build-sw.mjs after
 * the Vite build, so the cache name changes whenever the contents change.
 * That is the whole update mechanism: a new build means a new cache, the old
 * one is deleted, and nothing has to be invalidated by hand.
 *
 * Strategy, and why each is what it is:
 *
 *   app shell (JS/CSS/icons)  cache-first. Filenames are content-hashed by
 *                             Vite, so a cached file can never be stale -- a
 *                             changed file has a different name.
 *
 *   index.html                network-first with a cache fallback. It is NOT
 *                             content-hashed, so serving it cache-first would
 *                             pin users to an old build permanently. This is
 *                             the single most important choice in this file.
 *
 *   /api, /ws                 never cached. A cached heart rate is not a
 *                             degraded reading, it is a wrong one.
 */

const BUILD_ID = '__BUILD_ID__';
const CACHE = `ecg-shell-${BUILD_ID}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll is atomic-ish: one failure aborts the install, which is what we
      // want. A half-populated shell cache would "work" until it hit the gap.
      await cache.addAll(PRECACHE);
      // Do NOT skipWaiting here. The new worker waits until the user accepts
      // the update, so a running monitoring session is never swapped out from
      // under the person watching it.
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('ecg-shell-') && n !== CACHE).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  // Sent by the page when the user clicks "Update now".
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_BUILD_ID') {
    event.source?.postMessage({ type: 'BUILD_ID', buildId: BUILD_ID });
  }
});

/** How long a navigation waits for the network before using the cached shell. */
const NAV_TIMEOUT_MS = 2500;

/**
 * Reject if `promise` has not settled in `ms`.
 *
 * Deliberately not AbortController: aborting the fetch would also cancel a
 * response that was nearly there, and letting it finish costs nothing once we
 * have stopped waiting on it.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * Last resort when even the shell is not cached: a real page, not a bare
 * string. Someone who installed the app and went offline before the worker
 * finished caching gets an explanation and a retry rather than a blank frame.
 */
const OFFLINE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECG Heart Visualizer</title><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0f14;
color:#e6edf3;font:14px/1.6 system-ui,sans-serif;text-align:center;padding:24px}
h1{font-size:16px;letter-spacing:.08em;text-transform:uppercase;color:#ff4d6d}
button{margin-top:16px;padding:10px 18px;border-radius:8px;border:1px solid #30363d;
background:#161b22;color:#e6edf3;font:inherit;cursor:pointer}
</style></head><body><div><h1>ECG Heart Visualizer</h1>
<p>This copy is not fully downloaded yet, so it cannot start offline.<br>
Reconnect once and reopen the app; after that it works with no connection.</p>
<button onclick="location.reload()">Try again</button></div></body></html>`;

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws');
}

/**
 * Downloads that must never be answered from cache.
 *
 * The presentation deck lives here. Everything else this worker caches is
 * content-hashed, so a cached copy can never be stale; these files keep the
 * same names while their contents are replaced, and the cache-first rule below
 * would therefore pin whoever downloaded them once to that version for good.
 * That is exactly what happened: a rebuilt deck kept downloading as the old
 * one. They are also several megabytes of files nobody needs offline.
 */
function isDownload(url) {
  return url.pathname.startsWith('/slides/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only ever handle our own origin. Anything else is passed straight through.
  if (url.origin !== self.location.origin) return;

  // Live data, and downloads whose names outlive their contents, must never
  // come from a cache.
  if (isApiRequest(url) || isDownload(url)) return;

  // Navigations: network first, fall back to the cached shell.
  //
  // Two things here are load-bearing and both were learned the hard way.
  //
  // The fetch is raced against a timeout. "Offline" is not always a fast
  // failure: a laptop still associated with a wifi network that has no route
  // out does not reject, it hangs until a TCP timeout, and a bare `await
  // fetch` therefore stalls the whole launch for tens of seconds. The user
  // sees a half-drawn shell and concludes the app is broken. A cached shell
  // now beats a fresh one later, so anything slower than the timeout loses.
  //
  // The fresh copy is NOT written back into this cache. index.html is the only
  // file here that is not content-hashed, so a newer one names asset files
  // this cache does not contain -- and then the offline fallback serves an
  // index that requests assets that 404, which renders as a page that loads
  // "partly". The precached index and the precached assets are one matched
  // set, and they must stay that way. A newer build gets its own cache, via
  // its own worker, atomically.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('/index.html');
        try {
          const fresh = await withTimeout(fetch(req), NAV_TIMEOUT_MS);
          return fresh;
        } catch {
          return cached ?? new Response(OFFLINE_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // Everything else (hashed assets, icons, manifest): cache first.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        // A miss while offline for an asset we never cached. Nothing useful to
        // return, but failing loudly beats returning a wrong body.
        return new Response('', { status: 504 });
      }
    })()
  );
});
