/**
 * USB driver setup: the panel, the identification, and the confirmation.
 *
 * A CH340 board with no driver is indistinguishable from a broken one, so the
 * app has to raise it before the user hits it. Chrome will not hand a headless
 * browser a real serial port, so navigator.serial.requestPort is stubbed to
 * return a device with a chosen VID/PID -- what is under test is the app's
 * identification and messaging, not Chrome's picker.
 */
import puppeteer from 'puppeteer';

const BASE = process.env.ECG_URL || 'https://ecg.192-99-245-44.nip.io';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
const check = (l, ok, d='') => { console.log(`  ${ok?'PASS':'FAIL'}  ${l}${d?'  -- '+d:''}`); ok?pass++:(fail++,failures.push(l)); };

const browser = await puppeteer.launch({ headless:'new',
  args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-unsafe-swiftshader'] });

async function open({ installed = false, device = null, empty = false, ua = null } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  // driverInfo() branches on the user agent, and the runner is Linux, so the
  // Windows path has to be asked for explicitly rather than assumed.
  if (ua) await p.setUserAgent(ua);
  await p.evaluateOnNewDocument((installed, device, empty) => {
    if (installed) {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => q.includes('display-mode: standalone')
        ? { matches:true, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }
        : real(q);
    }
    // Headless Chrome exposes navigator.serial but never a real port.
    const fake = device && {
      getInfo: () => ({ usbVendorId: device.vid, usbProductId: device.pid }),
      open: async () => {}, close: async () => {},
      readable: null, writable: null,
    };
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: {
        getPorts: async () => [],
        requestPort: async () => {
          if (empty || !fake) { const e = new Error('No port selected.'); e.name = 'NotFoundError'; throw e; }
          return fake;
        },
        addEventListener(){}, removeEventListener(){},
      },
    });
  }, installed, device, empty);
  await p.goto(BASE, { waitUntil:'domcontentloaded', timeout:60000 });
  await p.waitForFunction('window.__ecg !== undefined', { timeout:90000, polling:500 });
  return p;
}
const visible = (p) => p.evaluate(() => {
  const el = document.getElementById('driver-modal');
  return !!el && !el.classList.contains('hidden');
});

console.log('\nUSB driver setup');
console.log('-'.repeat(74));

// 1. a browser tab should not be interrupted
let p = await open({ installed: false });
await sleep(3500);
check('does not interrupt a plain browser tab', !(await visible(p)));
await p.close();

// 2. an installed app with no board granted should be offered setup.
//    Posing as Windows, since that is the only platform that needs a download.
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
p = await open({ installed: true, empty: true, ua: WIN_UA });
await sleep(4000);
check('offers setup automatically on an installed app', await visible(p));
const platform = await p.evaluate(() => ({
  note: document.getElementById('driver-platform-note')?.textContent.trim(),
  href: document.getElementById('driver-download')?.getAttribute('href'),
  label: document.getElementById('driver-download')?.textContent.trim(),
}));
check('offers the Windows driver on Windows', /wch-ic\.com/.test(platform.href || ''),
      `${platform.label} -> ${platform.href}`);

// 3. an empty picker must be read as the driver symptom
await p.click('#driver-check');
await sleep(1500);
const emptyMsg = await p.evaluate(() => document.getElementById('driver-result')?.textContent || '');
check('an empty picker is explained as a driver problem', /driver is missing|not plugged in/i.test(emptyMsg),
      emptyMsg.replace(/\s+/g,' ').slice(0, 72));
await p.close();

// 3b. On Linux the driver is in the kernel, so offering a download would be
//     misleading. The panel must say so instead.
p = await open({ installed: true, empty: true });
await sleep(4000);
const linux = await p.evaluate(() => ({
  note: document.getElementById('driver-platform-note')?.textContent.trim(),
  hidden: document.getElementById('driver-download')?.classList.contains('hidden'),
}));
check('offers no download on Linux, and says why', linux.hidden === true && /kernel/i.test(linux.note),
      linux.note?.slice(0, 62));
await p.close();

// 4. a CH340 must be named, and confirmed
p = await open({ installed: true, device: { vid: 0x1a86, pid: 0x7523 } });
await sleep(4000);
await p.click('#driver-check');
await sleep(1500);
const ok340 = await p.evaluate(() => document.getElementById('driver-result')?.textContent || '');
check('identifies a CH340 by name', /CH340 \(WCH\)/.test(ok340), ok340.replace(/\s+/g,' ').slice(0,70));
check('confirms the user is good to go', /good to go/i.test(ok340));
await p.close();

// 5. a genuine Uno should be named too
p = await open({ installed: true, device: { vid: 0x2341, pid: 0x0043 } });
await sleep(4000);
await p.click('#driver-check');
await sleep(1500);
const okUno = await p.evaluate(() => document.getElementById('driver-result')?.textContent || '');
check('identifies a genuine Arduino Uno', /Uno R3 \(Arduino\)/.test(okUno), okUno.replace(/\s+/g,' ').slice(0,60));

// 6. dismissal must stick
await p.evaluate(() => { document.getElementById('driver-dismiss').checked = true; document.getElementById('driver-close').click(); });
await sleep(500);
const stored = await p.evaluate(() => localStorage.getItem('ecg.driverSetupSeen'));
check('remembers "do not show again"', stored === '1', `ecg.driverSetupSeen=${stored}`);
check('and the panel closes', !(await visible(p)));
await p.screenshot({ path: 'out/driver-setup.png' });
await p.close();

await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
failures.forEach(f => console.log(`    - ${f}`));
process.exit(fail ? 1 : 0);
