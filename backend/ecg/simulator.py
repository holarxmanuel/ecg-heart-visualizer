"""
Synthetic AD8232 + Arduino Uno R3 ECG source.

The goal is not "a pretty line" -- it is to produce a byte-for-byte plausible
stand-in for what analogRead(A0) returns while an AD8232 is strapped to a
chest, so that every downstream stage (filters, detector, UI, audio) is already
proven correct before the hardware ever arrives.

Signal chain modelled, in order:

    1. PQRST morphology, synthesised in millivolts as a sum of Gaussians
       positioned at clinically realistic offsets from the R-peak.
    2. Heart-rate variability -- RR intervals jitter a couple of percent,
       because a metronome-perfect heart is an instant tell.
    3. Respiratory modulation -- 0.25 Hz baseline wander plus amplitude
       modulation of the QRS (real respiratory sinus arrhythmia effect).
    4. AD8232 analog front end -- x1100 gain, 1.5 V baseline offset.
    5. Corruption -- Gaussian sensor noise, 60 Hz mains hum, and occasional
       motion artifacts (the electrode-tug transients you always get).
    6. Arduino ADC -- clip to the rail, quantise to 10 bits.

Output units: ADC counts, 0..1023. Identical to SerialSource.
"""

from __future__ import annotations

import time

import numpy as np

import config
from .source import ECGSource, SourceStatus


