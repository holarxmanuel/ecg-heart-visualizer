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

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only ever handle our own origin. Anything else is passed straight through.
  if (url.origin !== self.location.origin) return;

  // Live data must never come from a cache.
  if (isApiRequest(url)) return;

  // Navigations: network first, fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match('/index.html');
          return cached ?? new Response('Offline and no cached copy available.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
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
