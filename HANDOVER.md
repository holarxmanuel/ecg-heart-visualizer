# PROJECT HANDOVER — Real-Time ECG Heart Visualizer

**Written:** 2026-07-27 · **Updated:** 2026-07-29 (modes, HTTPS, heart surface)

---

# PART 0 — STATE AS OF 2026-07-29

Everything specified in Part 5 has now been **built and verified**. What
changed since the migration:

| Item | State | Evidence |
|---|---|---|
| Always-on service | **Done** | systemd `ecg-backend`, restarts on any exit |
| Reachable on the network | **Done** | `HOST=0.0.0.0`, Caddy on 80/443 |
| HTTPS / secure context | **Done, via tunnel** | see Part 0.1 |
| Online/offline mode toggle | **Done** | locked in a tab, free once installed |
| Live connectivity indicator | **Done** | reacts without a refresh |
| Heart surface realism | **Reworked** | per-pixel tissue, relief, lighting |
| JS DSP port (offline) | **Done, bit-exact** | `verify_dsp.py` — 0.000e+00 V max diff |
| Local engine | **Done** | emits the server's exact wire format |
| PWA / offline | **Done, verified** | boots and beats with the network OFF |
| Web Serial USB sensor | **Done** | `webserial.js` + `ClientFedSource` |
| Latency meter | **Done** | RTT + true beat age, colour-coded |
| Online/offline indicator | **Done** | socket state, not `navigator.onLine` |
| Auto-update (web + PWA) | **Done** | build id polling + SW cache swap |
| Auto-update (local clone) | **Done** | loopback-only `git pull` + rebuild |
| Linux serial detection | **Done** | 32 phantom ports → 0 |
| Mains frequency | **Done** | 50 Hz (Nigeria) |
| GitHub + CI | **Done** | `holarxmanuel/ecg-heart-visualizer` |
| AO "comb" artifact (4.1) | **Resolved** | confirmed by screenshot |

Test results: `selftest.py` 20/20 · `verify_dsp.py` all pass · `smoketest.py`
all pass · browser harness **42/42**.

## 0.1 HTTPS, and the firewall

**Ports 80 and 443 are blocked upstream** (8000 and 22 get through). The host
firewall is wide open, so it is a cloud firewall. ACME connects to those exact
port numbers and neither is configurable, so Let's Encrypt cannot validate
however Caddy is set up.

**Resolved with a Cloudflare tunnel** (`ecg-tunnel.service`), which dials
outbound and so needs no inbound port at all. It terminates TLS on Cloudflare's
edge with a certificate browsers already trust, which restores the secure
context Web Serial and service workers both require.

`GET /api/access` reports the current secure URL, and the app links to it from
the insecure origin rather than leaving two dead buttons.

**Caveat worth acting on:** a free quick tunnel's hostname is random and
changes on restart. An installed app's identity is its origin, so a changed
hostname orphans installed copies. Either open 80/443 (Caddy is still
configured for `143-198-27-18.nip.io` and will pick up a certificate by
itself), or run a named tunnel against a Cloudflare account.

## 0.2 The half-open socket

Worth knowing because it will come back in any networked rewrite. A WebSocket
stays in `readyState OPEN` long after its network has gone — TCP only finds
out when a send fails — so reconnect logic guarded on "am I connected?"
declines to act and the app stays in fallback permanently. Liveness now comes
from the ping/pong that already existed: three unanswered pings condemns the
socket, and the rebuild does not consult `readyState` at all.

## 0.3 Where the architecture went

The `ECGSource` abstraction absorbed the new requirement exactly as intended —
`ClientFedSource` is a third implementation, not a special case. The genuinely
new idea is that the **signal chain now exists twice**, in Python and in
JavaScript, with `verify_dsp.py` as the contract between them.

That was the largest item in the old Part 5.3, and the approach that made it
cheap was refusing to reimplement filter *design* in JS. `backend/export_dsp.py`
bakes scipy's SOS matrices into a generated `coeffs.js`; only the ~20 lines of
`sosfilt` arithmetic were ported by hand. The result is bit-identical output,
not merely close.

---

# PART 1 — WHAT THIS PROJECT IS

A real-time single-lead ECG monitor whose centrepiece is an **anatomically accurate, procedurally generated 3D human heart** that contracts on every detected R-peak, in sync with synthesised heart sounds, above a scrolling ECG waveform.

