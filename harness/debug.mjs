import puppeteer from 'puppeteer';
const BASE = process.env.ECG_URL || 'http://localhost:8000';
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
         '--disable-background-timer-throttling','--use-gl=angle',
      '--use-angle=swiftshader',
      // Chrome 137+ refuses software WebGL without this; without it the
      // renderer throws and the app never finishes booting.
      '--enable-unsafe-swiftshader','--mute-audio'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message, '\n', e.stack?.split('\n').slice(0,4).join('\n')));
page.on('requestfailed', (r) => console.log('[REQFAIL]', r.url(), r.failure()?.errorText));
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
await new Promise((r) => setTimeout(r, 6000));
const info = await page.evaluate(() => ({
  hasEcg: typeof window.__ecg,
  bootText: document.getElementById('boot-status')?.textContent,
  bootVisible: !document.getElementById('boot')?.classList.contains('opacity-0'),
  title: document.title,
  scripts: [...document.querySelectorAll('script')].map(s=>s.src||'inline'),
}));
console.log('\nPAGE STATE:', JSON.stringify(info, null, 2));
await browser.close();
