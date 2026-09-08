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
import { ModeManager, AppMode } from './mode.js';
import { UpdateManager, UpdateKind } from './updates.js';
import { WebSerialSensor, webSerialUnavailableReason } from './webserial.js';
import { SAMPLE_RATE } from './dsp/coeffs.js';

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

  netPill: $('net-pill'),
  netDot: $('net-dot'),
  netLabel: $('net-label'),

  modeSwitch: $('mode-switch'),
  modeOnline: $('mode-online'),
  modeOffline: $('mode-offline'),
  modeLock: $('mode-lock'),

  btnInstallPanel: $('btn-install-panel'),
  installBlurb: $('install-blurb'),
  installState: $('install-state'),
  secureLink: $('secure-link'),

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
  sensorState: $('sensor-state'),
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
/** @type {ModeManager} */
let modes;
/** Deferred beforeinstallprompt event, if the browser offered one. */
let installPrompt = null;
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

  // Keep the UI's idea of the source in step with reality.
  //
  // This used to be set only inside selectSource(), so it was wrong after
  // every page load: the app came up believing the source was 'off' while a
  // simulation was plainly running, and the Start/Pause button therefore
  // re-selected the source instead of pausing it. Nothing surfaced the
  // mismatch, because the button's LABEL comes from status and was correct.
  if (s.mode === 'simulating') state.mode = 'simulate';
  else if (s.mode === 'connected') state.mode = 'serial';
  else if (s.mode === 'idle') state.mode = 'off';
  // 'error' deliberately leaves it alone: the source still exists, it is just
  // unhappy, and forgetting which one it is would make recovery harder.

  // Session clock. Same problem: it only started when the user picked a source
  // by hand, so a page that loaded against an already-running session showed
  // 00:00 forever. The server (and the local engine) both report uptime, so
  // trust that and fall back to the local clock only if it is absent.
  if (typeof s.uptime_s === 'number' && s.uptime_s > 0) {
    state.sessionStart = Date.now() - s.uptime_s * 1000;
  } else if (s.running && state.sessionStart === null) {
    state.sessionStart = Date.now();
  }

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
    dom.footerSource.textContent = `Simulated AD8232 · Arduino Uno R3 / Nano · ${s.sample_rate} Hz`;
  }

  if (s.extra?.measured_rate_hz) {
    dom.statusDetail.textContent = `· ${s.extra.measured_rate_hz} Hz measured`;
  }

  if (s.mode === 'idle') {
    state.sessionStart = null;
    heart?.clearBeats();
  }

  syncSimControls(s);
}

/**
 * Timestamp of this user's last touch on each simulation control.
 *
 * The shared session broadcasts status four times a second, so without this a
 * remote value would fight the user's own drag -- the handle would jump back
 * under their finger between frames -- and their own change would echo back
 * and re-set the control they were still moving.
 */
const simEdit = { bpm: 0, noise: 0, artifacts: 0 };

/**
 * How long a local edit wins over the broadcast.
 *
 * Long enough to cover a drag plus the round trip that echoes the change back
 * (measured at ~20-150 ms here), short enough that letting go of the slider
 * hands control back to the shared session almost immediately.
 */
const SIM_ECHO_MS = 1600;

/**
 * Reflect another user's changes in this dashboard's controls.
 *
 * The server session is shared: anyone with the link can move the simulation,
 * and everyone sees the result. The trace and the BPM readout already followed
 * -- they are derived from the stream -- but the CONTROLS did not, so a
 * dashboard could show 60 on its slider while plainly rendering 100 BPM.
 *
 * Only applies to the shared session. A private or offline session belongs to
 * this user alone and nothing remote should touch it.
 */