It runs today against a physically-modelled **simulation** of an AD8232 + Arduino Uno R3. The hardware has not arrived yet. The entire system was built so that swapping simulation for real hardware is a configuration change, not a rewrite.

**Non-negotiables from the original brief:**
- Heart is the hero: centred, large, anatomically real (not a ❤️ symbol), waveform below it
- Live BPM, beat counter, port status, CSV export, dark clinical theme
- Every beat triggers *both* the animation and the sound
- < 150 ms latency, low CPU, works on modest hardware
- Switching simulation ↔ hardware in under 10 seconds

---

# PART 2 — CURRENT STATE (what is DONE and PROVEN)

## 2.1 Status summary

| Area | State | Evidence |
|---|---|---|
| Backend signal chain | **Done, verified** | `selftest.py` — 20/20 cases |
| Simulation source | **Done, verified** | 1000 Hz exact, 0 splices under normal load |
| Serial source (hardware) | **Done, untested against real board** | Fails gracefully; port scan works |
| R-peak detection | **Done, verified** | ±0.5 BPM across 45–180 BPM, 0–100% noise |
| 3D heart geometry | **Done** | 16k tris, 154 ms build, 0.58 MB |
| Cardiac cycle animation | **Done, verified** | 8/8 model assertions |
| Heart sounds | **Done, verified** | lub/dub scheduling verified |
| Waveform chart | **Done, verified** | fixed-memory ring buffer |
| CSV export | **Done, verified** | exact row count / timestep / R-peak flags |
| Dashboard UI | **Done, verified** | responsive, no overflow, no console errors |
| Server deployment | **NOT STARTED** | see Part 5 |
| Offline / PWA | **NOT STARTED** | see Part 5 |
| Client-side USB sensor | **NOT STARTED** | see Part 5 |
| Latency meter | **NOT STARTED** | see Part 5 |

## 2.2 Verification performed

Two independent test suites, both re-runnable.

**A. Backend signal-chain regression — `backend/selftest.py`**

Runs the *real* filter and detector against synthetic ECG, offline, at many rates and noise levels, and compares recovered BPM to ground truth.

```
 BPM  noise   beats  expect  measured    err     xRT
  60   0.00      18    18.0     60.61   0.61     56x   PASS
  60   1.00      18    18.0     59.94   0.06     55x   PASS
 120   1.00      36    36.0    120.48   0.48     52x   PASS
 150   1.00      45    45.0    149.63   0.37     50x   PASS
 180   0.60      55    54.0    180.72   0.72     49x   PASS
 ... 15 steady-state cases, all PASS

Step-change cases (thresholds learned under one condition, then changed)
  60  0.15->1.00   ratio 1.00  PASS
 120  0.15->1.00   ratio 1.00  PASS
 120  1.00->0.05   ratio 1.00  PASS
  75  0.10->0.80   ratio 1.09  PASS

Waveform splices (lost samples)
  splice unhandled :  45 beats, reports 71.0 BPM
  splice handled   :  45 beats, reports 73.8 BPM   PASS

All 20 cases passed.
```

`xRT ≈ 50` means the backend runs ~50× faster than real time — a few percent of one core.

**B. Browser end-to-end — headless Chrome via puppeteer-core**

**72/72 checks passed.** Covered: boot, WebGL, simulation at 60 and 120 BPM, cardiac-cycle model, noise robustness, audio scheduling, pause/resume, recording, CSV content, serial path, source-swap speed, display controls, mobile responsiveness, memory stability, console health.

Selected results worth keeping:

```
Cardiac cycle model
  peak systole 0.997 at t=0.08s after R-peak
  fully relaxed by t=0.70s
  ejection fraction: volume 1.000 -> 0.382 (~62%)
  atrial kick peaks 0.99 at t=0.90s (next R-peak at 1.00s) -- 100 ms early
  shader uniforms track the model exactly

Audio
  10 sounds in 3 s (5 beats x lub+dub)
  S1->S2 gap 0.090s == age-compensated systolic interval
  S1 (0.32s) longer than S2 (0.26s)

CSV export
  9141 rows vs 9141 recorded (exact)
  timestep 0.0010 s (exact), duration 9.140 s (exact)
  11 R-peaks flagged

Resources
  JS heap 6.2 MB, growth +0.07 MB over 20 s
  1 draw call for the entire heart, 2 geometries, no leaks

Handover speed
  server-side source swap: 57 ms
  end-to-end (incl. UI): 5.6 s under CPU saturation
```

