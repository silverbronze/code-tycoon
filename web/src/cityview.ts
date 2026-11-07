import * as THREE from 'three';
import { api, live, type Prop, type City, type Timeline, type LiveSession, type LiveEvent, type Alert, type TaskT, type Changes, type Digest, type Tie, type Health, type Review, type Insights, type WeekStats, type OptJob } from './api';
import { Mood } from './city/mood';
import type { TaskFlags, FileHist } from './api';
import { Sky } from './city/sky';
import { ENV } from './city/env';
import { Stage } from './city/scene';
import { World, linkColor } from './city/world';
import { Actors, colorCss } from './city/actors';
import { TimelineView, KIND_COLORS } from './ui/timeline';
import { Schematic } from './schematic';
import { DomainMap } from './domain';
import { applyLayout, hasLayout, resetLayout } from './city/layout';
import { Pulse } from './pulse';
import { HealthChip } from './health';
import { h, put, ago, dur, clock, shortTime, bytes, tail, money } from './util';

const SPEEDS = [1, 10, 60, 300, 1800, 7200];
const ACTIVE_WINDOW = 15 * 60e3;   // replay: a session with no event for this long goes home
const WARM_TAU = 20 * 60e3;
const DAY = 86400e3;
const FIRST_LOAD = 14 * DAY;       // events older than this load after the city is up
const VERB: Record<string, string> = { write: 'Editing', read: 'Reading', search: 'Searching', touch: 'Touching', cmd: 'Running', remote: 'Calling', skill: 'Using skill', spawn: 'Spawning agent', ask: 'Asking you', prompt: 'Prompted', other: 'Using' };
// Distinct colours go to the sessions that matter now (open, or inside the timeline
// view); everything else is a muted tint, so 200 sessions never share 12 hues.
const PALETTE = ['#4fd8ff', '#ffb547', '#b18cff', '#5dff9e', '#ff6f91', '#ffe066', '#6f8bff', '#ff8f4f', '#3ff0c8', '#e57bff', '#a4ff4f', '#ff5f5f'].map(c => new THREE.Color(c));
const MULTI = new THREE.Color('#ff4d6a'), NOBODY = new THREE.Color('#8a93a8');
const TESTED = new THREE.Color('#3fbf7a'), UNTESTED = new THREE.Color('#e0503f');
const STATE_ORDER: [string, string][] = [['needs-you', 'Needs you'], ['working', 'Working'], ['waiting', 'Your turn'], ['idle', 'Idle']];
const COLOR_MODES: [string, string][] = [['district', 'Colour: district'], ['recent', 'Colour: recent edits'], ['churn', 'Colour: churn'], ['rework', 'Colour: rework (30d)'],
  ['growth', 'Colour: growth (30d)'], ['tested', 'Colour: tested'], ['session', 'Colour: last session']];
type ColorMode = 'district' | 'recent' | 'churn' | 'rework' | 'growth' | 'tested' | 'session';
type Layer = 'domain' | 'city' | 'schematic';
const LAYERS: Layer[] = ['domain', 'city', 'schematic'];
const LAYER_NAME: Record<Layer, string> = { domain: 'Domain', city: 'City', schematic: 'Schematic' };
type Tab = 'log' | 'inspect' | 'digest' | 'review' | 'insights';
const CHECK_NAME: Record<string, string> = { test: 'Tests', build: 'Build', types: 'Types', lint: 'Lint' };

export class CityView {
  root: HTMLDivElement;
  stage!: Stage; world!: World; actors!: Actors; tl!: TimelineView; schem!: Schematic; domain!: DomainMap;
  layer: Layer = 'city';
  city!: City; data!: Timeline;
  colors: THREE.Color[] = []; colorStr: string[] = [];
  sIndex = new Map<string, number>(); taskIndex = new Map<string, number>(); agentIndex = new Map<string, number>();
  fileIndex = new Map<string, number>();   // lowercased path -> file
  mode: 'live' | 'replay' = 'live';
  t = Date.now(); playing = false; speed = 60; cursor = 0;
  lastSim = new Map<string, number>();   // session idx -> last event ts (replay)
  lastPlace = new Map<string, [number, number]>();
  prevPlace = new Map<string, [number, number] | null>(); // session -> place of its last action, for road traffic
  liveSessions = new Map<string, LiveSession>();
  selected: { tt: number; ti: number } | null = null;
  focusSession: string | null = null;
  logQuery = '';
  changes: Changes | null = null;
  showChanges = false;
  colorMode: ColorMode = 'district';
  alerts: Alert[] = [];
  digestDay = startOfDay(Date.now());
  digestData: Digest | null = null;
  tiesShown: 'day' | 'week' | null = null;
  private slots = new Map<string, number>();
  private hoverSid: string | null = null;
  private pendingFollow: string | null;
  private offLive: (() => void) | null = null;
  private els: Record<string, HTMLElement> = {};
  private pulse = new Pulse('strip');
  private health: HealthChip | null = null;
  private healthData: Health | null = null;
  private mood: Mood | null = null;
  private sky: Sky | null = null;
  private lastCommitT = 0;          // replay: commits up to here have pulled in a train
  private testSeen = new Map<string, number>(); // session -> ts of the last test run shown
  private testState = new Map<string, { ok: boolean; ts: number }>();
  private spent = new Map<string, number>(); private spentBase = -1; private tankers = 0;
  review: Review | null = null;
  insightsData: Insights | null = null;
  private curTab: Tab = 'log';
  private insightsWanted = false;
  private toastEls = new Map<number, HTMLElement>();
  private timers: number[] = [];
  private fxBudget = 0;
  private uiTick = 0;
  private gapNote = 0;
  private warped = 0;   // simulated time fast-forwarded in the current quiet stretch
  private disposed = false;

  constructor(parent: HTMLElement, public pid: string, follow: string | null = null) {
    this.root = h('div', { class: 'cityview' });
    parent.appendChild(this.root);
    this.pendingFollow = follow;
    this.load();
  }

  focusWhenReady(sid: string) { if (this.tl) this.focusOn(sid); else this.pendingFollow = sid; }

  private async load() {
    this.root.appendChild(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Building the city…'));
    let city: City, data: Timeline, liveRes: { sessions: LiveSession[] };
    try {
      [city, data, liveRes] = await Promise.all([api.city(this.pid), api.timeline(this.pid, Date.now() - FIRST_LOAD), api.live(this.pid)]);
    } catch (e: any) {
      if (e.status === 409) { // still indexing or untracked
        this.root.innerHTML = '';
        this.root.appendChild(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), e.body?.indexing ? `Indexing transcripts… ${e.body.indexing.done}/${e.body.indexing.total}` : 'Starting to track this project…'));
        if (e.body?.untracked) await api.track(this.pid);
        setTimeout(() => { if (!this.disposed) { this.root.innerHTML = ''; this.load(); } }, 1500);
        return;
      }
      this.root.innerHTML = ''; this.root.appendChild(h('div', { class: 'loading' }, 'Could not load: ' + e.message)); return;
    }
    applyLayout(city);
    if (this.disposed) return;
    this.root.innerHTML = '';
    this.city = city; this.data = data;
    data.sessions.forEach((s, i) => { this.sIndex.set(s.id, i); this.colors.push(new THREE.Color()); this.colorStr.push(''); });
    data.tasks.forEach((t, i) => this.taskIndex.set(t.id, i));
    data.agents.forEach((a, i) => this.agentIndex.set(a.id, i));
    this.indexFiles();
    for (const s of liveRes.sessions) this.liveSessions.set(s.id, s);
    this.assignColors(true);
    this.buildDom();
    this.stage = new Stage(this.els.stage);
    this.world = new World(this.stage, city, this.els.overlay);
    this.world.onMoved = this.onPlaceMoved;
    this.stage.grab = (x, y) => this.layer === 'city' ? this.world.grab(x, y) : null;
    this.actors = new Actors(this.stage, this.world);
    this.makeSchematic();
    this.domain = new DomainMap(this.root, this.pid, city, { onFile: p => this.openFile(p), onLayout: () => this.placeOccluders() });
    this.root.insertBefore(this.domain.el, this.els.layers);
    this.makeMood();
    this.sky = new Sky(this.stage);
    this.stage.onFrame((dt, t) => this.sky?.update(dt, t, this.t));
    this.hookLife();
    this.applyBirths(0, data.events.ts.length);
    const span = city.project.w + city.project.h;
    this.stage.viewSize = span * 0.55;
    this.stage.home.viewSize = span * 0.55;
    this.stage.onView = this.paintCompass;
    this.stage.updateCamera();
    this.stage.onZoom = z => { this.world.setLod(z); this.els.lod.textContent = this.world.lod === 'files' ? 'Files' : 'Modules'; };
    this.stage.onZoom(this.stage.viewSize);
    this.stage.onFrame(this.frame);
    this.stage.renderer.domElement.addEventListener('stage-click', (e: any) => this.onClick(e.detail.x, e.detail.y));
    this.stage.renderer.domElement.addEventListener('pointermove', this.onHoverCity);

    let viewTimer = 0;
    this.tl = new TimelineView(this.els.tl, {
      data, city, colors: this.colorStr,
      onSeek: (t, final) => { this.setMode('replay'); this.seek(t); if (final) { this.renderLog(); this.applyColorMode(); } },
      onHover: (info, x, y) => this.timelineTip(info, x, y),
      onHoverCommit: (c, x, y) => this.commitTip(c, x, y),
      onPickSession: s => this.focusOn(data.sessions[s].id),
      onPickCommit: c => this.openCommit(c.h),
      onView: () => { clearTimeout(viewTimer); viewTimer = window.setTimeout(() => this.assignColors(), 300); },
    });

