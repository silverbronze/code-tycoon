// How hard the local machine is working: whole-system CPU and RAM, plus the
// Node and Claude processes. Sampled only while someone is looking.
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';

const NAMES = ['node', 'claude'];
const EVERY = 4000, IDLE = 60e3;

let child = null, timer = null, lastAsk = 0;
let state = { cpu: null, memUsed: 0, memTotal: os.totalmem(), cores: os.cpus().length, procs: null, at: 0 };
let prevCpu = cpuTimes(), prevProc = new Map(), prevAt = Date.now();

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  return { idle, total };
}

// rows: { pid, name, cpu (seconds used so far), mem (bytes) }
function onRows(rows) {
  const now = Date.now(), dt = (now - prevAt) / 1000;
  const t = cpuTimes(), dTotal = t.total - prevCpu.total;
  const procs = Object.fromEntries(NAMES.map(n => [n, { n: 0, mem: 0, cpu: 0 }]));
  const next = new Map();
  for (const r of rows) {
    const g = procs[r.name]; if (!g) continue;
    g.n++; g.mem += r.mem;
    const before = prevProc.get(r.pid);
    if (before != null && dt > 0) g.cpu += Math.max(0, r.cpu - before) / dt / state.cores * 100;
    next.set(r.pid, r.cpu);
  }
  state = { ...state, cpu: dTotal > 0 ? Math.round((1 - (t.idle - prevCpu.idle) / dTotal) * 100) : null,
    memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), procs, at: now };
  for (const g of Object.values(procs)) g.cpu = Math.round(g.cpu * 10) / 10;
  prevCpu = t; prevProc = next; prevAt = now;
}

function start() {
  if (process.platform === 'win32') {
    // one long-lived PowerShell instead of a new process every few seconds
    const ps = `$n=${NAMES.map(n => `'${n}'`).join(',')}; while($true){ $p = @(Get-Process -Name $n -ErrorAction SilentlyContinue | % { @{ pid=$_.Id; name=$_.ProcessName.ToLower(); cpu=[double]$_.CPU; mem=$_.WorkingSet64 } }); '@@' + (ConvertTo-Json -Compress -InputObject $p); Start-Sleep -Milliseconds ${EVERY} }`;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith('@@')) try { onRows(JSON.parse(line.slice(2) || '[]')); } catch {}
      }
    });
    child.on('exit', () => { child = null; });
  } else {
    const tick = () => execFile('ps', ['-A', '-o', 'pid=,rss=,time=,comm='], (err, out) => {
      if (err) return;
      onRows(out.split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length >= 4).map(([pid, rss, time, ...c]) => {
        const s = time.split(/[-:]/).map(Number).reverse();
        return { pid: Number(pid), mem: Number(rss) * 1024, cpu: (s[0] || 0) + (s[1] || 0) * 60 + (s[2] || 0) * 3600 + (s[3] || 0) * 86400,
          name: c.join(' ').split('/').pop().toLowerCase() };
      }));
    });
    tick(); timer = setInterval(tick, EVERY);
  }
  const idle = setInterval(() => {
    if (Date.now() - lastAsk < IDLE) return;
    clearInterval(idle); stop();
  }, IDLE / 4);
}

function stop() {
  child?.kill(); child = null;
  clearInterval(timer); timer = null;
  prevProc = new Map();
}

export function systemLoad() {
  lastAsk = Date.now();
  if (!child && !timer) start();
  return state;
}

process.on('exit', stop);

