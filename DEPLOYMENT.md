# Deployment

How this system runs, how to reach it, and how the two ways of running it stay
in sync.

---

## The two access paths

Both must always show the same build.

| | Web / installed app | Local clone |
|---|---|---|
| URL | `https://143-198-27-18.nip.io` | `http://localhost:8000` |
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

### Required: open ports 80 and 443

The droplet's host firewall is open, but the **DigitalOcean cloud firewall**
blocks inbound 80/443. Until those are opened, ACME cannot validate and the
site stays HTTP-only.

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
look.

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
