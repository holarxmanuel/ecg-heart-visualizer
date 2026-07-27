"""
Streaming R-peak detector (Pan-Tompkins, adapted for chunked real-time input).

Why Pan-Tompkins rather than the naive "threshold the raw voltage" approach:
a raw threshold is defeated by baseline wander, by a tall T wave, and by the
amplitude drop when an electrode dries out. Pan-Tompkins solves all three by
detecting QRS *energy* in the 5-15 Hz band and adapting its threshold to the
running signal and noise levels. It is the algorithm real monitors use.

Pipeline, per sample:
    band-pass 5-15 Hz  -> isolate QRS energy from P/T waves and drift
    5-point derivative -> emphasise the steep QRS slope
    square             -> make everything positive, amplify big slopes
    150 ms integrate   -> turn the spiky QRS into one broad bump
    adaptive threshold -> SPKI/NPKI running estimates (the "adaptive" part)
    200 ms refractory  -> physiologically impossible to beat faster

All state persists across chunks, so a beat straddling a 20 ms batch boundary
is detected exactly once, at the right sample.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

import config
from .filters import BandpassFilter


@dataclass
class Beat:
    """One detected heartbeat."""

    global_index: int  # sample index since acquisition start
    chunk_index: int  # index within the chunk just processed (for UI sync)
    number: int  # 1-based beat counter
    bpm: float  # instantaneous rate from this RR interval
    bpm_avg: float  # smoothed rate (median of recent RRs)
    rr_ms: float  # RR interval that produced `bpm`
    amplitude: float  # filtered-signal amplitude at the R-peak


class RPeakDetector:
    def __init__(self, sample_rate: int = config.SAMPLE_RATE) -> None:
        self.fs = int(sample_rate)

        self._bandpass = BandpassFilter(*config.QRS_BANDPASS, sample_rate=self.fs)
        self._win = max(int(config.QRS_INTEGRATION_MS * self.fs / 1000), 1)
        self._refractory = int(config.QRS_REFRACTORY_MS * self.fs / 1000)

        # Minimum RR that could still be a real (very fast) beat.
        self._min_rr = int((60.0 / config.BPM_MAX) * self.fs)
        self._max_rr = int((60.0 / config.BPM_MIN) * self.fs)

        self.reset()

    # -- lifecycle ---------------------------------------------------------

    def reset(self) -> None:
        self._bandpass.reset()

        self._n = 0  # global sample counter
        self._deriv_tail = np.zeros(4)  # 5-point derivative history
        self._sq_tail = np.zeros(self._win - 1)  # integrator history

        # Peak-tracking state machine across chunk boundaries.
        self._prev_y = 0.0
        self._rising = False

        # Adaptive thresholds (Pan-Tompkins SPKI / NPKI).
        self._spki = 0.0  # running signal-peak estimate
        self._npki = 0.0  # running noise-peak estimate
        self._learning = True
        self._learn_buf: list[float] = []
        self._learn_samples = int(1.5 * self.fs)  # 1.5 s warm-up

        self._last_r: int | None = None
        self._beat_count = 0
        self._rr_history: deque[float] = deque(maxlen=8)

        # Detection blanking window, used after a waveform splice.
        self._suppress_until = 0
        self.suppressed_beats = 0

        # Rolling window of filtered signal, for locating the true R-peak
        # (the integrator's output lags the actual peak by ~100 ms).
        self._lookback = int(0.35 * self.fs)
        self._filt_buf = np.zeros(self._lookback)
        self._filt_base = 0  # global index of _filt_buf[0]

    # -- properties --------------------------------------------------------

    @property
    def threshold(self) -> float:
        return self._npki + 0.25 * (self._spki - self._npki)

    @property
    def beat_count(self) -> int:
        return self._beat_count

    @property
    def bpm(self) -> float:
        """Smoothed BPM, or 0 if we have not seen two beats yet."""
        if not self._rr_history:
            return 0.0
        rr = float(np.median(self._rr_history))
        return 60000.0 / rr if rr > 0 else 0.0

    def notify_discontinuity(self, blank_ms: float = 120.0) -> None:
        """
        Tell the detector the waveform was just spliced.

        The damage a splice does is NOT mainly phantom beats -- the high-pass
        smooths the step and the refractory period absorbs most of what is
        left. The real damage is to timing: the interval spanning the seam is
        measured in samples, and the missing samples make it read short. One
        0.4 s dropout at 120 BPM turns a 500 ms RR into a 100 ms one, and a few
        of those drag the reported rate up by ten BPM or more. The displayed
        heart rate is the number a user actually trusts, so corrupting it is
        the worst available failure.

        The fix is therefore to forget where the last R-peak was, so the next
        beat simply produces no interval instead of a wrong one. We also blank
        detection briefly across the seam itself -- but only briefly, because a
        long blanking window discards real beats to prevent phantoms that
        measurement shows were not occurring.
        """
        self._last_r = None
        self._suppress_until = self._n + int(blank_ms * self.fs / 1000)

    def seconds_since_last_beat(self) -> float:
        if self._last_r is None:
            return 0.0
        return (self._n - self._last_r) / self.fs

    # -- main --------------------------------------------------------------

    def process(self, filtered: np.ndarray) -> list[Beat]:
        """
        Feed a chunk of *filtered* ECG (volts). Returns beats found in it.

        `filtered` should come from ECGFilter, not the raw ADC signal -- the
        detector assumes baseline wander has already been removed.
        """
        if filtered.size == 0:
            return []

        n = filtered.size
        chunk_start = self._n

        self._push_filtered(filtered)

        integrated = self._integrate(filtered)
        beats = self._find_peaks(integrated, chunk_start)

        self._n += n
        return beats

    # -- internals ---------------------------------------------------------

    def _push_filtered(self, x: np.ndarray) -> None:
        """Maintain the rolling filtered-signal window used for peak refinement."""
        if x.size >= self._lookback:
            self._filt_buf = x[-self._lookback :].copy()
        else:
            self._filt_buf = np.concatenate([self._filt_buf[x.size :], x])
        self._filt_base = self._n + x.size - self._lookback

    def _integrate(self, x: np.ndarray) -> np.ndarray:
        """band-pass -> derivative -> square -> moving-window integrate."""
        bp = self._bandpass.process(x)

        # Pan-Tompkins 5-point derivative: (2x[n] + x[n-1] - x[n-3] - 2x[n-4]) / 8
        padded = np.concatenate([self._deriv_tail, bp])
        self._deriv_tail = padded[-4:].copy()
        d = (
            2.0 * padded[4:]
            + padded[3:-1]
            - padded[1:-3]
            - 2.0 * padded[:-4]
        ) / 8.0

        sq = d * d

        # Moving-window integrator, implemented as a cumulative-sum difference
        # with the previous chunk's tail prepended so windows span boundaries.
        buf = np.concatenate([self._sq_tail, sq])
        self._sq_tail = buf[-(self._win - 1) :].copy() if self._win > 1 else buf[:0]
        c = np.cumsum(buf)
        head = np.concatenate([[0.0], c[: -self._win]]) if self._win <= c.size else None
        if head is None:  # chunk shorter than the window on a cold start
            return np.full(sq.size, c[-1] / self._win)
        return (c[self._win - 1 :] - head) / self._win

    def _find_peaks(self, integrated: np.ndarray, chunk_start: int) -> list[Beat]:
        beats: list[Beat] = []

        # Warm-up: collect statistics before trusting any threshold, so a loud
        # startup transient does not get logged as a run of tachycardia.
        if self._learning:
            self._learn_buf.extend(integrated.tolist())
            if len(self._learn_buf) >= self._learn_samples:
                arr = np.asarray(self._learn_buf)
                self._spki = float(np.percentile(arr, 99.5))
                self._npki = float(np.percentile(arr, 60.0))
                self._learning = False
                self._learn_buf.clear()
            self._prev_y = float(integrated[-1])
            return beats

        for i, y in enumerate(integrated):
            y = float(y)
            gi = chunk_start + i

            if y > self._prev_y:
                self._rising = True
                self._prev_y = y
                continue

            if not self._rising:
                self._prev_y = y
                continue

            # We just crested: _prev_y is a local maximum at global index gi-1.
            self._rising = False
            peak_val = self._prev_y
            peak_gi = gi - 1
            self._prev_y = y

            if peak_val < self.threshold:
                # Below threshold -> treat as noise and let NPKI drift up.
                self._npki = 0.125 * peak_val + 0.875 * self._npki
                continue

            if self._last_r is not None:
                gap = peak_gi - self._last_r
                if gap < max(self._refractory, self._min_rr):
                    # Inside the refractory period: physiologically impossible,
                    # almost always a T wave or a motion spike. Ignore it, and
                    # do not let it pollute either running estimate.
                    continue

            if peak_gi < self._suppress_until:
                # Inside the post-splice blanking window. Do not count it, and
                # do not let it touch SPKI or the RR history either -- a
                # phantom that poisons the adaptive state costs far more than
                # the single beat we may be discarding here.
                self.suppressed_beats += 1
                continue

            # Accepted as a QRS complex.
            self._spki = 0.125 * peak_val + 0.875 * self._spki
            r_gi, amp = self._refine_peak(peak_gi)

            rr_ms = 0.0
            bpm = 0.0
            if self._last_r is not None:
                rr_samples = r_gi - self._last_r
                if rr_samples > 0:
                    rr_ms = rr_samples * 1000.0 / self.fs
                    bpm = 60000.0 / rr_ms
                    if config.BPM_MIN <= bpm <= config.BPM_MAX:
                        self._rr_history.append(rr_ms)
                    else:
                        bpm = 0.0

            self._last_r = r_gi
            self._beat_count += 1

            beats.append(
                Beat(
                    global_index=r_gi,
                    chunk_index=int(np.clip(r_gi - chunk_start, 0, integrated.size - 1)),
                    number=self._beat_count,
                    bpm=round(bpm, 1),
                    bpm_avg=round(self.bpm, 1),
                    rr_ms=round(rr_ms, 1),
                    amplitude=round(amp, 4),
                )
            )

        return beats

    def _refine_peak(self, integrated_peak_gi: int) -> tuple[int, float]:
        """
        Snap the detection back onto the true R-peak.

        The integrator's bump is centred ~half its window after the QRS, so we
        search the filtered signal backwards over the preceding 200 ms for the
        largest absolute deflection. That is the sample the animation and the
        audio click should fire on.
        """
        search = int(0.20 * self.fs)
        lo = integrated_peak_gi - search
        hi = integrated_peak_gi + 1

        lo_i = lo - self._filt_base
        hi_i = hi - self._filt_base
        lo_i = max(lo_i, 0)
        hi_i = min(hi_i, self._filt_buf.size)
        if hi_i - lo_i < 2:
            return integrated_peak_gi, 0.0

        window = self._filt_buf[lo_i:hi_i]
        k = int(np.argmax(np.abs(window)))
        return self._filt_base + lo_i + k, float(window[k])
