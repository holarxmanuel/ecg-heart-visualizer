/**
 * Where does the data come from right now -- and how far behind is it?
 *
 * The app can be driven from three places, and the user must never have to
 * care which:
 *
 *   server   the WebSocket stream from the always-on backend (default)
 *   local    the JS DSP in this tab, when the network is gone or when a USB
 *            sensor is attached here and a round trip would only add latency
 *   hybrid   USB sensor read locally, processed locally, and *also* forwarded
 *            to the server so the session is recorded centrally
 *
 * This class owns the switch and re-emits everything under one event surface,
 * so main.js keeps listening for 'hello' / 'batch' / 'status' exactly as it
 * did when the server was the only option.
 *
 * It also owns the two honesty features the dashboard needs. `navigator.onLine`
 * is not one of them: it reports whether a network interface exists, not
 * whether this server is reachable, and it cheerfully returns true on a
 * captive-portal wifi that drops every packet. The socket's own state is the
 * only trustworthy signal, so that is what drives the indicator.
 */

import { ECGConnection, api } from './net.js';
import { LocalEngine } from './dsp/engine.js';
import { AppMode } from './mode.js';

/** Round trips to keep for the latency readout. */
const RTT_WINDOW = 8;
const PING_INTERVAL_MS = 3000;
/**
 * Unanswered pings before the socket is written off. Three at 3 s is ~9 s of
 * silence -- long enough not to trip on a GC pause or a congested link, short
 * enough that a user does not sit watching a frozen "Live" badge.
 */
const MISSED_PONGS_BEFORE_DEAD = 3;

export const LinkMode = {
  SERVER: 'server',
  LOCAL: 'local',
  HYBRID: 'hybrid',
};

export class Link extends EventTarget {
  constructor() {
    super();
    this.conn = new ECGConnection();
    this.engine = new LocalEngine();

    this.mode = LinkMode.SERVER;
    this.serverUp = false;
    /**
     * The user's *preference* (see mode.js), which is not the same as what is
     * actually running. An installed app set to online still processes
     * locally while the connection is down -- the trace must never stop.
     */
    this.userMode = AppMode.ONLINE;
    /** True when we are on local only because the server went away. */
    this.degraded = false;
    /** Set once the server has ever answered, so we can tell "not yet" from "lost". */
    this.everConnected = false;

    this._rtts = [];
    this._pingTimer = null;
    this._pendingPing = null;
    /**
     * Consecutive pings that got no answer. A socket can sit in readyState
     * OPEN long after its network has gone, so "did the server answer" is the
     * only liveness signal worth trusting.
     */
    this._missedPongs = 0;
    this.rtt = null;
    /** Newest beat's age in ms, straight from the stream -- true end-to-end lag. */
    this.beatAge = null;

    this._wireServer();
    this._wireLocal();
    this._wireBrowserOnline();
  }

  // -- wiring -------------------------------------------------------------

  _wireServer() {
    this.conn.addEventListener('hello', (e) => {
      if (this.mode !== LinkMode.LOCAL) this._relay('hello', e.detail);
    });

    this.conn.addEventListener('batch', (e) => {
      if (this.mode === LinkMode.SERVER) {
        const beats = e.detail.beats;
        if (beats?.length) this.beatAge = beats[beats.length - 1].age_ms;
        this._relay('batch', e.detail);
      }
    });

    this.conn.addEventListener('status', (e) => {
      if (this.mode === LinkMode.SERVER) this._relay('status', e.detail);
    });

    this.conn.addEventListener('pong', (e) => this._onPong(e.detail));

    this.conn.addEventListener('open', () => {
      this.serverUp = true;
      this.everConnected = true;
      this._startPinging();
      this._emitLink();
      // Coming back from an outage: hand control back to the server, which is
      // the authoritative source and the one other viewers are watching. But
      // only if the user actually wants online -- someone who deliberately
      // chose offline must not be yanked back by a network event.
      if (this.degraded && this.userMode === AppMode.ONLINE) {
        this.degraded = false;
        this.useServer({ automatic: true });
        this.dispatchEvent(new CustomEvent('restored'));
      }
    });

    this.conn.addEventListener('close', () => {
      this.serverUp = false;
      this.rtt = null;
      this._stopPinging();
      this._emitLink();
      // Keep the trace alive on local simulation rather than freezing. A
      // monitor that silently stops updating is the one failure mode that
      // actively misleads.
      if (this.mode === LinkMode.SERVER) this._fallBackToLocal();
    });
  }

