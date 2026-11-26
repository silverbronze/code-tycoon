type Child = Node | string | number | null | undefined | false | Child[];

// The listeners h() added to each element ("onclick,oninput,"), for morph() below.
const ON = new WeakMap<Element, string>();

// morph(el, ...children): put() for panels that redraw on a timer or a live message. Instead of
// replacing everything, it keeps each old element that is unchanged (same HTML, same listeners),
// so hover, focus, an open <select>, typed text and scroll positions survive the refresh.
// Changed elements are swapped whole, never edited in place, because their listeners close over
// the elements built with them (a Send button reads its own answer box). The rule that keeps
// this safe:
// - an element with `data-key` is one self-contained item (a card, a row, a task): its
//   listeners refer only to itself and its own children. Items are matched by key and kept
//   when unchanged, even when their neighbours change.
// - an unkeyed container with no listeners of its own, same tag and attributes, is patched
//   inside (a grid of keyed cards).
// - when anything at one level changes, every unkeyed sibling that has listeners outside a
//   keyed item is rebuilt too, since one of them may refer to the part that changed.
export function morph(el: Element, ...children: Child[]) {
  const fresh: Node[] = [];
  const add = (c: Child) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else fresh.push(c instanceof Node ? c : document.createTextNode(String(c))); };
  children.forEach(add);
  patch(el, fresh);
  return el;
}
const keyOf = (n: Node) => n instanceof Element ? n.getAttribute('data-key') : null;
function sig(n: Node) {
  if (!(n instanceof Element)) return n.nodeType + ':' + n.nodeValue;
  let s = n.outerHTML;
  const walk = (e: Element) => { const o = ON.get(e); if (o) s += '|' + o; for (const c of e.children) walk(c); };
  walk(n);
  return s;
}
// listeners not enclosed in a keyed item (an item's own listeners count as enclosed)
function loose(n: Node): boolean {
  if (!(n instanceof Element)) return false;
  const walk = (e: Element): boolean => { if (e !== n && e.hasAttribute('data-key')) return false; if (ON.has(e)) return true; for (const c of e.children) if (walk(c)) return true; return false; };
  return n.hasAttribute('data-key') ? false : walk(n);
}
function plain(o: Element, n: Element) {
  if (o.tagName !== n.tagName || ON.has(o) || ON.has(n) || o.attributes.length !== n.attributes.length) return false;
  for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) return false;
  return true;
}
function patch(el: Element, fresh: Node[]) {
  const old = [...el.childNodes];
  const byKey = new Map<string, Node>();
  for (const o of old) { const k = keyOf(o); if (k != null && !byKey.has(k)) byKey.set(k, o); }
  type Step = { n: Node; o?: Node; how: 'keep' | 'patch' | 'new' };
  let changed = old.length !== fresh.length;
  const steps: Step[] = fresh.map((n, i) => {
    const k = keyOf(n);
    let o: Node | undefined;
    if (k != null) { o = byKey.get(k); byKey.delete(k); }
    else if (old[i] && keyOf(old[i]) == null) o = old[i];
    if (o === n) return { n, o, how: 'keep' };
    if (!o || n.isConnected) { changed = true; return { n, how: 'new' }; }
    if (sig(o) === sig(n)) { if (o !== old[i]) changed = true; return { n, o, how: 'keep' }; }
    changed = true;
    if (k == null && o instanceof Element && n instanceof Element && plain(o, n)) return { n, o, how: 'patch' };
    return { n, how: 'new' };
  });
  if (changed) for (const s of steps) if (s.o && s.o !== s.n && keyOf(s.n) == null && loose(s.o)) { s.how = 'new'; s.o = undefined; }
  const next = steps.map(s => {
    if (s.how === 'patch') patch(s.o as Element, [...s.n.childNodes]);
    return s.how === 'new' ? s.n : s.o!;
  });
  next.forEach((n, i) => { if (el.childNodes[i] !== n) el.insertBefore(n, el.childNodes[i] ?? null); });
  while (el.childNodes.length > next.length) el.lastChild!.remove();
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') { el.addEventListener(k.slice(2).toLowerCase(), v); ON.set(el, (ON.get(el) || '') + k + ','); }
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