**The test harness lives in the scratchpad, not the repo** (`harness/test.mjs`, `visual.mjs`, `debug.mjs`). It is worth recreating on the server — see Part 6.4.

## 2.3 Real bugs found and fixed during testing

These are documented because they are the non-obvious ones, and because the reasoning applies to whatever gets built next.

1. **Backpressure stalled acquisition.** `await ws.send_json()` was called straight from the acquisition loop. A slow browser applied TCP backpressure to the pump, so ticks stopped firing on schedule and the UI drifted *seconds* into the past while still rendering stale data as though it were live. Fixed with per-client bounded queues (`ClientChannel`): a slow client gets its own frames dropped, acquisition stays at a true 1000 Hz. **Display degrades; timing never lies.** This matters more, not less, over a network.

2. **Vertex colours were being fed as linear.** three.js consumes the `color` attribute as linear data and never converts it. Authoring sRGB hex values and shipping them raw effectively brightens everything by a 2.2 gamma — which is why the heart first rendered as pale pink plastic. Fixed with an explicit `s2l()` conversion.

3. **Icosahedron `detail` is not a power-of-four subdivision level.** It produces `20 × (detail+1)²` triangles. Reading it as `4^detail` gave a ~700-triangle body that looked visibly faceted. Corrected to detail 12/20/28.

4. **Audio init blocked the data stream.** Clicking "Simulate" awaited `armAudio()` before starting acquisition, so on a loaded machine the trace appeared ~10 s late. Audio is now armed without being awaited.

5. **Simulator settings were discarded when no simulator existed.** Moving a slider before the source was created silently dropped the change — indistinguishable from a broken control. Settings now live on the pipeline and are applied whenever the simulator is (re)created; the UI seeds its sliders from server state on connect.

6. **`AudioContext.resume()` never settles when there is no audio device.** It hangs rather than rejecting. Now raced against a 2 s timeout.

7. **Lost samples corrupt the reported rate.** When samples are dropped the waveform is spliced, and the RR interval spanning the seam is measured short — one 0.4 s dropout at 120 BPM turns a 500 ms RR into a 100 ms one. Sources now count discontinuities and the detector forgets `_last_r` across them, so the next beat yields *no* interval rather than a wrong one. **Measurement showed the naive fix (long detection blanking) was a net negative — it discarded real beats to prevent phantoms that were not actually occurring.** The blanking is now only 120 ms.

8. **Mobile horizontal overflow** from the refresh-ports button; fixed with `overflow-x-hidden` and a constrained toast.

## 2.4 Known-good performance numbers

```
Geometry build (Node, no contention):
  low     6 724 tris    3 740 verts    95 ms   0.25 MB
  medium 16 052 tris    8 624 verts   157 ms   0.58 MB
  high   31 140 tris   16 404 verts   277 ms   1.11 MB

Frontend bundle:
  index.js   44 kB  (17 kB gzip)
  three.js  485 kB (121 kB gzip)
  css        19 kB  (4.8 kB gzip)
```

---

# PART 3 — ARCHITECTURE AS BUILT

## 3.1 The swap point

Everything turns on one abstraction. `backend/ecg/source.py` defines `ECGSource`. Two implementations:

- `SimulatedSource` — synthetic AD8232
- `SerialSource` — the real board over USB

**Both emit the identical thing: raw 10-bit ADC counts at 1000 Hz**, in the order `analogRead(A0)` would produce them. Everything downstream — filtering, R-peak detection, the WebSocket protocol, the browser — never learns which one is connected.

```
 SimulatedSource ─┐
                  ├─▶ ECGSource ─▶ ECGFilter ─▶ RPeakDetector ─▶ ClientChannel ─▶ browser
 SerialSource ────┘                (scipy)      (Pan-Tompkins)     (bounded)      3D heart
 (real AD8232)                                                                    waveform
                                                                                  audio
                                                                                  CSV
```

`ECGPipeline.select()` tears one down and starts the other — about 20 lines. By the time hardware arrives, the whole downstream path has been exercised for hours against synthetic signal, so a misbehaving real trace points at physics, not code.

