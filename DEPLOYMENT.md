# Deployment

How this system runs, how to reach it, and how the two ways of running it stay
in sync.

---

## Access paths

All must always show the same build.

| | URL | Secure context? | Mode toggle |
|---|---|---|---|
| Hosted, HTTPS | `https://ecg.192-99-245-44.nip.io` | **yes** | locked Online |
| Hosted, plain HTTP | `http://192.99.245.44:8000` | no | redirects to the HTTPS one |
| Installed app | installed from the HTTPS URL | yes | **Online / Offline** |
| Local clone | `http://localhost:8000` | yes (localhost is exempt) | **Online / Offline** |

Only a secure context can install the app or read a USB sensor. The bare-IP
address 308s to the HTTPS one, but only once a certificate actually exists for
it: redirecting to a certificate that was never issued would strand every
visitor, so `_has_certificate()` gates the redirect.

| | Web / installed app | Local clone |
|---|---|---|
| URL | the HTTPS host above | `http://localhost:8000` |
| Updates | automatic — new deploy, banner offers reload | banner offers `git pull` + rebuild |
| Runs | always, under systemd | when you start it |
| USB sensor | Web Serial, in the user's browser | Web Serial, or the server-side `SerialSource` |

---

## Architecture as deployed

```
                    ┌──────────────────── the server (192.99.245.44) ────────┐
                    │                                                        │
   browser ──443──▶ │  nginx ──▶ FastAPI :8000 ──▶ ECGSource ──▶ filter ──▶  │
     │              │  (TLS)     (systemd)         │             detector    │
     │              │                              │                         │
     │              └──────────────────────────────┼─────────────────────────┘
     │                                             │
     │  AD8232 on the user's own USB               │  SimulatedSource
     └──▶ Web Serial ──▶ local JS DSP ──▶ animation│  SerialSource
                      └─▶ forwarded to ────────────┘  ClientFedSource
                          the server
```

The browser carries a full copy of the signal chain (`frontend/src/dsp/`).
`backend/verify_dsp.py` asserts it is bit-identical to the Python, so offline
and online can never disagree about a heart rate. Both are generated from
`config.SAMPLE_RATE` by `export_dsp.py`, so changing the rate means rerunning
it and rebuilding, or the browser keeps filtering for the old one.

---

## Why HTTPS is mandatory

Two headline features refuse to run outside a **secure context**:

- **Web Serial** — reading the AD8232 from the user's own USB port
- **Service workers** — offline operation and installing the app

`http://localhost` is exempt. A bare IP address is **not**. There is no way to
ship those features over plain HTTP on an IP.

We use **nip.io**: `ecg.192-99-245-44.nip.io` resolves to `192.99.245.44`,
giving a real hostname that Let's Encrypt will issue a certificate for, with no
domain purchase.

### TLS terminates at nginx, not Caddy

The original deployment used Caddy on its own host. This host already runs
nginx on 443 for an unrelated project, so the ECG app is a **name-based virtual
host beside it** rather than a second TLS server competing for the port.

`deploy/nginx-ecg.conf` is the vhost as deployed, installed at
`/etc/nginx/sites-enabled/zz-ecg`. Two details in it are not cosmetic:

- **The filename sorts last on purpose.** `sites-enabled/*` is included in glob
  order and the *first* block on a port becomes nginx's implicit
  `default_server` for it. A name that sorted earlier would silently take over
  every unmatched HTTPS request to the machine.
- **`/ws/` sets the upgrade headers and turns buffering off.** A buffered
  WebSocket batches the trace into bursts, which the app's own latency meter
  then reports as lag.
- **The `Cache-Control` rules are ported from the old `deploy/Caddyfile`.**
  They were lost in the move off Caddy, and their absence is not cosmetic.
  `/sw.js` and `/version.json` are `no-store`, because a browser that pins
  itself to an old service worker is the one PWA failure that cannot be fixed
  remotely. `index.html` is `no-cache`: it is the only file the app ships that
  is not content-hashed, and `vite build` empties `dist/`, so a stale index
  names asset files that are gone from the server and the page renders
  partly. `/assets/*` is `immutable` for a year, which is safe precisely
  because those names are content-addressed.

The certificate is issued by acme.sh over the HTTP-01 webroot at
`/var/www/acme`, installed to `/etc/ssl/ecg/`, and renewed by the existing
acme.sh cron, which reloads nginx on renewal.

