// GENERATED FILE -- do not edit by hand.
// Produced by backend/export_dsp.py from the scipy filter designs in
// backend/ecg/filters.py. Regenerate after changing any filter constant:
//
//     cd backend && .venv/bin/python export_dsp.py
//
// Keeping scipy as the source of truth means the browser's offline DSP and
// the server's DSP cannot drift apart -- verify_dsp.py asserts they agree
// sample-for-sample.

export const SAMPLE_RATE = 125;
export const MAINS_HZ = 50.0;
export const ADC_MAX = 1023;
export const ADC_VREF = 5.0;
export const AD8232_GAIN = 1100.0;
export const AD8232_BASELINE_V = 1.5;
export const SIM_BREATHING_HZ = 0.25;

export const QRS_INTEGRATION_MS = 150;
export const QRS_REFRACTORY_MS = 200;
export const BPM_MIN = 25.0;
export const BPM_MAX = 240.0;

// Display chain: 0.5 Hz high-pass -> 50 Hz notch ->
// 100 Hz notch -> 40 Hz low-pass.
export const ECG_SOS = [
    [0.982385438526092, -1.964770877052184, 0.982385438526092, 1.0, -1.9644605802052324, 0.9650811738991353],
    [0.95977356895352, 1.5529462560705858, 0.95977356895352, 1.0, 1.552946256070586, 0.9195471379070398],
    [0.20561452486753623, 0.41122904973507246, 0.20561452486753623, 1.0, 0.4638241941309157, 0.08935357665234994],
    [1.0, 2.0, 1.0, 1.0, 0.6325354049721967, 0.4855945732990751],
  ];

// Unit-step steady state, scaled by the first sample to prime the delay line.
// Without priming, the high-pass rings for seconds at startup.
export const ECG_ZI = [
    [-0.9823854385260364, 0.9823854385260384],
    [0.0, 0.0],
    [0.0, 0.0],
    [0.0, 0.0],
  ];

// QRS detector front end: 5-15 Hz band-pass.
export const QRS_SOS = [
    [0.01018257673643693, 0.02036515347287386, 0.01018257673643693, 1.0, -1.439786547927553, 0.5913983513994713],
    [1.0, 0.0, -1.0, 1.0, -1.2823329392866671, 0.7030006898068755],
    [1.0, -2.0, 1.0, 1.0, -1.8049684603984224, 0.8702175029734399],
  ];
export const QRS_ZI = [
    [0.25846607734603894, -0.14869579439362612],
    [-0.2686486540824759, -0.2686486540824759],
    [-0.0, 0.0],
  ];
