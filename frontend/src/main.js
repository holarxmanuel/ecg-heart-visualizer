/**
 * Application controller.
 *
 * Owns the render loop, the DOM bindings, and the routing of each incoming
 * batch to the four consumers: the waveform, the 3D heart, the audio engine
 * and the recorder.
 *
 * One rule shapes the whole file: a beat event goes to the heart and the sound
 * on the *same* tick it arrives, before anything else is updated. That is what
 * keeps animation and audio locked to each other and inside the 150 ms budget.
 */

import './style.css';

import { ECGChart } from './chart.js';
import { HeartAudio } from './audio.js';
import { HeartView, autoQuality } from './heart.js';
import { Recorder } from './recorder.js';
import { api } from './net.js';
import { Link, LinkMode } from './link.js';
import { UpdateManager, UpdateKind } from './updates.js';
import { WebSerialSensor, webSerialUnavailableReason } from './webserial.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const dom = {
  boot: $('boot'),
  bootStatus: $('boot-status'),

  statusDot: $('status-dot'),
  statusLabel: $('status-label'),
  statusDetail: $('status-detail'),
  leadsOff: $('leads-off'),
  livePing: $('live-ping'),

  btnStart: $('btn-start'),
  btnStartLabel: $('btn-start-label'),
  btnAudio: $('btn-audio'),
  audioIcon: $('audio-icon'),
  btnUsb: $('btn-usb'),
  btnInstall: $('btn-install'),

  linkPill: $('link-pill'),
  linkIcon: $('link-icon'),
  linkLabel: $('link-label'),
  linkRtt: $('link-rtt'),

  offlineBanner: $('offline-banner'),
  offlineText: $('offline-text'),
  offlineDismiss: $('offline-dismiss'),
  updateBanner: $('update-banner'),
  updateText: $('update-text'),
  updateApply: $('update-apply'),
  updateDismiss: $('update-dismiss'),

  bpmValue: $('bpm-value'),
  bpmInst: $('bpm-inst'),
  bpmBar: $('bpm-bar'),
  heroBpm: $('hero-bpm'),
  phaseLabel: $('phase-label'),

  statBeats: $('stat-beats'),
  statRr: $('stat-rr'),
  statElapsed: $('stat-elapsed'),
  statSamples: $('stat-samples'),

  btnRecord: $('btn-record'),
  btnExport: $('btn-export'),
  recordInfo: $('record-info'),

  btnSim: $('btn-sim'),
  btnSerial: $('btn-serial'),
  serialPanel: $('serial-panel'),
  portSelect: $('port-select'),
  btnRefreshPorts: $('btn-refresh-ports'),
  serialHint: $('serial-hint'),

  simControls: $('sim-controls'),
  simBpm: $('sim-bpm'),
  simBpmVal: $('sim-bpm-val'),
  simNoise: $('sim-noise'),
  simNoiseVal: $('sim-noise-val'),
  simArtifacts: $('sim-artifacts'),

  audioVolume: $('audio-volume'),
  volVal: $('vol-val'),
  audioPitch: $('audio-pitch'),
  pitchVal: $('pitch-val'),

  showRaw: $('show-raw'),
  showFilt: $('show-filt'),
  qualitySelect: $('quality-select'),
  perfInfo: $('perf-info'),
  filterInfo: $('filter-info'),

  heartCanvas: $('heart-canvas'),
  ecgCanvas: $('ecg-canvas'),
  heartStage: $('heart-canvas').parentElement,

  footerSource: $('footer-source'),
  toast: $('toast'),
  toastBody: $('toast-body'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mode: 'off', // 'off' | 'simulate' | 'serial'
  running: false,
  serverConfig: null,
  lastBpm: 0,
  lastRr: 0,
  beats: 0,
  samples: 0,
  sessionStart: null,
  audioArmed: false,
};

let chart;
let heart;
let audio;
let recorder;
/** @type {Link} */
let link;
/** @type {UpdateManager} */
let updates;
/** @type {WebSerialSensor|null} */
let sensor = null;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