  _wireLocal() {
    this.engine.addEventListener('hello', (e) => {
      if (this.mode !== LinkMode.SERVER) this._relay('hello', e.detail);
    });
    this.engine.addEventListener('batch', (e) => {
      if (this.mode !== LinkMode.SERVER) {
        const beats = e.detail.beats;
        if (beats?.length) this.beatAge = beats[beats.length - 1].age_ms;
        this._relay('batch', e.detail);
      }
    });
    this.engine.addEventListener('status', (e) => {
      if (this.mode !== LinkMode.SERVER) this._relay('status', e.detail);
    });
  }

  _wireBrowserOnline() {
    // `navigator.onLine` is not trustworthy on its own -- it reports whether an
    // interface exists, and returns true on a captive portal that drops every
    // packet -- so the socket's own state remains the authority. But the events
    // fire *immediately*, whereas a dead socket is only noticed when a send
    // fails or a timeout expires. Using both gives an indicator that reacts at
    // once and is still correct.
    window.addEventListener('online', () => {
      this._emitLink();
      // Rebuild the socket rather than politely retrying. After an outage the
      // old one usually still reports OPEN despite being dead, so anything
      // conditional on `connected` would decline to act and leave the app
      // stranded in fallback.
      if (this.userMode === AppMode.ONLINE) {
        this.conn.forceReconnect();
      }
    });

    window.addEventListener('offline', () => {
      this.rtt = null;
      this.serverUp = false;
      // Do not wait for the socket to notice. The interface is gone; anything
      // that needs the network is unusable as of right now, and the UI must
      // say so without a refresh.
      if (this.mode === LinkMode.SERVER) this._fallBackToLocal();
      this._emitLink();
    });
  }

  _relay(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _emitLink() {
    this.dispatchEvent(new CustomEvent('link', { detail: this.state() }));
  }

  // -- latency ------------------------------------------------------------

  _startPinging() {
    this._stopPinging();
    this._ping();
    this._pingTimer = setInterval(() => this._ping(), PING_INTERVAL_MS);
  }

  _stopPinging() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
    this._pendingPing = null;
    this._missedPongs = 0;
  }

  _ping() {
    if (!this.conn.connected) return;

    // The previous ping is still outstanding, so it was never answered.
    if (this._pendingPing !== null) {
      this._missedPongs += 1;
      if (this._missedPongs >= MISSED_PONGS_BEFORE_DEAD) {
        this._declareDead();
        return;
      }
    }

    // Stamp with our own clock and have the server echo it back untouched.
    // Comparing against the server's clock instead would fold an arbitrary
    // offset between two unsynchronised machines into the reading.
    const t = performance.now();
    this._pendingPing = t;
    if (!this.conn.send({ type: 'ping', client_t: t })) {
      // send() refused -- the socket is definitely not usable.
      this._declareDead();
    }
  }

  /**
   * The socket claims to be open but the server is not answering. Treat it as
   * gone: drop to local processing so the trace keeps moving, and rebuild the
   * connection from scratch rather than waiting for a close that may never
   * arrive.
   */
  _declareDead() {
    this._stopPinging();
    this.serverUp = false;
    this.rtt = null;
    if (this.mode === LinkMode.SERVER) this._fallBackToLocal();
    this._emitLink();
    this.conn.forceReconnect();
  }

