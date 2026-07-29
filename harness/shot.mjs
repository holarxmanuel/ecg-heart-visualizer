import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage();
await p.setViewport({width: 1000, height: 1000, deviceScaleFactor: 1});
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://localhost:8000?quality=high',{waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
// Force full detail even though this box has no GPU -- we are judging looks, not speed.
await p.evaluate(()=>{ window.__ecg.heart.uniforms.uDetail.value = 1.0; });
await p.evaluate(()=>window.__ecg.link.useLocal('simulate'));
await new Promise(r=>setTimeout(r,6000));
// Drive the model to mid-diastole so the chambers are full and rounded.
// Freeze mid-diastole: chambers full and rounded, the pose to judge.
await p.evaluate(()=>{const h=window.__ecg.heart; h.lastBeatAt=-999; h.systole=0; h.fill=1; h.atrial=0;});
await new Promise(r=>setTimeout(r,3000));
const el = await p.$('#heart-canvas');
await (el||p).screenshot({path:'/root/ecg-harness/heart.png'});
console.log('errors:', errs.slice(0,5).join(' | ') || 'none');
await b.close();
