// Desktop notifications for alerts, from whichever view is open. Only while the
// tab is in the background: in front, the in-page toast is enough.
import { live, type Alert } from './api';

const KEY = 'vis.notify';
export const notify = {
  get supported() { return 'Notification' in window; },
  get on() { try { return localStorage.getItem(KEY) === '1' && Notification.permission === 'granted'; } catch { return false; } },
  async toggle() {
    if (!this.supported) return false;
    if (this.on) { try { localStorage.setItem(KEY, '0'); } catch {} return false; }
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    try { localStorage.setItem(KEY, p === 'granted' ? '1' : '0'); } catch {}
    return p === 'granted';
  },
};

const TITLE: Record<string, string> = { 'needs-you': 'A session needs you', collision: 'Two sessions edited the same file', overlap: 'Sessions working in the same area',
  loop: 'A session is going in circles', failing: 'Checks keep failing', cost: 'A task is costing far more than usual', 'red-stop': 'A session stopped with checks failing' };
const shown = new Map<number, Notification>();

live.on(m => {
  if (m.type === 'alert-resolved') { shown.get(m.id)?.close(); shown.delete(m.id); return; }
  if (m.type !== 'alert' || !notify.on) return;
  const a = m.alert as Alert;
  if (a.kind === 'overlap' || (document.visibilityState === 'visible' && document.hasFocus())) return;
  const n = new Notification(TITLE[a.kind] || 'Code Tycoon', { body: a.text, tag: 'vis-' + a.id, requireInteraction: a.kind === 'needs-you' });
  n.onclick = () => { window.focus(); location.hash = '#/p/' + encodeURIComponent(a.pid) + (a.sessions[0] ? '/s/' + encodeURIComponent(a.sessions[0]) : ''); n.close(); };
  shown.set(a.id, n);
});
