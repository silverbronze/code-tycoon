// What each place in a project is for: Storefront, Database, Security... These
// roles are the city's districts, so a folder that mixes auth, checkout and SQL
// helpers is split into one block per role. The project's own list of roles and
// the file assignments come from the summarizer (kv 'roles:<pid>'); until it has
// answered, and for files added since, keyword rules on the path stand in.

// Starting vocabulary: the summarizer keeps these ids where they fit and adds
// project-specific ones.
export const BASE_ROLES = [
  { id: 'storefront', name: 'Storefront', desc: 'Customer-facing app: pages, UI components, public assets' },
  { id: 'database', name: 'Database', desc: 'Schemas, migrations, queries and data access' },
  { id: 'security', name: 'Security', desc: 'Auth, sessions, passwords, rate limits, bot and firewall rules' },
  { id: 'payments', name: 'Payments & orders', desc: 'Checkout, carts, orders, invoices, refunds' },
  { id: 'pipeline', name: 'Data pipeline', desc: 'Crawlers, imports, matching and other data jobs' },
  { id: 'infra', name: 'Infrastructure', desc: 'Servers, deploys, backups, DNS, web server config' },
  { id: 'qa', name: 'Testing & QA', desc: 'Tests, fixtures and QA tooling' },
  { id: 'marketing', name: 'Marketing & SEO', desc: 'SEO, analytics, ads, email campaigns' },
  { id: 'brand', name: 'Brand & media', desc: 'Logos, images and other media files' },
  { id: 'docs', name: 'Docs', desc: 'Notes, guides and project history' },
  { id: 'workspace', name: 'Workspace', desc: 'Everything else: scratch, research and tooling' },
];

