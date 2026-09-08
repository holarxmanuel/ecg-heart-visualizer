"""
Measure how noisy a real capture actually is, and say which noise it is.

"The trace looks noisy" is not actionable: the display auto-scales to the
signal, so a weak-but-clean recording and a strong-but-dirty one look alike.
This separates the two by measuring the R-wave against the noise floor in the
isoelectric segment between beats, then splits the noise by frequency band,
because each band has a different cause and a different fix.

    .venv/bin/python analyze_capture.py <capture.csv>

Accepts either shape:
    index,timestamp_ms,raw_adc,leads_off     (bench capture)
    time_s,raw_adc,raw_volts,filtered_mv,r_peak   (the app's CSV export)

It runs the SAME filter and detector the app runs, so the numbers describe
what you are actually looking at rather than an idealised version of it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy import signal as sig

import config
from ecg.detector import RPeakDetector
from ecg.filters import ECGFilter

MV_PER_COUNT = (config.ADC_VREF / config.ADC_MAX) / config.AD8232_GAIN * 1000.0


def load(path: Path) -> np.ndarray:
    """Return raw ADC counts, whichever CSV shape this is."""
    header, rows = None, []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if header is None:
            header = [c.strip().lower() for c in line.split(",")]
            continue
        rows.append(line.split(","))
    if header is None or not rows:
        raise SystemExit(f"{path}: no data rows found")
    if "raw_adc" not in header:
        raise SystemExit(f"{path}: no raw_adc column (found {header})")
    col = header.index("raw_adc")
    vals = []
    for r in rows:
        try:
            vals.append(float(r[col]))
        except (ValueError, IndexError):
            continue
    return np.asarray(vals, dtype=np.float64)


def band_rms(x: np.ndarray, fs: float, lo: float, hi: float) -> float:
    """RMS of x restricted to [lo, hi] Hz, via Welch power integration."""
    nper = min(len(x), int(fs * 4))
    f, p = sig.welch(x, fs=fs, nperseg=max(nper, 32))
    m = (f >= lo) & (f <= min(hi, fs / 2 - 1e-9))
    if not m.any():
        return 0.0
    return float(np.sqrt(np.trapezoid(p[m], f[m])))


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    raw = load(path)
    fs = config.SAMPLE_RATE
    dur = len(raw) / fs

    print(f"\n{path.name}: {len(raw)} samples, {dur:.1f} s at {fs} Hz")
    print("=" * 70)

    # --- the signal, through the app's own chain --------------------------
    volts = raw * (config.ADC_VREF / config.ADC_MAX)
    filt_v = ECGFilter().process(volts)
    filt_mv = filt_v * (1000.0 / config.AD8232_GAIN)

    # Feed it in the same small batches the live pipeline uses. The detector
    # keeps only a short lookback for locating the true peak, so handing it one
    # huge array is not equivalent to streaming and finds nothing.
    det = RPeakDetector()
    chunk = max(int(config.BATCH_INTERVAL_MS * fs / 1000), 1)
    peaks = []
    for i in range(0, len(filt_v) - chunk + 1, chunk):
        peaks.extend(b.global_index for b in det.process(filt_v[i : i + chunk]))
    peaks = [p for p in peaks if 2.0 * fs < p < len(raw) - fs]

    print(f"\nADC baseline      : {raw.mean():7.1f} counts  (mid-rail is ~340-350)")
    print(f"ADC excursion     : {raw.min():7.0f} .. {raw.max():.0f} counts")
    clipped = int(((raw <= 0) | (raw >= config.ADC_MAX)).sum())
    print(f"clipped samples   : {clipped:7d}  {'<-- SATURATING, signal is being lost' if clipped else ''}")
    print(f"R-peaks detected  : {len(peaks):7d}   ({det.bpm:.1f} bpm)")

    if len(peaks) < 5:
        print("\nToo few beats to measure signal-to-noise. Capture at least 15 s.")
        return 1

    # --- R amplitude vs the isoelectric noise floor -----------------------
    # The TP segment (after the T wave, before the next P) is the only part of
    # a cardiac cycle that should be flat, so it is where noise is measurable
    # without the signal contaminating the estimate.
    amps, floors = [], []
    w = int(0.04 * fs)
    for p in peaks:
        a, b = p - int(0.45 * fs), p - int(0.30 * fs)
        if a < 0 or p + w >= len(filt_mv) or b - a < 8:
            continue
        seg = filt_mv[a:b]
        seg = seg - np.polyval(np.polyfit(np.arange(len(seg)), seg, 1), np.arange(len(seg)))
        floors.append(float(np.std(seg)))
        amps.append(float(np.ptp(filt_mv[p - w : p + w])))

    if not amps:
        print("\nCould not isolate isoelectric segments (heart rate too high?).")
        return 1

    r_mv = float(np.median(amps))
    n_mv = float(np.median(floors))
    snr = 20.0 * np.log10(r_mv / n_mv) if n_mv > 0 else float("inf")

    print("\nSignal and noise, referred to the electrodes")
    print("-" * 70)
    print(f"  R-wave amplitude    : {r_mv:6.3f} mV   (a good lead-I R is 0.5-1.5 mV)")
    print(f"  noise floor (TP)    : {n_mv:6.3f} mV   (quiet is < 0.05, good < 0.02)")
    print(f"  signal-to-noise     : {snr:6.1f} dB   (>26 dB clean, 20-26 usable, <20 poor)")
    print(f"  display autoscales to +/-{max(r_mv * 0.625, 0.35):.2f} mV, so noise is drawn")
    print(f"  at {100 * n_mv / max(r_mv * 0.625, 0.35):.1f}% of half-screen height")

    # --- which noise is it ------------------------------------------------
    raw_mv = (raw - raw.mean()) * MV_PER_COUNT
    bands = {
        "baseline wander (<0.5 Hz)": band_rms(raw_mv, fs, 0.0, 0.5),
        "ECG band (0.5-40 Hz)": band_rms(raw_mv, fs, 0.5, 40.0),
        "EMG / muscle (20-40 Hz)": band_rms(raw_mv, fs, 20.0, 40.0),
        f"mains ({config.MAINS_HZ:.0f} Hz +/-2)": band_rms(raw_mv, fs, config.MAINS_HZ - 2, config.MAINS_HZ + 2),
        "aliased harmonics (24-26 Hz)": band_rms(raw_mv, fs, 24.0, 26.0),
    }
    print("\nWhere the energy sits (raw, before filtering)")
    print("-" * 70)
    for k, v in bands.items():
        print(f"  {k:<28}: {v:7.4f} mV rms")

    # --- verdict ----------------------------------------------------------
    print("\nVerdict")
    print("-" * 70)
    notes = []
    if clipped:
        notes.append("SATURATING: the amplifier is railing. Check the 3.3V supply and "
                     "electrode contact before trusting anything else here.")
    if r_mv < 0.35:
        notes.append(f"Weak signal ({r_mv:.2f} mV). The display floors its scale at "
                     "0.35 mV, so a weak R wave makes noise look far worse than it is. "
                     "Reposition the electrodes (wider apart, over bone not muscle) "
                     "before touching filters.")
    if bands["mains (50 Hz +/-2)"] > 0.03:
        notes.append("Mains pickup is significant. Run on battery, move the leads away "
                     "from chargers and mains cabling, keep them from running parallel "
                     "to a wall.")
    if bands["baseline wander (<0.5 Hz)"] > 0.3:
        notes.append("Large baseline wander. Usually breathing or electrode movement; "
                     "the 0.5 Hz high-pass removes it from the display, so it is only a "
                     "problem if it is large enough to saturate.")
    if bands["EMG / muscle (20-40 Hz)"] > 0.05:
        notes.append("Muscle activity dominates. Sit still, rest your arms fully "
                     "supported, and keep electrodes off active muscle.")
    if snr >= 26:
        notes.append(f"SNR {snr:.0f} dB is clean. What you are seeing is real ECG detail "
                     "plus the raw overlay, not a fault.")
    elif snr >= 20:
        notes.append(f"SNR {snr:.0f} dB is usable: beat detection is reliable, the trace "
                     "will look grainy next to the simulator. That is expected.")
    else:
        notes.append(f"SNR {snr:.0f} dB is poor. Work through skin prep, electrode "
                     "placement and cable movement in that order.")
    for i, n in enumerate(notes, 1):
        print(f"  {i}. {n}")
    print("\n  Tip: untick 'Raw trace' in the app. The grey line is unfiltered ADC and")
    print("  always looks far noisier than the green filtered trace you should judge.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
