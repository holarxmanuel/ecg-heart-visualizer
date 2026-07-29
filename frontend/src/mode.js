/**
 * Online vs offline, and who is allowed to choose.
 *
 * Two genuinely different things run this app, and they get different powers:
 *
 *   ONLINE   Samples go to the server, the server's signal chain processes
 *            them, and the result comes back. Needs a live connection.
 *
 *   OFFLINE  Everything happens in this browser using frontend/src/dsp, which
 *            verify_dsp.py proves is bit-identical to the server's chain. No
 *            connection needed at all.
 *
 * Who may switch:
 *
 *   Browser tab on the hosted site   LOCKED to online. Someone who just opened
 *                                    a URL has not installed anything; letting
 *                                    them pick "offline" would imply a
 *                                    persistence guarantee a tab does not have.
 *
 *   Installed app (standalone PWA)   FREE CHOICE. The whole point of
 *                                    installing is that the machine can do the
 *                                    work itself. The user may still prefer
 *                                    online -- to have the session recorded
 *                                    server-side, or for others to watch --
 *                                    so it is a toggle, not an automatic
 *                                    switch.
 *
 *   Local clone on localhost         FREE CHOICE. Same reasoning; the server
 *                                    is their own machine.
 *
 * Note this is the user's *preference*. It is not the same as what is actually
 * running: an installed app set to online falls back to local processing the
 * instant the connection drops, so the trace never stops. Link owns that.
 */

export const AppMode = {
  ONLINE: 'online',
  OFFLINE: 'offline',
};

const STORAGE_KEY = 'ecg.mode';

/** Running as an installed app rather than in a browser tab. */
export function isInstalled() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
    // iOS Safari predates the display-mode media query.
    window.navigator.standalone === true
  );
}

/** Served from this machine, so "the server" is local anyway. */
export function isLocalhost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export class ModeManager extends EventTarget {
  constructor() {
    super();
    this.installed = isInstalled();
    this.localhost = isLocalhost();
    this.canToggle = this.installed || this.localhost;

    this.mode = this._initialMode();

    // An install can complete while the page is open, and on some platforms
    // the display-mode flips without a reload. Re-evaluate rather than
    // leaving the toggle stuck disabled until the user restarts the app.
    window.matchMedia?.('(display-mode: standalone)').addEventListener?.(
      'change',
      (e) => {
        this.installed = e.matches;
        this.canToggle = this.installed || this.localhost;
        this._emit();
      }
    );
  }

  _initialMode() {
    if (!this.canToggle) return AppMode.ONLINE;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === AppMode.OFFLINE || saved === AppMode.ONLINE) return saved;
    } catch {
      // Private browsing can throw on localStorage. Not worth failing over.
    }
    // Default an installed app to online: it is the richer mode, and it
    // degrades to local by itself the moment the connection goes.
    return AppMode.ONLINE;
  }

  set(mode) {
    if (!this.canToggle && mode !== AppMode.ONLINE) return false;
    if (mode !== AppMode.ONLINE && mode !== AppMode.OFFLINE) return false;
    if (mode === this.mode) return true;

    this.mode = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* preference simply will not persist */
    }
    this._emit();
    return true;
  }

  toggle() {
    return this.set(this.mode === AppMode.ONLINE ? AppMode.OFFLINE : AppMode.ONLINE);
  }

  get isOnline() {
    return this.mode === AppMode.ONLINE;
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('change', { detail: this.state() }));
  }

  state() {
    return {
      mode: this.mode,
      canToggle: this.canToggle,
      installed: this.installed,
      localhost: this.localhost,
      // Why the toggle is locked, phrased for a user rather than a developer.
      lockedReason: this.canToggle
        ? null
        : 'Install the app to use offline mode. In a browser tab the app always runs through the server.',
    };
  }
}
