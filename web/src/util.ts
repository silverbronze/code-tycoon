type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c: Child) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

// A click is a press and a release on the same element. Panels that rebuild their DOM on a
// timer or a live message replaced the button between the two, and the browser dropped the
// click (the "have to click twice" bug). heldBy(root, redo) returns true while a press that
// started inside root is still down, and runs redo once after the release (the click has
// fired by then), so a render just returns when it is held.
// A press is held for 2 s at most: a native <select> list can swallow the release.
let pressed: Element | null = null, pressedAt = 0, giveUp = 0;
const held = new Map<Element, () => void>();
addEventListener('pointerdown', e => { pressed = e.target as Element; pressedAt = Date.now(); }, true);
const release = () => {
  pressed = null; clearTimeout(giveUp);
  if (!held.size) return;
  const fns = [...held.values()]; held.clear();
  setTimeout(() => fns.forEach(f => f()), 0); // after the click event of this release
};
addEventListener('pointerup', release, true);
addEventListener('pointercancel', release, true);
addEventListener('blur', release);
export function heldBy(root: Element, redo: () => void) {
  if (!pressed || !root.contains(pressed)) return false;
  const left = 2000 - (Date.now() - pressedAt);
  if (left <= 0) return false;
  if (!held.size) giveUp = window.setTimeout(release, left);
  held.set(root, redo);
  return true;
}

// A textarea that grows with its text up to its CSS max-height, then scrolls.
// Returns a fit() to call after setting .value from code.
export function autoGrow(ta: HTMLTextAreaElement) {
  const fit = () => {
    if (!ta.isConnected) return;
    const cs = getComputedStyle(ta);
    const max = parseFloat(cs.maxHeight) || Infinity;
    const edge = cs.boxSizing === 'border-box' ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : -(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
    ta.style.height = 'auto';
    const want = ta.scrollHeight + edge;
    ta.style.height = Math.min(want, max) + 'px';
    ta.style.overflowY = want > max ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('focus', fit);
  requestAnimationFrame(fit);
  return fit;
}

// append children, skipping null/false (native append rejects them)
export function put(el: Element, ...children: Child[]) {
  const add = (c: Child) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); };
  children.forEach(add);
  return el;
}

export function ago(ts: number | null, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
export function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
}
export function clock(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function shortTime(ts: number) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export function bytes(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
export function tail(p: string, n = 2) { return p.split('/').slice(-n).join('/'); }
export function money(n: number) { return n >= 100 ? '$' + Math.round(n) : n >= 1 ? '$' + n.toFixed(2) : n > 0 ? '$' + n.toFixed(3) : '$0'; }
