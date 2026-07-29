import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage();
const failed=[]; p.on('requestfailed',r=>failed.push(r.url()));
await p.evaluateOnNewDocument(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => q.includes('display-mode: standalone')
    ? {matches:true,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}} : real(q);
});
await p.setViewport({width:1440,height:900});
await p.goto('http://localhost:8000?quality=low',{waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
await p.evaluate(()=>{window.__ecg.heart.enabled=false;});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const ck=(l,ok,d='')=>{console.log(`  ${ok?'PASS':'FAIL'}  ${l}${d?'  -- '+d:''}`); ok?pass++:fail++;};

console.log('\nONLINE mode (installed app, server reachable)');
await p.waitForFunction("window.__ecg.linkState.mode==='server'",{timeout:40000,polling:300});
ck('drives from the server', true);
// Establish a known baseline: an earlier run may have left the server paused,
// and a toggle test that does not control its starting state proves nothing.
await p.evaluate(async()=>{await fetch('/api/monitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({running:true})});});
await sleep(1200);
const base = await p.evaluate(async()=>((await (await fetch('/api/status')).json()).paused));
ck('baseline: server running', base === false, `paused=${base}`);
// Pause via the button must hit the server, not the local engine.
await p.evaluate(()=>document.getElementById('btn-start').click());
await sleep(1500);
let st = await p.evaluate(async()=>({
  btn: document.getElementById('btn-start-label').textContent,
  serverPaused: (await (await fetch('/api/status')).json()).paused,
  enginePaused: window.__ecg.engine.paused,
}));
ck('Pause reaches the SERVER online', st.serverPaused === true, `serverPaused=${st.serverPaused}`);
ck('local engine untouched online', st.enginePaused === false);
ck('button flips to Resume', st.btn === 'Resume', st.btn);
await p.evaluate(()=>document.getElementById('btn-start').click());
await sleep(1500);
st = await p.evaluate(async()=>((await (await fetch('/api/status')).json()).paused));
ck('Resume reaches the server', st === false, `serverPaused=${st}`);

// Slider online must reach the server.
await p.evaluate(()=>{const s=document.getElementById('sim-bpm'); s.value=88; s.dispatchEvent(new Event('input',{bubbles:true}));});
await sleep(1500);
const cfg = await p.evaluate(async()=>(await (await fetch('/api/config')).json()).sim);
ck('slider reaches the server online', Math.round(cfg.bpm) === 88, `server bpm=${cfg.bpm}`);

console.log('\nElapsed clock (was stuck at 00:00)');
const el = await p.evaluate(()=>document.getElementById('stat-elapsed').textContent);
ck('session clock is running', el !== '00:00', `"${el}"`);

console.log('\nSwitch to OFFLINE');
failed.length = 0;
await p.evaluate(()=>document.getElementById('mode-offline').click());
await sleep(3000);
const off = await p.evaluate(()=>({ws: window.__ecg.link.conn.connected, link: window.__ecg.linkState.mode}));
ck('socket closed', off.ws === false);
ck('driving locally', off.link === 'local', off.link);
failed.length = 0;
await sleep(6000);
ck('no network requests at all while offline', failed.length === 0, failed.slice(0,2).join(', '));

console.log('\nSwitch back to ONLINE');
await p.evaluate(()=>document.getElementById('mode-online').click());
const back = await p.waitForFunction("window.__ecg.linkState.mode==='server'",{timeout:40000,polling:300}).then(()=>true).catch(()=>false);
ck('reconnects and resumes server processing', back);
await sleep(2000);
const cfg2 = await p.evaluate(async()=>(await (await fetch('/api/config')).json()).sim);
ck('local settings carried up to the server', Math.round(cfg2.bpm) === 88 || Math.round(cfg2.bpm) === Math.round(cfg.bpm), `server bpm=${cfg2.bpm}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
