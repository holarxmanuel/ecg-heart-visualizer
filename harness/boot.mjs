import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',protocolTimeout:180000,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage();
p.on('pageerror',e=>console.log('PAGEERROR:',e.message,'\n',(e.stack||'').split('\n').slice(0,5).join('\n')));
p.on('console',m=>console.log(`[${m.type()}]`,m.text()));
await p.goto('http://localhost:8000?quality=low',{waitUntil:'domcontentloaded'});
for (const t of [3000,6000,12000,20000]) {
  await new Promise(r=>setTimeout(r,t===3000?t:t-(t/2)));
  const st = await p.evaluate(()=>({ecg:typeof window.__ecg, boot:document.getElementById('boot-status')?.textContent}));
  console.log(`  t~${t}ms  __ecg=${st.ecg}  boot="${st.boot}"`);
  if (st.ecg==='object') break;
}
await b.close();