let toastTimer;
function toast(message, kind = 'info') {
  dom.toastBody.textContent = message;
  dom.toastBody.className =
    'rounded-lg border px-4 py-2 text-sm shadow-xl ' +
    (kind === 'error'
      ? 'border-trace-alert/40 bg-trace-alert/15 text-red-200'
      : kind === 'success'
        ? 'border-trace-ecg/40 bg-trace-ecg/10 text-emerald-200'
        : 'border-white/10 bg-ink-700 text-slate-200');
  dom.toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (dom.toast.style.opacity = '0'), 3800);
}

const STATUS_COLORS = {
  simulating: ['bg-trace-ecg', 'text-trace-ecg'],
  connected: ['bg-trace-ecg', 'text-trace-ecg'],
  error: ['bg-trace-alert', 'text-trace-alert'],
  idle: ['bg-slate-500', 'text-slate-400'],
};

function renderStatus(s) {
  const [dotColor] = STATUS_COLORS[s.mode] || STATUS_COLORS.idle;
  dom.statusDot.className = `h-2 w-2 rounded-full ${dotColor}`;
  dom.statusLabel.textContent = s.paused && s.mode !== 'idle' ? 'Paused' : s.label;
  dom.statusDetail.textContent = s.detail ? `· ${s.detail}` : '';

  dom.leadsOff.classList.toggle('hidden', !s.leads_off);
  dom.leadsOff.classList.toggle('flex', !!s.leads_off);

  const live = s.running && s.mode !== 'idle';
  dom.livePing.classList.toggle('is-idle', !live);

  state.running = !!s.running;
  dom.btnStartLabel.textContent = s.mode === 'idle'
    ? 'Start Monitoring'
    : s.running
      ? 'Pause'
      : 'Resume';
  dom.btnStart.disabled = false;

  dom.btnSim.classList.toggle('is-active', s.mode === 'simulating');
  dom.btnSerial.classList.toggle('is-active', s.mode === 'connected');

  if (s.mode === 'connected') {
    dom.footerSource.textContent = `AD8232 hardware · ${s.port} @ ${s.baud} baud · ${s.sample_rate} Hz`;
  } else if (s.mode === 'simulating') {
    dom.footerSource.textContent = `Simulated AD8232 · Arduino Uno R3 · ${s.sample_rate} Hz`;
  }

  if (s.extra?.measured_rate_hz) {
    dom.statusDetail.textContent = `· ${s.extra.measured_rate_hz} Hz measured`;
  }

  if (s.mode === 'idle') {
    state.sessionStart = null;
    heart?.clearBeats();
  }
}

function fmtElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Beat handling -- the latency-critical path
// ---------------------------------------------------------------------------

function onBeat(beat) {
  // 1. Animation and sound first, together, before any DOM work. Layout and
  //    style recalculation are the slowest things in this function and must
  //    never sit between the R-peak and the thing the user perceives.
  heart.beat(beat);
  if (beat.rr_ms) state.lastRr = beat.rr_ms;
  audio.beat((state.lastRr || 1000) / 1000, beat.age_ms || 0);

  // 2. Then the readouts.
  state.beats = beat.n;
  dom.statBeats.textContent = beat.n;
  if (beat.rr_ms) dom.statRr.textContent = `${Math.round(beat.rr_ms)} ms`;
  if (beat.bpm) dom.bpmInst.textContent = `inst ${beat.bpm.toFixed(0)}`;

  dom.bpmValue.classList.remove('bpm-kick');
  void dom.bpmValue.offsetWidth; // force reflow so the animation can retrigger
  dom.bpmValue.classList.add('bpm-kick');

  dom.heartStage.classList.remove('beat-flash');
  void dom.heartStage.offsetWidth;
  dom.heartStage.classList.add('beat-flash');
}

function setBpm(bpm) {
  if (!bpm) {
    dom.bpmValue.textContent = '--';
    dom.heroBpm.textContent = '--';
    dom.bpmBar.style.width = '0%';
    return;
  }
  state.lastBpm = bpm;
  const shown = Math.round(bpm);
  dom.bpmValue.textContent = shown;
  dom.heroBpm.textContent = shown;

  // 40..180 BPM mapped across the bar.
  const pct = Math.max(0, Math.min(100, ((bpm - 40) / 140) * 100));
  dom.bpmBar.style.width = `${pct}%`;

  // Colour-code against normal sinus range, the way a monitor would.
  const brady = bpm < 50;
  const tachy = bpm > 120;
  const color = brady || tachy ? '#ffb020' : '#31e07a';
  dom.bpmValue.style.color = color;
  dom.bpmBar.style.background = color;
}


