/**
 * The whole server pipeline, in the browser.
 *
 * This is the piece that makes the app genuinely independent of the network.
 * It owns a source, a filter and a detector, runs them on the same 20 ms
 * cadence main.py uses, and emits messages in *exactly* the server's wire
 * format. Nothing downstream -- the chart, the heart, the audio, the recorder
 * -- can tell whether a batch came from the server or from here.
 *
 * Two situations use it:
 *
 *   offline    the network is gone but the user still wants the simulation.
 *              A service worker can cache the app shell; it cannot cache a
 *              Python process, so the DSP has to exist here or "offline" would
 *              really mean "replays a recording".
 *
 *   local      an AD8232 is plugged into this machine's USB. Processing the
 *              samples here costs one loop iteration instead of a network
 *              round trip, so the heart contracts on the beat rather than
 *              ~an RTT after it.
 *
 * verify_dsp.py asserts this produces bit-identical output to the server on
 * identical input, so the two paths cannot silently disagree about heart rate.
 */

import { ECGFilter } from './filters.js';
import { RPeakDetector } from './detector.js';
import { SimulatedSource } from './simulator.js';
import { SAMPLE_RATE, ADC_MAX, ADC_VREF, AD8232_GAIN, MAINS_HZ } from './coeffs.js';

const BATCH_INTERVAL_MS = 20;

/**
 * A source fed sample-by-sample from outside (Web Serial).
 * Implements the same read()/takeDiscontinuity() contract as SimulatedSource.
 */
export class PushSource {
  constructor(label = 'USB sensor') {
    this.sampleRate = SAMPLE_RATE;
    this.label = label;
    this.discontinuities = 0;
    this._lastReported = 0;
    this._buf = [];
    this._leadsOff = false;
    this._running = false;
    this._rxCount = 0;
    this._rateWindowStart = 0;
    this._rateWindowCount = 0;
    this._measuredRate = 0;
    // ~10 s of backlog. Beyond this the consumer is not keeping up and the
    // freshest samples matter far more than the stale ones.
    this._max = SAMPLE_RATE * 10;
  }

  start() {
    this._running = true;
    this._rateWindowStart = performance.now();
  }

  stop() {
    this._running = false;
    this._buf.length = 0;
  }

  /** Called by the transport as samples arrive. */
  push(samples, leadsOff = false) {
    this._leadsOff = leadsOff;
    for (let i = 0; i < samples.length; i++) this._buf.push(samples[i]);
    this._rxCount += samples.length;
    this._rateWindowCount += samples.length;

    const now = performance.now();
    const dt = now - this._rateWindowStart;
    if (dt >= 1000) {
      // Measured, not assumed. The UI can then prove the board is really
      // keeping up with the configured 1 kHz instead of taking it on trust.
      this._measuredRate = (this._rateWindowCount * 1000) / dt;
      this._rateWindowCount = 0;
      this._rateWindowStart = now;
    }

    if (this._buf.length > this._max) {
      this._buf.splice(0, this._buf.length - this._max);
      this.discontinuities += 1;
    }
  }

  read() {
    if (!this._running || this._buf.length === 0) return new Float64Array(0);
    const out = Float64Array.from(this._buf);
    this._buf.length = 0;
    return out;
  }

  takeDiscontinuity() {
    const changed = this.discontinuities !== this._lastReported;
    this._lastReported = this.discontinuities;
    return changed;
  }

  status() {
    return {
      mode: this._running ? 'connected' : 'idle',
      label: this._running ? 'USB sensor (local)' : 'Disconnected',
      port: this.label,
      baud: null,
      sample_rate: this.sampleRate,
      leads_off: this._leadsOff,
      detail: `AD8232 via Web Serial · ${this._measuredRate.toFixed(0)} Hz measured`,
      extra: {
        local: true,
        measured_rate_hz: Math.round(this._measuredRate),
        samples_rx: this._rxCount,
      },
    };
  }
}

export class LocalEngine extends EventTarget {
  constructor() {
    super();
    this.filter = new ECGFilter();
    this.detector = new RPeakDetector();
    /** @type {SimulatedSource|PushSource|null} */
    this.source = null;

    this.paused = false;
    this.seq = 0;
    this.samplesTotal = 0;
    this.splices = 0;
    this.simConfig = { bpm: 60, noise: 0.15, artifacts: true };

    this._timer = null;
    this.voltsPerCount = ADC_VREF / ADC_MAX;
    this.mvPerVolt = 1000.0 / AD8232_GAIN;
  }

  get running() {
    return this.source !== null && !this.paused;
  }

