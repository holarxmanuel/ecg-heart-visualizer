/**
 * Streaming Pan-Tompkins R-peak detector -- the JS twin of ecg/detector.py.
 *
 * Ported line-for-line, deliberately. Every constant, every ordering decision
 * and every state variable mirrors the Python, because the Python is the
 * verified reference: backend/selftest.py proves it to +/-0.5 BPM across
 * 45-180 BPM and 0-100% noise, and verify_dsp.py asserts this port produces
 * the same beats on the same input. Divergence here would mean the offline
 * heart rate quietly disagrees with the online one -- the kind of bug that is
 * invisible until someone compares two screens.
 *
 * Pipeline, per sample:
 *   band-pass 5-15 Hz -> 5-point derivative -> square -> 150 ms integrate
 *   -> adaptive SPKI/NPKI threshold -> 200 ms refractory -> snap to true peak
 */

import { BandpassFilter } from './filters.js';
import {
  SAMPLE_RATE,
  QRS_INTEGRATION_MS,
  QRS_REFRACTORY_MS,
  BPM_MIN,
  BPM_MAX,
} from './coeffs.js';

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated percentile, matching numpy.percentile's default. */
function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export class RPeakDetector {
  constructor(sampleRate = SAMPLE_RATE) {
    this.fs = sampleRate | 0;
    this._bandpass = new BandpassFilter();
    this._win = Math.max(Math.floor((QRS_INTEGRATION_MS * this.fs) / 1000), 1);
    this._refractory = Math.floor((QRS_REFRACTORY_MS * this.fs) / 1000);
    this._minRR = Math.floor((60.0 / BPM_MAX) * this.fs);
    this._maxRR = Math.floor((60.0 / BPM_MIN) * this.fs);
    this.reset();
  }

  reset() {
    this._bandpass.reset();

    this._n = 0;
    this._derivTail = new Float64Array(4);
    this._sqTail = new Float64Array(Math.max(this._win - 1, 0));

    // Peak-tracking state machine, carried across chunk boundaries.
    this._prevY = 0.0;
    this._rising = false;

    // Adaptive thresholds.
    this._spki = 0.0;
    this._npki = 0.0;
    this._learning = true;
    this._learnBuf = [];
    this._learnSamples = Math.floor(1.5 * this.fs);

    this._lastR = null;
    this._beatCount = 0;
    this._rrHistory = [];

    this._suppressUntil = 0;
    this.suppressedBeats = 0;

    // Rolling filtered-signal window, for snapping onto the true R-peak.
    this._lookback = Math.floor(0.35 * this.fs);
    this._filtBuf = new Float64Array(this._lookback);
    this._filtBase = 0;
  }

  get threshold() {
    return this._npki + 0.25 * (this._spki - this._npki);
  }

  get beatCount() {
    return this._beatCount;
  }

  /** Smoothed BPM, or 0 before two beats have been seen. */
  get bpm() {
    if (this._rrHistory.length === 0) return 0.0;
    const rr = median(this._rrHistory);
    return rr > 0 ? 60000.0 / rr : 0.0;
  }

  /**
   * Tell the detector the waveform was just spliced (samples were lost).
   *
   * The real damage from a splice is to *timing*, not to false beats: the
   * interval spanning the seam is measured in samples, so missing samples make
   * it read short, and a 0.4 s dropout at 120 BPM turns a 500 ms RR into a
   * 100 ms one. Forgetting the last R-peak means the next beat yields no
   * interval rather than a wrong one. Blanking is kept short (120 ms) because
   * measurement showed a long window discards real beats to prevent phantoms
   * that were not actually occurring.
   */
  notifyDiscontinuity(blankMs = 120.0) {
    this._lastR = null;
    this._suppressUntil = this._n + Math.floor((blankMs * this.fs) / 1000);
  }

  /**
   * Feed a chunk of *filtered* ECG in volts. Returns the beats found in it.
   * @param {Float64Array} filtered
   */
  process(filtered) {
    if (filtered.length === 0) return [];
    const n = filtered.length;
    const chunkStart = this._n;

    this._pushFiltered(filtered);
    const integrated = this._integrate(filtered);
    const beats = this._findPeaks(integrated, chunkStart);

    this._n += n;
    return beats;
  }

  _pushFiltered(x) {
    const lb = this._lookback;
    if (x.length >= lb) {
      this._filtBuf = x.slice(x.length - lb);
    } else {
      const next = new Float64Array(lb);
      next.set(this._filtBuf.subarray(x.length));
      next.set(x, lb - x.length);
      this._filtBuf = next;
    }
    this._filtBase = this._n + x.length - lb;
  }

  /** band-pass -> derivative -> square -> moving-window integrate. */
  _integrate(x) {
    const bp = this._bandpass.process(x);

    // Pan-Tompkins 5-point derivative: (2x[n] + x[n-1] - x[n-3] - 2x[n-4]) / 8
    const padded = new Float64Array(4 + bp.length);
    padded.set(this._derivTail, 0);
    padded.set(bp, 4);
    this._derivTail = padded.slice(padded.length - 4);

    const d = new Float64Array(bp.length);
    for (let i = 0; i < bp.length; i++) {
      const j = i + 4;
      d[i] =
        (2.0 * padded[j] + padded[j - 1] - padded[j - 3] - 2.0 * padded[j - 4]) / 8.0;
    }

    // Square, then moving-window integrate with the previous chunk's tail
    // prepended so windows span chunk boundaries.
    const tailLen = this._sqTail.length;
    const buf = new Float64Array(tailLen + d.length);
    buf.set(this._sqTail, 0);
    for (let i = 0; i < d.length; i++) buf[tailLen + i] = d[i] * d[i];

    this._sqTail =
      this._win > 1 ? buf.slice(Math.max(buf.length - (this._win - 1), 0)) : new Float64Array(0);

    // Cumulative sum, then difference over the window.
    const c = new Float64Array(buf.length);
    let run = 0;
    for (let i = 0; i < buf.length; i++) {
      run += buf[i];
      c[i] = run;
    }

    const w = this._win;
    if (w > c.length) {
      // Chunk shorter than the window on a cold start: the Python fills with
      // the running mean rather than emitting nothing.
      return new Float64Array(d.length).fill(c[c.length - 1] / w);
    }

    const outLen = c.length - w + 1;
    const out = new Float64Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const head = i === 0 ? 0.0 : c[i - 1];
      out[i] = (c[i + w - 1] - head) / w;
    }
    return out;
  }

  _findPeaks(integrated, chunkStart) {
    const beats = [];

    // Warm-up: gather statistics before trusting any threshold, so a loud
    // startup transient is not logged as a run of tachycardia.
    if (this._learning) {
      for (let i = 0; i < integrated.length; i++) this._learnBuf.push(integrated[i]);
      if (this._learnBuf.length >= this._learnSamples) {
        const sorted = [...this._learnBuf].sort((a, b) => a - b);
        this._spki = percentile(sorted, 99.5);
        this._npki = percentile(sorted, 60.0);
        this._learning = false;
        this._learnBuf.length = 0;
      }
      this._prevY = integrated[integrated.length - 1];
      return beats;
    }

    for (let i = 0; i < integrated.length; i++) {
      const y = integrated[i];
      const gi = chunkStart + i;

      if (y > this._prevY) {
        this._rising = true;
        this._prevY = y;
        continue;
      }
      if (!this._rising) {
        this._prevY = y;
        continue;
      }

      // Just crested: _prevY is a local maximum at global index gi-1.
      this._rising = false;
      const peakVal = this._prevY;
      const peakGi = gi - 1;
      this._prevY = y;

      if (peakVal < this.threshold) {
        // Below threshold -> noise; let NPKI drift up towards it.
        this._npki = 0.125 * peakVal + 0.875 * this._npki;
        continue;
      }

      if (this._lastR !== null) {
        const gap = peakGi - this._lastR;
        if (gap < Math.max(this._refractory, this._minRR)) {
          // Physiologically impossible -- a T wave or motion spike. Ignore it
          // without letting it pollute either running estimate.
          continue;
        }
      }

      if (peakGi < this._suppressUntil) {
        // Inside the post-splice blanking window. A phantom that poisons the
        // adaptive state costs more than the single beat discarded here.
        this.suppressedBeats += 1;
        continue;
      }

      // Accepted as a QRS complex.
      this._spki = 0.125 * peakVal + 0.875 * this._spki;
      const [rGi, amp] = this._refinePeak(peakGi);

      let rrMs = 0.0;
      let bpm = 0.0;
      if (this._lastR !== null) {
        const rrSamples = rGi - this._lastR;
        if (rrSamples > 0) {
          rrMs = (rrSamples * 1000.0) / this.fs;
          bpm = 60000.0 / rrMs;
          if (bpm >= BPM_MIN && bpm <= BPM_MAX) {
            this._rrHistory.push(rrMs);
            if (this._rrHistory.length > 8) this._rrHistory.shift();
          } else {
            bpm = 0.0;
          }
        }
      }

      this._lastR = rGi;
      this._beatCount += 1;

      beats.push({
        globalIndex: rGi,
        chunkIndex: Math.min(Math.max(rGi - chunkStart, 0), integrated.length - 1),
        number: this._beatCount,
        bpm: Math.round(bpm * 10) / 10,
        bpmAvg: Math.round(this.bpm * 10) / 10,
        rrMs: Math.round(rrMs * 10) / 10,
        amplitude: Math.round(amp * 10000) / 10000,
      });
    }

    return beats;
  }

  /**
   * Snap the detection back onto the true R-peak.
   *
   * The integrator's bump is centred ~half a window after the QRS, so search
   * the filtered signal backwards over the preceding 200 ms for the largest
   * absolute deflection. That is the sample the animation and the click should
   * fire on -- without this they land ~100 ms late.
   */
  _refinePeak(integratedPeakGi) {
    const search = Math.floor(0.2 * this.fs);
    let loI = integratedPeakGi - search - this._filtBase;
    let hiI = integratedPeakGi + 1 - this._filtBase;
    loI = Math.max(loI, 0);
    hiI = Math.min(hiI, this._filtBuf.length);
    if (hiI - loI < 2) return [integratedPeakGi, 0.0];

    let k = 0;
    let best = -Infinity;
    for (let i = loI; i < hiI; i++) {
      const a = Math.abs(this._filtBuf[i]);
      if (a > best) {
        best = a;
        k = i;
      }
    }
    return [this._filtBase + k, this._filtBuf[k]];
  }
}