function syncSimControls(s) {
  if (drivingLocally()) return;

  const x = s.extra;
  if (!x) return;

  const now = performance.now();

  if (typeof x.bpm === 'number' && now - simEdit.bpm > SIM_ECHO_MS) {
    const bpm = Math.round(x.bpm);
    if (Number(dom.simBpm.value) !== bpm) {
      dom.simBpm.value = bpm;
      dom.simBpmVal.textContent = bpm;
    }
  }

  if (typeof x.noise === 'number' && now - simEdit.noise > SIM_ECHO_MS) {
    const pct = Math.round(x.noise * 100);
    if (Number(dom.simNoise.value) !== pct) {
      dom.simNoise.value = pct;
      dom.simNoiseVal.textContent = pct;
    }
  }

  if (typeof x.artifacts === 'boolean' && now - simEdit.artifacts > SIM_ECHO_MS) {
    if (dom.simArtifacts.checked !== x.artifacts) {
      dom.simArtifacts.checked = x.artifacts;
    }
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

  // -- connectivity indicator -------------------------------------------
  // Two signals, deliberately. `navigator.onLine` flips the instant the OS
  // notices, which is what makes this feel immediate; the socket state is what
  // makes it true (onLine returns true on a captive portal that drops every
  // packet). Offline if either says so.
  const reachable = st.serverUp && st.browserOnline;
  dom.netDot.className = `h-2 w-2 rounded-full ${
    reachable ? 'bg-trace-ecg' : 'bg-trace-alert'
  }`;
  dom.netLabel.textContent = reachable ? 'Internet' : 'No internet';
  dom.netLabel.className = reachable ? 'text-slate-300' : 'text-trace-alert';
  dom.netPill.title = reachable
    ? 'Connected to the server. Sensor data can be sent for processing.'
    : st.browserOnline
      ? 'This device is online but the server is unreachable. Running locally.'
      : 'This device has no network connection. Running locally.';

  renderModeSwitch(st, reachable);

  // -- link quality ------------------------------------------------------
  if (local) {
    dom.linkIcon.textContent = st.privateSession ? '🔌' : '💾';
    dom.linkLabel.textContent = st.privateSession
      ? 'Private'
      : st.degraded
        ? 'Local (fallback)'
        : 'Local';
    dom.linkLabel.className = st.degraded ? 'text-trace-amber' : 'text-slate-300';
    dom.linkRtt.textContent = '0 ms';
    dom.linkRtt.className = 'text-trace-ecg tabular-nums hidden sm:inline';
    dom.linkPill.title = st.privateSession
      ? 'Your own sensor, processed here. Detached from the shared session, so nobody else can change what you see.'
      : st.degraded
        ? 'Server unreachable — processing in this browser until it returns.'
        : 'Processing in this browser — no network round trip.';
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


/**
 * The mode switch.
 *
 * In a browser tab it is locked to Online and says why. Once installed, the
 * choice is real: the machine has its own copy and can do the work.
 */
function renderModeSwitch(st, reachable) {
  // A socket event can land before boot() finishes wiring. Rendering the rest
  // of the pill is still useful, so skip only this part.
  if (!modes) return;
  const m = modes.state();
  const online = m.mode === AppMode.ONLINE;

  dom.modeOnline.classList.toggle('is-active', online);
  dom.modeOffline.classList.toggle('is-active', !online);
  dom.modeOnline.setAttribute('aria-pressed', String(online));
  dom.modeOffline.setAttribute('aria-pressed', String(!online));

  dom.modeOnline.disabled = !m.canToggle;
  dom.modeOffline.disabled = !m.canToggle;

  dom.modeLock.style.display = m.canToggle ? 'none' : '';
  dom.modeLock.title = m.lockedReason || '';
  dom.modeSwitch.title = m.canToggle
    ? 'Online sends data to the server. Offline processes everything on this computer.'
    : m.lockedReason;

  // Online-but-unreachable is not a failure, it is "waiting". Say that on the
  // button rather than silently showing Online while running locally.
  if (m.canToggle && online && !reachable) {
    dom.modeOnline.textContent = 'Online·waiting';
  } else {
    dom.modeOnline.textContent = 'Online';
  }
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
/**
 * Read the sensor attached to THIS computer, detached from the shared session.
 *
 * The online session is deliberately shared -- anyone with the link moves the
 * simulation for everyone. That is right for a demonstration and wrong the
 * moment a user has their own hardware: their trace is their heart, and a
 * stranger changing the simulated rate must not touch it.
 *
 * So asking for your own sensor steps out of the shared session entirely. The
 * detachment happens FIRST, before any of the fallible work, because the user
 * asked to leave -- and that has to hold whether or not a sensor turns up.
 *
 * When no sensor is found the trace stops. It deliberately does NOT fall back
 * to the shared simulation: showing a moving trace that is not the user's own
 * heart, on a dashboard they just pointed at their chest, is the worst
 * available outcome.
 */
async function useOwnSensor() {
  armAudioInBackground();

  // Detach immediately, with no source: reading stops until a sensor is found.
  link.usePrivate('off');
  chart.clear();
  state.sessionStart = null;
  dom.simControls.classList.add('hidden');
  dom.serialPanel.classList.remove('hidden');
  dom.btnSerial.classList.add('is-active');
  dom.btnSim.classList.remove('is-active');
  renderLink(link.state());

  const reason = webSerialUnavailableReason();
  if (reason) {
    dom.serialHint.textContent = reason;
    toast(reason, 'error');
    return;
  }

  dom.sensorState.textContent = 'looking for a board…';
  dom.sensorState.className = 'input flex-1 truncate !py-1 font-mono text-[11px] text-slate-400';
  dom.serialHint.textContent = 'Looking for a connected ECG board…';

  try {
    if (!sensor?.connected) {
      sensor = new WebSerialSensor();
      // Reopen a port the user already granted without prompting again; only
      // ask when there is nothing to reopen.
      const reopened = await sensor.openGranted();
      if (!reopened) {
        dom.sensorState.textContent = 'choose a board…';
        // requestPort() resolves when the user picks, rejects when they
        // cancel -- and in an environment with no picker at all it may do
        // neither. Same failure shape as AudioContext.resume(): a promise
        // that never settles leaves the UI stuck on a progress label with no
        // way back. Race it so there is always an outcome.
        await Promise.race([
          sensor.requestAndOpen(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('No board selected')), 120000)
          ),
        ]);
      }
    }

    const info = sensor.info();
    const push = link.usePrivate('push', { label: info.label });
    attachSensorTo(push);

    dom.btnUsb.classList.add('btn-primary');
    dom.sensorState.textContent = info.label;
    dom.sensorState.className = 'input flex-1 truncate !py-1 font-mono text-[11px] text-trace-ecg';
    dom.serialHint.textContent = 'Reading your own sensor. This session is yours alone.';
    toast(`Sensor connected (${info.label}) — detached from the shared session`, 'success');
  } catch (err) {
    const msg = String(err?.message || err);
    const cancelled = /No port selected|cancelled/i.test(msg);
    dom.serialHint.textContent = cancelled
      ? 'No board selected. Reading is stopped — press Arduino again, or Simulate to rejoin.'
      : msg;
    if (!cancelled) toast(msg, 'error');
    sensor = null;
    dom.sensorState.textContent = 'No board connected';
    dom.sensorState.className = 'input flex-1 truncate !py-1 font-mono text-[11px] text-trace-alert';
    // Stay detached with no data. Rejoining silently would put the shared
    // simulation back on screen as though it were a real reading.
  }
}

/** Wire an open sensor to a local push source. */
function attachSensorTo(push) {
  sensor.addEventListener('samples', (e) => {
    const { samples, leadsOff } = e.detail;
    push.push(samples, leadsOff);
  });

  sensor.addEventListener('close', () => {
    dom.btnUsb.classList.remove('btn-primary');
    dom.sensorState.textContent = 'No board connected';
    dom.sensorState.className = 'input flex-1 truncate !py-1 font-mono text-[11px] text-trace-alert';
    dom.serialHint.textContent = 'Sensor disconnected. Reading stopped.';
    toast('Sensor disconnected — reading stopped', 'warn');
    // Still detached, still no data, for the same reason as above.
    link.usePrivate('off');
    renderLink(link.state());
  });

  sensor.addEventListener('error', (e) => toast(`Sensor error: ${e.detail.message}`, 'error'));
}

/** Rejoin the shared server session. */
async function rejoinShared() {
  armAudioInBackground();
  await disconnectUsbSensor();
  dom.serialPanel.classList.add('hidden');
  dom.simControls.classList.remove('hidden');
  dom.btnSerial.classList.remove('is-active');
  link.rejoin();
  chart.clear();
  renderLink(link.state());

  // If the shared session is idle, starting it is a global act -- which is
  // correct here: that is what the shared dashboard is for.
  try {
    const st = await api.status();
    if (st.mode === 'idle') await api.setSource('simulate');
    renderStatus(st);
  } catch {
    /* server unreachable; the connection pill already says so */
  }
  toast('Rejoined the shared session', 'success');
}

async function connectUsbSensor() {
  const reason = webSerialUnavailableReason();
  if (reason) {
    toast(reason, 'error');
    return;
  }

  try {
    sensor = new WebSerialSensor();
    const info = await sensor.requestAndOpen();

    // Deliberately does NOT touch the server's source. That call switched the
    // SHARED session to this client's feed, so one user plugging in a board
    // stopped everyone else's trace. A sensor is private by nature.
    const push = link.usePrivate('push', { label: info.label });
    attachSensorTo(push);

    dom.serialPanel.classList.remove('hidden');
    dom.simControls.classList.add('hidden');
    dom.btnSerial.classList.add('is-active');
    dom.btnSim.classList.remove('is-active');
    dom.serialHint.textContent = `Reading from ${info.label}. This session is yours alone.`;

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
  // Gated on the app being allowed to talk to the server at all. In offline
  // mode there is nothing to check against and nothing to update to.
  updates = new UpdateManager(() => modes.mode === AppMode.ONLINE);

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
  const setInstallUi = (available, note) => {
    dom.btnInstall.classList.toggle('hidden', !available);
    dom.btnInstallPanel.disabled = !available;
    dom.btnInstallPanel.classList.toggle('needs-net-off', !available);
    if (note) dom.installState.textContent = note;
  };

  // Already installed: there is nothing to offer, so say what they have.
  if (modes.installed) {
    setInstallUi(false, 'Installed. Offline mode is available.');
    dom.installBlurb.textContent =
      'Running as an installed app. Use the Offline/Online switch to choose whether data is processed here or on the server.';
    dom.btnInstallPanel.classList.add('hidden');
  } else {
    setInstallUi(false, 'Checking…');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    // Chrome suppresses its own UI once preventDefault is called, which lets
    // the prompt live where the rest of the controls are.
    e.preventDefault();
    installPrompt = e;
    setInstallUi(true, '');
  });

  const doInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') setInstallUi(false, 'Installing…');
    else setInstallUi(false, 'Install dismissed. The button returns if you reload.');
  };

  dom.btnInstall.addEventListener('click', doInstall);
  dom.btnInstallPanel.addEventListener('click', doInstall);

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    setInstallUi(false, 'Installed. Offline mode is now available.');
    toast('Installed. It keeps working offline, and you can now switch to Offline mode.', 'success');
  });

  // On an insecure origin the browser will never offer installation and Web
  // Serial is blocked outright. Rather than leave two dead buttons, find out
  // where the secure copy lives and point at it.
  checkSecureOrigin();
}

