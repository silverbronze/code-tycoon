export interface Project {
  id: string; root: string; name: string; tracked: number; sessions: number; prompts: number;
  first_ts: number | null; last_ts: number | null; bytes: number; indexed_bytes: number;
  open: number; needs: number; indexing: { done: number; total: number } | null; cost14: number | null;
}
// A core property of a block or district for the role it plays (Database: engine,
// tables...; Payments: providers, currencies...). n: files showing a value, f: some of them.
export interface Prop { k: string; v: { t: string; n: number; f: string[] }[]; total?: number; unit?: string; basic?: boolean }
export interface District { id: string; name: string; desc: string | null; hue: number; x: number; z: number; w: number; h: number; born: number; members: [number, number][]; kind: string | null; style?: string; props: Prop[] }
export interface Module {
  id: string; key: string; district: number; x: number; z: number; w: number; h: number; cols: number; rows: number;
  warehouse: boolean; label: string; files: number; onDisk: string | null; desc: string | null; title: string | null; born: number;
  kind: string | null; props: Prop[];
}
export interface FileB {
  p: string; m: number; lot: number; x: number; z: number; kind: string; size: number;
  born: number | null; churn: number; w: number; r: number; last: number | null;
}
export interface External {
  id: string; label: string; type: 'host' | 'service' | 'web' | 'local'; n: number; x: number; z: number; w: number; h: number;
  district: number; born: number; first?: number; last?: number; refs: string[]; refCount: number; top: [string, number][] | null;
}
// A tie between two places ([tt, ti]: 1 module/store, 3 outside system): imports,
// files changed in the same task or commit, and code that names a system.
export interface Link { a: [number, number]; b: [number, number]; w: number; born: number; road: boolean; imp: number; task: number; commit: number; ref: number }
export interface City {
  project: { id: string; name: string; root: string; isGit: boolean; depth: number; w: number; h: number; t0: number };
  districts: District[]; modules: Module[]; files: FileB[]; externals: External[];
  links: Link[]; fileEdges: [number, number][];
  commits: { h: string; ts: number; s: string; n: number }[];
}
export interface SessionT { id: string; title: string; first: number; last: number; prompts: number; branch: string | null; entry: string | null; model: string | null; cost?: number }
export interface AgentT { id: string; s: number; desc: string | null; type: string | null; first: number; last: number }
export interface TaskT { id: string; s: string; ts: number; end: number; title: string | null; prompt: string; n: number[]; cost?: number }
export interface Timeline {
  kinds: string[]; sessions: SessionT[]; agents: AgentT[]; tasks: TaskT[];
  events: { ts: number[]; s: number[]; a: number[]; k: number[]; tt: number[]; ti: number[]; task: number[] };
  since: number; older: number;
}
export interface OlderEvents { ids: { s: string[]; a: string[]; task: string[] }; events: Timeline['events'] }
export interface LiveSession {
  id: string; pid: string; title: string | null; state: 'working' | 'needs-you' | 'waiting' | 'idle' | 'ended';
  since: number; lastSeen: number; prompt: string | null; hooks: boolean;
  action: { kind: string; tool: string; path: string | null; target: string | null; detail: string | null; agentId: string | null } | null;
  needs: { type: string; msg: string } | null; agents: { id: string; type?: string | null; ts: number }[];
  health?: SessionHealth | null;
}
// How the current task of a session is going (server/analytics.mjs)
export interface CheckRun { ok: boolean; ts: number; res: string | null; fails: number; runs: number }
export interface SessionHealth {
  task: string; since: number; checks: Partial<Record<'test' | 'build' | 'types' | 'lint', CheckRun>>; last: string | null;
  loop: { path: string; n: number; mins: number } | null; cost: number; median: number; ratio: number;
}
export interface LiveEvent { ts: number; s: string; a: string | null; k: number; tt: number; ti: number; task: string | null; tuid: string | null; d: string | null; tool: string | null; via: string }
export interface Alert { id: number; kind: 'collision' | 'overlap' | 'needs-you' | 'loop' | 'failing' | 'cost' | 'red-stop' | 'cold-resume' | 'context-big' | 'topic-switch' | 'compacted'; pid: string; sessions: string[]; text: string; ts: number; path?: string | null; module?: string | null; resolved?: boolean }
// Coaching on context and cache use (server/coach.mjs). Money is API-equivalent.
export type CoachKind = 'cold-resume' | 'big-context' | 'topic-switch' | 'compacted' | 'model-switch' | 'cache-reset' | 'model-fit' | 'big-results' | 'heavy-start';
export interface CoachFinding { kind: CoachKind; ts: number; text: string; fix: string; lost: number; save: number; task?: string; tasks?: string[] }
export interface CoachSession {
  id: string; pid: string; project: string | null; title: string; first: number; last: number; model: string; cost: number; agentCost: number; agents: number;
  calls: number; tasks: number; per10k: number; hit: number; base: number; peak: number; ttl: number; compactions: number;
  findings: CoachFinding[]; lost: number; save: number;
  curve?: [number, number][]; marks?: { ts: number; kind: string; pre?: number; post?: number }[];
}
export interface CoachHabit { kind: CoachKind; label: string; habit: string; steps?: string[]; n: number; sessions: number; lost: number; save: number }
export interface CoachRoll {
  sessions: number; cost: number; calls: number; hit: number; save: number; lost: number; compactions: number; coldResumes: number; coldLost: number;
  fitSave: number; bigShare: number; base: number; per10k: number; peak: number; habits: CoachHabit[];
}
export interface Coach { days: number; pid: string | null; since: number; totals: CoachRoll; projects: (CoachRoll & { id: string; name: string })[]; sessions: CoachSession[]; at: number }
export interface OpenSession extends LiveSession { project: string | null; tracked: boolean }
export interface ProcGroup { n: number; mem: number; cpu: number }
export interface PulseT {
  open: number; needs: number; tracked: number; summarizer: { enabled: boolean; running: boolean; total: number; done: number };
  system: { cpu: number | null; cores: number; memUsed: number; memTotal: number; procs: { node: ProcGroup; claude: ProcGroup } | null; at: number };
  idle: { n: number; mem: number; at: number } | null;
}
// a Claude Code process (and everything it started) nobody has used for hours
export interface IdleProc {
  pid: number; kind: 'session' | 'orphan'; reason: 'idle' | 'ended' | 'unseen' | 'orphan';
  session: { id: string; title: string | null; project: string | null } | null; label?: string; ver?: string | null;
  born: number; seen: number; mem: number; priv: number; helpers: number; helperNames: string[];
}
export interface IdleScan { at: number; n: number; mem: number; items: IdleProc[] }
export interface StopResult { stopped: number[]; failed: number[]; skipped: number[]; freed: number; idle: IdleScan }
export interface ProcGroupD {
  label: string; n: number; mem: number; priv: number; cpu: number; owners: number;
  items: { pid: number; mem: number; priv: number; cpu: number; born: number; owner: number | null; kids?: number }[];
}
export interface ProcBreakdown { kind: 'node' | 'claude' | 'cpu' | 'ram'; n: number; mem: number; priv: number; cpu: number; groups: ProcGroupD[]; memTotal?: number; memUsed?: number; idle?: IdleScan }
export type PulseDetail = ProcBreakdown
  | { kind: 'sessions' | 'needs'; sessions: OpenSession[] }
  | { kind: 'tracked'; projects: { id: string; name: string; root: string; sessions: number; prompts: number; last_ts: number | null; open: number }[] };