// ---------------------------------------------------------------------------
// Link state: connection honesty + latency
// ---------------------------------------------------------------------------

/**
 * Render the connection pill and the latency readout.
 *
 * The user is watching an animation driven by a machine somewhere else, so the
 * honest thing is to show how far behind it is rather than let them assume it
 * is instantaneous. `age_ms` from the stream is the better number of the two --
 * it is how long ago the beat physically happened -- so it wins when present,
 * with the ping round trip as the fallback before any beat has arrived.
 */
function renderLink(st) {
  const local = st.mode !== LinkMode.SERVER;

  if (local) {
    dom.linkIcon.textContent = st.mode === LinkMode.HYBRID ? '🔌' : '💾';
    dom.linkLabel.textContent = st.mode === LinkMode.HYBRID ? 'Local + server' : 'Local';
    dom.linkLabel.className = 'text-trace-amber';
    dom.linkRtt.textContent = '0 ms';
    dom.linkRtt.className = 'text-slate-500 tabular-nums hidden sm:inline';
    dom.linkPill.title = 'Processing in this browser — no network round trip.';
    return;
  }

  if (!st.serverUp) {
    dom.linkIcon.textContent = '⛔';
    dom.linkLabel.textContent = 'Disconnected';
    dom.linkLabel.className = 'text-trace-alert';
    dom.linkRtt.textContent = '';
    return;
  }

  const latency = st.beatAge != null ? st.beatAge : st.rtt;
  const grade = Link.latencyGrade(latency);
  const colour = {
    good: 'text-trace-ecg',
    fair: 'text-trace-amber',
    poor: 'text-trace-alert',
    none: 'text-slate-400',
  }[grade];

  dom.linkIcon.textContent = '☁';
  dom.linkLabel.textContent = 'Live';
  dom.linkLabel.className = 'text-slate-300';
  dom.linkRtt.textContent = latency == null ? '—' : `${Math.round(latency)} ms`;
  dom.linkRtt.className = `${colour} tabular-nums hidden sm:inline`;
  dom.linkPill.title =
    st.rtt == null
      ? 'Measuring round-trip time…'
      : `Round trip ${Math.round(st.rtt)} ms` +
        (st.beatAge != null ? ` · newest beat ${Math.round(st.beatAge)} ms old` : '');
}

function showOfflineBanner(reason) {
  dom.offlineText.textContent =
    reason === 'unreachable'
      ? 'Cannot reach the server — running the local simulation. Live sensor readings are unavailable.'
      : 'Connection lost — live sensor readings are paused. Showing the local simulation until the server returns.';
  dom.offlineBanner.classList.remove('hidden');
  dom.offlineBanner.classList.add('flex');
}

function hideOfflineBanner() {
  dom.offlineBanner.classList.add('hidden');
  dom.offlineBanner.classList.remove('flex');
}

// ---------------------------------------------------------------------------
// USB sensor (Web Serial)
// ---------------------------------------------------------------------------

/**
 * Connect an AD8232 plugged into *this* machine.
 *
 * The samples are processed locally rather than round-tripped, because the
 * whole point of reading the port here is that the beat should reach the heart
 * without waiting for a network hop. They are still forwarded to the server so
 * the session exists there too -- but that forwarding is fire-and-forget and
 * can never stall acquisition.
 */
