# Real-Time ECG Heart Visualizer

A single-lead ECG monitor whose centrepiece is an **anatomically accurate,
procedurally generated 3D heart** that contracts on every detected R-peak, in
sync with synthesised heart sounds, above a scrolling ECG waveform.

**Live:** <https://143-198-27-18.nip.io> · **Local:** clone and run, see
[DEPLOYMENT.md](DEPLOYMENT.md)

---

## What it does

- **Runs anywhere the browser does.** The whole signal chain — simulator,
  filters, Pan-Tompkins detector — exists in both Python and JavaScript, and
  `backend/verify_dsp.py` proves the two are bit-identical. So the app keeps
  working with the network unplugged, and a USB sensor can be processed
  locally with no round trip.
- **Reads a real AD8232 over USB**, from the user's own machine, via Web
  Serial — nothing to install beyond the browser.
- **Installs as an app** and works offline after the first load.
- **Tells you the truth about latency.** A round-trip meter and the true age of
  the newest beat, both in the header, because you are watching an animation
  driven by another machine.
- **Stays up to date.** A new deploy prompts every open tab and installed app
  to reload; a local clone is told when it falls behind the repository.

---

## Access

| | URL | Notes |
|---|---|---|
| Hosted | `https://143-198-27-18.nip.io` | always on, always current |
| Installed app | same, then "Install" | works offline after first load |
| Local clone | `http://localhost:8000` | full features; localhost is a secure context |

---

## Why it's built this way

The whole architecture turns on one idea: **the simulator and the real hardware are two implementations of the same interface**, and both emit the identical thing — raw 10-bit ADC counts at 1000 Hz, in the order `analogRead(A0)` would have produced them.

```
                    ┌──────────────────────┐
   SimulatedSource ─┤                      │
                    │   ECGSource          │──▶ filter ──▶ R-peak ──▶ WebSocket ──▶ browser
   SerialSource ────┤   (source.py)        │    (scipy)   (Pan-        (20 ms)      3D heart
   (real AD8232)    └──────────────────────┘               Tompkins)                waveform
                                                                                    audio
                                                                                    CSV
```

Everything to the right of `ECGSource` is shared. By the time hardware is plugged in, that entire path has already been exercised for hours against synthetic signal — so if the real trace misbehaves, the fault is physical, not in the code.

---

## Quick start

**Requirements:** Windows 10/11, Python 3.12+, Node.js 18+.

```powershell
.\start.ps1
```

That sets up both halves on first run and opens <http://localhost:3000>.

<details>
<summary>Manual setup</summary>

```powershell
# Backend  (terminal 1)
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python run_server.py            # -> http://127.0.0.1:8000

# Frontend (terminal 2)
cd frontend
npm install
npm run dev                     # -> http://localhost:3000
```

</details>

Then: click **Simulate** → the trace scrolls, the heart beats, the sound plays.

---

## Using it

| Control | What it does |
|---|---|
| **Simulate** | Synthetic AD8232 signal — no hardware needed |
| **Arduino** | Scan COM ports, then connect to the real board |
| **Start / Pause** | Freeze and resume the stream (`Space`) |
| **Heart rate** | 60–120 BPM, applied at the next beat boundary |
| **Noise** | 0–100%, adds sensor noise, mains hum and motion artifacts |
| **Volume / Pitch** | Heart-sound level and playback rate (`M` toggles sound) |
| **Record → Export CSV** | 5-minute rolling capture, exported with full metadata (`R`) |
| **2s / 4s / 6s** | Waveform time window |
| **3D quality** | Low / Medium / High mesh detail |

Drag the heart to rotate it; double-click to recentre.

---

## Connecting the real AD8232

Full walkthrough with wiring, electrode placement and troubleshooting: **[`instructions.txt`](instructions.txt)**.

The short version:

1. Wire it up — **AD8232 `3.3V` → Uno `3.3V`, never 5V**; `OUTPUT`→`A0`, `LO+`→`D10`, `LO-`→`D11`
2. Upload [`arduino/ecg_ad8232/ecg_ad8232.ino`](arduino/ecg_ad8232/ecg_ad8232.ino)
3. **Close the Arduino Serial Monitor** — Windows gives a COM port to one process at a time
4. Click **Arduino** in the app, pick the port, click **Arduino** again

Every hardware setting lives in one file: [`backend/config.py`](backend/config.py). You'd only touch it for a 50 Hz mains region (`MAINS_HZ = 50.0`) or an external analog reference.

---

## How the signal processing works

**Filtering** ([`ecg/filters.py`](backend/ecg/filters.py)) — 0.5 Hz high-pass (baseline wander) → 60 Hz + 120 Hz notch (mains hum) → 40 Hz low-pass (EMG). Cascaded into one SOS chain and run with persistent `zi` state, so filtering a 20 ms chunk gives bit-identical output to filtering the whole recording offline. Without that state, every chunk boundary would produce a step the R-peak detector would happily report as a heartbeat.

**R-peak detection** ([`ecg/detector.py`](backend/ecg/detector.py)) — streaming Pan-Tompkins: 5–15 Hz band-pass → derivative → square → 150 ms moving-window integrator → adaptive SPKI/NPKI threshold → 200 ms refractory period. A fixed voltage threshold is defeated by baseline wander, by a tall T wave, and by an electrode drying out; this is the algorithm real monitors use. The detection is then snapped back onto the true R-peak in the filtered signal, so the animation and the sound fire on the right sample rather than ~100 ms late.

