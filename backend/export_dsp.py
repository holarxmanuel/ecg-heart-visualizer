"""
Export the filter designs to JavaScript.

The browser needs the same filter chain the server runs, so that offline mode
and local (zero-latency) sensor processing produce the same trace and the same
beats as the server does. The obvious approach -- reimplement Butterworth and
iirnotch design in JS -- is a bad trade: filter *design* is fiddly numerical
code that is easy to get subtly wrong, and "subtly wrong" here means a trace
that looks fine but reports a different heart rate than the server. The design
is also completely static (fixed sample rate and cutoffs), so there is nothing
to gain by computing it at runtime.

So scipy stays the single source of truth and this script bakes its output
into a generated JS module. Only the *application* of the filter (sosfilt, a
dozen lines of arithmetic) is ported by hand, and `verify_dsp.py` proves that
port matches sample-for-sample.

Run after changing any filter constant in config.py:

    .venv/bin/python export_dsp.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy import signal

import config
from ecg.filters import ECGFilter, BandpassFilter

OUT = Path(__file__).resolve().parent.parent / "frontend" / "src" / "dsp" / "coeffs.js"


def _fmt(arr: np.ndarray) -> str:
    """A 2-D SOS matrix as a nested JS array literal, full float64 precision."""
    rows = [
        "    [" + ", ".join(repr(float(v)) for v in row) + "]" for row in np.atleast_2d(arr)
    ]
    return "[\n" + ",\n".join(rows) + ",\n  ]"


def _fmt1(arr: np.ndarray) -> str:
    return "[" + ", ".join(repr(float(v)) for v in np.ravel(arr)) + "]"


def main() -> None:
    ecg = ECGFilter()
    qrs = BandpassFilter(*config.QRS_BANDPASS, sample_rate=config.SAMPLE_RATE)

    ecg_zi = signal.sosfilt_zi(ecg.sos)
    qrs_zi = signal.sosfilt_zi(qrs.sos)

    text = f'''// GENERATED FILE -- do not edit by hand.
// Produced by backend/export_dsp.py from the scipy filter designs in
// backend/ecg/filters.py. Regenerate after changing any filter constant:
//
//     cd backend && .venv/bin/python export_dsp.py
//
// Keeping scipy as the source of truth means the browser's offline DSP and
// the server's DSP cannot drift apart -- verify_dsp.py asserts they agree
// sample-for-sample.

export const SAMPLE_RATE = {config.SAMPLE_RATE};
export const MAINS_HZ = {config.MAINS_HZ};
export const ADC_MAX = {config.ADC_MAX};
export const ADC_VREF = {config.ADC_VREF};
export const AD8232_GAIN = {config.AD8232_GAIN};
export const AD8232_BASELINE_V = {config.AD8232_BASELINE_V};
export const SIM_BREATHING_HZ = {config.SIM_BREATHING_HZ};

export const QRS_INTEGRATION_MS = {config.QRS_INTEGRATION_MS};
export const QRS_REFRACTORY_MS = {config.QRS_REFRACTORY_MS};
export const BPM_MIN = {config.BPM_MIN};
export const BPM_MAX = {config.BPM_MAX};

// Display chain: 0.5 Hz high-pass -> {config.MAINS_HZ:.0f} Hz notch ->
// {config.MAINS_HZ * 2:.0f} Hz notch -> {config.LOWPASS_HZ:.0f} Hz low-pass.
export const ECG_SOS = {_fmt(ecg.sos)};

// Unit-step steady state, scaled by the first sample to prime the delay line.
// Without priming, the high-pass rings for seconds at startup.
export const ECG_ZI = {_fmt(ecg_zi)};

// QRS detector front end: {config.QRS_BANDPASS[0]:.0f}-{config.QRS_BANDPASS[1]:.0f} Hz band-pass.
export const QRS_SOS = {_fmt(qrs.sos)};
export const QRS_ZI = {_fmt(qrs_zi)};
'''
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"  ECG chain : {ecg.sos.shape[0]} sections")
    print(f"  QRS chain : {qrs.sos.shape[0]} sections")


if __name__ == "__main__":
    main()