```bash
curl -s https://ecg.192-99-245-44.nip.io/api/access   # what the app advertises
openssl x509 -in /etc/ssl/ecg/fullchain.pem -noout -dates
sudo nginx -t && sudo systemctl reload nginx          # never restart: reload
```

**Caveat:** the hostname encodes the server's IP. If the VPS IP ever changes,
the hostname changes with it, and an installed app's identity *is* its origin —
existing installs would point at a dead URL with orphaned cached data. A real
domain removes that coupling; it is a two-line change (`PUBLIC_HOST` in
`backend/config.py`, `server_name` in the vhost) plus a reissue.

---

## What a guest PC needs

The app is meant to be installed by someone who did not build it, so the
dependency list matters.

| | Required | Notes |
|---|---|---|
| Browser | **Chrome or Edge, desktop** | Web Serial only. Firefox and Safari do not implement it, and there is no iOS support at all. |
| USB driver | usually none | Genuine Arduino (ATmega16U2) and FTDI boards auto-provision on Windows. **CH340/CH341 clones need a manual driver install** and will otherwise not enumerate a COM port. The app raises this itself on first launch: see below. |
| Network | only for the first load | Once installed, a cold launch with no network at all boots, streams and detects locally. Verified, not assumed: `harness/offlineboot.mjs`. |
| Python | **no** | Only ever a diagnostic tool on the bench. Nothing user-facing needs it. |

The service worker deliberately never caches `/api`, so nothing at boot may
depend on a successful API call. `boot()` calls `api.config()` inside a
`try/catch` and falls back to the local engine, and the offline suite asserts
that path rather than trusting it.

---

## Online and offline modes

| | ONLINE | OFFLINE |
|---|---|---|
| Where the DSP runs | server | this browser |
| Needs a connection | yes | no |
| USB sensor | read locally, forwarded to the server | read and processed locally |

Who may choose:

- **A browser tab on the hosted site** is locked to Online, and says why. A tab
  has installed nothing, so offering "offline" would imply a persistence
  guarantee it does not have.
- **An installed app, or a local clone**, gets a real toggle, persisted in
  `localStorage`.

The preference is not the same as what is running. An installed app set to
Online still drops to local processing the instant the connection goes — the
trace must never stop — and returns by itself. A deliberately chosen Offline is
never overridden by a reconnect.

### Connectivity indicator

Two signals, for different reasons. The browser's `online`/`offline` events
fire *immediately*, which is what makes the indicator react without a refresh.
The WebSocket's own liveness keeps it *honest*, because `navigator.onLine` only
reports that an interface exists and returns true on a captive portal that
drops every packet.

Liveness comes from the ping/pong: three unanswered pings (~9 s) condemns the
socket and forces a rebuild. This matters because a WebSocket stays in
`readyState OPEN` long after its network has gone — TCP only finds out when a
send fails — so anything that trusts `readyState` will wait forever.

---

## Services

Both are systemd units, enabled at boot, restarting on any failure.

```bash
systemctl status ecg-backend     # FastAPI + acquisition at config.SAMPLE_RATE
systemctl status nginx           # TLS termination

journalctl -u ecg-backend -f
journalctl -u nginx -f

sudo systemctl restart ecg-backend
sudo systemctl reload nginx      # reload, so live connections are not dropped
```

The backend unit lives in `deploy/` and is copied to `/etc/systemd/system/`.
nginx is shared with another project on this host: only ever add a vhost, and
never restart it when a reload will do.

The backend comes up **idle**, with no source selected, until the UI picks one.
That is deliberate, not a fault: the source is a user choice.

### After changing backend code

```bash
sudo systemctl restart ecg-backend
```

### After changing frontend code

```bash
cd frontend && npm run build
```

No restart needed — FastAPI serves `frontend/dist` from disk. The new build id
propagates to every open tab within 60 s, which offers the user a reload.

### After changing a filter constant in `config.py`

```bash
cd backend && .venv/bin/python export_dsp.py   # regenerate coeffs.js
cd ../frontend && npm run build
```

CI fails if you forget: the browser DSP would silently drift from the server's.

---

## Verifying a deployment

Run in this order. The first is the oracle — if it fails, nothing else matters.

