"""
Prove the browser DSP matches the server DSP.

The Python signal chain is the verified reference -- selftest.py pins it to
+/-0.5 BPM across 45-180 BPM and 0-100% noise. Once a second implementation
exists in JavaScript for offline mode, the risk is no longer "is the algorithm
right" but "do the two agree". A browser that quietly reports a different heart
rate offline than online is a worse failure than one that refuses to run.

So this uses the Python as an oracle, exactly as the handover suggested:

  1. Feed IDENTICAL raw ADC counts to both chains, in the same 20 ms chunks,
     and compare the filtered output sample-for-sample and the beats one by one.
  2. Run the JS simulator into the JS detector and check it recovers the BPM
     it was asked to generate -- the same property selftest.py asserts for the
     Python simulator. (The two simulators cannot be compared sample-wise:
     numpy's PCG64 and the JS PRNG produce different noise by construction.)

Run:  .venv/bin/python verify_dsp.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

import config
from ecg.filters import ECGFilter
from ecg.detector import RPeakDetector
from ecg.simulator import SimulatedSource

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
CHUNK = int(config.SAMPLE_RATE * config.BATCH_INTERVAL_MS / 1000)  # 20 samples

# Sample-level tolerance. The two implementations do identical arithmetic in
# the same order, so they should agree to near machine epsilon; anything above
# this means a real structural difference, not float noise.
ATOL_V = 1e-9


def run_node(job: dict) -> dict:
    with tempfile.TemporaryDirectory() as td:
        inp = Path(td) / "in.json"
        out = Path(td) / "out.json"
        inp.write_text(json.dumps(job))
        proc = subprocess.run(
            ["node", "verify-dsp.mjs", str(inp), str(out)],
            cwd=FRONTEND,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr, file=sys.stderr)
            raise SystemExit("node harness failed")
        return json.loads(out.read_text())


def python_chain(raw: np.ndarray) -> tuple[np.ndarray, list]:
    """The server's chain, chunked exactly as main.py chunks it."""
    filt = ECGFilter()
    det = RPeakDetector()
    volts_per_count = config.ADC_VREF / config.ADC_MAX

    filtered_all: list[np.ndarray] = []
    beats: list[dict] = []

    for i in range(0, raw.size, CHUNK):
        chunk = raw[i : i + CHUNK]
        f = filt.process(chunk * volts_per_count)
        filtered_all.append(f)
        for b in det.process(f):
            beats.append(
                {
                    "global_index": b.global_index,
                    "number": b.number,
                    "bpm": b.bpm,
                    "rr_ms": b.rr_ms,
                }
            )

    return np.concatenate(filtered_all), beats, det


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{('  -- ' + detail) if detail else ''}")
    return ok


def main() -> None:
    print("=" * 74)
    print("  JS DSP equivalence -- Python signal chain as the oracle")
    print("=" * 74)

    failures = 0

    # ---- Part 1: identical input, both chains -----------------------------
    print("\nPart 1: identical raw ADC input through both chains")
    print("-" * 74)

    for bpm, noise, artifacts, seconds in (
        (60.0, 0.0, False, 12),
        (60.0, 0.30, False, 12),
        (120.0, 0.60, True, 12),
        (150.0, 1.00, True, 10),
        (45.0, 0.15, True, 12),
    ):
        # Generate with the PYTHON simulator so both sides see the same bytes.
        sim = SimulatedSource(bpm=bpm, noise=noise, artifacts=artifacts, seed=12345)
        sim.start()
        raw = sim._generate(int(seconds * config.SAMPLE_RATE))

        py_filt, py_beats, py_det = python_chain(raw)
        js = run_node({"mode": "chain", "raw": [int(v) for v in raw], "chunk": CHUNK})
        js_filt = np.asarray(js["filtered"], dtype=np.float64)

        label = f"{bpm:5.0f} BPM  noise {noise:.2f}  artifacts {int(artifacts)}"

        same_len = js_filt.size == py_filt.size
        if not same_len:
            failures += not check(
                f"{label}  filtered length", False, f"{js_filt.size} vs {py_filt.size}"
            )
            continue

        max_err = float(np.max(np.abs(js_filt - py_filt)))
        ok_filt = max_err < ATOL_V
        if not check(f"{label}  filtered trace", ok_filt, f"max |diff| = {max_err:.3e} V"):
            failures += 1

        # Beats: same count, same sample index, same reported rate.
        ok_count = len(js["beats"]) == len(py_beats)
        if not check(
            f"{label}  beat count", ok_count, f"{len(js['beats'])} vs {len(py_beats)}"
        ):
            failures += 1
            continue

        idx_err = max(
            (abs(a["global_index"] - b["global_index"]) for a, b in zip(js["beats"], py_beats)),
            default=0,
        )
        bpm_err = max(
            (abs(a["bpm"] - b["bpm"]) for a, b in zip(js["beats"], py_beats)), default=0.0
        )
        if not check(
            f"{label}  beat positions", idx_err == 0, f"max index drift = {idx_err} samples"
        ):
            failures += 1
        if not check(f"{label}  beat rates", bpm_err < 0.05, f"max |dBPM| = {bpm_err:.3f}"):
            failures += 1

        rate_err = abs(js["bpm"] - py_det.bpm)
        if not check(
            f"{label}  reported BPM", rate_err < 0.05, f"JS {js['bpm']:.1f} / PY {py_det.bpm:.1f}"
        ):
            failures += 1

    # ---- Part 2: JS simulator recovers its own BPM ------------------------
    print("\nPart 2: JS simulator -> JS detector recovers the generated rate")
    print("-" * 74)

    cases = [
        {"bpm": b, "noise": n, "artifacts": a, "seed": 7, "samples": 20 * config.SAMPLE_RATE}
        for b, n, a in (
            (45.0, 0.10, False),
            (60.0, 0.00, False),
            (60.0, 0.50, True),
            (75.0, 0.30, True),
            (100.0, 0.60, True),
            (120.0, 1.00, True),
            (150.0, 0.60, True),
            (180.0, 0.40, True),
        )
    ]
    js = run_node({"mode": "simulate", "chunk": CHUNK, "cases": cases})

    print(f"  {'BPM':>5} {'noise':>6} {'beats':>6} {'measured':>9} {'err':>7}")
    for c in js["cases"]:
        err = abs(c["measured"] - c["bpm"])
        # Same tolerance selftest.py uses for the Python chain.
        ok = err <= 2.0 and c["beats"] > 0
        status = "PASS" if ok else "FAIL"
        print(
            f"  {c['bpm']:5.0f} {c['noise']:6.2f} {c['beats']:6d} "
            f"{c['measured']:9.2f} {err:7.2f}  {status}"
        )
        if not ok:
            failures += 1

    print("-" * 74)
    if failures:
        print(f"{failures} check(s) FAILED -- the browser DSP does not match the server.")
        raise SystemExit(1)
    print("All checks passed. Browser DSP is equivalent to the server DSP.")


if __name__ == "__main__":
    main()
