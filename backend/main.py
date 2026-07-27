"""
Real-Time ECG Heart Visualizer -- FastAPI server.

Responsibilities:
  * own exactly one ECGSource (simulator OR real AD8232 serial), swappable at
    runtime via POST /api/source
  * run it through the filter + R-peak detector on a fixed 20 ms cadence
  * fan the result out to every connected browser over WebSocket

The source swap is the whole point of the architecture: `_pipeline.select()`
tears down one ECGSource and stands up the other. Every line below this point
is identical for simulated and real data.

Run:  python run_server.py       (or: uvicorn main:app --port 8000)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import config
from ecg import (
    ECGFilter,
    ECGSource,
    RPeakDetector,
    SimulatedSource,
    SerialSource,
    autodetect_port,
    list_serial_ports,
)
from ecg.serial_source import PYSERIAL_AVAILABLE, SerialError

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s  %(levelname)-7s %(name)s: %(message)s"
)
log = logging.getLogger("ecg")


# ===========================================================================
# Pipeline
# ===========================================================================


class ClientChannel:
    """
    One browser's outbound queue.

    Without this, `await ws.send_json(...)` is called straight from the
    acquisition loop. A browser that falls behind (a weak GPU, a background
    tab, a laptop on battery) then applies TCP backpressure directly to the
    pump: ticks stop firing on schedule, the source's buffer overruns, and the
    UI drifts seconds into the past while still rendering stale data as if it
    were live. On a monitor that is worse than useless -- it is misleading.

    So each client gets a small bounded queue drained by its own task. If a
    client cannot keep up we drop the oldest frames for THAT client and keep
    acquiring at a true 1000 Hz. Display degrades; timing never lies.
    """

    #: ~200 ms of buffering at a 20 ms cadence. Enough to ride out a GC pause,
    #: short enough that a struggling client stays visibly near real time.
    MAX_QUEUED = 10

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(
            maxsize=self.MAX_QUEUED
        )
        self.dropped = 0
        self.sent = 0
        self.task: asyncio.Task | None = None
        self.alive = True

    def offer(self, message: dict[str, Any]) -> None:
        """Enqueue without ever blocking the producer."""
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            # Shed the oldest frame. Newer data is strictly more useful on a
            # real-time display than a backlog of history.
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(message)
            except asyncio.QueueFull:
                self.dropped += 1

    async def run(self) -> None:
        try:
            while self.alive:
                msg = await self.queue.get()
                await self.ws.send_json(msg)
                self.sent += 1
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception:
            log.debug("client writer stopped", exc_info=True)
        finally:
            self.alive = False

    def stop(self) -> None:
        self.alive = False
        if self.task:
            self.task.cancel()


class ECGPipeline:
    """Acquisition -> filtering -> R-peak detection -> broadcast."""

    def __init__(self) -> None:
        self.source: ECGSource | None = None
        self.filter = ECGFilter()
        self.detector = RPeakDetector()

        self.paused = False
        self.seq = 0
        self.samples_total = 0

        # Desired simulator settings, owned by the pipeline rather than by the
        # source object. The UI can change these at any time -- including
        # before a simulator exists, or while real hardware is connected -- and
        # they are applied when the simulator is (re)created. Storing them on
        # the source instead means a slider moved a moment too early is
        # silently discarded, which looks exactly like a broken control.
        self.sim_config: dict[str, Any] = {
            "bpm": config.SIM_DEFAULT_BPM,
            "noise": config.SIM_DEFAULT_NOISE,
            "artifacts": config.SIM_DEFAULT_ARTIFACTS,
        }
        self.session_started: float | None = None
        self.last_error: str | None = None
        #: Waveform splices seen this session (lost samples). Non-zero means
        #: the machine could not keep up, or the serial link dropped data.
        self.splices = 0

        self._clients: dict[WebSocket, ClientChannel] = {}
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

        # Volts-per-ADC-count, and the divisor that refers the amplified signal
        # back to millivolts at the electrodes (the clinically meaningful unit).
        self.volts_per_count = config.ADC_VREF / config.ADC_MAX
        self.mv_per_volt = 1000.0 / config.AD8232_GAIN

    # -- source selection --------------------------------------------------

    async def select(
        self, mode: str, port: str | None = None, baud: int | None = None
    ) -> dict[str, Any]:
        """
        Swap the data source. THIS is the hardware handover point.

        mode="simulate" -> SimulatedSource
        mode="serial"   -> SerialSource (real AD8232)
        mode="off"      -> tear everything down
        """
        async with self._lock:
            if self.source is not None:
                await asyncio.to_thread(self.source.stop)
                self.source = None

            self.last_error = None
            self._reset_processing()

            if mode == "off":
                return {"ok": True, "status": self.status()}

            if mode == "simulate":
                src: ECGSource = SimulatedSource(**self.sim_config)
            elif mode == "serial":
                src = SerialSource(port=port, baud=baud or config.SERIAL_BAUD)
            else:
                raise ValueError(f"unknown mode: {mode!r}")

            try:
                # start() can block for seconds on a serial port (board reset),
                # so keep it off the event loop.
                await asyncio.to_thread(src.start)
            except SerialError as exc:
                self.last_error = str(exc)
                log.warning("Serial connect failed: %s", exc)
                return {"ok": False, "error": str(exc), "status": self.status()}
            except Exception as exc:  # noqa: BLE001 - surfaced to the UI
                self.last_error = str(exc)
                log.exception("Source start failed")
                return {"ok": False, "error": str(exc), "status": self.status()}

            self.source = src
            self.paused = False
            self.session_started = time.time()
            log.info("Source active: %s", src.name)
            return {"ok": True, "status": self.status()}

    def _reset_processing(self) -> None:
        self.filter.reset()
        self.detector.reset()
        self.samples_total = 0
        self.seq = 0
        self.splices = 0
        self.session_started = None

    async def reset_session(self) -> None:
        """Zero the beat counter and filter state without dropping the source."""
        async with self._lock:
            self._reset_processing()
            self.session_started = time.time()

    def configure_simulation(self, **kwargs: Any) -> bool:
        """Record the requested settings, and apply them live if we can."""
        for key, value in kwargs.items():
            if value is not None and key in self.sim_config:
                self.sim_config[key] = value

        if isinstance(self.source, SimulatedSource):
            self.source.configure(**kwargs)
            return True
        # Not simulating right now (idle, or on real hardware). The settings
        # are still remembered and will take effect the moment we are.
        return False

    # -- status ------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        if self.source is None:
            base = {
                "mode": "idle",
                "label": "Disconnected",
                "port": None,
                "baud": None,
                "sample_rate": config.SAMPLE_RATE,
                "leads_off": False,
                "detail": "No source selected",
                "extra": {},
            }
        else:
            base = self.source.status().to_dict()
            if self.paused and base["mode"] in ("simulating", "connected"):
                base["label"] = "Paused"

        base.update(
            {
                "paused": self.paused,
                "running": self.source is not None and not self.paused,
                "beats_total": self.detector.beat_count,
                "bpm": round(self.detector.bpm, 1),
                "samples_total": self.samples_total,
                "clients": len(self._clients),
                # Frames shed because a browser could not keep up. Surfaced so
                # a struggling client is visible rather than silently lossy.
                "dropped_frames": sum(c.dropped for c in self._clients.values()),
                "splices": self.splices,
                "uptime_s": (
                    round(time.time() - self.session_started, 1)
                    if self.session_started
                    else 0.0
                ),
                "last_error": self.last_error,
                "pyserial_available": PYSERIAL_AVAILABLE,
            }
        )
        return base

    def hello(self) -> dict[str, Any]:
        """Constants the browser needs to interpret the stream."""
        return {
            "type": "hello",
            "fs": config.SAMPLE_RATE,
            "adc_max": config.ADC_MAX,
            "adc_vref": config.ADC_VREF,
            "gain": config.AD8232_GAIN,
            "baseline_v": config.AD8232_BASELINE_V,
            "mains_hz": config.MAINS_HZ,
            "batch_ms": config.BATCH_INTERVAL_MS,
            # The simulator settings the server is actually holding. The UI
            # seeds its sliders from these so a reloaded page never shows 60
            # BPM while the server is generating 120.
            "sim": dict(self.sim_config),
            "status": self.status(),
        }

    # -- client registry ---------------------------------------------------

    async def add_client(self, ws: WebSocket) -> ClientChannel:
        channel = ClientChannel(ws)
        channel.task = asyncio.create_task(channel.run())
        self._clients[ws] = channel
        return channel

    def remove_client(self, ws: WebSocket) -> None:
        channel = self._clients.pop(ws, None)
        if channel:
            channel.stop()

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Hand the message to every client's queue. Never blocks, never waits."""
        if not self._clients:
            return
        for ws, channel in list(self._clients.items()):
            if not channel.alive:
                self.remove_client(ws)
                continue
            channel.offer(message)

    async def broadcast_status(self) -> None:
        await self.broadcast({"type": "status", "status": self.status()})

    # -- the loop ----------------------------------------------------------

    def start_loop(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def stop_loop(self) -> None:
        for ws in list(self._clients):
            self.remove_client(ws)
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self.source:
            await asyncio.to_thread(self.source.stop)
            self.source = None

    async def _loop(self) -> None:
        """Fixed-cadence pump. Runs for the lifetime of the process."""
        interval = config.BATCH_INTERVAL_MS / 1000.0
        next_tick = time.monotonic()
        status_counter = 0

        while True:
            next_tick += interval
            delay = next_tick - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                # Fell behind (GC pause, heavy page load). Resync rather than
                # trying to catch up, which would only compound the backlog.
                next_tick = time.monotonic()

            try:
                await self._tick()
            except Exception:  # noqa: BLE001 - one bad tick must not kill the pump
                log.exception("pipeline tick failed")

            # Push a status frame ~4x/second so the dashboard's connection pill,
            # leads-off warning and measured sample rate stay honest.
            status_counter += 1
            if status_counter >= max(1, int(0.25 / interval)):
                status_counter = 0
                if self._clients:
                    await self.broadcast_status()

    async def _tick(self) -> None:
        src = self.source
        if src is None:
            return

        raw = src.read()

        # While paused we still drain the source -- otherwise the serial buffer
        # backs up and the simulator accumulates a backlog that would fast-
        # forward the instant you hit resume.
        if raw.size == 0 or self.paused or not self._clients:
            return

        # If the source lost samples, the waveform now has a step edge in it.
        # Warn the detector before it sees one, not after.
        if src.take_discontinuity():
            self.detector.notify_discontinuity()
            self.splices += 1
            log.debug("waveform splice #%d -- detection blanked", self.splices)

        # ---- the source-agnostic part starts here -------------------------
        volts = raw * self.volts_per_count
        filtered_v = self.filter.process(volts)
        beats = self.detector.process(filtered_v)

        # Refer the filtered trace back to millivolts at the electrodes, which
        # is what a clinician would expect the y-axis to read.
        filtered_mv = filtered_v * self.mv_per_volt

        start_index = self.samples_total
        self.samples_total += raw.size
        self.seq += 1

        beat_payload = [
            {
                "n": b.number,
                "i": b.chunk_index,
                "bpm": b.bpm,
                "bpm_avg": b.bpm_avg,
                "rr_ms": b.rr_ms,
                "amp": b.amplitude,
                # How far in the past this beat sits relative to the end of the
                # batch. The browser uses it to place the sound precisely.
                "age_ms": round(
                    (raw.size - b.chunk_index) * 1000.0 / config.SAMPLE_RATE, 1
                ),
            }
            for b in beats
        ]

        await self.broadcast(
            {
                "type": "batch",
                "seq": self.seq,
                "i0": start_index,
                "t": time.time() * 1000.0,
                # Raw as integer ADC counts: compact on the wire, and exactly
                # what the Arduino sent. The browser converts using `hello`.
                "raw": [int(v) for v in raw],
                # Filtered in mV, 3dp -- plenty for a 1 mV signal on screen.
                "filt": [round(float(v), 3) for v in filtered_mv],
                "beats": beat_payload,
                "bpm": round(self.detector.bpm, 1),
                "beats_total": self.detector.beat_count,
                "leads_off": src.status().leads_off,
            }
        )


pipeline = ECGPipeline()


# ===========================================================================
# API
# ===========================================================================


class SourceRequest(BaseModel):
    mode: Literal["simulate", "serial", "off"]
    port: str | None = None
    baud: int | None = None


class SimulationRequest(BaseModel):
    bpm: float | None = Field(default=None, ge=30, le=200)
    noise: float | None = Field(default=None, ge=0.0, le=1.0)
    artifacts: bool | None = None


class MonitorRequest(BaseModel):
    running: bool


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    pipeline.start_loop()
    log.info("ECG pipeline pump started (%d ms cadence)", config.BATCH_INTERVAL_MS)
    yield
    await pipeline.stop_loop()


app = FastAPI(title="ECG Heart Visualizer", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "ecg-heart-visualizer", "version": "1.0.0"}


@app.get("/api/status")
async def get_status() -> dict[str, Any]:
    return pipeline.status()


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return pipeline.hello()


@app.get("/api/ports")
async def get_ports() -> dict[str, Any]:
    """Serial ports visible to the OS, best Arduino candidate first."""
    ports = await asyncio.to_thread(list_serial_ports)
    suggested = await asyncio.to_thread(autodetect_port)
    return {
        "pyserial_available": PYSERIAL_AVAILABLE,
        "ports": ports,
        "suggested": suggested,
        "baud": config.SERIAL_BAUD,
    }


@app.post("/api/source")
async def set_source(req: SourceRequest) -> JSONResponse:
    """Swap between the simulator and real hardware. The one-click handover."""
    result = await pipeline.select(req.mode, port=req.port, baud=req.baud)
    await pipeline.broadcast_status()
    return JSONResponse(result, status_code=200 if result.get("ok") else 409)


@app.post("/api/simulation")
async def set_simulation(req: SimulationRequest) -> dict[str, Any]:
    applied_live = pipeline.configure_simulation(
        bpm=req.bpm, noise=req.noise, artifacts=req.artifacts
    )
    # ok=True even when nothing is simulating: the settings were accepted and
    # stored, and will apply as soon as the simulator runs.
    return {
        "ok": True,
        "applied_live": applied_live,
        "config": pipeline.sim_config,
        "status": pipeline.status(),
    }


@app.post("/api/monitor")
async def set_monitor(req: MonitorRequest) -> dict[str, Any]:
    pipeline.paused = not req.running
    await pipeline.broadcast_status()
    return {"ok": True, "status": pipeline.status()}


@app.post("/api/reset")
async def reset_session() -> dict[str, Any]:
    await pipeline.reset_session()
    await pipeline.broadcast_status()
    return {"ok": True, "status": pipeline.status()}


@app.websocket("/ws/ecg")
async def ws_ecg(ws: WebSocket) -> None:
    await ws.accept()
    channel = await pipeline.add_client(ws)
    log.info("client connected (%d total)", len(pipeline._clients))

    try:
        # Sent directly rather than queued: the client cannot interpret any
        # batch until it has these constants.
        await ws.send_json(pipeline.hello())
        channel.offer({"type": "status", "status": pipeline.status()})
        while True:
            # The browser only sends keepalives and the occasional inline
            # control message; all real control goes through the REST API.
            msg = await ws.receive_json()
            if msg.get("type") == "ping":
                await ws.send_json({"type": "pong", "t": time.time() * 1000.0})
    except WebSocketDisconnect:
        pass
    except Exception:
        log.debug("websocket closed unexpectedly", exc_info=True)
    finally:
        pipeline.remove_client(ws)
        log.info("client disconnected (%d left)", len(pipeline._clients))


# ---------------------------------------------------------------------------
# Optional: serve the production frontend build from this same server, so
# `npm run build` gives you a single-process deployment. In development the
# Vite dev server on :3000 handles this instead.
# ---------------------------------------------------------------------------

_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
    log.info("Serving production frontend build from %s", _dist)
