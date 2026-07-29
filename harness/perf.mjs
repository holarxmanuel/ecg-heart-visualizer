import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage();
await p.setViewport({width:1200,height:800});
await p.goto('http://localhost:8000',{waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
const info = await p.evaluate(()=>({
  softwareGL: window.__ecg.heart.softwareGL,
  uDetail: window.__ecg.heart.uniforms.uDetail.value,
  quality: window.__ecg.heart.quality,
  tris: window.__ecg.heart.mesh.geometry.index.count/3,
  pixelRatio: window.__ecg.heart.renderer.getPixelRatio(),
}));
console.log('render guard:', JSON.stringify(info));
// Time a batch of frames with detail off then on, to size the cost.
const timeFrames = async (detail) => {
  await p.evaluate((d)=>{ window.__ecg.heart.uniforms.uDetail.value=d; }, detail);
  return p.evaluate(()=>new Promise(res=>{
    const h=window.__ecg.heart; const t0=performance.now(); let n=0;
    const tick=()=>{ h.update(0.016); h.renderer.render(h.scene,h.camera); n++;
      if(n<30) requestAnimationFrame(tick); else res((performance.now()-t0)/n); };
    tick();
  }));
};
console.log('ms/frame detail=0:', (await timeFrames(0)).toFixed(1));
console.log('ms/frame detail=1:', (await timeFrames(1)).toFixed(1));
await b.close();
