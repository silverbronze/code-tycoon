import { api, type SetupAudit, type AuditItem, type ProtectStatus } from './api';
import { h, put, ago, bytes } from './util';

// The Setup panel on the overview: what of the AI setup (settings, MCP servers,
// memory, skills, secrets) and the projects would be lost if this disk died.
// The audit takes ~30 s server-side, so it is polled until it lands.
// Snapshots are made from a terminal: they need the vault passphrase, which
// never goes over HTTP.
const LEVELS: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export class SetupAuditPanel {
  el = h('section', { class: 'sa' });
  private data: SetupAudit | null = null;
  private running = false;
  private error: string | null = null;
  private open = false;
  private timer = 0;

  private prot: ProtectStatus | null = null;
  private protErr = '';
  private folder = '';
  private ptimer = 0;

  constructor() { this.load(); this.loadProtect(); }

  private async loadProtect(p?: Promise<ProtectStatus>) {
    try { this.prot = await (p || api.protect()); this.protErr = ''; } catch (e) { this.protErr = (e as Error).message; }
    this.render();
    clearTimeout(this.ptimer);
    if (this.prot?.run.running || this.prot?.login?.state === 'waiting') this.ptimer = window.setTimeout(() => this.loadProtect(), 2000);
    else if (this.prot?.run.result && !this.running && this.data && this.data.at < Date.now() - 5000) this.load();
  }

  // Put the flagged projects in private repos: GitHub (signed in) or a folder of bare repos.
  private protectBox(d: SetupAudit) {
    const p = this.prot; if (!p) return null;
    const flagged = d.items.filter(i => i.kind === 'project' && (i.level === 'critical' || i.level === 'high') && /no remote|not in git|unpushed/.test(i.title));
    const kept = p.projects.length ? h('p', { class: 'sa-sub' }, `${p.projects.length} project${p.projects.length > 1 ? 's' : ''} protected and kept pushed: `,
      p.projects.map(x => x.name).join(', '), p.projects.some(x => x.checked) ? ` (checked ${ago(Math.max(...p.projects.map(x => x.checked || 0)))})` : '') : null;
    if (p.run.running || p.run.log.length) {
      return h('div', { class: 'sa-protect' }, h('b', {}, p.run.running ? 'Protecting…' : 'Protect finished'),
        h('pre', { class: 'sa-log' }, p.run.log.join('\n')), kept);
    }
    if (!flagged.length) return kept ? h('div', { class: 'sa-protect' }, kept) : null;
    const run = (to?: string) => this.loadProtect(api.runProtect({ to }));
    const gh = p.github;
    const login = p.login;
    return h('div', { class: 'sa-protect' },
      h('b', {}, `Protect ${flagged.length} of these with one click`),
      h('p', { class: 'sa-sub' }, 'New private repos for projects with no remote, a first commit (data, media and .env left out) for folders not in git, and hidden backup refs for unpushed work. Your branches are never pushed over. Code Tycoon keeps them pushed afterwards.'),
      p.ready?.ok ? h('div', { class: 'sa-acts' }, h('button', { class: 'chip go', onclick: () => run() }, `Protect now → ${p.ready.label}`)) :
        h('div', { class: 'sa-acts' },
          gh.login ? h('button', { class: 'chip go', onclick: () => run('github') }, `Protect to GitHub (${gh.login})`)
            : gh.canLogin ? h('button', { class: 'chip go', disabled: login?.state === 'waiting', onclick: () => this.loadProtect(api.githubLogin()) }, 'Sign in to GitHub') : null,
          h('input', { class: 'sa-input', 'aria-label': 'Backup folder', placeholder: 'or a folder for backups (NAS, USB disk)', value: this.folder, oninput: (e: Event) => { this.folder = (e.target as HTMLInputElement).value; } }),
          h('button', { class: 'chip', onclick: () => { if (this.folder.trim()) run(this.folder.trim()); } }, 'Protect to folder')),
      login?.state === 'waiting' ? h('p', { class: 'sa-code' }, 'Open ', h('a', { href: login.url, target: '_blank', rel: 'noopener' }, login.url), ' and enter ', h('code', {}, login.code)) : null,
      login?.state === 'failed' ? h('p', { class: 'sa-err' }, login.error) : null,
      !gh.login && !gh.canLogin && !p.ready?.ok ? h('p', { class: 'sa-sub' }, 'For GitHub, start Code Tycoon with ', h('code', {}, 'CODETYCOON_GITHUB_TOKEN'), ' set to a token that may create repos.') : null,
      this.protErr ? h('p', { class: 'sa-err' }, this.protErr) : null,
      kept);
  }

  private async load(rerun = false) {
    try {
      const r = rerun ? await api.rerunSetupAudit() : await api.setupAudit();
      this.data = r.result; this.running = r.running; this.error = r.error;
    } catch (e) { this.error = (e as Error).message; this.running = false; }
    this.render();
    clearTimeout(this.timer);
    if (this.running) this.timer = window.setTimeout(() => this.load(), 3000);
  }

  private render() {
    const d = this.data;
    this.el.replaceChildren();
    put(this.el,
      h('div', { class: 'ov-h2row' },
        h('h2', { class: 'ov-h' }, 'Setup backup'),
        h('button', { class: 'chip mini', disabled: this.running, onclick: () => { this.running = true; this.render(); this.load(true); } },
          this.running ? 'Checking… (about 30 s)' : 'Check again')),
      this.error ? h('p', { class: 'sa-err' }, 'The audit failed: ', this.error) : null,
      !d ? h('p', { class: 'sa-sub' }, this.running ? 'Looking through your Claude Code and Codex setup and every project folder…' : '') : this.body(d));
  }

  private body(d: SetupAudit) {
    const urgent = d.items.filter(i => i.level === 'critical' || i.level === 'high');
    const rest = d.items.filter(i => !urgent.includes(i));
    const counts = (['critical', 'high', 'medium'] as const).filter(k => d.counts[k]).map(k => `${d.counts[k]} ${k}`);
    return h('div', { class: 'sa-box' },
      h('div', { class: 'sa-head' },
        h('div', {},
          h('b', {}, urgent.length ? 'If this disk died today, you would lose:' : 'Nothing urgent would be lost.'),
          h('p', { class: 'sa-sub' },
            `${d.setup.files} setup files (${bytes(d.setup.bytes)}), ${d.setup.secrets.values} secrets in config, ${d.projects.length} projects. `,
            d.last ? `Last snapshot ${ago(d.last.at)} to ${d.last.target}.` : 'No snapshot yet.',
            ` Checked ${ago(d.at)}.`)),
        counts.length ? h('div', { class: 'sa-counts' }, counts.join(' · ')) : null),
      h('div', { class: 'sa-list' }, ...urgent.map(i => this.row(i))),
      this.protectBox(d),
      rest.length ? h('button', { class: 'sa-more', onclick: () => { this.open = !this.open; this.render(); } },
        this.open ? 'Show less' : `${rest.length} more (uncommitted work, ignored data, what restore needs)`) : null,
      this.open ? h('div', { class: 'sa-list' }, ...rest.map(i => this.row(i))) : null,
      h('p', { class: 'sa-cmd' }, 'Save settings, MCP servers, memory, skills and an encrypted vault of your secrets from a terminal: ',
        h('code', {}, 'npx code-tycoon snapshot <folder or private git url>'), ' · rebuild it on another machine: ',
        h('code', {}, 'npx code-tycoon restore <same>')));
  }

  private row(i: AuditItem) {
    return h('div', { class: 'sa-row ' + i.level },
      h('span', { class: 'sa-lvl' }, LEVELS[i.level]),
      h('div', { class: 'sa-main' },
        h('div', { class: 'sa-title' }, i.title),
        i.detail ? h('div', { class: 'sa-detail' }, i.detail) : null),
      i.fix ? h('div', { class: 'sa-fix' }, ...fix(i.fix)) : h('div'));
  }

  dispose() { clearTimeout(this.timer); clearTimeout(this.ptimer); }
}

// `code` spans in a fix line
function fix(s: string) {
  return s.split(/(`[^`]+`)/).filter(Boolean).map(p => p.startsWith('`') ? h('code', {}, p.slice(1, -1)) : p);
}
