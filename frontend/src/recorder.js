/**
 * ECG session recorder and CSV export.
 *
 * Memory discipline is the whole design here. Recording is opt-in and the
 * buffers are allocated only when the user presses Record, so an app that is
 * merely monitoring holds nothing. When recording, storage is a fixed-size
 * ring of typed arrays -- an hour-long session costs exactly as much as a
 * one-minute one.
 *
 * Budget at the default 5-minute capacity, 1000 Hz:
 *     raw   Int16Array   300 000 x 2 B  = 586 KB
 *     filt  Float32Array 300 000 x 4 B  = 1.14 MB
 *     beat  Uint8Array   300 000 x 1 B  = 293 KB
 *                                        ~2.0 MB total
 */

const DEFAULT_CAPACITY_SECONDS = 300; // 5 minutes

export class Recorder {
  constructor(sampleRate = 1000, capacitySeconds = DEFAULT_CAPACITY_SECONDS) {
    this.sampleRate = sampleRate;
    this.capacitySeconds = capacitySeconds;
    this.recording = false;
    this._reset();
  }

  _reset() {
    this.raw = null;
    this.filt = null;
    this.beat = null;
    this.head = 0;
    this.count = 0;
    this.startedAt = null;
    this.firstSampleIndex = 0;
    this.beatsRecorded = 0;
  }

  get capacity() {
    return this.capacitySeconds * this.sampleRate;
  }

  get seconds() {
    return this.count / this.sampleRate;
  }

  get bytes() {
    return this.raw ? this.raw.byteLength + this.filt.byteLength + this.beat.byteLength : 0;
  }

  /** Allocate and begin. Returns false if allocation fails on a tight device. */
  start() {
    if (this.recording) return true;
    try {
      const cap = this.capacity;
      this.raw = new Int16Array(cap);
      this.filt = new Float32Array(cap);
      this.beat = new Uint8Array(cap);
    } catch (err) {
      console.error('[recorder] allocation failed', err);
      this._reset();
      return false;
    }
    this.head = 0;
    this.count = 0;
    this.beatsRecorded = 0;
    this.startedAt = new Date();
    this.recording = true;
    return true;
  }

  stop() {
    this.recording = false;
  }

  /** Free the buffers. Call after export, or when the user discards. */
  discard() {
    this.recording = false;
    this._reset();
  }

  /**
   * @param {number} i0            global sample index of the first sample
   * @param {number[]} rawCounts   ADC counts
   * @param {number[]} filtMv      filtered mV
   * @param {number[]} beatIndices R-peak offsets within this batch
   */
  push(i0, rawCounts, filtMv, beatIndices) {
    if (!this.recording || !this.raw) return;
    const cap = this.capacity;
    const n = rawCounts.length;

    if (this.count === 0) this.firstSampleIndex = i0;

    let h = this.head;
    for (let i = 0; i < n; i++) {
      this.raw[h] = rawCounts[i];
      this.filt[h] = filtMv[i];
      this.beat[h] = 0;
      h = h + 1 === cap ? 0 : h + 1;
    }
    if (beatIndices) {
      for (const bi of beatIndices) {
        if (bi >= 0 && bi < n) {
          this.beat[(this.head + bi) % cap] = 1;
          this.beatsRecorded++;
        }
      }
    }
    this.head = h;

    if (this.count + n > cap) {
      // Ring wrapped: the oldest samples are gone, so the timestamp origin
      // moves forward with them.
      this.firstSampleIndex += this.count + n - cap;
    }
    this.count = Math.min(this.count + n, cap);
  }

  /**
   * Build the CSV.
   *
   * Assembled in chunks rather than one giant concatenation -- a 5-minute
   * recording is 300 000 rows, and naive string building on that peaks at
   * several hundred megabytes.
   *
   * @param {object} meta contextual info for the header comments
   */
  toCSV(meta = {}) {
    if (!this.raw || this.count === 0) return '';

    const cap = this.capacity;
    const n = this.count;
    const start = (this.head - n + cap) % cap;
    const dt = 1 / this.sampleRate;
    const vPerCount = (meta.adcVref ?? 5.0) / (meta.adcMax ?? 1023);

    const chunks = [];
    chunks.push(
      [
        '# Real-Time ECG Heart Visualizer -- session export',
        `# recorded_at,${(this.startedAt || new Date()).toISOString()}`,
        `# source,${meta.source || 'unknown'}`,
        `# port,${meta.port || 'n/a'}`,
        `# sample_rate_hz,${this.sampleRate}`,
        `# adc_bits,${Math.round(Math.log2((meta.adcMax ?? 1023) + 1))}`,
        `# adc_vref_v,${meta.adcVref ?? 5.0}`,
        `# ad8232_gain,${meta.gain ?? 1100}`,
        `# samples,${n}`,
        `# beats,${this.beatsRecorded}`,
        `# mean_bpm,${meta.bpm ?? ''}`,
        '#',
        '# raw_adc     : exactly what analogRead(A0) returned (0-1023)',
        '# raw_volts   : raw_adc scaled to volts at the AD8232 OUTPUT pin',
        '# filtered_mv : 0.5-40 Hz band, mains-notched, referred to the electrodes',
        '# r_peak      : 1 on the sample the detector called an R-peak',
        '',
        'time_s,raw_adc,raw_volts,filtered_mv,r_peak',
      ].join('\n') + '\n',
    );

    const ROWS_PER_CHUNK = 8192;
    let buf = [];
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % cap;
      const adc = this.raw[idx];
      buf.push(
        `${(i * dt).toFixed(4)},${adc},${(adc * vPerCount).toFixed(4)},` +
          `${this.filt[idx].toFixed(4)},${this.beat[idx]}`,
      );
      if (buf.length >= ROWS_PER_CHUNK) {
        chunks.push(buf.join('\n') + '\n');
        buf = [];
      }
    }
    if (buf.length) chunks.push(buf.join('\n') + '\n');

    return chunks.join('');
  }

  /** Trigger a browser download of the current recording. */
  download(meta = {}) {
    const csv = this.toCSV(meta);
    if (!csv) return false;

    const stamp = (this.startedAt || new Date())
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `ecg-${meta.source || 'session'}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick; revoking synchronously can cancel the download
    // in some Chromium builds.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  }
}