async function connectUsbSensor() {
  const reason = webSerialUnavailableReason();
  if (reason) {
    toast(reason, 'error');
    return;
  }

  try {
    sensor = new WebSerialSensor();
    const info = await sensor.requestAndOpen();

    // Tell the server to expect forwarded samples, so it stops simulating and
    // its own status reflects what is really driving the trace.
    try {
      await api.setSource('client', info.label);
    } catch {
      // Server unavailable is not fatal here -- local processing is the
      // primary path and works regardless.
    }

    const push = link.useLocal('push', { hybrid: true, label: info.label });

    sensor.addEventListener('samples', (e) => {
      const { samples, leadsOff } = e.detail;
      push.push(samples, leadsOff);
      link.forwardSamples(samples, leadsOff);
    });

    sensor.addEventListener('close', () => {
      toast('USB sensor disconnected', 'warn');
      dom.btnUsb.classList.remove('btn-primary');
      link.useServer();
      api.setSource('simulate').catch(() => {});
    });

    sensor.addEventListener('error', (e) => toast(`Sensor error: ${e.detail.message}`, 'error'));

    dom.btnUsb.classList.add('btn-primary');
    state.running = true;
    dom.btnStartLabel.textContent = 'Stop Monitoring';
    toast(`USB sensor connected (${info.label})`, 'success');
  } catch (err) {
    // The user closing the port picker throws, and is not an error worth
    // shouting about.
    const msg = String(err?.message || err);
    if (!/No port selected|cancelled/i.test(msg)) toast(msg, 'error');
    sensor = null;
  }
}

async function disconnectUsbSensor() {
  await sensor?.close();
  sensor = null;
  dom.btnUsb.classList.remove('btn-primary');
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function wireUpdates() {
  updates = new UpdateManager();

  updates.addEventListener('update', (e) => {
    const d = e.detail;
    if (d.kind === UpdateKind.SHELL) {
      dom.updateText.textContent = d.version
        ? `Version ${d.version} is available.`
        : 'A new version of the app is available.';
      dom.updateApply.textContent = 'Update now';
    } else {
      dom.updateText.textContent = d.dirty
        ? `Update ${d.remoteVersion} is available, but you have uncommitted local changes — commit or stash them first.`
        : `Update available: ${d.localVersion} → ${d.remoteVersion}. Pull and rebuild?`;
      dom.updateApply.textContent = d.dirty ? 'Open repository' : 'Update & rebuild';
    }
    dom.updateBanner.dataset.kind = d.kind;
    dom.updateBanner.dataset.dirty = d.dirty ? '1' : '';
    dom.updateBanner.dataset.repo = d.repo || '';
    dom.updateBanner.classList.remove('hidden');
    dom.updateBanner.classList.add('flex');
  });

  updates.addEventListener('insecure', (e) => {
    // Worth saying once: on an insecure origin neither offline mode nor USB
    // sensors can work, and both failures would otherwise look like bugs.
    console.warn(e.detail.message);
    dom.btnUsb.title = e.detail.message;
  });

  dom.updateDismiss.addEventListener('click', () => {
    updates.dismiss();
    dom.updateBanner.classList.add('hidden');
    dom.updateBanner.classList.remove('flex');
  });

  dom.updateApply.addEventListener('click', async () => {
    const kind = dom.updateBanner.dataset.kind;

    if (kind === UpdateKind.SHELL) {
      updates.applyShellUpdate();
      return;
    }

    if (dom.updateBanner.dataset.dirty) {
      window.open(`https://github.com/${dom.updateBanner.dataset.repo}`, '_blank');
      return;
    }

    dom.updateApply.disabled = true;
    dom.updateApply.textContent = 'Updating…';
    try {
      const res = await updates.applyCloneUpdate();
      toast(
        res.restart_required
          ? `Updated to ${res.version}. Restart the backend to finish.`
          : `Updated to ${res.version}.`,
        'success'
      );
      dom.updateApply.textContent = 'Reload';
      dom.updateApply.disabled = false;
      dom.updateApply.onclick = () => window.location.reload();
    } catch (err) {
      toast(String(err.message || err), 'error');
      dom.updateApply.disabled = false;
      dom.updateApply.textContent = 'Retry';
    }
  });

  updates.start();
}

// ---------------------------------------------------------------------------
// Install prompt
// ---------------------------------------------------------------------------

function wireInstall() {
  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    // Chrome fires this instead of showing its own UI once preventDefault is
    // called, which lets the button live in the header with everything else.
    e.preventDefault();
    deferred = e;
    dom.btnInstall.classList.remove('hidden');
  });

  dom.btnInstall.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') dom.btnInstall.classList.add('hidden');
    deferred = null;
  });

  window.addEventListener('appinstalled', () => {
    dom.btnInstall.classList.add('hidden');
    toast('Installed. It will keep working offline after this first load.', 'success');
  });
}

// ---------------------------------------------------------------------------
// Stream handling
// ---------------------------------------------------------------------------

