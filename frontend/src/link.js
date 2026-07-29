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

/** Round trips to keep for the latency readout. */
const RTT_WINDOW = 8;
const PING_INTERVAL_MS = 3000;

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
    /** Set once the server has ever answered, so we can tell "not yet" from "lost". */
    this.everConnected = false;

    this._rtts = [];
    this._pingTimer = null;
    this._pendingPing = null;
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
      // the authoritative source and the one other viewers are watching.
      if (this.mode === LinkMode.LOCAL && this._fellBackAutomatically) {
        this.useServer({ automatic: true });
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
    // Useful as a hint only -- it changes fast and costs nothing to observe --
    // but the socket state above is what the UI actually trusts.
    window.addEventListener('online', () => this._emitLink());
    window.addEventListener('offline', () => {
      this.rtt = null;
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
  }

  _ping() {
    if (!this.conn.connected) return;
    // Stamp with our own clock and have the server echo it back untouched.
    // Comparing against the server's clock instead would fold an arbitrary
    // offset between two unsynchronised machines into the reading.
    const t = performance.now();
    this._pendingPing = t;
    this.conn.send({ type: 'ping', client_t: t });
  }

  _onPong(msg) {
    const sent = msg?.client_t ?? this._pendingPing;
    if (sent == null) return;
    const rtt = performance.now() - sent;
    this._pendingPing = null;

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