export interface Changes { isGit: boolean; files: { p: string; st: string; writers: { s: string; ts: number; n: number }[] }[] }
// City health (server/health.mjs): factors with no data this week have score null
export interface HealthFactor { key: string; label: string; weight: number; score: number | null; value: string }
export interface Milestone { key: string; label: string; got: boolean; progress: number; have: number; need: number }
export interface Health {
  score: number | null; grade: string | null; factors: HealthFactor[]; tip: string | null; commits: number;
  streak: { current: number; best: number; today: boolean }; history: { day: string; score: number }[]; milestones: Milestone[]; at: number;
  look: CityLook; cosmetics: Cosmetic[];
}
// What the city looks like for its health; paths are relative to the project root
export interface CityLook { smog: number; light: number; rundown: string[]; litter: string[]; cones: string[] }
export interface Cosmetic { key: string; label: string; unlock: string; unlocked: boolean; on: boolean }
export interface ReviewFile {
  p: string; st: string; ti: number | null; district: string | null; add: number; del: number; score: number; level: 'high' | 'medium' | 'low';
  reasons: { t: string; k: string }[]; sessions: string[]; lastWrite: number | null; task: { id: string; title: string } | null; age: number | null;
}
export interface Review { isGit: boolean; files: ReviewFile[]; high?: number; medium?: number }
export interface WeekStats {
  tasks: number; writing: number; landed: number; abandoned: number; cost: number; perLanded: number | null; rework: number | null;
  waited: number; waitMedian: number; blind: number | null; checks: number; checkPass: number | null;
}
export interface Insights {
  at: number; week: WeekStats; prev: WeekStats;
  files: { churn: number; growth: number; tested: number | null }[];
  hot: { i: number; p: string; tasks: number }[]; growing: { i: number; p: string; g: number; size: number }[];
  untested: number; tested: number; suggestions: { text: string; n: number; rule: boolean }[];
  prompts: {
    good: PromptEx[]; bad: (PromptEx & { why: string })[];
    stats: { goodWords: number; badWords: number; goodNames: number; badNames: number; goodN: number; badN: number };
  } | null;
  deps: { weeks: { week: number; added: DepChange[]; removed: DepChange[] }[] };
}
export interface PromptEx { id: string; prompt: string; cost: number; words: number; names: boolean }
export interface DepChange { name: string; file: string; ts: number; commit: string; task?: { id: string; title: string } | null }
// per task (30 days): d districts written, u wrote code untested within the task, r files reworked by another task, f files
export type TaskFlags = Record<string, { d: number; u: number; r: number; f: number }>;
export interface FileHist { p: string; lines: number; weeks: { week: number; lines: number; commits: number; writes: number }[] }
export interface Weekly { week: Pick<WeekStats, 'perLanded' | 'landed' | 'writing' | 'rework' | 'waitMedian'>; prev: Weekly['week'] }
export interface CommitD { h: string; ts: number; s: string; files: string[]; committers: string[]; tasks: { id: string; s: string; ts: number; title: string | null; prompt: string; files: number }[] }
export interface Tie { a: [number, number]; b: [number, number]; an: string; bn: string; why: string; born: number }
export interface Digest {
  from: number; to: number; sessions: string[]; cost: number; outTokens: number; summary: string | null; summarizing?: boolean;
  tasks: { id: string; s: string; ts: number; title: string | null; prompt: string; w: number }[];
  modules: { i: number; name: string; n: number }[]; shared: { i: number; p: string; sessions: string[] }[];
  commits: { h: string; ts: number; s: string; n: number }[]; ties: Tie[]; tiesWeek: Tie[];
}
// An optimization run on a block (key m:<module key>) or district (d:<id>), server/optimize.mjs
export interface OptItem { id: string; title: string; gain: string; impact: 'high' | 'medium' | 'low'; risk: 'high' | 'medium' | 'low'; files: string[]; why: string; change: string }
export interface OptJob {
  id: string; key: string; label: string; kind: string; model: string | null; state: 'surveying' | 'planned' | 'applying' | 'applied' | 'undone' | 'error';
  started: number; ended?: number; files: number; read: number; cost: number; error?: string;
  plan: { summary: string; items: OptItem[] } | null; picked?: string[];
  result?: { done: { id: string; note: string }[]; skipped: { id: string; why: string }[]; note: string | null } | null;
  changed?: string[]; created?: string[]; kept?: string[]; undo: boolean;
}

