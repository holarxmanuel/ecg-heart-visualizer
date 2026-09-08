/**
 * Supplementary checks: the things test.mjs does not cover.
 *   downloads (CSV recording + export), responsiveness across viewports,
 *   the simulation control surface end to end, audio, 3D interaction,
 *   and every served route.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.ECG_URL || 'http://localhost:8000';
const OUT = path.join(import.meta.dirname, 'out');
const DL = path.join(OUT, 'downloads');

let pass = 0, fail = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  ok ? pass++ : (fail++, failures.push(label));
}
function section(t) {
  console.log(`\n${t}\n${'-'.repeat(74)}`);
}

async function main() {
  await fs.mkdir(DL, { recursive: true });
  for (const f of await fs.readdir(DL)) await fs.rm(path.join(DL, f), { force: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  console.log(`\nTarget: ${BASE}`);
  console.log('='.repeat(74));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 });

  // The backend comes up idle with no source selected: a fresh restart means
  // nothing is streaming until Start is pressed. Establish that first so the
  // rest of the suite is testing the app, not an idle pipeline.
  section('Start the simulation');
  const preState = await page.evaluate(async () => ({
    mode: (await (await fetch('/api/status')).json()).mode,
    label: document.getElementById('btn-start-label').textContent.trim(),
  }));
  if (!/pause/i.test(preState.label)) {
    await page.click('#btn-start');
  }
  let started = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    started = await page.evaluate(async () => await (await fetch('/api/status')).json());
    if (started.running && started.mode === 'simulating') break;
  }
  check('simulation starts from the UI', started.running && started.mode === 'simulating',
        `was "${preState.mode}", now ${started.mode} running=${started.running}`);
  await sleep(6000);

  // ---------------------------------------------------------------- routes
  section('Every served route responds');
  const routes = [
    ['/', 'text/html'], ['/api/health', 'json'], ['/api/status', 'json'],
    ['/api/config', 'json'], ['/api/version', 'json'], ['/api/access', 'json'],
    ['/api/ports', 'json'], ['/api/update/check', 'json'],
    ['/manifest.webmanifest', null], ['/sw.js', 'javascript'],
    ['/version.json', 'json'], ['/icons/icon-512.png', 'image/png'],
    ['/slides/', 'text/html'],
    ['/slides/ECG-Heart-Visualizer-Project-Review.pdf', 'application/pdf'],
  ];
  for (const [r, kind] of routes) {
    const res = await page.evaluate(async (u) => {
      try {
        const rr = await fetch(u);
        return { s: rr.status, ct: rr.headers.get('content-type') || '', len: (await rr.blob()).size };
      } catch (e) { return { s: 0, ct: String(e), len: 0 }; }
    }, r);
    const ok = res.s === 200 && res.len > 0 && (!kind || res.ct.includes(kind));
    check(`GET ${r}`, ok, `${res.s} ${res.ct.split(';')[0]} ${res.len}B`);
  }

  // ------------------------------------------------------- simulation sweep
  section('Simulation control surface');
  const sweep = [30, 40, 75, 120, 200];
  for (const bpm of sweep) {
    await page.evaluate((v) => {
      const s = document.getElementById('sim-bpm');
      s.value = v; s.dispatchEvent(new Event('input', { bubbles: true }));
    }, bpm);
    await sleep(Math.max(20000, (60 / bpm) * 12 * 1000));
    const st = await page.evaluate(async () => {
      const r = await (await fetch('/api/status')).json();
      return { bpm: r.bpm, mode: r.mode, extra: r.extra, label: document.getElementById('bpm-value')?.textContent };
    });
    const err = Math.abs(st.bpm - bpm);
    check(`BPM ${bpm} requested, detector recovers it`, err <= bpm * 0.08 + 2,
          `server says ${st.bpm}, UI shows ${st.label}, err ${err.toFixed(1)}`);
  }
  await page.evaluate(() => {
    const s = document.getElementById('sim-bpm');
    s.value = 75; s.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const noiseOk = await page.evaluate(async () => {
    const s = document.getElementById('sim-noise');
    s.value = 80; s.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2000));
    return (await (await fetch('/api/status')).json()).extra;
  });
  check('noise slider reaches the server', Math.abs((noiseOk.noise ?? 0) - 0.8) < 0.02, `noise=${noiseOk.noise}`);
  const artOff = await page.evaluate(async () => {
    const c = document.getElementById('sim-artifacts');
    c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2000));
    return (await (await fetch('/api/status')).json()).extra;
  });
  check('motion-artifact toggle reaches the server', artOff.artifacts === false, `artifacts=${artOff.artifacts}`);
  await page.evaluate(async () => {
    const c = document.getElementById('sim-artifacts');
    c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
    const s = document.getElementById('sim-noise');
    s.value = 15; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(1500);

  section('Pause and resume');
  await page.click('#btn-start'); await sleep(2500);
  const paused = await page.evaluate(async () => ({
    api: (await (await fetch('/api/status')).json()).paused,
    label: document.getElementById('btn-start-label').textContent.trim(),
  }));
  check('Pause pauses the server stream', paused.api === true, `paused=${paused.api}`);
  check('button offers Resume', /resume/i.test(paused.label), paused.label);
  const before = await page.evaluate(async () => (await (await fetch('/api/status')).json()).samples_total);
  await sleep(2500);
  const during = await page.evaluate(async () => (await (await fetch('/api/status')).json()).samples_total);
  check('no samples accumulate while paused', during === before, `${before} -> ${during}`);
  await page.click('#btn-start'); await sleep(3000);
  const after = await page.evaluate(async () => (await (await fetch('/api/status')).json()).samples_total);
  check('Resume resumes acquisition', after > during, `${during} -> ${after}`);

  // ------------------------------------------------------------- recording
  section('Recording and CSV download');
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await page.click('#btn-record');
  await sleep(1200);
  const recording = await page.evaluate(() => ({
    active: window.__ecg.recorder.recording ?? window.__ecg.recorder.isRecording,
    info: document.getElementById('record-info')?.textContent.trim(),
    exportDisabled: document.getElementById('btn-export').disabled,
  }));
  check('Record starts a recording', recording.active === true || /rec/i.test(recording.info || ''), recording.info);

  await sleep(12000);
  const grew = await page.evaluate(() => ({
    n: window.__ecg.recorder.count ?? window.__ecg.recorder.n ?? 0,
    info: document.getElementById('record-info')?.textContent.trim(),
  }));
  check('recording accumulates samples', grew.n > 5000, `${grew.n} samples — "${grew.info}"`);

  await page.click('#btn-record');  // stop
  await sleep(800);
  const stopped = await page.evaluate(() => document.getElementById('btn-export').disabled);
  check('Export enabled once stopped', stopped === false, `disabled=${stopped}`);

  await page.click('#btn-export');
  let files = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    files = (await fs.readdir(DL)).filter((f) => f.endsWith('.csv'));
    if (files.length) break;
  }
  check('CSV file actually downloads', files.length === 1, files.join(', ') || 'nothing downloaded');

  if (files.length) {
    const p = path.join(DL, files[0]);
    const text = await fs.readFile(p, 'utf8');
    const lines = text.trim().split('\n');
    const header = lines.find((l) => l.startsWith('time_s'));
    const rows = lines.filter((l) => /^[0-9]/.test(l));
    check('filename is descriptive', /^ecg-.*\.csv$/.test(files[0]), files[0]);
    check('CSV has the documented header', header === 'time_s,raw_adc,raw_volts,filtered_mv,r_peak', header);
    check('CSV carries metadata comments', text.includes('# mean_bpm'), lines[0]);
    check('CSV has a full session of rows', rows.length > 5000, `${rows.length} rows, ${(text.length / 1e6).toFixed(2)} MB`);

    const cols = rows.map((r) => r.split(','));
    const adc = cols.map((c) => Number(c[1]));
    const badAdc = adc.filter((v) => !Number.isFinite(v) || v < 0 || v > 1023).length;
    check('every raw_adc is a valid 10-bit count', badAdc === 0, `${badAdc} out of range`);
    const t = cols.map((c) => Number(c[0]));
    let monotonic = true;
    for (let i = 1; i < t.length; i++) if (t[i] <= t[i - 1]) { monotonic = false; break; }
    check('time column is strictly increasing', monotonic, `${t[0]} .. ${t[t.length - 1]} s`);
    const dt = t[1] - t[0];
    check('sample period matches the configured rate', Math.abs(1 / dt - 1000) < 1, `${(1 / dt).toFixed(1)} Hz`);
    const peaks = cols.filter((c) => c[4].trim() === '1').length;
    const dur = t[t.length - 1] - t[0];
    const csvBpm = (peaks / dur) * 60;
    check('r_peak column marks a plausible rate', csvBpm > 40 && csvBpm < 200, `${peaks} peaks over ${dur.toFixed(1)}s = ${csvBpm.toFixed(1)} BPM`);
    const mv = cols.map((c) => Number(c[3])).filter(Number.isFinite);
    const span = Math.max(...mv) - Math.min(...mv);
    check('filtered_mv has real signal amplitude', span > 0.2 && span < 20, `${span.toFixed(2)} mV peak-to-peak`);
  }

  // ------------------------------------------------------------------ audio
  section('Heart sounds');
  const a0 = await page.evaluate(() => ({ on: window.__ecg.audio.enabled, label: document.getElementById('btn-audio')?.textContent.trim() }));
  await page.click('#btn-audio'); await sleep(700);
  const a1 = await page.evaluate(() => window.__ecg.audio.enabled);
  check('audio button toggles state', a1 !== a0.on, `${a0.on} -> ${a1}`);
  await page.click('#btn-audio'); await sleep(500);
  const a2 = await page.evaluate(() => window.__ecg.audio.enabled);
  check('audio toggles back', a2 === a0.on, `${a1} -> ${a2}`);

  // -------------------------------------------------------------- 3D heart
  section('3D heart interaction');
  const fps = await page.evaluate(() => window.__ecg.fps);
  const gl = await page.evaluate(() => { try { const c = window.__ecg.heart.renderer.getContext();
    const d = c.getExtension('WEBGL_debug_renderer_info');
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : ''; } catch (e) { return ''; } });
  const software = /swiftshader|llvmpipe|software/i.test(gl);
  // This VPS has no GPU, so Chrome rasterises on the CPU and the ceiling is
  // the test host's, not the app's. Assert the loop runs; report the rate.
  check('render loop is running', fps > 5, `${fps} fps${software ? ' (CPU rasteriser on this host, not a GPU number)' : ''}`);
  console.log(`  NOTE  GL backend: ${gl || 'unknown'}`);
  const rot0 = await page.evaluate(() => { const m = window.__ecg.heart.mesh || window.__ecg.heart.group; return m ? m.rotation.y : null; });
  const box = await page.$eval('#heart-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 40, { steps: 20 });
  await page.mouse.up();
  await sleep(600);
  const rot1 = await page.evaluate(() => { const m = window.__ecg.heart.mesh || window.__ecg.heart.group; return m ? m.rotation.y : null; });
  check('drag rotates the heart', rot0 !== null && Math.abs(rot1 - rot0) > 0.05, `${rot0?.toFixed(3)} -> ${rot1?.toFixed(3)}`);
  await page.evaluate(() => document.getElementById('heart-canvas').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(1200);
  const rot2 = await page.evaluate(() => { const m = window.__ecg.heart.mesh || window.__ecg.heart.group; return m ? m.rotation.y : null; });
  check('double-click resets the view', Math.abs(rot2 - rot0) < Math.abs(rot1 - rot0), `back to ${rot2?.toFixed(3)}`);

  const phases = new Set();
  for (let i = 0; i < 30; i++) {
    phases.add(await page.$eval('#phase-label', (el) => el.textContent.trim()));
    await sleep(200);
  }
  check('heart cycles through systole and diastole', phases.size >= 2, [...phases].join(' / '));

  const beatStats = await page.evaluate(() => ({
    beats: document.getElementById('stat-beats')?.textContent,
    rr: document.getElementById('stat-rr')?.textContent,
    elapsed: document.getElementById('stat-elapsed')?.textContent,
    samples: document.getElementById('stat-samples')?.textContent,
  }));
  check('beat counter is live', Number(String(beatStats.beats).replace(/,/g, '')) > 0, `beats=${beatStats.beats}`);
  check('RR interval is displayed', /\d/.test(beatStats.rr || ''), `RR=${beatStats.rr}`);
  check('session clock advancing', /[1-9]/.test(beatStats.elapsed || ''), `elapsed=${beatStats.elapsed}`);
  check('sample counter advancing', Number(String(beatStats.samples).replace(/,/g, '')) > 1000, `samples=${beatStats.samples}`);

  // ---------------------------------------------------------- responsiveness
  section('Responsiveness');
  const viewports = [
    ['mobile-portrait', 375, 667, true],
    ['mobile-large', 414, 896, true],
    ['tablet-portrait', 768, 1024, true],
    ['tablet-landscape', 1024, 768, false],
    ['laptop', 1366, 768, false],
    ['desktop-hd', 1920, 1080, false],
    ['ultrawide', 2560, 1080, false],
  ];
  for (const [name, w, h, mobile] of viewports) {
    await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    await sleep(2500);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const canvas = document.getElementById('heart-canvas').getBoundingClientRect();
      return {
        overflow: de.scrollWidth - de.clientWidth,
        canvasW: Math.round(canvas.width), canvasH: Math.round(canvas.height),
        bpm: vis('bpm-value'), chart: vis('ecg-canvas') || !!document.querySelector('canvas'),
        controls: vis('sim-controls'), header: vis('status-pill'),
      };
    });
    const ok = m.overflow <= 1 && m.bpm && m.controls && m.canvasW > 0 && m.canvasH > 0;
    check(`${name} ${w}x${h}`, ok,
          `overflow ${m.overflow}px, heart canvas ${m.canvasW}x${m.canvasH}, bpm=${m.bpm} controls=${m.controls}`);
    await page.screenshot({ path: path.join(OUT, `responsive-${name}.png`) });
  }

  await page.setViewport({ width: 1400, height: 900 });
  await sleep(1500);

  section('Console hygiene');
  const noisy = consoleErrors.filter((e) => !/favicon|serial|Failed to load resource.*40[34]/i.test(e));
  check('no unexpected console errors', noisy.length === 0, noisy.slice(0, 2).join(' | ') || 'clean');

  await page.screenshot({ path: path.join(OUT, 'final-dashboard.png') });
  await browser.close();

  console.log('\n' + '='.repeat(74));
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  Failures:'); failures.forEach((f) => console.log(`    - ${f}`)); }
  console.log('='.repeat(74));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