    this.seek(Date.now());
    this.renderSessions(); this.renderLog();
    this.offLive = live.on(m => this.onMessage(m));
    live.subscribe(this.pid);
    this.placeOccluders();
    new ResizeObserver(() => this.placeOccluders()).observe(this.root);
    this.refreshChanges();
    this.timers.push(window.setInterval(() => this.refreshChanges(), 8000));
    this.loadAlerts();
    this.loadFlags();
    if (data.older) this.loadOlder();
    // intro: drop in from above
    this.stage.viewSize = span * 0.9; this.stage.updateCamera();
    this.stage.flyTo(0, 0, span * 0.55, 1.8);
    if (this.pendingFollow) { const sid = this.pendingFollow; this.pendingFollow = null; setTimeout(() => this.focusOn(sid), 1900); }
    // the domain map is the front page; a layer picked before is kept per browser
    let first: Layer = 'domain';
    try { const v = localStorage.getItem('vz-layer') as Layer; if (LAYERS.includes(v)) first = v; } catch {}
    this.setLayer(first);
  }

  private indexFiles() { this.fileIndex = new Map(this.city.files.map((f, i) => [f.p.toLowerCase(), i])); }

  // History older than the first window, fetched once the city is on screen.
  private async loadOlder() {
    const r = await api.older(this.pid, this.data.since).catch(() => null);
    if (!r || this.disposed) return;
    const ev = this.data.events, o = r.events;
    const sm = r.ids.s.map(id => this.sIndex.get(id) ?? -1), am = r.ids.a.map(id => this.agentIndex.get(id) ?? -1), tm = r.ids.task.map(id => this.taskIndex.get(id) ?? -1);
    const keep: number[] = [];
    for (let i = 0; i < o.ts.length; i++) if (sm[o.s[i]] >= 0) keep.push(i);
    ev.ts = keep.map(i => o.ts[i]).concat(ev.ts); ev.s = keep.map(i => sm[o.s[i]]).concat(ev.s);
    ev.a = keep.map(i => o.a[i] >= 0 ? am[o.a[i]] : -1).concat(ev.a); ev.k = keep.map(i => o.k[i]).concat(ev.k);
    ev.tt = keep.map(i => o.tt[i]).concat(ev.tt); ev.ti = keep.map(i => o.ti[i]).concat(ev.ti);
    ev.task = keep.map(i => o.task[i] >= 0 ? tm[o.task[i]] : -1).concat(ev.task);
    this.cursor += keep.length;
    this.data.since = 0; this.data.older = 0;
    this.applyBirths(0, keep.length);
    this.tl.invalidate();
    if (this.mode === 'replay') this.seek(this.t);
    this.applyColorMode();
  }

  // ---------------------------------------------------------------- DOM
  private buildDom() {
    const c = this.city;
    const e = this.els;
    e.stage = h('div', { class: 'stage' });
    e.overlay = h('div', { class: 'overlay' });
    e.tags = h('div', { class: 'opt-tags' });
    e.tip = h('div', { class: 'tip' });
    e.toasts = h('div', { class: 'toasts' });
    e.lod = h('span', {}, 'Files');
    // Layer switch: the tile shows the current layer; clicking it opens a chooser with every layer and the details
    const check = (label: string, title: string, f: (on: boolean) => void, on0 = true) => {
      const b = h('button', { class: 'ly-check' + (on0 ? ' on' : ''), title, onclick: () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); f(on); } }, h('i', {}), label);
      return b;
    };
    const thumb = (which: Layer) => { const t = h('span', { class: 'ly-thumb' }); t.innerHTML = THUMB[which]; return t; };
    e.layerTile = h('button', { class: 'ly-tile', title: 'Choose map layer (M)', 'aria-haspopup': 'dialog', onclick: () => this.toggleLayerMenu() });
    e.layerTypes = h('div', { class: 'ly-types' }, ...LAYERS.map(w =>
      h('button', { class: 'ly-type' + (w === this.layer ? ' on' : ''), 'data-layer': w, onclick: () => { this.setLayer(w); this.toggleLayerMenu(false); } }, thumb(w), LAYER_NAME[w])));
    e.cityOpts = h('div', { class: 'ly-opts' }, h('div', { class: 'ly-h' }, 'City details'),
      check('Roads', 'Streets between places that work together', on => this.world.showRoads(on)),
      check('Traffic', 'Cars drive the street a session just took', on => this.world.showTraffic(on)),
      check('City mood', 'The city looks like its health: smog for high spend, litter by stale uncommitted files, run-down buildings that keep being rewritten, cones where sessions collided', on => this.mood?.setEnabled(on)),
      check('People & vehicles', 'Residents, workers carrying each action\'s tool, delivery vans on import ties, police, buses for sub-agents, trains on commits, planes to outside services, birds', on => { this.world.life.enabled = on; }),
      check('Day & night', 'The sky follows the clock of the moment on screen (lit windows and street lamps at night); off keeps it day', on => { if (this.sky) this.sky.enabled = on; }, false),
      check('Weather', 'Rain while tests fail, lightning when sessions keep colliding on one file', on => { if (this.sky) this.sky.weather = on; }),
      e.resetLayout = h('button', { class: 'ly-reset', title: 'Put every dragged area and building back where the city placed it', disabled: !hasLayout(this.pid),
        onclick: () => { resetLayout(this.pid); (e.resetLayout as HTMLButtonElement).disabled = true; this.reloadCity(); } }, 'Reset layout'));
    e.layers = h('div', { class: 'layers' }, e.layerTile,
      h('div', { class: 'ly-panel glass', role: 'dialog', 'aria-label': 'Map layer' }, h('div', { class: 'ly-h' }, 'Map type'), e.layerTypes, e.cityOpts));
    this.paintLayerTile();
    e.changesBtn = h('button', { class: 'chip toggle', title: 'Mark files with uncommitted changes, in the colour of the session that wrote them (red: several sessions)', onclick: () => this.toggleChanges() }, 'Uncommitted ', h('b', {}, '–'));
    e.colorSel = h('select', { class: 'chip sel', title: 'What the building colours show', onchange: (ev: Event) => { this.colorMode = (ev.target as HTMLSelectElement).value as ColorMode; this.applyColorMode(); } },
      ...COLOR_MODES.map(([v, l]) => h('option', { value: v }, l)));
    e.bell = h('button', { class: 'chip icon bell', title: 'Alerts', onclick: () => this.toggleDrawer() }, h('span', { class: 'bell-ico' }), h('span', { class: 'badge' }));
    (e.bell.firstChild as HTMLElement).innerHTML = BELL;
    e.modeBadge = h('span', { class: 'mode live' }, 'LIVE');
    const totalCost = this.data.sessions.reduce((s, x) => s + (x.cost || 0), 0);
    const header = h('header', { class: 'topbar glass' },
      h('a', { class: 'back', href: '#/' }, '←'),
      h('div', { class: 'ttl' }, h('h1', {}, c.project.name), h('div', { class: 'path' }, c.project.root)),
      h('div', { class: 'chips' },
        (this.health = new HealthChip(this.pid, { onData: (d, prev) => this.onHealth(d, prev), onFactor: k => this.openFactor(k) })).el,
        h('span', { class: 'chip' }, h('b', {}, this.data.sessions.length), ' sessions'),
        h('span', { class: 'chip' }, h('b', {}, this.data.tasks.length), ' tasks'),
        h('span', { class: 'chip' }, h('b', {}, c.modules.filter(m => !m.warehouse).length), ' modules'),
        h('span', { class: 'chip wide' }, h('b', {}, c.externals.filter(x => x.type !== 'local').length), ' outside systems'),
        h('span', { class: 'chip wide' }, h('b', {}, c.files.length), ' files'),
        c.project.isGit ? h('span', { class: 'chip wide' }, h('b', {}, c.commits.length), ' commits') : null,
        totalCost ? h('span', { class: 'chip', title: 'All sessions at API list prices. A subscription is not billed per token; this shows relative spend.' }, h('b', {}, money(totalCost)), ' API-equiv.') : null),
      h('div', { class: 'spacer' }),
      e.modeBadge,
      e.bell,
      c.project.isGit ? e.changesBtn : null,
      e.colorSel,
      e.levelChip = h('span', { class: 'chip ghost', title: 'Zoom out for modules, in for files' }, 'Level: ', e.lod),
      h('button', { class: 'chip icon', title: 'Rotate left (Q)', onclick: () => this.viewStage().rotate(-1) }, '⟲'),
      h('button', { class: 'chip icon', title: 'Rotate right (E)', onclick: () => this.viewStage().rotate(1) }, '⟳'),
      h('button', { class: 'chip icon', title: 'Fit the map', onclick: () => this.layer === 'domain' ? this.domain.fit() : this.stage.flyTo(0, 0, (c.project.w + c.project.h) * 0.55) }, '⤢'));
    e.header = header;

    e.drawer = h('div', { class: 'drawer glass' });
    e.drawer.style.display = 'none';

    // cards are rebuilt on every session update, so the hover highlight is cleared by the list, not the card
    e.sessions = h('div', { class: 'list', onmouseleave: () => { this.hoverSid = null; this.world.setMarks([]); } });
    e.sessHead = h('div', { class: 'panel-h' });
    const left = h('aside', { class: 'panel left glass' }, e.sessHead, e.sessions);
    e.left = left;

    e.log = h('div', { class: 'list' });
    e.inspect = h('div', { class: 'list' });
    e.digest = h('div', { class: 'list' });
    e.search = h('input', { class: 'search', placeholder: 'Search tasks, prompts…', oninput: (ev: Event) => { this.logQuery = (ev.target as HTMLInputElement).value.toLowerCase(); this.renderLog(); } }) as HTMLInputElement;
    e.tabLog = h('button', { class: 'tab on', onclick: () => this.tab('log') }, 'Task log');
    e.tabInspect = h('button', { class: 'tab', onclick: () => this.tab('inspect') }, 'Inspect');
    e.tabDigest = h('button', { class: 'tab', onclick: () => { this.tab('digest'); this.loadDigest(); } }, 'Digest');
    e.reviewList = h('div', { class: 'list' });
    e.insights = h('div', { class: 'list' });
    e.tabReview = h('button', { class: 'tab', title: 'Uncommitted files, riskiest first', onclick: () => { this.tab('review'); this.loadReview(); } }, 'Review', h('span', { class: 'tbadge' }));
    e.tabInsights = h('button', { class: 'tab', title: 'This week: what landed, rework, waiting on you, hotspots', onclick: () => { this.tab('insights'); this.loadInsights(); } }, 'Insights');
    e.filterChip = h('div', { class: 'filter' });
    const right = h('aside', { class: 'panel right glass' },
      h('div', { class: 'tabs' }, e.tabLog, e.tabInspect, e.tabReview, e.tabInsights, e.tabDigest),
      h('div', { class: 'logwrap' }, e.search, e.filterChip, e.log), e.inspect, e.digest, e.reviewList, e.insights);
    e.right = right;
    e.inspect.style.display = 'none'; e.digest.style.display = 'none'; e.reviewList.style.display = 'none'; e.insights.style.display = 'none';

    e.play = h('button', { class: 'ctl play', title: 'Play / pause (space)', onclick: () => this.togglePlay() }, '▶');
    e.speed = h('select', { class: 'ctl', title: 'Playback speed', onchange: (ev: Event) => { this.speed = Number((ev.target as HTMLSelectElement).value); } },
      ...SPEEDS.map(s => h('option', { value: s, selected: s === this.speed }, s === 1 ? 'Real time' : `${s}×`)));
    e.clock = h('div', { class: 'clock' });
    e.goLive = h('button', { class: 'ctl golive', onclick: () => this.goLive() }, '● Live');
    e.gap = h('div', { class: 'gapnote' });
    const legend = h('div', { class: 'legend' }, ...['write', 'read', 'cmd', 'remote'].map(k => h('span', {}, h('i', { style: { background: KIND_COLORS[k] } }), k === 'cmd' ? 'command' : k)),
      h('span', {}, h('i', { class: 'diamond' }), 'commit'));
    const seg = (items: [string, () => void][], on: number) => {
      const bs = items.map(([l, f], i) => h('button', { class: i === on ? 'on' : '', onclick: () => { bs.forEach(b => b.classList.remove('on')); bs[i].classList.add('on'); f(); } }, l));
      return h('div', { class: 'seg' }, ...bs);
    };
    const histSeg = seg([['Actions', () => { this.tl.setMode('actions'); legend.style.opacity = '1'; }], ['Cost', () => { this.tl.setMode('cost'); legend.style.opacity = '0.3'; }]], 0);
    const rangeSeg = seg([['24h', () => this.tl.showSpan(DAY)], ['7d', () => this.tl.showSpan(7 * DAY)], ['All', () => this.tl.showSpan(Infinity)]], 0);
    e.tl = h('div', { class: 'tlhost' });
    const bottom = h('footer', { class: 'bottombar glass' },
      h('div', { class: 'controls' },
        h('button', { class: 'ctl', title: 'Replay from the first session', onclick: () => { this.setMode('replay'); this.seek(this.tl.t0); this.speed = Math.max(this.speed, 1800); (e.speed as HTMLSelectElement).value = String(this.speed); this.play(true); } }, '⏮'),
        e.play, e.speed, e.clock, e.gap, h('div', { class: 'spacer' }), rangeSeg, histSeg, legend, e.goLive),
      e.tl);
    e.bottom = bottom;

    e.pulse = this.pulse.el;
    // compass: needle points north, the ring flattens as the view tilts; click to square the view up again
    e.compassDial = h('span', { class: 'cp-dial' }, h('i', { class: 'cp-n' }), h('i', { class: 'cp-s' }));
    e.compass = h('button', { class: 'compass glass', title: 'Reset view (R)\nRight-drag or Alt+drag: rotate and tilt\nQ / E: quarter turn · PgUp / PgDn: tilt',
      onclick: () => this.stage.resetView() }, h('span', { class: 'cp-ring' }, e.compassDial), h('span', { class: 'cp-label' }, 'Reset view'));
    this.root.append(e.stage, e.overlay, e.tags, e.layers, e.compass, e.pulse, header, e.drawer, left, right, bottom, e.tip, e.toasts);
    window.addEventListener('keydown', this.onKey);
  }

  // North on screen sits at (90° − azimuth) clockwise from up; the ground disk squashes by sin(elevation).
  private paintCompass = (azimuth: number, elevation: number, atDefault: boolean) => {
    const e = this.els;
    if (!e.compass) return;
    e.compassDial.style.transform = `scaleY(${Math.max(0.35, Math.sin(elevation)).toFixed(3)}) rotate(${(90 - azimuth * 180 / Math.PI).toFixed(2)}deg)`;
    e.compass.classList.toggle('moved', !atDefault);
  };

  // Labels must not hide under the panels that sit on top of the canvas.
  private placeOccluders() {
    if (!this.world) return;
    const e = this.els;
    // the open part of the map, between the panels
    const box = this.root.getBoundingClientRect(), r = (x: HTMLElement) => x.getBoundingClientRect();
    // the sessions column is hidden on the domain map (its sessions lead the task log there)
    const frame = { left: e.left.style.display === 'none' ? box.left : r(e.left).right, top: r(e.header).bottom, right: r(e.right).left, bottom: r(e.bottom).top };
    if (frame.right - frame.left < 200) { frame.left = box.left; frame.right = box.right; }
    this.frameRect = frame;
    // on the domain layer its panel takes the left of that part; the floating bits move right of it
    const left = this.layer === 'domain' ? Math.min(frame.left + this.domain.panelWidth(), frame.right - 200) : frame.left;
    // the machine/session pulse floats at the top of that open part
    Object.assign(e.pulse.style, { top: `${frame.top - box.top + 10}px`, left: `${(left + frame.right) / 2 - box.left}px`, transform: 'translateX(-50%)', maxWidth: `${Math.max(200, frame.right - left - 28)}px` });
    this.world.occluders = [e.header, e.left, e.right, e.bottom, e.drawer, e.pulse]
      .filter(x => x && x.offsetParent && x.style.display !== 'none').map(x => x.getBoundingClientRect());
    Object.assign(e.layers.style, { left: `${left - box.left + 14}px`, bottom: `${box.bottom - frame.bottom + 14}px` });
    Object.assign(e.compass.style, { right: `${box.right - frame.right + 14}px`, bottom: `${box.bottom - frame.bottom + 14}px` });
    this.schem?.setFrame(frame);
    if (this.domain) this.domain.occluders = [e.pulse, e.layers, e.compass].filter(Boolean);
    this.domain?.setFrame(frame);
  }

  // ---------------------------------------------------------------- layers
  private makeSchematic() {
    const old = this.schem;
    old?.dispose();
    this.schem = new Schematic(this.root, this.city, {
      onPick: r => { this.select(r ? { tt: r[0], ti: r[1] } : null, false, true); if (!r && this.curTab === 'inspect') this.tab('log'); },
      onHover: (r, x, y) => this.showTip(r ? { tt: r[0], ti: r[1] } : null, x, y),
    });
    if (old) this.schem.takeView(old);
    this.root.insertBefore(this.schem.el, this.els.layers);
    this.placeOccluders(); // the frame first, or a rebuilt schematic fits itself to the whole window
    if (this.layer === 'schematic') this.schem.setVisible(true);
  }
  setLayer(which: Layer) {
    if (which === this.layer) return;
    const anchor = this.layer !== 'domain' && which !== 'domain' ? this.layerAnchor() : null;
    this.layer = which;
    try { localStorage.setItem('vz-layer', which); } catch {}
    const e = this.els, schem = which === 'schematic', notCity = which !== 'city';
    this.schem.setVisible(schem);
    this.domain.setVisible(which === 'domain');
    this.stage.hidden = notCity;
    e.stage.style.visibility = e.overlay.style.visibility = e.tags.style.visibility = notCity ? 'hidden' : '';
    e.compass.style.visibility = schem ? 'hidden' : '';
    // the domain map's own panel takes the left; the open sessions lead the task log instead
    e.left.style.display = which === 'domain' ? 'none' : 'flex';
    this.renderLog();
    e.levelChip.style.display = notCity ? 'none' : '';
    e.cityOpts.style.display = notCity ? 'none' : '';
    e.colorSel.style.display = notCity ? 'none' : '';
    e.layerTypes.querySelectorAll('.ly-type').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.layer === which));
    this.paintLayerTile();
    this.placeOccluders();
    this.els.tip.style.opacity = '0';
    if (schem && this.selected) this.schem.setSelected(this.placeRef(this.selected));
    if (anchor && schem) this.schem.pin(anchor.r, anchor.x, anchor.y);
    else if (anchor) this.stage.pin(this.world.center(anchor.r), anchor.x, anchor.y);
  }
  // The place both layers keep at the same spot on screen when switching: the selection, else the place
  // nearest the middle of the open frame; where it is now, or that middle if it is out of view.
  private frameRect = { left: 0, top: 0, right: 0, bottom: 0 };
  private layerAnchor(): { r: [number, number]; x: number; y: number } | null {
    const f = this.frameRect, mx = (f.left + f.right) / 2, my = (f.top + f.bottom) / 2;
    let r = this.selected ? this.placeRef(this.selected) : null, at: [number, number] | null = null;
    if (this.layer === 'city') {
      if (!r) {
        const g = this.stage.groundAt(mx, my); if (!g) return null;
        let d = Infinity;
        for (const p of this.world.roads.places) { const c = this.world.center(p), e = Math.hypot(c.x - g.x, c.z - g.z); if (e < d) { d = e; r = p; } }
      }
      if (!r) return null;
      const p = this.stage.project(this.world.center(r)), box = this.stage.el.getBoundingClientRect();
      at = [p.x + box.left, p.y + box.top];
    } else {
      r ??= this.schem.refAt(mx, my);
      if (!r) return null;
      at = this.schem.screenOf(r);
    }
    const shown = at && at[0] > f.left && at[0] < f.right && at[1] > f.top && at[1] < f.bottom;
    return { r, x: shown ? at![0] : mx, y: shown ? at![1] : my };
  }
  private paintLayerTile() {
    const t = this.els.layerTile;
    t.innerHTML = `<span class="ly-thumb">${THUMB[this.layer]}</span><span class="ly-name">${LAYER_NAME[this.layer]}</span>`;
  }
  private toggleLayerMenu(open = !this.els.layers.classList.contains('open')) {
    this.els.layers.classList.toggle('open', open);
    this.els.layerTile.setAttribute('aria-expanded', String(open));
    if (open) document.addEventListener('pointerdown', this.onLayerOutside, true);
    else document.removeEventListener('pointerdown', this.onLayerOutside, true);
  }
  private onLayerOutside = (ev: PointerEvent) => {
    if (!this.els.layers.contains(ev.target as Node)) this.toggleLayerMenu(false);
  };
  private viewStage() { return this.layer === 'domain' ? this.domain.stage : this.stage; }
  // A file picked on the domain map opens in the Inspect tab.
  private openFile(p: string) {
    const i = this.fileIndex.get(p.toLowerCase());
    if (i != null) this.select({ tt: 0, ti: i });
  }
  // The module or outside system a selection stands in (a file stands in its module).
  private placeRef(s: { tt: number; ti: number }): [number, number] | null {
    if (s.tt === 0) { const f = this.city.files[s.ti]; return f ? [1, f.m] : null; }
    return s.tt === 1 || s.tt === 3 ? [s.tt, s.ti] : null;
  }

  private onKey = (ev: KeyboardEvent) => {
    if ((ev.target as HTMLElement)?.closest('input,textarea,select')) return;
    if (ev.code === 'Space') { ev.preventDefault(); this.togglePlay(); }
    if (ev.key === 'Escape' && this.els.layers.classList.contains('open')) { this.toggleLayerMenu(false); return; }
    if (ev.key === 'Escape') { this.select(null); this.focusOn(null); this.toggleDrawer(false); }
    if (ev.key === 'l' || ev.key === 'L') this.goLive();
    if (ev.key === 'm' || ev.key === 'M') this.toggleLayerMenu();
  };

  private tab(which: Tab) {
    this.curTab = which;
    this.els.tabLog.classList.toggle('on', which === 'log');
    this.els.tabInspect.classList.toggle('on', which === 'inspect');
    this.els.tabDigest.classList.toggle('on', which === 'digest');
    this.els.tabReview.classList.toggle('on', which === 'review');
    this.els.tabInsights.classList.toggle('on', which === 'insights');
    (this.els.log.parentElement as HTMLElement).style.display = which === 'log' ? '' : 'none';
    this.els.inspect.style.display = which === 'inspect' ? '' : 'none';
    this.els.digest.style.display = which === 'digest' ? '' : 'none';
    this.els.reviewList.style.display = which === 'review' ? '' : 'none';
    this.els.insights.style.display = which === 'insights' ? '' : 'none';
    if (which !== 'digest' && this.tiesShown) { this.tiesShown = null; this.world.showTies(null); }
  }

  // ---------------------------------------------------------------- colours
  assignColors(quiet = false) {
    const want: string[] = [];
    for (const s of this.liveSessions.values()) if (s.state !== 'ended' && this.sIndex.has(s.id)) want.push(s.id);
    const v1 = this.tl?.v1 ?? Date.now(), v0 = this.tl?.v0 ?? v1 - DAY;
    const inView = this.data.sessions.filter(s => s.first <= v1 && s.last >= v0).sort((a, b) => b.last - a.last);
    for (const s of inView) if (!want.includes(s.id)) want.push(s.id);
    if (this.focusSession && !want.slice(0, PALETTE.length).includes(this.focusSession)) want.unshift(this.focusSession);
    const top = new Set(want.slice(0, PALETTE.length));
    for (const sid of [...this.slots.keys()]) if (!top.has(sid)) this.slots.delete(sid);
    const used = new Set(this.slots.values());
    for (const sid of top) if (!this.slots.has(sid)) { let k = 0; while (used.has(k)) k++; this.slots.set(sid, k); used.add(k); }
    let changed = false;
    this.data.sessions.forEach((s, i) => {
      const slot = this.slots.get(s.id);
      const c = slot != null ? PALETTE[slot] : muted(s.id);
      if (!this.colorStr[i] || !this.colors[i].equals(c)) {
        this.colors[i].copy(c); this.colorStr[i] = colorCss(c); changed = true;
        this.actors?.recolor(s.id, this.colors[i]);
      }
    });
    if (changed && !quiet) { this.tl?.invalidate(); this.renderSessions(); this.renderLog(); this.updatePins(); if (this.colorMode === 'session') this.applyColorMode(); }
  }

  private applyColorMode() {
    if (!this.world) return;
    const mode = this.colorMode, c = this.city, ev = this.data.events, w = this.data.kinds.indexOf('write');
    if (mode === 'district') { this.world.setFileTint(null); return; }
    if (mode === 'churn') {
      const max = Math.max(1, ...c.files.map(f => f.churn + f.w));
      this.world.setFileTint(i => { const v = c.files[i].churn + c.files[i].w; return v ? Math.log1p(v) / Math.log1p(max) : -1; });
      return;
    }
    if (mode === 'rework' || mode === 'growth' || mode === 'tested') {
      const d = this.insightsData;
      if (!d) { this.world.setFileTint(() => -1); if (!this.insightsWanted) { this.insightsWanted = true; this.loadInsights(); } return; }
      const f = (i: number) => d.files[i];
      if (mode === 'tested') { this.world.setFileTint(i => f(i)?.tested === 1 ? TESTED : f(i)?.tested === 0 ? UNTESTED : -1); return; }
      const val = (i: number) => Math.max(0, (mode === 'rework' ? f(i)?.churn : f(i)?.growth) || 0);
      const max = Math.max(1, ...c.files.map((_, i) => val(i)));
      this.world.setFileTint(i => val(i) ? Math.log1p(val(i)) / Math.log1p(max) : -1);
      return;
    }
    // last write per file, up to the time on screen
    const upTo = this.mode === 'live' ? Infinity : this.t;
    const lastTs = new Float64Array(c.files.length), lastS = new Int32Array(c.files.length).fill(-1);
    for (let i = 0; i < ev.ts.length && ev.ts[i] <= upTo; i++) if (ev.k[i] === w && ev.tt[i] === 0) { lastTs[ev.ti[i]] = ev.ts[i]; lastS[ev.ti[i]] = ev.s[i]; }
    if (mode === 'session') { this.world.setFileTint(i => lastS[i] >= 0 ? this.colors[lastS[i]] : -1); return; }
    const now = this.mode === 'live' ? Date.now() : this.t, H = 3600e3;
    this.world.setFileTint(i => lastTs[i] ? 1 - Math.min(1, Math.log(1 + Math.max(0, now - lastTs[i]) / H) / Math.log(1 + 30 * DAY / H)) : -1);
  }

  // ---------------------------------------------------------------- uncommitted changes
  private async refreshChanges() {
    if (!this.city?.project.isGit || this.disposed) return;
    const r = await api.changes(this.pid).catch(() => null);
    if (!r || this.disposed) return;
    this.changes = r;
    const b = this.els.changesBtn?.querySelector('b'); if (b) b.textContent = String(r.files.length);
    if (this.curTab === 'review' || Date.now() - this.reviewAt > 30e3) this.loadReview(true);
    this.updatePins();
    if (this.mode === 'live') this.renderSessions();
  }
  private changesSoon = 0;
  private scheduleChanges() { clearTimeout(this.changesSoon); this.changesSoon = window.setTimeout(() => this.refreshChanges(), 1500); }

  private toggleChanges() {
    this.showChanges = !this.showChanges;
    this.els.changesBtn.classList.toggle('on', this.showChanges);
    this.updatePins();
  }
  private updatePins() {
    if (!this.world) return;
    if (!this.showChanges || !this.changes) { this.world.setPins([]); return; }
    const pins = [];
    for (const f of this.changes.files) {
      const ti = this.fileIndex.get(f.p.toLowerCase()); if (ti == null) continue;
      const ws = f.writers.filter(x => this.sIndex.has(x.s));
      const multi = new Set(ws.map(x => x.s)).size > 1;
      pins.push({ ti, multi, color: multi ? MULTI : ws.length ? this.colors[this.sIndex.get(ws[0].s)!] : NOBODY });
    }
    this.world.setPins(pins);
  }
  // Uncommitted files this session wrote, with whether another session wrote them too.
  private footprint(sid: string) {
    if (!this.changes) return [];
    return this.changes.files.filter(f => f.writers.some(w => w.s === sid))
      .map(f => ({ p: f.p, ti: this.fileIndex.get(f.p.toLowerCase()), shared: f.writers.some(w => w.s !== sid) }));
  }

  // ---------------------------------------------------------------- health, review, insights
  private makeMood() {
    this.mood?.dispose();
    this.mood = new Mood(this.world, this.city, this.fileIndex);
    const on = this.els.cityOpts?.querySelector('.ly-check[title^="The city looks"]')?.classList.contains('on') ?? true;
    this.mood.enabled = on;
    if (this.healthData) { this.mood.setLook(this.healthData.look); this.mood.setCosmetics(this.healthData.cosmetics); }
  }
  private onHealth(d: Health, prev: Health | null) {
    this.healthData = d;
    if (!this.mood) return;
    this.lifeFromHealth(d);
    if (prev && prev !== d && d.commits > prev.commits && this.mode === 'live') {
      api.digest(this.pid, Date.now() - 6 * 3600e3, Date.now()).then(g => {
        const c = g.commits.slice().sort((a, b) => b.ts - a.ts)[0];
        this.world.life.commit(c?.n ?? 3);
        if (c) this.world.setTicker(c.s);
      }).catch(() => this.world.life.commit(3));
    }
    this.mood.setLook(d.look);
    this.mood.setCosmetics(d.cosmetics);
    if (!prev || prev === d) return;
    const fresh = d.milestones.filter(m => m.got && !prev.milestones.find(p => p.key === m.key)?.got);
    if (fresh.length) {
      this.mood.celebrate(6);
      for (const m of fresh) this.notice(`Milestone unlocked: ${m.label}`, d.cosmetics.find(c => c.unlocked && MILESTONE_OF[c.key] === m.key)?.label);
    } else if (d.commits > prev.commits) this.mood.celebrate(Math.min(5, 1 + d.commits - prev.commits));
  }
  // People and vehicles that follow the city's health: onlookers at collisions,
  // garbage trucks round districts with stale uncommitted files, a statue per 100 commits.
  private lifeFromHealth(d: Health) {
    const idx = (list: string[]) => list.map(p => this.fileIndex.get(p.toLowerCase())).filter((i): i is number => i != null);
    this.world.life.setCrowds(idx(d.look.cones));
    this.world.life.setLitter([...new Set(idx(d.look.litter).map(i => this.city.modules[this.city.files[i].m].district))]);
    this.world.dressing.setStatues(d.commits);
  }
  private hookLife() {
    this.world.life.drones = () => this.actors.drones.values();
    this.world.life.enabled = this.els.cityOpts?.querySelector('.ly-check[title^="Residents"]')?.classList.contains('on') ?? true;
    if (this.healthData) this.lifeFromHealth(this.healthData);
    this.paintLabs();
  }
  // Test runs: inspectors walk to what the session just wrote, the labs' lamps show the
  // latest result, and it rains while the latest run anywhere failed.
  private onSessionHealth(s: LiveSession) {
    const run = s.health?.checks?.test;
    if (run && this.testSeen.get(s.id) !== run.ts) {
      const first = !this.testSeen.has(s.id);
      this.testSeen.set(s.id, run.ts);
      this.testState.set(s.id, { ok: run.ok, ts: run.ts });
      if (!first && this.mode === 'live') {
        const si = this.sIndex.get(s.id), ev = this.data.events, w = this.data.kinds.indexOf('write'), files: number[] = [];
        for (let i = ev.ts.length - 1; i >= 0 && files.length < 8 && Date.now() - ev.ts[i] < 30 * 60e3; i--)
          if (ev.s[i] === si && ev.k[i] === w && ev.tt[i] === 0 && !files.includes(ev.ti[i])) files.push(ev.ti[i]);
        this.world.life.inspect(run.ok, files);
        if (!run.ok && files.length) this.world.life.emergency([1, this.city.files[files[0]].m]);
      }
      this.paintLabs();
    }
    // spend: a tanker for every $5 since the city opened
    if (s.health) {
      this.spent.set(s.id + ':' + s.health.task, s.health.cost || 0);
      const total = [...this.spent.values()].reduce((a, b) => a + b, 0);
      if (this.spentBase < 0) this.spentBase = total;
      const n = Math.floor((total - this.spentBase) / 5);
      for (; this.tankers < n; this.tankers++) this.world.life.tanker();
    }
  }
  private paintLabs() {
    const runs = [...this.testState.values()].filter(r => Date.now() - r.ts < 4 * 3600e3).sort((a, b) => b.ts - a.ts);
    const last = runs[0];
    const col = new THREE.Color(!last ? '#7d8aa0' : last.ok ? '#3ddc84' : '#ff4d5e').multiplyScalar(1.6);
    this.world.fileRoofs.paint('lamp', () => col); this.world.modRoofs.paint('lamp', () => col);
    this.updateWeather();
  }
  private updateWeather() {
    const runs = [...this.testState.values()].filter(r => Date.now() - r.ts < 2 * 3600e3).sort((a, b) => b.ts - a.ts);
    const failing = (runs[0] && !runs[0].ok) || this.alerts.some(a => a.kind === 'failing' && !a.resolved && Date.now() - a.ts < 3600e3);
    const hits = new Map<string, number>();
    for (const a of this.alerts) if (a.kind === 'collision' && a.path && Date.now() - a.ts < 2 * 3600e3) hits.set(a.path, (hits.get(a.path) || 0) + 1);
    this.sky?.setWeather(!!failing, [...hits.values()].some(n => n >= 2));
  }

  // An in-page note for good news (milestones); alerts stay for problems.
  private notice(text: string, sub?: string) {
    const el = h('div', { class: 'toast notice', onclick: () => el.remove() }, h('div', { class: 'tk' }, '★ ' + text), sub ? h('div', { class: 'tx' }, `Unlocked cosmetic: ${sub}`) : null);
    this.els.toasts.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 600); }, 9000);
  }
  // A health factor opens the view that explains it.
  private openFactor(key: string) {
    if (key === 'tidiness') { this.tab('review'); this.loadReview(); }
    else if (key === 'shipping' || key === 'efficiency') { this.tab('insights'); this.loadInsights(); }
    else if (key === 'harmony') this.toggleDrawer(true);
    else if (key === 'stability') { this.colorMode = 'rework'; (this.els.colorSel as HTMLSelectElement).value = 'rework'; this.applyColorMode(); this.loadInsights(); }
  }

  private reviewAt = 0;
  private async loadReview(quiet = false) {
    if (!this.city.project.isGit || this.disposed) return;
    const e = this.els.reviewList;
    if (!this.review && !quiet) { e.innerHTML = ''; e.appendChild(h('div', { class: 'loading-sm' }, 'Checking uncommitted changes…')); }
    const r = await api.review(this.pid).catch(() => null);
    if (!r || this.disposed) return;
    this.review = r; this.reviewAt = Date.now();
    const badge = this.els.tabReview.querySelector('.tbadge') as HTMLElement;
    badge.textContent = r.high ? String(r.high) : ''; badge.style.display = r.high ? 'inline-block' : 'none';
    if (this.curTab === 'review') this.renderReview();
  }
  private renderReview() {
    const r = this.review!, e = this.els.reviewList;
    e.innerHTML = '';
    if (!r.isGit) { e.appendChild(h('div', { class: 'empty' }, 'Not a git repository, so there is nothing to review before a commit.')); return; }
    if (!r.files.length) { e.appendChild(h('div', { class: 'empty' }, 'Working tree clean. Nothing waits for review.')); return; }
    const need = r.files.filter(f => f.level !== 'low').length;
    const icon = { high: '▲', medium: '●', low: '○' };
    put(e,
      h('div', { class: 'rv-head' }, h('b', {}, need ? `${need} of ${r.files.length} files need a look` : `${r.files.length} uncommitted files, none risky`),
        h('div', { class: 'sub' }, 'Ranked by what the area holds, size of the change, whether the writing session tested after it, and leftovers.')),
      r.files.map(f => {
        const ws = f.sessions.map(s => this.sIndex.get(s)).filter((x): x is number => x != null);
        return h('div', { class: 'rv-row ' + f.level, onclick: () => { if (f.ti != null) this.select({ tt: 0, ti: f.ti }, true); },
          onmouseenter: () => { if (f.ti != null) this.world.setMarks([{ tt: 0, ti: f.ti, color: ws.length ? this.colors[ws[0]] : NOBODY }]); } },
          h('div', { class: 'row' }, h('span', { class: 'rv-lv' }, icon[f.level]), h('span', { class: 'fp' }, f.p),
            h('span', { class: 'n' }, f.st === '??' ? 'new' : f.add || f.del ? `+${f.add} −${f.del}` : f.st)),
          h('div', { class: 'rv-why' }, f.reasons.map(x => h('span', { class: 'rv-r ' + x.k }, x.t))),
          f.task ? h('div', { class: 'rv-task', onclick: (ev: Event) => { ev.stopPropagation(); const ti = this.taskIndex.get(f.task!.id); if (ti != null) this.openTask(this.data.tasks[ti]); } },
            ...ws.slice(0, 1).map(si => h('span', { class: 'dot', style: { background: this.colorStr[si] } })), f.task.title || 'task', f.age ? h('span', { class: 'dim' }, ` · ${dur(f.age)} ago`) : null) : null);
      }));
    e.onmouseleave = () => this.world.setMarks([]);
  }

  private async loadInsights() {
    const e = this.els.insights;
    if (!this.insightsData) { e.innerHTML = ''; e.appendChild(h('div', { class: 'loading-sm' }, 'Reading this week…')); }
    const r = await api.insights(this.pid).catch(() => null);
    if (!r || this.disposed) return;
    this.insightsData = r;
    if (this.curTab === 'insights') this.renderInsights();
    if (this.colorMode === 'rework' || this.colorMode === 'growth' || this.colorMode === 'tested') this.applyColorMode();
  }
  private renderInsights() {
    const d = this.insightsData!, e = this.els.insights, w = d.week, p = d.prev;
    const pct = (x: number | null) => x == null ? '–' : `${Math.round(x * 100)}%`;
    const hrs = (ms: number) => ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)}h` : `${Math.round(ms / 60e3)}m`;
    // one number for this week, and how it moved against last week (good: which direction is better)
    const kpi = (label: string, cur: string, a: number | null, b: number | null, good: 'up' | 'down', tip: string) => {
      let delta: HTMLElement | null = null;
      if (a != null && b != null && b !== 0 && Math.abs(a - b) / Math.abs(b) >= 0.05) {
        const up = a > b, better = up === (good === 'up');
        delta = h('span', { class: 'kd ' + (better ? 'good' : 'bad') }, `${up ? '▲' : '▼'} ${Math.round(Math.abs(a - b) / Math.abs(b) * 100)}%`);
      }
      return h('div', { class: 'kpi', title: tip }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, cur, delta));
    };
    const fileRow = (i: number, p: string, n: string) => h('div', { class: 'frow link', onclick: () => this.select({ tt: 0, ti: i }, true) }, h('span', { class: 'fp' }, p), h('span', { class: 'n' }, n));
    e.innerHTML = '';
    put(e,
      h('div', { class: 'sect' }, h('h3', {}, 'This week vs last week'),
        h('div', { class: 'kpis' },
          kpi('Cost per landed task', w.perLanded == null ? '–' : money(w.perLanded), w.perLanded, p.perLanded, 'down', 'API-equivalent spend divided by tasks whose edits reached a commit'),
          kpi('Tasks landed', `${w.landed} of ${w.writing}`, w.writing ? w.landed / w.writing : null, p.writing ? p.landed / p.writing : null, 'up', 'Tasks that wrote files and whose edits reached a commit'),
          kpi('Rework', pct(w.rework), w.rework, p.rework, 'down', 'Share of file edits that another task rewrote within 3 days'),
          kpi('Abandoned', String(w.abandoned), w.abandoned, p.abandoned, 'down', 'Tasks that wrote files that never reached a commit (after 6 hours)'),
          kpi('Checks passing', pct(w.checkPass), w.checkPass, p.checkPass, 'up', `${w.checks} test, build, type and lint runs this week`),
          kpi('Waiting on you', hrs(w.waitMedian), w.waitMedian, p.waitMedian, 'down', `Median time a finished turn waited for your next prompt (${hrs(w.waited)} in total across sessions)`))),
      h('div', { class: 'sect' }, h('h3', {}, 'Habits'),
        h('div', { class: 'ptext' }, w.blind != null && w.blind > 0.4
          ? `${pct(w.blind)} of writing tasks edited more than they read. Tasks that read the code first tend to need less rework; ask for a plan or point at the files before asking for changes.`
          : 'Most writing tasks read the code before changing it.'),
        d.untested ? h('div', { class: 'ptext' }, `${d.untested} code files were changed without a passing test, type check or build by the session that changed them (30 days). Colour: tested shows where.`) : null),
      d.suggestions.length ? h('div', { class: 'sect' }, h('h3', {}, 'Rules for CLAUDE.md'),
        h('div', { class: 'sub' }, 'Things you told sessions that are not in CLAUDE.md yet. Written there once, every session follows them.'),
        d.suggestions.map(s => h('div', { class: 'sugg' }, h('div', { class: 'ptext' }, '“' + s.text + '”'),
          h('div', { class: 'row' }, h('span', { class: 'dim' }, s.n > 1 ? `said in ${s.n} tasks` : 'stated as a rule'),
            h('button', { class: 'chip mini', onclick: (ev: Event) => { navigator.clipboard?.writeText('- ' + s.text); (ev.target as HTMLElement).textContent = 'Copied'; } }, 'Copy line'))))) : null,
      d.hot.length ? h('div', { class: 'sect' }, h('h3', { class: 'warn' }, 'Rewritten again and again (30 days)'),
        h('div', { class: 'sub' }, 'Where sessions keep going back. Worth settling the design once, or a CLAUDE.md note.'),
        d.hot.map(x => fileRow(x.i, x.p, `${x.tasks} tasks`)),
        h('button', { class: 'chip mini', onclick: () => this.openFactor('stability') }, 'Show on map')) : null,
      d.growing.length ? h('div', { class: 'sect' }, h('h3', {}, 'Growing fast (30 days)'),
        d.growing.map(x => fileRow(x.i, x.p, `+${x.g} lines · ${bytes(x.size)}`)),
        h('button', { class: 'chip mini', onclick: () => { this.colorMode = 'growth'; (this.els.colorSel as HTMLSelectElement).value = 'growth'; this.applyColorMode(); } }, 'Show on map')) : null,
      d.prompts ? this.promptSection(d.prompts) : null,
      this.depSection(d.deps),
      h('div', { class: 'sub dim' }, `Updated ${ago(d.at)}. Advice only: none of these numbers feed the health score.`));
  }

  // Your prompts that landed cheaply next to the ones that were abandoned or reworked.
  private promptSection(p: NonNullable<Insights['prompts']>) {
    const s = p.stats;
    const ex = (x: { id: string; prompt: string; cost: number; why?: string }, cls: string) => {
      const ti = this.taskIndex.get(x.id);
      return h('div', { class: 'pex ' + cls + (ti != null ? ' link' : ''), onclick: ti != null ? () => this.openTask(this.data.tasks[ti]) : null },
        h('div', { class: 'ptext' }, '“' + x.prompt + (x.prompt.length >= 220 ? '…' : '') + '”'),
        h('div', { class: 'dim' }, (x.why ? x.why + ' · ' : 'landed · ') + money(x.cost)));
    };
    const notes: string[] = [];
    if (Math.abs(s.goodWords - s.badWords) >= 5) notes.push(`Prompts that landed cheaply had a median of ${s.goodWords} words; the ones that did not, ${s.badWords}.`);
    if (Math.abs(s.goodNames - s.badNames) >= 0.15) notes.push(`${Math.round(s.goodNames * 100)}% of the cheap ones named a file or folder, against ${Math.round(s.badNames * 100)}% of the others.`);
    return h('div', { class: 'sect' }, h('h3', {}, 'Prompt → outcome (30 days)'),
      h('div', { class: 'sub' }, `${s.goodN} tasks landed cheaply; ${s.badN} were never committed or were reworked soon after. Click one to see what happened.`),
      notes.length ? h('div', { class: 'ptext' }, notes.join(' ')) : null,
      h('div', { class: 'pex-h good' }, 'Landed cheaply'), p.good.map(x => ex(x, 'good')),
      h('div', { class: 'pex-h bad' }, 'Abandoned or reworked'), p.bad.map(x => ex(x, 'bad')));
  }

  // Dependencies added and removed per week, and the task that added each.
  private depSection(deps: Insights['deps']) {
    const weeks = deps.weeks.filter(w => w.added.length || w.removed.length);
    if (!weeks.length) return null;
    const total = weeks.reduce((s, w) => s + w.added.length, 0), gone = weeks.reduce((s, w) => s + w.removed.length, 0);
    const wk = (n: number) => n === 0 ? 'This week' : n === 1 ? 'Last week' : `${n} weeks ago`;
    return h('div', { class: 'sect' }, h('h3', {}, 'Dependencies (8 weeks)'),
      h('div', { class: 'sub' }, `${total} added, ${gone} removed. Each new package is code you now maintain; check the ones no one asked for.`),
      weeks.map(w => h('div', { class: 'dep-wk' }, h('div', { class: 'dim' }, wk(w.week)),
        w.added.map(a => {
          const ti = a.task ? this.taskIndex.get(a.task.id) : undefined;
          return h('div', { class: 'frow' + (ti != null ? ' link' : ''), title: `${a.file} · commit ${a.commit}`, onclick: ti != null ? () => this.openTask(this.data.tasks[ti]) : null },
            h('span', { class: 'dep add' }, '+ ' + a.name), h('span', { class: 'n' }, a.task ? a.task.title.slice(0, 40) : a.file));
        }),
        w.removed.map(a => h('div', { class: 'frow', title: `${a.file} · commit ${a.commit}` }, h('span', { class: 'dep del' }, '− ' + a.name), h('span', { class: 'n' }, a.file))))));
  }

  // ---------------------------------------------------------------- time
  setMode(m: 'live' | 'replay') {
    if (this.mode === m) return;
    this.mode = m;
    this.els.modeBadge.textContent = m === 'live' ? 'LIVE' : 'REPLAY';
    this.els.modeBadge.className = 'mode ' + m;
    this.els.goLive.classList.toggle('show', m === 'replay');
    if (m === 'live') this.play(false);
    this.renderSessions();
  }
  goLive() { this.setMode('live'); this.seek(Date.now()); this.renderLog(); this.applyColorMode(); }
  togglePlay() { this.play(!this.playing); }
  play(on: boolean) {
    if (on && this.mode === 'live') { this.setMode('replay'); this.seek(Math.max(this.tl.t0, this.t - 3600e3)); }
    this.playing = on;
    this.els.play.textContent = on ? '❚❚' : '▶';
  }

  // Jump to a moment: rebuild heat, buildings and drone positions from history.
  seek(t: number) {
    const ev = this.data.events;
    this.t = t;
    let lo = 0, hi = ev.ts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ev.ts[m] <= t) lo = m + 1; else hi = m; }
    this.cursor = lo;
    this.world.clearHeat();
    // born = git birth, or the first time a session touched it
    this.world.setTime(t, false);
    const warm = new Map<string, { w: number; c: THREE.Color }>();
    const W: Record<string, number> = { write: 0.5, read: 0.15, search: 0.1, touch: 0.06, remote: 0.3, skill: 0.2 };
    this.actors.clear(); this.lastSim.clear(); this.lastPlace.clear(); this.prevPlace.clear();
    this.world.life.clear();
    this.lastCommitT = t;
    let lastCommit: string | null = null;
    for (const c of this.city.commits) if (c.ts <= t) lastCommit = c.s;
    this.world.setTicker(lastCommit);
    const from = t - 90 * 60e3;
    for (let i = lo - 1; i >= 0 && ev.ts[i] >= from; i--) {
      const k = this.data.kinds[ev.k[i]];
      const sid = this.data.sessions[ev.s[i]].id;
      if (!this.lastSim.has(sid)) this.lastSim.set(sid, ev.ts[i]);
      if (ev.tt[i] < 0) continue;
      if (!this.lastPlace.has(sid)) this.lastPlace.set(sid, [ev.tt[i], ev.ti[i]]);
      const wk = W[k]; if (!wk) continue;
      const key = ev.tt[i] + ':' + ev.ti[i];
      const cur = warm.get(key);
      const add = wk * Math.exp(-(t - ev.ts[i]) / WARM_TAU);
      if (cur) cur.w += add; else warm.set(key, { w: add, c: this.colors[ev.s[i]] });
    }
    for (const [key, v] of warm) { const [tt, ti] = key.split(':').map(Number); this.world.setWarmth(tt, ti, v.w, v.c); }
    // drones: sessions active around t (replay) or open sessions (live)
    const show = new Set<string>();
    if (this.mode === 'live') for (const s of this.liveSessions.values()) if (s.state !== 'ended') show.add(s.id);
    for (const [sid, ts] of this.lastSim) if (t - ts < ACTIVE_WINDOW) show.add(sid);
    for (const sid of show) {
      const si = this.sIndex.get(sid); if (si == null) continue;
      let place = this.lastPlace.get(sid);
      if (!place) for (let i = lo - 1; i >= 0; i--) if (ev.s[i] === si && ev.tt[i] >= 0) { place = [ev.tt[i], ev.ti[i]]; break; }
      if (place) this.actors.place(sid, this.colors[si], place[0], place[1]);
      else this.actors.drone(sid, this.colors[si]);
      const ls = this.liveSessions.get(sid);
      if (this.mode === 'live' && ls?.state === 'needs-you') this.actors.setNeeds(sid, true);
      if (this.mode === 'live' && ls) this.actors.setLive(sid, ls.state === 'working');
    }
    this.tl?.setCursor(t);
    this.updateClock();
    if (this.mode === 'replay') this.renderSessions();
  }

  private frame = (dt: number) => {
    this.fxBudget = 24;
    this.root.classList.toggle('day', ENV.night.value < 0.5); // labels switch to dark-on-light
    let simDt: number;
    if (this.mode === 'live') {
      const now = Date.now(); simDt = now - this.t; this.t = now;
      this.tl.extend(now); this.tl.setCursor(now);
    } else if (this.playing) {
      simDt = dt * 1000 * this.speed;
      const ev = this.data.events;
      // the next thing that happens: an action, or a part of the city being built
      const next = Math.min(ev.ts[this.cursor] ?? Infinity, this.world.nextBirth(this.t) ?? Infinity);
      // quiet stretch: time-lapse through it (fast, then easing off) so that no more
      // than ~half a second of real time passes with nothing happening, and arrive
      // just before the next action plays at the chosen speed
      const slow = this.speed < 10 ? 20e3 : 0; // real time still skips idle minutes, not seconds
      const quiet = next - this.t - (250 * this.speed + slow);
      if (next !== Infinity && quiet > simDt + 300 * this.speed + slow) {
        const ff = Math.max(simDt, quiet * Math.min(1, dt * 8));
        this.warped += ff - simDt; simDt = ff;
        this.gapNote = performance.now();
        this.els.gap.textContent = `⏩ fast-forwarding quiet time · ${dur(this.warped)}`;
      }
      this.t += simDt;
      if (next === Infinity && this.t >= this.tl.liveEdge) { this.goLive(); return; }
      this.dispatchHistory();
      this.tl.setCursor(this.t);
      // drones of sessions that went quiet fly home
      for (const [sid, ts] of this.lastSim) if (this.t - ts > ACTIVE_WINDOW) { this.actors.retire(sid); this.lastSim.delete(sid); }
    } else simDt = 0;
    if (simDt > 0) this.world.decayWarm(Math.exp(-simDt / WARM_TAU));
    if (this.layer === 'domain') { if (this.uiTick % 15 === 0 || !this.domainActive) this.domainActive = this.codeAtWork(); this.domain.setActive(this.domainActive); }
    if (this.layer === 'schematic') { this.schem.setTime(this.t); this.schem.setActive(this.world.working.map(w => ({ tt: w.tt, ti: w.ti, color: '#' + w.color.getHexString() }))); }
    if (performance.now() - this.gapNote > 2500 && this.els.gap.textContent) { this.els.gap.textContent = ''; this.warped = 0; }
    if ((this.uiTick++ % 15) === 0) { this.updateClock(); this.placeTags(); if (this.mode === 'replay' && this.playing && this.uiTick % 60 === 1) { this.renderSessions(); this.renderLog(); } }
    else this.placeTags();
  };

  // Sessions at work and the code they work on, for the domain map: the place they are on when it is a
  // file or module, else (running a command, reading the web) the last file or module they touched,
  // so a session shows on its isle the whole time it works, not only while it edits.
  private domainActive: { tt: number; ti: number; color: string }[] | null = null;
  private codeAtWork() {
    const out: { tt: number; ti: number; color: string }[] = [];
    const ev = this.data.events, since = this.t - 30 * 60e3;
    const sids = this.mode === 'live'
      ? [...this.liveSessions.values()].filter(s => s.state === 'working' || s.state === 'needs-you').map(s => s.id)
      : [...this.lastSim].filter(([, ts]) => this.t - ts < ACTIVE_WINDOW).map(([sid]) => sid);
    for (const sid of sids) {
      const si = this.sIndex.get(sid); if (si == null) continue;
      let place = this.lastPlace.get(sid);
      if (!place || place[0] > 1) {
        place = undefined;
        for (let i = Math.min(this.cursor, ev.ts.length) - 1; i >= 0 && ev.ts[i] > since; i--) if (ev.s[i] === si && (ev.tt[i] === 0 || ev.tt[i] === 1)) { place = [ev.tt[i], ev.ti[i]]; break; }
      }
      if (place) out.push({ tt: place[0], ti: place[1], color: this.colorStr[si] });
    }
    return out;
  }

  private dispatchHistory() {
    const ev = this.data.events;
    const quick = this.speed >= 300;
    while (this.cursor < ev.ts.length && ev.ts[this.cursor] <= this.t) {
      const i = this.cursor++;
      const sid = this.data.sessions[ev.s[i]].id;
      this.lastSim.set(sid, ev.ts[i]);
      const agent = ev.a[i] >= 0 ? this.data.agents[ev.a[i]].id : null;
      const kind = this.data.kinds[ev.k[i]];
      const fx = this.fxBudget-- > 0;
      this.actors.act(sid, this.colors[ev.s[i]], agent, kind, ev.tt[i], ev.ti[i], quick, fx);
      if (fx && !quick) this.world.life.act(sid, agent, kind, ev.tt[i], ev.ti[i], this.colors[ev.s[i]]);
      this.noteAction(sid, ev.s[i], kind, ev.tt[i], ev.ti[i], ev.ts[i]);
    }
    // commits passed since the last frame: a train each
    for (const c of this.city.commits) if (c.ts > this.lastCommitT && c.ts <= this.t) { if (!quick) this.world.life.commit(c.n); this.world.setTicker(c.s); }
    this.lastCommitT = this.t;
    this.world.setTime(this.t, true);
  }

  // Births the history knows better than the scan, and traffic on the road the session took.
  private noteAction(sid: string, si: number, kind: string, tt: number, ti: number, ts: number) {
    if (tt < 0) return;
    if (kind === 'write' || tt !== 0) this.world.noteBirth(tt, ti, ts);
    const place = this.world.placeOf(tt, ti);
    const prev = this.prevPlace.get(sid);
    if (place && prev && (prev[0] !== place[0] || prev[1] !== place[1])) { this.world.travel(prev, place, this.colors[si]); this.schem.travel(prev, place, this.colorStr[si]); }
    if (place) this.prevPlace.set(sid, place);
  }

  // ---------------------------------------------------------------- live
  private ensureSession(sid: string, ts: number, title?: string | null) {
    let si = this.sIndex.get(sid);
    if (si == null) {
      si = this.data.sessions.length;
      this.data.sessions.push({ id: sid, title: title || sid.slice(0, 8), first: ts, last: ts, prompts: 0, branch: null, entry: null, model: null, cost: 0 });
      this.sIndex.set(sid, si); this.colors.push(new THREE.Color()); this.colorStr.push('');
      this.assignColors();
      this.tl.invalidate();
    }
    const s = this.data.sessions[si];
    s.last = Math.max(s.last, ts);
    return si;
  }

  private onMessage(m: any) {
    if (m.pid && m.pid !== this.pid) return;
    switch (m.type) {
      case 'events': {
        let wrote = false;
        for (const e of m.events as LiveEvent[]) { this.liveEvent(e); if (this.data.kinds[e.k] === 'write') wrote = true; }
        this.tl.invalidate();
        if (wrote) { this.scheduleChanges(); if (this.colorMode === 'recent' || this.colorMode === 'session') this.applyColorMode(); }
        break;
      }
      case 'session': {
        const s = m.session as LiveSession;
        if (s.pid !== this.pid) return;
        const prev = this.liveSessions.get(s.id);
        const isNew = !prev || (prev.state === 'ended') !== (s.state === 'ended');
        this.liveSessions.set(s.id, s);
        // the task log leads with the open sessions: a new state re-sorts it, a new action is written in place
        if (!prev || prev.state !== s.state || isStuck(prev) !== isStuck(s) || !!prev.health !== !!s.health) this.renderLog();
        else { const a = this.els.log?.querySelector(`.task.live[data-sid="${CSS.escape(s.id)}"] .lact`); if (a) a.textContent = this.liveAction(s); }
        this.onSessionHealth(s);
        if (s.title) { const si = this.sIndex.get(s.id); if (si != null) this.data.sessions[si].title = s.title; }
        if (this.mode === 'live') {
          const si = this.ensureSession(s.id, Date.now(), s.title);
          if (isNew) this.assignColors();
          if (s.state === 'ended') this.actors.retire(s.id);
          else { this.actors.drone(s.id, this.colors[si]); this.actors.setNeeds(s.id, s.state === 'needs-you'); this.actors.setLive(s.id, s.state === 'working'); }
        }
        this.renderSessions();
        break;
      }
      case 'task': {
        const t = m.task as TaskT;
        if (!this.taskIndex.has(t.id)) { this.taskIndex.set(t.id, this.data.tasks.length); this.data.tasks.push(t); this.ensureSession(t.s, t.ts); this.tl.indexTasks(); }
        this.renderLog();
        // a new prompt means the previous task is over: its badges can change
        clearTimeout(this.flagsSoon); this.flagsSoon = window.setTimeout(() => this.loadFlags(), 40e3);
        break;
      }
      case 'titles': {
        for (const x of m.titles) { const i = this.taskIndex.get(x.id); if (i != null && x.title) this.data.tasks[i].title = x.title; }
        this.renderLog();
        break;
      }
      case 'alert': this.onAlert(m.alert as Alert); break;
      case 'alert-resolved': {
        const a = this.alerts.find(x => x.id === m.id); if (a) a.resolved = true;
        const el = this.toastEls.get(m.id); if (el) { el.classList.add('out'); setTimeout(() => el.remove(), 600); this.toastEls.delete(m.id); }
        this.renderAlerts();
        break;
      }
      case 'alerts-dismissed': this.alerts = m.ids ? this.alerts.filter(a => !m.ids.includes(a.id)) : []; this.renderAlerts(); break;
      case 'digest': if (this.digestData && m.from === this.digestData.from) this.loadDigest(false, m.error); break;
      case 'city-changed': this.reloadCity(); break;
      case 'optimize': { const o = this.opt; if (o && o.key === m.key && o.box.isConnected) { o.job = m.job; this.renderOpt(); } break; }
    }
  }

  private liveEvent(e: LiveEvent) {
    const si = this.ensureSession(e.s, e.ts);
    const kind = this.data.kinds[e.k];
    if (e.a && !this.agentIndex.has(e.a)) { this.agentIndex.set(e.a, this.data.agents.length); this.data.agents.push({ id: e.a, s: si, desc: null, type: null, first: e.ts, last: e.ts }); }
    if (kind !== 'prompt') {
      // keep history complete so replay and the histogram include live activity
      const ev = this.data.events;
      ev.ts.push(e.ts); ev.s.push(si); ev.a.push(e.a ? this.agentIndex.get(e.a)! : -1); ev.k.push(e.k); ev.tt.push(e.tt); ev.ti.push(e.ti);
      ev.task.push(e.task ? this.taskIndex.get(e.task) ?? -1 : -1);
      if (this.mode === 'replay') return; // will be played when the cursor gets there
      this.cursor = ev.ts.length;
    }
    if (this.mode !== 'live') return;
    this.actors.act(e.s, this.colors[si], e.a, kind, e.tt, e.ti, false, true);
    this.world.life.act(e.s, e.a, kind, e.tt, e.ti, this.colors[si]);
    this.noteAction(e.s, si, kind, e.tt, e.ti, e.ts);
    this.world.setTime(Date.now(), true);
  }

  // A place is born at its first commit, first AI write, first use or creation on disk.
  private applyBirths(from: number, to: number) {
    const ev = this.data.events, w = this.data.kinds.indexOf('write');
    for (let i = from; i < to; i++) if (ev.tt[i] > 0 || (ev.k[i] === w && ev.tt[i] === 0)) this.world.noteBirth(ev.tt[i], ev.ti[i], ev.ts[i]);
  }

  private async reloadCity() {
    // new files appeared: rebuild the world in place, keep the camera
    const city = await api.city(this.pid);
    if (this.disposed) return;
    applyLayout(city);
    this.world.dispose();
    this.city = city; this.tl.o.city = city;
    this.indexFiles();
    this.world = new World(this.stage, city, this.els.overlay);
    this.world.onMoved = this.onPlaceMoved;
    this.actors.world = this.world;
    this.makeSchematic();
    this.domain.setCity(city);
    this.makeMood();
    this.hookLife();
    this.applyBirths(0, this.data.events.ts.length);
    this.world.setLod(this.stage.viewSize);
    this.placeOccluders();
    this.seek(this.mode === 'live' ? Date.now() : this.t);
    this.applyColorMode(); this.updatePins();
  }

  // ---------------------------------------------------------------- alerts
  private async loadAlerts() {
    const r = await api.alerts(this.pid).catch(() => null);
    if (!r || this.disposed) return;
    this.alerts = r.alerts;
    this.renderAlerts();
    // a session still waiting on you keeps its toast after a reload
    for (const a of this.alerts.filter(a => a.kind === 'needs-you' && !a.resolved && Date.now() - a.ts < 2 * 3600e3).reverse()) {
      if (this.liveSessions.get(a.sessions[0])?.state === 'needs-you') this.toast(a);
    }
  }
  private onAlert(a: Alert) {
    this.alerts.unshift(a);
    // an ambulance to where a session keeps failing or goes in circles
    if (a.kind === 'failing' || a.kind === 'loop' || a.kind === 'red-stop') {
      const fi = a.path ? this.fileIndex.get(a.path.toLowerCase()) : undefined;
      const to = fi != null ? [1, this.city.files[fi].m] as [number, number] : a.sessions.map(x => this.prevPlace.get(x)).find(Boolean);
      if (to) this.world.life.emergency(to);
    }
    this.updateWeather();
    this.renderAlerts();
    this.toast(a);
  }
  private openAlerts() { return this.alerts.filter(a => !(a.kind === 'needs-you' && a.resolved)); }
  private toggleDrawer(force?: boolean) {
    const d = this.els.drawer;
    const on = force ?? d.style.display === 'none';
    d.style.display = on ? '' : 'none';
    this.els.bell.classList.toggle('on', on);
    this.root.classList.toggle('drawer-open', on); // the drawer lists the same alerts as the toasts
    if (on) this.renderAlerts();
    this.placeOccluders();
  }
  private renderAlerts() {
    const n = this.openAlerts().length;
    const badge = this.els.bell?.querySelector('.badge') as HTMLElement | null;
    if (badge) { badge.textContent = n ? String(n) : ''; badge.style.display = n ? 'block' : 'none'; }
    this.els.bell?.classList.toggle('hot', this.openAlerts().some(a => a.kind !== 'overlap'));
    const d = this.els.drawer;
    if (!d || d.style.display === 'none') return;
    d.innerHTML = '';
    put(d, h('div', { class: 'dr-head' }, h('b', {}, 'Alerts'), h('span', { class: 'spacer' }),
      this.alerts.length ? h('button', { class: 'chip', onclick: () => { api.dismiss(null, this.pid); } }, 'Dismiss all') : null,
      h('button', { class: 'chip icon', onclick: () => this.toggleDrawer(false) }, '×')));
    if (!this.alerts.length) d.appendChild(h('div', { class: 'empty' }, 'No alerts. Collisions, overlaps and sessions waiting on you collect here until you dismiss them.'));
    const list = h('div', { class: 'dr-list' });
    for (const a of this.alerts) {
      const fi = a.path ? this.fileIndex.get(a.path.toLowerCase()) : undefined;
      list.appendChild(h('div', { class: 'dr-row ' + a.kind + (a.resolved ? ' resolved' : ''), onclick: () => { if (fi != null) this.select({ tt: 0, ti: fi }, true); else if (a.sessions[0]) this.focusOn(a.sessions[0]); } },
        h('div', { class: 'row' }, h('span', { class: 'tk' }, alertKind(a)), h('span', { class: 'when' }, ago(a.ts)),
          h('button', { class: 'x', title: 'Dismiss', onclick: (e: Event) => { e.stopPropagation(); api.dismiss([a.id]); } }, '×')),
        h('div', { class: 'tx' }, a.text + (a.resolved ? ' (answered)' : '')),
        h('div', { class: 'whos' }, ...this.whoChips(a.sessions))));
    }
    d.appendChild(list);
  }
  private whoChips(sids: string[]) {
    return sids.map(sid => { const si = this.sIndex.get(sid); return si != null ? h('span', { class: 'who', style: { '--c': this.colorStr[si] } }, this.data.sessions[si].title) : null; });
  }

  // ---------------------------------------------------------------- panels
  private sessionsAt(): { id: string; si: number; live?: LiveSession; lastTs: number }[] {
    if (this.mode === 'live') {
      return [...this.liveSessions.values()].filter(s => s.state !== 'ended')
        .map(s => ({ id: s.id, si: this.sIndex.get(s.id) ?? -1, live: s, lastTs: s.lastSeen }));
    }
    return [...this.lastSim].map(([id, ts]) => ({ id, si: this.sIndex.get(id)!, lastTs: ts })).sort((a, b) => b.lastTs - a.lastTs);
  }

  renderSessions() {
    if (!this.els.sessions) return;
    const list = this.sessionsAt();
    const e = this.els;
    e.sessHead.innerHTML = '';
    e.sessHead.append(h('span', {}, this.mode === 'live' ? 'Open sessions' : 'At this moment'), h('span', { class: 'count' }, list.length));
    e.sessions.innerHTML = '';
    if (!list.length) e.sessions.appendChild(h('div', { class: 'empty' }, this.mode === 'live' ? 'No open sessions in this project. Start Claude Code here and it will appear.' : 'No session active at this moment.'));
    if (this.mode === 'live') {
      // grouped by what they need from you; the longest wait first. Sessions going in
      // circles (edit loop, a check failing again and again, cost far over the usual)
      // get their own group right under "Needs you".
      const stuck = new Set(list.filter(s => s.live!.state !== 'needs-you' && isStuck(s.live!)).map(s => s.id));
      for (const [state, label] of [STATE_ORDER[0], ['stuck', 'Stuck?'], ...STATE_ORDER.slice(1)]) {
        const g = list.filter(s => state === 'stuck' ? stuck.has(s.id) : s.live!.state === state && !stuck.has(s.id))
          .sort((a, b) => state === 'working' || state === 'stuck' ? b.lastTs - a.lastTs : a.live!.since - b.live!.since);
        if (!g.length) continue;
        e.sessions.appendChild(h('div', { class: 'sgroup ' + state, title: state === 'stuck' ? 'Editing the same file again and again, a check failing 3+ times in a row, or a task costing 4× your usual' : '' }, label, h('span', {}, g.length)));
        for (const s of g) e.sessions.appendChild(this.sessionCard(s));
      }
    } else for (const s of list) e.sessions.appendChild(this.sessionCard(s));
    if (this.hoverSid && this.world) { if (list.some(s => s.id === this.hoverSid)) this.markSession(this.hoverSid); else { this.hoverSid = null; this.world.setMarks([]); } }
  }

  private sessionCard(s: { id: string; si: number; live?: LiveSession; lastTs: number }) {
    const meta = s.si >= 0 ? this.data.sessions[s.si] : null;
    const color = s.si >= 0 ? this.colorStr[s.si] : '#888';
    const L = s.live;
    const state = L ? L.state : 'replay';
    let actionText = '';
    let promptText = L?.prompt || '';
    if (L?.needs?.msg) actionText = L.needs.msg;
    else if (L?.action) actionText = `${VERB[L.action.kind] || 'Using'} ${L.action.path ? tail(L.action.path, 2) : L.action.target || L.action.detail || L.action.tool}`;
    if (!L) {
      const task = this.currentTask(s.id);
      if (task) promptText = task.title || task.prompt;
      const last = this.lastEventOf(s.si);
      if (last) actionText = last.label ? `${VERB[last.kind] || last.kind} ${last.label}` : last.kind === 'cmd' ? 'Running a command' : VERB[last.kind] || last.kind;
    }
    const fp = L ? this.footprint(s.id) : [];
    const card = h('div', { class: 'scard' + (this.focusSession === s.id ? ' focus' : ''), style: { '--c': color },
      onclick: () => this.focusOn(this.focusSession === s.id ? null : s.id),
      onmouseenter: () => { this.hoverSid = s.id; this.markSession(s.id); } },
      h('div', { class: 'stitle' }, meta?.title || L?.title || s.id.slice(0, 8)),
      h('div', { class: 'row' },
        L ? h('span', { class: 'state ' + state }, stateLabel(state)) : null,
        meta?.entry === 'codex' ? h('span', { class: 'via', title: 'An OpenAI Codex CLI session' }, 'Codex') : null,
        h('span', { class: 'since' }, L ? dur(Date.now() - L.since) : 'last action ' + dur(this.t - s.lastTs) + ' before'),
        L && L.agents.length ? h('span', { class: 'agents' }, `+${L.agents.length} subagent${L.agents.length > 1 ? 's' : ''}`) : null,
        meta?.cost ? h('span', { class: 'cost', title: 'API-equivalent cost of this session so far' }, money(meta.cost)) : null,
        L && !L.hooks ? h('span', { class: 'nohooks', title: 'State inferred from the transcript; hooks give instant updates' }, 'transcript') : null),
      actionText ? h('div', { class: 'action' + (L?.needs ? ' needs' : '') }, actionText) : null,
      promptText ? h('div', { class: 'prompt' }, promptText) : null,
      L?.health ? this.healthLine(L.health) : null,
      fp.length ? h('div', { class: 'fprint' },
        h('div', { class: 'fp-h' }, `${fp.length} uncommitted file${fp.length > 1 ? 's' : ''}`, fp.some(f => f.shared) ? h('span', { class: 'shared' }, ' · some shared with other sessions') : null),
        ...fp.slice(0, 4).map(f => h('div', { class: 'frow' + (f.ti != null ? ' link' : '') + (f.shared ? ' shared' : ''), title: f.shared ? 'Another session also wrote this file' : f.p,
          onclick: f.ti != null ? (ev: Event) => { ev.stopPropagation(); this.select({ tt: 0, ti: f.ti! }, true); } : null }, h('span', { class: 'fp' }, f.p))),
        fp.length > 4 ? h('div', { class: 'more' }, `+${fp.length - 4} more`) : null) : null);
    return card;
  }

  // Hovering a card lights what the session changed (or, if nothing is uncommitted, where it worked lately).
  private markSession(sid: string) {
    const si = this.sIndex.get(sid); if (si == null) return;
    const color = this.colors[si];
    let marks = this.footprint(sid).filter(f => f.ti != null).map(f => ({ tt: 0, ti: f.ti!, color }));
    if (!marks.length) {
      const ev = this.data.events, seen = new Set<string>(), since = (this.mode === 'live' ? Date.now() : this.t) - 30 * 60e3;
      for (let i = Math.min(this.cursor, ev.ts.length) - 1; i >= 0 && ev.ts[i] > since && marks.length < 12; i--) {
        if (ev.s[i] !== si || ev.tt[i] < 0) continue;
        const k = ev.tt[i] + ':' + ev.ti[i]; if (seen.has(k)) continue; seen.add(k);
        marks.push({ tt: ev.tt[i], ti: ev.ti[i], color });
      }
    }
    this.world.setMarks(marks);
  }

  // How the session's current task is going: each check's last result, the file it
  // keeps rewriting, and its cost against the project's usual task.
  private healthLine(H: NonNullable<LiveSession['health']>) {
    const bits: HTMLElement[] = [];
    for (const k of ['test', 'types', 'build', 'lint'] as const) {
      const c = H.checks[k]; if (!c) continue;
      bits.push(h('span', { class: 'hc ' + (c.ok ? 'ok' : 'bad'), title: c.ok ? `${CHECK_NAME[k]} passed ${ago(c.ts)}` : (c.res || `${CHECK_NAME[k]} failed`) },
        h('i', {}), CHECK_NAME[k], c.ok ? '' : c.fails > 1 ? ` failing ×${c.fails}` : ' failing'));
    }
    if (H.loop) bits.push(h('span', { class: 'hc warn', title: H.loop.path }, `↻ ${tail(H.loop.path, 1)} ×${H.loop.n} in ${H.loop.mins}m`));
    if (H.median > 0 && H.ratio >= 2) bits.push(h('span', { class: 'hc ' + (H.ratio >= 4 ? 'bad' : 'warn'), title: `This task: ${money(H.cost)}. Your usual task: ${money(H.median)}` }, `${money(H.cost)} · ${H.ratio.toFixed(H.ratio < 10 ? 1 : 0)}× usual`));
    return bits.length ? h('div', { class: 'shealth' }, ...bits) : null;
  }

  private lastEventOf(si: number) {
    const ev = this.data.events;
    for (let i = this.cursor - 1; i >= 0 && ev.ts[i] > this.t - ACTIVE_WINDOW; i--) {
      if (ev.s[i] !== si) continue;
      return { kind: this.data.kinds[ev.k[i]], label: this.placeLabel(ev.tt[i], ev.ti[i]) };
    }
    return null;
  }
  private currentTask(sid: string) {
    let best: TaskT | null = null;
    for (const t of this.data.tasks) if (t.s === sid && t.ts <= this.t && (!best || t.ts > best.ts)) best = t;
    return best;
  }
  placeLabel(tt: number, ti: number) {
    const c = this.city;
    if (tt === 0) return tail(c.files[ti]?.p || '', 2);
    if (tt === 1) return c.modules[ti]?.label || '';
    if (tt === 2) return c.districts[ti]?.name || '';
    if (tt === 3) return c.externals[ti]?.id === 'remote:*' ? 'the web' : c.externals[ti]?.label || '';
    return '';
  }

  renderLog() {
    const e = this.els;
    if (!e.log) return;
    const q = this.logQuery;
    const tasks = this.data.tasks;
    const out: HTMLElement[] = [];
    e.filterChip.innerHTML = '';
    if (this.focusSession) {
      const si = this.sIndex.get(this.focusSession)!;
      e.filterChip.append(h('span', { class: 'fchip', style: { '--c': this.colorStr[si] } }, 'Session: ' + (this.data.sessions[si]?.title || ''), h('button', { onclick: () => this.focusOn(null) }, '×')));
    }
    const limitT = this.mode === 'live' ? Infinity : this.t;
    // live: each open session's current task leads the log, marked with what the session is doing
    // (the sessions column is hidden on the domain map, so this is where they show there)
    const now = this.liveNow();
    const pinned = new Set(now.map(x => x.t));
    if (now.length) {
      out.push(h('div', { class: 'sgroup working' }, 'Now', h('span', {}, now.length)));
      for (const x of now) if (!q || ((x.t.title || '') + ' ' + x.t.prompt).toLowerCase().includes(q)) out.push(this.taskRow(x.t, x.s));
      out.push(h('div', { class: 'sgroup' }, 'Earlier'));
    }
    for (let i = tasks.length - 1; i >= 0 && out.length < 250; i--) {
      const t = tasks[i];
      if (t.ts > limitT || pinned.has(t)) continue;
      if (this.focusSession && t.s !== this.focusSession) continue;
      if (q && !((t.title || '') + ' ' + t.prompt).toLowerCase().includes(q)) continue;
      out.push(this.taskRow(t));
    }
    e.log.innerHTML = '';
    if (!out.length) e.log.appendChild(h('div', { class: 'empty' }, q ? 'No task matches.' : 'No tasks yet.'));
    e.log.append(...out);
  }

  // The open sessions' current tasks (live only), the ones that need you first, then working, then your turn.
  private liveNow(): { t: TaskT; s: LiveSession }[] {
    if (this.mode !== 'live') return [];
    const rank = (s: LiveSession) => s.state === 'needs-you' ? 0 : isStuck(s) ? 1 : s.state === 'working' ? 2 : 3;
    const out: { t: TaskT; s: LiveSession }[] = [];
    for (const s of this.liveSessions.values()) {
      if (!['needs-you', 'working', 'waiting'].includes(s.state)) continue;
      if (this.focusSession && s.id !== this.focusSession) continue;
      let best: TaskT | null = null;
      for (let i = this.data.tasks.length - 1; i >= 0; i--) { const t = this.data.tasks[i]; if (t.s === s.id && (!best || t.ts > best.ts)) best = t; }
      if (best) out.push({ t: best, s });
    }
    return out.sort((a, b) => rank(a.s) - rank(b.s) || b.s.lastSeen - a.s.lastSeen);
  }
  private liveAction(L: LiveSession) {
    if (L.needs?.msg) return L.needs.msg;
    return L.action ? `${VERB[L.action.kind] || 'Using'} ${L.action.path ? tail(L.action.path, 2) : L.action.target || L.action.detail || L.action.tool}` : '';
  }
  private taskRow(t: TaskT, L?: LiveSession) {
    const si = this.sIndex.get(t.s) ?? -1;
    const active = t.ts <= this.t && this.t <= (t.end || t.ts) + 60e3;
    const [r, w, c, x, a] = t.n;
    const st = L ? (L.state !== 'needs-you' && isStuck(L) ? 'stuck' : L.state) : null, act = L ? this.liveAction(L) : '';
    return h('div', { class: 'task' + (active ? ' active' : '') + (L ? ' live ' + st : ''), 'data-sid': L ? L.id : null, style: { '--c': si >= 0 ? this.colorStr[si] : '#888' }, onclick: () => this.openTask(t) },
      h('div', { class: 'row' }, h('span', { class: 'dot' }),
        L ? h('span', { class: 'state ' + (st === 'stuck' ? 'needs-you' : st), title: st === 'stuck' ? 'Editing the same file again and again, a check failing 3+ times in a row, or a task costing 4× your usual' : '' }, st === 'stuck' ? 'Stuck?' : stateLabel(st!)) : null,
        h('span', { class: 'when' }, shortTime(t.ts)), h('span', { class: 'len' }, L ? dur(Date.now() - L.since) : dur((t.end || t.ts) - t.ts))),
      h('div', { class: t.title ? 'ttitle' : 'ttitle pending' }, t.title || t.prompt.slice(0, 120)),
      L ? h('div', { class: 'lact' + (L.needs ? ' needs' : '') }, act) : null,
      L?.health ? this.healthLine(L.health) : null,
      h('div', { class: 'counts' }, w ? h('span', { class: 'w' }, `✎ ${w}`) : null, r ? h('span', { class: 'r' }, `◉ ${r}`) : null,
        c ? h('span', { class: 'c' }, `⌘ ${c}`) : null, x ? h('span', { class: 'x' }, `⇡ ${x}`) : null, a ? h('span', { class: 'a' }, `⧉ ${a}`) : null,
        t.cost ? h('span', { class: 'm', title: 'API-equivalent cost' }, money(t.cost)) : null,
        ...this.taskBadges(t.id)));
  }

  // What went wrong with a task, as small badges on its log row.
  private flags: TaskFlags = {};
  private flagsSoon = 0;
  private async loadFlags() {
    const r = await api.taskFlags(this.pid).catch(() => null);
    if (!r || this.disposed) return;
    this.flags = r;
    this.renderLog();
  }
  private taskBadges(id: string) {
    const f = this.flags[id]; if (!f) return [];
    return [
      f.u ? h('span', { class: 'tb bad', title: 'Wrote code but no test, type check or build passed afterwards in this task' }, 'untested') : null,
      f.d >= 3 ? h('span', { class: 'tb warn', title: 'Wrote into this many areas of the city; wide tasks are harder to review' }, `${f.d} areas`) : null,
      f.r >= 2 ? h('span', { class: 'tb warn', title: `${f.r} of the ${f.f} files it wrote were rewritten by another task within 3 days` }, `reworked ${f.r}`) : null,
    ];
  }

  // A file over 12 weeks: its size in lines, and how often it was committed and
  // edited by sessions, with one line saying what that adds up to.
  private fileTrend(p: string) {
    const box = h('div', { class: 'sect ftrend' }, h('h3', {}, 'Last 12 weeks'), h('div', { class: 'loading-sm' }, '…'));
    api.fileHist(this.pid, p).then(d => {
      box.lastChild!.remove();
      if (!d.weeks.some(w => w.lines || w.writes || w.commits)) { box.append(h('div', { class: 'empty' }, 'No history in the last 12 weeks.')); return; }
      const W = 300, H = 34, n = d.weeks.length, maxL = Math.max(1, ...d.weeks.map(w => w.lines)), maxA = Math.max(1, ...d.weeks.map(w => w.writes + w.commits));
      const x = (i: number) => (i + 0.5) * W / n;
      const pts = d.weeks.map((w, i) => `${x(i).toFixed(1)},${(H - 2 - (H - 6) * w.lines / maxL).toFixed(1)}`).join(' ');
      const bars = d.weeks.map((w, i) => {
        const hw = (H - 4) * w.writes / maxA, hc = (H - 4) * w.commits / maxA, bw = W / n * 0.62, x0 = x(i) - bw / 2;
        return `<rect x="${x0}" y="${H - hw}" width="${bw}" height="${hw}" fill="#111111" opacity=".8"><title>${12 - i} weeks ago: ${w.writes} AI edits</title></rect>`
          + `<rect x="${x0}" y="${H - hw - hc}" width="${bw}" height="${hc}" fill="#bdbdbd"><title>${w.commits} commits</title></rect>`;
      }).join('');
      const lines = h('div', { class: 'spark' }); lines.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#111111" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
      const act = h('div', { class: 'spark' }); act.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
      // a file with no lines at the start of the window was created inside it
      const first = d.weeks[0].lines, edits = d.weeks.reduce((s, w) => s + w.writes, 0), busy = d.weeks.filter(w => w.writes).length;
      const grew = d.lines - first;
      const verdict = [!first ? `New in these weeks: ${d.lines} lines` : grew ? `${grew > 0 ? 'Grew' : 'Shrank'} ${Math.abs(grew)} lines (${grew > 0 ? '+' : ''}${Math.round(grew / first * 100)}%)` : 'Same size',
        edits ? `edited by sessions ${edits}× in ${busy} of 12 weeks` : 'no session edits'].join(' · ');
      box.append(h('div', { class: 'ft-row' }, h('span', { class: 'k' }, `Lines · ${d.lines}`), lines),
        h('div', { class: 'ft-row' }, h('span', { class: 'k' }, h('i', { style: { background: '#111111' } }), 'AI edits ', h('i', { style: { background: '#bdbdbd' } }), 'commits'), act),
        h('div', { class: 'sub' }, verdict));
    }).catch(() => { box.lastChild?.remove(); box.append(h('div', { class: 'empty' }, 'Could not read its history.')); });
    return box;
  }

  private async openTask(t: TaskT) {
    this.tab('inspect');
    const e = this.els.inspect;
    const si = this.sIndex.get(t.s) ?? -1;
    e.innerHTML = '';
    e.appendChild(h('div', { class: 'loading-sm' }, 'Loading task…'));
    const d = await api.task(this.pid, t.id);
    const root = this.city.project.root.toLowerCase() + '/';
    const relp = (p: string) => p.toLowerCase().startsWith(root) ? p.slice(root.length) : p;
    const byKind = (k: string[]) => { const m = new Map<string, number>(); for (const x of d.events) if (k.includes(x.kind) && (x.path || x.target)) { const key = x.path ? relp(x.path) : x.target!; m.set(key, (m.get(key) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
    const fileLink = (p: string, n: number) => {
      const fi = this.fileIndex.get(p.toLowerCase());
      return h('div', { class: 'frow' + (fi != null ? ' link' : ''), onclick: fi != null ? () => this.select({ tt: 0, ti: fi }, true) : null }, h('span', { class: 'fp' }, p), n > 1 ? h('span', { class: 'n' }, '×' + n) : null);
    };
    const writes = byKind(['write']), reads = byKind(['read', 'search']), remotes = byKind(['remote', 'skill']);
    const cmds = d.events.filter(x => x.kind === 'cmd');
    e.innerHTML = '';
    put(e,
      h('div', { class: 'ihead', style: { '--c': si >= 0 ? this.colorStr[si] : '#888' } },
        h('div', { class: 'kicker' }, h('span', { class: 'dot' }), this.data.sessions[si]?.title || 'Session', ' · ', clock(d.ts)),
        h('h2', {}, d.title || 'Untitled task'),
        h('div', { class: 'sub' }, `${dur((d.end || d.ts) - d.ts)} · ${d.events.length} actions`,
          d.cost ? ` · ${money(d.cost)} API-equiv. (${fmtTokens(d.tokens.in)} in, ${fmtTokens(d.tokens.out)} out)` : ''),
        h('div', { class: 'btns' },
          h('button', { class: 'chip', onclick: () => { this.setMode('replay'); this.seek(d.ts - 5e3); this.tl.zoomTo(d.ts, d.end || d.ts); this.speed = Math.max(10, Math.min(300, Math.round(((d.end || d.ts) - d.ts) / 20e3))); (this.els.speed as HTMLSelectElement).value = String(SPEEDS.reduce((a, b) => Math.abs(b - this.speed) < Math.abs(a - this.speed) ? b : a)); this.speed = Number((this.els.speed as HTMLSelectElement).value); this.play(true); } }, '▶ Replay task'),
          h('button', { class: 'chip', onclick: () => this.focusOn(t.s) }, 'Follow session'))),
      h('div', { class: 'sect' }, h('h3', {}, 'Prompt'), h('div', { class: 'ptext' }, d.prompt)),
      writes.length ? h('div', { class: 'sect' }, h('h3', {}, `Changed (${writes.length})`), ...writes.slice(0, 60).map(([p, n]) => fileLink(p, n))) : null,
      reads.length ? h('div', { class: 'sect' }, h('h3', {}, `Read (${reads.length})`), ...reads.slice(0, 40).map(([p, n]) => fileLink(p, n))) : null,
      remotes.length ? h('div', { class: 'sect' }, h('h3', {}, `Outside systems (${remotes.length})`), ...remotes.slice(0, 30).map(([p, n]) => h('div', { class: 'frow' }, h('span', { class: 'fp' }, p), n > 1 ? h('span', { class: 'n' }, '×' + n) : null))) : null,
      cmds.length ? h('div', { class: 'sect' }, h('h3', {}, `Commands (${cmds.length})`), ...cmds.slice(0, 40).map(x => h('div', { class: 'crow' }, x.detail || x.tool))) : null,
    );
  }

  // A commit: the session that committed it, the tasks that wrote its files, the files.
  private async openCommit(hash: string) {
    this.tab('inspect');
    const e = this.els.inspect;
    e.innerHTML = '';
    e.appendChild(h('div', { class: 'loading-sm' }, 'Loading commit…'));
    const d = await api.commit(this.pid, hash).catch(() => null);
    e.innerHTML = '';
    if (!d || !d.files) { e.appendChild(h('div', { class: 'empty' }, 'Commit not found in the scanned history.')); return; }
    const taskRow = (t: CommitD_Task) => {
      const ti = this.taskIndex.get(t.id), si = this.sIndex.get(t.s) ?? -1;
      return h('div', { class: 'task mini', style: { '--c': si >= 0 ? this.colorStr[si] : '#888' }, onclick: ti != null ? () => this.openTask(this.data.tasks[ti]) : null },
        h('div', { class: 'row' }, h('span', { class: 'dot' }), h('span', { class: 'when' }, shortTime(t.ts)), h('span', { class: 'len' }, `${t.files} of its files`)),
        h('div', { class: 'ttitle' }, t.title || t.prompt || '(no prompt)'));
    };
    put(e,
      h('div', { class: 'ihead' }, h('div', { class: 'kicker' }, h('i', { class: 'diamond' }), 'Commit ', h('span', { class: 'mono' }, d.h), ' · ', clock(d.ts)),
        h('h2', {}, d.s || '(no message)'), h('div', { class: 'sub' }, `${d.files.length} files`),
        h('div', { class: 'btns' }, h('button', { class: 'chip', onclick: () => { this.setMode('replay'); this.seek(d.ts - 30 * 60e3); this.tl.zoomTo(d.ts - 3 * 3600e3, d.ts + 600e3); } }, '◷ Go to this moment'))),
      d.committers.length ? h('div', { class: 'sect' }, h('h3', {}, 'Committed by'), h('div', { class: 'whos' }, ...this.whoChips(d.committers).map((c, i) => c && Object.assign(c, { onclick: () => this.focusOn(d.committers[i]) })))) : null,
      h('div', { class: 'sect' }, h('h3', {}, `Tasks that wrote its files (${d.tasks.length})`),
        d.tasks.length ? d.tasks.map(taskRow) : h('div', { class: 'empty' }, 'No session wrote these files in the two days before the commit.')),
      h('div', { class: 'sect' }, h('h3', {}, `Files (${d.files.length})`), ...d.files.slice(0, 80).map(p => {
        const fi = this.fileIndex.get(p.toLowerCase());
        return h('div', { class: 'frow' + (fi != null ? ' link' : ''), onclick: fi != null ? () => this.select({ tt: 0, ti: fi }, true) : null }, h('span', { class: 'fp' }, p));
      })));
  }

  // ---------------------------------------------------------------- digest
  private async loadDigest(summarize = false, error?: string) {
    const e = this.els.digest;
    const from = this.digestDay, to = from + DAY - 1;
    if (!this.digestData || this.digestData.from !== from) { e.innerHTML = ''; e.appendChild(h('div', { class: 'loading-sm' }, 'Loading…')); }
    const d = await api.digest(this.pid, from, to, summarize).catch(() => null);
    if (!d || this.disposed || from !== this.digestDay) return;
    this.digestData = d;
    this.renderDigest(error);
  }
  private renderDigest(error?: string) {
    const d = this.digestData!, e = this.els.digest;
    const today = startOfDay(Date.now());
    const label = d.from === today ? 'Today' : d.from === today - DAY ? 'Yesterday' : new Date(d.from).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const go = (delta: number) => { this.digestDay = startOfDay(this.digestDay + delta * DAY + DAY / 2); this.tiesShown = null; this.world.showTies(null); this.loadDigest(); };
    const tieList = (list: Tie[], which: 'day' | 'week') => list.length ? h('div', { class: 'sect' },
      h('h3', {}, which === 'day' ? `New connections (${list.length})` : `New connections this week (${list.length})`,
        h('button', { class: 'chip mini' + (this.tiesShown === which ? ' on' : ''), onclick: () => { this.tiesShown = this.tiesShown === which ? null : which; this.world.showTies(this.tiesShown ? list : null); this.renderDigest(); } }, this.tiesShown === which ? 'Hide on map' : 'Show on map')),
      ...list.map(t => h('div', { class: 'frow link tie', onclick: () => this.select({ tt: t.a[0], ti: t.a[1] }, true) },
        h('span', { class: 'fp' }, `${t.an} → ${t.bn}`), h('span', { class: 'n' }, `${t.why} · ${shortTime(t.born)}`)))) : null;
    e.innerHTML = '';
    put(e,
      h('div', { class: 'dg-nav' }, h('button', { class: 'chip icon', onclick: () => go(-1) }, '‹'), h('b', {}, label),
        h('button', { class: 'chip icon', disabled: d.from >= today, onclick: () => go(1) }, '›')),
      h('div', { class: 'stats' }, stat('Tasks', d.tasks.length), stat('Sessions', d.sessions.length), stat('Commits', d.commits.length), stat('API-equiv.', money(d.cost))),
      this.dayHealth(d.from),
      h('div', { class: 'sect' }, h('h3', {}, 'Recap'),
        d.summary ? h('div', { class: 'ptext recap' }, d.summary)
          : !d.tasks.length ? h('div', { class: 'empty' }, 'Nothing happened this day.')
          : d.summarizing ? h('div', { class: 'loading-sm' }, 'Haiku is writing the recap…')
          : h('div', {}, error ? h('div', { class: 'empty' }, 'Could not write the recap: ' + error) : null,
            h('button', { class: 'chip', onclick: () => this.loadDigest(true) }, '✎ Write a recap (Haiku)'))),
      d.modules.length ? h('div', { class: 'sect' }, h('h3', {}, 'Busiest modules'), ...d.modules.map(m => h('div', { class: 'frow link', onclick: () => this.select({ tt: 1, ti: m.i }, true) }, h('span', { class: 'fp ltr' }, m.name), h('span', { class: 'n' }, `✎ ${m.n}`)))) : null,
      d.shared.length ? h('div', { class: 'sect' }, h('h3', { class: 'warn' }, `Edited by several sessions (${d.shared.length})`),
        ...d.shared.map(x => h('div', { class: 'frow link', onclick: () => this.select({ tt: 0, ti: x.i }, true) }, h('span', { class: 'fp' }, x.p), h('span', { class: 'n' }, `${x.sessions.length} sessions`)))) : null,
      tieList(d.ties, 'day'), tieList(d.tiesWeek.filter(t => !d.ties.some(x => x.an === t.an && x.bn === t.bn)), 'week'),
      d.commits.length ? h('div', { class: 'sect' }, h('h3', {}, 'Commits'), ...d.commits.map(c => h('div', { class: 'frow link', onclick: () => this.openCommit(c.h) }, h('span', { class: 'fp ltr' }, c.s), h('span', { class: 'n' }, shortTime(c.ts))))) : null,
      d.tasks.length ? h('div', { class: 'sect' }, h('h3', {}, 'Tasks'), ...d.tasks.slice().reverse().map(t => { const ti = this.taskIndex.get(t.id); return ti != null ? this.taskRow(this.data.tasks[ti]) : null; })) : null);
  }

  // The city's health that day and its move from the day before, with what to do next.
  private dayHealth(from: number) {
    const hd = this.healthData; if (!hd) return null;
    const key = (t: number) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const at = hd.history.find(x => x.day === key(from)), before = hd.history.find(x => x.day === key(from - DAY / 2));
    if (!at) return null;
    const d = before ? at.score - before.score : 0;
    return h('div', { class: 'dg-health' }, 'City health ', h('b', {}, at.score),
      before && d ? h('span', { class: d > 0 ? 'good' : 'bad' }, ` ${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs the day before`) : null,
      from === startOfDay(Date.now()) && hd.tip ? h('div', { class: 'sub' }, hd.tip) : null);
  }

  // ---------------------------------------------------------------- inspect
  // keepTab: a click on the map leaves Review / Insights / Digest open; Inspect fills behind it.
  private async select(s: { tt: number; ti: number } | null, fly = false, keepTab = false) {
    this.selected = s;
    this.world.showSelection(s);
    this.schem?.setSelected(s ? this.placeRef(s) : null);
    if (!s) return;
    if (!keepTab || this.curTab === 'log') this.tab('inspect');
    const e = this.els.inspect;
    e.innerHTML = '';
    const c = this.city;
    const pos = this.world.position(s.tt, s.ti);
    if (fly && pos) this.stage.flyTo(pos.x, pos.z, Math.min(this.stage.viewSize, 40));
    if (s.tt === 0) {
      const f = c.files[s.ti]; const m = c.modules[f.m];
      const imports = c.fileEdges.filter(([a]) => a === s.ti).length, importedBy = c.fileEdges.filter(([, b]) => b === s.ti).length;
      const dirty = this.changes?.files.find(x => x.p.toLowerCase() === f.p.toLowerCase());
      put(e, h('div', { class: 'ihead' }, h('div', { class: 'kicker' }, m.title ? `${m.title} · ${m.id}` : m.id || '(root)'), h('h2', { class: 'mono' }, f.p.split('/').pop()!), h('div', { class: 'sub mono' }, f.p)),
        dirty ? h('div', { class: 'dirty' }, h('b', {}, 'Uncommitted'), dirty.writers.length ? [' · written by ', ...this.whoChips(dirty.writers.map(w => w.s))] : ' · not written by a session') : null,
        h('div', { class: 'stats' },
          stat('Size', bytes(f.size)), stat('Kind', f.kind), stat('Commits', f.churn || '—'), stat('Born', f.born ? new Date(f.born).toLocaleDateString() : '—'),
          stat('AI edits', f.w), stat('AI reads', f.r), stat('Imports', imports), stat('Imported by', importedBy)),
        this.fileTrend(f.p),
        m.desc ? h('div', { class: 'sect' }, h('h3', {}, 'Module'), h('div', { class: 'ptext' }, m.desc)) : null,
        h('div', { class: 'legend-sm' }, h('i', { style: { background: '#ffb547' } }), 'imports', h('i', { style: { background: '#5ee6ff' } }), 'imported by'));
      const box = h('div', { class: 'sect' }, h('h3', {}, 'Tasks that touched it'), h('div', { class: 'loading-sm' }, '…'));
      e.append(box);
      const r = await api.file(this.pid, f.p);
      box.lastChild!.remove();
      if (!r.tasks.length) box.append(h('div', { class: 'empty' }, 'No session has touched this file.'));
      for (const t of r.tasks) {
        const si = this.sIndex.get(t.s) ?? -1;
        const ti = t.id ? this.taskIndex.get(t.id) : undefined;
        box.append(h('div', { class: 'task mini', style: { '--c': si >= 0 ? this.colorStr[si] : '#888' }, onclick: ti != null ? () => this.openTask(this.data.tasks[ti]) : null },
          h('div', { class: 'row' }, h('span', { class: 'dot' }), h('span', { class: 'when' }, shortTime(t.ts)), h('span', { class: 'len' }, t.kinds)),
          h('div', { class: 'ttitle' }, t.title || t.prompt || '(no prompt)')));
      }
    } else if (s.tt === 1) {
      const m = c.modules[s.ti];
      const files = c.files.filter(f => f.m === s.ti);
      const top = [...files].sort((a, b) => (b.w + b.r) - (a.w + a.r)).slice(0, 12);
      const d = c.districts[m.district];
      put(e, h('div', { class: 'ihead' }, h('div', { class: 'kicker' }, m.warehouse ? 'Data warehouse (untracked)' : 'Module',
          d ? [' · ', h('button', { class: 'dlink', style: `--c: hsl(${d.hue} 85% 68%)`, onclick: () => this.select({ tt: 2, ti: m.district }) }, h('i', {}), d.name)] : null),
          h('h2', {}, m.title || m.label), h('div', { class: 'sub mono' }, m.id.replace('#wh:', ''))),
        m.desc ? h('div', { class: 'sect' }, h('div', { class: 'ptext' }, m.desc)) : null,
        h('div', { class: 'stats' }, stat('Files', m.warehouse ? (m.onDisk || m.files) : files.length), stat('AI edits', files.reduce((s, f) => s + f.w, 0)), stat('AI reads', files.reduce((s, f) => s + f.r, 0))),
        m.warehouse ? null : this.optimizeSection('m:' + m.key),
        this.propsSection(m.props, m.kind),
        this.tiesSection(1, s.ti),
        top.length ? h('div', { class: 'sect' }, h('h3', {}, 'Busiest files'), ...top.map(f => h('div', { class: 'frow link', onclick: () => this.select({ tt: 0, ti: c.files.indexOf(f) }, true) }, h('span', { class: 'fp' }, m.id.endsWith('/*') ? f.p : f.p.slice((m.id ? m.id.length + 1 : 0))), h('span', { class: 'n' }, `✎${f.w} ◉${f.r}`)))) : null);
    } else if (s.tt === 2) {
      const d = c.districts[s.ti];
      const blocks = d.members.filter(([t, i]) => t === 1 && !c.modules[i].warehouse).map(([, i]) => i).sort((a, b) => c.modules[b].files - c.modules[a].files);
      const places = d.members.filter(([t, i]) => t === 3 || (t === 1 && c.modules[i].warehouse));
      const fl = c.files.filter(f => c.modules[f.m].district === s.ti);
      put(e, h('div', { class: 'ihead', style: `--c: hsl(${d.hue} 85% 68%)` }, h('div', { class: 'kicker' }, h('span', { class: 'dot' }), 'District'), h('h2', {}, d.name)),
        d.desc ? h('div', { class: 'sect' }, h('div', { class: 'ptext' }, d.desc)) : null,
        h('div', { class: 'stats' }, stat('Blocks', blocks.length), stat('Files', fl.length), stat('AI edits', fl.reduce((n, f) => n + f.w, 0)), stat('AI reads', fl.reduce((n, f) => n + f.r, 0))),
        this.optimizeSection('d:' + d.id),
        this.propsSection(d.props.filter(p => p.k !== 'Data stores' && p.k !== 'Outside systems'), d.kind),
        blocks.length ? h('div', { class: 'sect' }, h('h3', {}, `Blocks (${blocks.length})`), ...blocks.map(i => { const m = c.modules[i]; return h('div', { class: 'frow link', onclick: () => this.select({ tt: 1, ti: i }, true) }, h('span', { class: 'fp ltr' }, m.title || m.label), h('span', { class: 'n' }, `${m.files} files`)); })) : null,
        places.length ? h('div', { class: 'sect' }, h('h3', {}, `Places it uses (${places.length})`), ...places.map(([t, i]) => h('div', { class: 'frow link', onclick: () => this.select({ tt: t, ti: i }, true) },
          h('span', { class: 'fp ltr' }, t === 1 ? (c.modules[i].title || c.modules[i].label) : c.externals[i].label), h('span', { class: 'n' }, t === 1 ? 'data store' : `${c.externals[i].n} calls`)))) : null);
    } else if (s.tt === 3) {
      const x = c.externals[s.ti];
      const kind = x.type === 'local' ? 'Outside the repo, on this machine' : x.type === 'web' ? 'Research on the open web' : x.type === 'host' ? 'Server or website' : 'Service (MCP / tool)';
      const fileRow = (p: string) => { const fi = this.fileIndex.get(p.toLowerCase()); return h('div', { class: 'frow' + (fi != null ? ' link' : ''), onclick: fi != null ? () => this.select({ tt: 0, ti: fi }, true) : null }, h('span', { class: 'fp' }, p)); };
      put(e, h('div', { class: 'ihead' }, h('div', { class: 'kicker' }, kind), h('h2', {}, x.label)),
        h('div', { class: 'stats' }, stat('Calls', x.n), stat('Named in', x.refCount ? `${x.refCount} files` : '—'),
          x.first ? stat('First', new Date(x.first).toLocaleDateString()) : null, x.last ? stat('Last', ago(x.last)) : null),
        this.tiesSection(3, s.ti),
        x.top?.length ? h('div', { class: 'sect' }, h('h3', {}, 'Most visited sites'), ...x.top.map(([site, n]) => h('div', { class: 'frow' }, h('span', { class: 'fp' }, site), h('span', { class: 'n' }, '×' + n)))) : null,
        x.refs.length ? h('div', { class: 'sect' }, h('h3', {}, `Code that names it (${x.refCount})`), ...x.refs.slice(0, 25).map(fileRow)) : null);
    }
  }

  // Optimize a block or district with the project's own model: survey (read-only,
  // a ranked list of changes), pick, apply (a visible session edits), undo.
  private opt: { key: string; box: HTMLElement; job: OptJob | null; model: string | null; pick: Set<string>; planOf: string; busy: { id: string; title: string | null }[] | null; err: string | null } | null = null;
  private optimizeSection(key: string) {
    const box = h('div', { class: 'sect opt' }, h('h3', {}, 'Optimize'), h('div', { class: 'loading-sm' }, '…'));
    const o: NonNullable<CityView['opt']> = { key, box, job: null, model: null, pick: new Set(), planOf: '', busy: null, err: null };
    this.opt = o;
    api.optimize(this.pid, key).then(r => { if (this.opt !== o) return; o.job = r.job; o.model = r.model; this.renderOpt(); })
      .catch(e => { o.err = e.message; this.renderOpt(); });
    return box;
  }

  private renderOpt() {
    const o = this.opt; if (!o) return;
    const j = o.job, model = (j?.model || o.model || '').replace(/^claude-/, '') || 'default model';
    if (j?.plan && o.planOf !== j.id + j.started) { o.planOf = j.id + j.started; o.pick = new Set(j.plan.items.filter(x => x.risk !== 'high').map(x => x.id)); }
    const step = async (s: 'survey' | 'apply' | 'stop' | 'undo', force = false) => {
      o.err = null; o.busy = null;
      const r = await api.optimizeStep(this.pid, s, o.key, s === 'apply' ? { items: [...o.pick], force } : {});
      if (r.busy) o.busy = r.busy; else if (r.error) o.err = r.error;
      if (r.job) o.job = r.job;
      if (s === 'undo' && r.kept?.length) o.err = `Left ${r.kept.length} file(s) alone: edited again after the run.`;
      this.renderOpt();
    };
    const fileLink = (p: string) => { const fi = this.fileIndex.get(p.toLowerCase()); return h('span', { class: 'pv' + (fi != null ? ' link' : ''), onclick: fi != null ? () => this.select({ tt: 0, ti: fi }, true) : null }, tail(p)); };
    const title = (id: string) => j?.plan?.items.find(x => x.id === id)?.title || id;
    const survey = (label: string) => h('button', { class: 'chip', onclick: () => step('survey') }, label);
    const plan = () => {
      const items = j!.plan!.items;
      if (!items.length) return h('div', { class: 'empty' }, 'Nothing worth changing here.');
      const go = h('button', { class: 'chip go', disabled: !o.pick.size, onclick: () => step('apply') }, `Apply ${o.pick.size} selected`);
      return [
        ...items.map(x => h('div', { class: 'opt-item' },
          h('label', {}, h('input', { type: 'checkbox', checked: o.pick.has(x.id), onchange: (ev: Event) => {
            (ev.target as HTMLInputElement).checked ? o.pick.add(x.id) : o.pick.delete(x.id);
            go.textContent = `Apply ${o.pick.size} selected`; go.disabled = !o.pick.size;
          } }), h('b', {}, x.title)),
          h('div', { class: 'opt-tags' }, h('span', { class: 'opt-tag ' + x.impact }, `${x.impact} impact`), h('span', { class: 'opt-tag risk-' + x.risk }, `${x.risk} risk`), x.gain ? h('span', { class: 'opt-tag' }, x.gain) : null, ...x.files.map(fileLink)),
          h('details', {}, h('summary', {}, 'Why and how'), h('div', { class: 'why' }, x.why), h('div', { class: 'how' }, x.change)))),
        o.busy ? h('div', { class: 'dirty' }, h('b', {}, 'Busy'), ` · ${o.busy.map(s => s.title || s.id.slice(0, 8)).join(', ')} is editing files here right now. `,
          h('button', { class: 'chip mini', onclick: () => step('apply', true) }, 'Apply anyway')) : null,
        h('div', { class: 'opt-act' }, go, survey('Survey again'))];
    };
    const body = !j || j.state === 'undone' ? [
        j?.state === 'undone' ? h('div', { class: 'sub' }, 'The last run was undone.') : null,
        h('div', { class: 'sub' }, `${model} reads the busiest files here and lists what is worth optimizing. Nothing changes until you pick items and apply them.`),
        h('div', { class: 'opt-act' }, survey('⚡ Survey for optimizations'))]
      : j.state === 'surveying' ? [h('div', { class: 'loading-sm' }, `${model} is reading ${j.read} of ${j.files} files…`), h('div', { class: 'opt-act' }, h('button', { class: 'chip', onclick: () => step('stop') }, 'Stop'))]
      : j.state === 'applying' ? [h('div', { class: 'loading-sm' }, `A ${model} session is applying ${j.picked?.length || 0} change(s): watch it work in the city.`),
        h('div', { class: 'opt-act' }, h('button', { class: 'chip', onclick: () => step('stop') }, 'Stop'))]
      : j.state === 'applied' ? [
        j.error ? h('div', { class: 'dirty' }, h('b', {}, 'Stopped'), ' · ' + j.error) : null,
        ...(j.result?.done || []).map(x => h('div', { class: 'opt-done' }, h('b', {}, '✓ ' + title(x.id)), h('div', { class: 'sub' }, x.note))),
        ...(j.result?.skipped || []).map(x => h('div', { class: 'opt-done skip' }, h('b', {}, '– ' + title(x.id)), h('div', { class: 'sub' }, x.why))),
        j.result?.note ? h('div', { class: 'ptext' }, j.result.note) : null,
        j.changed?.length || j.created?.length ? h('div', { class: 'opt-tags' }, 'Changed: ', ...[...(j.changed || []), ...(j.created || [])].map(fileLink)) : h('div', { class: 'sub' }, 'No file was changed.'),
        h('div', { class: 'opt-act' }, j.undo ? h('button', { class: 'chip', onclick: () => step('undo') }, '↶ Undo') : null, survey('Survey again'))]
      : [h('div', { class: 'dirty' }, h('b', {}, 'Failed'), ' · ' + (j.error || 'unknown error')), j.plan ? plan() : h('div', { class: 'opt-act' }, survey('Try again'))];
    o.box.innerHTML = '';
    put(o.box, h('h3', {}, 'Optimize', h('span', { class: 'n' }, ` · ${model}${j?.cost ? ' · ' + money(j.cost) : ''}`)),
      j?.plan?.summary && j.state !== 'undone' ? h('div', { class: 'sub' }, j.plan.summary) : null,
      j?.state === 'planned' ? plan() : body,
      o.err ? h('div', { class: 'dirty' }, o.err) : null);
  }

  // Core properties for the role a block or district plays; a value opens a file that shows it.
  private propsSection(props: Prop[], kind: string | null) {
    if (!props?.length) return null;
    // a name list (tables, endpoints) shows its count up front, so no per-value file counts
    const isList = (p: Prop) => !!p.total && p.unit !== 'indexes' && p.unit !== 'cases';
    const row = (p: Prop) => h('div', { class: 'prow' }, h('div', { class: 'pk' }, p.k),
      h('div', { class: 'pvs' }, p.total ? h('b', { class: 'ptot' }, `${p.total.toLocaleString()} ${p.unit || ''}`) : null,
        ...(isList(p) ? p.v.slice(0, 8) : p.v).map(v => {
          const fi = v.f.map(f => this.fileIndex.get(f.toLowerCase())).find(x => x != null);
          const tip = [v.n > 1 ? `in ${v.n} files${v.f.length ? ', e.g.' : ''}` : '', ...v.f].filter(Boolean).join('\n');
          return h('span', { class: 'pv' + (fi != null ? ' link' : ''), title: tip || null, onclick: fi != null ? () => this.select({ tt: 0, ti: fi }, true) : null },
            v.t, v.n > 1 && !isList(p) ? h('i', {}, String(v.n)) : null);
        }),
        isList(p) && p.total! > Math.min(8, p.v.length) && p.v.length > 1 ? h('span', { class: 'pmore' }, `+${p.total! - Math.min(8, p.v.length)} more`) : null));
    const core = props.filter(p => !p.basic), basic = props.filter(p => p.basic);
    return [
      core.length ? h('div', { class: 'sect props' }, h('h3', {}, kind ? `${kind} properties` : 'Properties'), ...core.map(row)) : null,
      basic.length ? h('div', { class: 'sect props' }, h('h3', {}, 'Basics'), ...basic.map(row)) : null];
  }

  // Everything a place is tied to, strongest first, with the reason.
  private tiesSection(tt: number, ti: number) {
    const c = this.city;
    const mine = c.links.filter(l => (l.a[0] === tt && l.a[1] === ti) || (l.b[0] === tt && l.b[1] === ti)).sort((a, b) => b.w - a.w).slice(0, 18);
    if (!mine.length) return null;
    const name = ([t, i]: [number, number]) => t === 1 ? (c.modules[i].title || c.modules[i].label) : c.externals[i].label;
    const why = (l: City['links'][number]) => [l.imp ? `${l.imp} imports` : '', l.ref ? `named in ${l.ref} files` : '', l.task >= 0.5 ? 'worked on together' : '', l.commit >= 0.5 ? 'committed together' : ''].filter(Boolean).join(' · ');
    return h('div', { class: 'sect' }, h('h3', {}, `Connected to (${mine.length})`),
      ...mine.map(l => {
        const other = (l.a[0] === tt && l.a[1] === ti ? l.b : l.a) as [number, number];
        return h('div', { class: 'frow link tie', onclick: () => this.select({ tt: other[0], ti: other[1] }, true) },
          h('i', { class: 'swatch', style: { background: linkColor(l) } }), h('span', { class: 'fp' }, name(other)), h('span', { class: 'n' }, why(l)));
      }));
  }

  focusOn(sid: string | null) {
    this.focusSession = sid;
    if (sid && !this.sIndex.has(sid)) this.focusSession = null;
    if (this.focusSession) this.assignColors();
    this.tl.focusSession = this.focusSession ? this.sIndex.get(this.focusSession) ?? null : null;
    this.tl.invalidate();
    if (this.focusSession) {
      const p = this.actors.focusPos(this.focusSession);
      if (p) this.stage.flyTo(p.x, p.z, Math.min(this.stage.viewSize, 60));
      const s = this.data.sessions[this.sIndex.get(this.focusSession)!];
      if (s && this.mode === 'replay') this.tl.zoomTo(s.first, s.last);
    }
    this.renderSessions(); this.renderLog(); this.tab('log');
  }

  // A place was dragged. The schematic lays itself out, so it stays as it is.
  private onPlaceMoved = () => {
    (this.els.resetLayout as HTMLButtonElement).disabled = false;
  };

  private onClick(x: number, y: number) {
    const folly = this.world.follyAt(x, y); // rides on open ground do a trick instead
    if (folly) { folly.poke(); return; }
    const hit = this.world.pick(x, y);
    this.select(hit, false, true);
    if (!hit && this.curTab === 'inspect') this.tab('log');
  }

  private hoverT = 0;
  private onHoverCity = (ev: PointerEvent) => {
    if (ev.buttons) { this.els.tip.style.opacity = '0'; return; }
    const now = performance.now(); if (now - this.hoverT < 60) return; this.hoverT = now;
    const folly = this.world.follyAt(ev.clientX, ev.clientY);
    if (folly) {
      const tip = this.els.tip;
      this.stage.renderer.domElement.style.cursor = 'pointer';
      tip.innerHTML = `<b>${esc(folly.name)}</b><span class="hint">${esc(folly.hint)}</span>`;
      tip.style.opacity = '1';
      tip.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
      return;
    }
    const hit = this.world.pick(ev.clientX, ev.clientY);
    this.stage.renderer.domElement.style.cursor = hit ? (hit.tt === 2 ? 'pointer' : 'grab') : ''; // places can be dragged, districts only opened
    this.showTip(hit, ev.clientX, ev.clientY);
  };
  private showTip(hit: { tt: number; ti: number } | null, x: number, y: number) {
    const tip = this.els.tip;
    if (!hit) { tip.style.opacity = '0'; return; }
    const c = this.city;
    let html = '';
    if (hit.tt === 0) {
      const f = c.files[hit.ti];
      const dirty = this.changes?.files.find(x => x.p.toLowerCase() === f.p.toLowerCase());
      html = `<b class="mono">${esc(f.p)}</b><span>${bytes(f.size)} · ${f.churn} commits · ✎${f.w} ◉${f.r}</span>${dirty ? `<span class="tt">uncommitted${dirty.writers.length > 1 ? ` · ${new Set(dirty.writers.map(w => w.s)).size} sessions wrote it` : ''}</span>` : ''}`;
    }
    else if (hit.tt === 1) { const m = c.modules[hit.ti]; html = `<b>${esc(m.title || m.label)}</b><span class="mono">${esc(m.id.replace('#wh:', ''))}</span><span>${m.warehouse ? (m.onDisk || m.files) + ' data files' : m.files + ' files'}</span>`; }
    else if (hit.tt === 3) { const x = c.externals[hit.ti]; html = `<b>${esc(x.label)}</b><span>${x.n} calls${x.refCount ? ` · named in ${x.refCount} files` : ''}</span>`; }
    else if (hit.tt === 2) { const d = c.districts[hit.ti]; html = `<b>${esc(d.name)}</b><span>District · click for its properties</span>${d.props.filter(p => !p.basic).slice(0, 3).map(p => `<span>${esc(p.k)}: ${esc(p.v.slice(0, 4).map(v => v.t).join(', '))}</span>`).join('')}`; }
    tip.innerHTML = html;
    tip.style.opacity = '1';
    tip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  }

  private timelineTip(info: { session: number; task: number | null } | null, x: number, y: number) {
    const tip = this.els.tip;
    if (!info) { tip.style.opacity = '0'; return; }
    const s = this.data.sessions[info.session];
    const t = info.task != null ? this.data.tasks[info.task] : null;
    tip.innerHTML = `<b style="color:${this.colorStr[info.session]}">${esc(s.title)}</b><span>${shortTime(s.first)} → ${shortTime(s.last)} · ${s.prompts} prompts${s.cost ? ' · ' + money(s.cost) : ''}</span>${t ? `<span class="tt">${esc(t.title || t.prompt.slice(0, 100))}</span>` : ''}<span class="hint">double-click to follow</span>`;
    tip.style.opacity = '1';
    tip.style.transform = `translate(${Math.min(x + 14, innerWidth - 300)}px, ${y - 90}px)`;
  }
  private commitTip(c: City['commits'][number] | null, x: number, y: number) {
    const tip = this.els.tip;
    if (!c) return;
    tip.innerHTML = `<b>${esc(c.s || '(no message)')}</b><span class="mono">${c.h} · ${shortTime(c.ts)} · ${c.n} files</span><span class="hint">click for the tasks behind it</span>`;
    tip.style.opacity = '1';
    tip.style.transform = `translate(${Math.min(x + 14, innerWidth - 300)}px, ${y - 80}px)`;
  }

  // In-page toast; "needs you" stays until the session is answered or the toast is clicked.
  private toast(a: Alert) {
    if (this.toastEls.has(a.id)) return;
    const el = h('div', { class: 'toast ' + a.kind, onclick: () => { if (a.sessions[0]) this.focusOn(a.sessions[0]); close(); } },
      h('div', { class: 'tk' }, alertKind(a)),
      h('div', { class: 'tx' }, a.text), h('div', { class: 'whos' }, ...this.whoChips(a.sessions)));
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 600); this.toastEls.delete(a.id); };
    this.els.toasts.prepend(el);
    this.toastEls.set(a.id, el);
    if (a.kind !== 'needs-you') setTimeout(close, 12000);
  }

  private tagEls = new Map<string, HTMLElement>();
  private placeTags() {
    const show = this.stage.viewSize < 170;
    const seen = new Set<string>();
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    // lowest drones first, so a tag that would cover another one stacks above it
    if (show) for (const p of this.actors.screenPositions().sort((a, b) => b.y - a.y)) {
      if (p.id.includes('/')) continue;
      const si = this.sIndex.get(p.id); if (si == null) continue;
      seen.add(p.id);
      let el = this.tagEls.get(p.id);
      if (!el) { el = h('div', { class: 'tag' }); this.els.tags.appendChild(el); this.tagEls.set(p.id, el); }
      el.style.setProperty('--c', this.colorStr[si]);
      const L = this.liveSessions.get(p.id);
      const txt = (this.data.sessions[si].title || '').slice(0, 28) + (this.mode === 'live' && L?.state === 'needs-you' ? ' · needs you' : '');
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('needs', this.mode === 'live' && L?.state === 'needs-you');
      el.style.display = p.visible ? '' : 'none';
      if (!p.visible) continue;
      const w = el.offsetWidth + 6, th = el.offsetHeight + 3;
      let bottom = p.y - 22; // tags hang above their drone
      for (let moved = true, n = 0; moved && n < 8; n++) {
        moved = false;
        for (const b of boxes) if (Math.abs(b.x - p.x) * 2 < b.w + w && bottom > b.y - b.h / 2 && bottom - th < b.y + b.h / 2) { bottom = b.y - b.h / 2; moved = true; }
      }
      el.style.transform = `translate(${p.x.toFixed(0)}px, ${bottom.toFixed(0)}px) translate(-50%, -100%)`;
      boxes.push({ x: p.x, y: bottom - th / 2, w, h: th });
    }
    this.world.tagBoxes = boxes;
    for (const [id, el] of this.tagEls) if (!seen.has(id)) { el.remove(); this.tagEls.delete(id); }
  }

  private updateClock() {
    this.els.clock.textContent = clock(this.mode === 'live' ? Date.now() : this.t);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointerdown', this.onLayerOutside, true);
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.changesSoon);
    this.offLive?.();
    this.pulse.dispose();
    this.health?.dispose();
    this.mood?.dispose();
    this.sky?.dispose();
    this.schem?.dispose();
    this.domain?.dispose();
    this.stage?.dispose();
    this.root.remove();
  }
}

type CommitD_Task = { id: string; s: string; ts: number; title: string | null; prompt: string; files: number };
function startOfDay(t: number) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function muted(id: string) { let x = 0; for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) >>> 0; return new THREE.Color().setHSL((x % 360) / 360, 0.16, 0.5); }
function fmtTokens(n: number) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n); }
const ALERT_KIND: Record<Alert['kind'], string> = { collision: 'Same file', overlap: 'Same area', 'needs-you': 'Needs you', loop: 'Going in circles', failing: 'Keeps failing', cost: 'Costly task', 'red-stop': 'Stopped while failing',
  'cold-resume': 'Cold resume', 'context-big': 'Large context', 'topic-switch': 'New topic', compacted: 'Auto-compacted' };
function alertKind(a: Alert) { return ALERT_KIND[a.kind] || a.kind; }
function isStuck(s: LiveSession) {
  const H = s.health; if (!H) return false;
  return !!H.loop && H.loop.n >= 8 || Object.values(H.checks).some(c => c && c.fails >= 3) || (H.median > 0 && H.ratio >= 4 && s.state === 'working');
}
const MILESTONE_OF: Record<string, string> = { sign: 'first-commit', landmark: 'commits-100', fireworks: 'streak-7', aurora: 'streak-30', gold: 'commits-1000' };
function stateLabel(s: string) { return s === 'needs-you' ? 'Needs you' : s === 'working' ? 'Working' : s === 'waiting' ? 'Your turn' : s === 'idle' ? 'Idle' : s; }
function stat(k: string, v: any) { return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v))); }
function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

// Layer tile thumbnails: a little night city, and a little plan.
const BELL = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.2H2.8z"/><path d="M6.6 14.2a1.5 1.5 0 0 0 2.8 0"/></svg>`;
const CITY_THUMB =`<svg viewBox="0 0 64 64"><rect width="64" height="64" fill="#b9c99c"/><path d="M0 40h64M22 0v64M48 0v64" stroke="#8f8f92" stroke-width="5"/><path d="M0 40h64M22 0v64M48 0v64" stroke="#c9a14a" stroke-width=".7" stroke-dasharray="3 3"/><rect x="4" y="8" width="13" height="26" fill="#9fb0c4"/><rect x="27" y="14" width="16" height="20" fill="#b3a5cf"/><rect x="52" y="6" width="9" height="28" fill="#9cc0bc"/><rect x="5" y="46" width="12" height="14" fill="#c9c1a0"/><rect x="27" y="46" width="16" height="13" fill="#9fb0c4"/><g fill="#ffffff"><rect x="7" y="12" width="2" height="2"/><rect x="12" y="18" width="2" height="2"/><rect x="31" y="18" width="2" height="2"/><rect x="37" y="24" width="2" height="2"/><rect x="55" y="12" width="2" height="2"/><rect x="31" y="50" width="2" height="2"/></g><circle cx="35" cy="40" r="1.6" fill="#4fd8ff"/></svg>`;
const DOMAIN_THUMB = `<svg viewBox="0 0 64 64"><rect width="64" height="64" fill="#e9edf0"/><ellipse cx="32" cy="58" rx="30" ry="6" fill="#d3dbc8"/><path d="M21 22 Q32 31 43 24" stroke="#6d5d4b" stroke-width="1.4" fill="none"/><path d="M8 20h18l-9 16z" fill="#8f8270"/><ellipse cx="17" cy="20" rx="9" ry="3.2" fill="#9cbf7f"/><path d="M38 24h20l-10 18z" fill="#8f8270"/><ellipse cx="48" cy="24" rx="10" ry="3.6" fill="#8fc0a6"/><rect x="14" y="13" width="4" height="6" fill="#fff" stroke="#333" stroke-width=".6"/><rect x="45" y="16" width="5" height="7" fill="#fff" stroke="#333" stroke-width=".6"/><path d="M54 22v-9" stroke="#333"/><path d="M54 13h5l-5 3z" fill="#d2232a"/><path d="M17 36v16M48 42v10" stroke="#6a6a6a" stroke-dasharray="2 2"/></svg>`;
const SCHEM_THUMB = `<svg viewBox="0 0 64 64"><rect width="64" height="64" fill="#f7f7f5"/><path d="M0 16h64M0 32h64M0 48h64M16 0v64M32 0v64M48 0v64" stroke="#000" stroke-opacity=".06"/><rect x="5" y="6" width="54" height="26" rx="4" fill="none" stroke="#4a7fc0" stroke-opacity=".5" stroke-dasharray="3 2"/><rect x="9" y="11" width="18" height="11" rx="2" fill="#ffffff" stroke="#4a7fc0"/><rect x="37" y="11" width="18" height="11" rx="2" fill="#ffffff" stroke="#4a7fc0"/><path d="M27 16.5h10" stroke="#d98a1c" stroke-width="1.4"/><path d="M18 22v20h12" stroke="#8a5cf0" stroke-width="1.2" fill="none"/><path d="M46 22v20h-6" stroke="#1798bd" stroke-dasharray="2 2" fill="none"/><path d="M30 42h10" stroke="#8a5cf0" stroke-width="1.2"/><path d="M28 38h8l3 5-3 5h-8l-3-5z" fill="#f5f1fd" stroke="#7f55e0"/></svg>`;
const THUMB: Record<Layer, string> = { domain: DOMAIN_THUMB, city: CITY_THUMB, schematic: SCHEM_THUMB };