/**
 * Is this origin secure, and if not, where is the one that is?
 *
 * Both headline features -- installing, and reading a USB sensor -- are
 * silently unavailable over plain http on an IP address. Silently is the
 * problem: the user clicks and nothing sensible happens.
 */
async function checkSecureOrigin() {
  if (window.isSecureContext) return;
  // Nothing to look up while offline, and the request would only fail.
  if (!navigator.onLine || modes.mode !== AppMode.ONLINE) return;

  dom.installBlurb.textContent =
    'Installing and USB sensors need a secure (https) connection. This page is running over plain http.';

  try {
    const res = await fetch('/api/access', { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    if (!info.secure_url) return;

    const url = info.secure_url + location.pathname;
    dom.secureLink.href = url;
    dom.secureLink.classList.remove('hidden');
    dom.secureLink.textContent = 'Open the secure link → enables USB sensors & install';
    dom.btnUsb.title = `USB sensors need https. Open ${info.secure_url}`;
    dom.installState.textContent = 'Install is unavailable on this insecure address.';
  } catch {
    /* no access endpoint; nothing useful to point at */
  }
}

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

function wireModes() {
  modes = new ModeManager();
  modes.addEventListener('change', () => link && renderLink(link.state()));
}

function bindModeButtons() {
  const apply = (mode) => {
    if (!modes.set(mode)) {
      if (!modes.state().canToggle) {
        toast(modes.state().lockedReason, 'info');
      }
      return;
    }
    link.applyUserMode(mode);
    if (mode === AppMode.OFFLINE) {
      hideOfflineBanner();
      toast('Offline mode — everything is processed on this computer.', 'success');
    } else {
      // Carry whatever the user set while offline up to the server, or the two
      // disagree about what is being simulated and the trace visibly jumps
      // when the server's own settings take over.
      api.setSimulation({ ...link.engine.simConfig }).catch(() => {});
      toast('Online mode — data is processed on the server.', 'success');
    }
    renderLink(link.state());
  };

  dom.modeOnline.addEventListener('click', () => apply(AppMode.ONLINE));
  dom.modeOffline.addEventListener('click', () => apply(AppMode.OFFLINE));
}

// ---------------------------------------------------------------------------
// Control routing
// ---------------------------------------------------------------------------

/**
 * Every control has two possible destinations, and picking the wrong one is
 * the difference between a working app and a broken one.
 *
 * When the local engine is driving, the server is not merely optional -- it is
 * irrelevant, and may be unreachable. Calling it anyway is what produced
 * "Failed to fetch" toasts on the sliders and a Pause button that did nothing
 * while the trace kept running: the local state was in fact updated first, and
 * then the network call threw and buried that success under an error.
 *
 * So: local engine when local, server when server, never both.
 */
function drivingLocally() {
  return link.mode !== LinkMode.SERVER;
}

async function ctlSetSimulation(patch) {
  // Always apply locally. Online this keeps the engine warm and correct for
  // the moment the connection drops, and it costs nothing.
  link.engine.configureSimulation(patch);
  if (drivingLocally()) return { ok: true, config: link.engine.simConfig };
  return api.setSimulation(patch);
}

async function ctlSetMonitor(running) {
  if (drivingLocally()) {
    return { ok: true, status: link.engine.setPaused(!running) };
  }
  return api.setMonitor(running);
}

async function ctlSetSource(mode, port = null) {
  if (drivingLocally()) {
    // 'serial' means a board attached to the SERVER, which by definition
    // cannot be reached from here. The USB Sensor button is the local path.
    if (mode === 'serial') {
      throw new Error('Server-side sensors need an online connection. Use USB Sensor instead.');
    }
    link.engine.select(mode === 'off' ? 'off' : 'simulate');
    return { ok: true, status: link.engine.status() };
  }
  return api.setSource(mode, port);
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
  // The recorder writes time_s as index / sampleRate, so a stale rate here
  // silently scales every timestamp in the exported CSV and the r_peak column
  // reads as a wildly wrong heart rate. Never move it mid-capture: that would
  // corrupt the timebase of the recording already in progress.
  if (recorder && !recorder.recording && typeof msg.fs === 'number') {
    recorder.sampleRate = msg.fs;
  }
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



function bindControls() {
  // --- start / pause ----------------------------------------------------
  dom.btnStart.addEventListener('click', async () => {
    armAudioInBackground();
    if (state.mode === 'off') {
      // Nothing is running. Offline (or detached) that means start the local
      // simulator; on the shared session it means start it for everyone.
      if (drivingLocally()) {
        link.engine.select('simulate');
        chart.clear();
      } else {
        await rejoinShared();
      }
      return;
    }
    try {
      const res = await ctlSetMonitor(!state.running);
      renderStatus(res.status);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // --- source -----------------------------------------------------------
  // Simulate = the SHARED session. Arduino = MY sensor, private.
  //
  // The pairing is the point: one button joins everyone, the other steps out.
  // Previously both swapped the SERVER's source, so picking Arduino stopped
  // every other viewer's trace -- which is indefensible once more than one
  // person has the link.
  dom.btnSim.addEventListener('click', () => {
    if (modes.mode === AppMode.OFFLINE) {
      // Offline there is no shared session to rejoin; this just means "use the
      // simulator" on the local engine.
      armAudioInBackground();
      dom.serialPanel.classList.add('hidden');
      dom.simControls.classList.remove('hidden');
      dom.btnSerial.classList.remove('is-active');
      link.usePrivate('simulate');
      chart.clear();
      renderLink(link.state());
      return;
    }
    rejoinShared();
  });

  dom.btnSerial.addEventListener('click', () => useOwnSensor());

  // "Refresh ports" now means "pick a different board", since the ports that
  // matter are on this machine and only the browser may enumerate them.
  dom.btnRefreshPorts.addEventListener('click', async () => {
    await disconnectUsbSensor();
    await useOwnSensor();
  });


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
  // Coalescing, not debouncing.
  //
  // A plain debounce keeps only the LAST call, which is right for repeated
  // updates to ONE control and wrong across controls: nudging noise and then
  // toggling artifacts inside the window discarded the noise change entirely,
  // and silently. Merging the patches keeps every field while still collapsing
  // a drag into a single request.
  let pendingSim = null;
  let simTimer = null;
  const pushSim = (patch) => {
    pendingSim = { ...(pendingSim || {}), ...patch };
    clearTimeout(simTimer);
    simTimer = setTimeout(async () => {
      const merged = pendingSim;
      pendingSim = null;
      try {
        // ctlSetSimulation applies locally first: offline that is the only
        // thing running, and online it costs nothing.
        await ctlSetSimulation(merged);
      } catch (err) {
        toast(err.message, 'error');
      }
    }, 90);
  };

  dom.simBpm.addEventListener('input', (e) => {
    const bpm = Number(e.target.value);
    simEdit.bpm = performance.now();
    dom.simBpmVal.textContent = bpm;
    pushSim({ bpm });
  });

  dom.simNoise.addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    simEdit.noise = performance.now();
    dom.simNoiseVal.textContent = pct;
    pushSim({ noise: pct / 100 });
  });

  dom.simArtifacts.addEventListener('change', (e) => {
    simEdit.artifacts = performance.now();
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
  chart = new ECGChart(dom.ecgCanvas, { windowSeconds: 4, sampleRate: SAMPLE_RATE });
  audio = new HeartAudio();
  // Seeded from the generated DSP constant rather than a literal, so the
  // exported CSV's time base follows the configured sample rate. onHello
  // corrects it to whatever the server actually reports.
  recorder = new Recorder(SAMPLE_RATE, 300);

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
  // Created before the link: renderLink() consults it, and a socket event can
  // arrive the moment the link is constructed.
  wireModes();

  link = new Link();
  link.userMode = modes.mode;
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

  bindModeButtons();
  wireUpdates();
  wireInstall();

  // Honour a saved Offline preference straight away, so an installed app that
  // was left in Offline does not briefly stream from the server on launch.
  if (modes.mode === AppMode.OFFLINE) {
    link.applyUserMode(AppMode.OFFLINE);
  }

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
    get modes() { return modes; },
    get modeState() { return modes.state(); },
  };

  hideBoot();
}

boot();
