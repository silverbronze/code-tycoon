// Finds secrets in config files and swaps each for a reference, `@@ct-secret:<id>@@`.
// The values go into the vault; the file that is stored keeps only the reference.
// It errs toward treating a value as secret: a stray setting in the vault costs
// nothing, a token left in plain text ends the product.
import crypto from 'node:crypto';

// A setting name is split into words (camelCase, snake_case, dots, dashes) and is
// a secret name when a word is one of these...
const SECRET_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'pass', 'passphrase', 'bearer', 'credential', 'credentials',
  'cookie', 'cookies', 'authorization', 'auth', 'apikey', 'sessionid', 'privatekey', 'pat', 'dsn', 'webhook']);
// ...or `key` follows one of these (api_key, ACCESS_KEY, privateKey)
const KEY_AFTER = new Set(['api', 'access', 'secret', 'private', 'signing', 'client', 'master', 'license', 'encryption', 'service', 'app', 'auth']);
// and no word says it is a count, a switch or a place
const NOT_WORDS = new Set(['tokens', 'max', 'min', 'count', 'limit', 'budget', 'len', 'length', 'size', 'type', 'method', 'mode', 'url', 'uri', 'endpoint',
  'file', 'path', 'dir', 'name', 're', 'regex', 'pattern', 'date', 'at', 'ttl', 'timeout', 'expiry', 'expires', 'header', 'env', 'var', 'provider', 'enabled', 'required', 'use', 'id_token_hint']);

export function words(k) {
  return String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
export function isSecretName(k) {
  const w = words(k);
  if (!w.length || w.some(x => NOT_WORDS.has(x))) return false;
  return w.some((x, i) => SECRET_WORDS.has(x) || (x === 'key' && i > 0 && KEY_AFTER.has(w[i - 1])));
}

const B = '(?<![A-Za-z0-9_])';
// Shapes that are secrets wherever they appear.
const SHAPES = [
  `sk-ant-[A-Za-z0-9_-]{20,}`, `sk-(?:proj-)?[A-Za-z0-9_-]{32,}`, `gh[pousr]_[A-Za-z0-9]{30,}`, `github_pat_[A-Za-z0-9_]{30,}`,
  `xox[abposr]-[A-Za-z0-9-]{10,}`, `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{30,}`, `glpat-[A-Za-z0-9_-]{20,}`, `hf_[A-Za-z0-9]{30,}`,
  `(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`, `eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`,
  `npm_[A-Za-z0-9]{30,}`, `dop_v1_[a-f0-9]{40,}`, `SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`,
].map(s => new RegExp(B + s, 'g'));
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// credentials inside a URL: user:pass@host, ?token=..., ?key=...
const URL_CRED = /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:)[^\s@/"'<>]{3,}(?=@)/gi;
const URL_PARAM = /(?<=[?&](?:access_?token|token|api_?key|apikey|key|secret|password|auth|sig|signature)=)[A-Za-z0-9._~%+/=-]{12,}/gi;
const BEARER = /(?<=\b(?:Bearer|Basic|Token)\s+)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{16,}/g;

export const REF = /@@ct-secret:([a-f0-9]{16})@@/g;
const idOf = v => crypto.createHash('sha256').update('ct-secret\0' + v).digest('hex').slice(0, 16);
const take = (found, v) => { const id = idOf(v); found.set(id, v); return `@@ct-secret:${id}@@`; };

// A value that could be a secret: not a number, a switch, a path, a plain URL or prose.
function looksLikeValue(v, strict) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 20000) return false;
  if (/^(true|false|null|none|undefined|\d+(\.\d+)?)$/i.test(v)) return false;
  if (/^(\/|~|[A-Za-z]:[\\/]|\.{1,2}[\\/]|@@ct-|\$|%|<|\{\{)/.test(v)) return false; // a path, a variable, a placeholder
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/:\/\/[^\s/@]+:[^\s/@]+@/.test(v) && !/[?&](token|key|secret|password|auth|sig)/i.test(v)) return false;
  if (/\s/.test(v) && !/^(Bearer|Basic|Token)\s+\S+$/i.test(v)) return false;
  // in code and docs only a key-like literal counts: long, letters and digits mixed
  if (strict && !(v.length >= 16 && /[0-9]/.test(v) && /[A-Za-z]/.test(v))) return false;
  return true;
}

// Replace every secret shape inside a string.
function cutShapes(s, found) {
  for (const re of [...SHAPES, PEM, URL_CRED, URL_PARAM, BEARER]) s = s.replace(re, m => take(found, m));
  return s;
}

// JSON: walk it. A string under a secret-looking key goes whole; any string is checked for shapes.
export function cutJson(value, found = new Map(), keyName = '') {
  if (typeof value === 'string') {
    if (keyName && isSecretName(keyName) && looksLikeValue(value, false)) return take(found, value);
    return cutShapes(value, found);
  }
  if (Array.isArray(value)) return value.map(v => cutJson(v, found, keyName));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = cutJson(v, found, k);
    return out;
  }
  return value;
}

// Config-like text (TOML, .env, .npmrc, ini, YAML) and notes (memory often holds a
// password written down in prose) allow bare values; code needs a quoted literal that
// looks like a key. A false hit costs nothing: restore puts the same text back.
const CONFIG_TEXT = /(^|[\\/])(\.env[^\\/]*|\.npmrc|\.pypirc|\.netrc|\.gitconfig|config|credentials|[^\\/]*\.(toml|ini|cfg|conf|env|ya?ml|properties|md|txt))$/i;
const PAIR = /(^|[\s{,;(])(["']?)([A-Za-z_][\w.:/-]*)\2(\s*[:=]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,;}#"'\n]+))/gm;
export function cutText(text, found = new Map(), file = '') {
  const config = CONFIG_TEXT.test(file);
  let out = text.replace(PAIR, (all, pre, q, name, sep, dq, sq, bare) => {
    if (bare != null && !config) return all;
    const v = dq ?? sq ?? bare;
    const last = name.split(/[.:/]/).filter(Boolean).pop() || name;
    if (!isSecretName(last) || !looksLikeValue(v, !config)) return all;
    const ref = take(found, v);
    return `${pre}${q}${name}${q}${sep}${dq != null ? `"${ref}"` : sq != null ? `'${ref}'` : ref}`;
  });
  return cutShapes(out, found);
}

// Cut secrets out of one file's text, JSON or not.
export function cutFile(text, file, found = new Map()) {
  if (/\.json$/i.test(file)) {
    try { return { text: JSON.stringify(cutJson(JSON.parse(text), found), null, 2) + '\n', json: true, found }; } catch {}
  }
  return { text: cutText(text, found, file), json: false, found };
}

// Put the values back. A missing value stays a reference and is reported.
export function fillSecrets(text, vault, missing = new Set()) {
  return text.replace(REF, (m, id) => {
    if (vault[id] == null) { missing.add(id); return m; }
    return vault[id];
  });
}
