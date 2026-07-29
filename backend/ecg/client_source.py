"""
An ECG source whose samples arrive from a browser over the WebSocket.

The deployment inverts the usual arrangement: the code runs on a server, but
the AD8232 is plugged into the *user's* laptop. Web Serial lets the page read
that port and forward the samples up, and this class is where they land.

Crucially it is not a special case bolted onto the pipeline -- it is a third
implementation of ECGSource, alongside SimulatedSource and SerialSource,
emitting the same raw 10-bit ADC counts. So filtering, R-peak detection, the
broadcast protocol and the entire browser stay exactly as they were. That was
the whole point of the abstraction.

Note the browser can also process its samples locally (frontend/src/dsp) and
skip this path entirely, which is lower latency. This exists for the cases
where the server should own the signal chain anyway: recording a session
server-side, or letting other viewers watch the same trace.
"""

from __future__ import annotations

import threading
import time
from collections import deque

import numpy as np

import config
from .source import ECGSource, SourceStatus


class ClientFedSource(ECGSource):
    name = "client"

    #: Samples buffered before the oldest are dropped. 10 s at 1 kHz. Beyond
    #: this the consumer is not keeping up and fresh samples matter far more
    #: than stale ones -- but the drop is recorded, because the resulting
    #: splice looks exactly like a QRS to a detector that has not been told.
    MAX_BUFFER = config.SAMPLE_RATE * 10

    def __init__(self, sample_rate: int = config.SAMPLE_RATE, label: str = "") -> None:
        super().__init__(sample_rate)
        self._buffer: deque[float] = deque(maxlen=self.MAX_BUFFER)
        self._lock = threading.Lock()
        self._running = False
        self._leads_off = False
        self.label = label or "browser USB sensor"

        self._rx_count = 0
        self._last_rx = 0.0
        self._rate_window_start = 0.0
        self._rate_window_count = 0
        self._measured_rate = 0.0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._started_at = time.monotonic()
        self._rate_window_start = time.monotonic()
        self._rx_count = 0

    def stop(self) -> None:
        self._running = False
        with self._lock:
            self._buffer.clear()

    # -- ingestion ---------------------------------------------------------

    def feed(self, samples: list[float], leads_off: bool = False) -> None:
        """Called from the WebSocket handler as the browser forwards samples."""
        if not self._running or not samples:
            return

        with self._lock:
            before = len(self._buffer)
            self._buffer.extend(samples)
            # A bounded deque discards silently, so detect the overflow by
            # arithmetic rather than trusting it not to have happened.
            if before + len(samples) > self.MAX_BUFFER:
                self.discontinuities += 1

        self._leads_off = bool(leads_off)
        self._rx_count += len(samples)
        self._last_rx = time.monotonic()
        self._rate_window_count += len(samples)

        now = time.monotonic()
        dt = now - self._rate_window_start
        if dt >= 1.0:
            # Measured rather than assumed, so the dashboard can prove the
            # board is really keeping up rather than taking 1 kHz on trust.
            self._measured_rate = self._rate_window_count / dt
            self._rate_window_count = 0
            self._rate_window_start = now

    # -- data --------------------------------------------------------------

    def read(self) -> np.ndarray:
        if not self._running:
            return self._empty()
        with self._lock:
            if not self._buffer:
                return self._empty()
            out = np.fromiter(self._buffer, dtype=np.float64, count=len(self._buffer))
            self._buffer.clear()
        return out

    @property
    def stale(self) -> bool:
        """True when the browser has stopped forwarding (tab closed, cable out)."""
        return self._last_rx > 0 and (time.monotonic() - self._last_rx) > 2.0

    def status(self) -> SourceStatus:
        if not self._running:
            mode, label = "idle", "Disconnected"
        elif self._rx_count == 0:
            mode, label = "connected", "Waiting for browser"
        elif self.stale:
            # Distinct from "disconnected": the socket is fine, the samples
            # stopped. Saying "connected" here would be a lie on a monitor.
            mode, label = "error", "Sensor stream stalled"
        else:
            mode, label = "connected", "USB sensor (via browser)"

        return SourceStatus(
            mode=mode,
            label=label,
            port=self.label,
            baud=config.SERIAL_BAUD,
            sample_rate=self.sample_rate,
            leads_off=self._leads_off,
            detail=f"Forwarded from browser · {self._measured_rate:.0f} Hz measured",
            extra={
                "measured_rate_hz": round(self._measured_rate, 1),
                "samples_rx": self._rx_count,
                "client_fed": True,
            },
        )
