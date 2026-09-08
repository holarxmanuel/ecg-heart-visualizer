import puppeteer from 'puppeteer';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({width:1400,height:900});
await p.goto(process.env.ECG_URL, {waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__ecg !== undefined',{timeout:90000,polling:500});
const lbl = await p.evaluate(()=>document.getElementById('btn-start-label').textContent.trim());
if(!/pause/i.test(lbl)) await p.click('#btn-start');
await sleep(12000);
console.log(await p.evaluate(async () => {
  const c = window.__ecg.chart;
  const fs = (await (await fetch('/api/config')).json()).fs;
  return { serverFs: fs, chartSampleRate: c.sampleRate, chartCapacity: c.capacity,
           windowSeconds: c.windowSeconds,
           impliedWindowSeconds: c.capacity / c.sampleRate,
           engineFs: window.__ecg.engine ? window.__ecg.engine.sampleRate : null };
}));
await b.close();
