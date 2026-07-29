/**
 * Synthetic AD8232 in the browser -- the JS twin of ecg/simulator.py.
 *
 * This is what makes genuine offline operation possible. A service worker can
 * cache HTML and JS; it cannot cache a running Python process, so without a
 * simulator here "works offline" would mean "replays a recording".
 *
 * Emits the same thing as everything else in this system: raw 10-bit ADC
 * counts at 1000 Hz, exactly as analogRead(A0) would produce them.
 *
 * Signal chain modelled, in order:
 *   1. PQRST as a sum of Gaussians at clinically realistic offsets
 *   2. Heart-rate variability (a metronome-perfect heart is an instant tell)
 *   3. Respiratory modulation -- baseline wander + QRS amplitude swing
 *   4. AD8232 front end -- x1100 gain, 1.5 V offset
 *   5. Corruption -- Gaussian noise, mains hum, motion artifacts
 *   6. Arduino ADC -- clip to the rail, quantise to 10 bits
 */

import {
  SAMPLE_RATE,
  MAINS_HZ,
  ADC_MAX,
  ADC_VREF,
  AD8232_GAIN,
  AD8232_BASELINE_V,
  SIM_BREATHING_HZ,
} from './coeffs.js';

/**
 * Small deterministic PRNG (mulberry32).
 *
 * Deterministic on purpose: a seeded run is reproducible, which is what makes
 * the offline simulator testable at all. Math.random() cannot be replayed.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, with the spare value cached -- normals come in pairs. */