## 3.2 Signal processing

**Filtering** (`ecg/filters.py`) — 0.5 Hz high-pass → 60 Hz + 120 Hz notch → 40 Hz low-pass, cascaded into one SOS chain, run with persistent `zi` state. Statefulness is the critical property: without it every 20 ms chunk boundary produces a step the detector would report as a heartbeat.

**R-peak detection** (`ecg/detector.py`) — streaming Pan-Tompkins: band-pass 5–15 Hz → derivative → square → 150 ms moving-window integrator → adaptive SPKI/NPKI threshold → 200 ms refractory. A fixed voltage threshold is defeated by baseline wander, by a tall T wave, and by an electrode drying out. Detection is then snapped back onto the true R-peak in the filtered signal so the animation and sound fire on the right sample rather than ~100 ms late.

**Simulation** (`ecg/simulator.py`) — PQRST as a sum of Gaussians at clinically realistic offsets, plus heart-rate variability, respiratory modulation, the AD8232's ×1100 gain and 1.5 V offset, Gaussian noise, mains hum, motion artifacts, and 10-bit quantisation.

## 3.3 The 3D heart

No downloaded model. Grown from a **signed distance field** at startup (`frontend/src/heartGeometry.js`): both ventricles, both atria, both auricles, coronary sulcus and interventricular groove carved in, aorta + arch + three head vessels, pulmonary trunk, both venae cavae, and LAD / circumflex / RCA / diagonal resampled onto the myocardial surface.

Three reasons this beat loading a GLB:
1. Zero asset weight, no licensing, works offline
2. One seamless organic surface instead of a visible bag of primitives
3. Because the field is analytic, **ambient occlusion, tissue type and contraction weights bake into vertex attributes** — so the runtime shader is trivial, the whole organ is **one draw call**, and animating costs four float uniforms per frame. No vertex buffer is ever re-uploaded.

**Orientation (important, easy to get backwards):** `+x` = viewer's right = the *patient's left*. That puts the SVC and right atrium on the viewer's left and the apex down to the viewer's right, which is what a true anterior view looks like. It was mirrored in the first version.

**Motion is a real cardiac cycle, not a pulse:**
- Ventricular systole fires on the detected R-peak — radial squeeze, long-axis shortening, and apex/base counter-rotation (the "wringing" motion)
- Atrial systole is scheduled *ahead* of the next R-peak by predicting it from the running RR, because the P wave precedes QRS by ~160 ms
- Blood volume follows ~62% ejection fraction with rapid early filling then diastasis
- Systole scales with √RR, so at high rates it is diastole that vanishes — as in life

## 3.4 Heart sounds

S1 ("lub") = mitral/tricuspid closure, lands on the R-peak. S2 ("dub") = aortic/pulmonic closure at the *end* of ejection, so it trails S1 by the systolic interval, not a fixed gap. Both are pre-rendered once into `AudioBuffer`s via `OfflineAudioContext`; a beat costs two buffer sources and nothing else. Pitch uses `playbackRate`. The app subtracts how late a batch arrived so the lub-dub interval stays true under load.

## 3.5 Files

```
backend/
  config.py             ← EVERY hardware setting lives here
  main.py               FastAPI: WebSocket stream + REST control + ClientChannel
  run_server.py         launcher
  selftest.py           offline signal-chain regression test  ← RUN THIS FIRST
  smoketest.py          live test against a running server    ← RUN THIS SECOND
  ecg/
    source.py           the ECGSource interface (THE SWAP POINT)
    simulator.py        synthetic AD8232
    serial_source.py    real AD8232 over USB serial
    filters.py          streaming notch + band-pass
    detector.py         streaming Pan-Tompkins
frontend/
  index.html            dashboard
  vite.config.js        port 3000, proxies /api and /ws to :8000
  bench-heart.mjs       geometry build benchmark
  src/
    main.js             app controller + render loop + debug hook (window.__ecg)
    heartGeometry.js    SDF → anatomical mesh
    heart.js            rendering + cardiac cycle animation
    chart.js            scrolling waveform (Canvas2D, fixed memory)
    audio.js            pre-rendered lub-dub
    recorder.js         ring buffer + CSV export
    net.js              WebSocket + REST client
arduino/ecg_ad8232/     the sketch (1000 Hz, 115200 baud, leads-off detection)
instructions.txt        hardware swap guide (wiring, electrodes, troubleshooting)
README.md               user-facing docs
HANDOVER.md             this file
start.ps1 / start.bat   Windows launchers (see Part 6.3 for Linux)
```

