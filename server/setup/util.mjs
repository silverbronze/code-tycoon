// Small helpers shared by the setup scan, snapshot and restore.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

// Glob on forward-slash relative paths: `*` stays inside one folder, `**` crosses folders.
export function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// A file is text when its first 8 KB has no NUL byte and decodes as UTF-8.
export function isText(buf) {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head.length < buf.length ? head.subarray(0, lastBoundary(head)) : head); return true; } catch { return false; }
}
function lastBoundary(b) { let i = b.length; while (i > 0 && (b[i - 1] & 0xc0) === 0x80) i--; return Math.max(0, i - 1); }

export function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }

// Every file under dir: [{ rel, abs, size, mtime }], skipping symlinks and junctions.
// `prune(relDir)` returns true for folders not to descend into.
export function listFiles(dir, prune = () => false, base = '') {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(path.join(dir, base), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!prune(rel)) out.push(...listFiles(dir, prune, rel)); continue; }
    if (!e.isFile()) continue;
    const st = lstat(path.join(dir, rel));
    if (st) out.push({ rel, abs: path.join(dir, rel), size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

// Total size and file count of a folder, cheap enough for the audit.
export function treeSize(dir, limit = 200000) {
  let size = 0, files = 0;
  const stack = [dir];
  while (stack.length && files < limit) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files++; const st = lstat(p); if (st) size += st.size; }
    }
  }
  return { size, files };
}

export function git(cwd, args, timeout = 15000, env = undefined) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 16 << 20, env }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() }));
  });
}

// Run up to n promises at a time.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 10 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}
