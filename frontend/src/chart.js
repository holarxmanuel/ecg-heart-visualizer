/**
 * Scrolling ECG waveform, Canvas2D.
 *
 * Memory is fixed at construction: two Float32Array ring buffers sized to the
 * visible window and nothing else. Nothing is allocated per frame or per
 * sample, so the chart's footprint is a few hundred kilobytes forever,
 * regardless of how long the session runs.
 *
 * Drawing cost is bounded the same way. However many samples the window holds,
 * we always emit exactly `COLUMNS` screen columns, reducing each column with a
 * min/max pair so a 2 ms R-peak spike can never be skipped by decimation --
 * the classic bug that makes downsampled ECG look flat and wrong.
 *
 * The graticule is rendered once into an offscreen canvas and blitted, so per
 * frame we do one drawImage plus two polylines.
 */

const COLUMNS = 1000; // "1000 points visible", per the spec

export class ECGChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{windowSeconds?: number, sampleRate?: number}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    this.sampleRate = opts.sampleRate || 1000;
    this.windowSeconds = opts.windowSeconds || 4;
    this.showRaw = true;
    this.showFiltered = true;
    this.autoScale = true;
    this.gain = 1.0; // mm/mV equivalent, user adjustable

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = 0;
    this.height = 0;

    this._grid = document.createElement('canvas');
    this._gridCtx = this._grid.getContext('2d');

    this._allocate();
    this.resize();
  }

  // -- buffers ------------------------------------------------------------

  _allocate() {
    const capacity = Math.ceil(this.windowSeconds * this.sampleRate);
    this.capacity = capacity;
    this.filt = new Float32Array(capacity);
    this.raw = new Float32Array(capacity);
    // Beat markers: sample index (mod capacity) where an R-peak landed.
    this.beatMark = new Uint8Array(capacity);
    this.head = 0;
    this.filled = 0;
    this._scaleMv = 1.2; // running full-scale estimate, in mV
  }

  setWindowSeconds(seconds) {
    if (seconds === this.windowSeconds) return;
    this.windowSeconds = seconds;
    this._allocate();
    this._drawGrid();
  }

  clear() {
    this.filt.fill(0);
    this.raw.fill(0);
    this.beatMark.fill(0);
    this.head = 0;
    this.filled = 0;
  }

  /**
   * Append one batch.
   * @param {Int16Array|number[]} rawCounts raw ADC counts, 0..1023
   * @param {Float32Array|number[]} filtMv  filtered signal in mV
   * @param {number[]} beatIndices          indices within this batch
   */
  push(rawCounts, filtMv, beatIndices) {
    const n = filtMv.length;
    const cap = this.capacity;
    let h = this.head;

    for (let i = 0; i < n; i++) {
      this.filt[h] = filtMv[i];
      this.raw[h] = rawCounts[i];
      this.beatMark[h] = 0;
      h = h + 1 === cap ? 0 : h + 1;
    }

    if (beatIndices) {
      for (const bi of beatIndices) {
        if (bi >= 0 && bi < n) {
          const idx = (this.head + bi) % cap;
          this.beatMark[idx] = 1;
        }
      }
    }

    this.head = h;
    this.filled = Math.min(this.filled + n, cap);
  }

  // -- layout -------------------------------------------------------------

  resize() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 220;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawGrid();
  }

  /**
   * Standard ECG graticule: 5 mm major squares, 1 mm minor. At the default
   * 25 mm/s paper speed one major square is 0.2 s, which is why clinicians can
   * read a rate straight off the paper -- worth preserving even on a screen.
   */
  _drawGrid() {
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;

    this._grid.width = Math.round(w * this.dpr);
    this._grid.height = Math.round(h * this.dpr);
    const g = this._gridCtx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    g.fillStyle = '#070a10';
    g.fillRect(0, 0, w, h);

    const majorX = w / (this.windowSeconds / 0.2); // 0.2 s per major square
    const minorX = majorX / 5;
    const majorY = h / 8; // 8 major divisions vertically
    const minorY = majorY / 5;

    g.lineWidth = 1;
    g.strokeStyle = 'rgba(228, 62, 84, 0.09)';
    g.beginPath();
    for (let x = 0; x <= w + 0.5; x += minorX) {
      g.moveTo(Math.round(x) + 0.5, 0);
      g.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = 0; y <= h + 0.5; y += minorY) {
      g.moveTo(0, Math.round(y) + 0.5);
      g.lineTo(w, Math.round(y) + 0.5);
    }
    g.stroke();

    g.strokeStyle = 'rgba(228, 62, 84, 0.22)';
    g.beginPath();
    for (let x = 0; x <= w + 0.5; x += majorX) {
      g.moveTo(Math.round(x) + 0.5, 0);
      g.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = 0; y <= h + 0.5; y += majorY) {
      g.moveTo(0, Math.round(y) + 0.5);
      g.lineTo(w, Math.round(y) + 0.5);
    }
    g.stroke();

    // Isoelectric baseline.
    g.strokeStyle = 'rgba(160, 200, 255, 0.16)';
    g.beginPath();
    g.moveTo(0, Math.round(h / 2) + 0.5);
    g.lineTo(w, Math.round(h / 2) + 0.5);
    g.stroke();
  }

  // -- drawing ------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;

    ctx.drawImage(this._grid, 0, 0, w, h);

    if (this.filled < 8) {
      this._drawIdleMessage();
      return;
    }

    const cap = this.capacity;
    const n = this.filled;
    // Oldest visible sample. When the buffer is not yet full we still anchor
    // to the right edge, so the trace grows in from the left like real paper.
    const start = (this.head - n + cap) % cap;

    // --- auto-scale -------------------------------------------------------
    if (this.autoScale) {
      let peak = 0;
      // Sampling every 4th value is plenty to track the envelope and keeps
      // this loop off the profiler even at a 6 s window.
      for (let i = 0; i < n; i += 4) {
        const v = Math.abs(this.filt[(start + i) % cap]);
        if (v > peak) peak = v;
      }
      const target = Math.max(peak * 1.25, 0.35);
      // Slow attack/release so the trace does not visibly breathe.
      this._scaleMv += (target - this._scaleMv) * 0.04;
    }
    const scale = (h / 2) / (this._scaleMv / this.gain);
    const mid = h / 2;

    // --- filtered trace ---------------------------------------------------
    if (this.showFiltered) {
      this._strokeTrace(ctx, this.filt, start, n, cap, mid, scale, {
        color: '#31e07a',
        width: 1.7,
        glow: 'rgba(49, 224, 122, 0.35)',
      });
    }

    // --- raw trace (baseline-removed for display only) --------------------
    if (this.showRaw) {
      // Raw arrives as ADC counts sitting near 307. Centre it and squash it so
      // it sits behind the filtered trace as context, not competition.
      let mean = 0;
      const step = Math.max(1, Math.floor(n / 512));
      let cnt = 0;
      for (let i = 0; i < n; i += step) {
        mean += this.raw[(start + i) % cap];
        cnt++;
      }
      mean /= cnt || 1;

      this._strokeTrace(
        ctx, this.raw, start, n, cap, mid, scale * 0.0042, // counts -> screen
        { color: 'rgba(96, 150, 200, 0.5)', width: 1.0, glow: null, offset: -mean },
      );
    }

    // --- R-peak markers ---------------------------------------------------
    ctx.fillStyle = 'rgba(255, 210, 80, 0.9)';
    const colStep = n / COLUMNS;
    for (let c = 0; c < COLUMNS; c++) {
      const i0 = Math.floor(c * colStep);
      const i1 = Math.min(Math.floor((c + 1) * colStep), n);
      for (let i = i0; i < i1; i++) {
        if (this.beatMark[(start + i) % cap]) {
          const x = (c / COLUMNS) * w;
          ctx.fillRect(x - 1, 2, 2, 7);
          break;
        }
      }
    }

    this._drawLabels(ctx, w, h);
  }

  /**
   * Draw one trace as min/max columns.
   *
   * Reducing each screen column to its extremes (rather than picking one
   * sample) is what guarantees the QRS spike survives decimation. It costs the
   * same number of path operations as naive downsampling.
   */
  _strokeTrace(ctx, buf, start, n, cap, mid, scale, style) {
    const w = this.width;
    const offset = style.offset || 0;
    const colStep = n / COLUMNS;

    ctx.beginPath();
    for (let c = 0; c < COLUMNS; c++) {
      const i0 = Math.floor(c * colStep);
      const i1 = Math.max(Math.floor((c + 1) * colStep), i0 + 1);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i < i1 && i < n; i++) {
        const v = buf[(start + i) % cap] + offset;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo === Infinity) continue;
      const x = (c / COLUMNS) * w;
      const yHi = mid - hi * scale;
      const yLo = mid - lo * scale;
      if (c === 0) ctx.moveTo(x, yHi);
      else ctx.lineTo(x, yHi);
      if (yLo !== yHi) ctx.lineTo(x, yLo);
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (style.glow) {
      // A single shadowed pass gives the phosphor bloom of a real monitor.
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = 6;
    }
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawLabels(ctx, w, h) {
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(150, 175, 205, 0.75)';
    ctx.textAlign = 'left';
    ctx.fillText(`${this.windowSeconds.toFixed(0)} s window`, 8, h - 8);
    ctx.fillText(`${this.sampleRate} Hz`, 8, 16);

    ctx.textAlign = 'right';
    ctx.fillText(`±${(this._scaleMv / this.gain).toFixed(2)} mV`, w - 8, 16);
    ctx.fillText('25 mm/s', w - 8, h - 8);
  }

  _drawIdleMessage() {
    const ctx = this.ctx;
    ctx.font = '13px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(140, 165, 195, 0.55)';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Awaiting signal — choose a source and press Start Monitoring',
      this.width / 2,
      this.height / 2,
    );
    ctx.textAlign = 'left';
  }
}
