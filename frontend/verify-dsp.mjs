/**
 * JS half of the DSP equivalence check. Driven by backend/verify_dsp.py.
 *
 *   node verify-dsp.mjs <input.json> <output.json>
 *
 * Reads raw ADC counts, runs the browser filter + detector over them in the
 * same 20 ms chunks the server uses, and writes back the filtered trace and
 * every beat. The Python side then asserts the two agree.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { ECGFilter } from './src/dsp/filters.js';
import { RPeakDetector } from './src/dsp/detector.js';
import { SimulatedSource } from './src/dsp/simulator.js';
import { ADC_MAX, ADC_VREF } from './src/dsp/coeffs.js';

const [, , inPath, outPath] = process.argv;
const job = JSON.parse(readFileSync(inPath, 'utf8'));

function runChain(raw, chunkSize) {
  const filter = new ECGFilter();
  const detector = new RPeakDetector();
  const voltsPerCount = ADC_VREF / ADC_MAX;

  const filtered = [];
  const beats = [];

  for (let i = 0; i < raw.length; i += chunkSize) {
    const chunk = raw.slice(i, i + chunkSize);
    const volts = new Float64Array(chunk.length);
    for (let k = 0; k < chunk.length; k++) volts[k] = chunk[k] * voltsPerCount;

    const f = filter.process(volts);
    for (let k = 0; k < f.length; k++) filtered.push(f[k]);

    for (const b of detector.process(f)) {
      beats.push({ global_index: b.globalIndex, number: b.number, bpm: b.bpm, rr_ms: b.rrMs });
    }
  }

  return { filtered, beats, bpm: detector.bpm, beat_count: detector.beatCount };
}

const result = { mode: job.mode };

if (job.mode === 'chain') {
  Object.assign(result, runChain(job.raw, job.chunk));
} else if (job.mode === 'simulate') {
  // JS simulator -> JS detector, mirroring selftest.py: does the chain recover
  // the BPM it was asked to generate?
  const cases = [];
  for (const c of job.cases) {
    const sim = new SimulatedSource({
      bpm: c.bpm,
      noise: c.noise,
      artifacts: c.artifacts,
      seed: c.seed,
    });
    const raw = Array.from(sim.generateForTest(c.samples));
    const out = runChain(raw, job.chunk);
    cases.push({
      bpm: c.bpm,
      noise: c.noise,
      measured: out.bpm,
      beats: out.beat_count,
    });
  }
  result.cases = cases;
}

writeFileSync(outPath, JSON.stringify(result));
