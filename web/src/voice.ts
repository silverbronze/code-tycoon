// Voice control on every page: press the mic (or Alt+V), speak in English, Russian or Hebrew,
// and stop talking. The server turns the recording into text (Deepgram) and the text into
// actions: task board changes it makes itself, page changes (open a project, switch the map,
// follow a session) it hands back to be done here.
import { h } from './util';
import './voice.css';

type Lang = 'auto' | 'en' | 'ru' | 'he';
type UiAction = { do: 'overview' } | { do: 'open' | 'follow'; pid: string; sid: string | null; layer: string | null } | { do: 'layer'; layer: string };
interface Reply { text: string; lang: string | null; say: string | null; ui: UiAction[]; did: { do: string; task: string; text?: string }[]; errors: string[]; error?: string }

const LANG_KEY = 'vz-voice-lang', SPEAK_KEY = 'vz-voice-speak';
const LANG_LABEL: Record<Lang, string> = { auto: 'Auto', en: 'EN', ru: 'RU', he: 'HE' };
const SPEECH: Record<string, string> = { en: 'en-US', ru: 'ru-RU', he: 'he-IL' };
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
const MIC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>';

// silence detection: stop after this long quiet once speech was heard, or if nothing is said at all
const QUIET_MS = 1500, NOTHING_MS = 7000, MAX_MS = 30e3;

export class Voice {
  el: HTMLElement;
  private btn: HTMLButtonElement;
  private lang: HTMLSelectElement;
  private panel: HTMLElement;
  private state: 'idle' | 'listening' | 'thinking' = 'idle';
  private rec: MediaRecorder | null = null;
  private stopAll: (() => void) | null = null;
  private hideTimer = 0;

  constructor(private view: () => any) {
    this.btn = h('button', { class: 'vc-btn', title: 'Speak a command (Alt+V)', 'aria-label': 'Voice command', onclick: () => this.toggle() });
    this.btn.innerHTML = MIC;
    this.lang = h('select', { class: 'vc-lang', title: 'The language you speak. Auto detects it.', onchange: () => lsSet(LANG_KEY, this.lang.value) },
      ...(Object.keys(LANG_LABEL) as Lang[]).map(l => h('option', { value: l }, LANG_LABEL[l])));
    this.lang.value = (lsGet(LANG_KEY) as Lang) || 'auto';
    this.panel = h('div', { class: 'vc-panel' });
    this.el = h('div', { class: 'vc' }, h('div', { class: 'vc-bar' }, this.lang, this.btn));
    // the replies live on <body>: docked in a header, they would sit under the map's own layers
    document.body.append(this.el, this.panel);
    // a page can offer a spot for the mic (the project header has one); else it floats bottom-right.
    // The project page builds its header after its data loads, so look again for a few seconds.
    const dock = () => {
      const slot = document.querySelector('.vc-slot');
      const want = slot || document.body;
      if (this.el.parentElement !== want) { want.appendChild(this.el); this.el.classList.toggle('docked', !!slot); }
    };
    setInterval(dock, 1000);
    window.addEventListener('hashchange', () => setTimeout(dock, 50));
    window.addEventListener('keydown', e => {
      // by physical key, so it works on Russian and Hebrew layouts too
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyV') { e.preventDefault(); this.toggle(); }
      else if (e.key === 'Escape' && this.state === 'listening') this.cancel();
    });
  }

  private toggle() {
    if (this.state === 'listening') this.rec?.stop();
    else if (this.state === 'idle') this.listen();
  }
  private cancel() { this.stopAll?.(); this.set('idle'); this.show([h('div', { class: 'vc-dim' }, 'Cancelled')], 1500); }

  private set(s: typeof this.state) {
    this.state = s;
    this.el.classList.toggle('listening', s === 'listening');
    this.el.classList.toggle('thinking', s === 'thinking');
    this.btn.title = s === 'listening' ? 'Stop and send (Alt+V)' : 'Speak a command (Alt+V)';
  }

  private show(children: (Node | null)[], ms = 0) {
    clearTimeout(this.hideTimer);
    this.panel.replaceChildren(...children.filter(Boolean) as Node[]);
    // under the mic when it is docked up top, above it when it floats at the bottom
    const r = this.el.getBoundingClientRect(), up = r.top > innerHeight / 2;
    Object.assign(this.panel.style, { right: `${Math.max(16, innerWidth - r.right)}px`,
      top: up ? '' : `${r.bottom + 12}px`, bottom: up ? `${innerHeight - r.top + 8}px` : '' });
    this.panel.classList.add('open');
    if (ms) this.hideTimer = window.setTimeout(() => this.panel.classList.remove('open'), ms);
  }

