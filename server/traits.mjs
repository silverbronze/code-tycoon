// Core properties of a block or a district, by the role it plays: a Database
// shows its engine, data-access layer, tables and migrations; Payments its
// providers, currencies and flows; Security how people sign in and what guards
// the doors. Read from the files themselves with plain patterns, so every value
// can point at the files that show it. Per-file results are cached by size.
import fs from 'node:fs';
import path from 'node:path';
import { labelRole } from './roles.mjs';

// ---- property kinds
// tags: [name, content regex, path regex?]; a file shows a tag when either matches
const tags = (k, list) => ({ k, type: 'tags', list });
// names: fn(txt, p) -> string[] (table names, endpoints...)
const names = (k, fn, unit) => ({ k, type: 'names', fn, unit });
// sum: fn(txt, p) -> number
const sum = (k, fn, unit) => ({ k, type: 'sum', fn, unit });
// files: count of files whose path matches
const files = (k, re, unit) => ({ k, type: 'files', re, unit });

const all = (re, txt, g = 1) => { const out = []; for (const m of txt.matchAll(re)) if (m[g]) out.push(m[g]); return out; };
const count = (re, txt) => (txt.match(re) || []).length;

// route of a Next.js / file-based page or handler: app/(shop)/p/[id]/page.tsx -> /p/[id]
function fileRoute(p) {
  const m = /(?:^|\/)(app|pages)\/(.*)$/.exec(p);
  if (!m) return null;
  let r = m[2].replace(/\.(t|j)sx?$|\.mdx?$/, '');
  if (m[1] === 'app') { if (!/(^|\/)(page|route)$/.test(r)) return null; r = r.replace(/(^|\/)(page|route)$/, ''); }
  else if (/(^|\/)_(app|document|error)$/.test(r)) return null;
  r = r.split('/').filter(s => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/').replace(/(^|\/)index$/, '');
  return '/' + r;
}
const METHOD = '(get|post|put|patch|delete)';
function endpoints(txt, p) {
  const out = [];
  for (const m of txt.matchAll(new RegExp(`\\b(?:app|router|api|server|fastify)\\.${METHOD}\\(\\s*['"\`]([^'"\`]+)`, 'g'))) out.push(m[1].toUpperCase() + ' ' + m[2]);
  for (const m of txt.matchAll(new RegExp(`@(?:app|router|bp|api)\\.${METHOD}\\(\\s*['"]([^'"]+)`, 'g'))) out.push(m[1].toUpperCase() + ' ' + m[2]);
  if (/(^|\/)route\.(t|j)s$/.test(p)) { const r = fileRoute(p); if (r) for (const m of txt.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) out.push(m[1] + ' ' + r); }
  if (/(^|\/)pages\/api\//.test(p)) { const r = fileRoute(p); if (r) out.push('ANY ' + r); }
  return out;
}
function tables(txt, p) {
  const out = all(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(?:\w+\.)?(\w+)/gi, txt);
  if (p.endsWith('.prisma')) out.push(...all(/^model\s+(\w+)\s*\{/gm, txt));
  out.push(...all(/(?:pgTable|sqliteTable|mysqlTable)\(\s*['"](\w+)/g, txt));
  out.push(...all(/__tablename__\s*=\s*['"](\w+)/g, txt));
  return out.map(s => s.toLowerCase());
}
const SKIP_HOST = /(^|\.)(w3\.org|schema\.org|example\.(com|org)|localhost|github\.com|githubusercontent\.com|npmjs\.(com|org)|googleapis\.com|gstatic\.com|mozilla\.org|wikipedia\.org|json-schema\.org|xmlns\.com|purl\.org|ogp\.me|unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com)$/;
function hosts(txt) {
  const out = [];
  for (const m of txt.matchAll(/https?:\/\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) { const h = m[1].toLowerCase(); if (!SKIP_HOST.test(h)) out.push(h); }
  return out;
}

const KINDS = {
  database: { name: 'Database', props: [
    tags('Engine', [['SQLite', /better-sqlite3|node:sqlite|sqlite3|aiosqlite|\.sqlite\b|libsql|turso/i, /\.(sqlite3?|db)$/],
      ['PostgreSQL', /postgres(ql)?:\/\/|from\s+['"](pg|postgres)['"]|require\(['"]pg['"]\)|psycopg|asyncpg|@neondatabase|@vercel\/postgres|provider\s*=\s*"postgresql"|pgTable/i],
      ['MySQL', /mysql2?|mariadb|pymysql|mysqlTable|provider\s*=\s*"mysql"/i], ['MongoDB', /mongodb|mongoose|pymongo/i],
      ['Redis', /ioredis|from\s+['"]redis['"]|require\(['"]redis['"]\)|redis:\/\/|@upstash\/redis/i], ['Supabase', /@supabase\/|supabase\.co/i],
      ['Firestore', /firestore/i], ['DynamoDB', /dynamodb/i]]),
    tags('Data access', [['Prisma', /@prisma\/client/, /\.prisma$/], ['Drizzle', /drizzle-orm/], ['Knex', /from\s+['"]knex['"]|require\(['"]knex['"]\)/],
      ['Sequelize', /sequelize/i], ['TypeORM', /typeorm/], ['Kysely', /kysely/], ['Mongoose', /mongoose/], ['SQLAlchemy', /sqlalchemy/i],
      ['Django ORM', /django\.db/], ['Raw SQL', /\b(SELECT\s[\s\S]{1,200}?\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/]]),
    names('Tables', tables, 'tables'),
    files('Migrations', /(^|\/)(migrations?|migrate)(\/|[-_.])|\d{8,}[-_]\w+\.sql$/i, 'files'),
    sum('Indexes', txt => count(/CREATE\s+(?:UNIQUE\s+)?INDEX/gi, txt) + count(/@@index|@@unique/g, txt), 'indexes'),
    tags('Integrity', [['Transactions', /\bBEGIN(\s+(IMMEDIATE|TRANSACTION))?\s*;|\.transaction\(|\$transaction|db\.begin\(|session\.begin\(/],
      ['Foreign keys', /\bREFERENCES\s+\w+|FOREIGN\s+KEY|@relation\(/i], ['Constraints', /\bCHECK\s*\(|\bUNIQUE\b|NOT NULL/],
      ['WAL mode', /journal_mode\s*=\s*WAL/i], ['Backups', /\bbackup\b|pg_dump|\.dump\b|VACUUM\s+INTO/i]]),
  ] },
  payments: { name: 'Payments', props: [
    tags('Providers', [['Stripe', /stripe/i], ['PayPal', /paypal/i], ['Paddle', /paddle\.com|@paddle\//i], ['Lemon Squeezy', /lemonsqueezy/i],
      ['Braintree', /braintree/i], ['Square', /squareup/i], ['Adyen', /adyen/i], ['Mollie', /mollie/i], ['Razorpay', /razorpay/i],
      ['Tranzila', /tranzila/i], ['Cardcom', /cardcom/i], ['Grow / Meshulam', /meshulam|grow\.co\.il/i], ['PayPlus', /payplus/i],
      ['Apple Pay', /apple.?pay/i], ['Google Pay', /google.?pay/i], ['Crypto', /coinbase|usdc|web3/i]]),
    tags('Handles', [['Checkout', /checkout/i, /checkout/i], ['Cart', /\bcart\b|basket/i, /cart|basket/i], ['Orders', /\border(s|_id|Id)?\b/i, /orders?/i],
      ['Subscriptions', /subscription|recurring/i], ['Refunds', /refund/i], ['Invoices', /invoice|receipt/i], ['Payouts', /payout|transfer_group|connect.*account/i],
      ['Webhooks', /webhook/i, /webhook/i], ['Tax / VAT', /\b(vat|sales.?tax|tax.?rate)\b/i], ['Shipping', /shipping|shipment|parcel/i], ['Currency conversion', /exchange.?rate|\bfx\b|convert.*currency/i]]),
    names('Currencies', txt => all(/\b(USD|EUR|GBP|ILS|JPY|CAD|AUD|CHF|CNY|INR|SEK|NOK|DKK|PLN|BRL|MXN)\b/g, txt), 'currencies'),
    tags('Safety', [['Idempotency keys', /idempotency/i], ['Signature check', /constructEvent|verify.?signature|webhook.?secret|x-signature/i], ['Amounts in cents', /amount_?cents|unit_amount|\*\s*100\b|minor.?units/i]]),
    names('Endpoints', endpoints, 'endpoints'),
  ] },
  security: { name: 'Security', props: [
    tags('Sign-in', [['Passwords', /password/i], ['Magic links', /magic.?link|login.?link|sign.?in.?link|email.?link/i], ['One-time codes', /\botp\b|one.?time.?code|verification.?code/i],
      ['OAuth / SSO', /oauth|openid|next-auth|@auth\/|passport|clerk|auth0|saml/i], ['Passkeys', /webauthn|passkey/i], ['2FA', /totp|\b2fa\b|two.?factor|mfa\b/i]]),
    tags('Sessions', [['Cookies', /set-cookie|cookies\(\)|httpOnly|express-session|iron-session|cookie-parser/i], ['JWT', /jsonwebtoken|\bjwt\b|from\s+['"]jose['"]/i], ['Server sessions', /sessions?\s+table|session_id|sessionId|session store/i]]),
    tags('Password hashing', [['bcrypt', /bcrypt/i], ['argon2', /argon2/i], ['scrypt', /scrypt/i], ['PBKDF2', /pbkdf2/i]]),
    tags('Protections', [['Rate limiting', /rate.?limit|ratelimit|limiter|throttl/i, /rate.?limit|limiter/i], ['CSRF', /csrf|xsrf/i], ['CAPTCHA', /turnstile|recaptcha|hcaptcha|captcha/i],
      ['Security headers', /helmet|content-security-policy|strict-transport-security|x-frame-options|x-content-type-options/i], ['WAF / bot rules', /\bwaf\b|firewall|bad.?bots?|block(ed)?.?bots?|user.?agent.*(block|deny)/i, /waf|firewall|bots?/i],
      ['Input validation', /from\s+['"](zod|joi|yup|valibot)['"]|pydantic|express-validator/i], ['Sanitizing', /sanitiz|dompurify|escapeHtml|xss/i], ['Encryption', /createCipheriv|aes-?256|crypto\.subtle|encrypt\(/i],
      ['Access control', /\b(isAdmin|requireAdmin|role\s*===|permissions?|authorize|acl)\b/i]]),
    tags('Privacy', [['Cookie consent', /cookie.?consent|consent.?banner|consent mode/i], ['GDPR / data rights', /gdpr|data.?deletion|delete.?account|privacy.?policy/i]]),
    names('Secrets in env', txt => all(/process\.env\.([A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASS)[A-Z0-9_]*)/g, txt).concat(all(/os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD)[A-Z0-9_]*)/g, txt)), 'secrets'),
  ] },
  storefront: { name: 'Storefront', props: [
    tags('Framework', [['Next.js', /from\s+['"]next(\/|['"])/, /next\.config\./], ['React', /from\s+['"]react['"]/, /\.(tsx|jsx)$/], ['Vue', /from\s+['"]vue['"]/, /\.vue$/],
      ['Svelte', /svelte/, /\.svelte$/], ['Astro', /astro/, /\.astro$/], ['Angular', /@angular\//], ['jQuery', /jquery|\$\(document\)/i], ['WordPress', /wp-content|add_action\(|wp_enqueue/], ['Plain HTML', /<!doctype html/i, /\.html?$/]]),
    tags('Styling', [['Tailwind', /tailwind|className=["'`][^"'`]*\b(flex|grid|px-\d|text-(sm|lg|xl))\b/], ['CSS modules', /\.module\.css/, /\.module\.(css|scss)$/], ['Sass', /\.scss/, /\.(scss|sass)$/],
      ['styled-components / Emotion', /styled-components|@emotion\//], ['Plain CSS', /^/, /\.css$/]]),
    names('Pages', (txt, p) => { if (/(^|\/)(page)\.(t|j)sx?$/.test(p) || /(^|\/)pages\/(?!api\/).*\.(t|j)sx?$/.test(p)) { const r = fileRoute(p); return r ? [r] : []; } return /\.html?$/.test(p) ? [p.split('/').pop()] : []; }, 'pages'),
    files('Components', /(^|\/)components?\//i, 'files'),
    names('Endpoints', endpoints, 'endpoints'),
    tags('Features', [['Search', /search/i], ['Images (optimized)', /next\/image|srcset|loading=["']lazy/], ['Languages / i18n', /i18n|next-intl|hreflang|useTranslation|locale/i],
      ['Right-to-left', /dir=["']rtl|\brtl\b/i], ['Dark mode', /prefers-color-scheme|dark:/], ['Forms', /<form|onSubmit/], ['Accessibility', /aria-|role=["']/]]),
  ] },
  api: { name: 'API', props: [
    tags('Framework', [['Express', /from\s+['"]express['"]|require\(['"]express['"]\)/], ['Fastify', /fastify/], ['Hono', /from\s+['"]hono/], ['Koa', /from\s+['"]koa['"]/],
      ['Next.js route handlers', /export\s+(async\s+)?function\s+(GET|POST)\b/, /(^|\/)route\.(t|j)s$/], ['FastAPI', /fastapi/i], ['Flask', /from\s+flask/], ['Django', /django/], ['tRPC', /@trpc\//], ['GraphQL', /graphql/i]]),
    names('Endpoints', endpoints, 'endpoints'),
    tags('Handles', [['Auth check', /auth|session|token/i], ['Validation', /zod|joi|yup|pydantic|validate/i], ['Pagination', /\b(limit|offset|cursor|page)\b/], ['CORS', /cors/i], ['Caching', /cache-control|revalidate|etag|\bcache\b/i]]),
  ] },
  pipeline: { name: 'Data pipeline', props: [
    tags('Fetching', [['Playwright', /playwright/i], ['Puppeteer', /puppeteer/i], ['Selenium', /selenium/i], ['Cheerio', /cheerio/], ['BeautifulSoup', /bs4|BeautifulSoup/],
      ['Scrapy', /scrapy/], ['HTTP fetch', /\bfetch\(|axios|requests\.(get|post)|httpx|undici|got\(/]]),
    names('Sources', hosts, 'sites'),
    tags('Runs', [['Cron / schedule', /cron|schedule|setInterval|apscheduler|systemd timer/i, /cron/i], ['Queue', /bullmq|\bbull\b|celery|\brq\b|p-queue|job.?queue/i], ['Batches', /batch/i, /batch/i], ['Backfills', /backfill/i, /backfill/i]]),
    tags('Robustness', [['Retries / backoff', /retry|retries|backoff/i], ['Rate limits', /rate.?limit|sleep\(|throttl|delay\(/i], ['Proxies', /proxy|proxies/i], ['Dedup / matching', /dedup|fuzzy|similarity|levenshtein|match(ing|er)/i]]),
    tags('Data formats', [['CSV', /\.csv\b|csv-parse|papaparse|import csv/i, /\.csv$/], ['JSON / JSONL', /JSON\.parse|json\.load|\.jsonl?\b/], ['Excel', /xlsx|openpyxl|exceljs/i], ['Parquet', /parquet/i]]),
  ] },
  infra: { name: 'Infrastructure', props: [
    tags('Hosting', [['Docker', /docker|FROM\s+\w+[:@]/, /(^|\/)(Dockerfile|docker-compose[^/]*|compose\.ya?ml)$/i], ['Vercel', /vercel/i, /vercel\.json$/], ['Netlify', /netlify/i, /netlify\.toml$/],
      ['Cloudflare', /cloudflare|wrangler/i, /wrangler\.toml$/], ['Fly.io', /fly\.io|flyctl/i, /fly\.toml$/], ['Railway', /railway/i], ['Render', /render\.com/i], ['AWS', /\baws\b|amazonaws|s3:\/\//i],
      ['Google Cloud', /gcloud|googleapis\.com\/storage/i], ['Hostinger', /hostinger|hstgr/i], ['DigitalOcean', /digitalocean/i], ['Hetzner', /hetzner/i], ['VPS over SSH', /\bssh\s+\S+@|rsync\s+-/]]),
    tags('Web server', [['nginx', /nginx|server_name|proxy_pass/, /nginx|\.conf$/], ['Apache', /RewriteRule|<VirtualHost/, /\.htaccess$/], ['Caddy', /caddy/i, /Caddyfile$/]]),
    tags('Delivery', [['CI (GitHub Actions)', /^/, /^\.github\/workflows\//], ['GitLab CI', /^/, /\.gitlab-ci\.yml$/], ['pm2', /pm2/], ['systemd', /systemd|\[Service\]/], ['Deploy scripts', /deploy/i, /deploy/i], ['Release tags', /git tag|release/i, /release/i]]),
    tags('Operations', [['Backups', /backup/i, /backup/i], ['TLS certificates', /certbot|letsencrypt|ssl_certificate|acme/i], ['DNS', /\bdns\b|A record|CNAME|nameserver/i, /dns/i], ['Health checks', /health|uptime|status.?check/i], ['Logs', /logrotate|journalctl|access_log|error_log/i]]),
    names('Env vars', (txt, p) => all(/process\.env\.([A-Z][A-Z0-9_]+)/g, txt).concat(all(/os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]+)/g, txt), /(^|\/)\.env[\w.-]*$/.test(p) ? all(/^([A-Z][A-Z0-9_]+)=/gm, txt) : []), 'variables'),
  ] },
  qa: { name: 'Testing & QA', props: [
    tags('Frameworks', [['Vitest', /vitest/], ['Jest', /jest|@jest\//], ['Mocha', /mocha|describe\(.*function/], ['node:test', /node:test/], ['Playwright Test', /@playwright\/test/],
      ['Cypress', /cypress/i], ['pytest', /pytest|def test_/], ['unittest', /import unittest/]]),
    files('Test files', /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i, 'files'),
    sum('Test cases', txt => count(/^\s*(?:it|test)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(/gm, txt) + count(/^\s*(?:async\s+)?def test_/gm, txt), 'cases'),
    tags('Kinds', [['Unit', /\bexpect\(|assert/], ['End-to-end', /page\.goto|cy\.visit/], ['Smoke', /smoke/i, /smoke/i], ['Snapshot', /toMatchSnapshot|toMatchInlineSnapshot/], ['Visual / screenshots', /screenshot|toHaveScreenshot/], ['Mocks', /vi\.mock|jest\.mock|unittest\.mock|nock|msw/]]),
  ] },
  marketing: { name: 'Marketing & SEO', props: [
    tags('Analytics', [['Google Analytics', /gtag\(|google-analytics|\bG-[A-Z0-9]{8,}\b/], ['Tag Manager', /googletagmanager|\bGTM-[A-Z0-9]+/], ['PostHog', /posthog/i], ['Plausible', /plausible/i],
      ['Meta Pixel', /fbq\(|facebook.?pixel|connect\.facebook\.net/i], ['Mixpanel', /mixpanel/i], ['Segment', /segment\.(com|io)|analytics\.track/i], ['Hotjar', /hotjar/i], ['Clarity', /clarity\.ms/i], ['Umami', /umami/i]]),
    tags('SEO', [['Sitemap', /sitemap/i, /sitemap/i], ['robots.txt', /robots/i, /robots\.(txt|ts|js)$/], ['Structured data', /application\/ld\+json|jsonld|json-ld/i], ['Open Graph', /og:|openGraph/],
      ['Canonical URLs', /canonical/i], ['hreflang', /hreflang/i], ['IndexNow', /indexnow/i], ['Search Console', /search.?console|\bgsc\b/i]]),
    tags('Email', [['Resend', /resend/i], ['SendGrid', /sendgrid/i], ['Mailgun', /mailgun/i], ['Postmark', /postmark/i], ['Amazon SES', /\bses\b|@aws-sdk\/client-ses/i], ['Nodemailer', /nodemailer/i], ['Mailchimp', /mailchimp/i], ['Notifuse', /notifuse/i]]),
    tags('Ads & attribution', [['Google Ads', /google.?ads|adwords|gclid/i], ['Meta Ads', /meta.?ads|fbclid|facebook.?ads/i], ['UTM tracking', /utm_(source|medium|campaign)/i], ['Conversions', /conversion/i]]),
  ] },
};

// brand and docs read the inventory, not the content
const IMG = /\.(png|jpe?g|webp|gif|svg|ico|avif|bmp|tiff?)$/i, FONT = /\.(ttf|otf|woff2?|eot)$/i, VID = /\.(mp4|mov|webm)$/i;

// The property set a district id stands for: base roles keep their own, a
// project-specific one borrows the closest by its name ("Orders & Users API").
export function kindOf(id, name) {
  if (KINDS[id] || id === 'brand' || id === 'docs') return id;
  const s = `${id} ${name || ''}`;
  if (/\b(api|apis|endpoints?|backend|server)\b/i.test(s)) return 'api';
  const r = labelRole(s);
  return r && (KINDS[r] || r === 'brand' || r === 'docs') ? r : null;
}

// ---- per-file signals, cached
const cache = new Map(); // root|p|size|kind -> { [prop]: values | number }, plus lines and libs
const READ = new Set(['code', 'config', 'markup', 'doc', 'style', 'other']);
const LIB_JS = /(?:^|[^\w$.])(?:import\s+(?:[\w*{}\s,$]+\s+from\s+)?|require\s*\(\s*)["']((?:@[\w.-]+\/)?[\w.:-]+)[^"']*["']/g;
const LIB_PY = /^\s*(?:from\s+([a-zA-Z_]\w*)[\w.]*\s+import|import\s+([a-zA-Z_]\w*))/gm;
const STD_PY = new Set(['os', 'sys', 're', 'json', 'time', 'datetime', 'math', 'pathlib', 'typing', 'collections', 'itertools', 'functools', 'subprocess', 'random', 'csv', 'io', 'logging', 'argparse', 'shutil', 'glob', 'hashlib', 'base64', 'urllib', 'string', 'textwrap', 'tempfile', 'copy', 'dataclasses', 'enum', 'traceback', 'threading', 'asyncio', 'unicodedata', 'html', 'uuid', 'statistics', 'concurrent', 'contextlib', 'abc', 'struct', 'zipfile', 'pprint', 'socket', 'secrets', 'platform', '__future__', 'imaplib', 'smtplib', 'email', 'sqlite3', 'ssl', 'getpass', 'signal', 'gzip', 'pickle', 'decimal', 'operator', 'inspect', 'warnings', 'queue', 'multiprocessing', 'http', 'xml', 'mimetypes', 'locale', 'calendar', 'heapq', 'bisect', 'difflib', 'webbrowser', 'shlex', 'codecs', 'configparser', 'ipaddress', 'unittest', 'ctypes', 'array', 'fnmatch', 'types', 'weakref', 'atexit', 'errno', 'stat', 'select', 'gc', 'zlib']);

function signals(root, f, kind) {
  const ck = root + '|' + f.p + '|' + f.size + '|' + kind;
  let s = cache.get(ck);
  if (s) return s;
  s = { lines: 0, libs: [] };
  const props = KINDS[kind]?.props || [];
  let txt = '';
  if (READ.has(f.kind) && f.size <= 300 * 1024 && !f.p.endsWith('.svg') && !/\.(min\.js|map|lock)$|package-lock\.json$/.test(f.p)) {
    try { txt = fs.readFileSync(path.join(root, f.p), 'utf8'); } catch {}
  }
  if (txt) {
    if (f.kind === 'code' || f.kind === 'style' || f.kind === 'markup') s.lines = count(/\n/g, txt) + 1;
    if (f.kind === 'doc') s.words = count(/\S+/g, txt);
    if (f.kind === 'code') {
      const libs = new Set();
      if (f.p.endsWith('.py')) { for (const m of txt.matchAll(LIB_PY)) { const l = m[1] || m[2]; if (!STD_PY.has(l)) libs.add(l); } }
      else for (const m of txt.matchAll(LIB_JS)) { const l = m[1]; if (!l.startsWith('.') && !l.startsWith('node:') && !/^(fs|path|os|url|http|https|crypto|child_process|util|events|stream|zlib|readline|assert|net|tls|dns|buffer|worker_threads|process|module|timers|querystring|vm)$/.test(l)) libs.add(l); }
      s.libs = [...libs];
    }
  }
  for (const pr of props) {
    if (pr.type === 'files') { if (pr.re.test(f.p)) s[pr.k] = 1; continue; }
    if (pr.type === 'tags') {
      const hit = [];
      for (const [name, re, pre] of pr.list) if ((pre && pre.test(f.p)) || (txt && re.source !== '^' && re.test(txt))) hit.push(name);
      if (hit.length) s[pr.k] = hit;
      continue;
    }
    if (!txt) continue;
    const v = pr.fn(txt, f.p);
    if (pr.type === 'sum' ? v > 0 : v.length) s[pr.k] = pr.type === 'sum' ? v : [...new Set(v)];
  }
  if (cache.size > 60000) cache.clear();
  cache.set(ck, s);
  return s;
}

const EX = 4; // example files kept per value
const add = (m, t, p) => { const e = m.get(t) || { t, n: 0, f: [] }; e.n++; if (e.f.length < EX) e.f.push(p); m.set(t, e); };
const top = (m, k) => [...m.values()].sort((a, b) => b.n - a.n || a.t.localeCompare(b.t)).slice(0, k);

// Properties of a set of files playing one role. Returns
// { kind, props: [{ k, v: [{ t, n, f }], total?, unit? }] }, the role's own
// properties first (only the ones with something to show), then the basics.
// `local`: names of the project's own folders and modules, so `import lib` in a
// script that sits next to lib.py is not counted as a library.
export function traitsOf(root, inv, kind, local = new Set()) {
  const props = [];
  const def = KINDS[kind];
  const sig = inv.map(f => [f, signals(root, f, def ? kind : '')]);
  if (def) for (const pr of def.props) {
    if (pr.type === 'files') {
      const hit = sig.filter(([, s]) => s[pr.k]).map(([f]) => f.p);
      if (hit.length) props.push({ k: pr.k, total: hit.length, unit: pr.unit, v: hit.slice(0, EX).map(p => ({ t: p.split('/').pop(), n: 1, f: [p] })) });
    } else if (pr.type === 'sum') {
      let total = 0; const m = new Map();
      for (const [f, s] of sig) if (s[pr.k]) { total += s[pr.k]; m.set(f.p, { t: f.p.split('/').pop(), n: s[pr.k], f: [f.p] }); }
      if (total) props.push({ k: pr.k, total, unit: pr.unit, v: top(m, EX) });
    } else {
      const m = new Map();
      for (const [f, s] of sig) for (const t of s[pr.k] || []) add(m, t, f.p);
      if (!m.size) continue;
      // tags read as a short list; names (tables, pages, endpoints) as a count with the commonest
      if (pr.type === 'tags') props.push({ k: pr.k, v: top(m, 12) });
      else props.push({ k: pr.k, total: m.size, unit: pr.unit, v: top(m, 14) });
    }
  }
  if (kind === 'brand') {
    const m = new Map(); let bytes = 0, big = null;
    for (const f of inv) {
      const e = (f.p.split('.').pop() || '').toLowerCase();
      if (IMG.test(f.p) || FONT.test(f.p) || VID.test(f.p)) { add(m, e === 'jpeg' ? 'jpg' : e, f.p); bytes += f.size; if (!big || f.size > big.size) big = f; }
    }
    const n = k => [...m.values()].filter(x => k.test('.' + x.t)).reduce((s, x) => s + x.n, 0);
    if (m.size) {
      props.push({ k: 'Media', v: [['Images', n(IMG)], ['Fonts', n(FONT)], ['Video', n(VID)]].filter(x => x[1]).map(([t, c]) => ({ t, n: c, f: [] })) });
      props.push({ k: 'Formats', v: top(m, 10) });
      props.push({ k: 'Weight', v: [{ t: fmtBytes(bytes) + ' in all', n: 0, f: [] }, ...(big ? [{ t: 'largest ' + big.p.split('/').pop() + ' (' + fmtBytes(big.size) + ')', n: 0, f: [big.p] }] : [])] });
    }
  }
  if (kind === 'docs') {
    const docs = sig.filter(([f]) => f.kind === 'doc');
    if (docs.length) {
      const words = docs.reduce((s, [, x]) => s + (x.words || 0), 0);
      props.push({ k: 'Documents', total: docs.length, unit: 'files', v: docs.sort((a, b) => (b[1].words || 0) - (a[1].words || 0)).slice(0, 6).map(([f, x]) => ({ t: f.p.split('/').pop(), n: x.words || 0, f: [f.p] })) });
      props.push({ k: 'Length', v: [{ t: `${words.toLocaleString('en-US')} words`, n: 0, f: [] }, { t: `about ${Math.max(1, Math.round(words / 230))} min to read`, n: 0, f: [] }] });
    }
  }
  // basics for every role
  const langs = new Map(), libs = new Map();
  let lines = 0, bytes = 0;
  for (const [f, s] of sig) {
    bytes += f.size; lines += s.lines || 0;
    const e = (f.p.split('.').pop() || '').toLowerCase();
    if ((f.kind === 'code' || f.kind === 'style' || f.kind === 'markup') && e !== 'svg') add(langs, LANG[e] || e, f.p);
    for (const l of s.libs) if (e !== 'py' || !local.has(l.toLowerCase())) add(libs, l, f.p);
  }
  if (libs.size) props.push({ k: 'Libraries', basic: true, v: top(libs, 10) });
  if (langs.size) props.push({ k: 'Languages', basic: true, v: top(langs, 5) });
  props.push({ k: 'Size', basic: true, v: [{ t: `${inv.length} files`, n: 0, f: [] }, { t: fmtBytes(bytes), n: 0, f: [] }, ...(lines ? [{ t: `${lines.toLocaleString('en-US')} lines`, n: 0, f: [] }] : [])] });
  return { kind: def ? def.name : kind === 'brand' ? 'Brand & media' : kind === 'docs' ? 'Docs' : null, props };
}

const LANG = { ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', php: 'PHP', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', cs: 'C#', swift: 'Swift', sql: 'SQL', sh: 'Shell', ps1: 'PowerShell',
  bat: 'Batch', css: 'CSS', scss: 'Sass', sass: 'Sass', less: 'Less', html: 'HTML', htm: 'HTML', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', xml: 'XML', njk: 'Nunjucks', liquid: 'Liquid', lua: 'Lua', dart: 'Dart' };
function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB'; }
