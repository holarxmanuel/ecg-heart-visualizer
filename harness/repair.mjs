/**
 * The install that cannot fix itself.
 *
 * The field failure was a shell that rendered while its module bundle did not
 * load: the page sat on "Generating cardiac anatomy" with no JavaScript
 * running, and therefore no way to be told anything, offline or not. The cause
 * varies (a stale worker holding an index whose asset names have been purged,
 * a half-finished precache); the condition is always the same, so that is what
 * this asserts against.
 */
import puppeteer from 'puppeteer';
import { rmSync } from 'node:fs';

const BASE = process.env.ECG_URL || 'http://127.0.0.1:8012';
const PROFILE = '/tmp/claude-1000/-home-ubuntu/42a171d5-d57e-46c7-b3e1-1f8d10d15314/scratchpad/prof-repair';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
const check = (l, ok, d='') => { console.log(`  ${ok?'PASS':'FAIL'}  ${l}${d?'  -- '+d:''}`); ok?pass++:(fail++,failures.push(l)); };
rmSync(PROFILE, { recursive:true, force:true });

console.log('\nA broken install repairing itself');
console.log('-'.repeat(74));

const browser = await puppeteer.launch({ headless:'new', userDataDir:PROFILE,
  args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await browser.newPage();

// Break the bundle, and keep Chrome's own HTTP cache out of it so the break
// is real: /assets/* ships `immutable`, so a cached copy would satisfy the
// request without any network involvement.
await p.setCacheEnabled(false);
await p.setRequestInterception(true);
let blocking = true;
p.on('request', (r) => {
  if (blocking && /\/assets\/index-.*\.js$/.test(r.url())) return r.respond({ status: 404, body: 'gone' });
  r.continue();
});

await p.goto(BASE, { waitUntil:'domcontentloaded', timeout:40000 });
await sleep(2500);
const stuck = await p.evaluate(() => ({
  scriptRan: window.__ecgScriptStarted === true,
  ecg: typeof window.__ecg,
  status: document.getElementById('boot-status')?.textContent.trim(),
}));
check('reproduces the field symptom exactly', !stuck.scriptRan && stuck.ecg === 'undefined',
      `boot-status: "${stuck.status}"`);
check('and it is the static shell, not the running app',
      stuck.status === 'Generating cardiac anatomy…',
      'no quality in brackets means no JS ran');

// The watchdog waits 12 s, wipes, and reloads. Let the bundle through then,
// standing in for the user reconnecting.
await sleep(9000);
blocking = false;
let recovered = true, err = '';
try {
  await p.waitForFunction('window.__ecg !== undefined', { timeout:60000, polling:500 });
} catch (e) { recovered = false; err = String(e).split('\n')[0].slice(0,60); }
check('watchdog repairs it and the app starts', recovered, err);

if (recovered) {
  const after = await p.evaluate(async () => ({
    caches: (await caches.keys()).length,
    bpm: !!document.getElementById('bpm-value'),
    boot: (() => { const el = document.getElementById('boot');
      return el ? getComputedStyle(el).display === 'none' || el.hidden : true; })(),
  }));
  check('boot overlay cleared', after.boot);
  check('app is usable again', after.bpm);
}

// It must never loop. The one-shot guard is armed after a repair, so a second
// failure hands the user a Repair button instead of reloading forever. The
// second failure itself cannot be staged here: after a successful repair the
// worker holds the bundle again, so blocking the network no longer breaks it.
const guard = await p.evaluate(() => { try { return sessionStorage.getItem('ecg.repaired'); } catch { return null; } });
check('one-shot guard armed, so a repeat failure asks rather than loops', guard === '1', `ecg.repaired=${guard}`);

await p.screenshot({ path:'out/repair.png' });
await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
failures.forEach(f => console.log(`    - ${f}`));
process.exit(fail ? 1 : 0);