function onBatch(msg) {
  const raw = msg.raw;
  const filt = msg.filt;

  chart.push(raw, filt, msg.beats.map((b) => b.i));
  recorder.push(msg.i0, raw, filt, msg.beats.map((b) => b.i));

  for (const b of msg.beats) onBeat(b);

  state.samples = msg.i0 + raw.length;
  if (msg.bpm) setBpm(msg.bpm);
  else if (msg.beats_total < 2) setBpm(0);
}

function onHello(msg) {
  state.serverConfig = msg;
  chart.sampleRate = msg.fs;
  dom.filterInfo.textContent = `0.5–40 Hz · ${msg.mains_hz} Hz notch · ${msg.fs} Hz`;

  // Seed the controls from the server's actual state. The server owns these
  // settings and keeps them across source swaps and page reloads, so a UI that
  // just shows its own HTML defaults will confidently display the wrong
  // numbers -- and the first slider nudge would then jump the signal.
  if (msg.sim) {
    if (typeof msg.sim.bpm === 'number') {
      dom.simBpm.value = Math.round(msg.sim.bpm);
      dom.simBpmVal.textContent = Math.round(msg.sim.bpm);
    }
    if (typeof msg.sim.noise === 'number') {
      const pct = Math.round(msg.sim.noise * 100);
      dom.simNoise.value = pct;
      dom.simNoiseVal.textContent = pct;
    }
    if (typeof msg.sim.artifacts === 'boolean') {
      dom.simArtifacts.checked = msg.sim.artifacts;
    }
  }

  renderStatus(msg.status);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
let frames = 0;
let fpsAccum = 0;
let fps = 0;

function frame(now) {
  requestAnimationFrame(frame);

  // Hidden tab: rAF is already throttled by the browser, but skipping the work
  // entirely means a backgrounded monitor costs essentially nothing.
  if (document.hidden) {
    lastFrame = now;
    return;
  }

  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  // The cardiac model always advances -- it is the data, and pausing it would
  // desynchronise the heart from the trace. Only rasterisation is optional.
  heart.update(dt);
  if (heart.enabled) heart.render();
  chart.draw();

  // Phase readout, derived from the same envelope driving the geometry.
  if (heart.systole > 0.35) dom.phaseLabel.textContent = '— systole —';
  else if (heart.atrial > 0.2) dom.phaseLabel.textContent = '— atrial kick —';
  else if (state.running) dom.phaseLabel.textContent = '— diastole —';
  else dom.phaseLabel.textContent = '— idle —';

  // Cheap counters, refreshed 4x/second rather than per frame.
  fpsAccum += dt;
  frames++;
  if (fpsAccum >= 0.25) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
    updateSlowReadouts();
  }
}

