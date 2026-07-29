import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',protocolTimeout:180000,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const ck=(l,ok,d='')=>{console.log(`  ${ok?'PASS':'FAIL'}  ${l}${d?'  -- '+d:''}`);ok?pass++:fail++;};
const open = async () => {
  const p = await b.newPage();
  await p.setViewport({width:1400,height:900});
  await p.goto('http://localhost:8000?quality=low',{waitUntil:'domcontentloaded'});
  await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
  await p.evaluate(()=>{window.__ecg.heart.enabled=false;});
  await p.waitForFunction("window.__ecg.linkState.mode==='server'",{timeout:40000,polling:300});
  return p;
};

const u1 = await open(); const u2 = await open();
await sleep(1500);
// Known baseline.
await u1.evaluate(async()=>{await fetch('/api/simulation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bpm:70})});});
await sleep(2000);

console.log('\nUser 2 asks for their own sensor (none attached here)');
await u2.evaluate(()=>document.getElementById('btn-serial').click());
await sleep(3000);
const s2 = await u2.evaluate(()=>({
  link: window.__ecg.linkState.mode,
  priv: window.__ecg.linkState.privateSession,
  engineSrc: !!window.__ecg.engine.source,
  hint: document.getElementById('serial-hint').textContent,
  sensorState: document.getElementById('sensor-state').textContent,
  pill: document.getElementById('link-label').textContent,
}));
ck('detached from the shared session', s2.link === 'local' && s2.priv === true, `${s2.link} private=${s2.priv}`);
ck('reading stopped (no source)', s2.engineSrc === false);
ck('does NOT fall back to the shared simulation', s2.engineSrc === false);
ck('pill reads Private', s2.pill === 'Private', `"${s2.pill}"`);
// The picker is user-driven, so "waiting to choose" is a legitimate resting
// state here; what must never happen is silently showing someone else's trace.
ck('panel explains the state', /No board|stopped|selected|choose|looking/i.test(s2.sensorState + s2.hint), `"${s2.sensorState}"`);

console.log('\nUser 1 (still shared) is unaffected');
const s1 = await u1.evaluate(()=>({link: window.__ecg.linkState.mode, samples: window.__ecg.state.samples}));
await sleep(2500);
const s1b = await u1.evaluate(()=>({link: window.__ecg.linkState.mode, samples: window.__ecg.state.samples}));
ck('user 1 still on the shared session', s1b.link === 'server', s1b.link);
ck('user 1 still receiving data', s1b.samples > s1.samples, `+${s1b.samples - s1.samples} samples`);
const srv = await u1.evaluate(async()=>await (await fetch('/api/status')).json());
ck('server source untouched by the detach', srv.mode === 'simulating', srv.mode);

console.log('\nGlobal changes must not reach the detached user');
const before2 = await u2.evaluate(()=>Number(document.getElementById('sim-bpm').value));
await u1.evaluate(()=>{const s=document.getElementById('sim-bpm');s.value=155;s.dispatchEvent(new Event('input',{bubbles:true}));});
await sleep(3500);
const after2 = await u2.evaluate(()=>Number(document.getElementById('sim-bpm').value));
ck("detached user's slider does NOT follow", after2 === before2, `${before2} -> ${after2}`);
const u1now = await u1.evaluate(()=>Number(document.getElementById('sim-bpm').value));
ck('shared user still sees the global value', u1now === 155, `${u1now}`);

console.log('\nRejoining puts the user back in the shared session');
await u2.evaluate(()=>document.getElementById('btn-sim').click());
const rejoined = await u2.waitForFunction("window.__ecg.linkState.mode==='server'",{timeout:40000,polling:300}).then(()=>true).catch(()=>false);
ck('rejoined the shared session', rejoined);
await sleep(3000);
const back = await u2.evaluate(()=>({priv: window.__ecg.linkState.privateSession, bpm: Number(document.getElementById('sim-bpm').value)}));
ck('private flag cleared', back.priv === false);
ck('slider picks up the global value again', back.bpm === 155, `${back.bpm}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