// How a district's buildings look. A closed catalog the renderer knows how to draw;
// every district, whatever the project calls it, maps to one of these: the base
// roles by id, a project-specific district by the summarizer's pick ('style' in
// kv 'roles:<pid>'), else by keywords in its name and description, else by a hash
// over the generic looks, so the same district always looks the same.
export const STYLES = [
  { id: 'shops', desc: 'shopfronts, awnings, neon signs: customer-facing UI, pages, apps', re: /\b(storefront|front-?end|ui|ux|pages?|web ?app|client|mobile|ios|android|views?|screens?|components?|shop|store)\b/ },
  { id: 'vault', desc: 'windowless vaults and storage tanks: data, schemas, storage, caches', re: /\b(data(base)?|db|sql|storage|schema|cache|redis|persistence|records?|ledger|repository)\b/ },
  { id: 'fortress', desc: 'walls, watchtowers, searchlights: auth, security, permissions, secrets', re: /\b(security|auth\w*|login|identity|permissions?|access|secrets?|crypto|firewall|guard|privacy|compliance)\b/ },
  { id: 'bank', desc: 'columned banks with gold trim: payments, billing, money, orders', re: /\b(payments?|billing|checkout|orders?|invoices?|money|finance|pricing|subscriptions?|wallet|commerce|cart)\b/ },
  { id: 'factory', desc: 'factories with chimneys and conveyors: pipelines, jobs, crawlers, ETL, processing', re: /\b(pipelines?|crawl\w*|scrap\w*|etl|ingest\w*|jobs?|workers?|processing|batch|import\w*|sync|render\w*|build\w*|compiler|transform\w*)\b/ },
  { id: 'power', desc: 'power stations and pylons: infrastructure, deploys, servers, CI, ops', re: /\b(infra\w*|deploy\w*|devops|ops|servers?|ci|cd|docker|cloud|hosting|platform|runtime|kubernetes|k8s|terraform)\b/ },
  { id: 'lab', desc: 'labs with domes and status lamps: tests, QA, benchmarks, experiments', re: /\b(tests?|testing|qa|quality|spec|benchmarks?|e2e|experiments?|eval\w*|fixtures?)\b/ },
  { id: 'media', desc: 'billboards and a broadcast tower: marketing, SEO, analytics, email, ads, notifications', re: /\b(marketing|seo|analytics|ads?|campaigns?|email|newsletter|notifications?|growth|social|tracking|content)\b/ },
  { id: 'gallery', desc: 'galleries and statues: brand, design, images, media assets, themes', re: /\b(brand\w*|design|assets?|images?|media|icons?|fonts?|art|graphics|themes?|styles?)\b/ },
  { id: 'library', desc: 'a library with a clock tower: docs, notes, guides, history, knowledge', re: /\b(docs?|documentation|notes|guides?|wiki|knowledge|history|readme|manuals?|research)\b/ },
  { id: 'workshop', desc: 'workshops and crates: scripts, tooling, scratch, misc', re: /\b(workspace|scripts?|tool(s|ing)?|scratch|misc|utils?|helpers?|dev|cli)\b/ },
  { id: 'offices', desc: 'glass office towers: APIs, backend services, business logic, servers of the app', re: /\b(api|apis|backend|services?|endpoints?|server|core|domain|logic|graphql|rest|rpc)\b/ },
  { id: 'campus', desc: 'a research campus with an observatory and dishes: AI, ML, models, prompts, search, science', re: /\b(ai|ml|llm|agents?|prompts?|models?|training|inference|embeddings?|search|science|math|nlp|vision)\b/ },
  { id: 'port', desc: 'a harbour with cranes and containers: integrations, third-party APIs, messaging, queues, webhooks', re: /\b(integrations?|connectors?|webhooks?|queues?|messag\w*|events?|bus|kafka|bridges?|adapters?|plugins?|extensions?|third-party|vendors?)\b/ },
  { id: 'civic', desc: 'a domed city hall with flags: admin, dashboards, settings, config, internal tools', re: /\b(admin\w*|dashboards?|settings|config\w*|console|backoffice|management|cms|control|governance)\b/ },
  { id: 'homes', desc: 'houses with gabled roofs and gardens: users, profiles, accounts, community, chat', re: /\b(users?|profiles?|accounts?|community|members?|social|chat|people|customers?|teams?|onboarding)\b/ },
];
const STYLE_IDS = new Set(STYLES.map(s => s.id));
const ROLE_STYLE = { storefront: 'shops', database: 'vault', security: 'fortress', payments: 'bank', pipeline: 'factory', infra: 'power', qa: 'lab',
  marketing: 'media', brand: 'gallery', docs: 'library', workspace: 'workshop', api: 'offices' };