## 3.6 API

| Endpoint | Purpose |
|---|---|
| `WS /ws/ecg` | stream: `hello`, `batch`, `status`; accepts `{type:"ping"}` |
| `GET /api/status` | current state incl. `dropped_frames`, `splices` |
| `GET /api/config` | constants + stored simulator settings |
| `GET /api/ports` | COM/tty ports, likely Arduino first |
| `POST /api/source` | `{mode:"simulate"\|"serial"\|"off", port?}` — **the swap** |
| `POST /api/simulation` | `{bpm?, noise?, artifacts?}` |
| `POST /api/monitor` | `{running: bool}` |
| `POST /api/reset` | zero the beat counter |

`batch` payload: `{seq, i0, t, raw[] (ADC ints), filt[] (mV), beats[{n,i,bpm,bpm_avg,rr_ms,amp,age_ms}], bpm, beats_total, leads_off}`

---

# PART 4 — OPEN ITEMS ON THE EXISTING BUILD

1. **The last visual tweak is unverified.** Source contains an AO-smoothing change (`bakeAO` sample distances widened, occlusion strength 2.2→1.35, floor 0.18→0.42), a shallower coronary sulcus carve, and reduced fat-pad weighting — intended to remove a sawtooth "comb" artifact along the edge of the epicardial fat band that follows mesh topology. **This was edited but never rebuilt or screenshotted.** First job on the server: rebuild, capture, confirm the comb is gone.

2. **Heart aesthetics need another iteration.** As last seen it reads as recognisably cardiac — conical ventricular mass, correct chamber layout, aortic arch with head vessels, coronaries in their grooves — but not yet photoreal. Specific remaining weaknesses:
   - Fat band still slightly too prominent / stripe-like
   - Great vessels still read pale despite darkening (tone mapping + env map lift them)
   - Atria are largely hidden behind the AV-groove fat
   - No surface veining or fine detail on the myocardium
   - Consider moving the fat/muscle blend into the **fragment shader** (interpolate the raw distance as an attribute, apply smoothstep per pixel) instead of baking the blended colour per vertex. That removes topology-following artifacts entirely.

3. **`SerialSource` has never seen a real Arduino.** The parser, auto-detection, leads-off handling and error paths are written and fail gracefully, but only real hardware proves them. On Linux the port will be `/dev/ttyUSB0` or `/dev/ttyACM0`, not `COMx`.

   **Confirmed problem:** the server enumerates **32 ports** (`/dev/ttyS0`–`ttyS31`, kernel placeholders that are not real devices). `autodetect_port()` currently falls back to "if there is exactly one port, use it" and otherwise matches description hints — neither is safe here. Before hardware arrives, tighten `autodetect_port()` to require `/dev/ttyUSB*` or `/dev/ttyACM*` (or a USB VID/PID) on Linux, and never offer bare `ttyS*` in the UI dropdown.

4. **`start.ps1` is Windows-only.** Needs a Linux equivalent (Part 6.3).

5. **No automated CI.** Both suites are run by hand.

---

# PART 5 — THE NEW ARCHITECTURE (requested, NOT yet built)

**STATUS (2026-07-29): all of this is now built.** It is kept as written
because the reasoning behind each decision is still the reasoning that governs
the code. See Part 0 for what shipped and `DEPLOYMENT.md` for how it runs.

## 5.1 Target model

- The whole system runs **permanently on the Ubuntu server** and never stops
- Users reach it at `http://<server-ip>:<port>` (or better, HTTPS — see 5.4)
- With no sensor, the server-side simulation drives everything (works today)
- With an AD8232 plugged into the **user's own PC by USB**, that data must reach the animation with no perceptible latency
- The site must be **installable as an app** and keep working **offline** after first load
- The UI must show **online/offline state** and a **latency meter**

## 5.2 Getting sensor data from the client's USB to the server

The sensor is on the *client's* machine; the code is on the *server*. Three options:

### Option A — Web Serial API in the browser (RECOMMENDED)

