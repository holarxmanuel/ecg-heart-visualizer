"""
Offline self-test for the ECG signal chain.

Runs the simulator -> filter -> R-peak detector pipeline at several heart rates
and noise levels and checks the detected BPM against ground truth. This is the
proof that the processing is correct *before* any hardware or browser is
involved -- and the regression test to re-run after touching filters.py or
detector.py.

    python selftest.py
"""

from __future__ import annotations

import sys
import time

import numpy as np

import config
from ecg import ECGFilter, RPeakDetector, SimulatedSource


def run_case(bpm: float, noise: float, seconds: float = 20.0) -> dict:
    """Feed `seconds` of synthetic ECG through the real pipeline, offline."""
    fs = config.SAMPLE_RATE
    src = SimulatedSource(bpm=bpm, noise=noise, artifacts=True, seed=7)
    src.start()

    filt = ECGFilter()
    det = RPeakDetector()

    chunk = int(config.BATCH_INTERVAL_MS * fs / 1000)  # same 20 ms batches as live
    total = int(seconds * fs)
    beats: list[int] = []

    t_start = time.perf_counter()
    for _ in range(total // chunk):
        # Bypass the wall-clock pacing so the test runs at full speed.
        raw = src._generate(chunk)  # noqa: SLF001 - deliberate, test-only
        volts = raw * (config.ADC_VREF / config.ADC_MAX)
        f = filt.process(volts)
        for b in det.process(f):
            beats.append(b.global_index)
    elapsed = time.perf_counter() - t_start

    # Ignore the detector's 1.5 s learning phase when scoring.
    warm = [i for i in beats if i > 2.0 * fs]
    if len(warm) < 3:
        return {
            "bpm_set": bpm,
            "noise": noise,
            "detected": len(warm),
            "bpm_measured": 0.0,
            "error": 999.0,
            "rt_factor": seconds / elapsed,
            "ok": False,
        }

    rr = np.diff(warm) / fs
    measured = 60.0 / float(np.median(rr))
    expected_beats = (seconds - 2.0) * bpm / 60.0
    err = abs(measured - bpm)

    # Pass criteria: rate within tolerance, and beat count within 8% of
    # expected (which catches both missed beats and double-counted T waves).
    #
    # The tolerance cannot be a flat 2 BPM at every sample rate. An RR interval
    # is measured in whole samples, so one sample of quantisation is worth
    # bpm^2 / (60 * fs) BPM, and that grows with the square of the rate: at
    # 1000 Hz it is 0.5 BPM at 180 BPM and irrelevant, but at 125 Hz it is
    # 4.3 BPM, and demanding 2 BPM there asks for precision the sample rate
    # cannot express. The estimator is a median of whole-sample RR intervals,
    # so it can only ever return 60*fs/k for integer k: at 180 BPM and 125 Hz
    # the only achievable readings either side are 178.57 and 182.93, and RR
    # jitter decides which one the median lands on. Allow one full quantum, or
    # 2 BPM, whichever is larger, so this measures the detector rather than the
    # timebase. At 1000 Hz the quantum is under 0.6 BPM across the whole range,
    # so this leaves the original tolerance in force exactly as before.
    quantum = (bpm * bpm) / (60.0 * fs)
    tolerance = max(2.0, quantum)
    count_ratio = len(warm) / expected_beats
    ok = err <= tolerance and 0.92 <= count_ratio <= 1.08

    return {
        "bpm_set": bpm,
        "noise": noise,
        "detected": len(warm),
        "expected": round(expected_beats, 1),
        "bpm_measured": round(measured, 2),
        "error": round(err, 2),
        "rt_factor": round(seconds / elapsed, 1),
        "ok": ok,
    }


def run_step_change(bpm: float, noise_a: float, noise_b: float, seconds: float = 30.0) -> dict:
    """
    The realistic hard case: conditions change *after* the detector has already
    learned its thresholds.

    On real hardware this is an electrode drying out, the patient moving, or a
    charger being plugged in. In the app it is the noise slider. A detector
    whose "adaptive" threshold only adapts downward will start counting noise
    peaks as beats the moment the noise floor rises above where it learned.
    """
    fs = config.SAMPLE_RATE
    src = SimulatedSource(bpm=bpm, noise=noise_a, artifacts=True, seed=11)
    src.start()
    filt = ECGFilter()
    det = RPeakDetector()

    chunk = int(config.BATCH_INTERVAL_MS * fs / 1000)
    total = int(seconds * fs)
    switch_at = total // 2

    beats_before: list[int] = []
    beats_after: list[int] = []

    for i in range(total // chunk):
        sample_no = i * chunk
        if sample_no >= switch_at:
            src.configure(noise=noise_b)

        raw = src._generate(chunk)  # noqa: SLF001 - test-only
        f = filt.process(raw * (config.ADC_VREF / config.ADC_MAX))
        for b in det.process(f):
            (beats_before if b.global_index < switch_at else beats_after).append(
                b.global_index
            )

    half_seconds = switch_at / fs
    expected_half = half_seconds * bpm / 60.0
    after = [i for i in beats_after if i > switch_at + fs]  # skip the transition
    expected_after = (seconds - half_seconds - 1.0) * bpm / 60.0
    ratio = len(after) / expected_after if expected_after else 0

    return {
        "bpm": bpm,
        "noise_a": noise_a,
        "noise_b": noise_b,
        "before": len(beats_before),
        "expect_before": round(expected_half, 1),
        "after": len(after),
        "expect_after": round(expected_after, 1),
        "ratio": round(ratio, 2),
        # Wider than the steady-state tolerance: the window is short enough
        # that beat-phase alignment alone moves the count by +/-1, which is
        # already 6% of a 17-beat window.
        "ok": 0.90 <= ratio <= 1.12,
    }


def run_splice(bpm: float = 72.0, splices: int = 12, notify: bool = True) -> dict:
    """
    Simulate lost samples and check we do not invent beats.

    A splice -- the seam left when samples go missing -- is a step edge, and a
    step edge run through band-pass/derivative/square looks exactly like a QRS.
    This is what happens when the machine is pinned at 100% CPU, or when the
    serial link drops bytes. `notify=False` reproduces the old behaviour so the
    fix is measurable rather than merely asserted.
    """
    fs = config.SAMPLE_RATE
    src = SimulatedSource(bpm=bpm, noise=0.2, artifacts=True, seed=3)
    src.start()
    filt = ECGFilter()
    det = RPeakDetector()

    chunk = int(config.BATCH_INTERVAL_MS * fs / 1000)
    seconds = 40.0
    n_chunks = int(seconds * fs) // chunk
    # Space the dropouts evenly through the run, after the learning phase.
    splice_at = {int(n_chunks * (i + 1) / (splices + 1)) for i in range(splices)}

    beats = 0
    for i in range(n_chunks):
        if i in splice_at and i * chunk > 2 * fs:
            # Throw away 0.4 s of signal, exactly as a backlog drop would.
            src._generate(int(0.4 * fs))  # noqa: SLF001 - test-only
            if notify:
                det.notify_discontinuity()

        raw = src._generate(chunk)  # noqa: SLF001 - test-only
        f = filt.process(raw * (config.ADC_VREF / config.ADC_MAX))
        for b in det.process(f):
            if b.global_index > 2 * fs:
                beats += 1

    expected = (seconds - 2.0) * bpm / 60.0
    ratio = beats / expected
    reported = det.bpm  # the number the dashboard would be showing
    return {
        "beats": beats,
        "expected": round(expected, 1),
        "ratio": round(ratio, 2),
        "reported_bpm": round(reported, 1),
        "bpm_error": round(abs(reported - bpm), 1),
        "suppressed": det.suppressed_beats,
        # Both must hold: neither invent beats, nor misreport the rate.
        "ok": 0.94 <= ratio <= 1.06 and abs(reported - bpm) <= 3.0,
    }


def main() -> int:
    print(f"ECG pipeline self-test  ({config.SAMPLE_RATE} Hz, "
          f"{config.BATCH_INTERVAL_MS} ms batches)")
    print("-" * 78)
    print(f"{'BPM':>5} {'noise':>6} {'beats':>7} {'expect':>7} "
          f"{'measured':>9} {'err':>6} {'xRT':>7}  result")
    print("-" * 78)

    cases = [
        (60, 0.0), (60, 0.15), (60, 0.5), (60, 1.0),
        (75, 0.3), (90, 0.2), (110, 0.3), (120, 0.5),
        (45, 0.2), (150, 0.3),
        # The hard corner: a fast rate leaves little room between beats, so
        # heavy noise there is where a detector starts inventing extra ones.
        (100, 1.0), (120, 0.8), (120, 1.0), (150, 1.0), (180, 0.6),
    ]

    failures = 0
    for bpm, noise in cases:
        r = run_case(bpm, noise)
        if not r["ok"]:
            failures += 1
        print(
            f"{r['bpm_set']:>5.0f} {r['noise']:>6.2f} {r['detected']:>7} "
            f"{r.get('expected', 0):>7} {r['bpm_measured']:>9.2f} "
            f"{r['error']:>6.2f} {r['rt_factor']:>6.0f}x  "
            f"{'PASS' if r['ok'] else 'FAIL'}"
        )

    print("-" * 78)

    # --- conditions changing mid-recording --------------------------------
    print("\nStep-change cases (thresholds learned under one condition, then changed)")
    print("-" * 78)
    print(f"{'BPM':>5} {'noise':>12} {'before':>8} {'after':>7} {'expect':>7} "
          f"{'ratio':>6}  result")
    print("-" * 78)

    step_cases = [
        (60, 0.15, 1.0),
        (120, 0.15, 1.0),
        (120, 1.0, 0.05),
        (75, 0.1, 0.8),
    ]
    for bpm, a, b in step_cases:
        r = run_step_change(bpm, a, b)
        if not r["ok"]:
            failures += 1
        print(
            f"{r['bpm']:>5.0f} {a:>5.2f}->{b:<5.2f} {r['before']:>8} "
            f"{r['after']:>7} {r['expect_after']:>7} {r['ratio']:>6.2f}  "
            f"{'PASS' if r['ok'] else 'FAIL'}"
        )

    # --- lost samples -----------------------------------------------------
    print("\nWaveform splices (lost samples, e.g. CPU starvation or serial dropout)")
    print("-" * 78)
    unguarded = run_splice(notify=False)
    guarded = run_splice(notify=True)
    print(f"  splice unhandled : {unguarded['beats']:>4} beats "
          f"(ratio {unguarded['ratio']}), reports "
          f"{unguarded['reported_bpm']} BPM -- error {unguarded['bpm_error']}")
    print(f"  splice handled   : {guarded['beats']:>4} beats "
          f"(ratio {guarded['ratio']}), reports "
          f"{guarded['reported_bpm']} BPM -- error {guarded['bpm_error']}   "
          f"{'PASS' if guarded['ok'] else 'FAIL'}")
    if not guarded["ok"]:
        failures += 1

    total_cases = len(cases) + len(step_cases) + 1
    print("-" * 78)
    if failures:
        print(f"{failures}/{total_cases} cases FAILED")
        return 1

    print(f"All {total_cases} cases passed.")
    print("'xRT' = times faster than real time; anything above ~50x means the")
    print("backend will sit near idle while streaming.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
