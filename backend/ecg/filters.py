"""
Streaming ECG filter chain.

The critical property here is *statefulness*. We receive the signal in 20 ms
chunks, so every filter must carry its delay line across calls -- otherwise you
get a transient discontinuity at every chunk boundary, which the R-peak
detector would happily report as a heartbeat.

scipy's `sosfilt` with an explicit `zi` gives us exactly that: the same output
as filtering the whole recording offline, but computed incrementally.

Chain (all second-order sections, cascaded into one filter):
    high-pass 0.5 Hz  -> kills baseline wander / breathing drift
    notch     60 Hz   -> kills mains hum
    low-pass  40 Hz   -> kills EMG hash; standard ECG "monitor mode" band
"""

from __future__ import annotations

import numpy as np
from scipy import signal

import config


def _notch_sos(freq: float, q: float, fs: float) -> np.ndarray:
    """IIR notch as second-order sections."""
    b, a = signal.iirnotch(w0=freq, Q=q, fs=fs)
    return signal.tf2sos(b, a)


class ECGFilter:
    """Zero-glitch streaming filter for display-quality ECG."""

    def __init__(
        self,
        sample_rate: int = config.SAMPLE_RATE,
        mains_hz: float = config.MAINS_HZ,
        highpass_hz: float = config.HIGHPASS_HZ,
        lowpass_hz: float = config.LOWPASS_HZ,
    ) -> None:
        self.sample_rate = sample_rate
        nyq = sample_rate / 2.0

        sections = [
            signal.butter(2, highpass_hz / nyq, btype="highpass", output="sos"),
            _notch_sos(mains_hz, config.NOTCH_Q, sample_rate),
        ]
        # Also notch the 2nd harmonic -- switch-mode supplies and cheap USB
        # chargers put a very audible 120 Hz component on the AD8232 rail.
        if mains_hz * 2 < nyq:
            sections.append(_notch_sos(mains_hz * 2, config.NOTCH_Q, sample_rate))
        if lowpass_hz < nyq:
            sections.append(
                signal.butter(4, lowpass_hz / nyq, btype="lowpass", output="sos")
            )

        self.sos = np.vstack(sections)
        self._zi = signal.sosfilt_zi(self.sos) * 0.0
        self._primed = False

    def reset(self) -> None:
        self._zi = signal.sosfilt_zi(self.sos) * 0.0
        self._primed = False

    def process(self, x: np.ndarray) -> np.ndarray:
        """Filter a chunk, carrying filter state across calls."""
        if x.size == 0:
            return x

        if not self._primed:
            # Seed the delay line with the first sample's steady state. Without
            # this the high-pass rings for several seconds on startup and the
            # trace looks like it fell off a cliff.
            self._zi = signal.sosfilt_zi(self.sos) * float(x[0])
            self._primed = True

        y, self._zi = signal.sosfilt(self.sos, x, zi=self._zi)
        return y


class BandpassFilter:
    """Generic streaming band-pass, used by the QRS detector's front end."""

    def __init__(self, low: float, high: float, sample_rate: int, order: int = 3):
        nyq = sample_rate / 2.0
        self.sos = signal.butter(
            order, [low / nyq, min(high / nyq, 0.99)], btype="bandpass", output="sos"
        )
        self._zi = signal.sosfilt_zi(self.sos) * 0.0

    def reset(self) -> None:
        self._zi = signal.sosfilt_zi(self.sos) * 0.0

    def process(self, x: np.ndarray) -> np.ndarray:
        if x.size == 0:
            return x
        y, self._zi = signal.sosfilt(self.sos, x, zi=self._zi)
        return y