// The domain map (server/domain.mjs): what the project is about, tied to the code and the real world
export type EStatus = 'solid' | 'shaky' | 'partial' | 'missing' | 'unknown';
export interface DEntity {
  id: string; name: string; group: string; what: string; real: string; world: string[]; states: string[]; facts: string[];
  code: { p: string; does: 'defines' | 'stores' | 'changes' | 'shows' | 'uses'; note: string }[]; status: EStatus; statusWhy: string;
}
// start, end, step files and risks are missing on maps built before they were asked for
export interface DFlow {
  id: string; name: string; why: string; start?: { world: string | null; by: string }; end?: { world: string | null; outcome: string };
  steps: { e: string; do: string; files?: string[]; risk?: string }[]; files: string[]; status: 'works' | 'partial' | 'broken' | 'unknown'; note: string;
}
export interface DAssumption {
  id: string; text: string; holds: boolean; was: string; now: string; entities: string[]; files: string[];
  evidence: string; cost: string; fix: string; severity: 'high' | 'medium' | 'low';
}
export interface DomainModel {
  summary: string; groups: { id: string; name: string; what: string }[];
  world: { id: string; name: string; kind: 'person' | 'system' | 'device' | 'place' | 'thing' | 'money'; what: string }[];
  entities: DEntity[]; relations: { a: string; b: string; verb: string; card: string }[]; flows: DFlow[]; assumptions: DAssumption[];
}
export interface DriftFile { p: string; score: number; markers: { line: number; text: string }[]; markerCount: number; pinned: { line: number; text: string }[]; lines: number; rework: number; age: number; twin: boolean; churn: number }
export interface DomainJob { id: string; kind: 'build' | 'update'; auto?: boolean; why?: string | null; head?: string | null; state: 'working' | 'done' | 'error'; started: number; ended?: number; model: string | null; cost: number; error?: string }
export interface BriefResult {
  goal: string; entities: string[]; flows: string[]; newEntities: { name: string; what: string }[]; done: string[]; missing: string[];
  files: { p: string; why: string; act: 'edit' | 'read' | 'new' }[]; respect: { a: string | null; text: string }[];
  drift: { a: string | null; text: string; how: string; why: string }[]; steps: string[]; questions: string[]; prompt: string;
}
export interface Brief { id: string; task: string; state: 'working' | 'done' | 'error'; started: number; ended?: number; model: string | null; cost: number; error?: string; result: BriefResult | null }
export interface DomainState {
  model: DomainModel | null; job: DomainJob | null; briefs: Brief[]; drift: DriftFile[]; llm: string | null;
  meta: { builtAt: number; head: string | null; cost: number; model: string | null; kind: string; changed: string[]; changedCount: number;
    // auto: updates itself on commits that change the domain; git: the map follows commits; behind: commits since the map;
    // waiting: HEAD moved but its diff changes no entity, so the map waits for a commit that does
    auto: boolean; git?: boolean; behind?: number; waiting?: boolean; updateMode?: 'full' | 'patch'; lastCost?: number } | null;
}

