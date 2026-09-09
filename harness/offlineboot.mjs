/**
 * The guest scenario: install the app online, then cold-launch it in
 * standalone mode with the network genuinely gone. Nothing may depend on
 * /api, which the service worker deliberately never caches.
 */
import puppeteer from 'puppeteer';
const BASE = process.env.ECG_URL;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
const check = (l, ok, d='') => { console.log(`  ${ok?'PASS':'FAIL'}  ${l}${d?'  -- '+d:''}`); ok?pass++:(fail++,failures.push(l)); };

const browser = await puppeteer.launch({ headless:'new',
  args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-unsafe-swiftshader'] });

// 1. First visit while online, so the service worker caches the shell.
const warm = await browser.newPage();
await warm.goto(BASE, { waitUntil:'domcontentloaded' });
await warm.waitForFunction('window.__ecg !== undefined', {timeout:90000, polling:500});
await warm.waitForFunction("navigator.serviceWorker.controller !== null", {timeout:60000, polling:500});
// Choose Offline like a guest would, so the preference is persisted.
await warm.evaluate(() => { try { localStorage.setItem('ecg.mode','offline'); } catch {} });
await sleep(3000);
console.log('\nGuest cold boot: installed app, no network at all');
console.log('-'.repeat(74));
check('service worker cached the shell while online', true);
await warm.close();

// 2. Cold launch in standalone (installed) display mode, network fully dead.
const page = await browser.newPage();
// This puppeteer cannot emulate the display-mode media feature, so patch
// matchMedia before any app code runs: that is the exact signal mode.js reads.
await page.evaluateOnNewDocument(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) =>
    q.includes('display-mode: standalone')
      ? { matches:true, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }
      : real(q);
});
const attempted = [];
await page.setRequestInterception(true);
page.on('request', r => {
  const u = r.url();
  if (u.startsWith(BASE)) attempted.push(u.replace(BASE,''));
  // Kill the network dead: nothing reaches the origin server. Only what the
  // service worker already holds can satisfy a request.
  if (/^https?:/.test(u)) return r.abort('internetdisconnected');
  r.continue();
});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

let booted = true;
try {
  await page.goto(BASE, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForFunction('window.__ecg !== undefined', { timeout:60000, polling:500 });
} catch (e) { booted = false; check('app boots with no network', false, String(e).split('\n')[0]); }

if (booted) {
  check('app boots with no network', true);
  const boot = await page.evaluate(() => ({
    overlayGone: !!document.getElementById('boot')?.hidden ||
                 getComputedStyle(document.getElementById('boot')).display === 'none',
    installed: window.__ecg.modeState.installed,
    mode: window.__ecg.modeState.mode,
  }));
  check('boot overlay cleared (not stuck on a spinner)', boot.overlayGone, `installed=${boot.installed}`);

  // It must start streaming from the local engine with no server at all.
  let streamed = true;
  try {
    await page.waitForFunction('window.__ecg.state.samples > 200', { timeout:45000, polling:500 });
  } catch { streamed = false; }
  check('local engine streams with no server', streamed);

  await sleep(20000);
  const live = await page.evaluate(() => ({
    samples: window.__ecg.state.samples,
    linkMode: window.__ecg.linkState.mode,
    beats: window.__ecg.engine ? window.__ecg.engine.detector.beatCount : 0,
    bpm: window.__ecg.engine ? window.__ecg.engine.detector.bpm : 0,
    chartFs: window.__ecg.chart.sampleRate,
    chartWindow: window.__ecg.chart.capacity / window.__ecg.chart.sampleRate,
    // The rate the offline engine advertises in its own hello, which is what
    // the chart must follow when there is no server to ask.
    engineFs: window.__ecg.state.serverConfig ? window.__ecg.state.serverConfig.fs : null,
    uiBpm: document.getElementById('bpm-value')?.textContent,
    tris: window.__ecg.renderInfo.triangles,
  }));
  check('processing locally', live.linkMode === 'local', live.linkMode);
  check('detects beats offline', live.beats > 5, `${live.beats} beats`);
  check('reports a plausible heart rate offline', live.bpm > 40 && live.bpm < 200,
        `${live.bpm.toFixed(1)} bpm, UI shows ${live.uiBpm}`);
  check('chart timebase matches the engine', live.chartFs === live.engineFs,
        `chart ${live.chartFs} Hz vs engine hello ${live.engineFs} Hz`);
  check('chart window is the 4 s it claims', Math.abs(live.chartWindow - 4) < 0.01,
        `${live.chartWindow.toFixed(2)} s`);
  check('3D heart still renders offline', live.tris > 5000, `${live.tris} triangles`);

  // Controls must work with no server to talk to.
  await page.evaluate(() => { const s=document.getElementById('sim-bpm'); s.value=140; s.dispatchEvent(new Event('input',{bubbles:true})); });
  await sleep(15000);
  const after = await page.evaluate(() => window.__ecg.engine.detector.bpm);
  check('slider drives the local engine offline', Math.abs(after-140) < 12, `${after.toFixed(1)} bpm for a 140 request`);

  const apiHits = [...new Set(attempted.filter(u => u.startsWith('/api')))];
  check('boot did not depend on any /api call succeeding', true,
        apiHits.length ? `tried and survived: ${apiHits.join(', ')}` : 'none attempted');
  check('no uncaught page errors offline', errors.length === 0, errors.slice(0,2).join(' | ') || 'clean');
  await page.screenshot({ path: 'out/offline-cold-boot.png' });
}

// ---- 3. the network that hangs instead of failing ----------------------
// A laptop still associated with a wifi network that has no route out does not
// reject a fetch, it stalls until a TCP timeout. That is a different code path
// from a hard offline, and the one that leaves a half-drawn shell on screen.
console.log('\nReopened on a network that hangs rather than fails');
console.log('-'.repeat(74));
const hangPage = await browser.newPage();
await hangPage.evaluateOnNewDocument(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) =>
    q.includes('display-mode: standalone')
      ? { matches:true, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }
      : real(q);
});
await hangPage.setRequestInterception(true);
hangPage.on('request', (r) => {
  // Never answer, never fail: exactly what a dead gateway does.
  if (r.url().startsWith(BASE)) return;
  if (/^https?:/.test(r.url())) return r.abort('internetdisconnected');
  r.continue();
});
const t0 = Date.now();
let hangBooted = true, hangErr = '';
try {
  await hangPage.goto(BASE, { waitUntil:'domcontentloaded', timeout:30000 });
  await hangPage.waitForFunction('window.__ecg !== undefined', { timeout:30000, polling:250 });
} catch (e) { hangBooted = false; hangErr = String(e).split('\n')[0].slice(0,70); }
const hangMs = Date.now() - t0;
check('boots even when the network hangs instead of failing', hangBooted, hangErr || `${hangMs} ms`);
check('falls back promptly rather than waiting on a dead socket', hangMs < 20000, `${hangMs} ms`);
if (hangBooted) {
  await hangPage.waitForFunction('window.__ecg.state.samples > 100', { timeout:30000, polling:250 }).catch(() => {});
  const hangLive = await hangPage.evaluate(() => ({
    samples: window.__ecg.state.samples,
    chartFs: window.__ecg.chart.sampleRate,
  }));
  check('streams locally on a hanging network', hangLive.samples > 100, `${hangLive.samples} samples`);
}
await hangPage.screenshot({ path: 'out/offline-hanging-network.png' });

await browser.close();
console.log('\n' + '='.repeat(74));
console.log(`  ${pass} passed, ${fail} failed`);
failures.forEach(f => console.log(`    - ${f}`));
process.exit(fail ? 1 : 0);
