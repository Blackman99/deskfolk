// The Deskfolk 0.4.0 release film: the reel's cast (Mochi, Pudding and the Reviewer) presents 0.4.0 on the app's own
// surfaces, redrawn. film.seek(t) poses everything from t alone and resolves once the sprites it chose have decoded.
// Timeline (120 BPM, a bar every 2 s, the 0.1.0 film's music edit): 0 0.3.0 turns over to 0.4.0 · 4 you ask a Bot
// for a purple accent and frosted glass content, and the window turns · 10 code colours: Dracula for the dark look
// (the song's breakdown) · 14 Roles: a step of your own at the end of a Bot's turn · 19 a Bot's model, picked a
// level at a time in its direct · 24 and more · 26.5 the mark, the URL on the final hit (28.0).
import { clamp, lerp, inv, E, css, h } from '/launch/lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const DURATION = 30.5;
const FPS = 30;
const GY = 905; // the ground line the cast stands on
let SP = null; // sprites.json (the reel's): frames per move, and where the feet are in a frame

// ---------------------------------------------------------------- scale, geometry and icons
// The app's surfaces are drawn at k times their size in the app (film.css --k on each surface): the window's
// conversation at KL (the look and the picker) or KD (the dark look, a little smaller so the code block stays in
// view), its sidebar at KS, Roles at KR (wide enough for Roles' wide layout: over 760 px).
const KL = 1.5, KS = 1.25, KD = 1.3, KR = 1.5;
// A desk (the wallpaper) with the window on it; the window's sidebar is SIDE_W wide.
const DESK = { x: 96, y: 246, w: 1300, h: 780 }, WIN = { x: 34, y: 30, w: 1232, h: 720 }, SIDE_W = 300;
// The app's one icon set (apps/messenger/src/lib/icons.ts), the shapes this film draws, copied as they are; stroked
// with the app's 1.6 px pen at the role size. `f` fills a shape.
const PIN_HEAD = 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z';
const GEAR = 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';
const ICONS = {
  x: [{ p: 'M6 6l12 12M18 6 6 18' }],
  check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
  terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
  clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
  'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
  'chevron-right': [{ p: 'm9 6 6 6-6 6' }],
  plus: [{ p: 'M12 5v14M5 12h14' }],
  'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
  folder: [{ p: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z' }],
  paperclip: [{ p: 'm21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
  minimap: [{ r: [3, 3, 18, 18, 2.5] }, { r: [12, 12, 6, 6, 1] }],
  pin: [{ p: 'M12 17v5' }, { p: PIN_HEAD }],
  more: [{ c: [5.5, 12, 1.6], f: 1 }, { c: [12, 12, 1.6], f: 1 }, { c: [18.5, 12, 1.6], f: 1 }],
  nodes: [{ c: [5, 6, 2] }, { c: [19, 6, 2] }, { c: [12, 18, 2] }, { p: 'M7 6h10M6 8l5 8M18 8l-5 8' }],
  lock: [{ r: [4.5, 11, 15, 10, 2.5] }, { p: 'M8 11V7.5a4 4 0 0 1 8 0V11' }],
  activity: [{ p: 'M22 12h-4l-3 9L9 3l-3 9H2' }],
  target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1.5] }],
  search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.5-3.5' }],
  info: [{ c: [12, 12, 9] }, { p: 'M12 16v-4.5M12 8h.01' }],
  sparkles: [{ p: 'M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z' }, { p: 'M20 3v4M22 5h-4' }],
  stop: [{ r: [6.5, 6.5, 11, 11, 2.5], f: 1 }],
  hierarchy: [{ r: [8, 2.5, 8, 6, 1.5] }, { p: 'M12 8.5v3M5.5 14v-2.5h13V14' }, { r: [2, 14, 7, 6, 1.5] }, { r: [15, 14, 7, 6, 1.5] }],
  settings: [{ p: GEAR }, { c: [12, 12, 3] }],
  copy: [{ r: [9, 9, 11, 11, 2.5] }, { p: 'M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9' }]
};
function ic(name, role, k = KL) {
  const px = +(role * k).toFixed(2), fill = s => s.f ? ' fill="currentColor"' : '';
  const shapes = ICONS[name].map(s => s.p ? `<path d="${s.p}"${fill(s)}/>` : s.c ? `<circle cx="${s.c[0]}" cy="${s.c[1]}" r="${s.c[2]}"${fill(s)}/>`
    : `<rect x="${s.r[0]}" y="${s.r[1]}" width="${s.r[2]}" height="${s.r[3]}" rx="${s.r[4]}"${fill(s)}/>`).join('');
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
const agentTile = k => `<span class="atile">${ic('terminal', 16, k)}</span>`;
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
/** A running clock in the app's words: tenths under a minute. */
const live = sec => S.span(Math.max(0, sec).toFixed(1));
const at = (el, x, y) => { el.style.left = `${x.toFixed(1)}px`; el.style.top = `${y.toFixed(1)}px`; };

// ---------------------------------------------------------------- DOM
const R = {};

// ---- the sidebar (Sidebar.svelte, SessionRow.svelte) on the window's glass: the traffic lights, the mark with its
// switches at the far end, search, the Bots and a folder's sessions; the open conversation's row a card
function sessionRow(parent, { avatar, title, time, preview = '', on = false }) {
  const row = h('div', `row${on ? ' on' : ''}`, `<span class="av">${avatar}</span><span class="t">${title}</span><span class="rt">${time}</span>` +
    `<span class="rs idle"><i></i><span class="rst"></span></span><span class="s">${preview}</span>`, parent);
  const r = { row, rs: row.querySelector('.rs'), rst: row.querySelector('.rst'), s: row.querySelector('.s') };
  r.status = (label) => {
    r.rs.className = `rs ${label ? 'running' : 'idle'}`;
    setText(r.rst, label || '');
    row.classList.toggle('busy', !!label);
  };
  return r;
}
function sidebar(parent, k, bots) {
  const sb = h('div', 'sb', null, parent);
  sb.style.setProperty('--k', k);
  sb.style.width = `${SIDE_W}px`;
  h('div', 'lights', '<i></i><i></i><i></i>', sb);
  h('div', 'brand', `${markSVG(22 * k)}<span class="tg">${ic('activity', 20, k)}</span><span class="tg">${ic('target', 20, k)}</span>`, sb);
  h('div', 'srch', `<span class="si">${ic('search', 16, k)}</span><span>${S.search}</span><kbd>⌘K</kbd>`, sb);
  const list = h('div', 'groups', null, sb);
  h('div', 'ghead', `<span>${S.botsTab}</span><span class="gadd">+</span>`, list);
  const rows = bots.map(b => sessionRow(list, { avatar: face(b.who, 40 * k, true), title: b.name, time: b.time, preview: b.prev, on: b.on }));
  h('div', 'ghead', `<span>${S.section}</span><span class="gadd">+</span>`, list);
  h('div', 'dirrow', `<span class="dhead">${ic('chevron-down', 12, k)}<span>${ic('folder', 16, k)}</span><span>${S.dir}</span></span>`, list);
  const sess = h('div', 'psess', null, list);
  sessionRow(sess, { avatar: agentTile(k), title: S.ccTitle, time: '10:44' });
  sessionRow(sess, { avatar: agentTile(k), title: S.cxTitle, time: LANG === 'zh' ? '昨天' : 'Yesterday', preview: S.cxPrev });
  return rows;
}

/**
 * A desk with a window on it: the wallpaper, the window's glass (the same wallpaper blurred and washed, then the
 * shell's ground at its tint), the sidebar, and a pane — its tab strip and its card (WorkbenchLeaf.svelte) with a
 * Bot's direct in it: the header (PaneChatBar), the transcript, the composer (Composer.svelte). Coordinates inside
 * the card are film px; k is the conversation's scale.
 */
function deskWindow({ k, dark = false, bots, bot }) {
  const desk = h('div', `abs desk${dark ? ' dark' : ''}`, null, stage);
  css(desk, { width: DESK.w, height: DESK.h });
  const wall = `<div class="wall${dark ? ' night' : ''}" style="width:${DESK.w}px;height:${DESK.h}px"></div>`;
  desk.insertAdjacentHTML('beforeend', wall);
  const win = h('div', `abs win${dark ? ' dark' : ''}`, null, desk);
  css(win, { x: WIN.x, y: WIN.y, width: WIN.w, height: WIN.h });
  win.style.setProperty('--k', k);
  const blur = h('div', 'blur', wall, win);
  css(blur, { left: -WIN.x, top: -WIN.y, width: DESK.w, height: DESK.h });
  h('div', 'wash', null, win); h('div', 'shellg', null, win);
  const rows = sidebar(win, KS, bots);
  const col = h('div', 'col', null, win);
  col.style.left = `${SIDE_W}px`;
  const colW = WIN.w - SIDE_W - 4 * k;
  // the pane's tabs: the Bot's direct (its picture and name), another conversation, + and the pane's ⋯
  const other = bots.find(b => !b.on);
  h('div', 'tabs', `<span class="tab on">${face(bot.who, 20 * k, true)}<span>${bot.name}</span><span class="x">${ic('x', 12, k)}</span></span>` +
    `<span class="tab">${face(other.who, 20 * k, true)}<span>${other.name}</span></span><span class="tplus">${ic('plus', 12, k)}</span><span class="tmore">${ic('more', 16, k)}</span>`, col);
  const card = h('div', 'card', null, col);
  const cardW = colW, cardH = WIN.h - 6 * k - 4 * k - 40 * k;
  const colw = Math.min(800 * k, cardW - 48 * k);
  card.style.setProperty('--colw', `${colw}px`);
  // the header: the Bot's picture and name, a second line while it is busy (or its pinned model), then the buttons
  const hd = h('div', 'chd', `${face(bot.who, 36 * k, true)}<div class="who"><span class="nm">${bot.name}</span><span class="st2"></span></div>` +
    `<div class="acts"><span class="ab">${ic('pin', 16, k)}</span><span class="ab">${ic('hierarchy', 16, k)}<span>${S.trace}</span></span>` +
    `<span class="ab">${ic('minimap', 16, k)}<span>${S.map}</span></span><span class="ab">${ic('settings', 16, k)}</span></div>`, card);
  const hdH = 57 * k;
  const tr = h('div', 'tr', null, card);
  css(tr, { top: hdH, bottom: 0 });
  const tri = h('div', 'tri', null, tr);
  // the composer: the words, then the clip, the Bot's picker, ✨ and send
  const comp = h('div', 'abs composer focus', null, card);
  css(comp, { width: colw });
  const compTxt = h('div', 'txt', '', comp);
  h('span', 'cb', ic('paperclip', 20, k), comp);
  const trig = h('span', 'tune', '', comp);
  h('span', 'gap', null, comp);
  const sug = h('span', 'cb sug', ic('sparkles', 16, k), comp);
  const send = h('span', 'cb send off', ic('arrow-up', 20, k), comp);
  return { desk, win, col, card, hd, st: hd.querySelector('.st2'), tr, tri, comp, compTxt, trig, sug, send, rows, k, colw, cardW, cardH, hdH, x0: (cardW - colw) / 2 };
}
/** A finished reply's last line: how long it took and when (TranscriptBotGroup). */
const replyFoot = (k, took, time) => `${ic('clock', 12, k)}<span>${S.span(took)}</span><span>·</span><span>${time}</span>`;
/** A notice in the window's top-right corner (ToastHost.svelte): its mark, its words, ✕ in its countdown ring. */
function toast(win, k, words) {
  const el = h('div', 'abs toast', `<span class="tm">${ic('info', 16, k)}</span><span class="tw">${words}</span>` +
    `<span class="tx"><svg class="ring" width="${28 * k}" height="${28 * k}" viewBox="0 0 28 28"><circle class="trk" cx="14" cy="14" r="12.5"/>` +
    `<circle class="lft" cx="14" cy="14" r="12.5" pathLength="100" stroke-dasharray="100 100"/></svg>${ic('x', 12, k)}</span>`, win);
  el.style.setProperty('--k', k);
  return { el, ring: el.querySelector('.lft') };
}

// ---- Roles (RoutingTab.svelte, PlaybookList.svelte, PlaybookMap.svelte, PlaybookAddMenu.svelte, CustomStepDetail)
// The steps under each hook in PLAYBOOK_STEPS' order (packages/protocol/src/playbooks.ts).
const ROUNDS = [
  ['line', ['intake', 'reader', 'jobs', 'scribe', 'derived_checks', 'large_job']], ['group', ['judgement']],
  ['turn', ['pacing', 'compaction', 'closing', 'settle', 'check_backs', 'pickup']], ['handed_in', ['checks', 'wait_word', 'escalation', 'ceiling']],
  ['accepted', ['retrospective']], ['overturned', ['reflection']], ['compose', ['composer']]
];
// The rounds a step of your own can be added to (playbook-flow.ts CUSTOM_HOOKS): each ends in an add card.
const CUSTOM_HOOKS = ['turn', 'handed_in', 'accepted', 'overturned'];
// What each step says on the map under 通用 (PlaybookMap's said(): a call's model, else its first number, else 开).
const OFF = new Set(['scribe', 'reflection']);
const SAID = {
  intake: `45 ${S.unit.s}`, reader: S.follows, jobs: S.on, scribe: S.offShort, derived_checks: S.on, large_job: S.on, judgement: S.follows,
  pacing: `40 ${S.unit.hops}`, compaction: S.follows, closing: S.on, settle: S.follows, check_backs: `5 ${S.unit.min}`, pickup: `2 ${S.unit.min}`,
  checks: S.follows, wait_word: S.on, escalation: '2', ceiling: '3', retrospective: S.follows, reflection: S.offShort, composer: S.follows
};
// Locked under 通用: running and not switchable, or held on while jobs runs (stepLocked).
const LOCKED = new Set(['intake', 'reader', 'compaction', 'check_backs', 'checks', 'composer']);
/**
 * layPlaybookFlow (settings/playbook-flow.ts), its spine half, with the steps of your own after the built-in ones
 * in their round and an add card closing each round that takes one. App px in, boxes out.
 */
function layFlow(available, own) {
  const ROOT_W = 196, ROOT_H = 38, STEP_W = 184, STEP_H = 54, GAP_X = 14, ROW_GAP = 12, ROUND_GAP = 26, PAD = 16, INDENT = 26;
  const width = Math.max(available, ROOT_W + 2 * PAD, 150 + INDENT + 2 * PAD), inner = width - 2 * PAD;
  const across = Math.max(1, Math.floor((inner + GAP_X) / (STEP_W + GAP_X)));
  const rows = ROUNDS.map(([hook, steps]) => [...steps.map(id => ({ id, kind: 'step' })), ...own.filter(o => o.hook === hook).map(o => ({ id: o.id, kind: 'own' })),
    ...(CUSTOM_HOOKS.includes(hook) ? [{ id: `add:${hook}`, kind: 'add' }] : [])]);
  if (rows.every(r => r.length <= across)) throw new Error('the map would fan out');
  const cards = [], edges = [];
  let y = PAD;
  ROUNDS.forEach(([hook], i) => {
    const rootH = hook === 'turn' ? STEP_H : ROOT_H, root = { id: hook === 'turn' ? 'turn' : `root:${hook}`, hook, kind: 'root', x: PAD, y, w: ROOT_W, h: rootH };
    cards.push(root);
    y += rootH + ROW_GAP;
    for (const step of rows[i]) {
      const x = PAD + INDENT;
      cards.push({ ...step, hook, x, y, w: Math.max(150, Math.min(320, width - PAD - x)), h: STEP_H });
      const sx = root.x + 14, y1 = root.y + rootH, y2 = y + STEP_H / 2;
      if (step.kind !== 'add') edges.push({ to: step.id, d: `M ${sx} ${y1} L ${sx} ${y2 - 8} Q ${sx} ${y2}, ${sx + 8} ${y2} L ${x} ${y2}` });
      y += STEP_H + ROW_GAP;
    }
    y += ROUND_GAP - ROW_GAP;
  });
  return { width, height: y - ROUND_GAP + PAD, cards, edges };
}
// the step of your own the film adds: the template 「收尾前跑测试」 (custom-step-templates.ts: turn_end, pnpm test,
// 600 s, a no sends it back), switched on before Save
const OWN = { id: 'u_tests', hook: 'turn' };

// ---- the code block in the dark scene: Shiki's tokens, coloured by the theme in force (film.css)
const T = (cls, s) => `<span class="${cls}">${s}</span>`;
const CODE = [
  `${T('kw', 'export')} ${T('kw', 'function')} ${T('fn', 'greet')}${T('pu', '(')}${T('pa', 'name')}${T('op', ':')} ${T('ty', 'string')}${T('pu', ')')}${T('op', ':')} ${T('ty', 'string')} ${T('pu', '{')}`,
  `  ${T('kw', 'return')} ${T('kw', 'new')} ${T('cls', 'Date')}${T('pu', '().')}${T('fn', 'getHours')}${T('pu', '()')} ${T('op', '&lt;')} ${T('nu', '12')} ${T('op', '?')} ${T('st', '`' + S.greetA)}${T('tp', '${')}${T('pu', 'name')}${T('tp', '}')}${T('st', '`')} ${T('op', ':')} ${T('st', '`' + S.greetB)}${T('tp', '${')}${T('pu', 'name')}${T('tp', '}')}${T('st', '`')}${T('pu', ';')}`,
  T('pu', '}')
].join('\n');

function build() {
  R.dim = document.getElementById('dusk');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };

  // ---- 0–4 the release: 0.3.0 turns over to 0.4.0
  R.badge = h('div', 'abs', null, stage);
  R.bMark = h('div', 'abs', markSVG(200), R.badge);
  R.bWord = h('div', 'abs word', S.word, R.badge);
  const [major, minor, patch] = S.version.split('.'), from = S.from.split('.')[1];
  R.ver = h('div', 'abs ver', `<span>${major}.</span><span class="roll"><span class="col"><span>${from}</span><span>${minor}</span></span></span><span>.${patch}</span>`, R.badge);
  R.roll = R.ver.querySelector('.roll'); R.rollCol = R.ver.querySelector('.col');
  R.count = h('div', 'abs pill count', `${ic('check', 12)}${S.count}`, R.badge);
  R.mac = h('div', 'abs platform', `${ic('check', 16)}<span>${S.mac}</span>`, stage);
  R.win = h('div', 'abs platform quiet', `${ic('minimap', 16)}<span>${S.win}</span>`, stage);
  R.lin = h('div', 'abs platform quiet', `${ic('minimap', 16)}<span>${S.linux}</span><span class="new">${S.isNew}</span>`, stage);

  // ---- 4–10 a Bot's direct: you ask, edit_interface applies, the window turns purple and frosted
  const botsA = [{ who: 'pudding', name: S.botA, time: '09:41', prev: S.botAPrev, on: true }, { who: 'mochi', name: S.botB, time: LANG === 'zh' ? '昨天' : 'Yesterday', prev: S.botBPrev }];
  const A = R.A = deskWindow({ k: KL, bots: botsA, bot: botsA[0] });
  A.side = A.rows[0];
  setHTML(A.trig, `<span>${S.auto}</span><span class="arr">${ic('chevron-down', 12, KL)}</span>`);
  A.earlier = h('div', 'abs reply', `<p>${S.earlier.replace('docs/weekly.md', '<code class="i">docs/weekly.md</code>')}</p>`, A.tri);
  A.earlierF = h('div', 'abs rfoot', replyFoot(KL, '3.2', '09:41'), A.tri);
  A.you = h('div', 'abs you', S.askLook, A.tri);
  A.youT = h('div', 'abs youT', '10:42', A.tri);
  A.reply = h('div', 'abs reply', '<p></p>', A.tri);
  A.replyP = A.reply.querySelector('p');
  A.sfoot = h('div', 'abs sfoot', `<span class="pulse"></span><span class="sst"></span><span class="dur">${ic('clock', 12, KL)}<span class="d"></span></span>`, A.tri);
  A.sst = A.sfoot.querySelector('.sst'); A.sd = A.sfoot.querySelector('.d');
  A.rfoot = h('div', 'abs rfoot', replyFoot(KL, '2.3', '10:42'), A.tri);
  A.chip = h('div', 'abs ichip', `<b>${S.chipLabel}</b><span class="tx">${S.chipLook}</span><span class="un">${S.chipUndo}</span>`, A.tri);
  A.toast = toast(A.win, KL, S.toast(S.botA));

  // ---- 10–14 the same direct in the dark look: Dracula for code
  const B = R.B = deskWindow({ k: KD, dark: true, bots: botsA, bot: botsA[0] });
  B.win.classList.add('glass');
  B.side = B.rows[0];
  setHTML(B.trig, `<span>${S.auto}</span><span class="arr">${ic('chevron-down', 12, KD)}</span>`);
  B.code = h('div', 'abs codeb-wrap', `<div class="codeb"><div class="chead"><span class="lang">ts</span><span class="cp">${ic('copy', 12, KD)}<span>${S.copyCode}</span></span></div><pre>${CODE}</pre></div>`, B.tri);
  B.block = B.code.querySelector('.codeb');
  css(B.code, { width: B.colw });
  B.codeF = h('div', 'abs rfoot', replyFoot(KD, '6.8', '21:05'), B.tri);
  B.you = h('div', 'abs you', S.askCode, B.tri);
  B.youT = h('div', 'abs youT', '21:07', B.tri);
  B.reply = h('div', 'abs reply', '<p></p>', B.tri);
  B.replyP = B.reply.querySelector('p');
  B.sfoot = h('div', 'abs sfoot', `<span class="pulse"></span><span class="sst"></span><span class="dur">${ic('clock', 12, KD)}<span class="d"></span></span>`, B.tri);
  B.sst = B.sfoot.querySelector('.sst'); B.sd = B.sfoot.querySelector('.d');
  B.rfoot = h('div', 'abs rfoot', replyFoot(KD, '2.1', '21:07'), B.tri);
  B.chip = h('div', 'abs ichip', `<b>${S.chipLabel}</b><span class="tx">${S.chipCode}</span><span class="un">${S.chipUndo}</span>`, B.tri);
  B.toast = toast(B.win, KD, S.toast(S.botA));

  // ---- 14–19 Roles, a tab of its own: 通用's map, the add card at the end of a Bot's turn, its menu, the panel
  R.roles = h('div', 'abs pane roles', null, stage);
  css(R.roles, { width: 1400, height: 760 });
  R.roles.style.setProperty('--k', KR);
  h('div', 'rstrip', `<span class="rtab">${ic('nodes', 16, KR)}<span>${S.rolesTab}</span></span>`, R.roles);
  const wide = h('div', 'rwide', null, R.roles);
  const list = h('div', 'rlist', null, wide);
  h('div', 'rlhead', `<span>${S.engines}</span><span class="rladd">${ic('plus', 16, KR)}</span>`, list);
  S.engineNames.forEach((n, i) => h('div', `erow${i === 0 ? ' on' : ''}`, `<span class="en">${i === 0 ? '<span class="star">★</span>' : ''}<span class="et">${n}</span></span><span class="etime"></span><span class="el">${S.engineLines[i]}</span>`, list));
  const main = h('div', 'rmain', null, wide);
  const top = h('div', 'rtop', null, main);
  h('p', 'rhint', S.engineLines[0], top);
  h('p', 'rintro', S.intro, top);
  const split = h('div', 'rsplit', null, main);
  R.mapCol = h('div', 'rmapcol', null, split);
  R.flow = h('div', 'pflow', null, R.mapCol);
  R.detail = h('div', 'rdetail', null, split);
  // the built-in step picked when the scene opens: 收尾自检, running under 通用
  R.closingPanel = h('div', 'pstep', `<div class="psh"><h3>${S.steps.closing}</h3><p class="phint">${S.closingHint}</p></div>` +
    `<div class="ppart"><h4>${S.runs} · ${S.engineNames[0]}</h4><div class="psw"><span class="sw on"><span class="th" style="translate:${18 * KR}px 0"></span></span><span class="pstate">${S.on}</span></div></div>`, R.detail);
  // the step of your own, a draft from the template until Save (CustomStepDetail.svelte)
  const o = S.own, sel = v => `<div class="own-input own-sel"><span>${v}</span>${ic('chevron-down', 12, KR)}</div>`;
  R.ownPanel = h('section', 'own-step', `<div class="own-head"><h3>${o.tests}</h3><p class="own-hint"></p></div>` +
    `<div class="own-part"><label class="own-field"><span class="own-label">${o.name}</span><div class="own-input">${o.tests}</div><span class="own-note">${o.nameHint}</span></label>` +
    `<div class="own-sw"><span class="sw"><span class="th"></span></span><span class="ost"></span></div></div>` +
    `<div class="own-part"><div class="own-field"><span class="own-label">${o.moment}</span>${sel(o.momentValue)}<span class="own-note">${o.momentHint}</span></div></div>` +
    `<div class="own-part"><h4>${o.looksAt}</h4><label class="own-field"><span class="own-label">${o.paths}</span><div class="own-input text"></div><span class="own-note">${o.pathsHint}</span></label></div>` +
    `<div class="own-part"><h4>${o.judges}</h4><div class="own-kinds">${o.kinds.map((n, i) => `<span class="own-kind${i === 1 ? ' on' : ''}">${n}</span>`).join('')}</div><p class="own-note">${o.kindHint}</p>` +
    `<label class="own-field"><span class="own-label">${o.command}</span><div class="own-input text code">pnpm test</div><span class="own-note">${o.commandHint}</span></label>` +
    `<label class="own-field"><span class="own-label">${o.folder}</span><div class="own-input"></div><span class="own-note">${o.folderHint}</span></label>` +
    `<label class="own-field inline"><span class="own-label">${o.timeout}</span><span class="own-inline"><span class="own-input num">600</span><span class="own-note">${o.timeoutNote}</span></span></label></div>` +
    `<div class="own-part"><div class="own-field"><span class="own-label">${o.thenTitle}</span>${sel(o.thenValue)}<span class="own-note">${o.thenHint}</span></div></div>` +
    `<div class="own-part"><h4>${o.tryTitle}</h4><p class="own-note">${o.tryHint}</p><label class="own-field"><span class="own-label">${o.tryReply}</span><div class="own-input text"></div></label>` +
    `<div class="own-actions"><span class="btn secondary">${o.tryRun}</span></div></div>` +
    `<div class="own-part"><div class="own-actions"><span class="btn primary osave">${o.save}</span><span class="btn ghost ocancel">${o.cancel}</span><span class="btn danger odel">${o.del}</span></div></div>`, R.detail);
  R.ownHint = R.ownPanel.querySelector('.own-hint');
  R.ownSw = R.ownPanel.querySelector('.sw'); R.ownTh = R.ownSw.querySelector('.th'); R.ownSt = R.ownPanel.querySelector('.ost');
  R.ownSave = R.ownPanel.querySelector('.osave'); R.ownCancel = R.ownPanel.querySelector('.ocancel'); R.ownDel = R.ownPanel.querySelector('.odel');
  // the add card's menu: the turn round's starting points, then a blank step
  R.amenu = h('div', 'abs amenu', `<p class="at">${o.templatesTitle}</p>` +
    `<div class="ai"><span class="an">${o.tests}</span><span class="ah">${o.testsHint}</span></div>` +
    `<div class="ai"><span class="an">${o.rules}</span><span class="ah">${o.rulesHint}</span></div>` +
    `<div class="as"></div><div class="ai"><span class="an">${ic('plus', 12, KR)} ${o.blank}</span></div>`, R.roles);
  R.amItems = [...R.amenu.querySelectorAll('.ai')];

  // ---- 19–24 another Bot's direct, as the app ships it: the picker in its composer
  const botsC = [{ who: 'mochi', name: S.botC, time: '11:20', prev: S.botCPrev, on: true }, { who: 'pudding', name: S.botA, time: '10:42', prev: S.replyLook }];
  const C = R.C = deskWindow({ k: KL, bots: botsC, bot: botsC[0] });
  C.earlier = h('div', 'abs reply', `<p>${S.earlierPick.replace(/cuts\/teaser-v3\.mp4/, '<code class="i">cuts/teaser-v3.mp4</code>')}</p>`, C.tri);
  C.earlierF = h('div', 'abs rfoot', replyFoot(KL, '41.6', '11:20'), C.tri);
  C.trigBefore = `<span>${S.auto}</span><span class="arr">${ic('chevron-down', 12, KL)}</span>`;
  C.trigAfter = `<span class="srcmark">${S.custom}</span><span>${S.models[0]}<span class="sep"> · </span>${S.levels[3]}</span><span class="aside">${S.endpoints[0]}</span><span class="arr">${ic('chevron-down', 12, KL)}</span>`;
  // the columns: endpoint (240), model (290), thinking level (140) — TunePicker's widths from bot-tune.ts
  C.panel = h('div', 'abs tpanel', null, C.win);
  const col = (w, head, rows) => {
    const el = h('div', 'tcol', `<div class="th">${head}</div>`, C.panel);
    el.style.width = `${w * KL}px`;
    return { el, rows: rows.map(r => h('div', 'trow', `<span class="tt"><span class="tl">${r.label}</span>${r.detail ? `<span class="td">${r.detail}</span>` : ''}</span>` +
      `${r.checked ? `<span class="ck">${ic('check', 12, KL)}</span>` : ''}${r.more ? `<span class="mo">${ic('chevron-right', 12, KL)}</span>` : ''}`, el)) };
  };
  C.cols = [
    col(240, S.colEndpoint, [{ label: S.auto, detail: S.autoHint, checked: true }, ...S.endpoints.map(e => ({ label: e, more: true }))]),
    col(290, S.colModel, S.models.map(m => ({ label: m, more: true }))),
    col(140, S.colThinking, S.levels.map(l => ({ label: l })))
  ];
  C.cols[0].rows[0].classList.add('checked');

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

/** The engine map, both ways (before and after Save), laid out for the map column's width once the page has its size. */
function buildMap() {
  const avail = R.mapCol.getBoundingClientRect().width / KR;
  const lay = [layFlow(avail, []), layFlow(avail, [OWN])];
  R.lay = lay;
  css(R.flow, { width: lay[1].width * KR, height: lay[1].height * KR });
  R.svgs = lay.map(L => {
    R.flow.insertAdjacentHTML('beforeend', `<svg class="pedges" width="${L.width * KR}" height="${L.height * KR}" viewBox="0 0 ${L.width} ${L.height}">${L.edges.map(e => `<path class="${OFF.has(e.to) ? 'off' : ''}" d="${e.d}"/>`).join('')}</svg>`);
    return R.flow.lastElementChild;
  });
  R.cards = {};
  for (const c of lay[1].cards) {
    const el = h('div', `pcard ${c.kind === 'own' ? 'step own-card' : c.kind}${c.id === 'turn' ? ' turn' : ''}${OFF.has(c.id) ? ' off' : ''}`, null, R.flow);
    if (c.kind === 'root') el.innerHTML = c.id === 'turn' ? `<span class="ct">${S.hooks.turn}</span><span class="cs">${S.turnModel}</span>` : `<span class="ct">${S.hooks[c.hook]}</span>`;
    else if (c.kind === 'add') el.innerHTML = `<span class="ct">${ic('plus', 12, KR)} ${S.own.add}</span>`;
    else if (c.kind === 'own') el.innerHTML = `<span class="ch"><i class="cd"></i><span class="ct">${S.own.tests}</span><span class="own">${S.own.mine}</span></span><span class="cs">${S.own.said}</span>`;
    else el.innerHTML = `<span class="ch"><i class="cd"></i><span class="ct">${S.steps[c.id]}</span>${LOCKED.has(c.id) ? `<span class="lk">${ic('lock', 12, KR)}</span>` : ''}</span><span class="cs">${SAID[c.id]}</span>`;
    R.cards[c.id] = el;
  }
  R.addCard = R.cards['add:turn'];
  // the map opens on a Bot's turn and glides down to its add card, which stays in view after Save
  const mapH = R.mapCol.getBoundingClientRect().height / KR;
  const add1 = lay[1].cards.find(c => c.id === 'add:turn'), turn = lay[1].cards.find(c => c.id === 'turn');
  R.mapFrom = Math.max(0, turn.y - 8);
  R.mapTo = Math.max(R.mapFrom, add1.y + add1.h + 14 - mapH);
}
/** Places the map's cards as one layout or the other (no slide: a card moving with the layout jumps, as in the app). */
function placeMap(saved) {
  const L = R.lay[saved ? 1 : 0];
  const byId = Object.fromEntries(L.cards.map(c => [c.id, c]));
  for (const id in R.cards) {
    const c = byId[id], el = R.cards[id];
    el.style.display = c ? '' : 'none';
    if (c) css(el, { left: c.x * KR, top: c.y * KR, width: c.w * KR, height: c.h * KR });
  }
  R.svgs[0].style.display = saved ? 'none' : '';
  R.svgs[1].style.display = saved ? '' : 'none';
}

const M = {};
function measure() {
  const w = el => el.getBoundingClientRect().width, hh = el => el.getBoundingClientRect().height;
  M.bWordW = w(R.bWord); M.bWordH = hh(R.bWord); M.verW = w(R.ver); M.countW = w(R.count);
  M.macW = w(R.mac); M.winW = w(R.win); M.linW = w(R.lin);
  M.moreW = R.more.map(w);
  M.wordW = w(R.word); M.wordH = hh(R.word); M.endVerW = w(R.endVer); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
  for (const W of [R.A, R.B, R.C]) W.compH = W.comp.offsetHeight;
}

// ---------------------------------------------------------------- headlines (one slot, top left)
const HEADS = { look: [4.05, 9.85], code: [10.05, 13.85], steps: [14.05, 18.85], model: [19.05, 23.85], more: [24.05, 26.25] };
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
  // the dark look quiets the room a little while the song breaks down
  R.dim.style.opacity = (0.24 * E.smooth(inv(10.6, 11.3, t)) * (1 - E.smooth(inv(13.4, 13.9, t)))).toFixed(3);
}

// ---------------------------------------------------------------- pointer
// Each pass: shown from a to b, it travels from `from` (or where the pass before it ended) onto el by `at`, and
// presses there when click is set (at `at`, or at click's time). A pass that follows on from the last does not fade in.
const POINTS = [
  { a: 14.45, at: 14.9, b: 15.3, from: [1450, 1060], el: () => R.addCard, click: 15.0, center: true },
  { a: 15.3, at: 15.75, b: 16.05, from: 'prev', el: () => R.amItems[0], dx: 0.3, click: 15.9 },
  { a: 16.05, at: 16.35, b: 16.75, from: 'prev', el: () => R.ownSw, center: true, click: 16.45 },
  { a: 16.75, at: 17.45, b: 17.95, from: 'prev', el: () => R.ownSave, center: true, click: 17.6 },
  { a: 19.35, at: 19.72, b: 20.05, from: [1400, 1060], el: () => R.C.trig, click: 19.8, dx: 0.4 },
  { a: 20.05, at: 20.4, b: 20.75, from: 'prev', el: () => R.C.cols[0].rows[1], dx: 0.45 },
  { a: 20.75, at: 21.1, b: 21.45, from: 'prev', el: () => R.C.cols[1].rows[0], dx: 0.35 },
  { a: 21.45, at: 21.85, b: 22.45, from: 'prev', el: () => R.C.cols[2].rows[3], dx: 0.4, click: 22.05 }
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
    const ca = typeof p.click === 'number' ? p.click : p.at;
    const press = p.click && t > ca - 0.02 && t < ca + 0.07 ? 3 : 0;
    const fin = chained ? 1 : E.out(inv(p.a, p.a + 0.14, t));
    const fout = next && next.from === 'prev' && Math.abs(next.a - p.b) < 1e-6 ? 0 : E.in(inv(p.b - 0.2, p.b, t));
    pos = { x: lerp(fx, tx - 6, u), y: lerp(fy, ty - 4, u) + press, o: Math.min(fin, 1 - fout) };
    if (p.click && t >= ca && t < ca + 0.45) click = { at: ca, x: tx, y: ty };
  });
  if (pos) css(R.pointer, { x: pos.x, y: pos.y, opacity: pos.o }); else R.pointer.style.opacity = 0;
  if (click) {
    const u = inv(click.at, click.at + 0.45, t);
    css(R.ripple, { x: click.x, y: click.y, s: lerp(0.25, 1.25, E.out(u)), opacity: 0.7 * (1 - u) });
  } else R.ripple.style.opacity = 0;
}

