# Browser end-to-end tests

```bash
npm install          # downloads its own Chrome
node test.mjs        # against http://localhost:8000
ECG_URL=https://143-198-27-18.nip.io node test.mjs
```

Drives the app through `window.__ecg` and asserts on real internal state
rather than scraping formatted DOM text.

## Constraints on a GPU-less server

These cost real time to rediscover, so they are written down:

- Chrome 137+ **refuses software WebGL** without `--enable-unsafe-swiftshader`.
  Without it three.js throws and the app never finishes booting.
- Headless Chrome has no compositor, so `requestAnimationFrame` runs at ~1 fps.
  Never assert on live animation state — drive the cardiac model directly.
- For the same reason `page.waitForFunction` defaults to rAF polling and
  effectively never fires. Always pass `{polling: 500}`.
- `renderer.info.render.triangles` is the **last frame's** draw count, not the
  geometry size. Assert on `heart.mesh.geometry` instead.
- Software WebGL saturates the machine and starves the Python process. Set
  `heart.enabled = false` for functional tests; enable only for screenshots.
- `AudioContext.resume()` never settles with no audio device — race everything
  audio-related against a timeout.
- A crashed run leaves Chrome alive holding a WebSocket: `pkill chrome`.
