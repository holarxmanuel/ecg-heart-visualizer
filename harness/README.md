# Browser end-to-end tests

```bash
npm install          # downloads its own Chrome
node test.mjs        # the main suite
node sync.mjs        # two clients, shared-session slider sync
node detach.mjs      # two clients, own-sensor detachment
ECG_URL=https://143-198-27-18.nip.io node test.mjs
```

The multi-client suites are separate on purpose. Each needs two live clients,
and folding them into `test.mjs` means three pages building anatomy and
rendering in software at once -- which a GPU-less box cannot sustain, so the
boot times out rather than anything failing on merit.

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
- A crashed run leaves Chrome alive holding a WebSocket: `pkill -9 -f chrome`.
  Leftover renderers starve the next run and produce timeouts that look like
  product bugs.
- A page that has been reloaded offline, had a service worker take control,
  lost and regained its socket, and run a 1 kHz engine throughout will
  eventually stop answering CDP calls. Hand later sections a fresh page rather
  than chasing it.
- The mode preference lives in `localStorage`, which is per-ORIGIN and so is
  shared by every tab and every suite. Clear it when a test needs a known
  starting mode, and restore it afterwards.
- Raise `protocolTimeout` well above the 30 s default; software rendering
  makes ordinary evaluates slow.