The browser itself opens the USB serial port (`navigator.serial.requestPort()`), reads the AD8232 stream, and forwards samples over the existing WebSocket to the server.

- **Pros:** no software to install on the client beyond the browser; reuses the existing WebSocket; the user explicitly grants port access, which is a clean permission story
- **Cons:** Chrome/Edge/Opera only (no Firefox, no Safari); **requires a secure context** (HTTPS or localhost)
- **Work:** a `WebSerialSource` in the frontend that parses the same line protocol the Python `SerialSource` parses, plus a new inbound WebSocket message type (e.g. `{type:"samples", data:[...]}`) and a corresponding server-side `ClientFedSource` implementing `ECGSource`.

**This is the natural fit** — it slots into the existing `ECGSource` abstraction as a third implementation, and the swap machinery already exists.

### Option B — Small local agent on the client PC

A tiny Python/Node process on the user's machine reads the serial port and pushes to the server over WebSocket.

- **Pros:** works in any browser; can run headless; full pyserial capability
- **Cons:** something to install, update and support per machine

### Option C — Process entirely in the browser

Browser reads serial *and* runs filtering + detection locally; the server only serves static files.

- **Pros:** lowest possible latency; works fully offline
- **Cons:** requires porting the DSP to JavaScript (see 5.3) — but note that work is needed anyway for offline mode

**Recommendation: build Option A first** (smallest step, reuses everything), then let Option C fall out of the offline work, and use Option A's server round-trip only when the client cannot process locally.

## 5.3 Offline operation — the hidden cost

**Be aware: this is the largest item in the new scope.**

The requirement is that after one online load, the site keeps working — including the simulation — with no internet. But **the simulator, the filters and the R-peak detector are all Python running on the server.** A service worker can cache HTML/JS/CSS; it cannot cache a Python process.

So genuine offline operation requires the DSP to exist **in the browser**. Options:

| Approach | Effort | Notes |
|---|---|---|
| **Port to JavaScript** | Medium–high | Rewrite simulator, IIR filter chain and Pan-Tompkins in JS. Feasible — they are a few hundred lines each and all the maths is already worked out and *tested*. Best long-term answer: also enables Option C and removes all latency. |
| **Pyodide (CPython in WASM)** | Medium | Reuses the Python verbatim, but ~10 MB download and scipy in Pyodide is heavy. Contradicts "low memory". |
| **Port to WASM (Rust/C)** | High | Fastest, most work. |
| **Offline = playback only** | Low | Cache a recorded buffer and replay it. Honest, cheap, but not really "the simulation". |

**Recommendation: port the DSP to JavaScript.** The Python becomes the reference implementation and `selftest.py` becomes the oracle — port, then check the JS produces the same BPM on the same input. That is a strong, cheap correctness test.

Then: server-side Python remains for headless/recording use, browser-side JS covers offline and zero-latency local processing.

## 5.4 HTTPS is required (blocking constraint)

Both headline features need a **secure context**:

- **Web Serial API** — blocked on plain `http://<ip>:<port>`
- **Service workers / PWA install** — blocked on plain HTTP

`http://localhost` is exempt, but `http://<server-ip>:<port>` is **not**.

Options, in order of preference:
1. A domain name + **Let's Encrypt** via nginx/Caddy — proper fix, free
2. **Caddy** with an automatic certificate — simplest to operate
3. A self-signed certificate — works but every user must click through a warning; acceptable for a small trusted group
4. An SSH tunnel so each user reaches it as `localhost` — secure-context exempt, but awkward

**Decide this early — it gates 5.2 Option A and all of 5.5.**

## 5.5 PWA / installable app

- `manifest.json` (name, icons, `display: "standalone"`, theme colour)
- Service worker caching the app shell (HTML/JS/CSS) with a cache-first strategy and a versioned cache name
- three.js is 485 kB — cache it explicitly
- An update path, or users get stuck on a stale version forever

## 5.6 Connection status and latency meter

