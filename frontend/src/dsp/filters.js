/**
 * Streaming IIR filtering in the browser -- the JS twin of backend/ecg/filters.py.
 *
 * Only the *application* of the filter lives here. The coefficients come from
 * scipy via the generated coeffs.js, so there is no chance of the two chains
 * drifting apart (see backend/export_dsp.py for why).
 *
 * The one property that matters is statefulness. Samples arrive in chunks, and
 * a filter that restarts its delay line each chunk produces a step at every
 * boundary -- which the R-peak detector downstream reports as a heartbeat. So
 * `zi` persists across calls, exactly as scipy's sosfilt(zi=...) does.
 */

import { ECG_SOS, ECG_ZI, QRS_SOS, QRS_ZI } from './coeffs.js';

/**
 * Cascaded second-order sections, direct form II transposed.
 *
 * This is scipy's sosfilt, transcribed. For each section:
 *     y[n] = b0*x[n] + z0
 *     z0   = b1*x[n] - a1*y[n] + z1
 *     z1   = b2*x[n] - a2*y[n]
 * The output of one section is the input to the next.
 */
class SOSFilter {
  /**
   * @param {number[][]} sos  n_sections x 6, each row [b0,b1,b2,a0,a1,a2]
   * @param {number[][]} zi   n_sections x 2, unit-step steady state
   */
  constructor(sos, zi) {
    this.sos = sos;
    this.ziTemplate = zi;
    this.n = sos.length;
    // Flat state array: [s0_z0, s0_z1, s1_z0, s1_z1, ...]. Flat rather than
    // nested because this runs over a 1 kHz stream and the inner loop is hot.
    this.z = new Float64Array(this.n * 2);
    this.reset();
  }

  reset() {
    this.z.fill(0);
    this.primed = false;
  }

  /**
   * Prime the delay line to the steady state for a constant input `value`.
   * Mirrors `sosfilt_zi(sos) * x[0]` in the Python.
   */
  prime(value) {
    for (let s = 0; s < this.n; s++) {
      this.z[s * 2] = this.ziTemplate[s][0] * value;
      this.z[s * 2 + 1] = this.ziTemplate[s][1] * value;
    }
    this.primed = true;
  }

  /**
   * Filter a chunk, carrying state across calls.
   * @param {Float64Array|number[]} x
   * @returns {Float64Array}
   */
  process(x) {
    const len = x.length;
    if (len === 0) return new Float64Array(0);

    const out = new Float64Array(len);
    const sos = this.sos;
    const z = this.z;
    const nSec = this.n;

    for (let i = 0; i < len; i++) {
      let v = x[i];
      for (let s = 0; s < nSec; s++) {
        const c = sos[s];
        // c = [b0, b1, b2, a0, a1, a2]; scipy normalises a0 to 1.
        const j = s * 2;
        const y = c[0] * v + z[j];
        z[j] = c[1] * v - c[4] * y + z[j + 1];
        z[j + 1] = c[2] * v - c[5] * y;
        v = y;
      }
      out[i] = v;
    }
    return out;
  }
}

/**
 * Display chain: high-pass -> mains notch -> harmonic notch -> low-pass.
 * Input: volts at the AD8232 OUT pin. Output: volts, baseline removed.
 */
export class ECGFilter {
  constructor() {
    this.f = new SOSFilter(ECG_SOS, ECG_ZI);
  }

  reset() {
    this.f.reset();
  }

  process(x) {
    if (x.length === 0) return new Float64Array(0);
    if (!this.f.primed) {
      // Seed from the first sample, or the high-pass rings for several
      // seconds and the trace appears to fall off a cliff at startup.
      this.f.prime(x[0]);
    }
    return this.f.process(x);
  }
}

/** The QRS detector's 5-15 Hz front end. */
export class BandpassFilter {
  constructor() {
    this.f = new SOSFilter(QRS_SOS, QRS_ZI);
    this.f.primed = true; // starts from zero, matching the Python
  }

  reset() {
    this.f.reset();
    this.f.primed = true;
  }

  process(x) {
    return x.length === 0 ? new Float64Array(0) : this.f.process(x);
  }
}
