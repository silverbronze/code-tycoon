// Runs every adapter over this machine and the project pass over every known
// project. Reads only; nothing leaves the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { norm } from '../paths.mjs';
import { globRe, lstat, treeSize } from './util.mjs';
import { COMMON_RULES, COPIED, MAX_COPY } from './adapters/common.mjs';
import { scanProjects } from './projects.mjs';
import claude from './adapters/claude.mjs';
import codex from './adapters/codex.mjs';
import system from './adapters/system.mjs';
import codetycoon from './adapters/codetycoon.mjs';

export const ADAPTERS = [claude, codex, codetycoon, system];

export function machine() {
  return { home: os.homedir(), platform: process.platform, vars: process.env, user: os.userInfo().username };
}

const compile = rules => rules.map(([pattern, cls, opts = {}]) => ({
  dir: pattern.endsWith('/'), re: globRe(pattern.replace(/\/$/, '')), cls, opts,
}));

// Walk one tool folder. A folder rule gives the whole folder one class; copied
// classes are walked file by file, the rest are summed and not opened.
function walkDir(tool, dir, rules, out) {
  const all = [...compile(COMMON_RULES), ...compile(rules)];
  const visit = (rel, fallback, fallbackOpts) => {
    let ents;
    try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(dir, r);
      if (e.isDirectory()) {
        // a git checkout inside a tool folder (an MCP server, a skill pack) is cloned back, not copied
        const remote = fallback !== 'secret' && repoRemote(abs);
        if (remote) { out.push({ tool, cls: 'repo', abs, rel: r, tree: true, remote, ...treeSize(abs, 50000) }); continue; }
        const rule = all.find(x => x.dir && x.re.test(r));
        if (!rule) { visit(r, fallback, fallbackOpts); continue; }
        if (COPIED.has(rule.cls) || rule.cls === 'secret') { visit(r, rule.cls, rule.opts); continue; }
        const except = rule.opts.except || {};
        const t = sizeExcept(abs, Object.keys(except));
        out.push({ tool, cls: rule.cls, abs, rel: r, tree: true, size: t.size, files: t.files, note: rule.opts.note });
        for (const [child, cls] of Object.entries(except)) {
          if (fs.existsSync(path.join(abs, child))) visitAs(r + '/' + child, cls, { ...rule.opts, except: undefined });
        }
        continue;
      }
      if (!e.isFile()) continue;
      const st = lstat(abs); if (!st) continue;
      const rule = all.find(x => !x.dir && x.re.test(r));
      let cls = rule ? rule.cls : fallback;
      const opts = rule ? rule.opts : fallbackOpts || {};
      if (COPIED.has(cls) && st.size > MAX_COPY) cls = 'history';
      out.push({ tool, cls, abs, rel: r, size: st.size, mtime: st.mtimeMs, note: opts.note, opts });
    }
  };
  const visitAs = (rel, cls, opts) => visit(rel, cls, opts);
  visit('', 'other', {});
}

function repoRemote(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg) || /\[remote "[^"]+"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    return m ? m[1] : null;
  } catch { return null; }
}

function sizeExcept(dir, skip) {
  let size = 0, files = 0;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { size, files }; }
  for (const e of ents) {
    if (skip.includes(e.name) || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const t = treeSize(p); size += t.size; files += t.files; }
    else if (e.isFile()) { files++; size += lstat(p)?.size || 0; }
  }
  return { size, files };
}

export function scanTools(env = machine()) {
  const entries = [], tools = [];
  for (const a of ADAPTERS) {
    const dirs = a.dirs(env).filter(d => fs.existsSync(d.dir));
    const files = a.files(env).filter(f => fs.existsSync(f.abs));
    if (a.id !== 'system') tools.push({ id: a.id, name: a.name, present: dirs.length > 0, dirs: dirs.map(d => norm(d.dir)), install: a.install || null, logins: a.logins });
    for (const d of dirs) {
      const before = entries.length;
      walkDir(a.id, d.dir, d.rules, entries);
      for (const e of entries.slice(before)) e.base = d.dir;
    }
    for (const f of files) {
      const st = lstat(f.abs); if (!st?.isFile()) continue;
      entries.push({ tool: a.id, cls: f.class, abs: f.abs, rel: path.basename(f.abs), base: path.dirname(f.abs), size: st.size, mtime: st.mtimeMs, opts: f, note: f.note });
    }
  }
  return { tools, entries };
}

export async function scan(env = machine()) {
  const t0 = Date.now();
  const { tools, entries } = scanTools(env);
  const projects = await scanProjects(env.home);
  return { at: Date.now(), ms: Date.now() - t0, machine: { home: norm(env.home), platform: env.platform, user: env.user }, tools, entries, projects };
}
