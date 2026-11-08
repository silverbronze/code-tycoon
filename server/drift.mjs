// Drift signals: places where code built for an earlier setup is still carrying
// the current one. Read locally and fast, no model: comments that say so (legacy,
// workaround, fallback, "no longer"...), flags pinned to one value, old/v1/bak
// twins of a file, and old files that keep being reworked. The domain model uses
// them as evidence; the map shows them as strain on the isles that own the files.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.mjs';

const MARKER = /\b(legacy|deprecated|obsolete|no longer|used to|not used anymore|backwards? compat\w*|compat(?:ibility)? (?:shim|layer|path|mode)|work ?around|hack|kludge|temporar(?:y|ily)|for now|TODO|FIXME|XXX|shim|fallback|polyfill|leftover|left over|old (?:way|api|format|version|schema|path|code|setup|hook|style|theme)|kept for|until we|remove (?:this|once|when|after))\b/i;
const COMMENT = /(^|\s)(\/\/|#(?!\w*\[)|\/\*|\*\s|--\s|<!--|;\s)/;
const PINNED = [
  /\bif\s*\(\s*(?:false|true|0|1)\s*\)/,
  /&&\s*false\b|\|\|\s*true\b/,
  /\b[\w$]*(?:enabled|Enabled|ENABLED|legacy|Legacy|LEGACY|USE_[A-Z_]+|use[A-Z]\w*|OLD_[A-Z_]+)\s*[:=]\s*(?:false|true)\b(?!\s*[=&|?])/,
];
const TWIN = /(^|[/_.-])(old|legacy|deprecated|v1|bak|backup|copy|orig)([/_.-]|$)/i;
const CODE = new Set(['code', 'style', 'markup']);
const MAX_SIZE = 300 * 1024;
const cache = new Map(); // root|path|size|mtime -> { markers, pinned, lines }

function readSignals(root, p, size) {
  let st; try { st = fs.statSync(path.join(root, p)); } catch { return null; }
  const k = root + '|' + p + '|' + size + '|' + st.mtimeMs;
  if (cache.has(k)) return cache.get(k);
  let src; try { src = fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; }
  const markers = [], pinned = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 400) continue; // minified or data
    const c = COMMENT.exec(l);
    if (c && MARKER.test(l.slice(c.index))) markers.push({ line: i + 1, text: l.trim().slice(0, 160) });
    else if (PINNED.some(r => r.test(l))) pinned.push({ line: i + 1, text: l.trim().slice(0, 160) });
  }
  const out = { markers, pinned, lines: lines.length };
  cache.set(k, out);
  return out;
}

// Per file: what points at drift there, and a strain score to rank by.
export function scanDrift(pid, city) {
  const root = city.project.root;
  const now = Date.now(), t0 = city.project.t0 || Math.min(...city.files.map(f => f.born || now));
  const life = Math.max(now - t0, 86400e3);
  // tasks that wrote each file in the last 30 days: rework on code that keeps being bent
  const recent = new Map();
  try {
    for (const r of db.prepare(`SELECT lower(path) p, COUNT(DISTINCT task_id) n FROM events WHERE project_id=? AND kind='write' AND ts > ? AND path IS NOT NULL GROUP BY lower(path)`)
      .all(pid, now - 30 * 86400e3)) recent.set(r.p, r.n);
  } catch {}
  const names = new Set(city.files.map(f => f.p.toLowerCase()));
  const out = [];
  let read = 0;
  for (const f of city.files) {
    if (!CODE.has(f.kind) || f.size > MAX_SIZE || read > 4000) continue;
    read++;
    const s = readSignals(root, f.p, f.size);
    if (!s) continue;
    const age = f.born ? (now - f.born) / life : 0;
    const rework = recent.get((root + '/' + f.p).toLowerCase()) || 0;
    // a twin: api.old.js next to api.js, or a file under old/ or v1/
    const twin = TWIN.test(f.p) ? f.p : null;
    const sib = !twin && /\d$/.test(f.p.replace(/\.[^.]+$/, '')) && names.has(f.p.replace(/\d+(\.[^.]+)$/, '$1').toLowerCase()) ? f.p : null;
    const score = s.markers.length + s.pinned.length * 1.5 + (twin || sib ? 4 : 0)
      + (age > 0.5 && rework >= 3 ? rework * 0.8 : 0) + (s.lines > 1500 ? Math.min(6, s.lines / 1000) : 0);
    if (score < 2) continue;
    out.push({ p: f.p, score: +score.toFixed(1), markers: s.markers.slice(0, 8), markerCount: s.markers.length,
      pinned: s.pinned.slice(0, 5), lines: s.lines, rework, age: +age.toFixed(2), twin: !!(twin || sib), churn: f.churn });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 300);
}