// hooks: live updates from Claude Code; autostart: null where the platform has none
export interface Setup { hooks: boolean; autostart: boolean | null }

const enc = encodeURIComponent;
const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${url}`), { status: r.status, body: await r.json().catch(() => null) });
  return r.json();
}
export const api = {
  projects: (all = false) => get<{ projects: Project[]; sessions: OpenSession[]; summarizer: { enabled: boolean; running: boolean; total: number; done: number } }>(`/api/projects${all ? '?all=1' : ''}`),
  pulse: () => get<PulseT>('/api/pulse'),
  pulseDetail: (k: string) => get<PulseDetail>(`/api/pulse/${enc(k)}`),
  stopProcs: async (pids: number[]) => { const r = await post('/api/procs/stop', { pids }); if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<StopResult>; },
  setup: () => get<Setup>('/api/setup'),
  setSetup: async (change: Partial<Record<'hooks' | 'autostart', boolean>>) => {
    const r = await post('/api/setup', change), d = await r.json();
    if (!r.ok) throw new Error(d.error || String(r.status));
    return d as Setup;
  },
  track: (id: string) => post(`/api/projects/${enc(id)}/track`),
  untrack: (id: string) => post(`/api/projects/${enc(id)}/untrack`),
  coach: (days: number, pid?: string | null) => get<Coach>(`/api/coach?days=${days}${pid ? '&pid=' + enc(pid) : ''}`),
  coachSession: (sid: string) => get<CoachSession>(`/api/coach/session/${enc(sid)}`),
  alerts: (pid?: string) => get<{ alerts: Alert[] }>(`/api/alerts${pid ? '?pid=' + enc(pid) : ''}`),
  dismiss: (ids: number[] | null, pid?: string) => post('/api/alerts/dismiss', { ids, pid: pid ?? null }),
  changes: (id: string) => get<Changes>(`/api/projects/${enc(id)}/changes`),
  health: (id: string) => get<Health>(`/api/projects/${enc(id)}/health`),
  cosmetic: (id: string, key: string, on: boolean) => post(`/api/projects/${enc(id)}/cosmetics`, { key, on }),
  review: (id: string) => get<Review>(`/api/projects/${enc(id)}/review`),
  insights: (id: string) => get<Insights>(`/api/projects/${enc(id)}/insights`),
  taskFlags: (id: string) => get<TaskFlags>(`/api/projects/${enc(id)}/taskflags`),
  weekly: (id: string) => get<Weekly>(`/api/projects/${enc(id)}/week`),
  fileHist: (id: string, p: string) => get<FileHist>(`/api/projects/${enc(id)}/filehist?p=${enc(p)}`),
  commit: (id: string, h: string) => get<CommitD>(`/api/projects/${enc(id)}/commit/${enc(h)}`),
  digest: (id: string, from: number, to: number, summarize = false) => get<Digest>(`/api/projects/${enc(id)}/digest?from=${from}&to=${to}${summarize ? '&summarize=1' : ''}`),
  older: (id: string, before: number) => get<OlderEvents>(`/api/projects/${enc(id)}/timeline?before=${before}`),
  city: (id: string, fresh = false) => get<City>(`/api/projects/${enc(id)}/city${fresh ? '?fresh=1' : ''}`),
  timeline: (id: string, since = 0) => get<Timeline>(`/api/projects/${enc(id)}/timeline${since ? '?since=' + since : ''}`),
  live: (id: string) => get<{ sessions: LiveSession[] }>(`/api/projects/${enc(id)}/live`),
  task: (id: string, task: string) => get<TaskT & { tokens: { in: number; out: number }; events: { ts: number; kind: string; tool: string; path: string | null; target: string | null; detail: string | null; agent_id: string | null; inferred: number }[] }>(`/api/projects/${enc(id)}/task/${enc(task)}`),
  optimize: (id: string, key: string) => get<{ model: string | null; job: OptJob | null }>(`/api/projects/${enc(id)}/optimize?key=${enc(key)}`),
  optimizeStep: async (id: string, step: 'survey' | 'apply' | 'stop' | 'undo', key: string, extra: { items?: string[]; force?: boolean } = {}) => {
    const r = await post(`/api/projects/${enc(id)}/optimize/${step}`, { key, ...extra });
    return { status: r.status, ...(await r.json()) } as { status: number; job?: OptJob; error?: string; busy?: { id: string; title: string | null }[]; restored?: string[]; kept?: string[] };
  },
  domain: (id: string) => get<DomainState>(`/api/projects/${enc(id)}/domain`),
  domainStep: async (id: string, step: 'build' | 'update' | 'stop' | 'auto', body: { on?: boolean } = {}) => {
    const r = await post(`/api/projects/${enc(id)}/domain/${step}`, body);
    return { status: r.status, ...(await r.json()) } as { status: number; job?: DomainJob; error?: string };
  },
  brief: async (id: string, task: string) => {
    const r = await post(`/api/projects/${enc(id)}/brief`, { task });
    return { status: r.status, ...(await r.json()) } as { status: number; brief?: Brief; error?: string };
  },
  dropBrief: (id: string, bid: string) => post(`/api/projects/${enc(id)}/brief/drop`, { id: bid }),
  file: (id: string, p: string) => get<{ path: string; tasks: { id: string; s: string; ts: number; kinds: string; title: string | null; prompt: string }[] }>(`/api/projects/${enc(id)}/file?p=${enc(p)}`),
};

type Handler = (msg: any) => void;
export class Live {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private pid: string | null = null;
  private retry = 500;
  constructor() { this.connect(); }
  private connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 500; this.subscribe(this.pid); this.handlers.forEach(h => h({ type: 'connected' })); };
    ws.onmessage = e => { const m = JSON.parse(e.data); this.handlers.forEach(h => h(m)); };
    ws.onclose = () => { this.handlers.forEach(h => h({ type: 'disconnected' })); setTimeout(() => this.connect(), this.retry = Math.min(this.retry * 2, 8000)); };
  }
  subscribe(pid: string | null) { this.pid = pid; if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'subscribe', pid })); }
  on(h: Handler) { this.handlers.push(h); return () => { this.handlers = this.handlers.filter(x => x !== h); }; }
}
export const live = new Live();