// ---------------------------------------------------------------- 0–4 · 0.3.0 turns over to 0.4.0
function poseRelease(t) {
  const { mochi, pudding } = R.cast;
  const on = t < 4.1;
  show(R.badge, on); show(R.mac, on && t >= 2.45); show(R.win, on && t >= 2.6); show(R.lin, on && t >= 2.75);
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
  // the version is there from the start as 0.3.0; its middle digit shakes, then rolls over to 4 on the 2.0 downbeat
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
  const gap = 24, rowW = M.macW + gap + M.winW + gap + M.linW, rx = (1920 - rowW) / 2;
  const chip = (el, a, x) => { const u = E.pop(inv(a, a + 0.32, t)); el.style.transformOrigin = '50% 50%'; css(el, { x, y: 590 + lerp(24, 0, E.out(inv(a, a + 0.3, t))) - 40 * ex, s: lerp(0.85, 1, u), opacity: clamp(inv(a, a + 0.15, t)) * (1 - ex) }); };
  chip(R.mac, 2.45, rx); chip(R.win, 2.6, rx + M.macW + gap); chip(R.lin, 2.75, rx + M.macW + gap + M.winW + gap);
  // Mochi and Pudding come to see it, and cheer when it turns over
  if (t < 4.2) {
    const s = seq(t, [[0, 'hop'], [0.72, 'idle', true], [2.0, 'cheer'], [3.43, 'hop']]);
    const x = t < 3.43 ? hopX(t, 0, -180, 300) : hopX(t, 3.43, 300, -260);
    mochi.pose({ ...s, x, s: 420, flip: t >= 3.43 });
  }
  const sp = seq(t, [[0.3, 'hop'], [1.02, 'idle', true], [2.05, 'cheer'], [3.48, 'idle', true]]);
  if (t >= 0.3 && t < 4.0) pudding.pose({ ...sp, x: hopX(t, 0.3, 2150, 1660), s: 440, flip: true });
}

