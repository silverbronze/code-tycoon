// Visual + runtime probe: node scripts/probe.mjs [outDir] [--full-replay]
import { chromium } from 'playwright';
const out = process.argv[2] || 'probe-out';
const fullReplay = process.argv.includes('--full-replay');
const base = process.env.URL || 'http://127.0.0.1:4400';
if (!process.env.PID) { console.error('Set PID to a tracked project id (its folder path, e.g. PID=c:/code/myapp).'); process.exit(1); }
const pid = encodeURIComponent(process.env.PID);
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];

for (const [w, h] of [[1280, 800], [1920, 1080]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${w}] ${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => errors.push(`[${w}] pageerror: ${e.message}`));
  await page.goto(base + '/');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/overview-${w}.png` });
  await page.goto(base + '/#/p/' + pid);
  await page.waitForFunction(() => window.__view?.world, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/city-${w}.png` });
  const fps = [];
  for (let i = 0; i < 5; i++) fps.push(await page.evaluate(async () => { await new Promise(r => setTimeout(r, 600)); return Math.round(window.__view.stage.fps); }));
  console.log(`${w}x${h} live fps median ${median(fps)} (${fps.join(',')})`);
  // click a busy building -> inspect panel
  const hit = await page.evaluate(() => { const v = window.__view; const f = v.city.files.reduce((b, f, i) => f.w > v.city.files[b].w ? i : b, 0); v.select({ tt: 0, ti: f }, true); return v.city.files[f].p; });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${out}/inspect-${w}.png` });
  console.log('inspected', hit);
  if (w === 1280) {
    await page.evaluate(() => { const v = window.__view; v.select(null); v.stage.flyTo(0, 0, (v.city.project.w + v.city.project.h) * 0.55, 0.1); });
    await page.waitForTimeout(600);
    // mid-history replay at a watchable speed
    await page.evaluate(() => { const v = window.__view; v.setMode('replay'); v.seek(v.tl.t0 + (v.tl.liveEdge - v.tl.t0) * 0.62); v.speed = 300; v.play(true); });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${out}/replay-${w}.png` });
    const fpsR = [];
    for (let i = 0; i < 5; i++) fpsR.push(await page.evaluate(async () => { await new Promise(r => setTimeout(r, 500)); return Math.round(window.__view.stage.fps); }));
    console.log(`replay fps median ${median(fpsR)} (${fpsR.join(',')})`, JSON.stringify(await page.evaluate(() => ({ drones: window.__view.actors.drones.size, t: new Date(window.__view.t).toISOString() }))));
    if (fullReplay) {
      const t0 = Date.now();
      await page.evaluate(() => { const v = window.__view; v.setMode('replay'); v.seek(v.tl.t0); v.speed = 7200; v.play(true); window.__minFps = 999; window.__fpsLog = []; setInterval(() => { const f = v.stage.fps; window.__fpsLog.push(f); }, 1000); });
      let shot = 0;
      while (true) {
        await page.waitForTimeout(5000);
        const st = await page.evaluate(() => ({ mode: window.__view.mode, t: window.__view.t, cur: window.__view.cursor, n: window.__view.data.events.ts.length }));
        if (shot++ % 6 === 2) await page.screenshot({ path: `${out}/full-replay-${shot}.png` });
        if (st.mode === 'live' || Date.now() - t0 > 600e3) { console.log(`full replay: reached ${st.mode} after ${((Date.now() - t0) / 1000).toFixed(0)}s, events ${st.cur}/${st.n}`); break; }
      }
      const log = await page.evaluate(() => window.__fpsLog);
      console.log(`full replay fps: median ${Math.round(median(log))}, p10 ${Math.round([...log].sort((a, b) => a - b)[Math.floor(log.length * 0.1)])}, min ${Math.round(Math.min(...log))}`);
    }
  }
  await page.close();
}
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no console errors');
