/**
 * Read the AD8232 from the browser, over the user's own USB port.
 *
 * The problem this solves: the code runs on a server in a datacentre, but the
 * sensor is plugged into the user's laptop. Web Serial lets the page open that
 * port directly, so no agent has to be installed on the client machine and the
 * user grants access explicitly through the browser's own picker.
 *
 * It parses exactly the line protocol backend/ecg/serial_source.py parses, and
 * emits the same thing every other source in this system emits -- raw 10-bit
 * ADC counts. See arduino/ecg_ad8232/ecg_ad8232.ino:
 *
 *     "512\n"     ADC value only
 *     "512,0\n"   ADC value, leads-off flag (1 = electrode detached)
 *     "!\n"       leads-off marker, no valid sample
 *
 * Requirements, both non-negotiable and both worth surfacing clearly in the UI
 * rather than failing mysteriously:
 *   - Chromium-family browser (Chrome/Edge/Opera). Firefox and Safari have not
 *     shipped Web Serial.
 *   - A secure context. https:// or http://localhost -- a bare http://<ip>
 *     will not do, which is why the deployment terminates TLS.
 */

const DEFAULT_BAUD = 115200;

/**
 * USB-serial bridges an Arduino-class board is likely to be behind, and
 * whether Windows can talk to one without being given a driver first.
 *
 * This exists because "no COM port" and "no driver" look identical to a user:
 * the board is plugged in, its power LED is on, and the browser's port picker
 * is empty. Naming the chip turns that dead end into an instruction.
 *
 * `needsDriver` is about Windows specifically. Linux has ch341, cp210x and
 * ftdi_sio in-kernel, and recent macOS carries CH34x itself, so on those the
 * answer is almost always "just plug it in".
 */
export const USB_CHIPS = {
  '1a86:7523': { name: 'CH340', vendor: 'WCH', needsDriver: true },
  '1a86:7522': { name: 'CH340', vendor: 'WCH', needsDriver: true },
  '1a86:5523': { name: 'CH341', vendor: 'WCH', needsDriver: true },
  '1a86:55d4': { name: 'CH9102', vendor: 'WCH', needsDriver: true },
  '0403:6001': { name: 'FT232R', vendor: 'FTDI', needsDriver: false },
  '0403:6015': { name: 'FT231X', vendor: 'FTDI', needsDriver: false },
  '10c4:ea60': { name: 'CP2102', vendor: 'Silicon Labs', needsDriver: false },
  '2341:0043': { name: 'Uno R3', vendor: 'Arduino', needsDriver: false },
  '2341:0001': { name: 'Uno', vendor: 'Arduino', needsDriver: false },
  '2341:0243': { name: 'Uno R3', vendor: 'Arduino', needsDriver: false },
  '2a03:0043': { name: 'Uno R3', vendor: 'Arduino.org', needsDriver: false },
};

/** The official driver download, per platform. Null means none is needed. */
export function driverInfo() {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua)) {
    return {
      platform: 'Windows',
      url: 'https://www.wch-ic.com/downloads/CH341SER_EXE.html',
      label: 'CH340 driver for Windows (WCH, official)',
      note: 'Run the installer, click Install, then unplug and replug the board.',
    };
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return {
      platform: 'macOS',
      url: 'https://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html',
      label: 'CH340 driver for macOS (WCH, official)',
      note: 'Recent macOS already includes this driver. Only install it if the board does not appear.',
    };
  }
  return {
    platform: /Linux|X11/i.test(ua) ? 'Linux' : 'this system',
    url: null,
    label: null,
    note: 'The ch341 driver is part of the Linux kernel, so no download is needed. If the port is missing, add yourself to the dialout group and replug.',
  };
}

/** "CH340 (WCH)" rather than "USB 1a86:7523". */
export function describeUsbDevice(vid, pid) {
  if (vid == null) return { key: null, name: 'USB serial device', known: false, needsDriver: null };
  const key = `${vid.toString(16).padStart(4, '0')}:${(pid ?? 0).toString(16).padStart(4, '0')}`;
  const chip = USB_CHIPS[key];
  return chip
    ? { key, name: `${chip.name} (${chip.vendor})`, known: true, needsDriver: chip.needsDriver }
    : { key, name: `USB ${key}`, known: false, needsDriver: null };
}

/**
 * Ports the user has already granted, described.
 *
 * Note what this cannot do: the Web Serial security model only exposes ports
 * the user has explicitly picked, so a machine with a perfectly working driver
 * and nothing yet granted looks exactly like a machine with no driver. There
 * is no silent probe, by design. Confirming a fresh setup therefore needs one
 * click through the browser's picker, which is what the setup panel asks for.
 */
export async function probeGrantedDevices() {
  if (!isWebSerialSupported()) return [];
  try {
    const ports = await navigator.serial.getPorts();
    return ports.map((p) => {
      const i = p.getInfo?.() || {};
      return { port: p, ...describeUsbDevice(i.usbVendorId, i.usbProductId) };
    });
  } catch {
    return [];
  }
}