  _onPong(msg) {
    const sent = msg?.client_t ?? this._pendingPing;
    if (sent == null) return;
    const rtt = performance.now() - sent;
    this._pendingPing = null;
    this._missedPongs = 0;

    // A pong is proof of life, which matters when the socket had been written
    // off but recovered before the reconnect completed.
    if (!this.serverUp) {
      this.serverUp = true;
      this.everConnected = true;
    }

    this._rtts.push(rtt);
    if (this._rtts.length > RTT_WINDOW) this._rtts.shift();

    // Median, not mean: one scheduling hiccup should not make the readout
    // jump, and the user is being shown this to decide whether to trust the
    // animation's timing.
    const sorted = [...this._rtts].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    this.rtt =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    this._emitLink();
  }

  // -- mode switching -----------------------------------------------------

  _fallBackToLocal() {
    this._fellBackAutomatically = true;
    this.degraded = true;
    this.mode = LinkMode.LOCAL;
    this.engine.start();
    this.engine.select('simulate');
    this._emitLink();
    this.dispatchEvent(
      new CustomEvent('fallback', {
        detail: {
          reason: this.everConnected ? 'lost' : 'unreachable',
        },
      })
    );
  }

  /**
   * Apply the user's chosen mode.
   *
   * Online with no server is not an error -- it means "prefer the server, run
   * locally until it is there", which is exactly what degraded mode is.
   */
  applyUserMode(mode, { keepSensor = true } = {}) {
    this.userMode = mode;

    if (mode === AppMode.OFFLINE) {
      this.degraded = false;
      // A locally-attached sensor keeps feeding the local engine; only the
      // simulation needs re-selecting.
      const sourceMode = keepSensor && this.engine.source ? null : 'simulate';
      this.engine.start();
      if (sourceMode) this.engine.select(sourceMode);
      this.mode = this.mode === LinkMode.HYBRID ? LinkMode.LOCAL : LinkMode.LOCAL;
      this._emitLink();
      return;
    }

    if (this.serverUp) {
      this.degraded = false;
      this.useServer();
    } else {
      // Wanted online, cannot have it yet. Run locally and say so.
      this._fallBackToLocal();
    }
  }

  /** Drive from the server. */
  useServer({ automatic = false } = {}) {
    this._fellBackAutomatically = automatic;
    this.engine.stop();
    this.mode = LinkMode.SERVER;
    this._emitLink();
  }

  /** Drive from the local JS pipeline (offline simulation, or a local sensor). */
  useLocal(sourceMode = 'simulate', opts = {}) {
    this._fellBackAutomatically = false;
    this.mode = opts.hybrid ? LinkMode.HYBRID : LinkMode.LOCAL;
    this.engine.start();
    const src = this.engine.select(sourceMode, opts);
    this._emitLink();
    return src;
  }

  /**
   * Forward locally-read sensor samples to the server.
   * Fire-and-forget: a failed send must never stall acquisition.
   */
  forwardSamples(samples, leadsOff) {
    if (!this.conn.connected) return false;
    return this.conn.send({
      type: 'samples',
      data: Array.from(samples),
      leads_off: !!leadsOff,
    });
  }

  connect() {
    this.conn.connect();
  }

  state() {
    return {
      mode: this.mode,
      userMode: this.userMode,
      degraded: this.degraded,
      serverUp: this.serverUp,
      everConnected: this.everConnected,
      browserOnline: navigator.onLine,
      rtt: this.rtt,
      beatAge: this.beatAge,
      local: this.mode !== LinkMode.SERVER,
    };
  }

  /** Quality band for the latency readout, matching the colour coding. */
  static latencyGrade(rtt) {
    if (rtt == null) return 'none';
    if (rtt < 80) return 'good';
    if (rtt < 200) return 'fair';
    return 'poor';
  }
}

export { api };