const GENERIC = ['offices', 'workshop', 'homes', 'civic', 'campus', 'port'];
export function styleOf(d) {
  if (ROLE_STYLE[d.id]) return ROLE_STYLE[d.id];
  if (STYLE_IDS.has(d.style)) return d.style;
  const s = `${d.id.replace(/-/g, ' ')} ${d.name || ''} ${d.desc || ''}`.toLowerCase();
  // the name decides before the description does
  for (const text of [`${d.id.replace(/-/g, ' ')} ${d.name || ''}`.toLowerCase(), s]) { const hit = STYLES.find(x => x.re.test(text)); if (hit) return hit.id; }
  let h = 0; for (const ch of d.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GENERIC[h % GENERIC.length];
}

// first match wins, so the specific roles come before the broad ones
const RULES = [
  ['qa', /^(tests?|__tests__|spec|specs|qa|e2e|fixtures?|smoke)$/],
  ['security', /^(auth|authn|authz|login|logout|logins?|passwords?|session|sessions|csrf|xsrf|ratelimit|rate|limit|limiter|waf|firewall|bots?|captcha|jwt|oauth|acl|permissions?|roles|secrets?|vault|crypto|sanitizer?|sanitize|htaccess|guard|security|2fa|totp|otp|consent|gdpr|signin|signup|identity)$/],
  ['database', /^(db|database|sql|migrations?|schema|schemas|prisma|drizzle|orm|models?|queries|query|seeds?|knex|sequelize|postgres|pg|mysql|sqlite|redis|ledger)$/],
  ['payments', /^(stripe|payments?|pay|checkout|cart|basket|orders?|invoices?|refunds?|billing|fx|currency|money|tax|vat|shipping|parcel|freight)$/],
  ['infra', /^(infra|nginx|docker|dockerfile|compose|deploy|deploys|release|releases|backup|backups|dns|cloudflare|server|servers|k8s|terraform|ansible|ci|github|workflows|cron|systemd|pm2)$/],
  ['marketing', /^(seo|analytics|posthog|gtag|pixel|ads|adwords|marketing|newsletter|campaigns?|jsonld|sitemap|indexnow|gsc|feeds?|tracking|attribution)$/],
  ['storefront', /^(components?|pages?|app|ui|views?|layouts?|styles?|css|public|static|frontend|web|storefront|theme|themes|templates?|tokens)$/],
  ['pipeline', /^(pipeline|pipelines|crawl|crawler|crawlers|scrape|scraper|scrapers|fetch|fetchers?|import|imports|etl|ingest|sync|matching|match|jobs?|workers?|backfill)$/],
  ['brand', /^(logos?|brand|branding|icons?|images?|img|media|assets|fonts?)$/],
  ['docs', /^(docs?|documentation|history|notes|guides?|readme|changelog)$/],
];
const EXT_ROLE = [
  ['database', /\.(sql|prisma|sqlite|db)$/i],
  ['qa', /\.(test|spec)\.[a-z]+$/i],
  ['brand', /\.(png|jpe?g|webp|gif|svg|ico|avif|ttf|otf|woff2?|mp4|mov|psd|ai)$/i],
  ['docs', /\.(md|mdx|txt|rst)$/i],
  ['infra', /\.(sh|conf|ya?ml|tf)$/i],
];

const STRONG = new Set(['security', 'database', 'payments', 'qa']);
const tokens = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function byTokens(toks) {
  for (const [role, re] of RULES) if (toks.some(t => re.test(t))) return role;
  return null;
}

// a file's role from its name alone (strong signals only), then its extension
export function nameRole(p) {
  const name = p.split('/').pop();
  return byTokens(tokens(name.replace(/\.[^.]+$/, ''))) || EXT_ROLE.find(([, re]) => re.test(name))?.[0] || null;
}
// a folder's role: its own name first, then up the path, then what most files say
export function folderRole(mk, files) {
  const seg = mk.replace(/\/\*$/, '').split('/').filter(Boolean);
  for (let i = seg.length - 1; i >= 0; i--) { const r = byTokens(tokens(seg[i])); if (r) return r; }
  const votes = new Map();
  for (const p of files) { const r = nameRole(p); if (r) votes.set(r, (votes.get(r) || 0) + 1); }
  const top = [...votes].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= files.length * 0.4 ? top[0] : 'workspace';
}
export function labelRole(label) { return byTokens(tokens(label)); }

// Resolver over the saved assignments, with the rules as fallback.
export function roleResolver(saved) {
  const list = saved?.districts?.length ? saved.districts : BASE_ROLES;
  const ids = new Set(list.map(d => d.id));
  const ok = r => r && ids.has(r) ? r : null;
  const mods = saved?.modules || {};
  const fallbackFolder = new Map();
  return {
    list,
    file(mk, p, files) {
      const m = mods[mk];
      if (m) {
        if (m.x && p in m.x) return ok(m.x[p]) || ok(m.d) || 'workspace';
        // a file the summarizer never saw: a strong name signal beats the folder default
        if (!m.seen || !m.seen.includes(p)) { const r = ok(nameRole(p)); if (STRONG.has(r)) return r; }
        return ok(m.d) || 'workspace';
      }
      if (!fallbackFolder.has(mk)) fallbackFolder.set(mk, folderRole(mk, files));
      const folder = fallbackFolder.get(mk);
      // only a strong name pulls a file out of its folder's district
      const r = nameRole(p);
      return ok(STRONG.has(r) ? r : folder) || 'workspace';
    },
    place(id, label) { return ok(saved?.places?.[id]) || ok(labelRole(label)); },
    known: mk => !!mods[mk],
  };
}
