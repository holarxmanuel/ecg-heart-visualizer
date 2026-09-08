/**
 * End-to-end browser tests for the server-hosted ECG visualizer.
 *
 * Driven through window.__ecg rather than by scraping formatted DOM text, so
 * the assertions are about real internal state.
 *
 * Constraints learned the hard way on a GPU-less server (see HANDOVER 6.4):
 *   - headless Chrome has no compositor, so rAF runs at ~1 fps. Never assert
 *     on live animation; drive the model directly instead.
 *   - page.waitForFunction defaults to rAF polling and so effectively never
 *     fires. Always pass {polling: N}.
 *   - software WebGL saturates the box and starves the Python process.
 *   - AudioContext.resume() never settles with no audio device.
 */

import puppeteer from 'puppeteer';

const BASE = process.env.ECG_URL || 'http://localhost:8000';
// Several rules depend on whether the target counts as "your own machine".
// Assert the rule, not a fixed outcome, so the suite is valid against both
// localhost and the public deployment.
const BASE_IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
// A non-localhost origin, used to assert the mode toggle is locked there.
const PUBLIC_URL = process.env.ECG_PUBLIC_URL || 'http://143.198.27.18:8000';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  ${tag}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(label);
  }
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    // Several pages plus a 1 kHz backend on a GPU-less box: CDP calls can
    // take far longer than the 30 s default.
    protocolTimeout: 180000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      // Chrome 137+ refuses software WebGL without this; without it the
      // renderer throws and the app never finishes booting.
      '--enable-unsafe-swiftshader',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  console.log(`\nTarget: ${BASE}`);
  console.log('='.repeat(74));

  // ---- boot ------------------------------------------------------------
  console.log('\nBoot');
  console.log('-'.repeat(74));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Sample-count thresholds below are really durations. Read the configured
  // rate once and scale them, so the suite is valid at any sample rate.
  const FS = await page.evaluate(async () => {
    try { return (await (await fetch('/api/config')).json()).fs; } catch { return 1000; }
  });
  const secs = (n) => Math.round(n * FS);
  await page.waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 });
  check('app boots and exposes __ecg', true);

  // Rendering is expensive on software GL and starves the backend; the
  // functional tests do not need it.
  await page.evaluate(() => {
    window.__ecg.heart.enabled = false;
  });

  // Assert on the geometry itself, not renderer.info.render.triangles: that
  // counter reports the LAST FRAME's draw count, and rendering has just been
  // switched off (and rAF barely runs headless anyway), so it reads ~0 whether
  // or not the mesh exists.
  const geo = await page.evaluate(() => {
    const g = window.__ecg.heart.mesh.geometry;
    return {
      verts: g.attributes.position.count,
      tris: g.index ? g.index.count / 3 : g.attributes.position.count / 3,
      hasColor: !!g.attributes.color,
    };
  });
  check('3D heart geometry built', geo.tris > 5000, `${geo.tris} triangles, ${geo.verts} verts`);
  check('vertex colours baked', geo.hasColor);

  // ---- server-driven streaming ----------------------------------------
  console.log('\nServer-driven streaming');
  console.log('-'.repeat(74));

  await page.evaluate(async () => {
    await fetch('/api/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'simulate' }),
    });
    await fetch('/api/simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bpm: 75, noise: 0.1 }),
    });
    await fetch('/api/monitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ running: true }),
    });
  });

  await page.waitForFunction(`window.__ecg.state.samples > ${secs(3)}`, {
    timeout: 30000,
    polling: 300,
  });
  const mode = await page.evaluate(() => window.__ecg.linkState.mode);
  check('link is in server mode', mode === 'server', mode);

  await page.waitForFunction('window.__ecg.state.lastBpm > 0', { timeout: 30000, polling: 300 });
  const bpm = await page.evaluate(() => window.__ecg.state.lastBpm);
  check('recovers the simulated rate', Math.abs(bpm - 75) < 6, `${bpm.toFixed(1)} BPM vs 75`);

  // ---- latency meter ---------------------------------------------------
  console.log('\nLatency meter');
  console.log('-'.repeat(74));

  await page.waitForFunction('window.__ecg.linkState.rtt !== null', {
    timeout: 20000,
    polling: 300,
  });
  const st = await page.evaluate(() => window.__ecg.linkState);
  check('round-trip time measured', st.rtt != null && st.rtt >= 0, `${st.rtt?.toFixed(1)} ms`);
  check('RTT is plausible on loopback', st.rtt < 500, `${st.rtt?.toFixed(1)} ms`);
  check('beat age reported', st.beatAge != null, `${st.beatAge} ms`);

  const rttText = await page.$eval('#link-rtt', (el) => el.textContent.trim());
  const linkLabel = await page.$eval('#link-label', (el) => el.textContent.trim());
  check('latency shown in header', /\d+\s*ms/.test(rttText), `"${rttText}"`);
  check('link label reads Live', linkLabel === 'Live', `"${linkLabel}"`);

  // ---- local / offline engine -----------------------------------------
  console.log('\nLocal (offline) engine');
  console.log('-'.repeat(74));

  const before = await page.evaluate(() => window.__ecg.state.samples);
  await page.evaluate(() => {
    window.__ecg.link.useLocal('simulate');
    window.__ecg.link.engine.configureSimulation({ bpm: 110, noise: 0.1 });
  });

  await sleep(1000);
  const localMode = await page.evaluate(() => window.__ecg.linkState.mode);
  check('link switched to local', localMode === 'local', localMode);

  await page.waitForFunction(`window.__ecg.state.samples > ${before + secs(3)}`, {
    timeout: 30000,
    polling: 300,
  });
  check('local engine produces samples', true);

  // Wait for the local detector to settle on the new rate.
  await page.waitForFunction('window.__ecg.engine.detector.beatCount > 8', {
    timeout: 40000,
    polling: 300,
  });
  const localBpm = await page.evaluate(() => window.__ecg.engine.detector.bpm);
  check(
    'local DSP recovers its own rate',
    Math.abs(localBpm - 110) < 8,
    `${localBpm.toFixed(1)} BPM vs 110`
  );

  const localBatch = await page.evaluate(() => {
    const e = window.__ecg.engine;
    return { splices: e.splices, seq: e.seq, samples: e.samplesTotal };
  });
  check('no splices in local acquisition', localBatch.splices === 0, `${localBatch.splices}`);

  const localLabel = await page.$eval('#link-label', (el) => el.textContent.trim());
  check('header shows Local', localLabel === 'Local', `"${localLabel}"`);

  // ---- genuine offline: kill the network, reload -----------------------
  console.log('\nOffline survival (service worker)');
  console.log('-'.repeat(74));

  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      registered: !!reg,
      active: !!reg?.active,
      controller: !!navigator.serviceWorker.controller,
      secure: window.isSecureContext,
    };
  });
  check('secure context (localhost)', swState.secure);
  check('service worker registered', swState.registered);
  check('service worker active', swState.active);

  // Give the SW a moment to take control, then reload so it controls the page.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 });
  await page.evaluate(() => {
    window.__ecg.heart.enabled = false;
  });

  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check('page is controlled by the service worker', controlled);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((n) => n.startsWith('ecg-shell-'));
    if (!shell) return { shell: null, count: 0 };
    const c = await caches.open(shell);
    const keys = await c.keys();
    return { shell, count: keys.length, urls: keys.map((k) => new URL(k.url).pathname) };
  });
  check('app shell cached', cached.count >= 5, `${cached.count} entries in ${cached.shell}`);
  check(
    'three.js chunk cached (485 kB)',
    (cached.urls || []).some((u) => u.includes('three')),
    (cached.urls || []).find((u) => u.includes('three')) || 'missing'
  );

  // Now go truly offline and reload.
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  const bootedOffline = await page
    .waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 })
    .then(() => true)
    .catch(() => false);
  check('app boots with the network OFF', bootedOffline);

  if (bootedOffline) {
    await page.evaluate(() => {
      window.__ecg.heart.enabled = false;
    });
    // With no server, boot() falls back to the local engine by itself.
    await page.waitForFunction(`window.__ecg.state.samples > ${secs(2)}`, {
      timeout: 40000,
      polling: 300,
    });
    const offMode = await page.evaluate(() => window.__ecg.linkState.mode);
    check('falls back to local automatically', offMode === 'local', offMode);

    await page.waitForFunction('window.__ecg.engine.detector.beatCount > 5', {
      timeout: 40000,
      polling: 300,
    });
    const offBpm = await page.evaluate(() => window.__ecg.engine.detector.bpm);
    check('beats detected while offline', offBpm > 30 && offBpm < 200, `${offBpm.toFixed(1)} BPM`);

    const bannerShown = await page.$eval(
      '#offline-banner',
      (el) => !el.classList.contains('hidden')
    );
    check('offline banner is visible', bannerShown);

    const bannerText = await page.$eval('#offline-text', (el) => el.textContent.trim());
    check(
      'banner explains sensors are unavailable',
      /sensor|simulation/i.test(bannerText),
      `"${bannerText.slice(0, 60)}…"`
    );
  }

  await page.setOfflineMode(false);


  // ---- mode switch + connectivity indicator ----------------------------
  console.log('\nMode switch and connectivity indicator');
  console.log('-'.repeat(74));

  // Put the link back on the server and wait for it: earlier sections left it
  // local and offline, and asserting before the socket reconnects would be
  // testing the harness's timing rather than the app.
  await page.evaluate(() => window.__ecg.link.useServer());
  await page.waitForFunction('window.__ecg.linkState.serverUp === true', {
    timeout: 40000,
    polling: 300,
  });
  await page.waitForFunction("window.__ecg.linkState.mode === 'server'", {
    timeout: 20000,
    polling: 300,
  });

  const netOn = await page.evaluate(() => ({
    label: document.getElementById('net-label').textContent.trim(),
    dot: document.getElementById('net-dot').className,
  }));
  check('indicator reads Internet when connected', netOn.label === 'Internet', `"${netOn.label}"`);
  check('indicator dot is green', netOn.dot.includes('trace-ecg'), netOn.dot);

  // localhost counts as "your own machine", so the toggle is unlocked there
  // and locked on a hosted origin. Both are correct; which one applies depends
  // on the target.
  const modeState = await page.evaluate(() => window.__ecg.modeState);
  check(
    BASE_IS_LOCAL ? 'localhost can toggle mode' : 'hosted origin locks the mode toggle',
    modeState.canToggle === BASE_IS_LOCAL,
    `canToggle=${modeState.canToggle} (target ${BASE_IS_LOCAL ? 'local' : 'hosted'})`
  );
  check('defaults to online', modeState.mode === 'online', modeState.mode);

  // ---- immediate reaction to losing the network ------------------------
  console.log('\nImmediate reaction to losing the network (no refresh)');
  console.log('-'.repeat(74));

  await page.setOfflineMode(true);

  // No reload: the indicator must flip on its own, and fast.
  const flipped = await page
    .waitForFunction(
      "document.getElementById('net-label').textContent.trim() === 'No internet'",
      { timeout: 8000, polling: 100 }
    )
    .then(() => true)
    .catch(() => false);
  check('indicator flips to "No internet" without a refresh', flipped);

  const netOff = await page.evaluate(() => ({
    dot: document.getElementById('net-dot').className,
    serialDisabled: document.getElementById('btn-serial').disabled,
    simSliderDisabled: document.getElementById('sim-bpm').disabled,
  }));
  check('indicator dot turns red', netOff.dot.includes('trace-alert'), netOff.dot);
  // Nothing is greyed out any more, deliberately: the Arduino button now reads
  // a sensor on THIS machine, so it is one of the things that must still work
  // when the network does not.
  check('own-sensor button stays usable offline', netOff.serialDisabled === false);
  check('simulation sliders stay usable offline', netOff.simSliderDisabled === false);

  const degraded = await page.evaluate(() => window.__ecg.linkState);
  check('switched to local processing', degraded.local === true, degraded.mode);
  check('marked as degraded, not a user choice', degraded.degraded === true);

  const linkLabelOff = await page.$eval('#link-label', (el) => el.textContent.trim());
  check('link pill says it is a fallback', /fallback/i.test(linkLabelOff), `"${linkLabelOff}"`);

  // The trace must keep moving. Assert on the LOCAL engine's own counter:
  // state.samples restarts at zero when the source swaps (a new acquisition
  // session, exactly as a server-side source swap behaves), so it cannot be
  // compared against the pre-drop figure.
  await page.waitForFunction('window.__ecg.engine.samplesTotal > 2000', {
    timeout: 30000,
    polling: 300,
  });
  const kept = await page.evaluate(() => window.__ecg.engine.samplesTotal);
  check('kept streaming locally after the drop', kept > 2000, `${kept} samples locally`);

  // ---- recovery ---------------------------------------------------------
  console.log('\nRecovery when the network returns');
  console.log('-'.repeat(74));

  await page.setOfflineMode(false);
  const recovered = await page
    .waitForFunction(
      "document.getElementById('net-label').textContent.trim() === 'Internet'",
      { timeout: 40000, polling: 200 }
    )
    .then(() => true)
    .catch(() => false);
  check('indicator returns to Internet', recovered);

  const backOnline = await page
    .waitForFunction("window.__ecg.linkState.mode === 'server'", { timeout: 40000, polling: 300 })
    .then(() => true)
    .catch(() => false);
  check('automatically resumes server processing', backOnline);

  const notDegraded = await page.evaluate(() => window.__ecg.linkState.degraded);
  check('degraded flag cleared on recovery', notDegraded === false);

  const reenabled = await page.evaluate(() => !document.getElementById('btn-serial').disabled);
  check('network controls re-enabled', reenabled);

  // ---- hosted site in a browser tab: mode must be LOCKED ---------------
  console.log('\nHosted site in a browser tab (mode locked to Online)');
  console.log('-'.repeat(74));

  if (PUBLIC_URL && BASE_IS_LOCAL) {
    const tabPage = await browser.newPage();
    await tabPage.setViewport({ width: 1400, height: 900 });
    await tabPage.goto(PUBLIC_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await tabPage.waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 });
    await tabPage.evaluate(() => {
      window.__ecg.heart.enabled = false;
    });

    const tState = await tabPage.evaluate(() => window.__ecg.modeState);
    check('hosted tab cannot toggle mode', tState.canToggle === false, `canToggle=${tState.canToggle}`);
    check('hosted tab is online', tState.mode === 'online', tState.mode);
    check('lock reason explained to the user', !!tState.lockedReason,
          (tState.lockedReason || '').slice(0, 46) + '…');

    const tBtns = await tabPage.evaluate(() => ({
      onlineDisabled: document.getElementById('mode-online').disabled,
      offlineDisabled: document.getElementById('mode-offline').disabled,
      onlineActive: document.getElementById('mode-online').classList.contains('is-active'),
      lockVisible: document.getElementById('mode-lock').style.display !== 'none',
    }));
    check('both mode buttons disabled', tBtns.onlineDisabled && tBtns.offlineDisabled);
    check('Online shown as the active mode', tBtns.onlineActive);
    check('lock icon visible', tBtns.lockVisible);

    await tabPage.evaluate(() => document.getElementById('mode-offline').click());
    await sleep(500);
    const afterClick = await tabPage.evaluate(() => window.__ecg.modeState.mode);
    check('clicking Offline is refused', afterClick === 'online', afterClick);

    await tabPage.close();
  } else {
    console.log('  SKIP  target is already a hosted origin (asserted above)');
  }

  // ---- installed app ----------------------------------------------------
  console.log('\nInstalled app (standalone display-mode)');
  console.log('-'.repeat(74));

  const installedPage = await browser.newPage();
  await installedPage.setViewport({ width: 1400, height: 900 });
  // This puppeteer cannot emulate the display-mode media feature, so patch
  // matchMedia before any app code runs. That is exactly the signal mode.js
  // reads, so the app cannot tell the difference.
  await installedPage.evaluateOnNewDocument(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) =>
      q.includes('display-mode: standalone')
        ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
        : real(q);
  });
  await installedPage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await installedPage.waitForFunction('window.__ecg !== undefined', {
    timeout: 90000,
    polling: 500,
  });
  await installedPage.evaluate(() => {
    window.__ecg.heart.enabled = false;
  });

  const iState = await installedPage.evaluate(() => window.__ecg.modeState);
  check('installed app detected', iState.installed === true, `installed=${iState.installed}`);
  check('installed app CAN toggle mode', iState.canToggle === true);

  const iBtns = await installedPage.evaluate(() => ({
    onlineDisabled: document.getElementById('mode-online').disabled,
    offlineDisabled: document.getElementById('mode-offline').disabled,
    lockVisible: document.getElementById('mode-lock').style.display !== 'none',
  }));
  check('mode buttons enabled when installed', !iBtns.onlineDisabled && !iBtns.offlineDisabled);
  check('lock icon hidden when installed', !iBtns.lockVisible);

  await installedPage.evaluate(() => document.getElementById('mode-offline').click());
  await sleep(1500);
  const iOffline = await installedPage.evaluate(() => ({
    mode: window.__ecg.modeState.mode,
    link: window.__ecg.linkState.mode,
    degraded: window.__ecg.linkState.degraded,
  }));
  check('switched to offline mode', iOffline.mode === 'offline', iOffline.mode);
  check('link is processing locally', iOffline.link === 'local', iOffline.link);
  check('offline is a choice, not a degradation', iOffline.degraded === false);

  const iBefore = await installedPage.evaluate(() => window.__ecg.engine.samplesTotal);
  await installedPage.waitForFunction(
    `window.__ecg.engine.samplesTotal > ${iBefore + secs(2)}`,
    { timeout: 30000, polling: 300 }
  );
  check('local engine streaming in chosen offline mode', true);

  // Chosen-offline must NOT be dragged back online by a reconnect.
  await sleep(2500);
  const stillOffline = await installedPage.evaluate(() => window.__ecg.linkState.mode);
  check('stays offline despite a live server', stillOffline === 'local', stillOffline);

  // The preference must survive a reload -- that is what makes it a setting.
  await installedPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await installedPage.waitForFunction('window.__ecg !== undefined', {
    timeout: 90000,
    polling: 500,
  });
  await installedPage.evaluate(() => {
    window.__ecg.heart.enabled = false;
  });
  const persisted = await installedPage.evaluate(() => window.__ecg.modeState.mode);
  check('offline preference persists across reload', persisted === 'offline', persisted);
  const persistedLink = await installedPage.evaluate(() => window.__ecg.linkState.mode);
  check('and is applied on launch', persistedLink === 'local', persistedLink);

  await installedPage.evaluate(() => document.getElementById('mode-online').click());
  await sleep(2000);
  const iOnline = await installedPage.evaluate(() => window.__ecg.modeState.mode);
  check('can switch back to online', iOnline === 'online', iOnline);

  await installedPage.close();

  // ---- controls must not depend on the server when running locally -----
  console.log('\nOffline controls (installed app, no server)');
  console.log('-'.repeat(74));

  const offlinePage = await browser.newPage();
  await offlinePage.setViewport({ width: 1400, height: 900 });
  await offlinePage.evaluateOnNewDocument(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) =>
      q.includes('display-mode: standalone')
        ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
        : real(q);
  });
  const offlineFailedReqs = [];
  offlinePage.on('requestfailed', (r) => offlineFailedReqs.push(r.url()));

  await offlinePage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await offlinePage.waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 });
  await offlinePage.evaluate(() => {
    window.__ecg.heart.enabled = false;
  });

  await offlinePage.evaluate(() => document.getElementById('mode-offline').click());
  await sleep(2000);

  const sockClosed = await offlinePage.evaluate(() => window.__ecg.link.conn.connected);
  check('offline mode closes the socket', sockClosed === false);

  // Sliders must drive the local engine and must not call the API.
  offlineFailedReqs.length = 0;
  await offlinePage.evaluate(() => {
    const s = document.getElementById('sim-bpm');
    s.value = 95;
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(1500);
  const simCfg = await offlinePage.evaluate(() => window.__ecg.engine.simConfig.bpm);
  const sliderToast = await offlinePage.evaluate(
    () => document.getElementById('toast-body')?.textContent || ''
  );
  check('slider drives the local engine', simCfg === 95, `engine bpm=${simCfg}`);
  check('slider raises no fetch error', !/fetch|failed/i.test(sliderToast), `"${sliderToast}"`);

  // Pause must actually pause.
  await offlinePage.evaluate(() => document.getElementById('btn-start').click());
  await sleep(1500);
  const pausedState = await offlinePage.evaluate(() => ({
    paused: window.__ecg.engine.paused,
    label: document.getElementById('btn-start-label').textContent,
    toast: document.getElementById('toast-body')?.textContent || '',
  }));
  check('Pause pauses the local engine', pausedState.paused === true);
  check('button reads Resume', pausedState.label === 'Resume', pausedState.label);
  check('Pause raises no fetch error', !/fetch|failed/i.test(pausedState.toast), `"${pausedState.toast}"`);

  await offlinePage.evaluate(() => document.getElementById('btn-start').click());
  await sleep(1200);
  const resumed = await offlinePage.evaluate(() => window.__ecg.engine.paused);
  check('Resume resumes', resumed === false);

  // Nothing at all should have gone to the network.
  offlineFailedReqs.length = 0;
  await sleep(5000);
  check(
    'no network requests while offline',
    offlineFailedReqs.length === 0,
    offlineFailedReqs.slice(0, 2).join(', ')
  );

  // The session clock must not sit at 00:00 -- it used to start only when the
  // user picked a source by hand.
  const elapsed = await offlinePage.$eval('#stat-elapsed', (el) => el.textContent.trim());
  check('session clock is running', elapsed !== '00:00', `"${elapsed}"`);

  // BPM slider range must cover the simulator's range, or 60 BPM renders as an
  // empty track and reads as zero.
  const range = await offlinePage.evaluate(() => {
    const s = document.getElementById('sim-bpm');
    return { min: Number(s.min), max: Number(s.max), value: Number(s.value) };
  });
  check('BPM slider spans the simulator range', range.min <= 30 && range.max >= 200,
        `${range.min}-${range.max}`);

  // Restore the shared preference: it is per-origin localStorage, so leaving
  // it on 'offline' would silently change how later sections start up.
  await offlinePage.evaluate(() => document.getElementById('mode-online').click());
  await sleep(1000);
  await offlinePage.close();

  // NOTE: the multi-client checks (shared-session slider sync, and one user's
  // own sensor detaching from the shared session) live in their own suites --
  // sync.mjs and detach.mjs. They need two live clients each, and running them
  // inside this session means three pages building anatomy and rendering in
  // software at once, which a GPU-less box cannot sustain. Run:
  //
  //     node sync.mjs && node detach.mjs
  //
  // ---- PWA metadata ----------------------------------------------------
  console.log('\nPWA installability');
  console.log('-'.repeat(74));

  // Fresh renderer for the remaining sections. By this point the main page has
  // been reloaded offline, had a service worker take control, lost and
  // regained its socket, and run a 1 kHz engine throughout -- and it
  // eventually stops answering CDP calls. Rather than chase that, hand the
  // last read-only checks a clean page.
  await page.goto('about:blank');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__ecg !== undefined', { timeout: 150000, polling: 500 });
  await page.evaluate(() => {
    window.__ecg.heart.enabled = false;
  });

  const manifest = await page.evaluate(async () => {
    const res = await fetch('/manifest.webmanifest');
    return res.ok ? res.json() : null;
  });
  check('manifest served', !!manifest);
  if (manifest) {
    check('display: standalone', manifest.display === 'standalone', manifest.display);
    check('has 192 and 512 icons', manifest.icons?.length >= 2, `${manifest.icons?.length} icons`);
    check(
      'has a maskable icon',
      manifest.icons?.some((i) => i.purpose === 'maskable')
    );
    check('start_url set', manifest.start_url === '/', manifest.start_url);
  }

  const iconOk = await page.evaluate(async () => {
    const res = await fetch('/icons/icon-512.png');
    if (!res.ok) return false;
    const blob = await res.blob();
    return blob.size > 500 && blob.type.includes('png');
  });
  check('512px icon is a real PNG', iconOk);

  // ---- update machinery ------------------------------------------------
  console.log('\nUpdate machinery');
  console.log('-'.repeat(74));

  const version = await page.evaluate(async () => (await fetch('/api/version')).json());
  check('/api/version serves a build id', !!version.build_id, version.build_id);
  check('version matches VERSION file', version.version === '1.1.0', version.version);

  const swBuild = await page.evaluate(async () => (await fetch('/version.json')).json());
  check('version.json served for the shell', !!swBuild.buildId, swBuild.buildId);

  const upd = await page.evaluate(async () => (await fetch('/api/update/check')).json());
  check('update check responds', upd.ok === true, `update_available=${upd.update_available}`);
  check('update check is non-fatal when GitHub is unreachable', typeof upd.reachable === 'boolean');

  // The self-update endpoint must refuse non-loopback callers. From the page
  // it IS loopback, so assert the guard exists rather than that it rejects.
  const guard = await page.evaluate(async () => {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  // The endpoint runs git and npm on the host, so it must refuse anyone who is
  // not on loopback. From localhost it should get through (and then decline on
  // its own terms, e.g. a dirty tree); from a hosted origin it must be 403.
  if (BASE_IS_LOCAL) {
    check(
      'self-update reachable from loopback',
      guard.status === 200 || guard.status === 500,
      `HTTP ${guard.status}: ${(guard.body.error || 'ok').slice(0, 60)}`
    );
  } else {
    check(
      'self-update REFUSED from a remote origin',
      guard.status === 403,
      `HTTP ${guard.status}: ${(guard.body.error || '').slice(0, 60)}`
    );
  }

  // ---- Web Serial surface ----------------------------------------------
  console.log('\nWeb Serial (no hardware attached)');
  console.log('-'.repeat(74));

  const serial = await page.evaluate(() => ({
    supported: 'serial' in navigator,
    secure: window.isSecureContext,
    btn: !!document.getElementById('btn-usb'),
  }));
  check('USB Sensor button present', serial.btn);
  check('secure context available for Web Serial', serial.secure);
  console.log(
    `  NOTE  navigator.serial present: ${serial.supported} ` +
      `(headless Chrome does not expose it; real Chrome/Edge does)`
  );

  // ---- resources -------------------------------------------------------
  console.log('\nResources');
  console.log('-'.repeat(74));

  const metrics = await page.metrics();
  const heapMb = metrics.JSHeapUsedSize / 1048576;
  check('JS heap is modest', heapMb < 80, `${heapMb.toFixed(1)} MB`);

  const realErrors = consoleErrors.filter(
    (e) =>
      !/Failed to load resource/.test(e) &&
      !/net::ERR_INTERNET_DISCONNECTED/.test(e) &&
      !/WebSocket/.test(e) &&
      !/favicon/.test(e)
  );
  check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  // ---- screenshot ------------------------------------------------------
  await page.evaluate(() => {
    window.__ecg.heart.enabled = true;
  });
  await sleep(3000);
  const shotPath = process.env.ECG_SHOT || new URL('dashboard.png', import.meta.url).pathname;
  await page.screenshot({ path: shotPath });
  console.log(`\n  screenshot -> ${shotPath}`);

  await browser.close();

  console.log('\n' + '='.repeat(74));
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('  Failures: ' + failures.join(', '));
    process.exit(1);
  }
  console.log('  All browser checks passed.');
}

main().catch((e) => {
  console.error('\nHARNESS ERROR:', e);
  process.exit(2);
});