// ---------------------------------------------------------------- the conversation's transcript, top down
// Lays out the given items from y (app px × k): [el, x 'left'|'right', gap after]; returns the end. Items shown
// or not by the caller; only those counted add height.
function stack(W, items, y0) {
  let y = y0;
  for (const [el, side, gap, counts = true] of items) {
    const x = side === 'right' ? W.x0 + W.colw - el.offsetWidth : W.x0;
    at(el, x, y);
    if (counts) y += el.offsetHeight + gap * W.k;
  }
  return y;
}
/** Follows the end of the conversation as it does while you are at the bottom: the composer floats over the foot. */
function follow(W, end) {
  const room = W.cardH - W.hdH - W.compH - 12 * W.k - 10 * W.k;
  W.tri.style.translate = `0 ${(-Math.max(0, end - room)).toFixed(1)}px`;
}
function poseComposer(W, text, { busy = false } = {}) {
  setHTML(W.compTxt, text ? `${text}<span class="caret"></span>` : `<span class="caret lead"></span><span class="ph">${S.placeholder(W === R.C ? S.botC : S.botA)}</span>`);
  W.send.className = `cb send${busy ? ' stop' : text ? '' : ' off'}`;
  setHTML(W.send, busy ? ic('stop', 20, W.k) : ic('arrow-up', 20, W.k));
  W.sug.classList.toggle('off', busy);
  css(W.comp, { x: W.x0, y: W.cardH - 12 * W.k - W.comp.offsetHeight });
}
/** The notice's card, sliding in from the right at a, its ring emptying over 4 s. */
function poseToast(W, t, a) {
  const el = W.toast.el;
  if (!show(el, t >= a)) return;
  const u = E.out4(inv(a, a + 0.26, t));
  at(el, WIN.w - 16 * W.k - el.offsetWidth, 48 * W.k);
  el.style.translate = `${lerp(16 * W.k, 0, u).toFixed(1)}px 0`;
  el.style.opacity = clamp(inv(a, a + 0.18, t)).toFixed(3);
  W.toast.ring.setAttribute('stroke-dashoffset', (-100 * clamp((t - a) / 4)).toFixed(2));
}
/** The Bot's state on its sidebar row and in the header's second line. */
function poseBusy(W, label) {
  W.side.status(label);
  setHTML(W.st, label ? `<span class="pd"></span><span>${label}</span>` : '');
}

