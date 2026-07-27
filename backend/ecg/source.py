"""
The single abstraction that makes the hardware swap trivial.

Both the simulator and the real AD8232 serial reader implement ECGSource and
emit *exactly the same thing*: raw 10-bit ADC counts (0..1023) at 1000 Hz, in
the order the Arduino's analogRead() would have produced them.

Nothing downstream -- filtering, R-peak detection, the WebSocket protocol, the
browser -- knows or cares which one is plugged in.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Any

import numpy as np


@dataclass
class SourceStatus:
    """Everything the dashboard needs to render the connection pill."""

    mode: str = "idle"  # "idle" | "simulating" | "connected" | "error"
    label: str = "Disconnected"
    port: str | None = None
    baud: int | None = None
    sample_rate: int = 1000
    leads_off: bool = False
    detail: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ECGSource(ABC):
    """
    Contract for an ECG sample producer.

    Implementations must be non-blocking: `read()` returns whatever samples are
    available *right now* and returns immediately (possibly an empty array).
    The server calls it on a fixed 20 ms cadence.
    """

    #: Human-facing name shown in the UI.
    name: str = "source"

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = int(sample_rate)
        self._started_at: float | None = None
        #: Incremented whenever samples are lost, leaving a splice in the
        #: waveform. See `take_discontinuity`.
        self.discontinuities = 0
        self._last_reported_discontinuities = 0

    # -- lifecycle ---------------------------------------------------------

    @abstractmethod
    def start(self) -> None:
        """Open the device / reset the generator. Must be idempotent."""

    @abstractmethod
    def stop(self) -> None:
        """Release the device. Must be safe to call when already stopped."""

    # -- data --------------------------------------------------------------

    @abstractmethod
    def read(self) -> np.ndarray:
        """
        Return newly available samples as float64 ADC counts (0..1023).

        Returns an empty array when nothing new has arrived. Never blocks.
        """

    # -- introspection -----------------------------------------------------

    @abstractmethod
    def status(self) -> SourceStatus:
        """Current connection state, for the dashboard."""

    @property
    def uptime(self) -> float:
        return 0.0 if self._started_at is None else time.monotonic() - self._started_at

    def take_discontinuity(self) -> bool:
        """
        Report (and clear) whether samples were lost since the last call.

        Both sources can lose samples: the simulator drops backlog if the
        process is starved of CPU, and the serial reader's ring can overrun if
        the board out-runs the consumer. Either way the waveform gets spliced,
        and a splice is a step edge -- which a band-pass-and-square R-peak
        detector will happily report as a QRS complex. The pipeline uses this
        to blank detection across the transient instead of inventing beats.
        """
        current = self.discontinuities
        changed = current != self._last_reported_discontinuities
        self._last_reported_discontinuities = current
        return changed

    # -- helpers shared by implementations ---------------------------------

    @staticmethod
    def _empty() -> np.ndarray:
        return np.empty(0, dtype=np.float64)
