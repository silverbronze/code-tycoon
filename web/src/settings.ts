// Settings: one dialog for the account, the switches and this browser's preferences,
// opened from the gear on the overview and in the project header (and with the "," key).
// It lives on <body>, so it sits above the map and its layers on every page.
import { api, type Setup } from './api';
import { h, put } from './util';
import { notify } from './notify';
import { AccountChip } from './account';
import './settings.css';

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };

// the voice keys are read by voice.ts; it listens for SETTINGS_EVENT to pick up a change made here
export const VOICE_LANG_KEY = 'vz-voice-lang', VOICE_SPEAK_KEY = 'vz-voice-speak';
export const SETTINGS_EVENT = 'vz-settings';
const LANGS: [string, string][] = [['auto', 'Auto (English if unsure)'], ['en', 'English'], ['ru', 'Russian'], ['he', 'Hebrew']];

// what this browser keeps per project (dragged places, moved domain-map labels)
const ARRANGED = /^vz-(layout|dmlabels):/;

const GEAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

const KEYS: [string, string][] = [['Alt+V', 'Speak a command'], [',', 'Open settings'], ['M', 'Choose map layer (project page)'], ['Space', 'Play / pause a replay'], ['Esc', 'Close, clear selection']];

class SettingsDialog {
  private back: HTMLElement | null = null;
  private body = h('div', { class: 'st-body' });
  private account: AccountChip | null = null;
  private setup: Setup | null = null;
  private busy = false;
  private error = '';
  private version: { sha: string | null; started: number } | null = null;
  private confirmForget = false;
  private note = '';
  private lastFocus: Element | null = null;
  onSetupChange: ((s: Setup) => void)[] = [];

