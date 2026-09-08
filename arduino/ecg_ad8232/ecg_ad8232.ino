/*
 * ============================================================================
 *  AD8232 Single-Lead ECG  ->  Arduino Uno R3  ->  USB Serial
 *  Companion sketch for the Real-Time ECG Heart Visualizer
 * ============================================================================
 *
 *  Upload this, then click "Arduino" in the web app. Nothing else to change:
 *  the sketch emits exactly the format backend/ecg/serial_source.py parses,
 *  at exactly the rate backend/config.py expects.
 *
 *  ---------------------------------------------------------------------------
 *  WIRING  (AD8232 breakout  ->  Arduino Uno R3)
 *  ---------------------------------------------------------------------------
 *      AD8232 GND     ->  Uno GND
 *      AD8232 3.3V    ->  Uno 3.3V        <-- 3.3V, NOT 5V. 5V damages it.
 *      AD8232 OUTPUT  ->  Uno A0
 *      AD8232 LO+     ->  Uno D10
 *      AD8232 LO-     ->  Uno D11
 *      AD8232 SDN     ->  not connected (or tie to 3.3V to keep it awake)
 *
 *  IMPORTANT -- ANALOG REFERENCE
 *  The AD8232 runs on 3.3 V, so its output never exceeds 3.3 V, while the Uno's
 *  ADC by default measures against 5 V. That works, but you throw away a third
 *  of your resolution. Two options:
 *
 *    (a) Leave as-is. Set ADC_VREF = 5.0 in backend/config.py  (the default).
 *    (b) Wire Uno 3.3V -> AREF, uncomment USE_EXTERNAL_AREF below, and set
 *        ADC_VREF = 3.3 in backend/config.py. Better resolution.
 *        If you enable AREF you MUST have the wire in place before powering on,
 *        or you short the internal reference.
 *
 *  ---------------------------------------------------------------------------
 *  ELECTRODE PLACEMENT  (Einthoven's Lead I)
 *  ---------------------------------------------------------------------------
 *      RED    (+)  ->  left wrist,  or left side of chest below the collarbone
 *      YELLOW (-)  ->  right wrist, or right side of chest below the collarbone
 *      GREEN (REF) ->  right hip / right ankle / a bony spot away from muscle
 *
 *  Use fresh gel electrodes. Dried-out pads are the number one cause of a
 *  noisy, wandering trace. Sit still: skeletal muscle EMG swamps a 1 mV signal.
 *
 *  ---------------------------------------------------------------------------
 *  OUTPUT FORMAT
 *  ---------------------------------------------------------------------------
 *      "512,0\n"   ADC value (0-1023), leads-off flag (0 = attached)
 *      "!\n"       leads are off; no valid sample this tick
 *
 *  ---------------------------------------------------------------------------
 *  BANDWIDTH NOTE
 *  ---------------------------------------------------------------------------
 *  1000 samples/s x up to 7 bytes/line = ~7 kB/s = ~70 kbit/s with framing.
 *  At 115200 baud that is roughly 60% utilisation -- comfortable. Do NOT lower
 *  the baud rate without also lowering SAMPLE_RATE_HZ, or the serial buffer
 *  will overflow and you will silently lose samples.
 * ============================================================================
 */

// ---- configuration ---------------------------------------------------------

const uint16_t SAMPLE_RATE_HZ = 125;    // must match SAMPLE_RATE in config.py
const uint32_t BAUD           = 115200; // must match SERIAL_BAUD in config.py

const uint8_t PIN_ECG   = A0;
const uint8_t PIN_LO_P  = 10;
const uint8_t PIN_LO_N  = 11;

// Uncomment ONLY if you have physically wired Uno 3.3V to the AREF pin.
// #define USE_EXTERNAL_AREF

// Emit the leads-off flag as a second CSV column. Costs 2 bytes/sample.
// Turn off if you ever need the extra bandwidth headroom.
#define SEND_LEADS_OFF_COLUMN

// ---- state -----------------------------------------------------------------

const uint32_t PERIOD_US = 1000000UL / SAMPLE_RATE_HZ;
uint32_t nextSampleAt = 0;

void setup() {
  Serial.begin(BAUD);

  pinMode(PIN_LO_P, INPUT);
  pinMode(PIN_LO_N, INPUT);

#ifdef USE_EXTERNAL_AREF
  analogReference(EXTERNAL);
  // Discard the first conversions: the reference needs a moment to settle.
  for (uint8_t i = 0; i < 8; i++) analogRead(PIN_ECG);
#endif

  /*
   * Speed up the ADC.
   *
   * The Arduino core leaves the ADC prescaler at 128, giving a 125 kHz ADC
   * clock and a ~112 us conversion. That fits inside a 1000 us budget, but it
   * leaves little room and adds jitter, and jitter in the sample clock shows up
   * as spurious high-frequency content that the notch filter cannot remove.
   *
   * Prescaler 16 -> 1 MHz ADC clock -> ~14 us conversions. That is above the
   * 200 kHz the datasheet specifies for full 10-bit accuracy, so we lose a
   * fraction of a bit of precision. On a signal the AD8232 has already
   * amplified 1100x that is an excellent trade for a rock-steady sample clock.
   */
  ADCSRA = (ADCSRA & 0xF8) | 0x04;  // clear prescaler bits, set /16

  nextSampleAt = micros();
}

void loop() {
  // Busy-wait on micros() rather than using delay(). delay() accumulates drift
  // because it ignores the time your own code spent, and a drifting sample
  // clock makes the measured heart rate wrong by the same percentage.
  uint32_t now = micros();
  int32_t wait = (int32_t)(nextSampleAt - now);
  if (wait > 0) return;

  nextSampleAt += PERIOD_US;

  // If we have fallen more than one full period behind (a long Serial flush,
  // for instance), resynchronise instead of trying to catch up -- a burst of
  // back-to-back samples would corrupt the timebase far worse than a gap.
  if ((int32_t)(micros() - nextSampleAt) > (int32_t)PERIOD_US) {
    nextSampleAt = micros() + PERIOD_US;
  }

  // AD8232 drives LO+ / LO- HIGH when an electrode has lost contact.
  bool leadsOff = (digitalRead(PIN_LO_P) == HIGH) || (digitalRead(PIN_LO_N) == HIGH);

  if (leadsOff) {
    Serial.println('!');
    return;
  }

  uint16_t value = analogRead(PIN_ECG);

#ifdef SEND_LEADS_OFF_COLUMN
  Serial.print(value);
  Serial.println(F(",0"));
#else
  Serial.println(value);
#endif
}