// ---------------------------------------------------------------- 4–10 · you ask; the window turns
function poseLook(t) {
  const A = R.A;
  const kids = [A.toast.el, A.you, A.youT, A.reply, A.sfoot, A.rfoot, A.chip];
  if (!panel(A.desk, t, 4.15, 9.95, DESK.x, DESK.y)) { kids.forEach(e => show(e, false)); return; }
  // edit_interface applies when it runs: the accent family and glass content at once, before the reply
  const done = t >= 6.5;
  A.win.classList.toggle('purple', done);
  A.win.classList.toggle('glass', done);
  // the composer: your line typed, sent; while the turn runs, Stop
  const sent = t >= 5.2, busy = sent && t < 7.45;
  poseComposer(A, t >= 4.55 && !sent ? typed(S.askLook, t, 4.55, 5.05) : '', { busy });
  // the Bot at work: thinking, calling edit_interface, thinking after it, writing; then the reply
  const streaming = t >= 6.85 && t < 7.45, finished = t >= 7.45;
  poseBusy(A, !busy ? '' : streaming ? S.stReplying : S.stThinking);
  A.side.s.textContent = finished ? S.replyLook : S.botAPrev;
  setText(A.sst, t < 5.6 ? S.thinking : t < 6.5 ? S.calling : streaming ? S.streaming : S.called);
  setText(A.sd, live(t - 5.2));
  const words = finished ? S.replyLook : typed(S.replyLook, t, 6.85, 7.4);
  setHTML(A.replyP, words + (streaming ? '<span class="cursor"></span>' : ''));
  // the transcript, top down (laid out first: the scroll reads where its end is)
  const y = stack(A, [[A.earlier, 'left', 12], [A.earlierF, 'left', 16], [A.you, 'right', 4, sent], [A.youT, 'right', 16, sent],
    [A.reply, 'left', streaming || finished ? 12 : 0, streaming || finished], [A.sfoot, 'left', 12, busy && !finished], [A.rfoot, 'left', 6, finished], [A.chip, 'left', 0, done]], 16 * KL);
  follow(A, y + 16 * KL);
  show(A.you, sent); show(A.youT, sent);
  if (sent) { A.you.style.opacity = clamp(inv(5.2, 5.3, t)).toFixed(3); }
  show(A.reply, streaming || finished); show(A.sfoot, busy && !finished); show(A.rfoot, finished);
  if (show(A.chip, done)) A.chip.style.opacity = clamp(inv(6.5, 6.62, t)).toFixed(3);
  poseToast(A, t, 6.52);
}

