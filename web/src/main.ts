import './styles.css';
import './notify';
import { Overview } from './overview';
import { CityView } from './cityview';

const app = document.getElementById('app')!;
let view: { dispose(): void } | null = null;
let viewPid: string | null = null;

// #/p/<project>[/s/<session to follow>]
function route() {
  const m = /^#\/p\/([^/]+)(?:\/s\/(.+))?$/.exec(location.hash);
  const pid = m ? decodeURIComponent(m[1]) : null, sid = m?.[2] ? decodeURIComponent(m[2]) : null;
  if (pid && pid === viewPid && view instanceof CityView) { if (sid) view.focusWhenReady(sid); return; }
  view?.dispose();
  viewPid = pid;
  view = pid ? new CityView(app, pid, sid) : new Overview(app);
  (window as any).__view = view; // handy for debugging from the console
}
window.addEventListener('hashchange', route);
route();
