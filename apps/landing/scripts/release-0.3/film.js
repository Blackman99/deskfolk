// The Deskfolk 0.3.0 release film: the reel's cast (Mochi, Pudding and the Reviewer) presents 0.3.0 on the app's own
// surfaces, redrawn. film.seek(t) poses everything from t alone and resolves once the sprites it chose have decoded.
// Timeline (120 BPM, a bar every 2 s, the 0.1.0 film's music edit): 0 0.2.0 turns over to 0.3.0 · 4 Roles: Plain
// (自由) leaves the way of working off · 10 a project session's plan, full screen (the song's breakdown) · 14 a
// project session's background commands, Monitor and subagent · 19 the sidebar's Bots and Projects, a folder's +, a
// session pinned · 24 and more · 26.5 the mark, the URL on the final hit (28.0).
import { clamp, lerp, inv, E, css, h } from '/launch/lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const DURATION = 30.5;
const FPS = 30;
const GY = 905; // the ground line the cast stands on
let SP = null; // sprites.json (the reel's): frames per move, and where the feet are in a frame

// ---------------------------------------------------------------- scale and icons
// The app's surfaces are drawn at k times their size in the app (film.css --k on each surface): the project
// session's window at KW, Roles at KR (wide enough to be Roles' wide layout: over 760 px), the window's sidebar at
// KS, and the closer window of the sidebar scene at KB.
const KW = 1.8, KR = 1.5, KS = 1.25, KB = 1.6;
// The app's one icon set (apps/messenger/src/lib/icons.ts), the shapes this film draws, copied as they are; stroked
// with the app's 1.6 px pen at the role size, so 38.4 / role units of the 24-unit grid. `more` is drawn solid.
const PIN_HEAD = 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z';
const ICONS = {
  x: [{ p: 'M6 6l12 12M18 6 6 18' }],
  check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
  terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
  clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
  'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
  'chevron-right': [{ p: 'm9 6 6 6-6 6' }],
  plus: [{ p: 'M12 5v14M5 12h14' }],
  'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
  list: [{ p: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }],
  folder: [{ p: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z' }],
  paperclip: [{ p: 'm21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
  minimap: [{ r: [3, 3, 18, 18, 2.5] }, { r: [12, 12, 6, 6, 1] }],
  file: [{ p: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z' }, { p: 'M14 3v5h5' }],
  maximize: [{ p: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }],
  minimize: [{ p: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' }],
  pin: [{ p: 'M12 17v5' }, { p: PIN_HEAD }],
  more: [{ c: [5.5, 12, 1.6], f: 1 }, { c: [12, 12, 1.6], f: 1 }, { c: [18.5, 12, 1.6], f: 1 }],
  bot: [{ r: [4, 8, 16, 12, 3] }, { p: 'M12 8V4' }, { c: [9, 14, 1] }, { c: [15, 14, 1] }],
  nodes: [{ c: [5, 6, 2] }, { c: [19, 6, 2] }, { c: [12, 18, 2] }, { p: 'M7 6h10M6 8l5 8M18 8l-5 8' }],
  lock: [{ r: [4.5, 11, 15, 10, 2.5] }, { p: 'M8 11V7.5a4 4 0 0 1 8 0V11' }],
  activity: [{ p: 'M22 12h-4l-3 9L9 3l-3 9H2' }],
  target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1.5] }],
  search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.5-3.5' }]
};
function ic(name, role, k = KW) {
  const px = +(role * k).toFixed(2);
  const shapes = ICONS[name].map(s => s.p ? `<path d="${s.p}"/>` : s.c ? `<circle cx="${s.c[0]}" cy="${s.c[1]}" r="${s.c[2]}"${s.f ? ' fill="currentColor"' : ''}/>`
    : `<rect x="${s.r[0]}" y="${s.r[1]}" width="${s.r[2]}" height="${s.r[3]}" rx="${s.r[4]}"/>`).join('');
  return `<svg class="glyph" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${(38.4 / role).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
}
const I = {
  cta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
  pointer: '<svg viewBox="0 0 22 30" width="44" height="60"><path d="M2.5 2.2v21.6l5.6-5.5 3.6 8.7 3.6-1.5-3.5-8.6h7.8z" fill="#111" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/></svg>'
};
function markSVG(size) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64"><path d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z" fill="#146a7c"/>` +
    `<circle class="mf" cx="25" cy="29" r="10.5" fill="#ffffff"/><circle class="mm" cx="39.5" cy="29" r="10.5" fill="#f0ab3d" stroke="#146a7c" stroke-width="3"/></svg>`;
}
// a mascot's face from its first idle frame; `bot` draws one Bot's picture as the app does, a rounded square
const face = (who, size, bot = false) => `<span class="face${bot ? ' bot' : ''}" style="width:${size}px;height:${size}px;background-image:url(/sprites/${who}/idle/0001.png);background-size:${size * 2.15}px;background-position:50% 64%"></span>`;
// an agent's mark, a plain tile: the app shows the agent's own logo there
const agentMark = `<span class="am">${ic('terminal', 12)}</span>`;
const setHTML = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };

// ---------------------------------------------------------------- the cast
const stage = document.getElementById('stage');
let pending = [];
class Actor {
  constructor(who) {
    this.who = who;
    this.el = h('div', 'mascot', null, stage);
    this.shadow = h('div', 'shadow', null, this.el);
    this.img = h('img', null, null, this.el);
    this.img.decoding = 'sync';
    this.on = false;
  }
  pose({ clip, at, x, y = GY, air = 0, s = 460, flip = false, o = 1, loop = false }) {
    this.on = true;
    const n = SP[this.who][clip];
    let f = Math.floor(at * FPS + 1e-6);
    f = loop ? ((f % n) + n) % n : clamp(f, 0, n - 1);
    const src = `/sprites/${this.who}/${clip}/${String(f + 1).padStart(4, '0')}.png`;
    if (this.img.getAttribute('src') !== src) {
      this.img.setAttribute('src', src);
      pending.push(this.img.decode().catch(() => {}));
    }
    css(this.el, { x: x - s / 2, y: y - air - SP.feetY * s, width: s, height: s, opacity: o });
    this.img.style.transform = flip ? 'scaleX(-1)' : 'none';
    const k = clamp(1 - air / 700, 0.2, 1), sw = s * 0.4 * k;
    css(this.shadow, { left: (s - sw) / 2, top: SP.feetY * s - s * 0.035 * k + air, width: sw, height: s * 0.07 * k, opacity: 0.9 * k });
  }
}
function seq(t, list) {
  let cur = list[0];
  for (const it of list) if (t >= it[0]) cur = it;
  return { clip: cur[1], at: t - cur[0], loop: !!cur[2] };
}
const hopX = (t, t0, a, b) => lerp(a, b, E.inOut(inv(t0 + 0.08, t0 + 0.44, t)));
const show = (el, on) => { el.style.visibility = on ? 'visible' : 'hidden'; return on; };
/** A scene's panel: rises in at a, sinks out by b. */
function panel(el, t, a, b, x, y) {
  if (!show(el, t >= a && t < b)) return false;
  const u = E.out4(inv(a, a + 0.4, t)), o = E.in(inv(b - 0.3, b, t));
  el.style.transformOrigin = '50% 50%';
  css(el, { x, y: y + lerp(40, 0, u) - 24 * o, s: lerp(0.97, 1, u), opacity: Math.min(u, 1 - o) });
  return true;
}
/** Shown from a to b: fades and lifts in at a (a small overshoot when pop), fades out over the last 0.25 s. */
function span(el, t, a, b, { pop = false, dy = 18, d = 0.32, origin = '50% 50%' } = {}) {
  if (!show(el, t >= a && t < b)) return false;
  const u = (pop ? E.pop : E.out4)(inv(a, a + d, t));
  el.style.transformOrigin = origin;
  el.style.translate = `0 ${lerp(dy, 0, E.out4(inv(a, a + d, t))).toFixed(1)}px`;
  el.style.scale = pop ? lerp(0.9, 1, u).toFixed(3) : '1';
  el.style.opacity = Math.min(clamp(inv(a, a + d * 0.5, t)), 1 - E.in(inv(b - 0.25, b, t))).toFixed(3);
  return true;
}
/** What has been typed of `text` by t, typing from a to b. */
const typed = (text, t, a, b) => [...text].slice(0, Math.round([...text].length * clamp(inv(a, b, t)))).join('');
/** A running clock in the app's words: tenths under a minute (formatDurationMs), then minutes and seconds. */
const live = (sec) => sec < 60 ? S.span(sec.toFixed(1)) : S.spanM(Math.floor(sec / 60), Math.floor(sec % 60));

// ---------------------------------------------------------------- DOM
const R = {};
// the window's conversation column (pane coordinates inside .conv): your lines end at XR, the agent's start at X0
const X0 = 40, XR = 840, COMP_Y = 506;

// ---- the sidebar (Sidebar.svelte, SessionRow.svelte, ProjectSessionRow.svelte), drawn at the surface's --k:
// the mark alone at its head with the switches at the far end, then search, the Bots section and Projects, a
// folder and its sessions, each row a Bot's size
function sessionRow(parent, k, { avatar, title, time, status = null, preview = '', on = false, actions = false }) {
  const shell = h('div', 'rshell', null, parent);
  const row = h('div', `row${on ? ' on' : ''}`, `<span class="av">${avatar}</span><span class="t">${title}</span><span class="rt">${time}</span>` +
    `<span class="rs"><i></i><span class="rst"></span></span><span class="s">${preview}</span>`, shell);
  const r = { shell, row, rs: row.querySelector('.rs'), rst: row.querySelector('.rst'), rt: row.querySelector('.rt'), dot: row.querySelector('.adot') };
  if (actions) {
    r.acts = h('div', 'ract', null, shell);
    r.pin = h('span', 'ra', ic('pin', 16, k), r.acts);
    r.more = h('span', 'ra', ic('more', 16, k), r.acts);
  }
  r.status = (kind, label) => {
    r.rs.className = `rs ${kind}`;
    setText(r.rst, label || '');
    row.classList.toggle('busy', kind !== 'idle');
    if (r.dot) r.dot.className = `adot ${kind}`;
  };
  r.status(status ? status[0] : 'idle', status ? status[1] : '');
  return r;
}
// an agent's portrait in the list: a plain tile in a Bot avatar's place, a size smaller, with the run's dot on it
const agentTile = (k, dot = true) => `<span class="atile">${ic('terminal', 16, k)}${dot ? '<i class="adot idle"></i>' : ''}</span>`;
function sidebar(parent, k, { pins = false, bot2 = false } = {}) {
  const sb = h('div', 'sb', null, parent);
  sb.style.setProperty('--k', k);
  const o = { el: sb };
  h('div', 'brand', `${markSVG(22 * k)}<span class="tg">${ic('activity', 20, k)}</span><span class="tg">${ic('target', 20, k)}</span>`, sb);
  if (pins) {
    o.pins = h('div', 'pins', null, sb);
    o.roster = h('div', 'roster', null, o.pins);
    o.pinTile = h('div', 'pin on run', `<span class="pav">${agentTile(k * 0.85, false)}</span><span class="pname">${S.ccTitle}</span>`, o.roster);
  }
  h('div', 'srch', `<span class="si">${ic('search', 16, k)}</span><span>${S.search}</span><kbd>⌘K</kbd>`, sb);
  const list = h('div', 'groups', null, sb);
  h('div', 'ghead', `<span>${S.botsTab}</span><span class="gadd">+</span>`, list);
  o.bot = sessionRow(list, k, { avatar: face('pudding', 40 * k, true), title: S.botName, time: '09:30', preview: S.botPrev });
  if (bot2) o.bot2 = sessionRow(list, k, { avatar: face('mochi', 40 * k, true), title: S.bot2Name, time: LANG === 'zh' ? '昨天' : 'Yesterday', preview: S.bot2Prev });
  h('div', 'ghead', `<span>${S.section}</span><span class="gadd">+</span>`, list);
  o.dirRow = h('div', 'dirrow', `<span class="dhead">${ic('chevron-down', 12, k)}<span class="fold">${ic('folder', 16, k)}</span><span>${S.dir}</span></span>`, list);
  o.dirAdd = h('span', 'dadd', ic('plus', 16, k), o.dirRow);
  const sess = h('div', 'psess', null, list);
  o.ccWrap = h('div', 'rflip', null, sess);
  o.cc = sessionRow(o.ccWrap, k, { avatar: agentTile(k), title: S.ccTitle, time: '10:44', on: true, actions: true });
  o.cx = sessionRow(sess, k, { avatar: agentTile(k), title: S.cxTitle, time: LANG === 'zh' ? '昨天' : 'Yesterday', preview: S.cxPrev, actions: true });
  return o;
}

// ---- Roles (RoutingTab.svelte, PlaybookList.svelte, PlaybookMap.svelte, PlaybookStepDetail.svelte)
// The steps under each hook in PLAYBOOK_STEPS' order (packages/protocol/src/playbooks.ts).
const ROUNDS = [
  ['line', ['intake', 'reader', 'jobs', 'scribe', 'derived_checks', 'large_job']], ['group', ['judgement']],
  ['turn', ['pacing', 'compaction', 'closing', 'settle', 'check_backs', 'pickup']], ['handed_in', ['checks', 'wait_word', 'escalation', 'ceiling']],
  ['accepted', ['retrospective']], ['overturned', ['reflection']], ['compose', ['composer']]
];
// What each step says on the map when it runs (PlaybookMap's said(): a call's model, else its first number, else 开).
const SAID = {
  intake: `45 ${S.unit.s}`, reader: S.follows, jobs: S.on, scribe: S.follows, derived_checks: S.on, large_job: S.on, judgement: S.follows,
  pacing: `40 ${S.unit.hops}`, compaction: S.follows, closing: S.on, settle: S.follows, check_backs: `5 ${S.unit.min}`, pickup: `2 ${S.unit.min}`,
  checks: S.follows, wait_word: S.on, escalation: '2', ceiling: '3', retrospective: S.follows, reflection: S.follows, composer: S.follows
};
// 通用 switches the scribe and reflection off; 自由 switches jobs and pacing off, and every step that requires jobs goes
// with it (BUILTIN_PLAYBOOKS, resolvePlaybook). Locked: running and not switchable, or held on while jobs runs.
const NEEDS_JOBS = ['scribe', 'derived_checks', 'large_job', 'closing', 'settle', 'pickup', 'checks', 'wait_word', 'escalation', 'ceiling', 'retrospective', 'reflection'];
const OFF = { general: new Set(['scribe', 'reflection']), plain: new Set(['jobs', 'pacing', ...NEEDS_JOBS]) };
const UNSWITCHABLE = new Set(['intake', 'compaction', 'check_backs', 'checks', 'composer']);
const locked = (step, eng) => !OFF[eng].has(step) && (UNSWITCHABLE.has(step) || (step === 'reader' && !OFF[eng].has('jobs')));
/**
 * layPlaybookFlow (settings/playbook-flow.ts), its spine half: a map column narrower than six steps across (any
 * real window's) hangs every round's steps down a spine on the left, as an outline does. App px in, boxes out.
 */
function layFlow(available) {
  const ROOT_W = 196, ROOT_H = 38, STEP_W = 184, STEP_H = 54, GAP_X = 14, GAP_Y = 30, ROW_GAP = 12, ROUND_GAP = 26, PAD = 16, INDENT = 26;
  const width = Math.max(available, ROOT_W + 2 * PAD, 150 + INDENT + 2 * PAD), inner = width - 2 * PAD;
  if (ROUNDS.every(([, steps]) => steps.length <= Math.max(1, Math.floor((inner + GAP_X) / (STEP_W + GAP_X))))) throw new Error('the map would fan out');
  const cards = [], edges = [];
  let y = PAD;
  for (const [hook, steps] of ROUNDS) {
    const rootH = hook === 'turn' ? STEP_H : ROOT_H, root = { id: hook === 'turn' ? 'turn' : `root:${hook}`, hook, kind: 'root', x: PAD, y, w: ROOT_W, h: rootH };
    cards.push(root);
    y += rootH + ROW_GAP;
    for (const step of steps) {
      const x = PAD + INDENT;
      cards.push({ id: step, hook, kind: 'step', x, y, w: Math.max(150, Math.min(320, width - PAD - x)), h: STEP_H });
      const sx = root.x + 14, y1 = root.y + rootH, y2 = y + STEP_H / 2;
      edges.push({ to: step, d: `M ${sx} ${y1} L ${sx} ${y2 - 8} Q ${sx} ${y2}, ${sx + 8} ${y2} L ${x} ${y2}` });
      y += STEP_H + ROW_GAP;
    }
    y += ROUND_GAP - ROW_GAP;
  }
  return { width, height: y - ROUND_GAP + PAD, cards, edges };
}

function build() {
  R.dim = document.getElementById('dusk');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };

  // ---- 0–4 the release: 0.2.0 turns over to 0.3.0
  R.badge = h('div', 'abs', null, stage);
  R.bMark = h('div', 'abs', markSVG(200), R.badge);
  R.bWord = h('div', 'abs word', S.word, R.badge);
  const [major, minor, patch] = S.version.split('.'), from = S.from.split('.')[1];
  R.ver = h('div', 'abs ver', `<span>${major}.</span><span class="roll"><span class="col"><span>${from}</span><span>${minor}</span></span></span><span>.${patch}</span>`, R.badge);
  R.roll = R.ver.querySelector('.roll'); R.rollCol = R.ver.querySelector('.col');
  R.count = h('div', 'abs pill count', `${ic('check', 12)}${S.count}`, R.badge);
  R.mac = h('div', 'abs platform', `${ic('check', 16)}<span>${S.mac}</span>`, stage);
  R.win = h('div', 'abs platform quiet', `${ic('minimap', 16)}<span>${S.win}</span>`, stage);

  // ---- 4–10 Roles, a tab of its own: the engines down the left, the one shown's map and its picked step
  R.roles = h('div', 'abs pane roles', null, stage);
  css(R.roles, { width: 1400, height: 740 });
  R.roles.style.setProperty('--k', KR);
  h('div', 'rstrip', `<span class="rtab">${ic('nodes', 16, KR)}<span>${S.rolesTab}</span></span>`, R.roles);
  const wide = h('div', 'rwide', null, R.roles);
  const list = h('div', 'rlist', null, wide);
  h('div', 'rlhead', `<span>${S.engines}</span><span class="rladd">${ic('plus', 16, KR)}</span>`, list);
  R.eng = S.engineNames.map((n, i) => h('div', 'erow', `<span class="en">${i === 0 ? '<span class="star">★</span>' : ''}<span class="et">${n}</span></span><span class="etime"></span><span class="el">${S.engineLines[i]}</span>`, list));
  const main = h('div', 'rmain', null, wide);
  const top = h('div', 'rtop', null, main);
  const hints = h('div', 'rhints', null, top);
  R.hintA = h('p', 'rhint', S.engineLines[0], hints);
  R.hintB = h('p', 'rhint', S.engineLines[3], hints);
  h('p', 'rintro', S.intro, top);
  const split = h('div', 'rsplit', null, main);
  R.mapCol = h('div', 'rmapcol', null, split);
  R.flow = h('div', 'pflow', null, R.mapCol);
  const detail = h('div', 'rdetail', null, split);
  const step = h('div', 'pstep', `<div class="psh"><h3>${S.steps.jobs}</h3><p class="phint">${S.jobsHint}</p></div>`, detail);
  const part = h('div', 'ppart', `<h4>${S.runs} · <span class="eng"></span></h4>`, step);
  R.engName = part.querySelector('.eng');
  const sw = h('div', 'psw', `<span class="sw"><span class="th"></span></span><span class="pstate"></span>`, part);
  R.sw = sw.querySelector('.sw'); R.swTh = sw.querySelector('.th'); R.swState = sw.querySelector('.pstate');

  // ---- 10–19 the window: the sidebar and a Claude Code session in the folder shop
  const w = R.window = h('div', 'abs pane chat', null, stage);
  css(w, { width: 1180, height: 680 });
  const sideBox = h('div', 'sidebox', null, w);
  R.sideA = sidebar(sideBox, KS);
  const conv = R.conv = h('div', 'conv', null, w);
  R.mapBtn = `<span class="mapbtn">${ic('minimap', 16)}<span>${S.map}</span></span>`;
  h('div', 'conv-hd', `<b>${S.ccTitle}</b><span class="agentpill">${agentMark.replace('class="am"', 'class="am" style="width:26px;height:26px;border:0;background:none"')}${S.agentCC}</span><span class="dirp">${S.dirPath}</span>${R.mapBtn}`, conv);
  // the transcript, under the head and over the composer; it scrolls as a long one does
  const tr = h('div', 'tr', null, conv);
  R.tri = h('div', 'tri', null, tr);
  R.you = h('div', 'abs bubble-you', '', R.tri);
  R.youT = h('div', 'abs time', '', R.tri);
  // the working bubble's last line: its step (a toggle once it opens onto something), the run's time at the right end
  R.foot = h('div', 'abs wfoot', `<span class="pulse"></span><span class="st"></span><span class="dur">${ic('clock', 12)}<span class="d"></span></span>`, R.tri);
  R.footT = R.foot.querySelector('.st'); R.footD = R.foot.querySelector('.d');
  // the plan in the conversation (ProjectPlanCard.svelte), its head's full-screen button
  const planBody = `<h3>${S.planTitle}</h3><p>${S.planIntro}</p><ol>${S.planRows.map(([a, code, b]) => `<li>${a}${code ? `<code>${code}</code>` : ''}${b}</li>`).join('')}</ol><p>${S.planDone}</p>`;
  const planHead = (full) => `<div class="head">${ic('list', 12)}<span>${S.planHead}</span><span class="whom">${S.agentCC}</span><span class="fullbtn${full ? ' pressed' : ''}">${ic(full ? 'minimize' : 'maximize', 16)}</span></div>`;
  R.plan = h('div', 'abs plancard', `${planHead(false)}<div class="pbody"><div class="md">${planBody}</div></div>` +
    `<div class="foot"><span class="btn primary">${ic('check', 16)}${S.planApprove}</span><span class="btn secondary">${S.planKeep}</span><span class="hint">${S.planHint}</span></div>`, R.tri);
  R.fullBtn = R.plan.querySelector('.fullbtn'); R.pbody = R.plan.querySelector('.pbody');
  R.tip = h('div', 'abs tip', S.planFullscreen, stage);
  // the reply, the subagent's way in under it, and what the working bubble opens onto (TurnStepList.svelte)
  R.reply = h('div', 'abs agentline', S.reply3, R.tri);
  R.replyT = h('div', 'abs time', '10:44', R.tri);
  R.chip = h('div', 'abs subchip', `${ic('bot', 16)}<span class="sn">${S.subName}</span><i class="live"></i><span class="note">${S.running}</span>`, R.tri);
  R.steps = h('div', 'abs tsteps', `<div class="hd">${S.nowTitle}</div>`, R.tri);
  R.stepRows = S.taskRows.map(([doing, what], i) => {
    const li = h('div', `trow${i === 2 ? ' open' : ''}`, `<i class="tp"></i><span class="tt">${doing} ${what}</span><span class="tm"></span>`, R.steps);
    if (i === 0) R.devOut = h('pre', 'tout', '', li);
    return li;
  });
  R.subRow = R.stepRows[2].querySelector('.tt');
  // the composer: the words, then the clip, 计划, the picker and send
  R.comp = h('div', 'abs composer pcomp', null, conv);
  R.compTxt = h('div', 'txt', '', R.comp);
  h('span', 'cb attach', ic('paperclip', 20), R.comp);
  R.planTog = h('span', 'plantog', `${ic('list', 16)}<span>${S.plan}</span>`, R.comp);
  h('span', 'tune', `<span>${S.tune[0]}</span><span class="sep">·</span><span>${S.tune[1]}</span><span class="chev">${ic('chevron-down', 12)}</span>`, R.comp);
  h('span', 'gap', null, R.comp);
  R.send = h('span', 'cb send off', ic('arrow-up', 20), R.comp);
  // the plan, full screen: the whole window, its lines at a reading width, the buttons where the lines start
  R.full = h('div', 'abs planfull', `${planHead(true)}<div class="fbody"><div class="md">${planBody}</div></div>` +
    `<div class="ffoot"><div class="fcol"><span class="btn primary">${ic('check', 16)}${S.planApprove}</span><span class="btn secondary">${S.planKeep}</span><span class="hint">${S.planHintFull}</span></div></div>`, w);
  R.fullOk = R.full.querySelector('.btn.primary');
  // the subagent's popup over the window (ProjectSubagentDialog.svelte): what it was asked, what it said, its calls
  R.pop = h('div', 'abs popback', null, w);
  R.dlg = h('div', 'abs dlg', `<div class="mh">${ic('bot', 20)}<div class="mt"><b>${S.subName}</b><span>${S.subFacts}</span></div><span class="mx">✕</span></div>` +
    `<div class="mb"><div class="asked">${S.subAsked}</div><div class="say">${S.subSay}</div>` +
    `<div class="calls">${ic('terminal', 16)}<span>${S.subCalls}</span>${ic('chevron-down', 12)}</div>` +
    `<div class="sfoot2"><span class="pulse"></span><span class="st">${S.subOn}</span><span class="dur">${ic('clock', 12)}<span class="d"></span></span></div></div>`, R.pop);
  R.dlgD = R.dlg.querySelector('.sfoot2 .d');

  // ---- 19–24 the sidebar, closer: Bots and Projects; a folder's + and a session pinned
  const sw2 = R.sw2 = h('div', 'abs pane chat sw2', null, stage);
  css(sw2, { width: 1180, height: 750 });
  const side2 = h('div', 'sidebox2', null, sw2);
  R.sideB = sidebar(side2, KB, { pins: true });
  R.sideB.cc.status('running', S.stBackground);
  const conv2 = h('div', 'conv2', null, sw2);
  conv2.style.setProperty('--k', KB);
  h('div', 'c2hd', `<b>${S.ccTitle}</b><span class="agentpill">${agentMark.replace('class="am"', 'class="am" style="width:24px;height:24px;border:0;background:none"')}${S.agentCC}</span>`, conv2);
  const c2 = h('div', 'c2body', null, conv2);
  h('div', 'c2you', S.line3, c2);
  h('div', 'c2reply', S.reply3, c2);
  h('div', 'subchip c2chip', `${ic('bot', 16, KB)}<span class="sn">${S.subName}</span><i class="live"></i><span class="note">${S.running}</span>`, c2);
  R.c2foot = h('div', 'c2foot', `<span class="pulse"></span><span class="st tog">${S.tasksGoing}</span><span class="dur">${ic('clock', 12, KB)}<span class="d"></span></span>`, c2);
  R.c2D = R.c2foot.querySelector('.d');
  // a directory's + (ProjectAddMenu.svelte, no import there): one new session per agent, then the folder itself
  R.dmenu = h('div', 'abs dmenu', null, sw2);
  R.dmenu.style.setProperty('--k', KB);
  const tileK = `<span class="am mi">${ic('terminal', 12, KB)}</span>`;
  R.dmItems = [
    h('div', 'dmi', `${tileK}<span>${S.newCC}</span>`, R.dmenu), h('div', 'dmi', `${tileK}<span>${S.newCX}</span>`, R.dmenu)];
  h('div', 'dsep', null, R.dmenu);
  R.dmItems.push(h('div', 'dmi', `<span class="mic">${ic('folder', 16, KB)}</span><span>${S.openDir}</span>`, R.dmenu));
  R.dmItems.push(h('div', 'dmi', `<span class="mic">${ic('terminal', 16, KB)}</span><span>${S.openTerminal}</span>`, R.dmenu));

  // ---- 24–26.5 and more
  R.more = S.more.map(m => h('div', 'abs morechip', `<span class="dot" style="width:40px;height:40px;background:var(--accent)">${ic('check', 12)}</span><span>${m}</span>`, stage));

  // headlines
  R.heads = {}; R.subs = {};
  for (const k in S.h) R.heads[k] = h('div', `headline ${LANG}`, S.h[k], stage);
  for (const k in S.sub) R.subs[k] = h('div', 'subline', S.sub[k], stage);

  // the mark and the end card
  R.markG = h('div', 'abs', markSVG(360), stage);
  css(R.markG, { width: 360, height: 360 }); R.markG.style.transformOrigin = '180px 180px';
  R.mf = R.markG.querySelector('.mf'); R.mm = R.markG.querySelector('.mm');
  R.end = h('div', 'abs', null, stage); css(R.end, { width: 1920, height: 1080 }); R.end.style.transformOrigin = '960px 540px';
  R.word = h('div', 'abs word', [...S.word].map(c => `<span class="ch" style="display:inline-block">${c}</span>`).join(''), R.end);
  R.endVer = h('div', 'abs ver small', S.version, R.end);
  R.tag = h('div', 'abs tagline', S.tagline, R.end);
  R.ctaRow = h('div', 'abs', `<span class="cta"><span style="width:38px;height:38px;transform:rotate(180deg);display:inline-block">${I.cta}</span>${S.cta}</span><span class="url">${S.url}</span>`, R.end);
  css(R.ctaRow, { display: 'flex', alignItems: 'center', gap: '36px' });
  R.fine = h('div', 'abs fine', S.fine, R.end);
  R.finer = h('div', 'abs finer', S.finer, R.end);

  R.pointer = h('div', null, I.pointer, stage); R.pointer.id = 'pointer';
  R.ripple = h('div', null, null, stage); R.ripple.id = 'ripple';
}

/** The engine map, laid out for the map column's width once the page has its size. */
function buildMap() {
  const avail = R.mapCol.getBoundingClientRect().width / KR;
  const L = R.layout = layFlow(avail);
  css(R.flow, { width: L.width * KR, height: L.height * KR });
  R.edges = {};
  const svg = `<svg class="pedges" width="${L.width * KR}" height="${L.height * KR}" viewBox="0 0 ${L.width} ${L.height}">${L.edges.map(e => `<path data-to="${e.to}" d="${e.d}"/>`).join('')}</svg>`;
  R.flow.insertAdjacentHTML('beforeend', svg);
  R.flow.querySelectorAll('path').forEach(p => { R.edges[p.dataset.to] = p; });
  R.cards = {};
  for (const c of L.cards) {
    const el = h('div', `pcard ${c.kind}${c.id === 'turn' ? ' turn' : ''}${c.id === 'jobs' ? ' sel' : ''}`, null, R.flow);
    css(el, { left: c.x * KR, top: c.y * KR, width: c.w * KR, height: c.h * KR });
    if (c.kind === 'root') el.innerHTML = c.id === 'turn' ? `<span class="ct">${S.hooks.turn}</span><span class="cs">${S.turnModel}</span>` : `<span class="ct">${S.hooks[c.hook]}</span>`;
    else el.innerHTML = `<span class="ch"><i class="cd"></i><span class="ct">${S.steps[c.id]}</span><span class="lk">${ic('lock', 12, KR)}</span></span><span class="cs"></span>`;
    R.cards[c.id] = c.kind === 'step' ? { el, said: el.querySelector('.cs'), lock: el.querySelector('.lk'), y: c.y } : { el, y: c.y };
  }
  R.turnY = L.cards.find(c => c.id === 'turn').y;
}

const M = {};
function measure() {
  const w = el => el.getBoundingClientRect().width, hh = el => el.getBoundingClientRect().height;
  M.bWordW = w(R.bWord); M.bWordH = hh(R.bWord); M.verW = w(R.ver); M.countW = w(R.count);
  M.macW = w(R.mac); M.winW = w(R.win);
  M.moreW = R.more.map(w);
  M.wordW = w(R.word); M.wordH = hh(R.word); M.endVerW = w(R.endVer); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
  M.mapH = R.mapCol.getBoundingClientRect().height / KR;
  // the pinned band's height, taken while it is laid out at full
  M.compH = R.comp.offsetHeight;
  M.pinsH = R.sideB.pins.offsetHeight; M.ccRowH = R.sideB.ccWrap.offsetHeight;
}

// ---------------------------------------------------------------- headlines (one slot, top left)
const HEADS = { plain: [4.05, 9.85], full: [10.05, 13.85], bg: [14.05, 18.85], side: [19.05, 23.85], more: [24.05, 26.25] };
function poseHeads(t) {
  for (const k in HEADS) {
    const [a, b] = HEADS[k], el = R.heads[k];
    if (show(el, t >= a - 0.05 && t <= b + 0.05)) {
      const i = E.out4(inv(a, a + 0.4, t)), o = E.in(inv(b - 0.22, b, t));
      css(el, { x: 0, y: lerp(46, 0, i) + lerp(0, -30, o), opacity: Math.min(i, 1 - o) });
      el.style.clipPath = `inset(${lerp(100, -20, i).toFixed(1)}% -20px -20px -20px)`;
    }
    const sub = R.subs[k];
    if (sub && show(sub, t >= a + 0.3 && t <= b)) {
      const i = E.out4(inv(a + 0.35, a + 0.75, t)), o = E.in(inv(b - 0.22, b, t));
      css(sub, { x: 0, y: lerp(20, 0, i), opacity: Math.min(i, 1 - o) });
    }
  }
}

// ---------------------------------------------------------------- the room
function poseRoom(t) {
  css(document.getElementById('dots'), { x: -((t * 14) % 36), y: -((t * 9) % 36), opacity: 0.5 });
  // the plan quiets the room a little while the song breaks down
  R.dim.style.opacity = (0.22 * E.smooth(inv(11.0, 11.6, t)) * (1 - E.smooth(inv(13.4, 13.9, t)))).toFixed(3);
}

// ---------------------------------------------------------------- pointer
// Each pass: shown from a to b, it travels from `from` (or where the pass before it ended) onto el by `at`, and
// presses there when click is set. A pass that follows on from the last one does not fade in.
const POINTS = [
  { a: 5.4, at: 6.0, b: 6.6, from: [1450, 1060], el: () => R.eng[3], click: true },
  { a: 6.6, at: 7.15, b: 8.5, from: 'prev', el: () => R.mapCol, dx: 0.45, dy: 0.55 },
  { a: 10.2, at: 10.6, b: 11.45, from: [1400, 1060], el: () => R.fullBtn, click: 11.25, center: true },
  { a: 12.75, at: 13.3, b: 13.75, from: [1500, 1060], el: () => R.fullOk, click: true },
  { a: 15.4, at: 15.9, b: 16.45, from: [1450, 1060], el: () => R.footT, click: true },
  { a: 16.45, at: 17.2, b: 17.65, from: 'prev', el: () => R.subRow, click: true },
  { a: 19.55, at: 19.95, b: 20.25, from: [1400, 1060], el: () => R.sideB.dirRow, dx: 0.45 },
  { a: 20.25, at: 20.45, b: 20.7, from: 'prev', el: () => R.sideB.dirAdd, click: true, center: true },
  { a: 20.7, at: 21.2, b: 21.75, from: 'prev', el: () => R.dmItems[3], dx: 0.4 },
  { a: 21.75, at: 22.05, b: 22.35, from: 'prev', el: () => R.sideB.cc.row, dx: 0.42 },
  { a: 22.35, at: 22.55, b: 23.0, from: 'prev', el: () => R.sideB.cc.pin, click: true, center: true }
];
function target(p) {
  const r = p.el().getBoundingClientRect();
  return p.center ? [r.left + r.width / 2, r.top + r.height / 2] : [r.left + (p.dx !== undefined ? r.width * p.dx : Math.min(r.width / 2, 60)), r.top + r.height * (p.dy ?? 0.5)];
}
function posePointer(t) {
  let pos = null, click = null;
  POINTS.forEach((p, i) => {
    if (t < p.a || t >= p.b) return;
    const [tx, ty] = target(p);
    const prev = POINTS[i - 1], next = POINTS[i + 1];
    const chained = p.from === 'prev' && prev && Math.abs(prev.b - p.a) < 1e-6;
    const [fx, fy] = chained ? target(prev).map((v, j) => v - (j ? 4 : 6)) : p.from;
    const u = E.inOut(inv(p.a + 0.05, p.at - 0.1, t));
    const at = typeof p.click === 'number' ? p.click : p.at;
    const press = p.click && t > at - 0.02 && t < at + 0.07 ? 3 : 0;
    const fin = chained ? 1 : E.out(inv(p.a, p.a + 0.14, t));
    const fout = next && next.from === 'prev' && Math.abs(next.a - p.b) < 1e-6 ? 0 : E.in(inv(p.b - 0.2, p.b, t));
    pos = { x: lerp(fx, tx - 6, u), y: lerp(fy, ty - 4, u) + press, o: Math.min(fin, 1 - fout) };
    if (p.click && t >= at && t < at + 0.45) click = { at, x: tx, y: ty };
  });
  if (pos) css(R.pointer, { x: pos.x, y: pos.y, opacity: pos.o }); else R.pointer.style.opacity = 0;
  if (click) {
    const u = inv(click.at, click.at + 0.45, t);
    css(R.ripple, { x: click.x, y: click.y, s: lerp(0.25, 1.25, E.out(u)), opacity: 0.7 * (1 - u) });
  } else R.ripple.style.opacity = 0;
}

// ---------------------------------------------------------------- 0–4 · 0.2.0 turns over to 0.3.0
function poseRelease(t) {
  const { mochi, pudding } = R.cast;
  const on = t < 4.1;
  show(R.badge, on); show(R.mac, on && t >= 2.45); show(R.win, on && t >= 2.65);
  // a child shown on its own stays visible under a hidden parent: hide each
  if (!on) { show(R.count, false); return; }
  const ex = E.in(inv(3.7, 4.05, t));
  const tagW = M.verW + 24 + M.countW;
  const total = 200 + 44 + M.bWordW + 40 + tagW, left = (1920 - total) / 2, cy = 420;
  const ent = E.pop(inv(0.35, 0.75, t));
  R.badge.style.transformOrigin = '960px 420px';
  css(R.badge, { x: 0, y: -40 * ex, s: lerp(0.85, 1, ent) * (1 - 0.05 * ex), opacity: clamp(inv(0.35, 0.5, t)) * (1 - ex) });
  css(R.bMark, { x: left, y: cy - 100 });
  css(R.bWord, { x: left + 244, y: cy - M.bWordH / 2 - 8 });
  const tx = left + 244 + M.bWordW + 40;
  // the version is there from the start as 0.2.0; its middle digit shakes, then rolls over to 3 on the 2.0 downbeat
  R.ver.style.transformOrigin = '0 50%';
  const shake = t > 1.5 && t < 1.98 ? Math.sin((t - 1.5) * 60) * 5 * inv(1.5, 1.95, t) : 0;
  const beat = E.pop(inv(2.0, 2.3, t));
  css(R.ver, { x: tx, y: cy - 62, s: lerp(1, 1.12, Math.sin(Math.PI * clamp(inv(2.0, 2.3, t)))), opacity: clamp(inv(0.6, 0.8, t)) });
  R.roll.style.translate = `${shake.toFixed(1)}px 0`;
  R.rollCol.style.translate = `0 ${(-50 * clamp(E.out4(inv(1.98, 2.24, t)) + 0.04 * Math.sin(Math.PI * beat))).toFixed(2)}%`;
  if (show(R.count, t >= 2.15)) {
    const u = E.pop(inv(2.15, 2.45, t));
    R.count.style.transformOrigin = '0 50%';
    css(R.count, { x: tx + M.verW + 24, y: cy - 30, s: lerp(0.6, 1, u), opacity: clamp(inv(2.15, 2.25, t)) });
  }
  const gap = 28, rowW = M.macW + gap + M.winW, rx = (1920 - rowW) / 2;
  const chip = (el, a, x) => { const u = E.pop(inv(a, a + 0.32, t)); el.style.transformOrigin = '50% 50%'; css(el, { x, y: 590 + lerp(24, 0, E.out(inv(a, a + 0.3, t))) - 40 * ex, s: lerp(0.85, 1, u), opacity: clamp(inv(a, a + 0.15, t)) * (1 - ex) }); };
  chip(R.mac, 2.45, rx); chip(R.win, 2.65, rx + M.macW + gap);
  // Mochi and Pudding come to see it, and cheer when it turns over
  if (t < 4.2) {
    const s = seq(t, [[0, 'hop'], [0.72, 'idle', true], [2.0, 'cheer'], [3.43, 'hop']]);
    const x = t < 3.43 ? hopX(t, 0, -180, 300) : hopX(t, 3.43, 300, -260);
    mochi.pose({ ...s, x, s: 420, flip: t >= 3.43 });
  }
  const sp = seq(t, [[0.3, 'hop'], [1.02, 'idle', true], [2.05, 'cheer'], [3.48, 'idle', true]]);
  if (t >= 0.3 && t < 4.0) pudding.pose({ ...sp, x: hopX(t, 0.3, 2150, 1660), s: 440, flip: true });
}

// ---------------------------------------------------------------- 4–10 · Roles: 自由 leaves the way of working off
function poseRoles(t) {
  if (!panel(R.roles, t, 4.15, 9.95, 120, 268)) return;
  const plain = t >= 6.0;
  // the engine shown is tinted; the pointer's row under it before the press
  R.eng.forEach((el, i) => { el.classList.toggle('on', plain ? i === 3 : i === 0); el.classList.toggle('hover', !plain && i === 3 && t > 5.75); });
  setText(R.engName, plain ? S.engineNames[3] : S.engineNames[0]);
  // what the built-in is for, over the map: General's, then Plain's
  const x = E.out(inv(6.0, 6.25, t));
  R.hintA.style.opacity = (1 - x).toFixed(3); R.hintB.style.opacity = x.toFixed(3);
  // the switch of the picked step, 一件件事: on under 通用, off under 自由
  const sw = E.inOut(inv(6.05, 6.25, t));
  R.swTh.style.translate = `${(18 * KR * (1 - sw)).toFixed(1)}px 0`;
  R.sw.classList.toggle('on', sw < 0.5);
  setText(R.swState, sw < 0.5 ? S.on : S.off);
  // each step that goes off with jobs dims, top to bottom
  let n = 0;
  for (const [, steps] of ROUNDS) for (const step of steps) {
    const c = R.cards[step], wasOff = OFF.general.has(step), nowOff = OFF.plain.has(step);
    const at = 6.03 + (wasOff !== nowOff ? 0.035 * n++ : 0);
    const off = t >= at ? nowOff : wasOff;
    c.el.classList.toggle('off', off);
    setText(c.said, off ? S.offShort : SAID[step]);
    c.lock.style.display = locked(step, t >= at ? 'plain' : 'general') ? '' : 'none';
    R.edges[step].classList.toggle('off', off);
  }
  // the map scrolls on to the Bot's turn, most of it off now
  const scroll = (R.turnY - 8) * E.inOut(inv(7.2, 8.25, t));
  R.flow.style.translate = `0 ${(-scroll * KR).toFixed(1)}px`;
}

// ---------------------------------------------------------------- 10–19 · the window
function poseWindow(t) {
  show(R.tip, false);
  const on = panel(R.window, t, 9.95, 18.95, 120, 280);
  const kids = [R.you, R.youT, R.foot, R.plan, R.reply, R.replyT, R.chip, R.steps, R.full, R.pop, R.dlg, R.comp];
  if (!on) { kids.forEach(e => show(e, false)); return; }
  show(R.comp, true);
  // the sidebar: the session's row says where its run is
  const A = R.sideA;
  if (t < 13.3) A.cc.status('wait', S.stApproval);
  else if (t < 15.0) A.cc.status('running', S.stRunning);
  else A.cc.status('running', S.stBackground);
  // the composer: plan mode on until the plan is approved, then your next line
  const planOn = t < 13.4;
  R.planTog.classList.toggle('on', planOn);
  let text = '';
  if (t >= 14.05 && t < 14.45) text = typed(S.line3, t, 14.05, 14.35);
  setHTML(R.compTxt, text ? `${text}<span class="caret"></span>` : `<span class="caret lead"></span><span class="ph">${planOn ? S.phPlan : S.phCC}</span>`);
  R.comp.classList.toggle('focus', true);
  R.send.classList.toggle('off', !text);
  // the composer grows upward from its foot as a line wraps
  css(R.comp, { x: X0, y: COMP_Y - (R.comp.offsetHeight - M.compH) });
  if (t < 14.0) posePlan(t); else poseTasks(t);
  if (t >= 11.3) show(R.tip, false);
}

const at = (el, x, y) => { el.style.left = `${x}px`; el.style.top = `${y}px`; };

// 10–14 · the plan in the conversation; its full-screen button; the plan over the whole window; approved on 13.3
function posePlan(t) {
  R.tri.style.translate = '0 0';
  [R.reply, R.replyT, R.chip, R.steps, R.pop, R.dlg].forEach(e => show(e, false));
  setText(R.you, S.ccTitle); setText(R.youT, '10:41');
  // your line, the working bubble waiting on the plan, the plan card under it
  at(R.you, XR - R.you.offsetWidth, 14);
  at(R.youT, XR - R.youT.offsetWidth, 14 + R.you.offsetHeight + 6);
  const fy = 14 + R.you.offsetHeight + 40;
  at(R.foot, X0, fy);
  const py = fy + R.foot.offsetHeight + 14;
  at(R.plan, X0, py);
  // the card's plan scrolls inside it: as much of it shows as leaves the card clear of the composer
  R.pbody.style.height = '92px';
  R.pbody.style.height = `${clamp(418 - 14 - py - (R.plan.offsetHeight - 92), 40, 92)}px`;
  const leave = 1 - E.in(inv(13.7, 13.98, t));
  for (const e of [R.you, R.youT]) { show(e, true); e.style.opacity = leave.toFixed(3); e.style.translate = `0 ${(-40 * (1 - leave)).toFixed(1)}px`; }
  show(R.foot, true);
  R.foot.style.opacity = leave.toFixed(3);
  R.foot.classList.remove('opens');
  setText(R.footT, t < 13.3 ? S.waitingPlan : S.thinking);
  setText(R.footD, live(41 + (t - 10)));
  // the card: there while it waits, out once answered (the answer leaves full screen first)
  const cardIn = E.pop(inv(10.15, 10.45, t));
  const zoom = E.inOut(inv(11.25, 11.6, t)) * (1 - E.inOut(inv(13.35, 13.65, t)));
  const gone = E.in(inv(13.6, 13.8, t));
  if (show(R.plan, t < 13.8)) {
    R.plan.style.transformOrigin = '50% 0';
    R.plan.style.scale = lerp(0.94, 1, cardIn).toFixed(3);
    R.plan.style.opacity = (clamp(inv(10.15, 10.3, t)) * (1 - zoom) * (1 - gone)).toFixed(3);
    R.fullBtn.classList.toggle('hot', t > 10.55 && t < 11.3);
  }
  // the button's title, under the pointer
  if (show(R.tip, t >= 10.8 && t < 11.3)) {
    const b = R.fullBtn.getBoundingClientRect();
    at(R.tip, b.left + b.width / 2 + 22, b.bottom + 24);
    R.tip.style.opacity = clamp(inv(10.8, 10.9, t)).toFixed(3);
  }
  // full screen: the card grows from where it sits to the whole window, and back on approve
  if (show(R.full, zoom > 0.001)) {
    const pr = { x: 300 + X0, y: 82 + R.plan.offsetTop, w: R.plan.offsetWidth, h: R.plan.offsetHeight };
    const sx = pr.w / 1180, sy = pr.h / 680;
    R.full.style.transformOrigin = '0 0';
    css(R.full, { x: lerp(pr.x, 0, zoom), y: lerp(pr.y, 0, zoom), sx: lerp(sx, 1, zoom), sy: lerp(sy, 1, zoom), opacity: clamp(zoom * 2.5) });
    R.fullOk.style.scale = t > 13.28 && t < 13.4 ? '0.94' : '1';
  }
}

// 14–19 · your line; the reply, the subagent under it, the working bubble going on: what it opens onto; the popup
function poseTasks(t) {
  show(R.plan, false); show(R.full, false); show(R.tip, false);
  setText(R.you, S.line3); setText(R.youT, '10:43');
  const youOn = t >= 14.45, replyOn = t >= 15.0, listOn = t >= 15.95;
  // the transcript, top down
  let y = 14;
  at(R.you, XR - R.you.offsetWidth, y); y += R.you.offsetHeight + 6;
  at(R.youT, XR - R.youT.offsetWidth, y); y += R.youT.offsetHeight + 22;
  at(R.reply, X0, y); if (replyOn) y += R.reply.offsetHeight + 6;
  at(R.replyT, X0, y); if (replyOn) y += R.replyT.offsetHeight + 10;
  at(R.chip, X0, y); if (replyOn) y += R.chip.offsetHeight + 14;
  at(R.foot, X0, y); y += R.foot.offsetHeight + 10;
  at(R.steps, X0, y);
  // each row's time; a running command's output as it prints it
  R.stepRows.forEach((li, i) => setText(li.querySelector('.tm'), `${(Math.round(t - 14.7) + [21, 20, 18][i]).toFixed(1)}s`));
  setText(R.devOut, S.devOut.slice(0, 2 + (t >= 16.6) + (t >= 17.3)).join('\n'));
  const listH = R.steps.offsetHeight * E.out4(inv(15.95, 16.3, t));
  // follow the end of the conversation, as it does while you are at the bottom
  const room = COMP_Y - 82 - 24;
  const need = Math.max(0, y + (listOn ? listH : 0) - room);
  R.tri.style.translate = `0 ${(-need).toFixed(1)}px`;
  span(R.you, t, 14.45, 19.5); span(R.youT, t, 14.55, 19.5);
  if (!youOn) { show(R.you, false); show(R.youT, false); }
  show(R.foot, t >= 14.6);
  R.foot.style.opacity = clamp(inv(14.6, 14.75, t)).toFixed(3);
  R.foot.classList.toggle('opens', replyOn);
  R.foot.classList.toggle('open', listOn);
  setText(R.footT, replyOn ? S.tasksGoing : S.thinking);
  setText(R.footD, live(2 + (t - 14.45)));
  span(R.reply, t, 15.0, 19.5); span(R.replyT, t, 15.05, 19.5);
  span(R.chip, t, 15.12, 19.5, { pop: true, origin: '0 50%' });
  if (show(R.steps, listOn)) {
    R.steps.style.opacity = clamp(inv(15.95, 16.1, t)).toFixed(3);
    R.steps.style.translate = `0 ${lerp(-6, 0, E.out4(inv(15.95, 16.2, t))).toFixed(1)}px`;
    R.subRow.classList.toggle('hot', t > 17.0 && t < 17.4);
  }
  // the subagent, opened: over the whole window, nearly as wide as it at this size
  if (show(R.pop, t >= 17.25)) {
    show(R.dlg, true);
    const u = E.out4(inv(17.25, 17.55, t));
    R.pop.style.opacity = clamp(inv(17.25, 17.4, t)).toFixed(3);
    R.dlg.style.translate = `0 ${lerp(30, 0, u).toFixed(1)}px`;
    R.dlg.style.scale = lerp(0.97, 1, u).toFixed(3);
    setText(R.dlgD, live(Math.floor(t - 17.25) + 18.3));
  } else show(R.dlg, false);
}

// ---------------------------------------------------------------- 19–24 · the sidebar's two sections
function poseSide(t) {
  const on = panel(R.sw2, t, 19.0, 24.0, 120, 262);
  const B = R.sideB;
  if (!on) { [R.dmenu, B.cc.acts, B.cx.acts].forEach(e => show(e, false)); return; }
  setText(R.c2D, live(64 + (t - 19)));
  // pinned, the row goes up to the band (laid out first: what is placed below reads where things are now)
  const pin = E.inOut(inv(22.6, 22.95, t));
  B.pins.style.height = `${(M.pinsH * pin).toFixed(1)}px`;
  B.ccWrap.style.height = `${(M.ccRowH * (1 - pin)).toFixed(1)}px`;
  // the folder's row under the pointer shows its +; pressed, its menu hangs under it, right edge on the +'s
  const dirHover = t > 19.85 && t < 21.4;
  B.dirRow.classList.toggle('hover', dirHover);
  B.dirAdd.style.opacity = dirHover ? 1 : 0;
  B.dirAdd.classList.toggle('hot', t > 20.3 && t < 21.4);
  if (show(R.dmenu, t >= 20.45 && t < 21.55)) {
    const a = B.dirAdd.getBoundingClientRect(), wr = R.sw2.getBoundingClientRect(), s = wr.width / 1180;
    const u = E.pop(inv(20.45, 20.65, t)), o = E.in(inv(21.4, 21.55, t));
    R.dmenu.style.transformOrigin = '100% 0';
    css(R.dmenu, { x: (a.right - wr.left) / s - R.dmenu.offsetWidth, y: (a.bottom - wr.top) / s + 4 * KB, s: lerp(0.94, 1, u), opacity: clamp(inv(20.45, 20.52, t)) * (1 - o) });
    R.dmItems.forEach((el, i) => el.classList.toggle('hot', (i === 0 && t < 20.85) || (i === 2 && t >= 20.85 && t < 21.05) || (i === 3 && t >= 21.05)));
  }
  // a session's row under the pointer offers Pin and ⋯, its time giving way; pinned, it goes up to the band
  const rowHover = t > 21.95 && t < 22.75;
  if (show(B.cc.acts, rowHover)) {
    const u = E.out(inv(21.95, 22.1, t));
    B.cc.acts.style.opacity = u.toFixed(3);
    B.cc.acts.style.translate = `${(4 * KB * (1 - u)).toFixed(1)}px -50%`;
    B.cc.pin.classList.toggle('hot', t > 22.4);
    B.cc.pin.classList.toggle('pressed', t >= 22.55);
  }
  show(B.cx.acts, false);
  B.cc.row.classList.toggle('hover', rowHover);
  B.cc.rt.style.opacity = rowHover ? 0 : 1;
  B.ccWrap.style.opacity = (1 - E.out(inv(22.6, 22.8, t))).toFixed(3);
  const tu = E.pop(inv(22.75, 23.05, t));
  B.pinTile.style.scale = lerp(0.6, 1, tu).toFixed(3);
  B.pinTile.style.opacity = clamp(inv(22.75, 22.85, t)).toFixed(3);
}

// ---------------------------------------------------------------- the cast beside each scene
function poseCast(t) {
  const { mochi, pudding, reviewer } = R.cast;
  // Pudding, who stayed from the opening, presents Roles: General, then Plain
  if (t >= 4.0 && t < 9.95) {
    const s = seq(t, [[4.0, 'idle', true], [6.05, 'present'], [7.0, 'idle', true], [8.35, 'nod'], [9.0, 'idle', true], [9.55, 'hop']]);
    pudding.pose({ ...s, x: t < 9.55 ? 1660 : hopX(t, 9.55, 1660, 2150), s: 440, flip: true });
  }
  // the Reviewer reads the plan through with you, full screen, and nods it off
  if (t >= 9.9 && t < 14.3) {
    const s = seq(t, [[9.9, 'hop'], [10.62, 'think', true], [11.6, 'inspect'], [12.6, 'think', true], [13.3, 'nod'], [13.95, 'hop']]);
    const x = t < 13.95 ? hopX(t, 9.9, 2150, 1600) : hopX(t, 13.95, 1600, 2200);
    reviewer.pose({ ...s, x, s: 400, flip: t < 13.95 });
  }
  // Mochi types your line, points at what is running and at the subagent; stays on for the sidebar
  if (t >= 13.9 && t < 23.6) {
    const s = seq(t, [[13.9, 'hop'], [14.62, 'type', true], [15.3, 'idle', true], [15.75, 'point'], [16.4, 'nod'], [17.05, 'point'], [17.8, 'idle', true], [20.5, 'nod'], [21.2, 'idle', true]]);
    const x = t < 19.0 ? hopX(t, 13.9, 2150, 1600) : lerp(1600, 1440, E.inOut(inv(19.0, 19.5, t)));
    mochi.pose({ ...s, x, s: lerp(430, 400, inv(19.0, 19.4, t)), flip: true });
  }
  // the sidebar: Pudding and the Reviewer come to look, and cheer the pin
  if (t >= 19.2 && t < 23.62) {
    const s = seq(t, [[19.2, 'hop'], [19.92, 'idle', true], [20.5, 'nod'], [21.2, 'idle', true], [22.6, 'cheer'], [23.45, 'idle', true]]);
    pudding.pose({ ...s, x: hopX(t, 19.2, 2150, 1620), s: 360, flip: true });
  }
  if (t >= 19.45 && t < 24.0) {
    const s = seq(t, [[19.45, 'hop'], [20.17, 'inspect'], [21.4, 'think', true], [22.65, 'cheer'], [23.55, 'hop']]);
    const x = t < 23.55 ? hopX(t, 19.45, 2200, 1785) : hopX(t, 23.55, 1785, 1160);
    reviewer.pose({ ...s, x, s: 330, flip: true });
  }
}

// ---------------------------------------------------------------- 24–26.5 · and more
function poseMore(t) {
  const { reviewer } = R.cast;
  R.more.forEach((el, i) => {
    if (!show(el, t >= 24.0 && t < 26.5)) return;
    const a = 24.15 + i * 0.16, u = E.pop(inv(a, a + 0.32, t)), o = E.in(inv(26.15, 26.45, t));
    const col = i % 2, row = Math.floor(i / 2);
    el.style.transformOrigin = '50% 50%';
    css(el, { x: col === 0 ? 940 - M.moreW[i] : 980, y: 300 + row * 104 + lerp(26, 0, E.out(inv(a, a + 0.3, t))) - 20 * o, s: lerp(0.85, 1, u), opacity: clamp(inv(a, a + 0.12, t)) * (1 - o) });
  });
  if (t >= 24.0 && t < 26.6) {
    const s = seq(t, [[24.0, 'idle', true], [25.3, 'cheer']]);
    reviewer.pose({ ...s, x: 1160, s: 340, flip: true, o: 1 - E.in(inv(26.3, 26.6, t)) });
  }
  // Mochi and Pudding come down to the front, cheer, and go on to the mark
  if (t >= 23.6 && t < 26.45) {
    R.cast.mochi.pose({ ...seq(t, [[23.6, 'hop'], [24.32, 'idle', true], [25.3, 'cheer']]), x: hopX(t, 23.6, 1440, 760), s: 430, flip: t < 24.0 });
    R.cast.pudding.pose({ ...seq(t, [[23.62, 'hop'], [24.34, 'idle', true], [25.42, 'cheer']]), x: hopX(t, 23.62, 1620, 960), s: 380, flip: true });
  }
}

// ---------------------------------------------------------------- 26.5– · the mark and the end card
function poseEnd(t) {
  const { mochi, pudding } = R.cast;
  const on = t >= 26.45;
  show(R.markG, on); show(R.end, t >= 27.1);
  if (!on) return;
  const LS = 200 / 360, lock = E.inOutQuint(inv(27.35, 27.95, t));
  const push = 1 + 0.04 * inv(27.95, DURATION, t);
  const mx = M.lockX + 100, my = M.lockY + 100;
  const cx = lerp(960, 960 + (mx - 960) * push, lock), cy = lerp(500, 540 + (my - 540) * push, lock);
  const ap = E.pop(inv(26.45, 26.8, t));
  css(R.markG, { x: cx - 180, y: cy - 180, s: lerp(0.5, 1, ap) * lerp(1, LS * push, lock), opacity: clamp(ap * 2) });
  const circ = (el, at) => { const f = E.pop(inv(at, at + 0.3, t)); el.style.opacity = f > 0.001 ? 1 : 0; el.setAttribute('transform', `translate(${el.getAttribute('cx')} ${el.getAttribute('cy')}) scale(${f.toFixed(3)}) translate(-${el.getAttribute('cx')} -${el.getAttribute('cy')})`); };
  circ(R.mf, 27.05); circ(R.mm, 27.2);
  const onto = (actor, a, x0, s0, flip, cxm, at) => {
    if (t >= at + 0.02) return;
    const k = 360 / 64, tx = 960 - 180 + cxm * k, ty = 500 - 180 + 29 * k + 60;
    const u = E.inOut(inv(a + 0.08, at, t));
    actor.pose({ clip: 'idle', at: 0, x: lerp(x0, tx, u), y: lerp(GY, ty, u), air: 220 * Math.sin(u * Math.PI), s: lerp(s0, 170, u), flip, o: 1 - E.in(inv(at - 0.06, at, t)) });
  };
  onto(mochi, 26.45, 760, 430, false, 25, 27.05);
  onto(pudding, 26.6, 960, 380, true, 39.5, 27.2);
  if (t < 27.1) return;
  css(R.end, { x: 0, y: 0, s: push });
  R.word.querySelectorAll('.ch').forEach((c, i) => { const u = E.out4(inv(27.55 + i * 0.035, 27.95 + i * 0.035, t)); c.style.transform = `translateY(${lerp(60, 0, u).toFixed(1)}px)`; c.style.opacity = u; });
  css(R.word, { x: M.lockX + 240, y: M.lockY + 100 - M.wordH / 2 - 6 });
  const vu = E.pop(inv(27.95, 28.25, t));
  R.endVer.style.transformOrigin = '0 50%';
  css(R.endVer, { x: M.lockX + 240 + M.wordW + 30, y: M.lockY + 100 - 30, s: lerp(1.4, 1, vu), opacity: clamp(inv(27.95, 28.05, t)) });
  const showAt = (el, a, w, y) => { const u = E.out4(inv(a, a + 0.45, t)); css(el, { x: (1920 - w) / 2, y: y + lerp(26, 0, u), opacity: u }); };
  showAt(R.tag, 27.75, M.tagW, 470);
  const cu = E.out4(inv(28.0, 28.35, t));
  R.ctaRow.style.transformOrigin = '50% 50%';
  css(R.ctaRow, { x: (1920 - M.ctaW) / 2, y: 640, s: lerp(1.12, 1, cu), opacity: cu });
  showAt(R.fine, 28.35, M.fineW, 800);
  const fu = E.out(inv(28.6, 29.0, t)); css(R.finer, { x: 1920 - 96 - M.finerW, y: 985, opacity: fu });
}

// ---------------------------------------------------------------- seek
async function seek(t) {
  t = clamp(t, 0, DURATION);
  pending = [];
  for (const k in R.cast) R.cast[k].on = false;
  poseRoom(t);
  poseRelease(t);
  poseRoles(t);
  poseWindow(t);
  poseSide(t);
  poseCast(t);
  poseMore(t);
  poseEnd(t);
  for (const k in R.cast) show(R.cast[k].el, R.cast[k].on);
  poseHeads(t);
  posePointer(t);
  await Promise.all(pending);
}

// ---------------------------------------------------------------- sound cues: name, film time, what it marks
const CUES = [
  ['whoosh', 0.05, 'Mochi hops in'], ['whoosh', 0.35, 'Pudding hops in'], ['pop', 0.4, 'the name'], ['tick', 0.65, '0.2.0'],
  ['swish', 1.98, 'the digit rolls'], ['done', 2.0, '0.3.0 lands'], ['pop', 2.15, 'the count'], ['tick', 2.45, 'macOS'], ['tick', 2.65, 'Windows'],
  ['whoosh', 4.15, 'Roles'], ['click', 6.0, '自由'], ['pop', 6.05, 'the switch goes off'], ['tick', 6.2, 'steps dim'], ['swish', 7.2, 'the map scrolls'],
  ['whoosh', 9.55, 'Pudding leaves'], ['whoosh', 9.9, 'the Reviewer'], ['whoosh', 9.95, 'the window'], ['pop', 10.15, 'the plan'],
  ['click', 11.25, 'full screen'], ['swish', 11.25, 'the plan fills the window'], ['click', 13.3, 'approve'], ['swish', 13.35, 'back to the conversation'],
  ['whoosh', 13.9, 'Mochi'], ['tick', 14.45, 'your line'], ['check', 15.0, 'the reply'], ['pop', 15.12, 'the subagent'],
  ['click', 15.9, 'what is running'], ['pop', 15.95, 'the list opens'], ['tick', 16.6, 'output'], ['tick', 17.3, 'output'],
  ['click', 17.2, 'the subagent'], ['pop', 17.25, 'its popup'],
  ['whoosh', 19.0, 'the sidebar'], ['whoosh', 19.2, 'Pudding'], ['whoosh', 19.45, 'the Reviewer'], ['click', 20.45, 'the folder’s +'], ['pop', 20.45, 'its menu'],
  ['tick', 21.05, 'open terminal'], ['click', 22.55, 'Pin'], ['pop', 22.75, 'the pinned band'], ['pop', 22.65, 'a cheer'],
  ['whoosh', 23.6, 'down to the front'], ['tick', 24.15, 'chip'], ['tick', 24.31, 'chip'], ['tick', 24.47, 'chip'], ['tick', 24.63, 'chip'], ['tick', 24.79, 'chip'], ['tick', 24.95, 'chip'], ['pop', 25.3, 'cheer'],
  ['whoosh', 26.45, 'onto the mark'], ['tap', 27.05, 'white circle'], ['tap', 27.2, 'mustard circle']
];

// ---------------------------------------------------------------- boot
async function boot() {
  SP = await (await fetch('/sprites/sprites.json')).json();
  await Promise.all([document.fonts.load('700 76px "DF Sans"'), document.fonts.load('600 30px "DF Mono"'), document.fonts.load('600 40px "PingFang SC"', '交'), document.fonts.load('400 40px "PingFang SC"', '交')]);
  await document.fonts.ready;
  build();
  buildMap();
  measure();
  M.lockX = (1920 - (200 + 40 + M.wordW + 30 + M.endVerW)) / 2; M.lockY = 230;
  window.film.ready = true;
  await seek(0);
}
window.film = { duration: DURATION, seek, ready: false, cues: CUES, keys: [], lang: LANG };
boot();
