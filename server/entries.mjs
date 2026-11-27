// Entry points: where a person, a program or the clock comes into the code. Pages
// someone opens, HTTP routes, CLI commands, hooks and webhooks, schedules. The
// schematic draws them as a band above the code, each tied down to the module that
// declares it. Read from the files with plain patterns, like traits.mjs; per-file
// results are cached by size.
import fs from 'node:fs';
import path from 'node:path';
import { endpoints, fileRoute } from './traits.mjs';

export const ENTRY_KINDS = ['page', 'http', 'cli', 'hook', 'schedule'];

const READ = new Set(['code', 'config', 'markup']);
const all = (re, txt, g = 1) => { const out = []; for (const m of txt.matchAll(re)) if (m[g]) out.push(m[g]); return out; };

// A hand-rolled router: `parts[1] === 'projects'` under `parts[0] === 'api'`, or
// `pathname === '/hook'`. Walks the file in order and keeps the last literal seen
// at each depth, so nested checks read as one path; gaps become `*`.
function segRoutes(txt) {
  const out = [];
  for (const m of txt.matchAll(/\b(?:pathname|url\.path|req\.url)\s*===\s*['"](\/[^'"]*)['"]/g)) out.push(methodAt(txt, m.index) + ' ' + m[1]);
  const seg = [];
  for (const line of txt.split('\n')) {
    const hits = [...line.matchAll(/\b(?:parts|segs|segments|pathParts)\[(\d)\]\s*===\s*['"]([\w.-]+)['"]/g)];
    if (!hits.length) continue;
    let deep = -1;
    for (const h of hits) { const k = +h[1]; seg[k] = h[2]; deep = Math.max(deep, k); }
    seg.length = deep + 1;
    if (deep < 1) continue; // `parts[0] === 'api'` alone is a prefix, not a route
    const p = '/' + Array.from({ length: deep + 1 }, (_, k) => seg[k] ?? '*').join('/');
    const mm = /\bmethod\s*===\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/.exec(line);
    out.push((mm ? mm[1] : 'ANY') + ' ' + p);
  }
  return out;
}
function methodAt(txt, i) {
  const line = txt.slice(txt.lastIndexOf('\n', i) + 1, txt.indexOf('\n', i) < 0 ? undefined : txt.indexOf('\n', i));
  return /\bmethod\s*===\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/.exec(line)?.[1] || 'ANY';
}

const BROWSER = /\b(document|window)\.|from\s+['"](react|vue|svelte|three)['"]/;
const CRON = /['"`]((?:\*|\d+|\*\/\d+)(?:[ \t]+(?:\*|[\d,*/-]+)){4})['"`]/g;

// per-file entries: { http: [...], page: [...], cli: [...], hook: [...], schedule: [...] }
const cache = new Map();
function scanFile(root, f) {
  const ck = root + '|' + f.p + '|' + f.size;
  const hit = cache.get(ck);
  if (hit) return hit;
  const e = {};
  const put = (k, list) => { if (list.length) e[k] = [...new Set([...(e[k] || []), ...list])]; };
  const p = f.p;
  // pages: file-based routes and HTML documents
  if (/(^|\/)page\.(t|j)sx?$/.test(p) || /(^|\/)pages\/(?!api\/|_).*\.(t|j)sx?$/.test(p)) { const r = fileRoute(p); if (r) put('page', [r]); }
  if (/\.html?$/.test(p) && !/(^|\/)(dist|build|out|coverage|public\/vendor)\//.test(p)) put('page', [p.split('/').pop()]);
  let txt = '';
  if (READ.has(f.kind) && f.size <= 300 * 1024 && !/\.(min\.js|map|lock)$|package-lock\.json$/.test(p)) {
    // comment lines say what code does, they don't do it
    try { txt = fs.readFileSync(path.join(root, p), 'utf8').replace(/^\s*(\/\/|#(?!!)|\*).*$/gm, ''); } catch {}
  }
  if (txt) {
    if (f.kind === 'code' || f.kind === 'markup') {
      // HTTP routes: framework calls, file-based handlers, hand-rolled routers
      let http = endpoints(txt, p);
      if (/createServer\(|\.listen\(|\(BaseHTTPRequestHandler\)|http\.server/.test(txt) && !BROWSER.test(txt)) {
        http = http.concat(segRoutes(txt));
        if (!http.length) http.push('HTTP server');
      }
      if (/\burls\.py$/.test(p)) http = http.concat(all(/\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]/g, txt).map(r => 'ANY /' + r));
      if (/new\s+WebSocketServer|WebSocket\.Server|socket\.io|@app\.websocket|\.ws\(\s*['"]/.test(txt)) http.push('WebSocket');
      // a route whose path says hook goes to hooks
      put('hook', http.filter(r => /hook/i.test(r)));
      put('http', http.filter(r => !/hook/i.test(r)));
      // SPA routes
      const spa = all(/<Route\b[^>]*\bpath=["'{`]+([^"'}`]+)/g, txt);
      if (/react-router|vue-router|@angular\/router|svelte-routing/.test(txt)) spa.push(...all(/\bpath:\s*['"`]([^'"`]*)['"`]/g, txt).map(r => r || '/'));
      if (/location\.hash|hashchange/.test(txt)) spa.push(...all(/['"`/^]#\\?\/([\w-]+)/g, txt).map(r => '#/' + r));
      put('page', spa);
      // CLI commands
      const cli = [];
      if (/process\.argv|sys\.argv|argparse|commander|yargs|click\.|typer|clap::|flag\.Parse|os\.Args/.test(txt)) {
        cli.push(...all(/\b(?:cmd|command|sub|subcommand|action|verb)\s*===?\s*['"]([\w:-]+)['"]/g, txt));
        cli.push(...all(/\.command\(\s*['"]([\w:-]+)/g, txt), ...all(/add_parser\(\s*['"]([\w:-]+)/g, txt), ...all(/@\w+\.command\(\s*(?:name\s*=\s*)?['"]([\w:-]+)/g, txt));
      }
      if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(txt) && !cli.length) cli.push(p.split('/').pop());
      if (/^#!.*\b(node|python3?|bash|sh|deno|bun)\b/.test(txt) && !cli.length) cli.push(p.split('/').pop());
      put('cli', cli.filter(c => !/^(string|number|object|function|undefined|boolean|symbol|bigint)$/.test(c))); // typeof x === 'string'
      // hooks and webhooks named in code
      put('hook', all(/\b(?:hook_event_name|event)\s*===?\s*['"]((?:Pre|Post)ToolUse|UserPromptSubmit|SessionStart|SessionEnd|Stop|SubagentStop|Notification|PreCompact)['"]/g, txt));
      // schedules: cron expressions and long-running timers outside the browser
      const sch = all(CRON, txt).filter(c => !/^\d+( \d+){4}$/.test(c)); // five plain numbers are rarely a schedule
      sch.push(...all(/@Cron\(\s*['"]([^'"]+)/g, txt), ...all(/schedule\.every\(([^)]*)\)/g, txt).map(x => 'every ' + (x || '1')));
      if (!BROWSER.test(txt)) for (const m of txt.matchAll(/setInterval\(\s*(?:\(\)\s*=>\s*)?([\w.]+)?[^;]*?,\s*([\d_.e]+(?:\s*\*\s*[\d_.e]+)*)\s*\)/g)) {
        let ms; try { ms = Function('return (' + m[2].replace(/_/g, '') + ')')(); } catch { continue; }
        if (ms >= 60e3) sch.push(`${m[1] && !/^(async|import|function|this|await)$/.test(m[1]) ? m[1] + ' ' : ''}every ${ms >= 3600e3 ? +(ms / 3600e3).toFixed(1) + ' h' : Math.round(ms / 60e3) + ' min'}`);
      }
      put('schedule', sch);
    } else if (f.kind === 'config') {
      if (/(^|\/)\.github\/workflows\//.test(p)) put('schedule', all(/-\s*cron:\s*['"]([^'"]+)/g, txt).map(c => `${p.split('/').pop()} ${c}`));
      if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(p)) { try { put('hook', Object.keys(JSON.parse(txt).hooks || {})); } catch {} }
      if (/(^|\/)crontab$/.test(p)) put('schedule', all(/^([^#\s][^\n]*)$/gm, txt).map(l => l.slice(0, 60)));
    }
  }
  if (cache.size > 60000) cache.clear();
  cache.set(ck, e);
  return e;
}

// Bin targets from package.json files: { target file path: bin name }.
function bins(root, inv) {
  const out = new Map();
  for (const f of inv) {
    if (!/(^|\/)package\.json$/.test(f.p)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(root, f.p), 'utf8')); } catch { continue; }
    const dir = f.p.includes('/') ? f.p.slice(0, f.p.lastIndexOf('/') + 1) : '';
    const b = typeof j.bin === 'string' ? { [j.name?.split('/').pop() || 'cli']: j.bin } : j.bin || {};
    for (const [name, t] of Object.entries(b)) out.set(path.posix.normalize(dir + String(t).replace(/^\.\//, '')).toLowerCase(), name);
  }
  return out;
}

const MAX_ITEMS = 40;
// Entries of the project, one per kind and module: [{ kind, m, n, items, files }].
// `modOf(p)` gives the module index of a file, or undefined.
export function entriesOf(root, inv, modOf) {
  const bin = bins(root, inv);
  const by = new Map();
  for (const f of inv) {
    const m = modOf(f.p);
    if (m == null) continue;
    const e = scanFile(root, f);
    const name = bin.get(f.p.toLowerCase());
    if (name) e.cli = [...new Set([name, ...(e.cli || []).map(c => c === f.p.split('/').pop() ? name : name + ' ' + c)])];
    for (const kind of ENTRY_KINDS) {
      const list = e[kind];
      if (!list?.length) continue;
      const k = kind + '|' + m;
      let x = by.get(k);
      if (!x) by.set(k, x = { kind, m, items: new Set(), files: [] });
      for (const t of list) x.items.add(t);
      x.files.push(f.p);
    }
  }
  return [...by.values()].map(x => {
    const items = [...x.items];
    // a CLI's bare name only counts when it has no commands listed
    const cmds = x.kind === 'cli' ? items.filter(t => t.includes(' ')) : items;
    const list = cmds.length ? cmds : items;
    return { kind: x.kind, m: x.m, n: list.length, items: list.slice(0, MAX_ITEMS), files: x.files.slice(0, 8) };
  }).sort((a, b) => ENTRY_KINDS.indexOf(a.kind) - ENTRY_KINDS.indexOf(b.kind) || b.n - a.n);
}
