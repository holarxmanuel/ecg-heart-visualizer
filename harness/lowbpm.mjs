import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.goto('http://localhost:8000', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 });
for (const bpm of [30, 40, 50, 200]) {
  await p.evaluate((v) => { const s = document.getElementById('sim-bpm'); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }, bpm);
  // 8 RR medians at 30 BPM is 16 s; give every rate 12 beats of settle.
  await sleep(Math.max(20000, (60 / bpm) * 12 * 1000));
  const r = await p.evaluate(async () => { const s = await (await fetch('/api/status')).json(); return { bpm: s.bpm, sim: s.extra.bpm, ui: document.getElementById('bpm-value').textContent }; });
  const err = Math.abs(r.bpm - bpm);
  console.log(`  ${err <= bpm * 0.05 + 1 ? 'PASS' : 'FAIL'}  ${bpm} BPM -> server ${r.bpm}, UI ${r.ui} (sim set to ${r.sim}), err ${err.toFixed(1)}`);
}
await b.close();