  private async listen() {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { this.show([h('div', { class: 'vc-err' }, 'No microphone: ' + (e as Error).message)], 6000); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    let cancelled = false;
    // level meter for silence detection and the ring on the button
    const ac = new AudioContext(), an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const t0 = performance.now();
    let spoke = false, lastLoud = t0, raf = 0;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0; for (const v of buf) s += v * v;
      const rms = Math.sqrt(s / buf.length), now = performance.now();
      this.el.style.setProperty('--lvl', String(Math.min(1, rms * 12)));
      if (rms > 0.02) { spoke = true; lastLoud = now; }
      if ((spoke && now - lastLoud > QUIET_MS) || (!spoke && now - t0 > NOTHING_MS) || now - t0 > MAX_MS) { if (rec.state === 'recording') rec.stop(); return; }
      raf = requestAnimationFrame(tick);
    };
    const release = () => { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); ac.close().catch(() => {}); this.el.style.removeProperty('--lvl'); };
    this.stopAll = () => { cancelled = true; if (rec.state === 'recording') rec.stop(); };
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      release(); this.rec = null; this.stopAll = null;
      if (cancelled) return;
      if (!spoke) { this.set('idle'); this.show([h('div', { class: 'vc-dim' }, 'Didn’t hear anything')], 2500); return; }
      this.send(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
    this.rec = rec;
    rec.start();
    tick();
    this.set('listening');
    this.show([h('div', { class: 'vc-dim' }, 'Listening… stop talking to send, Esc to cancel')]);
  }

  // the page the user is on, and the board defaults they picked on the overview
  private query() {
    const m = /^#\/p\/([^/]+)/.exec(location.hash);
    const v = this.view();
    // tasks start with the task form's defaults (all commands, start right away, no pauses) and its model
    const q = new URLSearchParams({ lang: this.lang.value, mode: 'full', auto: '1', pause: '0' });
    const model = lsGet('vz-board-model');
    if (model) q.set('model', model);
    if (m) { q.set('pid', decodeURIComponent(m[1])); if (typeof v?.layer === 'string') q.set('layer', v.layer); }
    return q;
  }

  private async send(blob: Blob) {
    this.set('thinking');
    this.show([h('div', { class: 'vc-dim' }, 'Thinking…')]);
    let r: Reply;
    try {
      const res = await fetch('/api/voice?' + this.query(), { method: 'POST', headers: { 'content-type': blob.type.split(';')[0] || 'audio/webm' }, body: blob });
      r = await res.json();
      if (!res.ok) throw new Error(r.error || 'failed');
    } catch (e) {
      this.set('idle');
      this.show([h('div', { class: 'vc-err' }, (e as Error).message)], 8000);
      return;
    }
    this.set('idle');
    for (const a of r.ui) this.doUi(a);
    const did = r.did.map(d => d.do === 'add' ? `Task added: ${d.text}` : null).filter(Boolean) as string[];
    this.show([
      r.text ? h('div', { class: 'vc-heard', dir: 'auto' }, '“' + r.text + '”') : null,
      r.say ? h('div', { class: 'vc-say', dir: 'auto' }, r.say) : null,
      ...did.map(t => h('div', { class: 'vc-did', dir: 'auto' }, t)),
      ...r.errors.map(e => h('div', { class: 'vc-err' }, e)),
      h('label', { class: 'vc-speak' }, h('input', { type: 'checkbox', checked: lsGet(SPEAK_KEY) === '1', onchange: (e: Event) => lsSet(SPEAK_KEY, (e.target as HTMLInputElement).checked ? '1' : '0') }), 'Read replies aloud'),
    ], 12000);
    if (r.say && lsGet(SPEAK_KEY) === '1') this.speak(r.say, r.lang);
  }

  private doUi(a: UiAction) {
    const v = this.view();
    if (a.do === 'overview') { location.hash = '#/'; return; }
    if (a.do === 'layer') { v?.setLayer?.(a.layer); return; }
    // the city view opens on the layer kept in localStorage
    if (a.layer) lsSet('vz-layer', a.layer);
    const here = location.hash.startsWith('#/p/' + encodeURIComponent(a.pid));
    if (here && a.layer) v?.setLayer?.(a.layer);
    location.hash = '#/p/' + encodeURIComponent(a.pid) + (a.do === 'follow' && a.sid ? '/s/' + encodeURIComponent(a.sid) : '');
  }

  // the browser's own voices; Windows often has no Russian or Hebrew one, then it stays quiet
  private speak(text: string, lang: string | null) {
    const want = SPEECH[lang || 'en'] || 'en-US';
    const voice = speechSynthesis.getVoices().find(x => x.lang.toLowerCase().startsWith(want.slice(0, 2)));
    if (!voice) return;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice; u.lang = voice.lang;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
}