export function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function isSecureContextOk() {
  return typeof window !== 'undefined' && window.isSecureContext;
}

/**
 * Why Web Serial is unavailable, phrased for a user rather than a developer.
 * Returns null when it is available.
 */
export function webSerialUnavailableReason() {
  if (!isSecureContextOk()) {
    return 'USB sensors need a secure connection (https). Open the site over HTTPS.';
  }
  if (!isWebSerialSupported()) {
    return 'This browser has no Web Serial support. Use Chrome, Edge or Opera.';
  }
  return null;
}

export class WebSerialSensor extends EventTarget {
  constructor({ baud = DEFAULT_BAUD } = {}) {
    super();
    this.baud = baud;
    this.port = null;
    this.connected = false;
    this.leadsOff = false;

    this._reader = null;
    this._closing = false;
    this._carry = '';
    this._badLines = 0;
    this._sampleCount = 0;
  }

  /**
   * Prompt the user to pick a port, then open it.
   * Must be called from a user gesture -- the browser requires it.
   */
  async requestAndOpen() {
    const reason = webSerialUnavailableReason();
    if (reason) throw new Error(reason);

    // No filters: Arduino clones use a zoo of USB-serial bridges (CH340,
    // CP2102, FTDI) and a VID/PID allowlist would hide the user's actual board
    // behind an empty picker.
    const port = await navigator.serial.requestPort();
    return this.open(port);
  }

  /** Reopen a port the user has already granted, without prompting. */
  async openGranted() {
    if (!isWebSerialSupported()) return false;
    const ports = await navigator.serial.getPorts();
    if (ports.length === 0) return false;
    await this.open(ports[0]);
    return true;
  }

  async open(port) {
    this.port = port;
    this._closing = false;
    await port.open({
      baudRate: this.baud,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      // A generous buffer: at 1 kHz the board emits ~6 kB/s, and a GC pause on
      // the main thread must not cost samples.
      bufferSize: 65536,
    });

    this.connected = true;
    this._carry = '';
    this._sampleCount = 0;
    this.dispatchEvent(new CustomEvent('open', { detail: this.info() }));
    this._readLoop(); // deliberately not awaited: runs until close()
    return this.info();
  }

  info() {
    let label = 'USB serial device';
    try {
      const i = this.port?.getInfo?.();
      if (i?.usbVendorId != null) {
        label = describeUsbDevice(i.usbVendorId, i.usbProductId).name;
      }
    } catch {
      /* getInfo is best-effort */
    }
    return { label, baud: this.baud, samples: this._sampleCount };
  }

  async _readLoop() {
    const decoder = new TextDecoder();

    try {
      while (this.port?.readable && !this._closing) {
        this._reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this._reader.read();
            if (done) break;
            if (value) this._ingest(decoder.decode(value, { stream: true }));
          }
        } finally {
          try {
            this._reader.releaseLock();
          } catch {
            /* already released */
          }
          this._reader = null;
        }
      }
    } catch (err) {
      if (!this._closing) {
        this.dispatchEvent(new CustomEvent('error', { detail: { message: String(err) } }));
      }
    } finally {
      this.connected = false;
      if (!this._closing) this.dispatchEvent(new CustomEvent('close'));
    }
  }

  /**
   * Parse a chunk of text into ADC counts.
   *
   * The board's writes do not align to line boundaries, so a partial line is
   * carried into the next chunk. Dropping it instead would corrupt roughly one
   * sample per read -- invisible in isolation, but a steady stream of step
   * edges for the detector to trip over.
   */
  _ingest(text) {
    const data = this._carry + text;
    const lines = data.split('\n');
    // The last element is either a partial line or '' -- either way it carries.
    this._carry = lines.pop() ?? '';

    const samples = [];
    let leadsOff = this.leadsOff;

    for (let raw of lines) {
      const line = raw.trim();
      if (line === '') continue;

      if (line === '!') {
        leadsOff = true;
        continue;
      }

      const comma = line.indexOf(',');
      const valueStr = comma === -1 ? line : line.slice(0, comma);
      const value = Number(valueStr);

      if (!Number.isFinite(value) || value < 0 || value > 1023) {
        // Garbage happens at connect while the board resets and the buffer
        // holds half a line. Counted, not fatal.
        this._badLines += 1;
        continue;
      }

      if (comma !== -1) leadsOff = line.slice(comma + 1).trim() === '1';
      else leadsOff = false;

      samples.push(value);
    }

    this.leadsOff = leadsOff;

    if (samples.length) {
      this._sampleCount += samples.length;
      this.dispatchEvent(
        new CustomEvent('samples', { detail: { samples, leadsOff } })
      );
    }
  }

  async close() {
    this._closing = true;
    this.connected = false;
    try {
      await this._reader?.cancel();
    } catch {
      /* reader may already be gone */
    }
    try {
      await this.port?.close();
    } catch {
      /* port may already be closed */
    }
    this.port = null;
    this.dispatchEvent(new CustomEvent('close'));
  }
}