// --- what the numbers are made of (asked for on click, not polled) ----------
// rows: { pid, ppid, name, cmd, mem (working set), priv (committed), cpu (% of machine), born }
let snap = null, snapAt = 0, snapping = null;
export function forgetSnapshot() { snap = null; }
export function snapshot() {
  if (snap && Date.now() - snapAt < 3000) return Promise.resolve(snap);
  return snapping ||= new Promise(resolve => {
    const done = rows => { snapping = null; snap = rows; snapAt = Date.now(); resolve(rows); };
    if (process.platform === 'win32') {
      // CPU = process time used across one second, over all cores
      const q = `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,PrivatePageCount,CreationDate,KernelModeTime,UserModeTime`;
      const ps = `$a=@{}; ${q} | % { $a[$_.ProcessId]=$_.KernelModeTime+$_.UserModeTime }; Start-Sleep -Milliseconds 1000; ` +
        `$r=@(${q} | % { $t=$_.KernelModeTime+$_.UserModeTime; $b=$a[$_.ProcessId]; @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; mem=$_.WorkingSetSize; priv=$_.PrivatePageCount; ` +
        `d=$(if($b -ne $null){$t-$b}else{0}); born=$(if($_.CreationDate){[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}else{0}) } }); ConvertTo-Json -Compress -Depth 2 -InputObject $r`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 64 << 20 }, (err, out) => {
        let rows = [];
        try { rows = JSON.parse(out); } catch {}
        const cores = os.cpus().length;
        done(rows.map(r => ({ pid: r.pid, ppid: r.ppid, name: String(r.name || '').replace(/\.exe$/i, '').toLowerCase(), cmd: r.cmd || '',
          mem: Number(r.mem) || 0, priv: Number(r.priv) || 0, cpu: Math.round(Number(r.d) / 1e7 / cores * 1000) / 10, born: r.born || 0 })));
      });
    } else {
      // etime ([[dd-]hh:]mm:ss), not etimes: macOS ps has no etimes and fails on it
      execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,pcpu=,etime=,args='], { maxBuffer: 64 << 20 }, (err, out) => {
        const now = Date.now(), cores = os.cpus().length;
        done(err ? [] : out.split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length >= 6).map(([pid, ppid, rss, pcpu, et, ...a]) => ({
          pid: Number(pid), ppid: Number(ppid), name: a[0].split('/').pop().toLowerCase(), cmd: a.join(' '),
          mem: Number(rss) * 1024, priv: Number(rss) * 1024, cpu: Math.round(Number(pcpu) / cores * 10) / 10, born: now - elapsed(et) * 1000 })));
      });
    }
  });
}

function elapsed(et) {
  const [d, rest] = et.includes('-') ? et.split('-') : [0, et];
  const s = rest.split(':').map(Number).reverse();
  return Number(d) * 86400 + (s[0] || 0) + (s[1] || 0) * 60 + (s[2] || 0) * 3600;
}