function gaussianFactory(rand) {
  let spare = null;
  return function () {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2.0 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

// (label, offset_ms_from_R, sigma_ms, amplitude_mV). Amplitudes give a ~1.0 mV
// peak-to-peak QRS, the textbook lead-I figure.
const WAVES = [
  ['P', -160.0, 25.0, 0.13],
  ['Q', -22.0, 8.0, -0.11],
  ['R', 0.0, 8.5, 0.85],
  ['S', 24.0, 11.0, -0.15],
  ['T', 185.0, 45.0, 0.32],
];

export class SimulatedSource {
  constructor({ bpm = 60, noise = 0.15, artifacts = true, seed = null } = {}) {
    this.sampleRate = SAMPLE_RATE;
    this.bpm = bpm;
    this.noise = noise;
    this.artifacts = artifacts;

    const s = seed === null ? (Math.random() * 2 ** 32) >>> 0 : seed >>> 0;
    this._rand = mulberry32(s);
    this._gauss = gaussianFactory(this._rand);

    this._running = false;
    this._t0 = 0;
    this._emitted = 0;
    this._sampleClock = 0;
    this.discontinuities = 0;
    this._lastReportedDiscontinuities = 0;

    this._template = new Float64Array(1);
    this._templatePos = 0;
    this._artifact = null;
    this._artifactPos = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._t0 = performance.now() / 1000;
    this._emitted = 0;
    this._sampleClock = 0;
    this._templatePos = 0;
    this._buildTemplate();
  }

  stop() {
    this._running = false;
    this._artifact = null;
  }

  configure({ bpm, noise, artifacts } = {}) {
    if (bpm != null) this.bpm = Math.min(Math.max(bpm, 30.0), 200.0);
    if (noise != null) this.noise = Math.min(Math.max(noise, 0.0), 1.0);
    if (artifacts != null) this.artifacts = !!artifacts;
  }

  /** Report (and clear) whether samples were lost since the last call. */
  takeDiscontinuity() {
    const changed = this.discontinuities !== this._lastReportedDiscontinuities;
    this._lastReportedDiscontinuities = this.discontinuities;
    return changed;
  }

  /** Emit however many samples real time says are now due. */
  read() {
    if (!this._running) return new Float64Array(0);

    const elapsed = performance.now() / 1000 - this._t0;
    let due = Math.floor(elapsed * this.sampleRate) - this._emitted;
    if (due <= 0) return new Float64Array(0);

    // Guard against a huge burst after the tab was backgrounded or the machine
    // was suspended. Dropping the backlog splices the waveform, which is
    // indistinguishable from a QRS to a detector that has not been warned --
    // hence the discontinuity counter.
    const maxBurst = 3 * this.sampleRate;
    if (due > maxBurst) {
      this._emitted += due - maxBurst;
      due = maxBurst;
      this.discontinuities += 1;
    }

    this._emitted += due;
    return this._generate(due);
  }

  /**
   * Generate `count` samples ignoring wall-clock pacing.
   * Used by the verification harness and by fast-forward replay.
   */
  generateForTest(count) {
    return this._generate(count);
  }

  status() {
    return {
      mode: this._running ? 'simulating' : 'idle',
      label: this._running ? 'Simulating (local)' : 'Disconnected',
      port: null,
      baud: null,
      sample_rate: this.sampleRate,
      leads_off: false,
      detail: `Local synthetic AD8232 @ ${this.bpm.toFixed(0)} BPM`,
      extra: {
        bpm: Math.round(this.bpm * 10) / 10,
        noise: Math.round(this.noise * 1000) / 1000,
        artifacts: this.artifacts,
        local: true,
      },
    };
  }

  // -- internals ----------------------------------------------------------

  /**
   * Render one full cardiac cycle at the current BPM plus a dash of HRV.
   *
   * The R-peak sits ~30% of the way in, leaving room ahead of it for the P
   * wave. Reading the template circularly means the P wave of beat N+1 trails
   * the T wave of beat N with no special-case stitching.
   */
  _buildTemplate() {
    const fs = this.sampleRate;

    // +/-2.5% RR jitter. Also exercises the detector's adaptive threshold in a
    // way a fixed rate would not.
    let jitter = 1.0 + this._gauss() * 0.025;
    jitter = Math.min(Math.max(jitter, 0.9), 1.1);
    const rrSeconds = (60.0 / this.bpm) * jitter;
    const n = Math.max(Math.round(rrSeconds * fs), 60);

    const periodMs = rrSeconds * 1000.0;
    const rIndexMs = (Math.floor(0.3 * n) / fs) * 1000.0;

    const beat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const tMs = (i / fs) * 1000.0;
      let acc = 0;
      for (let w = 0; w < WAVES.length; w++) {
        const [, offsetMs, sigmaMs, ampMv] = WAVES[w];
        const centre = rIndexMs + offsetMs;
        // Circular distance, so a wave centred off either end wraps cleanly
        // instead of being clipped.
        let d = tMs - centre;
        d = ((((d + periodMs / 2) % periodMs) + periodMs) % periodMs) - periodMs / 2;
        const z = d / sigmaMs;
        acc += ampMv * Math.exp(-0.5 * z * z);
      }
      beat[i] = acc;
    }

    this._template = beat;
    this._templatePos = 0;
  }

  /** Read `count` samples from the circular beat template, in millivolts. */
  _nextBeatChunk(count) {
    const out = new Float64Array(count);
    let written = 0;
    while (written < count) {
      const remaining = this._template.length - this._templatePos;
      const take = Math.min(count - written, remaining);
      for (let i = 0; i < take; i++) {
        out[written + i] = this._template[this._templatePos + i];
      }
      written += take;
      this._templatePos += take;
      if (this._templatePos >= this._template.length) {
        // Beat finished: rebuild with fresh HRV and whatever BPM the user
        // dialled in mid-beat.
        this._buildTemplate();
      }
    }
    return out;
  }

  _generate(count) {
    const fs = this.sampleRate;
    const n0 = this._sampleClock;
    this._sampleClock += count;

    const ecgMv = this._nextBeatChunk(count);
    const out = new Float64Array(count);
    const countsPerVolt = ADC_MAX / ADC_VREF;
    const gainMvToV = AD8232_GAIN / 1000.0;

    const artifact = this.artifacts ? this._artifactChunk(count) : null;

    for (let i = 0; i < count; i++) {
      const t = (n0 + i) / fs;

      // Respiratory sinus arrhythmia: breathing swings QRS amplitude ~8%.
      const breath = Math.sin(2 * Math.PI * SIM_BREATHING_HZ * t);
      const mv = ecgMv[i] * (1.0 + 0.08 * breath);

      // AD8232 front end: gain then offset -> volts at the OUT pin.
      let volts = AD8232_BASELINE_V + mv * gainMvToV;

      // Baseline wander from chest movement, also breathing-locked.
      volts += 0.045 * breath;

      if (this.noise > 0.0) {
        volts += this._gauss() * 0.055 * this.noise;
        // Mains hum: the single most characteristic ECG artifact, and exactly
        // what the notch filter downstream exists to remove.
        volts += 0.03 * this.noise * Math.sin(2 * Math.PI * MAINS_HZ * t + 0.7);
      }

      if (artifact) volts += artifact[i];

      // Arduino ADC: clip to the rail, then quantise to 10 bits.
      let c = Math.round(volts * countsPerVolt);
      if (c < 0) c = 0;
      else if (c > ADC_MAX) c = ADC_MAX;
      out[i] = c;
    }

    return out;
  }

  /**
   * Occasional motion artifact: a sharp electrode-tug transient decaying over
   * 150-400 ms, roughly one every ~12 seconds.
   */
  _artifactChunk(count) {
    const out = new Float64Array(count);
    let pos = 0;

    while (pos < count) {
      if (this._artifact === null) {
        const pPerSample = 1.0 / (12.0 * this.sampleRate);
        if (this._rand() > pPerSample * (count - pos)) break;
        const dur = Math.floor((0.15 + this._rand() * 0.25) * this.sampleRate);
        const amp = (0.15 + this._rand() * 0.35) * (this._rand() < 0.5 ? -1 : 1);
        const wobbleEnd = 3.0 + this._rand() * 6.0;
        const a = new Float64Array(dur);
        for (let i = 0; i < dur; i++) {
          const decay = Math.exp(-(5.0 * i) / Math.max(dur - 1, 1));
          const wobble = Math.sin((wobbleEnd * i) / Math.max(dur - 1, 1));
          a[i] = amp * decay * (0.7 + 0.3 * wobble);
        }
        this._artifact = a;
        this._artifactPos = 0;
      }

      const remaining = this._artifact.length - this._artifactPos;
      const take = Math.min(count - pos, remaining);
      for (let i = 0; i < take; i++) out[pos + i] += this._artifact[this._artifactPos + i];
      pos += take;
      this._artifactPos += take;
      if (this._artifactPos >= this._artifact.length) this._artifact = null;
    }

    return out;
  }
}
