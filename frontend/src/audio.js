/**
 * Synchronised heartbeat audio.
 *
 * The two sounds are the real ones: S1 ("lub") is the mitral and tricuspid
 * valves slamming shut as the ventricles start to squeeze -- it lands on the
 * R-peak. S2 ("dub") is the aortic and pulmonic valves closing at the end of
 * ejection, so it must trail S1 by the systolic interval, not by a fixed gap.
 * Get that spacing wrong and the rhythm sounds like a metronome instead of a
 * heart, which is the usual tell in apps like this.
 *
 * Both sounds are rendered ONCE into AudioBuffers at startup via an
 * OfflineAudioContext. Playing a beat then costs two BufferSourceNodes and
 * nothing else -- no filter graph is built per beat, so audio stays flat at
 * effectively zero CPU even at 200 BPM. Pitch is handled with playbackRate,
 * which is free, rather than by re-synthesising.
 */

const S1_SECONDS = 0.32;
const S2_SECONDS = 0.26;

export class HeartAudio {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.buffers = { s1: null, s2: null };

    this.enabled = true;
    this.volume = 0.7;
    this.pitch = 1.0; // playbackRate multiplier
    this.ready = false;
    this._pending = false;
  }

  /**
   * Create the context and pre-render the sounds.
   * Must be called from a user gesture -- browsers refuse to start audio
   * otherwise, and a silent app with no explanation is a support nightmare.
   */
  async init() {
    if (this.ready || this._pending) return this.ready;
    this._pending = true;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;

      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);

      const [s1, s2] = await Promise.all([
        this._renderSound('s1'),
        this._renderSound('s2'),
      ]);
      this.buffers.s1 = s1;
      this.buffers.s2 = s2;
      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[audio] init failed:', err);
      return false;
    } finally {
      this._pending = false;
    }
  }

  async resume() {
    if (!this.ctx || this.ctx.state !== 'suspended') return;
    try {
      // resume() can hang forever rather than reject when the audio device is
      // unavailable (a machine with no sound card, a VM, a device unplugged
      // mid-session). Nothing critical awaits this today, but an un-settleable
      // promise is a trap for whoever adds the next `await`.
      await Promise.race([
        this.ctx.resume(),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      /* ignore -- the UI already offers an explicit "enable sound" control */
    }
  }

  /**
   * Render one heart sound offline.
   *
   * A heart sound is not a tone. It is a short, heavily damped thump: a
   * low-frequency body (the valve leaflets and blood column) plus a broadband
   * transient (the snap itself), both decaying in ~100 ms. We build exactly
   * that -- a swept low sine plus band-passed noise -- and let the envelope do
   * the work.
   */
  async _renderSound(which) {
    const sr = 44100;
    const seconds = which === 's1' ? S1_SECONDS : S2_SECONDS;
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new Offline(1, Math.ceil(sr * seconds), sr);

    // S1 is lower, longer and duller; S2 is higher, shorter and sharper --
    // that contrast is what makes "lub-DUB" legible as two distinct sounds.
    const cfg =
      which === 's1'
        ? { f0: 62, f1: 34, decay: 0.055, noiseHz: 110, q: 1.4, noiseMix: 0.45, dur: 0.20 }
        : { f0: 92, f1: 52, decay: 0.038, noiseHz: 175, q: 1.8, noiseMix: 0.55, dur: 0.14 };

    // --- low-frequency body ---------------------------------------------
    const osc = off.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(cfg.f0, 0);
    osc.frequency.exponentialRampToValueAtTime(cfg.f1, cfg.dur);

    const oscGain = off.createGain();
    oscGain.gain.setValueAtTime(0.0001, 0);
    oscGain.gain.exponentialRampToValueAtTime(1.0, 0.006); // fast attack
    oscGain.gain.exponentialRampToValueAtTime(0.0001, cfg.dur);
    osc.connect(oscGain).connect(off.destination);

    // --- broadband transient ---------------------------------------------
    const noiseLen = Math.ceil(sr * cfg.dur);
    const noiseBuf = off.createBuffer(1, noiseLen, sr);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      const env = Math.exp(-i / (sr * cfg.decay));
      nd[i] = (Math.random() * 2 - 1) * env;
    }

    const noise = off.createBufferSource();
    noise.buffer = noiseBuf;

    const bp = off.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = cfg.noiseHz;
    bp.Q.value = cfg.q;

    // Second-order roll-off above the band keeps it from sounding like hiss.
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cfg.noiseHz * 3.2;

    const noiseGain = off.createGain();
    noiseGain.gain.value = cfg.noiseMix;

    noise.connect(bp).connect(lp).connect(noiseGain).connect(off.destination);

    osc.start(0);
    osc.stop(cfg.dur);
    noise.start(0);

    const rendered = await off.startRendering();

    // Normalise so the two sounds sit at a predictable level relative to the
    // master gain, and so the volume slider means the same thing for both.
    const data = rendered.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak > 0) {
      const g = (which === 's1' ? 0.95 : 0.72) / peak;
      for (let i = 0; i < data.length; i++) data[i] *= g;
    }
    return rendered;
  }

  _play(buffer, when, gain = 1) {
    if (!buffer || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.pitch;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start(when);
    // Nodes are single-use; letting them fall out of scope is enough, but
    // clearing onended explicitly avoids retaining the closure.
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  /**
   * Play one full lub-dub for a detected beat.
   *
   * @param {number} rrSeconds current RR interval, for S1->S2 spacing
   * @param {number} ageMs     how long ago the R-peak actually occurred
   */
  beat(rrSeconds = 1.0, ageMs = 0) {
    if (!this.enabled || !this.ready || !this.ctx) return;

    if (this.ctx.state !== 'running') {
      // The context can be suspended by autoplay policy, by the OS switching
      // audio devices, or by the tab being backgrounded. Retry quietly rather
      // than going permanently silent -- at most once a second, so a genuinely
      // blocked context does not spam resume() on every beat.
      const now = performance.now();
      if (now - (this._lastResumeTry || 0) > 1000) {
        this._lastResumeTry = now;
        this.resume();
      }
      return;
    }

    const now = this.ctx.currentTime;

    // The R-peak is already `ageMs` in the past by the time the batch reaches
    // us. We cannot play in the past, so S1 goes out immediately -- but we DO
    // subtract the age from the S2 delay, so the lub-dub interval stays
    // correct even when a batch arrives late.
    const t1 = now + 0.002;

    // Systolic interval: S2 closes the ejection phase. Scales with sqrt(RR),
    // matching the same model the animation uses, so sound and motion agree.
    const systolic = Math.min(Math.max(0.30 * Math.sqrt(rrSeconds), 0.17), 0.34);
    const t2 = t1 + Math.max(systolic - ageMs / 1000, 0.09);

    this._play(this.buffers.s1, t1, 1.0);
    this._play(this.buffers.s2, t2, 0.78);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) {
      // Ramp rather than jump, to avoid a click on every slider tick.
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
    }
  }

  setPitch(p) {
    this.pitch = Math.max(0.5, Math.min(2.0, p));
  }

  setEnabled(on) {
    this.enabled = !!on;
  }

  dispose() {
    try {
      this.ctx?.close();
    } catch {
      /* nothing to do */
    }
    this.ctx = null;
    this.ready = false;
  }
}