class SimulatedSource(ECGSource):
    """Real-time-paced generator of synthetic single-lead ECG."""

    name = "simulator"

    # PQRST template, expressed as (label, offset_ms_from_R, sigma_ms, amplitude_mV).
    # Amplitudes are tuned so the QRS complex spans ~1.0 mV peak-to-peak, which
    # is the textbook lead-I amplitude and what the PRD asks for.
    _WAVES = (
        ("P", -160.0, 25.0, 0.13),
        ("Q", -22.0, 8.0, -0.11),
        ("R", 0.0, 8.5, 0.85),
        ("S", 24.0, 11.0, -0.15),
        ("T", 185.0, 45.0, 0.32),
    )

    def __init__(
        self,
        sample_rate: int = config.SAMPLE_RATE,
        bpm: float = config.SIM_DEFAULT_BPM,
        noise: float = config.SIM_DEFAULT_NOISE,
        artifacts: bool = config.SIM_DEFAULT_ARTIFACTS,
        seed: int | None = None,
    ) -> None:
        super().__init__(sample_rate)
        self.bpm = float(bpm)
        self.noise = float(noise)
        self.artifacts = bool(artifacts)

        self._rng = np.random.default_rng(seed)
        self._running = False

        # Wall-clock pacing state: we emit exactly `sample_rate` samples per
        # real second, no matter how often read() happens to be called.
        self._t0 = 0.0
        self._emitted = 0

        # Beat template state (regenerated whenever the RR interval changes).
        self._template = np.zeros(1, dtype=np.float64)
        self._template_pos = 0

        # Continuous phase for the slow modulators, so they never glitch at a
        # batch boundary.
        self._sample_clock = 0  # total samples generated, for sin() phases

        # Motion-artifact state: samples remaining + its decaying waveform.
        self._artifact: np.ndarray | None = None
        self._artifact_pos = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._t0 = time.monotonic()
        self._started_at = self._t0
        self._emitted = 0
        self._sample_clock = 0
        self._template_pos = 0
        self._build_template()

    def stop(self) -> None:
        self._running = False
        self._artifact = None

    # -- configuration (live-adjustable from the UI) ------------------------

    def configure(
        self,
        bpm: float | None = None,
        noise: float | None = None,
        artifacts: bool | None = None,
    ) -> None:
        """Apply UI changes. Takes effect at the next beat boundary."""
        if bpm is not None:
            self.bpm = float(np.clip(bpm, 30.0, 200.0))
        if noise is not None:
            self.noise = float(np.clip(noise, 0.0, 1.0))
        if artifacts is not None:
            self.artifacts = bool(artifacts)

    # -- data --------------------------------------------------------------

    def read(self) -> np.ndarray:
        """Emit however many samples real time says are now due."""
        if not self._running:
            return self._empty()

        elapsed = time.monotonic() - self._t0
        due = int(elapsed * self.sample_rate) - self._emitted
        if due <= 0:
            return self._empty()

        # Guard against a huge burst if the process was suspended (laptop lid,
        # debugger breakpoint, a machine pinned at 100% CPU). Drop the backlog
        # rather than flooding the UI -- but record it, because the resulting
        # splice in the waveform is indistinguishable from a QRS to a detector
        # that has not been told about it.
        #
        # The threshold is 3 s rather than 1 s deliberately. Generating a
        # backlog is cheap (it is vectorised numpy), whereas a splice costs an
        # RR interval and therefore a visibly wrong heart rate. On a busy
        # machine sub-second stalls are routine, so a 1 s threshold spends
        # accuracy to save work we can easily afford.
        max_burst = 3 * self.sample_rate
        if due > max_burst:
            self._emitted += due - max_burst
            due = max_burst
            self.discontinuities += 1

        self._emitted += due
        return self._generate(due)

    def status(self) -> SourceStatus:
        return SourceStatus(
            mode="simulating" if self._running else "idle",
            label="Simulating" if self._running else "Disconnected",
            port=None,
            baud=None,
            sample_rate=self.sample_rate,
            leads_off=False,
            detail=f"Synthetic AD8232 @ {self.bpm:.0f} BPM",
            extra={
                "bpm": round(self.bpm, 1),
                "noise": round(self.noise, 3),
                "artifacts": self.artifacts,
            },
        )

    # -- internals ---------------------------------------------------------

    def _build_template(self) -> None:
        """
        Render one full cardiac cycle at the current BPM (plus a dash of HRV).

        The template is laid out so the R-peak sits ~30% of the way in, which
        leaves room ahead of it for the P wave. Because we read the template
        circularly, the P wave of beat N+1 naturally trails the T wave of beat
        N with no special-case stitching.
        """
        fs = self.sample_rate

        # Heart-rate variability: +/-2.5% on the RR interval. Real hearts are
        # never metronomes, and this also exercises the detector's adaptive
        # threshold in a way a fixed rate would not.
        jitter = 1.0 + self._rng.normal(0.0, 0.025)
        jitter = float(np.clip(jitter, 0.9, 1.1))
        rr_seconds = (60.0 / self.bpm) * jitter
        # The template length IS the beat period, so this floor must never bind
        # inside the supported rate range: a floor longer than the RR interval
        # does not shorten the beat, it pins the simulated rate at the floor and
        # renders the waves against a period the array cannot hold. At 1000 Hz
        # a 60-sample floor is 1000 BPM and is unreachable, but at 125 Hz it is
        # 125 BPM, which capped the simulator mid-slider. Guard degeneracy only.
        n = max(int(round(rr_seconds * fs)), 2)

        t_ms = (np.arange(n, dtype=np.float64) / fs) * 1000.0
        r_index_ms = t_ms[int(0.30 * n)]

        beat = np.zeros(n, dtype=np.float64)
        for _label, offset_ms, sigma_ms, amp_mv in self._WAVES:
            centre = r_index_ms + offset_ms
            # Circular distance, so a wave whose centre falls off either end of
            # the template wraps cleanly instead of being clipped.
            d = t_ms - centre
            period_ms = rr_seconds * 1000.0
            d = (d + period_ms / 2.0) % period_ms - period_ms / 2.0
            beat += amp_mv * np.exp(-0.5 * (d / sigma_ms) ** 2)

        self._template = beat
        self._template_pos = 0

    def _next_beat_chunk(self, count: int) -> np.ndarray:
        """Read `count` samples from the circular beat template, in millivolts."""
        out = np.empty(count, dtype=np.float64)
        written = 0
        while written < count:
            remaining_in_template = len(self._template) - self._template_pos
            take = min(count - written, remaining_in_template)
            out[written : written + take] = self._template[
                self._template_pos : self._template_pos + take
            ]
            written += take
            self._template_pos += take
            if self._template_pos >= len(self._template):
                # Beat finished -- rebuild with fresh HRV and any new BPM the
                # user dialled in mid-beat.
                self._build_template()
        return out

    def _generate(self, count: int) -> np.ndarray:
        fs = self.sample_rate
        n0 = self._sample_clock
        self._sample_clock += count
        t = (np.arange(n0, n0 + count, dtype=np.float64)) / fs

        # 1-3. Physiology, in millivolts at the electrodes.
        ecg_mv = self._next_beat_chunk(count)

        # Respiratory sinus arrhythmia: breathing swings QRS amplitude ~8%.
        breath = np.sin(2.0 * np.pi * config.SIM_BREATHING_HZ * t)
        ecg_mv *= 1.0 + 0.08 * breath

        # 4. AD8232 front end: gain then offset. Now in volts at the OUT pin.
        volts = config.AD8232_BASELINE_V + ecg_mv * (config.AD8232_GAIN / 1000.0)

        # Baseline wander from chest movement, also breathing-locked.
        volts += 0.045 * breath

        # 5. Corruption.
        if self.noise > 0.0:
            # Broadband sensor/EMG noise.
            volts += self._rng.normal(0.0, 0.055 * self.noise, count)
            # Mains hum -- the single most characteristic ECG artifact, and the
            # exact thing the 60 Hz notch filter downstream exists to remove.
            volts += (0.030 * self.noise) * np.sin(
                2.0 * np.pi * config.MAINS_HZ * t + 0.7
            )

        if self.artifacts:
            volts += self._artifact_chunk(count)

        # 6. Arduino ADC: clip to the rail, then quantise to 10 bits.
        counts = volts * (config.ADC_MAX / config.ADC_VREF)
        np.clip(counts, 0, config.ADC_MAX, out=counts)
        return np.round(counts)

    def _artifact_chunk(self, count: int) -> np.ndarray:
        """
        Occasional motion artifact: a sharp electrode-tug transient that decays
        over 150-400 ms. Roughly one every ~12 seconds.
        """
        out = np.zeros(count, dtype=np.float64)
        pos = 0

        while pos < count:
            if self._artifact is None:
                # Poisson-ish trigger, evaluated per sample.
                p_per_sample = 1.0 / (12.0 * self.sample_rate)
                if self._rng.random() > p_per_sample * (count - pos):
                    break
                dur = int(self._rng.uniform(0.15, 0.40) * self.sample_rate)
                amp = self._rng.uniform(0.15, 0.5) * self._rng.choice([-1.0, 1.0])
                decay = np.exp(-np.linspace(0.0, 5.0, dur))
                wobble = np.sin(np.linspace(0.0, self._rng.uniform(3.0, 9.0), dur))
                self._artifact = amp * decay * (0.7 + 0.3 * wobble)
                self._artifact_pos = 0

            remaining = len(self._artifact) - self._artifact_pos
            take = min(count - pos, remaining)
            out[pos : pos + take] += self._artifact[
                self._artifact_pos : self._artifact_pos + take
            ]
            pos += take
            self._artifact_pos += take
            if self._artifact_pos >= len(self._artifact):
                self._artifact = None

        return out
