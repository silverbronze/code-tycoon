import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const VIS_DIR = path.join(HOME, '.visualizer');
export const SUMMARIZER_CWD = path.join(VIS_DIR, 'summarizer');
export const PORT = Number(process.env.VISUALIZER_PORT || 4400);

fs.mkdirSync(VIS_DIR, { recursive: true });
fs.mkdirSync(SUMMARIZER_CWD, { recursive: true });

// One canonical spelling per file. Windows hands us c:\x, C:\x, /c/x and C:/x
// for the same path, so everything is folded to forward slashes and a lowercase
// key. `norm` keeps the case for display, `key` is what we compare on.
export function norm(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (msys) s = msys[1] + ':/' + s.slice(3);
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export const isWin = process.platform === 'win32';
export function key(p) {
  const n = norm(p);
  return n && isWin ? n.toLowerCase() : n;
}

// Path relative to root, or null when outside it. Both arguments normalized.
export function rel(root, p) {
  const r = key(root), k = key(p);
  if (!r || !k) return null;
  if (k === r) return '';
  if (k.startsWith(r + '/')) return norm(p).slice(r.length + 1);
  return null;
}

export function projectId(cwd) { return key(cwd); }

export function baseName(p) { return p.split('/').filter(Boolean).pop() || p; }

// Claude Code's transcript folder name for a cwd.
export function slugFor(cwd) { return norm(cwd).replace(/[^a-zA-Z0-9]/g, '-'); }

const TEMPISH = [key(os.tmpdir()), key(path.join(HOME, 'AppData'))].filter(Boolean);
export function isTempPath(p) {
  const k = key(p);
  return !!k && TEMPISH.some(t => k === t || k.startsWith(t + '/'));
}

// Newest claude.exe bundled with the VS Code extension; the folder name carries
// the version and changes on every update, so it is resolved at call time.
export function findClaudeCli() {
  if (process.env.VISUALIZER_CLAUDE) return process.env.VISUALIZER_CLAUDE;
  const extDir = path.join(HOME, '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(extDir).filter(d => d.startsWith('anthropic.claude-code-'));
    const ver = d => (d.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    dirs.sort((a, b) => {
      const x = ver(a), y = ver(b);
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return 0;
    });
    for (const d of dirs) {
      const exe = path.join(extDir, d, 'resources', 'native-binary', isWin ? 'claude.exe' : 'claude');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return 'claude';
}