function updateSlowReadouts() {
  dom.statSamples.textContent = state.samples.toLocaleString();
  if (state.sessionStart) {
    dom.statElapsed.textContent = fmtElapsed((Date.now() - state.sessionStart) / 1000);
  }
  dom.perfInfo.textContent =
    `${fps} fps · ${heart.stats.triangles.toLocaleString()} tris · ` +
    `built in ${heart.stats.buildMs} ms` +
    (heart.softwareGL ? ' · software GL' : '');

  if (recorder.recording) {
    dom.recordInfo.textContent =
      `● REC ${fmtElapsed(recorder.seconds)} · ` +
      `${(recorder.bytes / 1048576).toFixed(1)} MB · ${recorder.beatsRecorded} beats`;
  } else if (recorder.count > 0) {
    dom.recordInfo.textContent =
      `Stopped — ${fmtElapsed(recorder.seconds)} ready to export`;
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * Arm audio without making anything wait for it.
 *
 * Creating the AudioContext and offline-rendering the two heart sounds can
 * take a noticeable moment on a loaded machine. It must therefore never sit in
 * front of starting the data stream: a user who clicks "Simulate" expects a
 * trace immediately, not after the sound engine finishes warming up. We still
 * have to call it from inside the click handler, because that is the only
 * place browsers permit audio to start -- we just refuse to await it.
 */
function armAudioInBackground() {
  armAudio().catch(() => {
    /* reported inside armAudio */
  });
}

/**
 * Ensure the audio engine exists and is running.
 * Browsers only allow this inside a user gesture, so every control that could
 * plausibly be the user's first click routes through here.
 */
async function armAudio() {
  if (!state.audioArmed) {
    const ok = await audio.init();
    state.audioArmed = ok;
    if (!ok) {
      toast('Audio unavailable in this browser', 'error');
      return false;
    }
  }
  await audio.resume();
  dom.audioIcon.textContent = audio.enabled ? '🔊' : '🔇';
  return true;
}

async function selectSource(mode) {
  dom.btnStart.disabled = true;
  try {
    if (mode === 'serial') {
      const port = dom.portSelect.value || null;
      const res = await api.setSource('serial', port);
      renderStatus(res.status);
      state.mode = 'serial';
      state.sessionStart = Date.now();
      chart.clear();
      toast(`Connected to ${res.status.port}`, 'success');
    } else if (mode === 'simulate') {
      const res = await api.setSource('simulate');
      renderStatus(res.status);
      state.mode = 'simulate';
      state.sessionStart = Date.now();
      chart.clear();
      toast('Simulation running', 'success');
    } else {
      const res = await api.setSource('off');
      renderStatus(res.status);
      state.mode = 'off';
      chart.clear();
    }
  } catch (err) {
    toast(err.message, 'error');
    dom.serialHint.textContent = err.message;
    // Leave the UI in a usable state rather than a half-connected one.
    try {
      renderStatus(await api.status());
    } catch {
      /* server is down; the socket's retry banner already says so */
    }
  } finally {
    dom.btnStart.disabled = false;
  }
}

async function refreshPorts() {
  dom.portSelect.innerHTML = '<option>scanning…</option>';
  try {
    const info = await api.ports();
    dom.portSelect.innerHTML = '';

    if (!info.pyserial_available) {
      dom.portSelect.innerHTML = '<option value="">pyserial not installed</option>';
      dom.serialHint.textContent =
        'Run: pip install pyserial   (in backend/.venv), then restart the server.';
      return;
    }
    if (!info.ports.length) {
      dom.portSelect.innerHTML = '<option value="">no ports found</option>';
      dom.serialHint.textContent =
        'No COM ports detected. Plug in the Uno, install the CH340/CP210x driver ' +
        'if it is a clone, and close the Arduino IDE Serial Monitor.';
      return;
    }

    for (const p of info.ports) {
      const opt = document.createElement('option');
      opt.value = p.device;
      opt.textContent = `${p.device} — ${p.description}${p.likely_arduino ? '  ✓' : ''}`;
      dom.portSelect.appendChild(opt);
    }
    if (info.suggested) dom.portSelect.value = info.suggested;
    dom.serialHint.textContent =
      `${info.ports.length} port(s) · ${info.baud} baud · ` +
      `expects one ADC value per line`;
  } catch (err) {
    dom.portSelect.innerHTML = '<option value="">error</option>';
    dom.serialHint.textContent = err.message;
  }
}

function bindControls() {
  // --- start / pause ----------------------------------------------------
  dom.btnStart.addEventListener('click', async () => {
    armAudioInBackground();
    if (state.mode === 'off') {
      await selectSource('simulate');
      return;
    }
    try {
      const res = await api.setMonitor(!state.running);
      renderStatus(res.status);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // --- source -----------------------------------------------------------
  dom.btnSim.addEventListener('click', async () => {
    armAudioInBackground();
    dom.serialPanel.classList.add('hidden');
    dom.simControls.classList.remove('hidden');
    await selectSource('simulate');
  });

  dom.btnSerial.addEventListener('click', async () => {
    armAudioInBackground();
    const opening = dom.serialPanel.classList.contains('hidden');
    dom.serialPanel.classList.toggle('hidden', !opening);
    if (opening) {
      await refreshPorts();
      dom.serialHint.textContent += '  →  press Arduino again to connect.';
    } else {
      dom.simControls.classList.add('hidden');
      await selectSource('serial');
    }
  });

  dom.btnRefreshPorts.addEventListener('click', refreshPorts);

  // --- audio ------------------------------------------------------------
  dom.btnUsb.addEventListener('click', async () => {
    if (sensor?.connected) {
      await disconnectUsbSensor();
      link.useServer();
      api.setSource('simulate').catch(() => {});
      toast('USB sensor disconnected', 'info');
    } else {
      await connectUsbSensor();
    }
  });

  dom.btnAudio.addEventListener('click', async () => {
    if (!state.audioArmed) {
      const ok = await armAudio();
      if (ok) {
        audio.setEnabled(true);
        dom.audioIcon.textContent = '🔊';
        toast('Heart sounds on', 'success');
      }
      return;
    }
    audio.setEnabled(!audio.enabled);
    dom.audioIcon.textContent = audio.enabled ? '🔊' : '🔇';
  });

  dom.audioVolume.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.volVal.textContent = v;
    audio.setVolume(v / 100);
  });

  dom.audioPitch.addEventListener('input', (e) => {
    const p = Number(e.target.value) / 100;
    dom.pitchVal.textContent = p.toFixed(2);
    audio.setPitch(p);
  });

  // --- simulation -------------------------------------------------------
  const pushSim = debounce(async (patch) => {
    try {
      // Apply locally first: offline that is the only thing running, and
      // online it costs nothing. A slider that does nothing when the network
      // is down is indistinguishable from a broken control.
      link.engine.configureSimulation(patch);
      await api.setSimulation(patch);
    } catch (err) {
      toast(err.message, 'error');
    }
  }, 90);

  dom.simBpm.addEventListener('input', (e) => {
    const bpm = Number(e.target.value);
    dom.simBpmVal.textContent = bpm;
    pushSim({ bpm });
  });

  dom.simNoise.addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    dom.simNoiseVal.textContent = pct;
    pushSim({ noise: pct / 100 });
  });

  dom.simArtifacts.addEventListener('change', (e) => {
    pushSim({ artifacts: e.target.checked });
  });

  // --- display ----------------------------------------------------------
  document.querySelectorAll('[data-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document
        .querySelectorAll('[data-window]')
        .forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      chart.setWindowSeconds(Number(btn.dataset.window));
    });
  });

  dom.showRaw.addEventListener('change', (e) => (chart.showRaw = e.target.checked));
  dom.showFilt.addEventListener('change', (e) => (chart.showFiltered = e.target.checked));

  dom.qualitySelect.addEventListener('change', async (e) => {
    const q = e.target.value;
    dom.boot.style.opacity = '1';
    dom.boot.style.pointerEvents = 'auto';
    dom.bootStatus.textContent = 'Rebuilding cardiac anatomy…';
    // Yield a frame so the overlay actually paints before we block on the
    // geometry build.
    await new Promise((r) => setTimeout(r, 30));
    rebuildHeart(q);
    hideBoot();
  });

  // --- recording --------------------------------------------------------
  dom.btnRecord.addEventListener('click', () => {
    if (recorder.recording) {
      recorder.stop();
      dom.btnRecord.textContent = '● Record';
      dom.btnRecord.classList.remove('is-active');
      dom.btnExport.disabled = recorder.count === 0;
      toast(`Recorded ${fmtElapsed(recorder.seconds)}`, 'success');
    } else {
      if (!recorder.start()) {
        toast('Could not allocate recording buffer', 'error');
        return;
      }
      dom.btnRecord.textContent = '■ Stop';
      dom.btnRecord.classList.add('is-active');
      dom.btnExport.disabled = true;
      toast('Recording (5 min rolling buffer)', 'success');
    }
  });

  dom.btnExport.addEventListener('click', () => {
    const cfg = state.serverConfig || {};
    const ok = recorder.download({
      source: state.mode,
      port: cfg.status?.port,
      adcMax: cfg.adc_max,
      adcVref: cfg.adc_vref,
      gain: cfg.gain,
      bpm: state.lastBpm,
    });
    toast(ok ? 'CSV exported' : 'Nothing recorded yet', ok ? 'success' : 'error');
  });

  // --- keyboard ---------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      dom.btnStart.click();
    } else if (e.key === 'm' || e.key === 'M') {
      dom.btnAudio.click();
    } else if (e.key === 'r' || e.key === 'R') {
      dom.btnRecord.click();
    }
  });

  // --- resize -----------------------------------------------------------
  const onResize = debounce(() => {
    heart.resize();
    chart.resize();
  }, 120);
  window.addEventListener('resize', onResize);
  // The panels are flex/grid children, so a window resize is not the only way
  // their box changes. Observe the elements directly.
  const ro = new ResizeObserver(onResize);
  ro.observe(dom.heartCanvas);
  ro.observe(dom.ecgCanvas);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function rebuildHeart(quality) {
  const wasBeating = heart ? { rr: heart.rr, lastBeatAt: heart.lastBeatAt } : null;
  heart?.dispose();
  heart = new HeartView(dom.heartCanvas, { quality });
  if (wasBeating) Object.assign(heart, wasBeating);
  heart.resize();
}