// ---------------------------------------------------------------- 10–14 · Dracula for code, in the dark look
function poseCode(t) {
  const B = R.B;
  const kids = [B.toast.el, B.you, B.youT, B.reply, B.sfoot, B.rfoot, B.chip];
  if (!panel(B.desk, t, 9.95, 13.95, DESK.x, DESK.y)) { kids.forEach(e => show(e, false)); return; }
  const done = t >= 11.25;
  B.block.classList.toggle('dracula', done);
  const sent = t >= 10.55, busy = sent && t < 11.95;
  poseComposer(B, t >= 10.15 && !sent ? typed(S.askCode, t, 10.15, 10.45) : '', { busy });
  const streaming = t >= 11.5 && t < 11.95, finished = t >= 11.95;
  poseBusy(B, !busy ? '' : streaming ? S.stReplying : S.stThinking);
  B.side.s.textContent = finished ? S.replyCode : S.replyLook;
  setText(B.sst, t < 10.75 ? S.thinking : t < 11.25 ? S.calling : streaming ? S.streaming : S.called);
  setText(B.sd, live(t - 10.55));
  setHTML(B.replyP, (finished ? S.replyCode : typed(S.replyCode, t, 11.5, 11.9)) + (streaming ? '<span class="cursor"></span>' : ''));
  const y = stack(B, [[B.code, 'left', 12], [B.codeF, 'left', 16], [B.you, 'right', 4, sent], [B.youT, 'right', 16, sent],
    [B.reply, 'left', 12, streaming || finished], [B.sfoot, 'left', 12, busy && !finished], [B.rfoot, 'left', 6, finished], [B.chip, 'left', 0, done]], 12 * KD);
  follow(B, y + 14 * KD);
  show(B.you, sent); show(B.youT, sent);
  show(B.reply, streaming || finished); show(B.sfoot, busy && !finished); show(B.rfoot, finished);
  if (show(B.chip, done)) B.chip.style.opacity = clamp(inv(11.25, 11.37, t)).toFixed(3);
  poseToast(B, t, 11.27);
}

