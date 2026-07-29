import puppeteer from 'puppeteer';
// Two pages plus a 1 kHz backend saturate a 2-vCPU box when WebGL is in
// software, so CDP calls can take far longer than the 30 s default.
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
const read = (p) => p.evaluate(()=>({
  bpm:Number(document.getElementById('sim-bpm').value),
  bpmLbl:document.getElementById('sim-bpm-val').textContent,
  noise:Number(document.getElementById('sim-noise').value),
  art:document.getElementById('sim-artifacts').checked,
  shown:document.getElementById('bpm-value').textContent,
}));

console.log('\nTwo users on the shared online session');
const u1 = await open(); const u2 = await open();
await sleep(1500);
ck('both on the server session', true);

console.log('\nUser 2 sets 100 BPM');
await u2.evaluate(()=>{const s=document.getElementById('sim-bpm');s.value=100;s.dispatchEvent(new Event('input',{bubbles:true}));});
await sleep(3000);
let a = await read(u1);
ck("user 1's slider follows", a.bpm===100, `slider=${a.bpm} label=${a.bpmLbl}`);

console.log('\nUser 1 sets 50 BPM');
await u1.evaluate(()=>{const s=document.getElementById('sim-bpm');s.value=50;s.dispatchEvent(new Event('input',{bubbles:true}));});
await sleep(3000);
let c = await read(u2);
ck("user 2's slider follows", c.bpm===50, `slider=${c.bpm} label=${c.bpmLbl}`);

console.log('\nNoise + artifacts propagate too');
await u2.evaluate(()=>{const s=document.getElementById('sim-noise');s.value=42;s.dispatchEvent(new Event('input',{bubbles:true}));
  const a=document.getElementById('sim-artifacts');a.checked=false;a.dispatchEvent(new Event('change',{bubbles:true}));});
await sleep(3000);
let d = await read(u1);
ck('noise follows', d.noise===42, `noise=${d.noise}`);
ck('artifacts follow', d.art===false, `artifacts=${d.art}`);

console.log('\nA remote broadcast must not fight a local drag');
// Hold user 1 mid-drag while user 2 changes the value.
await u1.evaluate(()=>{const s=document.getElementById('sim-bpm');s.value=77;s.dispatchEvent(new Event('input',{bubbles:true}));});
await u2.evaluate(()=>{const s=document.getElementById('sim-bpm');s.value=140;s.dispatchEvent(new Event('input',{bubbles:true}));});
await sleep(700);
const mid = await read(u1);
ck('local edit wins during the echo window', mid.bpm===77, `slider=${mid.bpm}`);
await sleep(3500);
const after = await read(u1);
ck('remote value applies once the drag settles', after.bpm===140, `slider=${after.bpm}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