**Simulation** ([`ecg/simulator.py`](backend/ecg/simulator.py)) — PQRST synthesised as a sum of Gaussians at clinically realistic offsets, with heart-rate variability, respiratory modulation, the AD8232's ×1100 gain and 1.5 V offset, then Gaussian noise, mains hum, motion artifacts, and finally 10-bit quantisation. The output is a plausible stand-in for what the real board sends, not just a pretty line.

Verify the whole chain at any time:

```powershell
cd backend
.\.venv\Scripts\python.exe selftest.py
```

It checks recovered BPM against ground truth across ten rates and noise levels — including 100% noise — and reports how much faster than real time it runs.

---

## The 3D heart

No downloaded model. The organ is *grown* from a signed distance field at startup ([`heartGeometry.js`](frontend/src/heartGeometry.js)): both ventricles, both atria, both auricles, the coronary sulcus and interventricular groove carved in, the aorta and its arch branches, the pulmonary trunk, both venae cavae, and the LAD / circumflex / RCA resampled onto the myocardial surface.

That choice pays for itself three ways: zero asset weight and no licensing; one seamless organic surface instead of a visible bag of primitives; and — because the field is analytic — ambient occlusion, tissue type and contraction weights can be **baked into vertex attributes**. So the runtime shader is trivial, the whole heart is **one draw call**, and animation costs four float uniforms per frame. No vertex buffer is ever re-uploaded.

The motion is a real cardiac cycle, not a generic pulse:

- **Ventricular systole** fires on the detected R-peak — radial squeeze, long-axis shortening, and the apex/base counter-rotation (the "wringing" motion) that separates a beating heart from a squeezing ball
- **Atrial systole** is scheduled *ahead* of the next R-peak by predicting it from the running RR interval, because the P wave precedes QRS by ~160 ms in the chest
- **Blood volume** follows a ~62% ejection fraction, with rapid early filling then diastasis
- Systole scales with √RR, so at 160 BPM it's diastole that vanishes — as it does in life

Measure the mesh cost yourself: `cd frontend && node bench-heart.mjs`

---

## Heart sounds

S1 ("lub") is the mitral and tricuspid valves closing as the ventricles start to squeeze — it lands on the R-peak. S2 ("dub") is the aortic and pulmonic valves closing at the *end* of ejection, so it trails S1 by the systolic interval, not by a fixed gap. Get that wrong and it sounds like a metronome.

Both are pre-rendered once into `AudioBuffer`s via an `OfflineAudioContext`, so a beat costs two buffer sources and nothing else — no filter graph is rebuilt per beat. Pitch uses `playbackRate` rather than re-synthesis. The app also compensates for how late a batch arrived, so the lub-dub interval stays true even under load.

---

## Performance & memory

Deliberate choices for a modest laptop:

- **Backend** runs ~50× faster than real time (see `selftest.py`) — a few percent of one core
- **Per-client bounded queues.** A browser that falls behind gets its own frames dropped; the acquisition loop keeps a true 1000 Hz. Without this, TCP backpressure from one slow tab stalls the pump and the UI silently drifts seconds into the past while still looking live — worse than useless on a monitor
- **One draw call** for the entire heart, no shadow maps, pixel ratio capped at 1.75
- **Fixed-size typed-array ring buffers** everywhere. The waveform allocates once; recording is opt-in and costs ~2 MB whether you record for one minute or an hour
- Render work is skipped entirely when the tab is hidden

Measured in-browser: ~9 MB JS heap, stable over a long session, 1 draw call, no geometry leaks.

---

## Project layout

```
backend/
  config.py             ← every hardware setting lives here
  main.py               FastAPI: WebSocket stream + REST control
  run_server.py         launcher
  selftest.py           offline signal-chain regression test
  ecg/
    source.py           the ECGSource interface (the swap point)
    simulator.py        synthetic AD8232
    serial_source.py    real AD8232 over USB serial
    filters.py          streaming notch + band-pass
    detector.py         streaming Pan-Tompkins R-peak detection
frontend/
  index.html            dashboard
  bench-heart.mjs       geometry build benchmark
  src/
    main.js             app controller + render loop
    heartGeometry.js    SDF → anatomical mesh
    heart.js            rendering + cardiac cycle animation
    chart.js            scrolling waveform (Canvas2D)
    audio.js            pre-rendered lub-dub
    recorder.js         ring buffer + CSV export
    net.js              WebSocket + REST client
arduino/ecg_ad8232/     the sketch
instructions.txt        hardware swap guide
```

## API

| Endpoint | Purpose |
|---|---|
| `WS /ws/ecg` | stream: `hello`, `batch`, `status` |
| `GET /api/status` | current state |
| `GET /api/ports` | COM ports, likely Arduino first |
| `POST /api/source` | `{mode: "simulate" \| "serial" \| "off", port?}` — **the swap** |
| `POST /api/simulation` | `{bpm?, noise?, artifacts?}` |
| `POST /api/monitor` | `{running: bool}` |
| `POST /api/reset` | zero the beat counter |

---

## Safety

This is a development and teaching tool. Do not use it to make any decision about anyone's health. Never connect any part of it to mains power, and only ever power the AD8232 from a battery-powered or properly isolated USB source.