- **Online/offline indicator:** combine `navigator.onLine` with actual WebSocket state (`navigator.onLine` lies — it only reports link presence). On disconnect, show a clear banner: *"No connection — live sensor readings paused. Showing local simulation."*
- **Latency meter, top bar:** the protocol already has `{type:"ping"}` → `{type:"pong", t}`. Measure round-trip every 2–5 s, display as a small colour-coded readout (green < 80 ms, amber < 200 ms, red beyond). Also surface `age_ms` from the batch payload, which already reports how long ago each R-peak actually occurred — that is the honest end-to-end animation latency.
- The existing `dropped_frames` and `splices` counters in `/api/status` should be surfaced too; they are exactly the "is what I'm seeing real?" signal.

## 5.7 Always-on service

Run the backend under **systemd** so it survives reboots and crashes. Serve the built frontend either from nginx/Caddy or directly from FastAPI (it already mounts `frontend/dist` at `/` when that directory exists — so a single process can serve everything).

## 5.8 Suggested build order

1. Get it running on the server, reachable on a port, simulation working *(unblocks everything)*
2. systemd unit + firewall
3. Decide and implement HTTPS *(gates 4 and 5)*
4. Web Serial client-side source (Option A)
5. PWA manifest + service worker
6. Latency meter + connection status
7. Port DSP to JavaScript for true offline + zero-latency local processing
8. Resume heart aesthetic polish

---

# PART 6 — RUNNING IT ON THE SERVER

## 6.0 Migration status — DONE AND VERIFIED

Migrated to `tofunmi:/root/ecg-heart-visualizer` on 2026-07-27. All 33 source
files transferred; `.venv/`, `node_modules/` and `dist/` were deliberately
excluded (platform-specific) and rebuilt on the server.

**Server:** Ubuntu 6.8.0, 2 vCPU / 4 GB, 38 GB free, Python 3.12.3, Node v18.19.1.

Verified in place:

```
backend/selftest.py     20/20 cases PASS   (~50x real time)
frontend npm install    8 s     (was ~4 min on the laptop)
frontend npm run build  8.6 s   (was 20-56 s)
geometry benchmark      low 126 ms / medium 192 ms / high 300 ms
backend/smoketest.py    all checks PASS
  - source swap to simulation: 16 ms  (was 57 ms)
  - 15 s continuous acquisition, 0 splices, 0 dropped frames, no errors
  - bad serial port fails gracefully
FastAPI serves the built frontend at /   (HTTP 200, 12 753 bytes)
```

The server is roughly **20x faster** than the laptop for the install/build loop,
which was the reason for the move.

**Nothing is currently running.** Start it with:

```bash
cd /root/ecg-heart-visualizer/backend
.venv/bin/python run_server.py            # foreground
# or
nohup .venv/bin/python run_server.py > /tmp/ecg.log 2>&1 &
```

It binds `127.0.0.1:8000` only — see 6.3 for making it reachable.

**New file added during migration:** `backend/smoketest.py` — a live smoke test
against a *running* server (stdlib only). `selftest.py` proves the signal chain
in isolation; `smoketest.py` proves the assembled service. Run both.

**Finding:** the server reports **32 serial ports** (`/dev/ttyS0`–`ttyS31`,
kernel placeholders). Serial auto-detection will have to be stricter here than
on Windows — match on `/dev/ttyUSB*` and `/dev/ttyACM*` and on the USB
descriptor, and ignore bare `ttyS*`. See Part 4.3.

## 6.1 Prerequisites

```bash
sudo apt update
sudo apt install -y python3.12 python3.12-venv python3-pip
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

## 6.2 First run

```bash
cd ~/ecg-heart-visualizer

# Backend
cd backend
python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
.venv/bin/python selftest.py          # MUST print "All 20 cases passed."
.venv/bin/python run_server.py &