```bash
cd backend
.venv/bin/python selftest.py      # 20/20 — the signal chain itself
.venv/bin/python verify_dsp.py    # browser DSP == server DSP, bit-exact
.venv/bin/python smoketest.py     # the assembled live service

cd ../harness
npm install                       # first time only
node test.mjs                     # 80 browser checks incl. offline + PWA
node extra.mjs                    # 57 checks: routes, CSV export, layout
node offlineboot.mjs              # 16 checks: no network, and a hanging one
node repair.mjs                   # 6 checks: a broken install healing itself
node driver.mjs                   # 10 checks: the USB driver setup flow
```

Point any of them at the deployment instead of localhost with
`ECG_URL=https://ecg.192-99-245-44.nip.io`. `test.mjs` also takes
`ECG_PUBLIC_URL` for the "hosted origin locks the mode toggle" assertion.

### The USB driver, and what the app can honestly do about it

A CH340 board with no driver is indistinguishable from a broken one: the board
powers up, its LED is on, and the browser's port picker is simply empty. So the
app raises it before the user hits it. On the first launch of an **installed**
app with no port yet granted, it offers a setup panel with the correct download
for the user's platform, and afterwards confirms by name what it is talking to
("Detected CH340 (WCH)"). It is reachable any time from the Signal Source panel.

Three limits are worth stating plainly, because they are not things better code
would fix:

- **It cannot install the driver.** No browser API can install a system driver,
  and that restriction is exactly what stops a web page changing a machine.
  The panel links to the chip maker's own installer.
- **It cannot detect a driver silently.** Web Serial only exposes ports the
  user has explicitly granted, so a working machine with nothing granted looks
  identical to one with no driver. Confirming requires one click through the
  browser's picker, which is what "Check my board" asks for.
- **An empty picker is ambiguous.** The browser reports "user cancelled" and
  "nothing to offer" the same way, so the panel leads with the driver
  explanation and mentions the other.

### Diagnosing a noisy capture

```bash
cd backend
.venv/bin/python analyze_capture.py path/to/capture.csv
```

Takes either the bench capture shape or the app's own CSV export. "It looks
noisy" is not actionable, because the display auto-scales to the signal: a weak
clean recording and a strong dirty one look alike on screen. This measures the
R wave against the noise floor in the isoelectric segment between beats, then
splits the noise into baseline wander, EMG, mains and aliased harmonics,
because each has a different cause and a different fix. It runs the same filter
and detector the app runs, so the numbers describe what you are looking at.

`repair.mjs` covers the failure with no other safety net. If the module bundle
does not load, the shell renders and no JavaScript runs, so the page cannot be
told anything and cannot fix itself: it sits on "Generating cardiac anatomy"
through every reopen. The inline watchdog in `index.html` is the only code that
still runs in that state, which is why it is inline and why it may not be moved
into the bundle it exists to rescue.

`offlineboot.mjs` is the one that catches what the others cannot: it installs
the app while online, then cold-launches it in standalone mode with **every**
request to the origin aborted, and asserts it still boots, streams, detects
beats and draws on the right timebase. That failure mode passes every online
test and fails for the first real guest.

---

## Running your own copy

```bash
git clone https://github.com/holarxmanuel/ecg-heart-visualizer
cd ecg-heart-visualizer

cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python selftest.py       # must print "All 20 cases passed."
.venv/bin/python run_server.py &

cd ../frontend
npm install
npm run build
```

Open <http://localhost:8000>. localhost is a secure context, so USB sensors,
offline mode and installing the app all work locally with no certificate.

When the published version moves ahead of your clone, a banner appears and
offers to pull and rebuild.

### Why self-update is loopback-only

`POST /api/update/apply` runs `git pull` and `npm install` on the host. On a
public deployment that is a remote code execution path for anyone who can
reach the port, so `backend/updater.py` restricts it to loopback callers and
refuses to run against a dirty working tree. The hosted site is updated by its
maintainer, not over the network.

---

## Serial ports on Linux

The server enumerates 32 `/dev/ttyS*` nodes that are kernel placeholders, not
devices. `autodetect_port()` ignores anything without a real USB hwid and will
return `None` rather than guess — opening a dead UART would show "connected"
against a port that never produces a sample.

A real Arduino appears as `/dev/ttyUSB*` (CH340/FTDI clone) or `/dev/ttyACM*`
(genuine ATmega16U2). The user must be in the `dialout` group.

---

## Mains frequency

`config.MAINS_HZ = 50.0` — correct for Nigeria. Set it to `60.0` in North
America, then regenerate the coefficients (see above). Leaving it wrong leaves
visible hum riding on the filtered trace.

---

## Not a medical device

For education and demonstration only. Never connect any part of this to mains
power.
