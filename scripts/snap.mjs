// quick look: node scripts/snap.mjs <out.png> <fraction 0..1> <speed> [viewSize]
import { chromium } from 'playwright';
const [out, frac = '0.3', speed = '7200', view] = process.argv.slice(2);
if (!process.env.PID) { console.error('Set PID to a tracked project id (its folder path, e.g. PID=c:/code/myapp).'); process.exit(1); }
const b = await chromium.launch({ channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:4400/#/p/' + encodeURIComponent(process.env.PID));
await p.waitForFunction(() => window.__view?.world, null, { timeout: 60000 });
await p.waitForTimeout(2500);
await p.evaluate(([f, s, vs]) => { const v = window.__view; if (vs) { v.stage.viewSize = +vs; v.stage.updateCamera(); } if (+f < 1) { v.setMode('replay'); v.seek(v.tl.t0 + (v.tl.liveEdge - v.tl.t0) * +f); v.speed = +s; v.play(true); } }, [frac, speed, view]);
await p.waitForTimeout(4500);
await p.screenshot({ path: out });
await b.close();