  constructor() {
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.back) { e.stopPropagation(); this.close(); return; }
      const t = e.target as HTMLElement;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === ',' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); this.open(); }
    }, true);
  }

  get isOpen() { return !!this.back; }

  open() {
    if (this.back) return;
    this.lastFocus = document.activeElement;
    // the account chip polls the server; made on first open, kept afterwards so its state stays warm
    this.account ??= new AccountChip();
    this.confirmForget = false; this.note = ''; this.error = '';
    const closeBtn = h('button', { class: 'chip icon', 'aria-label': 'Close settings', onclick: () => this.close() }, '×');
    const box = h('div', { class: 'st-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'st-title' },
      h('div', { class: 'st-head' }, h('h2', { id: 'st-title' }, 'Settings'), closeBtn),
      this.body);
    this.back = h('div', { class: 'st-back', onmousedown: (e: MouseEvent) => { if (e.target === this.back) this.close(); } }, box);
    document.body.appendChild(this.back);
    this.render();
    closeBtn.focus();
    api.setup().then(s => { this.setup = s; this.render(); }).catch(() => {});
    fetch('/api/version').then(r => r.json()).then(v => { this.version = v; this.render(); }).catch(() => {});
  }

  close() {
    this.back?.remove(); this.back = null;
    (this.lastFocus as HTMLElement | null)?.focus?.();
  }

  private async changeSetup(change: Partial<Record<'hooks' | 'autostart', boolean>>) {
    this.busy = true; this.error = ''; this.render();
    try { this.setup = await api.setSetup(change); this.onSetupChange.forEach(f => f(this.setup!)); } catch (e) { this.error = (e as Error).message; }
    this.busy = false; this.render();
  }

  private row(label: string, help: string, control: Node | null) {
    return h('div', { class: 'st-row' }, h('div', { class: 'st-l' }, h('b', {}, label), h('span', {}, help)), control ? h('div', { class: 'st-c' }, control) : null);
  }

  private section(title: string, ...rows: (Node | null)[]) {
    return h('section', { class: 'st-sec' }, h('h3', {}, title), ...rows);
  }

  private render() {
    if (!this.back) return;
    const s = this.setup;
    const voiceLang = h('select', { class: 'bd-sel', 'aria-label': 'Voice language',
      onchange: (e: Event) => { lsSet(VOICE_LANG_KEY, (e.target as HTMLSelectElement).value); window.dispatchEvent(new Event(SETTINGS_EVENT)); } },
      ...LANGS.map(([v, l]) => h('option', { value: v }, l)));
    voiceLang.value = lsGet(VOICE_LANG_KEY) || 'auto';
    const speak = lsGet(VOICE_SPEAK_KEY) === '1';
    const arranged = (() => { try { return Object.keys(localStorage).filter(k => ARRANGED.test(k)).length; } catch { return 0; } })();
    const v = this.version;

    this.body.replaceChildren();
    put(this.body,
      this.section('Account',
        h('p', { class: 'st-help' }, 'Sign in to open this PC’s Code Tycoon from anywhere. You stay signed in until you sign out here.'),
        this.account!.el),

      this.section('Claude Code',
        this.row('Live updates', 'Claude Code tells Code Tycoon about every step the moment it happens (a hook in ~/.claude/settings.json; a backup is kept). Off, sessions show up a few seconds late from their transcripts.',
          s ? switchEl(s.hooks, 'Live updates', () => this.changeSetup({ hooks: !s.hooks }), this.busy) : h('span', { class: 'st-dim' }, '…')),
        this.row('Start at login', 'Start Code Tycoon hidden when you log in, so this page is always there at http://127.0.0.1:4400.',
          !s ? h('span', { class: 'st-dim' }, '…') : s.autostart == null ? h('span', { class: 'st-dim' }, 'Not available on this system')
            : switchEl(s.autostart, 'Start at login', () => this.changeSetup({ autostart: !s.autostart }), this.busy)),
        this.error ? h('p', { class: 'st-err' }, 'Could not change it: ', this.error) : null),

      this.section('Notifications',
        this.row('Desktop alerts', notify.supported
          ? 'A desktop notification when a session needs you or two sessions edit one file, while this tab is in the background. Kept per browser.'
          : 'This browser can’t show desktop notifications.',
          notify.supported ? switchEl(notify.on, 'Desktop alerts', async () => { await notify.toggle(); this.render(); }) : null)),

      this.section('Voice',
        this.row('Language you speak', 'Speech is recognised in this language. Auto falls back to English.', voiceLang),
        this.row('Read replies aloud', 'Speak the answer to a voice command, not just show it.',
          switchEl(speak, 'Read replies aloud', () => { lsSet(VOICE_SPEAK_KEY, speak ? '0' : '1'); window.dispatchEvent(new Event(SETTINGS_EVENT)); this.render(); }))),

      this.section('This browser',
        this.row('Arranged places', arranged
          ? `Places you dragged on the map and labels you moved, in ${arranged} ${arranged === 1 ? 'project view' : 'project views'}. Forgetting puts them back where Code Tycoon lays them out.`
          : 'Places you drag on the map and labels you move are kept here, per project.',
          !arranged ? null : this.confirmForget
            ? h('span', { class: 'st-pair' },
              h('button', { class: 'chip', onclick: () => this.forgetArranged() }, 'Forget them'),
              h('button', { class: 'chip', onclick: () => { this.confirmForget = false; this.render(); } }, 'Cancel'))
            : h('button', { class: 'chip', onclick: () => { this.confirmForget = true; this.render(); } }, 'Reset…')),
        this.row('Setup reminder', 'The “Finish setting up” box on the overview, if you put it off with “Not now”.',
          lsGet('vz-setup-later') === '1'
            ? h('button', { class: 'chip', onclick: () => { try { localStorage.removeItem('vz-setup-later'); } catch {} this.note = 'The setup box shows again on the overview while something is still off.'; this.render(); } }, 'Show again')
            : h('span', { class: 'st-dim' }, 'Shown')),
        this.note ? h('p', { class: 'st-help' }, this.note) : null),

      this.section('Keyboard',
        h('dl', { class: 'st-keys' }, ...KEYS.flatMap(([k, what]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, what)]))),

      this.section('About',
        h('p', { class: 'st-help' },
          'Code Tycoon', v?.sha ? [' · ', h('code', {}, v.sha.slice(0, 7))] : null,
          v?.started ? [' · running since ', new Date(v.started).toLocaleString()] : null),
        h('p', { class: 'st-help' }, 'Data: ', h('code', {}, '~/.codetycoon'), '. Other settings are environment variables (', h('code', {}, 'CODETYCOON_*'), '), read at start.')));
  }

  private forgetArranged() {
    try { for (const k of Object.keys(localStorage)) if (ARRANGED.test(k)) localStorage.removeItem(k); } catch {}
    this.confirmForget = false;
    this.note = 'Forgotten. Open or reload a project to see its default layout.';
    this.render();
  }
}

function switchEl(on: boolean, label: string, onclick: () => void, busy = false) {
  return h('button', { class: 'ov-switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), 'aria-label': label, disabled: busy, onclick }, h('i', {}), on ? 'On' : 'Off');
}

export const settings = new SettingsDialog();

// the gear that opens it; `withLabel` for the overview, icon-only in the project header
export function settingsButton(withLabel = false) {
  const b = h('button', { class: 'chip' + (withLabel ? ' st-open' : ' icon'), title: 'Settings (,)', 'aria-label': 'Settings', onclick: () => settings.open() });
  b.innerHTML = GEAR;
  if (withLabel) b.append('Settings');
  return b;
}
