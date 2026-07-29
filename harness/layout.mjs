import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const sizes = [
  ['desktop-1920x1080', 1920, 1080],
  ['laptop-1440x900',   1440, 900],
  ['small-1366x768',    1366, 768],
  ['tablet-1024x768',   1024, 768],
  ['phone-390x844',     390,  844],
];
for (const [name, w, h] of sizes) {
  const p = await b.newPage();
  await p.setViewport({width:w, height:h});
  await p.goto('http://localhost:8000?quality=low',{waitUntil:'domcontentloaded'});
  await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
  await new Promise(r=>setTimeout(r,2500));
  const m = await p.evaluate(() => {
    const q = (s)=>document.querySelector(s);
    const r = (el)=>{const b=el.getBoundingClientRect();return {top:Math.round(b.top),bottom:Math.round(b.bottom),h:Math.round(b.height),w:Math.round(b.width)};};
    return {
      vh: window.innerHeight,
      docH: document.documentElement.scrollHeight,
      // Either element can be the scroller depending on the CSS, so check both.
      scrollRoot: document.documentElement.scrollHeight > window.innerHeight + 2 ? 'html' : (document.body.scrollHeight > window.innerHeight + 2 ? 'body' : 'none'),
      heart: r(q('#heart-canvas')),
      ecg:   r(q('#ecg-canvas')),
      hOverflowsX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });
  const ecgVisible = m.ecg.bottom <= m.vh + 1 && m.ecg.top >= 0;
  const heartVisible = m.heart.bottom <= m.vh + 1 && m.heart.h > 100;
  const above = m.heart.bottom <= m.ecg.top + 1;
  console.log(
    `${name.padEnd(20)} vh=${String(m.vh).padStart(4)} doc=${String(m.docH).padStart(4)}` +
    ` heart=${String(m.heart.h).padStart(4)}px ecg=${String(m.ecg.h).padStart(3)}px` +
    ` | ecgVisible=${ecgVisible?'Y':'N'} heartVisible=${heartVisible?'Y':'N'}` +
    ` above=${above?'Y':'N'} scroller=${m.scrollRoot} scrollX=${m.hOverflowsX?'Y':'N'}`
  );
  if (name.startsWith('desktop') || name.startsWith('laptop')) {
    await p.screenshot({path:`/root/ecg-harness/layout-${name}.png`});
  }
  await p.close();
}
await b.close();