  /** mode: 'simulate' | 'push' | 'off' */
  select(mode, opts = {}) {
    if (this.source) {
      this.source.stop();
      this.source = null;
    }
    this._resetProcessing();

    if (mode === 'off') {
      this.emitStatus();
      return null;
    }

    if (mode === 'simulate') {
      this.source = new SimulatedSource({ ...this.simConfig });
    } else if (mode === 'push') {
      this.source = new PushSource(opts.label);
    } else {
      throw new Error(`unknown local mode: ${mode}`);
    }

    this.source.start();
    this.paused = false;
    this.emitStatus();
    return this.source;
  }

  configureSimulation(patch) {
    for (const k of ['bpm', 'noise', 'artifacts']) {
      if (patch[k] != null) this.simConfig[k] = patch[k];
    }
    if (this.source instanceof SimulatedSource) this.source.configure(patch);
  }

  _resetProcessing() {
    this.filter.reset();
    this.detector.reset();
    this.samplesTotal = 0;
    this.seq = 0;
    this.splices = 0;
  }

  reset() {
    this._resetProcessing();
    this.emitStatus();
  }

  start() {
    if (this._timer !== null) return;
    // setInterval rather than rAF: the acquisition cadence must not be tied to
    // the compositor. A backgrounded tab throttles rAF to ~1 Hz, which would
    // stall the pipeline entirely; timers are throttled far less aggressively.
    this._timer = setInterval(() => this._tick(), BATCH_INTERVAL_MS);
    this.dispatchEvent(new CustomEvent('hello', { detail: this.hello() }));
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    if (this.source) {
      this.source.stop();
      this.source = null;
    }
  }

  hello() {
    return {
      type: 'hello',
      fs: SAMPLE_RATE,
      adc_max: ADC_MAX,
      adc_vref: ADC_VREF,
      gain: AD8232_GAIN,
      mains_hz: MAINS_HZ,
      batch_ms: BATCH_INTERVAL_MS,
      sim: { ...this.simConfig },
      local: true,
      status: this.status(),
    };
  }

  status() {
    const base =
      this.source === null
        ? {
            mode: 'idle',
            label: 'Disconnected',
            port: null,
            baud: null,
            sample_rate: SAMPLE_RATE,
            leads_off: false,
            detail: 'No local source',
            extra: {},
          }
        : this.source.status();

    if (this.paused && (base.mode === 'simulating' || base.mode === 'connected')) {
      base.label = 'Paused';
    }

    return {
      ...base,
      paused: this.paused,
      running: this.running,
      beats_total: this.detector.beatCount,
      bpm: Math.round(this.detector.bpm * 10) / 10,
      samples_total: this.samplesTotal,
      clients: 1,
      dropped_frames: 0,
      splices: this.splices,
      local: true,
      last_error: null,
    };
  }

  emitStatus() {
    this.dispatchEvent(
      new CustomEvent('status', { detail: { type: 'status', status: this.status() } })
    );
  }

  _tick() {
    const src = this.source;
    if (!src) return;

    const raw = src.read();
    // Drain even while paused, or a resume would fast-forward through the
    // whole accumulated backlog.
    if (raw.length === 0 || this.paused) return;

    if (src.takeDiscontinuity()) {
      // Warn the detector before it sees the step edge, not after.
      this.detector.notifyDiscontinuity();
      this.splices += 1;
    }

    const volts = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) volts[i] = raw[i] * this.voltsPerCount;

    const filteredV = this.filter.process(volts);
    const beats = this.detector.process(filteredV);

    const startIndex = this.samplesTotal;
    this.samplesTotal += raw.length;
    this.seq += 1;

    // Refer the trace back to millivolts at the electrodes -- the unit a
    // clinician expects on the y-axis.
    const filt = new Array(filteredV.length);
    for (let i = 0; i < filteredV.length; i++) {
      filt[i] = Math.round(filteredV[i] * this.mvPerVolt * 1000) / 1000;
    }

    const rawOut = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) rawOut[i] = raw[i] | 0;

    this.dispatchEvent(
      new CustomEvent('batch', {
        detail: {
          type: 'batch',
          seq: this.seq,
          i0: startIndex,
          t: Date.now(),
          raw: rawOut,
          filt,
          beats: beats.map((b) => ({
            n: b.number,
            i: b.chunkIndex,
            bpm: b.bpm,
            bpm_avg: b.bpmAvg,
            rr_ms: b.rrMs,
            amp: b.amplitude,
            // Locally there is no network delay, so age is purely how far back
            // in this chunk the beat sits.
            age_ms: Math.round(((raw.length - b.chunkIndex) * 1000) / SAMPLE_RATE * 10) / 10,
          })),
          bpm: Math.round(this.detector.bpm * 10) / 10,
          beats_total: this.detector.beatCount,
          leads_off: src.status().leads_off,
          local: true,
        },
      })
    );

    // ~4 status frames a second, matching the server's cadence.
    if (this.seq % 12 === 0) this.emitStatus();
  }
}
