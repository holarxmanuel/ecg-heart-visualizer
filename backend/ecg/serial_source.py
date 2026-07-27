"""
Real AD8232 + Arduino Uno R3 source over USB serial.

This is the drop-in twin of SimulatedSource. It implements the same ECGSource
contract and emits the same thing -- raw 10-bit ADC counts at 1000 Hz -- so
switching between them changes nothing downstream.

Wire protocol (see ../arduino/ecg_ad8232/ecg_ad8232.ino):

    "512\n"     ADC value only
    "512,0\n"   ADC value, leads-off flag (1 = an electrode has come loose)
    "!\n"       leads-off marker, no valid sample

Reading happens on a dedicated daemon thread because pyserial's read() blocks.
The thread drains the OS buffer into a deque; the asyncio server pops from that
deque without ever blocking the event loop.
"""

from __future__ import annotations

import threading
import time
from collections import deque

import numpy as np

import config
from .source import ECGSource, SourceStatus

try:  # pyserial is only needed for Phase 2; the simulator runs without it.
    import serial
    from serial.tools import list_ports

    PYSERIAL_AVAILABLE = True
except ImportError:  # pragma: no cover
    serial = None  # type: ignore[assignment]
    list_ports = None  # type: ignore[assignment]
    PYSERIAL_AVAILABLE = False


# ---------------------------------------------------------------------------
# Port discovery
# ---------------------------------------------------------------------------


def list_serial_ports() -> list[dict]:
    """Every serial port Windows can see, with a 'likely Arduino' hint flag."""
    if not PYSERIAL_AVAILABLE:
        return []

    ports = []
    for p in list_ports.comports():
        blob = " ".join(
            str(x) for x in (p.description, p.manufacturer, p.product) if x
        ).lower()
        likely = any(hint in blob for hint in config.SERIAL_AUTODETECT_HINTS)
        ports.append(
            {
                "device": p.device,
                "description": p.description or "Unknown device",
                "manufacturer": p.manufacturer or "",
                "hwid": p.hwid or "",
                "likely_arduino": likely,
            }
        )
    # Put the probable Arduino first so the UI can preselect it.
    ports.sort(key=lambda d: (not d["likely_arduino"], d["device"]))
    return ports


def autodetect_port() -> str | None:
    """Best guess at which COM port the Arduino is on. None if nothing matches."""
    ports = list_serial_ports()
    for p in ports:
        if p["likely_arduino"]:
            return p["device"]
    # Exactly one port on the machine? It is almost certainly the board.
    return ports[0]["device"] if len(ports) == 1 else None


# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------


class SerialError(RuntimeError):
    """Raised when the port cannot be opened or the board says nothing."""


