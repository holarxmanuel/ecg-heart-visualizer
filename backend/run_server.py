"""
Convenience launcher for the ECG backend.

    python run_server.py            # normal
    python run_server.py --reload   # auto-restart on edit

Equivalent to: uvicorn main:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import argparse

import uvicorn

import config


def main() -> None:
    parser = argparse.ArgumentParser(description="ECG Heart Visualizer backend")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--reload", action="store_true", help="dev auto-reload")
    args = parser.parse_args()

    print("=" * 68)
    print("  Real-Time ECG Heart Visualizer -- backend")
    print(f"  API      http://{args.host}:{args.port}/api/status")
    print(f"  Stream   ws://{args.host}:{args.port}/ws/ecg")
    print(f"  Rate     {config.SAMPLE_RATE} Hz, {config.BATCH_INTERVAL_MS} ms batches")
    print("  Frontend http://localhost:3000  (run `npm run dev` in ../frontend)")
    print("=" * 68)

    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
