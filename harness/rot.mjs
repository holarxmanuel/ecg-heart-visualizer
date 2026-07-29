import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage();
await p.setViewport({width:1440,height:900});
await p.goto('http://localhost:8000?quality=medium',{waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__ecg!==undefined',{timeout:120000,polling:500});
await new Promise(r=>setTimeout(r,2000));
// Project every vertex at a range of yaw/pitch and check it lands inside NDC.
const res = await p.evaluate(() => {
  const h = window.__ecg.heart;
  const THREE_pos = h.mesh.geometry.attributes.position;
  const out = [];
  for (const yaw of [0, 0.8, 1.6, 2.4, 3.14, -0.8, -1.6]) {
    for (const pitch of [0, 0.5, -0.5]) {
      h.yaw = yaw; h.pitch = pitch;
      h.mesh.rotation.y = yaw; h.mesh.rotation.x = pitch;
      h.mesh.updateMatrixWorld(true);
      h.camera.updateMatrixWorld(true);
      let worst = 0;
      const v = new (h.mesh.geometry.constructor === Object ? Object : Object)();
      const tmp = new (window.__ecg.heart.camera.constructor.prototype.constructor === Object ? Object : Object)();
      // Manual projection using three's matrices via the mesh
      const m = h.mesh.matrixWorld.elements;
      const vp = h.camera.projectionMatrix.clone().multiply(h.camera.matrixWorldInverse).multiply(h.mesh.matrixWorld).elements;
      for (let i = 0; i < THREE_pos.count; i += 7) {
        const x = THREE_pos.getX(i), y = THREE_pos.getY(i), z = THREE_pos.getZ(i);
        const cw = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
        const cx = (vp[0]*x + vp[4]*y + vp[8]*z + vp[12]) / cw;
        const cy = (vp[1]*x + vp[5]*y + vp[9]*z + vp[13]) / cw;
        worst = Math.max(worst, Math.abs(cx), Math.abs(cy));
      }
      out.push({yaw:+yaw.toFixed(2), pitch, worstNdc:+worst.toFixed(3), clipped: worst > 1.0});
    }
  }
  h.yaw = 0; h.pitch = 0;
  return out;
});
const bad = res.filter(r=>r.clipped);
for (const r of res) console.log(`  yaw=${String(r.yaw).padStart(5)} pitch=${String(r.pitch).padStart(4)}  worst|ndc|=${r.worstNdc}  ${r.clipped?'CLIPPED':'ok'}`);
console.log(bad.length ? `\n${bad.length}/${res.length} orientations clip` : `\nno clipping at any of ${res.length} orientations`);
await b.close();
