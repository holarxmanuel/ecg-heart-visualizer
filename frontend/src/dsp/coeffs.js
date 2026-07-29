// GENERATED FILE -- do not edit by hand.
// Produced by backend/export_dsp.py from the scipy filter designs in
// backend/ecg/filters.py. Regenerate after changing any filter constant:
//
//     cd backend && .venv/bin/python export_dsp.py
//
// Keeping scipy as the source of truth means the browser's offline DSP and
// the server's DSP cannot drift apart -- verify_dsp.py asserts they agree
// sample-for-sample.

export const SAMPLE_RATE = 1000;
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
    [0.9977810241029411, -1.9955620482058822, 0.9977810241029411, 1.0, -1.995557124345789, 0.9955669720659747],
    [0.9947912376593769, -1.8922053778585424, 0.9947912376593768, 1.0, -1.8922053778585421, 0.9895824753187538],
    [0.9896361753628921, -1.6012649682336104, 0.989636175362892, 1.0, -1.6012649682336102, 0.9792723507257837],
    [0.0001832160233696094, 0.0003664320467392188, 0.0001832160233696094, 1.0, -1.5752399777881516, 0.6263342591591414],
    [1.0, 2.0, 1.0, 1.0, -1.7688278599237215, 0.8262013329476159],
  ];

// Unit-step steady state, scaled by the first sample to prime the delay line.
// Without priming, the high-pass rings for seconds at startup.
export const ECG_ZI = [
    [-0.9977810241128645, 0.9977810241128205],
    [0.0, 0.0],
    [0.0, 0.0],
    [0.0, -0.0],
    [0.0, -0.0],
  ];

// QRS detector front end: 5-15 Hz band-pass.
export const QRS_SOS = [
    [2.9146494465697647e-05, 5.8292988931395294e-05, 2.9146494465697647e-05, 1.0, -1.9361916025752068, 0.9390625058174927],
    [1.0, 0.0, -1.0, 1.0, -1.9473993593261043, 0.9552104892146577],
    [1.0, -2.0, 1.0, 1.0, -1.9820685782158847, 0.9831558692142692],
  ];
export const QRS_ZI = [
    [0.04058036487658208, -0.03810572301365439],
    [-0.04060951137104962, -0.0406095113710485],
    [-0.0, 0.0],
  ];
