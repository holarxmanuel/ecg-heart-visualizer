import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage();
const errs=[]; const toasts=[];
p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
p.on('console',m=>{if(m.type()==='error')errs.push('console '+m.text());});
p.on('requestfailed',r=>errs.push('REQ '+r.url()));
await p.evaluateOnNewDocument(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => q.includes('display-mode: standalone')
    ? {matches:true,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}} : real(q);
});
await p.setViewport({width:1440,height:900});
await p.goto('http://localhost:8000?quality=low',{waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
await p.evaluate(()=>{window.__ecg.heart.enabled=false;});

console.log('--- 1. switch to Offline while still online ---');
await p.evaluate(()=>document.getElementById('mode-offline').click());
await new Promise(r=>setTimeout(r,2000));
const snap = async (tag) => {
  const s = await p.evaluate(()=>({
    sliderValue: document.getElementById('sim-bpm').value,
    sliderLabel: document.getElementById('sim-bpm-val').textContent,
    engineBpm: window.__ecg.engine.simConfig.bpm,
    detectorBpm: Math.round(window.__ecg.engine.detector.bpm),
    displayedBpm: document.getElementById('bpm-value').textContent,
    linkMode: window.__ecg.linkState.mode,
    userMode: window.__ecg.modeState.mode,
    wsOpen: window.__ecg.link.conn.connected,
    startLabel: document.getElementById('btn-start-label').textContent,
  }));
  console.log(`  ${tag}: slider=${s.sliderValue} label=${s.sliderLabel} engineCfg=${s.engineBpm} detected=${s.detectorBpm} shown=${s.displayedBpm} link=${s.linkMode}/${s.userMode} ws=${s.wsOpen} btn="${s.startLabel}"`);
  return s;
};
await snap('after switch');

console.log('--- 2. cut the network, then reload (== closed & reopened) ---');
await p.setOfflineMode(true);
await new Promise(r=>setTimeout(r,1500));
await p.reload({waitUntil:'domcontentloaded',timeout:60000});
await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
await p.evaluate(()=>{window.__ecg.heart.enabled=false;});
await new Promise(r=>setTimeout(r,4000));
await snap('after reopen');

console.log('--- 3. move the BPM slider ---');
errs.length=0;
await p.evaluate(()=>{const s=document.getElementById('sim-bpm'); s.value=95; s.dispatchEvent(new Event('input',{bubbles:true}));});
await new Promise(r=>setTimeout(r,2500));
const t1 = await p.evaluate(()=>document.getElementById('toast-body')?.textContent||'');
console.log(`  toast after slider: "${t1}"`);
await snap('after slider=95');

console.log('--- 4. click Pause ---');
await p.evaluate(()=>document.getElementById('btn-start').click());
await new Promise(r=>setTimeout(r,2500));
const t2 = await p.evaluate(()=>document.getElementById('toast-body')?.textContent||'');
console.log(`  toast after pause:  "${t2}"`);
const paused = await p.evaluate(()=>({enginePaused: window.__ecg.engine.paused, btn: document.getElementById('btn-start-label').textContent}));
console.log(`  enginePaused=${paused.enginePaused} btn="${paused.btn}"`);
console.log('  errors:', errs.slice(0,4).join(' | ')||'none');
await b.close();
