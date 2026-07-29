/**
 * Keeping every copy of this app in step with the server.
 *
 * There are two ways to run the system and both must stay current:
 *
 *   web / installed PWA   Served from the always-on server. A new deploy has
 *                         to reach people who already have the page open or
 *                         the app installed -- otherwise a PWA is a very
 *                         effective way of pinning someone to an old build
 *                         forever.
 *
 *   local git clone       Someone cloned the repo and runs it on their own
 *                         machine. Nothing pushes to them, so they have to be
 *                         told, and updating means pulling code, not swapping
 *                         a cache.
 *
 * Both funnel into one 'update' event so the UI has a single banner to render.
 *
 * Nothing here ever updates without consent. A monitoring session that reloads
 * itself mid-recording would lose the recording, so the user always clicks.
 */

const POLL_MS = 60_000;

export const UpdateKind = {
  /** New build on the server; reload swaps to it. */
  SHELL: 'shell',
  /** Local checkout is behind the repository; needs a git pull. */
  CLONE: 'clone',
};

export class UpdateManager extends EventTarget {
  /**
   * @param {() => boolean} [gate] returns false when the app must not touch
   *   the network at all. Offline mode means offline: a background poller that
   *   keeps reaching for the server contradicts the whole point of it, and
   *   fills the console with failed requests while the app is working fine.
   */
  constructor(gate = () => true) {
    super();
    this._gate = gate;
    this.registration = null;
    this.buildId = null;
    this.pending = null;
    this._timer = null;
    this._applying = false;
  }

  async start() {
    await this._registerServiceWorker();
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_MS);

    // A tab left open for days should check the moment it is looked at again,
    // not up to a minute later.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._poll();
    });
    window.addEventListener('online', () => this._poll());
  }

  // -- service worker -----------------------------------------------------

  async _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Service workers require a secure context. On plain http://<ip> this
    // throws rather than silently doing nothing, so guard instead of catching.
    if (!window.isSecureContext) {
      this.dispatchEvent(
        new CustomEvent('insecure', {
          detail: {
            message:
              'Offline mode and USB sensors need a secure (https) connection.',
          },
        })
      );
      return;
    }

    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      this.registration = reg;

      // Already waiting when the page loaded: an update arrived while the tab
      // was closed.
      if (reg.waiting && navigator.serviceWorker.controller) {
        this._offer(UpdateKind.SHELL, { source: 'sw' });
      }

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `controller` is null on the very first install -- that is the
          // initial cache fill, not an update, and prompting there would be
          // confusing nonsense on someone's first visit.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            this._offer(UpdateKind.SHELL, { source: 'sw' });
          }
        });
      });

      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!this._applying || reloading) return;
        reloading = true;
        window.location.reload();
      });
    } catch (err) {
      // A failed registration must not take the app down with it.
      console.warn('Service worker registration failed:', err);
    }
  }

  // -- polling ------------------------------------------------------------

  async _poll() {
    if (!navigator.onLine) return;
    if (!this._gate()) return;

    // Ask the service worker to re-check for a new script. This is what makes
    // an installed PWA notice a deploy without the user reloading.
    try {
      await this.registration?.update();
    } catch {
      /* offline or the server is down; the next tick retries */
    }

    await this._checkServerBuild();
    await this._checkCloneVersion();
  }

  /**
   * Has the *frontend* been rebuilt since this page loaded?
   *
   * Deliberately reads version.json, which build-sw.mjs writes, rather than
   * /api/version, which is derived from the git commit. They diverge for good
   * reasons -- a backend-only or docs-only commit moves the commit id without
   * changing a single byte the browser runs -- and prompting someone to reload
   * for a build identical to the one they already have is worse than not
   * prompting at all: it teaches them to dismiss the banner.
   *
   * This is the fallback path for clients with no service worker (an insecure
   * origin, or a browser without support). Where one exists, its cache swap
   * has already noticed.
   */
  async _checkServerBuild() {
    try {
      const res = await fetch('/version.json', { cache: 'no-store' });
      // Absent in dev (vite serves from source, there is no build). Nothing to
      // compare, so nothing to offer.
      if (!res.ok) return;
      const info = await res.json();
      if (!info.buildId) return;

      if (this.buildId === null) {
        this.buildId = info.buildId;
        return;
      }
      if (info.buildId !== this.buildId) {
        this._offer(UpdateKind.SHELL, {
          source: 'version.json',
          from: this.buildId,
          to: info.buildId,
          version: info.version,
        });
      }
    } catch {
      /* server unreachable -- the offline banner covers this */
    }
  }

  /**
   * For a locally-run clone: is the checkout behind the published repo?
   * The hosted deployment answers this too, but its own updates arrive by
   * deploy, so the banner it produces is informational only.
   */
  async _checkCloneVersion() {
    try {
      const res = await fetch('/api/update/check', { cache: 'no-store' });
      if (!res.ok) return;
      const info = await res.json();
      if (info.update_available && info.is_git_clone) {
        this._offer(UpdateKind.CLONE, {
          localVersion: info.local_version,
          remoteVersion: info.remote_version,
          reason: info.reason,
          dirty: info.dirty,
          repo: info.repo,
        });
      }
    } catch {
      /* endpoint absent or unreachable */
    }
  }

  _offer(kind, detail) {
    // Do not re-fire the same offer every poll -- one banner, until acted on.
    const key = `${kind}:${detail.to ?? detail.remoteVersion ?? 'pending'}`;
    if (this.pending?.key === key) return;
    this.pending = { key, kind, detail };
    this.dispatchEvent(new CustomEvent('update', { detail: { kind, ...detail } }));
  }

  dismiss() {
    this.pending = null;
  }

  // -- applying -----------------------------------------------------------

  /** Swap to the new build. Reloads the page. */
  applyShellUpdate() {
    this._applying = true;
    const waiting = this.registration?.waiting;
    if (waiting) {
      // The worker calls skipWaiting, which triggers controllerchange above,
      // which reloads. Reloading directly here would race the swap and could
      // land on the old build again.
      waiting.postMessage({ type: 'SKIP_WAITING' });
      // Belt and braces: if no controllerchange arrives (some browsers, some
      // states), reload anyway rather than leaving the user stuck.
      setTimeout(() => window.location.reload(), 3000);
    } else {
      window.location.reload();
    }
  }

  /**
   * Pull and rebuild a local clone. Only works on a locally-run instance --
   * the hosted server refuses this, deliberately (see backend/updater.py).
   */
  async applyCloneUpdate() {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      throw new Error(body.error || `Update failed (HTTP ${res.status})`);
    }
    return body;
  }
}