# Frontend
cd ../frontend
npm install
npm run build                          # FastAPI then serves it from :8000
# or, for development:
npm run dev -- --host                  # exposes :3000 on the network
```

Note `.venv/` and `node_modules/` are **not** migrated — they are platform-specific and must be recreated as above.

## 6.3 Things that must change for Linux / server use

1. **Bind address.** `backend/config.py` has `HOST = "127.0.0.1"`. For network access set `HOST = "0.0.0.0"` (and firewall the port).
2. **Vite dev host.** `npm run dev` binds locally; use `--host`, or set `server.host: true` in `vite.config.js`.
3. **CORS.** `config.CORS_ORIGINS` lists only localhost. Add the server origin.
4. **Serial device names.** `/dev/ttyUSB0` / `/dev/ttyACM0`, not `COMx`. The user must be in the `dialout` group.
5. **`start.ps1` is PowerShell.** Write a `start.sh` equivalent.
6. **Mains frequency.** `MAINS_HZ = 60.0` — set to `50.0` if deploying where mains is 50 Hz. Nigeria is **50 Hz**, so this very likely needs changing.

## 6.4 Recreating the browser test harness

Not in the repo. To rebuild it on the server:

```bash
mkdir -p ~/ecg-harness && cd ~/ecg-harness
npm init -y && npm pkg set type=module
npm install puppeteer-core
sudo apt install -y chromium-browser    # or use puppeteer's own download
```

The suite drives the app through `window.__ecg` (exposed by `main.js`) and asserts on internals rather than scraping formatted DOM text. **Lessons learned the hard way, worth preserving:**

- Headless Chrome has **no compositor**, so `requestAnimationFrame` runs at ~1 fps. Never assert on live animation state; drive the cardiac model directly instead (set `heart.lastBeatAt`, call `heart.update()`, read the envelopes back).
- For the same reason, `page.waitForFunction` defaults to rAF polling and effectively never fires. Use `{polling: 500}` or poll from Node.
- Software WebGL (SwiftShader) saturates the machine and starves the Python process. Set `heart.enabled = false` for functional tests; only enable rendering for screenshots.
- Always launch with `--disable-background-timer-throttling --disable-renderer-backgrounding`.
- A crashed run leaves Chrome alive, still holding a WebSocket and burning CPU — `taskkill`/`pkill chrome` at harness start.
- `AudioContext.resume()` never settles without an audio device; race everything audio-related against a timeout.
- The server *is* a real GPU-less machine, so these constraints apply to the server too — but the server is much faster than the laptop was.

---

# PART 7 — CRITICAL THINGS NOT TO BREAK

1. **`ECGSource` is the swap point.** Any new data path (Web Serial, replay, a second board) should implement it rather than special-casing.
2. **Never `await` a socket send from the acquisition loop.** Use `ClientChannel`. Display may degrade; timing must not.
3. **Filters must stay stateful across chunks.** Dropping `zi` silently reintroduces phantom beats at every chunk boundary.
4. **Vertex colours are linear.** Anything authored as sRGB hex must go through `s2l()`.
5. **A beat event must reach the heart and the audio before any DOM work.** `onBeat()` in `main.js` is ordered deliberately — layout/style recalculation must never sit between the R-peak and what the user perceives.
6. **`selftest.py` must pass before trusting any reading.** It is the oracle. If it fails, stop and fix that first.
7. **Not a medical device.** Keep the disclaimers. Never connect any part of this to mains power.

---

# PART 8 — IMMEDIATE NEXT STEPS

Migration and rebuild are already done and verified (Part 6.0). Pick up here:

1. **Open the project in VS Code Remote-SSH** at `tofunmi:/root/ecg-heart-visualizer`
2. **Make it reachable.** In `backend/config.py` set `HOST = "0.0.0.0"`, set `MAINS_HZ = 50.0` (Nigeria is 50 Hz mains — leaving it at 60 leaves visible hum on the filtered trace), and add `http://<server-ip>:<port>` to `CORS_ORIGINS`. Then open the port in the firewall.
3. **Add a systemd unit** so the backend survives reboots and never stops. FastAPI already serves `frontend/dist` at `/`, so one process can serve everything on one port.
4. **Verify visually.** Rebuild the frontend and screenshot the heart — confirm the AO "comb" artifact described in Part 4.1 is gone. This is the one change in the repo that was written but never visually confirmed.
5. **Tighten Linux serial detection** (Part 4.3) — the 32 phantom `ttyS*` ports will otherwise confuse both auto-detect and the UI.
6. **Decide the HTTPS strategy** (Part 5.4). This is the gate: without a secure context there is no Web Serial and no installable PWA. Caddy with an automatic certificate is the least-effort route.
7. Then work Part 5.8 in order — Web Serial first, then PWA, then the latency meter, then the JavaScript DSP port for true offline.

**Before trusting any reading, always:**
```bash
cd /root/ecg-heart-visualizer/backend
.venv/bin/python selftest.py     # must print "All 20 cases passed."
.venv/bin/python run_server.py & 
.venv/bin/python smoketest.py    # must print "All checks passed."
```