// ---------------------------------------------------------------- 14–19 · Roles: a step of your own
function poseRoles(t) {
  const kids = [R.amenu, R.closingPanel, R.ownPanel];
  if (!panel(R.roles, t, 14.0, 18.95, 120, 262)) { kids.forEach(e => show(e, false)); return; }
  const saved = t >= 17.6, drafting = t >= 15.9;
  // the map: the add card under the pointer, pressed; after Save the step sits in the round, picked
  placeMap(saved);
  R.flow.style.translate = `0 ${(-lerp(R.mapFrom, R.mapTo, E.inOut(inv(14.35, 14.85, t))) * KR).toFixed(1)}px`;
  R.cards.closing.classList.toggle('sel', !drafting);
  R.cards[OWN.id].classList.toggle('sel', saved);
  R.addCard.classList.toggle('hot', t > 14.85 && t < 15.95);
  // its menu, under the card or over it when the pane (the window here) has no room below; laid out whether shown
  // or not, so a pass of the pointer reads the same rows
  show(R.amenu, t >= 15.0 && t < 15.9);
  {
    const a = R.addCard.getBoundingClientRect(), p = R.roles.getBoundingClientRect(), s = p.width / 1400;
    const mh = R.amenu.offsetHeight, mw = R.amenu.offsetWidth;
    const below = (a.bottom - p.top) / s + 4 * KR;
    const y = below + mh <= 760 - 8 * KR ? below : (a.top - p.top) / s - mh - 4 * KR;
    const x = Math.max(8 * KR, Math.min((a.left - p.left) / s, 1400 - mw - 8 * KR));
    css(R.amenu, { x, y, opacity: clamp(inv(15.0, 15.08, t)) });
    R.amItems.forEach((el, i) => el.classList.toggle('hot', i === 0 && t > 15.6));
  }
  // the panel: 收尾自检 until the template is picked; then the draft, switched on, scrolled down, saved
  show(R.closingPanel, !drafting);
  if (show(R.ownPanel, drafting)) {
    R.ownPanel.style.opacity = clamp(inv(15.9, 16.0, t)).toFixed(3);
    setText(R.ownHint, `${S.own.mineTitle} · ${S.engineNames[0]}${saved ? '' : ` · ${S.own.draft}`}`);
    const on = t >= 16.45, sw = E.inOut(inv(16.45, 16.6, t));
    R.ownTh.style.translate = `${(18 * KR * sw).toFixed(1)}px 0`;
    R.ownSw.classList.toggle('on', sw >= 0.5);
    setText(R.ownSt, on ? S.own.on : S.off);
    R.ownCancel.style.display = saved ? 'none' : ''; R.ownDel.style.display = saved ? '' : 'none';
    R.ownSave.classList.toggle('pressed', t >= 17.58 && t < 17.68);
    // scrolled to how it judges, then down to Save
    const room = R.detail.getBoundingClientRect().height, full = R.ownPanel.offsetHeight;
    const judge = R.ownPanel.querySelectorAll('.own-part')[3].offsetTop;
    const end = Math.max(0, full - room + 2);
    const sc = lerp(0, Math.min(judge - 12, end), E.inOut(inv(16.65, 16.95, t))) + (end - Math.min(judge - 12, end)) * E.inOut(inv(17.05, 17.35, t));
    R.ownPanel.style.translate = `0 ${(-sc).toFixed(1)}px`;
  }
}

