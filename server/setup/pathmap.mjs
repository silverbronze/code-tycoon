// Absolute paths in stored files become placeholders, so a snapshot made on one
// machine restores on another OS, user name or folder layout:
//   @@ct-home@@             the home folder
//   @@ct-project:<n>@@      the folder of project <n> in manifest.projects
// Windows spells one folder many ways (C:\Users\a, C:\\Users\\a in JSON text,
// C:/Users/a, c:/users/a, /c/Users/a); every spelling maps to the same placeholder.
import { norm, slugFor } from '../paths.mjs';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const END = '(?=[\\\\/"\'`\\s,;:)\\]}>]|$)';

// A regex matching every spelling of an absolute folder.
export function spellings(p, win) {
  const parts = norm(p).split('/').filter(Boolean);
  let head = '';
  if (/^[A-Za-z]:$/.test(parts[0])) {
    const d = parts.shift()[0];
    head = `(?:[${d.toUpperCase()}${d.toLowerCase()}]:|/${d.toLowerCase()}|/mnt/${d.toLowerCase()})`;
  }
  const body = parts.map(esc).join('(?:\\\\\\\\|\\\\|/)');
  const sep = head ? '(?:\\\\\\\\|\\\\|/)' : '/';
  return new RegExp((head ? head + sep : '/') + body + END, win ? 'gi' : 'g');
}

// roots: [{ path, token }], longest first so a project inside home wins over home
export function makeMapper(roots, win) {
  const list = roots.filter(r => r.path).map(r => ({ ...r, n: norm(r.path) })).sort((a, b) => b.n.length - a.n.length);
  const res = list.map(r => ({ re: spellings(r.path, win), token: r.token }));
  // Claude Code names transcript folders after the path: C--Users-a-Downloads-x
  const slugs = list.map(r => ({ slug: slugFor(r.path), token: r.token }));
  // the token remembers which separator the path was written with (`:b` one
  // backslash, `:bb` an escaped one), so a Windows restore writes it back the same way
  const styled = (token, m) => {
    const sep = /\\\\|\\|\//.exec(m.replace(/^[A-Za-z]:/, ''))?.[0];
    return sep === '\\\\' ? token.replace(/@@$/, ':bb@@') : sep === '\\' ? token.replace(/@@$/, ':b@@') : token;
  };
  return {
    text(s) { for (const { re, token } of res) s = s.replace(re, m => styled(token, m)); return s; },
    // a folder name under ~/.claude/projects
    slug(name) {
      for (const { slug, token } of slugs) {
        if (name.toLowerCase() === slug.toLowerCase()) return token;
        if (name.toLowerCase().startsWith(slug.toLowerCase() + '-')) return token + name.slice(slug.length);
      }
      return null;
    },
  };
}

const TOKEN = /@@ct-(home|project:\d+)(?::(bb|b))?@@((?:(?:\\\\|\\|\/)[^\\/\s"'`,;:)\]}>@]*)*)/g;

// Back from placeholders to this machine's folders.
// where: { home, projects: { '<n>': absolute path } }, win: target is Windows.
// On Windows the path keeps the separators it was written with; elsewhere all become `/`.
export function fillPaths(s, where, win) {
  return s.replace(TOKEN, (m, tok, style, rest) => {
    const base = tok === 'home' ? where.home : where.projects[tok.slice(8)];
    if (!base) return m;
    if (!win) return norm(base) + rest.replace(/\\\\|\\|\//g, '/');
    const sep = style === 'bb' ? '\\\\' : style === 'b' ? '\\' : '/';
    return norm(base).replace(/\//g, sep) + rest;
  });
}

export function fillSlug(name, where) {
  const m = /^@@ct-(home|project:\d+)@@(.*)$/.exec(name);
  if (!m) return name;
  const base = m[1] === 'home' ? where.home : where.projects[m[1].slice(8)];
  return base ? slugFor(base) + m[2] : null;
}
