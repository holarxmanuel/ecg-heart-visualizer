"""
=============================================================================
 HARDWARE CONFIGURATION  --  THE ONLY FILE YOU NEED TO TOUCH FOR THE AD8232
=============================================================================

Every value the serial/hardware layer uses lives here. When the AD8232 +
Arduino Uno R3 arrives, verify the block marked "ARDUINO SERIAL SETTINGS"
matches the sketch in ../arduino/ecg_ad8232/ and you are done.

See ../instructions.txt for the copy-paste hardware swap guide.
"""

# ---------------------------------------------------------------------------
# ACQUISITION (shared by BOTH the simulator and the real hardware)
# ---------------------------------------------------------------------------

# Samples per second. The Arduino sketch paces analogRead() to this exact rate.
# If you change it here, change SAMPLE_RATE_HZ in the .ino sketch to match,
# and re-run export_dsp.py, or the browser's filter coefficients will still be
# designed for the old rate and offline mode will disagree with the server.
#
# 125 Hz is what the AD8232 rig actually delivers. Above Nyquist-safety this is
# a real trade: 125 Hz resolves a QRS complex well enough to time R-peaks (the
# detector band tops out at 15 Hz) but it is below the 250-500 Hz a diagnostic
# recorder would use, so fine morphology is coarser than the display suggests.
# Rate and hardware must agree; a mismatch does not degrade the reading, it
# scales every interval by the ratio and reports a heart rate that is wrong by
# that factor.
#
# One consequence of 125 Hz worth knowing before blaming the filters for noise:
# Nyquist is 62.5 Hz, so anything above that folds back into the band and no
# later filter can remove it, because after folding it is no longer at the
# frequency it came from. Mains harmonics are the case that matters here:
#
#     50 Hz  -> stays at 50.0 Hz -> notched, -72 dB
#     100 Hz -> folds to 25.0 Hz -> UNTOUCHED, -0.01 dB, mid-band
#     150 Hz -> folds to 25.0 Hz -> UNTOUCHED
#
# The 50 Hz notch cannot help with the 2nd and 3rd harmonics, and the guard
# below that adds a 2*mains notch is correctly inactive because 100 Hz is above
# Nyquist here. What protects the signal is the AD8232's own analogue
# band-limiting ahead of the ADC, not anything in this file. If aliased mains
# ever becomes visible as ~25 Hz hash on the trace, the fix is to sample faster
# (which also re-enables the harmonic notch), not to add more digital filtering.
SAMPLE_RATE = 125

# Arduino Uno R3 ADC characteristics. The AD8232 output pin goes to A0.
ADC_BITS = 10  # analogRead() returns 0..1023
ADC_MAX = (1 << ADC_BITS) - 1  # 1023
ADC_VREF = 5.0  # Uno analog reference in volts (3.3 if you power the board at 3V3)

# AD8232 nominal operating point: output idles near mid-rail.
# The datasheet-typical instrumentation gain of the AD8232 front end is ~1100,
# so a 1 mV physiological ECG becomes ~1.1 V at the OUTPUT pin.
AD8232_BASELINE_V = 1.5  # volts at rest
AD8232_GAIN = 1100.0  # V/V  (millivolt ECG -> volt output)

# ---------------------------------------------------------------------------
# ARDUINO SERIAL SETTINGS  (Phase 2 -- real hardware)
# ---------------------------------------------------------------------------

# Baud rate. MUST match Serial.begin() in the .ino sketch.
SERIAL_BAUD = 115200

# Set to a fixed port string (e.g. "COM5") to skip auto-detection.
# Leave as None to auto-detect on every connect.
SERIAL_PORT = None

# Read timeout in seconds for pyserial.
SERIAL_TIMEOUT = 1.0

# Substrings matched (case-insensitive) against a port's description /
# manufacturer when auto-detecting. Covers genuine Unos (ATmega16U2), and the
# CH340 / CP2102 / FTDI chips found on clones.
SERIAL_AUTODETECT_HINTS = (
    "arduino",
    "ch340",
    "ch341",
    "usb-serial",
    "usb serial",
    "cp210",
    "ftdi",
    "wch",
    "silicon labs",
)

# Line protocol emitted by the sketch. Two forms are accepted:
#   "512\n"        -> just the ADC value
#   "512,0\n"      -> ADC value, leads-off flag (1 = electrode detached)
# The parser in ecg/serial_source.py handles both, plus the bare "!" that the
# reference sketch prints while leads are off.
SERIAL_LEADS_OFF_TOKEN = "!"

# ---------------------------------------------------------------------------
# SIGNAL PROCESSING
# ---------------------------------------------------------------------------

# 60 for North America, 50 for EU/Asia/Africa. Notch filter target.
# Nigeria (where this is deployed) is 50 Hz -- leaving this at 60 leaves
# visible mains hum riding on the filtered trace.
MAINS_HZ = 50.0
NOTCH_Q = 30.0  # Notch quality factor (narrower = higher Q)
HIGHPASS_HZ = 0.5  # removes baseline wander / breathing drift
LOWPASS_HZ = 40.0  # removes EMG + high-frequency hash (diagnostic-band display)

# R-peak detector (Pan-Tompkins style, streaming)
QRS_BANDPASS = (5.0, 15.0)  # Hz, the band where QRS energy dominates
QRS_INTEGRATION_MS = 150  # moving-window integrator width
QRS_REFRACTORY_MS = 200  # physiological floor: no two R-peaks closer than this
BPM_MIN = 25.0
BPM_MAX = 240.0

# ---------------------------------------------------------------------------
# STREAMING / TRANSPORT
# ---------------------------------------------------------------------------

# How often the server pushes a batch of samples to the browser.
# 20 ms -> 50 messages/sec of 20 samples each. Keeps end-to-end latency well
# under the 150 ms budget while staying cheap on CPU.
BATCH_INTERVAL_MS = 20

# Bind on all interfaces: Caddy terminates TLS on :443 and reverse-proxies
# here, and the port is not exposed to the internet directly (see Caddyfile
# and deploy/). Set back to 127.0.0.1 for a purely local run.
HOST = "0.0.0.0"
PORT = 8000

# Origins allowed to talk to this API (the Vite dev server runs on 3000).
# The deployed origin. nip.io resolves <dashed-ip>.nip.io -> that IP, which
# lets Let's Encrypt issue a real certificate without owning a domain. A
# secure context is mandatory: Web Serial and service workers both refuse to
# run on plain http://<ip>.
PUBLIC_IP = "192.99.245.44"
PUBLIC_HOST = "ecgv.stream"
PUBLIC_ORIGIN = f"https://{PUBLIC_HOST}"

CORS_ORIGINS = [
    PUBLIC_ORIGIN,
    # The nip.io host the app lived on before the domain. Kept only so a stray
    # request from an older installed copy is not a CORS failure on top of the
    # redirect it is already following.
    "https://ecg.192-99-245-44.nip.io",
    f"http://{PUBLIC_IP}:8000",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

# ---------------------------------------------------------------------------
# SIMULATOR DEFAULTS
# ---------------------------------------------------------------------------

SIM_DEFAULT_BPM = 60.0
SIM_DEFAULT_NOISE = 0.15  # 0.0 = clean lab signal, 1.0 = very noisy
SIM_DEFAULT_ARTIFACTS = True
SIM_BREATHING_HZ = 0.25  # ~15 breaths/min