class SerialSource(ECGSource):
    name = "serial"

    def __init__(
        self,
        port: str | None = None,
        baud: int = config.SERIAL_BAUD,
        sample_rate: int = config.SAMPLE_RATE,
    ) -> None:
        super().__init__(sample_rate)
        self.port = port or config.SERIAL_PORT
        self.baud = int(baud)

        self._serial = None
        self._thread: threading.Thread | None = None
        self._stop_evt = threading.Event()
        self._lock = threading.Lock()
        self._buffer: deque[float] = deque(maxlen=sample_rate * 10)  # 10 s backlog

        self._leads_off = False
        self._error: str | None = None
        self._last_rx = 0.0
        self._rx_count = 0
        self._bad_lines = 0

        # Measured (not assumed) arrival rate, so the UI can prove the board is
        # actually keeping up with the configured 1000 Hz.
        self._rate_window_start = 0.0
        self._rate_window_count = 0
        self._measured_rate = 0.0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        if not PYSERIAL_AVAILABLE:
            raise SerialError(
                "pyserial is not installed. Run: pip install -r requirements.txt"
            )

        target = self.port or autodetect_port()
        if not target:
            raise SerialError(
                "No serial ports found. Plug in the Arduino, install its driver "
                "(CH340 for most clones), and make sure the Arduino IDE's Serial "
                "Monitor is closed -- it holds the port exclusively."
            )
        self.port = target

        try:
            self._serial = serial.Serial(
                port=self.port,
                baudrate=self.baud,
                timeout=config.SERIAL_TIMEOUT,
            )
        except Exception as exc:  # pyserial raises several distinct types
            raise SerialError(f"Could not open {self.port}: {exc}") from exc

        # The Uno auto-resets when the port opens (DTR toggle). Give the
        # bootloader time to hand over, then throw away the partial first line.
        time.sleep(2.0)
        self._serial.reset_input_buffer()

        self._error = None
        self._rx_count = 0
        self._bad_lines = 0
        self._buffer.clear()
        self._stop_evt.clear()
        self._started_at = time.monotonic()
        self._rate_window_start = self._started_at

        self._thread = threading.Thread(
            target=self._reader_loop, name="ad8232-serial", daemon=True
        )
        self._thread.start()

        # Confirm the board is actually talking before we report success --
        # an open port with a silent board is the most confusing failure mode.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            with self._lock:
                if self._buffer:
                    return
            if self._error:
                break
            time.sleep(0.05)

        detail = self._error or (
            "Port opened but no data arrived in 3 s. Check that the sketch is "
            "uploaded and that the baud rate matches (expected "
            f"{self.baud})."
        )
        self.stop()
        raise SerialError(detail)

    def stop(self) -> None:
        self._stop_evt.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:
                pass
            self._serial = None

    # -- data --------------------------------------------------------------

    def read(self) -> np.ndarray:
        with self._lock:
            if not self._buffer:
                return self._empty()
            out = np.fromiter(self._buffer, dtype=np.float64, count=len(self._buffer))
            self._buffer.clear()
        return out

    def status(self) -> SourceStatus:
        alive = bool(self._thread and self._thread.is_alive())
        stale = alive and (time.monotonic() - self._last_rx) > 1.0

        if self._error:
            mode, label = "error", "Error"
        elif alive and not stale:
            mode, label = "connected", "Connected"
        elif alive and stale:
            mode, label = "error", "No data"
        else:
            mode, label = "idle", "Disconnected"

        return SourceStatus(
            mode=mode,
            label=label,
            port=self.port,
            baud=self.baud,
            sample_rate=self.sample_rate,
            leads_off=self._leads_off,
            detail=self._error
            or ("Leads off - check electrodes" if self._leads_off else "AD8232 live"),
            extra={
                "samples_received": self._rx_count,
                "malformed_lines": self._bad_lines,
                "measured_rate_hz": round(self._measured_rate, 1),
            },
        )

    # -- reader thread -----------------------------------------------------

    def _reader_loop(self) -> None:
        assert self._serial is not None
        while not self._stop_evt.is_set():
            try:
                raw = self._serial.readline()
            except Exception as exc:
                self._error = f"Serial read failed: {exc}"
                return

            if not raw:
                continue  # timeout; loop back and re-check the stop event

            value, leads_off = self._parse_line(raw)
            self._leads_off = leads_off

            if value is None:
                continue

            now = time.monotonic()
            self._last_rx = now
            self._rx_count += 1

            with self._lock:
                # A full deque silently evicts its oldest element, which would
                # splice the waveform without anyone noticing. Detect it first.
                if len(self._buffer) == self._buffer.maxlen:
                    self.discontinuities += 1
                self._buffer.append(value)

            # Update the measured sample rate once per second.
            self._rate_window_count += 1
            span = now - self._rate_window_start
            if span >= 1.0:
                self._measured_rate = self._rate_window_count / span
                self._rate_window_count = 0
                self._rate_window_start = now

    def _parse_line(self, raw: bytes) -> tuple[float | None, bool]:
        """
        Decode one line into (adc_value, leads_off).

        Deliberately permissive: a dropped byte at 115200 baud is normal, and a
        malformed line should cost us one sample, not the whole session.
        """
        try:
            text = raw.decode("ascii", errors="ignore").strip()
        except Exception:
            self._bad_lines += 1
            return None, self._leads_off

        if not text:
            return None, self._leads_off

        if text == config.SERIAL_LEADS_OFF_TOKEN:
            return None, True

        parts = text.split(",")
        try:
            value = float(int(parts[0]))
        except ValueError:
            self._bad_lines += 1
            return None, self._leads_off

        if not (0 <= value <= config.ADC_MAX):
            self._bad_lines += 1
            return None, self._leads_off

        leads_off = False
        if len(parts) > 1:
            leads_off = parts[1].strip() in ("1", "true", "True")

        return value, leads_off
