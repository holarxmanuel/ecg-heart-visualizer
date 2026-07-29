# Deployment

How this system runs, how to reach it, and how the two ways of running it stay
in sync.

---

## Access paths

All must always show the same build.

| | URL | Secure context? | Mode toggle |
|---|---|---|---|
| Hosted, plain HTTP | `http://143.198.27.18:8000` | no | locked Online |
| Hosted, HTTPS (tunnel) | see `/api/access` | **yes** | locked Online |
| Installed app | installed from the HTTPS URL | yes | **Online / Offline** |
| Local clone | `http://localhost:8000` | yes (localhost is exempt) | **Online / Offline** |

Only a secure context can install the app or read a USB sensor. The plain-HTTP
address works for everything else and links users to the secure one.

| | Web / installed app | Local clone |
|---|---|---|
| URL | HTTPS tunnel | `http://localhost:8000` |
| Updates | automatic — new deploy, banner offers reload | banner offers `git pull` + rebuild |
| Runs | always, under systemd | when you start it |
| USB sensor | Web Serial, in the user's browser | Web Serial, or the server-side `SerialSource` |

---

## Architecture as deployed

```
                    ┌──────────────────── the server (143.198.27.18) ────────┐
                    │                                                        │
   browser ──443──▶ │  Caddy ──▶ FastAPI :8000 ──▶ ECGSource ──▶ filter ──▶  │
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
and online can never disagree about a heart rate.

---

## Why HTTPS is mandatory

Two headline features refuse to run outside a **secure context**:

- **Web Serial** — reading the AD8232 from the user's own USB port
- **Service workers** — offline operation and installing the app

`http://localhost` is exempt. `http://143.198.27.18:8000` is **not**. There is
no way to ship those features over plain HTTP on an IP address.

We use **nip.io**: `143-198-27-18.nip.io` resolves to `143.198.27.18`, giving a
real hostname that Let's Encrypt will issue a certificate for, with no domain
purchase. Caddy handles issuance and renewal by itself.

### What we actually use: a Cloudflare tunnel

The droplet's host firewall is open, but the **cloud firewall blocks inbound
80 and 443** (8000 and 22 get through). ACME connects to those exact port
numbers and neither is configurable, so Let's Encrypt cannot validate no
matter how Caddy is configured.

`cloudflared` sidesteps this by dialling **outbound**, so no inbound port is
needed at all, and TLS terminates on Cloudflare's edge with a certificate
browsers already trust.

```bash
systemctl status ecg-tunnel
cat /var/lib/ecg-tunnel/url        # the current public HTTPS address
curl -s localhost:8000/api/access  # what the app itself advertises
```

**Caveat:** a free quick tunnel gets a **random hostname that changes every
time it restarts**. That is fine for trying things out, but poor for an
installed app, whose identity is its origin — a changed hostname means the
installed copy points at a dead URL and its cached data is orphaned.

For a stable address, either open the ports (below) or run a *named* tunnel
against a free Cloudflare account with a domain.

### Alternative: open ports 80 and 443

Caddy is still installed and configured for `143-198-27-18.nip.io`, and will
obtain a certificate by itself the moment the ports open.

DigitalOcean → **Networking → Firewalls** → add inbound rules:

| Type | Protocol | Port | Sources |
|---|---|---|---|
| HTTP | TCP | 80 | All IPv4, All IPv6 |
| HTTPS | TCP | 443 | All IPv4, All IPv6 |

Port 80 is needed for the ACME HTTP-01 challenge *and* for renewals — do not
close it after issuance.

Then:

```bash
sudo systemctl restart caddy
journalctl -u caddy -f          # watch for "certificate obtained successfully"
curl -I https://143-198-27-18.nip.io/api/health
```

Caddy retries on its own, so this may already have happened by the time you
look. Once it works, that hostname is stable and the tunnel becomes optional.

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
systemctl status ecg-backend     # FastAPI + 1 kHz acquisition
systemctl status caddy           # TLS termination

journalctl -u ecg-backend -f
journalctl -u caddy -f

sudo systemctl restart ecg-backend
```

Unit files live in `deploy/` and are copied to `/etc/systemd/system/`.

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

cd ../../ecg-harness
node test.mjs                     # 42 browser checks incl. offline + PWA
```

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
