"""ECG acquisition + signal-processing package."""

from .source import ECGSource, SourceStatus
from .simulator import SimulatedSource
from .serial_source import SerialSource, list_serial_ports, autodetect_port
from .filters import ECGFilter
from .detector import RPeakDetector

__all__ = [
    "ECGSource",
    "SourceStatus",
    "SimulatedSource",
    "SerialSource",
    "list_serial_ports",
    "autodetect_port",
    "ECGFilter",
    "RPeakDetector",
]