function hideBoot() {
  dom.boot.style.opacity = '0';
  dom.boot.style.pointerEvents = 'none';
  setTimeout(() => (dom.boot.style.display = 'none'), 520);
}

async function boot() {
  chart = new ECGChart(dom.ecgCanvas, { windowSeconds: 4, sampleRate: 1000 });
  audio = new HeartAudio();
  recorder = new Recorder(1000, 300);

  // ?quality=low|medium|high overrides the auto-detected level. Useful for
  // troubleshooting on weak hardware, and for pinning the level in tests.
  const forced = new URLSearchParams(location.search).get('quality');
  const quality = ['low', 'medium', 'high'].includes(forced) ? forced : autoQuality();
  dom.qualitySelect.value = quality;
  dom.bootStatus.textContent = `Generating cardiac anatomy (${quality})…`;

  // Let the overlay paint before the synchronous geometry build.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  heart = new HeartView(dom.heartCanvas, { quality });
  heart.resize();
  chart.resize();

  bindControls();

  // --- backend ----------------------------------------------------------
  // Link owns the choice of where data comes from -- the server, or the local
  // JS pipeline -- and re-emits both under one event surface, so everything
  // below is written once and works either way.
  link = new Link();
  link.addEventListener('hello', (e) => onHello(e.detail));
  link.addEventListener('batch', (e) => onBatch(e.detail));
  link.addEventListener('status', (e) => renderStatus(e.detail.status));
  link.addEventListener('link', (e) => renderLink(e.detail));

  link.addEventListener('open', () => {});

  link.addEventListener('fallback', (e) => {
    // The trace keeps moving on local simulation. Say so explicitly -- a
    // monitor that silently switches data sources is misleading, and a
    // monitor that silently freezes is worse.
    showOfflineBanner(e.detail.reason);
    dom.livePing.classList.add('is-idle');
    toast('Server unreachable — switched to local simulation', 'warn');
  });

  link.conn.addEventListener('open', () => {
    dom.btnStart.disabled = false;
    hideOfflineBanner();
    dom.livePing.classList.remove('is-idle');
    toast('Connected to ECG server', 'success');
  });

  link.conn.addEventListener('close', () => {
    dom.statusDot.className = 'h-2 w-2 rounded-full bg-trace-alert';
    dom.statusLabel.textContent = 'Server offline';
    dom.statusDetail.textContent = '· retrying…';
    dom.livePing.classList.add('is-idle');
  });

  link.connect();
  renderLink(link.state());

  dom.offlineDismiss.addEventListener('click', hideOfflineBanner);

  wireUpdates();
  wireInstall();

  try {
    const cfg = await api.config();
    onHello(cfg);
  } catch {
    // No server at all. The app is still fully usable on local simulation,
    // which is the entire point of porting the DSP to the browser.
    dom.bootStatus.textContent = 'Server unreachable — using local simulation';
    dom.btnStart.disabled = false;
    link.useLocal('simulate');
    showOfflineBanner('unreachable');
  }

  requestAnimationFrame((t) => {
    lastFrame = t;
    frame(t);
  });

  // Debug/inspection hook. Handy from the devtools console, and it is what the
  // automated browser tests assert against (renderer triangle counts, beat
  // totals, audio state) rather than scraping formatted text out of the DOM.
  window.__ecg = {
    get state() { return state; },
    get heart() { return heart; },
    get chart() { return chart; },
    get audio() { return audio; },
    get recorder() { return recorder; },
    get fps() { return fps; },
    get renderInfo() { return heart.renderer.info.render; },
    get link() { return link; },
    get linkState() { return link.state(); },
    get engine() { return link.engine; },
    get sensor() { return sensor; },
    get updates() { return updates; },
  };

  hideBoot();
}

boot();
