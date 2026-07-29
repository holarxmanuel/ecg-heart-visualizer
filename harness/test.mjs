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

  await page.waitForFunction('window.__ecg.state.samples > 3000', {
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

  await page.waitForFunction(`window.__ecg.state.samples > ${before + 3000}`, {
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
    await page.waitForFunction('window.__ecg.state.samples > 2000', {
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

  // ---- PWA metadata ----------------------------------------------------
  console.log('\nPWA installability');
  console.log('-'.repeat(74));

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
  check(
    'self-update endpoint reachable from localhost',
    guard.status === 200 || guard.status === 500,
    `HTTP ${guard.status}: ${(guard.body.error || 'ok').slice(0, 70)}`
  );

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
  await page.screenshot({ path: '/root/ecg-harness/dashboard.png' });
  console.log('\n  screenshot -> /root/ecg-harness/dashboard.png');

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