// ---------------------------------------------------------------- 19–24 · a Bot's model, a level at a time
function posePick(t) {
  const C = R.C;
  const cols = C.cols.map(c => c.el);
  const kids = [C.panel, ...cols];
  if (!panel(C.desk, t, 19.0, 23.95, DESK.x, DESK.y)) { kids.forEach(e => show(e, false)); return; }
  const picked = t >= 22.05, open = t >= 19.8 && !picked;
  setHTML(C.trig, picked ? C.trigAfter : C.trigBefore);
  C.trig.classList.toggle('open', open);
  // a pinned model shows in the header's second line
  setHTML(C.st, picked ? `<span class="mchip">${S.models[0]}</span>` : '');
  poseComposer(C, '');
  stack(C, [[C.earlier, 'left', 12], [C.earlierF, 'left', 0]], 16 * KL);
  C.tri.style.translate = '0 0';
  // the columns: the endpoints alone, then each one beside the row it came from
  const depth = !open ? 0 : t >= 21.24 ? 3 : t >= 20.49 ? 2 : 1;
  show(C.panel, open);
  cols.forEach((el, i) => show(el, open && i < depth));
  // laid out whether shown or not (hidden columns keep their place), so a pass of the pointer reads the same rows
  const [ep, md, lv] = C.cols;
  ep.rows[1].classList.toggle('hot', t >= 20.35);
  ep.rows[1].classList.toggle('focus', depth >= 2);
  md.rows[0].classList.toggle('hot', t >= 21.05);
  md.rows[0].classList.toggle('focus', depth >= 3);
  lv.rows[3].classList.toggle('hot', t >= 21.8);
  // place(): over the field, far enough left that every column that may open fits in the window; lineUp(): each
  // column after the first level with its row, moved back to the field's edge when it would not fit (film px)
  const k = KL, wr = C.win.getBoundingClientRect(), s = wr.width / WIN.w, tr = C.trig.getBoundingClientRect();
  const trigL = (tr.left - wr.left) / s, trigT = (tr.top - wr.top) / s;
  const reserve = (240 + 290 + 140) * k + 4 * k * 2;
  css(C.panel, { x: Math.max(8 * k, Math.min(trigL, WIN.w - 8 * k - reserve)), y: 0 });
  C.panel.style.top = 'auto';
  C.panel.style.bottom = `${(WIN.h - trigT + 4 * k).toFixed(1)}px`;
  const bottom = trigT - 4 * k, topEdge = 8 * k;
  cols.forEach(el => { el.style.marginBottom = '0px'; });
  [md, lv].forEach((c, i) => {
    const from = i === 0 ? ep.rows[1] : md.rows[0];
    const box = c.el.offsetHeight, lead = (c.rows[0].getBoundingClientRect().top - c.el.getBoundingClientRect().top) / s;
    const rowTop = (from.getBoundingClientRect().top - wr.top) / s;
    const colTop = Math.max(topEdge, Math.min(rowTop - lead, bottom - box));
    c.el.style.marginBottom = `${Math.max(0, bottom - colTop - box).toFixed(1)}px`;
  });
  // each opens as it does: the panel up out of the field, a column out of the one before it
  const fade = (el, a, dx, dy, d) => { const u = E.out(inv(a, a + d, t)); el.style.opacity = u.toFixed(3); el.style.translate = `${(dx * (1 - u)).toFixed(1)}px ${(dy * (1 - u)).toFixed(1)}px`; };
  fade(ep.el, 19.8, 0, 4 * k, 0.14); fade(md.el, 20.49, -6 * k, 0, 0.12); fade(lv.el, 21.24, -6 * k, 0, 0.12);
}

