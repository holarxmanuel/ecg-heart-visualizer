import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function run(label, args) {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-dev-shm-usage', ...args] });
  const p = await b.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto('http://localhost:8000', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__ecg !== undefined', { timeout: 90000, polling: 500 });
  await sleep(8000);
  const r = await p.evaluate(() => ({
    fps: window.__ecg.fps,
    renderer: (() => { try { const gl = window.__ecg.heart.renderer.getContext();
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { return 'n/a'; } })(),
    tris: window.__ecg.renderInfo.triangles,
    calls: window.__ecg.renderInfo.calls,
  }));
  console.log(`  ${label}: ${r.fps} fps | ${r.tris} tris, ${r.calls} draw calls | GL: ${r.renderer}`);
  await b.close();
}
await run('software GL (swiftshader)', ['--use-gl=swiftshader','--enable-unsafe-swiftshader']);
await run('default GL             ', []);