// "node.exe" says nothing; name a process by what it runs
const parts = p => p.replace(/["']/g, '').split(/[\\/]+/).filter(Boolean);
function scriptOf(cmd) { return cmd.match(/(?:"([^"]+\.[cm]?[jt]s)"|(\S+\.[cm]?[jt]s))(?=\s|"|$)/)?.slice(1).find(Boolean) || null; }
export function nodeLabel(r, by) {
  if (r.pid === process.pid) return 'Code Tycoon (this app)';
  const c = r.cmd;
  let m = c.match(/npx-cli\.js"?\s+(?:"?--package=([^"\s]+)|(?:"?-y"?\s+)?"?([^"\s-][^"\s]*))/);
  if (m) return 'npx launcher · ' + (m[1] || m[2]).replace(/@latest$/, '');
  const s = scriptOf(c);
  if (!s) return 'node ' + c.split(/\s+/).slice(1, 3).join(' ');
  const ps = parts(s), file = ps.at(-1);
  const nm = ps.lastIndexOf('node_modules');
  if (nm >= 0) {
    const rest = ps.slice(nm + 1).filter(p => p !== '.bin' && p !== '..');
    return (rest[0]?.startsWith('@') ? rest[0] + '/' + rest[1] : rest[0]) + ' · ' + file;
  }
  const pf = ps.findIndex(p => /^program files/i.test(p));
  if (pf >= 0 && ps[pf + 1] && !/^nodejs$/i.test(ps[pf + 1])) return ps[pf + 1];
  if (/^[a-z]:$/i.test(ps[0]) || s.startsWith('/')) return ps.slice(-2).join('/');
  // relative script: the folder comes from whatever launched it (e.g. a run.cmd)
  const parent = by.get(r.ppid);
  const launcher = parent?.cmd.match(/([A-Za-z]:[\\/][^"]+?)[\\/][^\\/"]+\.(?:cmd|bat|ps1|sh)/i)?.[1];
  return (launcher ? parts(launcher).at(-1) + ' · ' : '') + ps.join('/');
}
function claudeLabel(r, by) {
  const ver = r.cmd.match(/anthropic\.claude-code-([\d.]+)/)?.[1];
  if (ver) return `Claude Code ${ver}` + (by.get(r.ppid)?.name === 'code' ? ' · VS Code' : '');
  if (/WindowsApps[\\/]Claude_|Claude[\\/]app/i.test(r.cmd)) return 'Claude desktop app';
  return 'claude ' + (parts(r.cmd.split(/\s+/)[0] || '').at(-1) || '');
}
// the Claude Code session (CLI process) a process was started by, if any
function ownerOf(r, by) {
  for (let p = by.get(r.ppid), i = 0; p && i < 6; p = by.get(p.ppid), i++) if (p.name === 'claude' && /native-binary|claude-code/.test(p.cmd)) return p.pid;
  return null;
}

function groupBy(rows, label) {
  const g = new Map();
  for (const r of rows) {
    const k = label(r);
    let e = g.get(k);
    if (!e) g.set(k, e = { label: k, n: 0, mem: 0, priv: 0, cpu: 0, owners: new Set(), items: [] });
    e.n++; e.mem += r.mem; e.priv += r.priv; e.cpu += r.cpu;
    if (r.owner) e.owners.add(r.owner);
    e.items.push({ pid: r.pid, mem: r.mem, priv: r.priv, cpu: r.cpu, born: r.born, owner: r.owner, kids: r.kids });
  }
  return [...g.values()].map(e => ({ ...e, cpu: Math.round(e.cpu * 10) / 10, owners: e.owners.size,
    items: e.items.sort((a, b) => a.born - b.born).slice(0, 80) }));
}

export async function processBreakdown(kind) {
  const rows = await snapshot();
  const by = new Map(rows.map(r => [r.pid, r]));
  const sum = (xs, k) => xs.reduce((a, r) => a + r[k], 0);
  if (kind === 'node' || kind === 'claude') {
    const mine = rows.filter(r => r.name === kind);
    for (const r of mine) {
      r.owner = ownerOf(r, by);
      // what each Claude Code session keeps running under it (MCP servers, shells, dev servers)
      if (kind === 'claude') r.kids = rows.filter(x => x.pid !== r.pid && ownerOf(x, by) === r.pid).length;
    }
    const groups = groupBy(mine, r => kind === 'node' ? nodeLabel(r, by) : claudeLabel(r, by));
    return { kind, n: mine.length, mem: sum(mine, 'mem'), priv: sum(mine, 'priv'), cpu: Math.round(sum(mine, 'cpu') * 10) / 10,
      groups: groups.sort((a, b) => b.n - a.n || b.priv - a.priv) };
  }
  // cpu / ram: the heaviest programs on the machine, all copies of one program together
  const groups = groupBy(rows.filter(r => r.pid !== 0 && r.name !== 'system idle process'), r => r.name)
    .sort((a, b) => kind === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem).slice(0, 12);
  return { kind, n: rows.length, mem: sum(rows, 'mem'), priv: sum(rows, 'priv'), cpu: Math.round(sum(rows.filter(r => r.pid !== 0), 'cpu') * 10) / 10,
    groups: groups.map(g => ({ ...g, items: [] })), memTotal: os.totalmem(), memUsed: os.totalmem() - os.freemem() };
}