// ---------------------------------------------------------------- the cast beside each scene
function poseCast(t) {
  const { mochi, pudding, reviewer } = R.cast;
  // Pudding, who stayed from the opening, presents the window as it turns
  if (t >= 4.0 && t < 9.95) {
    const s = seq(t, [[4.0, 'idle', true], [6.55, 'present'], [7.55, 'idle', true], [8.35, 'nod'], [9.0, 'idle', true], [9.55, 'hop']]);
    pudding.pose({ ...s, x: t < 9.55 ? 1660 : hopX(t, 9.55, 1660, 2150), s: 440, flip: true });
  }
  // the Reviewer watches the code repaint, looks closer and nods it off
  if (t >= 9.9 && t < 14.3) {
    const s = seq(t, [[9.9, 'hop'], [10.62, 'think', true], [11.3, 'inspect'], [12.4, 'think', true], [12.9, 'nod'], [13.95, 'hop']]);
    const x = t < 13.95 ? hopX(t, 9.9, 2150, 1640) : hopX(t, 13.95, 1640, 2200);
    reviewer.pose({ ...s, x, s: 400, flip: t < 13.95 });
  }
  // Mochi types the step in and points at it; stays on for the picker
  if (t >= 13.9 && t < 23.6) {
    const s = seq(t, [[13.9, 'hop'], [14.62, 'type', true], [15.7, 'point'], [16.4, 'nod'], [17.65, 'point'], [18.4, 'idle', true], [20.5, 'nod'], [21.2, 'idle', true], [22.15, 'nod'], [22.8, 'idle', true]]);
    const x = t < 19.0 ? hopX(t, 13.9, 2150, 1640) : lerp(1640, 1515, E.inOut(inv(19.0, 19.5, t)));
    mochi.pose({ ...s, x, s: lerp(430, 380, inv(19.0, 19.4, t)), flip: true });
  }
  // the picker: Pudding and the Reviewer come to look, and cheer the pick
  if (t >= 19.2 && t < 23.62) {
    const s = seq(t, [[19.2, 'hop'], [19.92, 'idle', true], [20.6, 'nod'], [21.25, 'idle', true], [22.15, 'cheer'], [23.45, 'idle', true]]);
    pudding.pose({ ...s, x: hopX(t, 19.2, 2150, 1685), s: 360, flip: true });
  }
  if (t >= 19.45 && t < 24.0) {
    const s = seq(t, [[19.45, 'hop'], [20.17, 'inspect'], [21.4, 'think', true], [22.2, 'cheer'], [23.55, 'hop']]);
    const x = t < 23.55 ? hopX(t, 19.45, 2200, 1835) : hopX(t, 23.55, 1835, 1160);
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
    R.cast.mochi.pose({ ...seq(t, [[23.6, 'hop'], [24.32, 'idle', true], [25.3, 'cheer']]), x: hopX(t, 23.6, 1515, 760), s: 430, flip: t < 24.0 });
    R.cast.pudding.pose({ ...seq(t, [[23.62, 'hop'], [24.34, 'idle', true], [25.42, 'cheer']]), x: hopX(t, 23.62, 1685, 960), s: 380, flip: true });
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
  const circ = (el, a) => { const f = E.pop(inv(a, a + 0.3, t)); el.style.opacity = f > 0.001 ? 1 : 0; el.setAttribute('transform', `translate(${el.getAttribute('cx')} ${el.getAttribute('cy')}) scale(${f.toFixed(3)}) translate(-${el.getAttribute('cx')} -${el.getAttribute('cy')})`); };
  circ(R.mf, 27.05); circ(R.mm, 27.2);
  const onto = (actor, a, x0, s0, flip, cxm, end) => {
    if (t >= end + 0.02) return;
    const k = 360 / 64, tx = 960 - 180 + cxm * k, ty = 500 - 180 + 29 * k + 60;
    const u = E.inOut(inv(a + 0.08, end, t));
    actor.pose({ clip: 'idle', at: 0, x: lerp(x0, tx, u), y: lerp(GY, ty, u), air: 220 * Math.sin(u * Math.PI), s: lerp(s0, 170, u), flip, o: 1 - E.in(inv(end - 0.06, end, t)) });
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
  poseLook(t);
  poseCode(t);
  poseRoles(t);
  posePick(t);
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
  ['whoosh', 0.05, 'Mochi hops in'], ['whoosh', 0.35, 'Pudding hops in'], ['pop', 0.4, 'the name'], ['tick', 0.65, '0.3.0'],
  ['swish', 1.98, 'the digit rolls'], ['done', 2.0, '0.4.0 lands'], ['pop', 2.15, 'the count'], ['tick', 2.45, 'macOS'], ['tick', 2.6, 'Windows'], ['tick', 2.75, 'Linux'],
  ['whoosh', 4.15, 'the window'], ['enter', 5.2, 'your line'], ['swish', 6.5, 'the window turns'], ['pop', 6.52, 'the notice'], ['check', 7.45, 'the reply'],
  ['whoosh', 9.55, 'Pudding leaves'], ['whoosh', 9.9, 'the Reviewer'], ['whoosh', 9.95, 'the dark window'],
  ['enter', 10.55, 'your line'], ['swish', 11.25, 'the code repaints'], ['pop', 11.27, 'the notice'], ['check', 11.95, 'the reply'],
  ['whoosh', 13.9, 'Mochi'], ['whoosh', 14.0, 'Roles'], ['click', 15.0, 'add a step'], ['pop', 15.0, 'its menu'], ['click', 15.9, 'the template'],
  ['click', 16.45, 'the switch'], ['swish', 17.05, 'down to Save'], ['click', 17.6, 'Save'], ['pop', 17.62, 'the step on the map'],
  ['whoosh', 19.0, 'the direct'], ['whoosh', 19.2, 'Pudding'], ['whoosh', 19.45, 'the Reviewer'], ['click', 19.8, 'the picker'], ['pop', 19.8, 'the endpoints'],
  ['tick', 20.49, 'the models'], ['tick', 21.24, 'the levels'], ['click', 22.05, 'a level'], ['pop', 22.15, 'a cheer'],
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
