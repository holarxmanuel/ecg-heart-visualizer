/**
 * Backend transport: WebSocket stream + REST control.
 *
 * Both go through the Vite proxy, so the browser only ever talks to
 * localhost:3000. That is deliberate -- when the real AD8232 replaces the
 * simulator, not one URL in this file changes.
 *
 * The socket reconnects with exponential backoff. Restarting the Python server
 * mid-session should look like a two-second blip in the UI, not a dead page.
 */

const WS_URL = () => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/ecg`;
};

export class ECGConnection extends EventTarget {
  constructor() {
    super();
    /** @type {WebSocket|null} */
    this.ws = null;
    this.connected = false;
    this._retry = 0;
    this._timer = null;
    this._closedByUs = false;
    this._pingTimer = null;
  }

  connect() {
    this._closedByUs = false;
    this._open();
  }

  _open() {
    clearTimeout(this._timer);
    try {
      this.ws = new WebSocket(WS_URL());
    } catch (err) {
      this._scheduleRetry();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this._retry = 0;
      this.dispatchEvent(new CustomEvent('open'));
      // A light keepalive stops intermediate proxies from reaping an idle
      // socket during a long paused session.
      clearInterval(this._pingTimer);
      // Latency measurement drives this now (see link.js), so the keepalive
      // only has to cover the case where nothing else is pinging.
      this._pingTimer = setInterval(() => {
        this.send({ type: 'ping', client_t: performance.now() });
      }, 20000);
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatchEvent(new CustomEvent(msg.type || 'message', { detail: msg }));
    };

    this.ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this.dispatchEvent(new CustomEvent('close'));
      if (!this._closedByUs) this._scheduleRetry();
    };

    this.ws.onerror = () => {
      // onclose always follows, so retry scheduling lives there only.
      this.ws?.close();
    };
  }

  /**
   * Tear down whatever socket we have and open a fresh one, immediately.
   *
   * Deliberately does NOT trust `readyState`. A WebSocket whose network has
   * gone away stays in OPEN for a long time -- TCP does not find out until a
   * send fails or a keepalive expires -- so a reconnect that skips out when
   * the socket "looks" connected will never fire, and the app stays stuck in
   * fallback forever. That is the exact failure a dropped wifi link or a
   * laptop waking from sleep produces.
   */
  forceReconnect() {
    if (this._closedByUs) return;
    clearTimeout(this._timer);
    clearInterval(this._pingTimer);
    this._retry = 0;

    const old = this.ws;
    if (old) {
      // Detach first: the close we are about to cause must not schedule a
      // competing retry alongside the one we are starting here.
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try {
        old.close();
      } catch {
        /* already closing */
      }
    }

    this.ws = null;
    this.connected = false;
    this._open();
  }

  /** Retry now if we are genuinely disconnected, cancelling any backoff. */
  reconnectNow() {
    if (this._closedByUs || this.connected) return;
    clearTimeout(this._timer);
    this._retry = 0;
    this._open();
  }

  _scheduleRetry() {
    this._retry = Math.min(this._retry + 1, 6);
    const delay = Math.min(500 * 2 ** (this._retry - 1), 8000);
    this.dispatchEvent(new CustomEvent('retry', { detail: { delay } }));
    this._timer = setTimeout(() => this._open(), delay);
  }

  /**
   * Send a control message. Returns false when the socket is not open rather
   * than throwing -- callers are on the acquisition path and must not have to
   * guard every send.
   */
  send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this._closedByUs = true;
    clearTimeout(this._timer);
    clearInterval(this._pingTimer);
    this.ws?.close();
  }
}

// ---------------------------------------------------------------------------
// REST control surface
// ---------------------------------------------------------------------------

/**
 * How long any control call waits before giving up.
 *
 * Not optional, and not a nicety. `fetch` has no default timeout, and a
 * network that hangs is a different failure from one that fails: a machine
 * still associated with a wifi network that has no route out never rejects,
 * it stalls until a TCP timeout that can be tens of seconds. boot() awaits
 * api.config(), so without this the whole launch parks on a half-drawn shell
 * and the app looks broken -- which is exactly how it looked to the first
 * person who installed it and then switched their wifi off.
 *
 * A hard offline was never the dangerous case: that rejects immediately and
 * the fallback runs. Only the hang needs a clock.
 */
const REQUEST_TIMEOUT_MS = 5000;

async function request(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...init } = options;

  // AbortController rather than AbortSignal.timeout, which is newer than some
  // of the browsers this has to run on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...init,
    });
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body?.error || body?.detail || `HTTP ${res.status}`;
    const err = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  status: () => request('/api/status'),
  config: () => request('/api/config'),

  /** List COM ports, best Arduino candidate first. */
  ports: () => request('/api/ports'),

  /**
   * THE HARDWARE SWAP.
   * mode 'simulate' -> synthetic AD8232; 'serial' -> the real board; 'off'.
   */
  setSource: (mode, port = null, baud = null) =>
    request('/api/source', {
      method: 'POST',
      body: JSON.stringify({ mode, port, baud }),
    }),

  setSimulation: (patch) =>
    request('/api/simulation', { method: 'POST', body: JSON.stringify(patch) }),

  setMonitor: (running) =>
    request('/api/monitor', { method: 'POST', body: JSON.stringify({ running }) }),

  reset: () => request('/api/reset', { method: 'POST' }),
};
