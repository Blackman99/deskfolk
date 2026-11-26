// The Deskfolk 0.7.0 release film: the reel's cast (Mochi, Pudding and the Reviewer) presents 0.7.0 on the native
// app's own surfaces, redrawn (apps/desktop-nsh). film.seek(t) poses everything from t alone and resolves once the
// sprites it chose have decoded.
// Timeline (120 BPM, a bar every 2 s, the 0.1.0 film's music edit):
//   0–4    0.6.0 turns over to 0.7.0, 24 updates, platform chips
//   4–10   Git & GitHub pane in project sessions (Changes Diff, Repo -> Worktree switcher, History Git Graph, GitHub PR/CI)
//   10–14  Project session consultants (breakdown, dusk): Consult switch + 2 consultants working & answering
//   14–19  Phone upgrades: top-right context ring & sheet, composer + sheet, multi-display remote screen picker
//   19–24  Desktop upgrades: Sidebar Active live strip, desktop context ring + draft, Antigravity tier in Usage
//   24–26.5 And more (6 chips)
//   26.5–30.5 The mark and end card (URL on the 28.0 hit)
import { clamp, lerp, inv, E, css, h } from '/launch/lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const P = S.platforms;
const DURATION = 30.5;
const FPS = 30;
const GY = 905;
let SP = null;
let FOLK = null;

const KD = 1.25, KPH = 0.88;
const DESK = { x: 96, y: 244, w: 1300, h: 780 }, WIN = { x: 34, y: 28, w: 1232, h: 724 };
const SIDE = 248;

const FILE = 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z';
const FOLDER = 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z';
const GEAR = 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';
const ICONS = {
  x: [{ p: 'M6 6l12 12M18 6 6 18' }],
  check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
  'check-circle': [{ c: [12, 12, 9] }, { p: 'm8 12.5 3 3 5-6' }],
  terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
  'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
  'chevron-up': [{ p: 'm18 15-6-6-6 6' }],
  'chevron-left': [{ p: 'm15 6-6 6 6 6' }],
  'chevron-right': [{ p: 'm9 6 6 6-6 6' }],
  plus: [{ p: 'M12 5v14M5 12h14' }],
  'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
  folder: [{ p: FOLDER }],
  file: [{ p: FILE }, { p: 'M14 3v5h5' }],
  paperclip: [{ p: 'm21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
  activity: [{ p: 'M22 12h-4l-3 9L9 3l-3 9H2' }],
  target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1.5] }],
  search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.5-3.5' }],
  settings: [{ p: GEAR }, { c: [12, 12, 3] }],
  grid: [{ r: [3.5, 3.5, 7, 7, 1.5] }, { r: [13.5, 3.5, 7, 7, 1.5] }, { r: [3.5, 13.5, 7, 7, 1.5] }, { r: [13.5, 13.5, 7, 7, 1.5] }],
  'sidebar-close': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'M9 3v18' }, { p: 'm16 15-3-3 3-3' }],
  mic: [{ r: [9, 2.5, 6, 11.5, 3] }, { p: 'M19 10v1a7 7 0 0 1-14 0v-1M12 18v3.5' }],
  gauge: [{ p: 'm12 14 4-4' }, { p: 'M3.3 19a10 10 0 1 1 17.4 0' }],
  'git-branch': [{ p: 'M6 3v12' }, { c: [18, 6, 3] }, { c: [6, 18, 3] }, { p: 'M18 9a9 9 0 0 1-9 9' }],
  history: [{ p: 'M3 12a9 9 0 1 0 2.6-6.4L3 8' }, { p: 'M3 3v5h5' }, { p: 'M12 7.5V12l3 2' }],
  globe: [{ c: [12, 12, 9] }, { p: 'M3 12h18' }, { p: 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z' }],
  users: [{ c: [9, 8, 3.5] }, { p: 'M3 20a6 6 0 0 1 12 0' }, { c: [17, 9, 2.5] }, { p: 'M16 14.2a5 5 0 0 1 5 4.8' }],
  bot: [{ r: [4, 8, 16, 12, 3] }, { p: 'M12 8V4' }, { c: [9, 14, 1], f: 1 }, { c: [15, 14, 1], f: 1 }],
  monitor: [{ r: [2.5, 3.5, 19, 13, 2] }, { p: 'M8 21h8M12 16.5V21' }],
  sparkles: [{ p: 'M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z' }, { p: 'M20 3v4M22 5h-4' }]
};
function ic(name, role, k = 1, style = '') {
  const px = +(role * k).toFixed(2), fill = s => s.f ? ' fill="currentColor" stroke="none"' : '';
  const shapes = ICONS[name].map(s => s.p ? `<path d="${s.p}"${fill(s)}/>` : s.c ? `<circle cx="${s.c[0]}" cy="${s.c[1]}" r="${s.c[2]}"${fill(s)}/>`
    : `<rect x="${s.r[0]}" y="${s.r[1]}" width="${s.r[2]}" height="${s.r[3]}" rx="${s.r[4]}"${fill(s)}/>`).join('');
  return `<svg class="glyph" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${(38.4 / role).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${style ? ` style="${style}"` : ''}>${shapes}</svg>`;
}
const I = {
  cta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
  pointer: '<svg viewBox="0 0 22 30" width="44" height="60"><path d="M2.5 2.2v21.6l5.6-5.5 3.6 8.7 3.6-1.5-3.5-8.6h7.8z" fill="#111" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/></svg>'
};
function markSVG(size) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64"><path d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z" fill="#146a7c"/>` +
    `<circle class="mf" cx="25" cy="29" r="10.5" fill="#ffffff"/><circle class="mm" cx="39.5" cy="29" r="10.5" fill="#f0ab3d" stroke="#146a7c" stroke-width="3"/></svg>`;
}
function ringSVG(size, pct, stroke = 3, color = '#146a7c') {
  const r = 10, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(-90deg)"><circle cx="12" cy="12" r="${r}" fill="none" stroke="#e0e6e8" stroke-width="${stroke}"/>` +
    `<circle cx="12" cy="12" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>`;
}
const agentTile = (cls, letter, sm = false) => `<span class="atile${sm ? ' sm' : ''} ${cls}">${letter}</span>`;
const setHTML = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ---- folk avatars (identical to 0.6.0)
const CHARACTERS = ['pudding', 'taro', 'sakura', 'matcha', 'caramel', 'sesame', 'blueberry'];
function hashCode(name) { let h = 0; for (let i = 0; i < name.length; i++) { h = ((h << 5) - h) + name.charCodeAt(i); h &= h; } return Math.abs(h); }
function mixHash(hash) { let h = hash >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
function folkLook(name) {
  const hash = hashCode(name);
  let h = mixHash(hash);
  const pick = list => { const v = list[h % list.length]; h = Math.floor(h / list.length); return v; };
  pick([0, 1, 2, 3, 4, 5, 6]);
  const eyes = pick(['dot', 'happy', 'wink']), mouth = pick(['smile', 'open', 'cat']);
  pick([null, 'sprout', 'antenna', 'bow', 'headphones']);
  const mirror = pick([false, true]), raised = pick([true, false, false]), character = pick(CHARACTERS);
  return { hash, eyes, mouth, mirror, character, wave: raised && character !== 'taro' };
}
let layerURL = null;
function folk(name, edgePx) {
  const look = folkLook(name), urls = layerURL, G = FOLK.now.geometry;
  const el = h('div', 'folk');
  h('div', 'fsh', null, el);
  const mir = h('div', 'fl', null, el);
  if (look.mirror) mir.style.transform = 'scaleX(-1)';
  const fig = h('div', 'fl', null, mir);
  const img = (parent, layer) => {
    if (!urls[layer]) return null;
    const im = h('img', null, null, parent);
    im.src = urls[layer]; im.decoding = 'sync'; return im;
  };
  const part = p => `${look.character}-${p}`;
  img(fig, part('body')); img(fig, part('antenna'));
  const armL = h('div', 'fl', null, fig), armR = h('div', 'fl', null, fig);
  img(armL, part('arm-l')); img(armL, part('held-l')); img(armR, part('arm-r')); img(armR, part('held-r'));
  const eyes = img(fig, `eyes-${look.eyes}`), closed = img(fig, 'eyes-closed');
  img(fig, `mouth-${look.mouth}`); img(fig, part('front'));
  const blinkDelay = (look.hash % 52) * 100;
  return {
    el,
    set(t) {
      const ms = t * 1000, b = (((ms - blinkDelay) % 5200) + 5200) % 5200 / 5200, shut = b > 0.935 && b < 0.965;
      eyes.style.opacity = shut ? 0 : 1; closed.style.opacity = shut ? 1 : 0;
    }
  };
}
function folkBox(name, edge, k) {
  const box = h('span', null, null);
  Object.assign(box.style, { display: 'inline-block', position: 'relative', width: `${edge * k}px`, height: `${edge * k}px`, flex: 'none' });
  const f = folk(name, edge * k); box.appendChild(f.el);
  return { box, f };
}

// ---- cast & timeline helpers
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
    if (this.img.getAttribute('src') !== src) { this.img.setAttribute('src', src); pending.push(this.img.decode().catch(() => {})); }
    css(this.el, { x: x - s / 2, y: y - air - SP.feetY * s, width: s, height: s, opacity: o });
    this.img.style.transform = flip ? 'scaleX(-1)' : 'none';
    const k = clamp(1 - air / 700, 0.2, 1), sw = s * 0.4 * k;
    css(this.shadow, { left: (s - sw) / 2, top: SP.feetY * s - s * 0.035 * k + air, width: sw, height: s * 0.07 * k, opacity: 0.9 * k });
  }
}
function seq(t, list) { let cur = list[0]; for (const it of list) if (t >= it[0]) cur = it; return { clip: cur[1], at: t - cur[0], loop: !!cur[2] }; }
const hopX = (t, t0, a, b) => lerp(a, b, E.inOut(inv(t0 + 0.08, t0 + 0.44, t)));
const show = (el, on) => { el.style.visibility = on ? 'visible' : 'hidden'; return on; };
const shown = (el, on) => { el.style.display = on ? '' : 'none'; show(el, on); return on; };
function panel(el, t, a, b, x, y) {
  el.style.display = t >= a && t < b ? '' : 'none';
  if (!show(el, t >= a && t < b)) return false;
  const u = E.out4(inv(a, a + 0.4, t)), o = E.in(inv(b - 0.3, b, t));
  el.style.transformOrigin = '50% 50%';
  css(el, { x, y: y + lerp(40, 0, u) - 24 * o, s: lerp(0.97, 1, u), opacity: Math.min(u, 1 - o) });
  return true;
}
const typed = (text, t, a, b) => [...text].slice(0, Math.round([...text].length * clamp(inv(a, b, t)))).join('');
const keysOf = (text, a, b) => [...text].map((_, i) => a + (b - a) * (i + 1) / [...text].length);

const R = {};
function deskWindow(k) {
  const desk = h('div', 'abs desk', null, stage);
  css(desk, { width: DESK.w, height: DESK.h });
  const wallHTML = `<div class="wall" style="width:${DESK.w}px;height:${DESK.h}px"></div>`;
  desk.insertAdjacentHTML('beforeend', wallHTML);
  const w = h('div', 'abs win', null, desk);
  css(w, { x: WIN.x, y: WIN.y, width: WIN.w, height: WIN.h });
  w.style.setProperty('--k', k);
  const blur = h('div', 'blur', wallHTML, w);
  css(blur, { left: -WIN.x, top: -WIN.y, width: DESK.w, height: DESK.h });
  h('div', 'wash', null, w); h('div', 'shellg', null, w);
  const frame = h('div', 'sframe', null, w); frame.style.width = `${SIDE * k}px`;
  const main = h('div', 'main', null, w); main.style.left = `${(SIDE * k).toFixed(2)}px`;
  h('div', 'lights', '<i></i><i></i><i></i>', w);
  return { desk, win: w, k, frame, main };
}

function sidebar(W, { activeProject = null, liveStrip = false, agyTitle = null } = {}) {
  const k = W.k, sb = h('div', 'sb', null, W.frame);
  sb.style.width = `${SIDE * k}px`;
  h('div', 'brand', `${markSVG(20 * k)}<span class="sp"></span><span class="tg">${ic('activity', 18, k)}</span><span class="tg">${ic('target', 18, k)}</span><span class="tg">${ic('sidebar-close', 18, k)}</span>`, sb);
  const srch = h('div', 'srch', `<span class="si">${ic('search', 14, k)}</span><span>${S.search}</span><kbd>⌘K</kbd>`, sb);
  const folks = [];
  if (liveStrip) {
    const ls = h('div', 'live-strip', `<div class="lh"><i></i><span>${S.liveSection}</span><span>2</span></div>`, sb);
    const fb0 = folkBox(S.bots[0].name, 18, k); folks.push(fb0.f);
    const r0 = h('div', 'lrow', null, ls); r0.appendChild(fb0.box);
    r0.insertAdjacentHTML('beforeend', `<span class="lt">${S.bots[0].name}</span><span class="ls">${S.stThinking}</span>`);
    const r1 = h('div', 'lrow on', `${agentTile('a-agy', 'A', true)}<span class="lt">${agyTitle}</span><span class="ls">${S.consult.live}</span>`, ls);
    ls.append(r0, r1);
  }
  const list = h('div', 'list', null, sb);
  h('div', 'ghead first', `${ic('chevron-down', 12, k)}<span>${S.botsTab}</span><span class="gadd">+</span>`, list);
  S.bots.slice(0, liveStrip ? 2 : 3).forEach((b, i) => {
    const row = h('div', `row${liveStrip && i === 0 ? ' busy' : ''}`, null, list);
    const av = h('span', 'av', null, row);
    const fb = folkBox(b.name, 32, k); folks.push(fb.f); av.appendChild(fb.box);
    h('div', 'tx', `<div class="l1"><span class="t">${b.name}</span><span class="rt">${b.time}</span></div>` +
      `<div class="l2"><span class="rs"><i></i><span class="rst">${S.stThinking}</span></span><span class="s">${b.prev}</span></div>`, row);
  });
  h('div', 'ghead', `${ic('chevron-down', 12, k)}<span>${S.section}</span><span class="gadd">+</span>`, list);
  h('div', 'dirrow', `${ic('chevron-down', 12, k)}${ic('folder', 14, k)}<span>deskfolk</span>`, list);
  const ps = h('div', 'psess', null, list);
  if (activeProject) {
    const prow = h('div', 'row on', `<span class="av">${agentTile(activeProject.cls, activeProject.letter)}</span>` +
      `<div class="tx"><div class="l1"><span class="t">${activeProject.title}</span><span class="rt">${activeProject.time}</span></div>` +
      `<div class="l2"><span class="s">${activeProject.sub}</span></div></div>`, ps);
    ps.appendChild(prow);
  }
  const foot = h('div', 'foot', `<span class="fa">${ic('folder', 14, k)}<span>${S.workspace}</span></span><span class="fa">${ic('grid', 14, k)}<span>${S.tools}</span></span><span class="fa end">${ic('settings', 14, k)}</span>`, sb);
  return { sb, folks };
}

function build() {
  R.dim = document.getElementById('dusk');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };

  // ---- 0–4: 0.6.0 -> 0.7.0
  R.badge = h('div', 'abs', null, stage);
  R.bMark = h('div', 'abs', markSVG(200), R.badge);
  R.bWord = h('div', 'abs word', S.word, R.badge);
  const [major, minor, patch] = S.version.split('.'), [, fromMinor] = S.from.split('.');
  R.ver = h('div', 'abs ver', `<span>${major}.</span><span class="roll"><span class="col"><span>${fromMinor}</span><span>${minor}</span></span></span><span>.${patch}</span>`, R.badge);
  R.roll = R.ver.querySelector('.roll'); R.rollCol = R.ver.querySelector('.col');
  R.count = h('div', 'abs pill count', `${ic('check', 12, 1.5)}${S.count}`, R.badge);
  R.plat = P.chips.map(c => h('div', 'abs platform', `${ic(c.icon || 'check', 16, 1.5)}<span>${c.text}</span>${c.tail ? `<span class="tail">· ${c.tail}</span>` : ''}`, stage));

  // ---- 4–10: Git & GitHub pane
  const G = S.git, Gw = R.Gw = deskWindow(KD);
  Gw.side = sidebar(Gw, { activeProject: { cls: 'a-claude', letter: 'C', title: G.chatTitle, time: '14:02', sub: 'feat/git-pane · 4' } });
  const gleaf = h('div', 'leaf', null, Gw.main);
  h('div', 'tabs', `<span class="tab"><span class="tav">${agentTile('a-claude', 'C', true)}</span><span>${G.chatTitle}</span></span>` +
    `<span class="tab on"><span class="tav">${ic('git-branch', 14, KD)}</span><span>${G.tabTitle}</span></span>`, gleaf);
  const gcard = h('div', 'card', null, gleaf);
  const gbar = h('div', 'git-bar', null, gcard);
  Gw.bc = h('span', 'git-bc', `${ic('folder', 12, KD)}<span class="repo">${G.repo}</span>${ic('chevron-right', 12, KD)}${ic('git-branch', 12, KD)}<span class="br">${G.branch}</span><span class="dty">· ${G.dirty}</span><span class="ahd">↑${G.ahead}</span>${ic('chevron-down', 12, KD)}`, gbar);
  const gseg = h('div', 'git-seg', null, gbar);
  Gw.tabChanges = h('span', 'on', `${ic('git-branch', 14, KD)}<span>${G.tabs[0]}</span>`, gseg);
  Gw.tabGraph = h('span', '', `${ic('history', 14, KD)}<span>${G.tabs[1]}</span>`, gseg);
  Gw.tabGh = h('span', '', `${ic('globe', 14, KD)}<span>${G.tabs[2]}</span>`, gseg);

  const gbody = h('div', 'git-body', null, gcard);
  // Repo -> Worktree popover
  Gw.pop = h('div', 'git-pop', `<div class="ph"><span>${G.pickerTitle}</span><small>${G.reposCount}</small></div>` +
    `<div class="grp">${ic('folder', 12, KD)}<span>${G.repo}</span></div>` +
    G.wts.map(w => `<div class="wt${w.cur ? ' on' : ''}"><div class="wl1">${ic('git-branch', 12, KD)}<span>${w.branch}</span><span class="tag">${w.badge}</span></div>` +
      `<div class="wl2"><span class="mono">${w.path}</span><span>${w.meta}</span></div>` +
      `${w.session ? `<div class="sess">${agentTile('a-claude', 'C', true)}<span>${w.session}</span></div>` : ''}</div>`).join(''), gcard);

  // View 1: Changes (Diff)
  Gw.vChanges = h('div', 'git-view', null, gbody);
  h('div', 'gfiles', `<div class="gf-top"><span class="gf-pill">${G.base}</span><span>${G.files.length}</span></div>` +
    G.files.map(f => `<div class="gfile${f.on ? ' on' : ''}"><div><b>${f.name}</b><small>${f.dir}</small></div><span class="st"><span class="a">${f.add}</span><span class="d">${f.del}</span></span></div>`).join(''), Gw.vChanges);
  const diffLines = [
    ['hunk', '', '@@ -369,8 +369,14 @@ export function GitPane(props) {'],
    ['', '370', '  <View class="flex-row items-center gap-[6px] px-[10px]">'],
    ['del', '371', '-   <Text>{summary()?.branch}</Text>'],
    ['add', '371', '+   <GitBreadcrumb repo={currentRepoName()}'],
    ['add', '372', '+     branch={branchText()} dirty={s().dirty_count}'],
    ['add', '373', '+     ahead={s().ahead} onPress={togglePicker} />'],
    ['', '374', '    <SegmentedControl views={GIT_PANE_VIEWS}'],
    ['add', '375', '+     active={activeView()} onSelect={switchView} />'],
    ['', '376', '  </View>'],
    ['hunk', '', '@@ -402,5 +408,9 @@'],
    ['add', '409', '+ <GitContextPopover open={pickerOpen()} tree={tree()}'],
    ['add', '410', '+   onSelect={selectContext} />']
  ];
  h('div', 'gdiff', `<div class="gd-hd"><span>apps/desktop-nsh/app/src/ui/git/GitPane.tsx</span><span class="badge">${G.split} · ${G.readOnly}</span></div>` +
    `<div class="gd-code">${diffLines.map(([cls, ln, txt]) => `<div class="dl ${cls}"><span class="ln">${ln}</span><span>${esc(txt)}</span></div>`).join('')}</div>`, Gw.vChanges);

  // View 2: History (Git Graph)
  Gw.vGraph = h('div', 'git-view', null, gbody);
  const graphL = h('div', 'ggraph-l', null, Gw.vGraph);
  G.commits.forEach((c, idx) => {
    const x = c.lane ? 34 : 14, col = c.lane ? '#d97706' : '#146a7c';
    const topLine = idx > 0 ? `<line x1="14" y1="0" x2="14" y2="52" stroke="#146a7c" stroke-width="2.4"/>` : '';
    const branchPath = idx === 0 ? `<line x1="34" y1="26" x2="34" y2="52" stroke="#d97706" stroke-width="2.4"/>` :
      idx === 1 ? `<path d="M34 0 L34 26 C34 40 14 38 14 52" fill="none" stroke="#d97706" stroke-width="2.4"/>` : '';
    const baseLine = idx >= 2 ? `<line x1="14" y1="0" x2="14" y2="${idx === G.commits.length - 1 ? 26 : 52}" stroke="#146a7c" stroke-width="2.4"/>` : '';
    const svg = `<svg class="lane" viewBox="0 0 48 52">${topLine}${baseLine}${branchPath}<circle cx="${x}" cy="26" r="5.5" fill="${col}" stroke="#fff" stroke-width="2"/></svg>`;
    const refs = c.refs.map(r => `<span class="ref ${r === 'HEAD' ? 'head' : r === 'feat/git-pane' ? 'br' : ''}">${r}</span>`).join('');
    h('div', `crow${idx === 0 ? ' on' : ''}`, `${svg}<div class="ci"><div class="ct">${refs}<b>${c.msg}</b></div><div class="cm">${c.sha} · ${c.who} · ${c.when}</div></div>`, graphL);
  });
  h('div', 'ggraph-r', `<h4>${G.graphDetail.title}</h4><div class="meta"><span>59356b3</span><span>·</span><span>${G.graphDetail.files}</span><span class="btn secondary" style="margin-left:auto">${G.graphDetail.copySha}</span></div>` +
    `<div class="flist">${G.files.map(f => `<div><span>${f.dir}/${f.name}</span><span><b style="color:var(--ok-text)">${f.add}</b> <b style="color:var(--danger)">${f.del}</b></span></div>`).join('')}</div>`, Gw.vGraph);

  // View 3: GitHub
  Gw.vGh = h('div', 'git-view', null, gbody);
  h('div', 'gh-l', `<div class="gh-sec">${G.gh.relatedHead}</div>` +
    `<div class="gh-card"><div class="top"><span class="gbadge brand">${G.gh.branchPrTag}</span><span class="gbadge ok">${G.gh.stateOpen}</span></div>` +
    `<div class="title">${G.gh.prTitle}</div>` +
    `<div class="badges"><span class="gbadge ok">${ic('check-circle', 12, KD)}${G.gh.reviewApproved}</span><span class="gbadge ok">${G.gh.checks}</span><span class="gbadge muted">${G.gh.closing}</span></div></div>`, Gw.vGh);
  h('div', 'gh-r', `<div style="display:flex;gap:${6 * KD}px"><span class="gbadge ok">${G.gh.stateOpen}</span><span class="gbadge ok">${G.gh.reviewApproved}</span><span class="gbadge ok">${G.gh.checks}</span></div>` +
    `<h4>${G.gh.prTitle}</h4><p>${G.gh.body}</p><div class="acts"><span class="btn primary">${G.gh.quote}</span><span class="btn secondary">${G.gh.openGh}</span></div>`, Gw.vGh);

  // ---- 10–14: Consultants in project sessions
  const C = S.consult, Cw = R.Cw = deskWindow(KD);
  Cw.side = sidebar(Cw, { activeProject: { cls: 'a-claude', letter: 'C', title: C.title, time: C.youT, sub: C.live } });
  const cleaf = h('div', 'leaf', null, Cw.main);
  h('div', 'tabs', `<span class="tab on"><span class="tav">${agentTile('a-claude', 'C', true)}</span><span>${C.title}</span></span>`, cleaf);
  const ccard = h('div', 'card', null, cleaf);
  h('div', 'chd', `${agentTile('a-claude', 'C')}<div class="who"><span class="nm">${C.title}</span><span class="st2"><span class="pd"></span><span>${C.live}</span><span class="q">Claude Code · ~/${C.dir}</span></span></div>`, ccard);
  const ctr = h('div', 'tr', null, ccard), ctri = h('div', 'tri', null, ctr), ccol = h('div', 'colw', null, ctri);
  Cw.you = h('div', 'you', C.you, ccol);
  Cw.subcard = h('div', 'subcard', null, ccol);
  Cw.reply = h('div', 'reply', '<p></p>', ccol);
  Cw.replyP = Cw.reply.querySelector('p');
  const ccwrap = h('div', 'cwrap', null, ccard);
  Cw.pop = h('div', 'cpop', `<div class="crow2"><b>${C.switchLabel}</b><span class="sw"><i></i></span></div>` +
    C.members.map(m => `<div class="crow2">${agentTile(m.agent === 'Codex' ? 'a-codex' : 'a-grok', m.agent === 'Codex' ? 'O' : 'G', true)}<div><b>${m.model} <span class="lv">· ${m.level}</span></b><span class="sub">${m.agent} · ${m.account}</span></div><span class="rm">${ic('x', 12, KD)}</span></div>`).join('') +
    `<div class="add"><span>${C.addLabel}</span>${ic('chevron-right', 14, KD)}</div>`, ccwrap);
  Cw.sw = Cw.pop.querySelector('.sw');
  const ccomp = h('div', 'composer', `<div class="txt"><span class="ph">${C.placeholder}</span></div><span class="cb">${ic('paperclip', 18, KD)}</span>` +
    `<span class="cpill bordered">${C.plan}</span>`, ccwrap);
  Cw.pill = h('span', 'cpill', `${ic('users', 15, KD)}<span>${C.pill}</span><span class="logos" style="display:inline-flex;gap:3px"></span>`, ccomp);
  Cw.pillLogos = Cw.pill.querySelector('.logos');
  ccomp.insertAdjacentHTML('beforeend', `<span class="gap"></span><span class="cb">${ic('mic', 18, KD)}</span><span class="cb send off">${ic('arrow-up', 18, KD)}</span>`);

  // ---- 14–19: Phone upgrades
  buildPhone();

  // ---- 19–24: Sidebar Active strip, Desktop Context Ring, Draft & Antigravity Usage
  const D = S.desk, Dw = R.Dw = deskWindow(KD);
  Dw.side = sidebar(Dw, { liveStrip: true, agyTitle: D.projTitle, activeProject: { cls: 'a-agy', letter: 'A', title: D.projTitle, time: '14:25', sub: 'Google AI Ultra' } });
  const dleaf = h('div', 'leaf', null, Dw.main);
  const dtabs = h('div', 'tabs', null, dleaf);
  Dw.tabChat = h('span', 'tab on', `<span class="tav">${agentTile('a-agy', 'A', true)}</span><span>${D.projTitle}</span>`, dtabs);
  Dw.tabUsage = h('span', 'tab', `<span class="tav">${ic('gauge', 14, KD)}</span><span>${D.usageTab}</span>`, dtabs);
  const dcard = h('div', 'card', null, dleaf);
  Dw.chatWrap = h('div', 'chat-wrap', null, dcard);
  h('div', 'chd', `${agentTile('a-agy', 'A')}<div class="who"><span class="nm">${D.projTitle}</span><span class="st2"><span class="q">${D.projSub}</span></span></div>`, Dw.chatWrap);
  const dtr = h('div', 'tr', null, Dw.chatWrap), dtri = h('div', 'tri', null, dtr), dcol = h('div', 'colw', null, dtri);
  h('div', 'you', D.you, dcol);
  h('div', 'reply', `<p>${D.reply}</p>`, dcol);
  const dcwrap = h('div', 'cwrap', null, Dw.chatWrap);
  Dw.ctxTip = h('div', 'ctx-tip', D.ctxTip, dcwrap);
  const dcomp = h('div', 'composer', `<div class="txt">${D.draftText}</div><span class="cb">${ic('paperclip', 18, KD)}</span><span class="cpill bordered">${S.consult.plan}</span><span class="gap"></span>`, dcwrap);
  Dw.ctxPill = h('span', 'ctx-pill', `${ringSVG(16 * KD, 68, 3, '#146a7c')}<span>${D.ctxPct}</span>`, dcomp);
  dcomp.insertAdjacentHTML('beforeend', `<span class="cb">${ic('mic', 18, KD)}</span><span class="cb send">${ic('arrow-up', 18, KD)}</span>`);

  Dw.usagePane = h('div', 'usage-pane', `<div class="ucard"><div class="uhd">${agentTile('a-agy', 'A')}<b>${D.agyTitle}</b><span class="tier">${D.agyTier}</span><span class="auto">${ic('check-circle', 12, KD)}${D.agyAuto}</span></div>` +
    `<div class="ugrid">${D.windows.map(w => `<div class="uwin">${ringSVG(46 * KD, w.pct, 3.2, '#146a7c')}<div><b>${w.name}</b><small>${w.pct}% · ${w.reset}</small></div></div>`).join('')}</div>` +
    `<div class="ufoot">${ic('sparkles', 14, KD)}<span>${D.spendNote}</span></div></div>`, dcard);

  // ---- 24–26.5: And more
  R.more = S.more.map(m => h('div', 'abs morechip', `<span class="dot" style="width:40px;height:40px;background:var(--accent)">${ic('check', 12, 1.5)}</span><span>${m}</span>`, stage));

  // headlines & sublines
  R.heads = {}; R.subs = {};
  for (const k in S.h) R.heads[k] = h('div', `headline ${LANG}`, S.h[k], stage);
  for (const k in S.sub) R.subs[k] = h('div', 'subline', S.sub[k], stage);

  // end card
  R.markG = h('div', 'abs', markSVG(360), stage);
  css(R.markG, { width: 360, height: 360 }); R.markG.style.transformOrigin = '180px 180px';
  R.mf = R.markG.querySelector('.mf'); R.mm = R.markG.querySelector('.mm');
  R.end = h('div', 'abs', null, stage); css(R.end, { width: 1920, height: 1080 }); R.end.style.transformOrigin = '960px 540px';
  R.word = h('div', 'abs word', [...S.word].map(c => `<span class="ch" style="display:inline-block">${c}</span>`).join(''), R.end);
  R.endVer = h('div', 'abs ver small', S.version, R.end);
  R.tag = h('div', 'abs tagline', S.tagline, R.end);
  R.ctaRow = h('div', 'abs', `<span class="cta"><span style="width:38px;height:38px;transform:rotate(180deg);display:inline-block">${I.cta}</span>${S.cta}</span><span class="url">${S.url}</span>`, R.end);
  css(R.ctaRow, { display: 'flex', alignItems: 'center', gap: '36px' });
  R.fine = h('div', 'abs fine', `${P.fine} · ${S.fineRest}`, R.end);
  R.finer = h('div', 'abs finer', S.finer, R.end);

  R.pointer = h('div', null, I.pointer, stage); R.pointer.id = 'pointer';
  R.ripple = h('div', null, null, stage); R.ripple.id = 'ripple';
  R.touch = h('div', null, null, stage); R.touch.id = 'touch';
}

const PH = { w: 412, h: 892 }, BEZ = 12, PHONE = { x: 640, y: 248 };
function buildPhone() {
  const k = KPH, X = S.phone;
  const sw = PH.w * k, sh = PH.h * k;
  const el = R.ph = h('div', 'abs phone', null, stage);
  css(el, { width: sw + 2 * BEZ, height: sh + 2 * BEZ });
  el.style.setProperty('--k', k);
  h('div', 'body', null, el);
  const scr = R.phScr = h('div', 'scr', null, el);
  css(scr, { left: BEZ, top: BEZ, width: sw, height: sh });
  const wifi = `<svg width="${16 * k}" height="${16 * k}" viewBox="0 0 24 24"><path d="M12 20.5 1.5 8.8a15 15 0 0 1 21 0z" fill="currentColor"/></svg>`;
  h('div', 'sbar', `<span>${X.clock}</span><span class="cam"></span><span class="ic">${wifi}<span class="bat"></span></span>`, scr);
  h('div', 'hdl', null, scr);

  // Page 1: Project chat on phone with top-right context ring & + composer
  const C = R.phChat = h('div', 'pg', null, scr);
  const hd = h('div', 'ph-hd', `<span class="bk">${ic('chevron-left', 20, k)}</span><div class="id">${agentTile('a-claude', 'C')}<div><b>${X.title}</b><small>${X.sub}</small></div></div>`, C);
  R.phCtxBtn = h('span', 'ph-ctx', `${ringSVG(20 * k, 62, 3, '#146a7c')}<span>${X.pct}</span>`, hd);
  const tr = h('div', 'ph-tr', null, C), inn = h('div', 'in', null, tr);
  h('div', 'you', X.you, inn);
  h('div', 'reply', `<p>${X.reply}</p>`, inn);
  const cmp = h('div', 'ph-cmp', `<div class="txt">${X.placeholder}</div>`, C);
  R.phPlusBtn = h('span', 'cb', ic('plus', 22, k), cmp);
  cmp.insertAdjacentHTML('beforeend', `<span class="pchip">${X.planChip}</span><span class="pchip">${ic('users', 14, k)}<span>2</span></span><span class="gap"></span><span class="cb">${ic('mic', 20, k)}</span><span class="cb send">${ic('arrow-up', 20, k)}</span>`);

  // Sheet 1: Context usage bottom sheet
  R.phSheetBg = h('div', 'sheetbg', null, scr);
  R.phCtxSheet = h('div', 'sheet', `<div class="grip"></div><div class="sh"><span>${X.ctxTitle}</span><i>${ic('x', 18, k)}</i></div>` +
    `<div class="ctx-ring-box">${ringSVG(88 * k, 62, 2.2, '#146a7c')}<span>${X.pct}</span></div>` +
    X.ctxRows.map(([a, b]) => `<div class="kv"><span>${a}</span><b>${b}</b></div>`).join(''), scr);

  // Sheet 2: Composer + bottom sheet
  R.phPlusSheet = h('div', 'sheet', `<div class="grip"></div><div class="sh"><span>${X.moreTitle}</span><i>${ic('x', 18, k)}</i></div>` +
    `<div class="srow">${ic('paperclip', 20, k)}<div class="stx"><b>${X.attach}</b></div></div>` +
    `<div class="srow">${ic('sparkles', 20, k)}<div class="stx"><b>${X.planMode}</b><small>${X.planDetail}</small></div><span class="sw on"><i></i></span></div>` +
    `<div class="srow">${ic('users', 20, k)}<div class="stx"><b>${X.consultLabel}</b><small>${X.consultDetail}</small></div>${ic('chevron-right', 16, k)}</div>` +
    `<div class="srow">${ic('terminal', 20, k)}<div class="stx"><b>${X.modelLabel}</b><small>${X.modelDetail}</small></div>${ic('chevron-right', 16, k)}</div>`, scr);

  // Page 2: Multi-display Mac remote screen
  const SC = R.phScreen = h('div', 'pg ph-scr-pg', null, scr);
  const shd = h('div', 'ph-scr-hd', `${ic('chevron-left', 18, k)}<span style="font-size:${14 * k}px;font-weight:600">${X.screenTitle}</span>`, SC);
  R.phDispBtn = h('span', 'disp', null, shd);
  shd.insertAdjacentHTML('beforeend', `<span class="sp"></span><span class="pill2">${X.direct}</span>`);
  const sbody = h('div', 'ph-scr-body', null, SC);
  R.phMacFrame = h('div', 'mac-frame', null, sbody);
  R.phMacCap = h('div', 'mac-cap', null, sbody);

  // Sheet 3: Display picker bottom sheet
  R.phDispSheet = h('div', 'sheet', `<div class="grip"></div><div class="sh"><span>${X.displayTitle}</span><i>${ic('x', 18, k)}</i></div>` +
    X.displays.map((d, idx) => `<div class="srow${idx === 1 ? ' d2row' : ''}">${ic('monitor', 20, k)}<div class="stx"><b>${d.name}</b><small>${d.sub}</small></div>${d.cur ? ic('check', 18, k) : ''}</div>`).join(''), scr);
  R.phDisp2 = R.phDispSheet.querySelector('.d2row');
}

const M = {};
function measure() {
  const w = el => el.getBoundingClientRect().width, hh = el => el.getBoundingClientRect().height;
  M.bWordW = w(R.bWord); M.bWordH = hh(R.bWord); M.verW = w(R.ver); M.countW = w(R.count);
  M.platW = R.plat.map(w); M.moreW = R.more.map(w);
  M.wordW = w(R.word); M.wordH = hh(R.word); M.endVerW = w(R.endVer); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
  const room = (what, width, most) => { if (width > most) console.error(`overflow: ${what} is ${Math.round(width)} px, room ${most}`); };
  for (const k in R.heads) room(`headline ${k}`, w(R.heads[k]), 1920 - 120 - 40);
  for (const k in R.subs) room(`subline ${k}`, w(R.subs[k]), 1920 - 124 - 40);
  M.moreW.forEach((x, i) => room(`chip ${i}`, x, 900));
  room('platforms', M.platW.reduce((a, b) => a + b, 0) + 24 * (M.platW.length - 1), 1760);
  room('fine print', M.fineW, 1800); room('tagline', M.tagW, 1800);
}

const HEADS = { git: [4.05, 9.85], consult: [10.05, 13.85], phone: [14.05, 18.85], desk: [19.05, 23.85], more: [24.05, 26.25] };
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

function poseRoom(t) {
  css(document.getElementById('dots'), { x: -((t * 14) % 36), y: -((t * 9) % 36), opacity: 0.5 });
  R.dim.style.opacity = (0.22 * E.smooth(inv(10.5, 11.2, t)) * (1 - E.smooth(inv(13.4, 13.9, t)))).toFixed(3);
}

const POINTS = [
  // 4–10: Git pane breadcrumb -> History tab -> GitHub tab
  { a: 5.05, at: 5.45, b: 5.65, from: [1520, 960], el: () => R.Gw.bc, click: 5.5, center: true },
  { a: 6.45, at: 6.8, b: 7.05, from: [1100, 500], el: () => R.Gw.tabGraph, click: 6.85, center: true },
  { a: 8.05, at: 8.35, b: 8.65, from: [1200, 420], el: () => R.Gw.tabGh, click: 8.4, center: true },
  // 10–14: Consult pill -> switch toggle
  { a: 10.25, at: 10.52, b: 10.65, from: [1480, 960], el: () => R.Cw.pill, click: 10.55, center: true },
  { a: 10.65, at: 10.9, b: 11.15, from: 'prev', el: () => R.Cw.sw, click: 10.95, center: true },
  // 19–24: Hover context ring -> click Usage tab
  { a: 19.65, at: 20.1, b: 20.95, from: [1500, 980], el: () => R.Dw.ctxPill, click: null, dx: 0.78, dy: 0.85 },
  { a: 20.95, at: 21.3, b: 21.65, from: 'prev', el: () => R.Dw.tabUsage, click: 21.35, center: true }
];
function target(p) {
  const r = p.el().getBoundingClientRect();
  return p.center ? [r.left + r.width / 2, r.top + r.height / 2] : [r.left + r.width * (p.dx ?? 0.5), r.top + r.height * (p.dy ?? 0.5)];
}
function posePointer(t) {
  let pos = null, click = null;
  POINTS.forEach((p, i) => {
    if (t < p.a || t >= p.b) return;
    const [tx, ty] = target(p);
    const prev = POINTS[i - 1], next = POINTS[i + 1];
    const chained = p.from === 'prev' && prev && Math.abs(prev.b - p.a) < 1e-6;
    const [fx, fy] = chained ? target(prev).map((v, j) => v - (j ? 4 : 6)) : p.from;
    const u = E.inOut(inv(p.a + 0.05, p.at - 0.04, t));
    const ca = typeof p.click === 'number' ? p.click : p.at;
    const press = p.click && t > ca - 0.02 && t < ca + 0.07 ? 3 : 0;
    const fin = chained ? 1 : E.out(inv(p.a, p.a + 0.14, t));
    const fout = next && next.from === 'prev' && Math.abs(next.a - p.b) < 1e-6 ? 0 : E.in(inv(p.b - 0.18, p.b, t));
    pos = { x: lerp(fx, tx - 6, u), y: lerp(fy, ty - 4, u) + press, o: Math.min(fin, 1 - fout) };
    if (p.click && t >= ca && t < ca + 0.42) click = { at: ca, x: tx, y: ty };
  });
  if (pos) css(R.pointer, { x: pos.x, y: pos.y, opacity: pos.o }); else R.pointer.style.opacity = 0;
  if (click) {
    const u = inv(click.at, click.at + 0.42, t);
    css(R.ripple, { x: click.x, y: click.y, s: lerp(0.25, 1.25, E.out(u)), opacity: 0.7 * (1 - u) });
  } else R.ripple.style.opacity = 0;
}

const TAPS = [[14.45, () => R.phCtxBtn], [15.85, () => R.phPlusBtn], [17.55, () => R.phDispBtn], [18.05, () => R.phDisp2]];
function poseTouch(t) {
  let at = null;
  for (const [ta, el] of TAPS) if (t >= ta - 0.14 && t < ta + 0.2) {
    const r = el().getBoundingClientRect();
    const u = inv(ta - 0.14, ta, t), o = Math.min(E.out(u), 1 - inv(ta + 0.06, ta + 0.2, t));
    at = { x: r.left + r.width / 2, y: r.top + r.height / 2, s: lerp(1.3, t >= ta ? 0.8 : 1, E.out(u)), o };
  }
  if (at) css(R.touch, { x: at.x, y: at.y, s: at.s, opacity: at.o }); else R.touch.style.opacity = 0;
}

function poseRelease(t) {
  const { mochi, pudding } = R.cast;
  const on = t < 4.1;
  show(R.badge, on);
  R.plat.forEach((el, i) => show(el, on && t >= 2.45 + i * 0.15));
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
  R.ver.style.transformOrigin = '0 50%';
  css(R.ver, { x: tx, y: cy - 62, s: lerp(1, 1.12, Math.sin(Math.PI * clamp(inv(2.0, 2.3, t)))), opacity: clamp(inv(0.6, 0.8, t)) });
  const shake = t > 1.5 && t < 1.98 ? Math.sin((t - 1.5) * 60) * 5 * inv(1.5, 1.95, t) : 0;
  const beat = E.pop(inv(2.0, 2.3, t));
  R.roll.style.translate = `${shake.toFixed(1)}px 0`;
  R.rollCol.style.translate = `0 ${(-50 * clamp(E.out4(inv(1.98, 2.24, t)) + 0.04 * Math.sin(Math.PI * beat))).toFixed(2)}%`;
  if (show(R.count, t >= 2.15)) {
    const u = E.pop(inv(2.15, 2.45, t));
    R.count.style.transformOrigin = '0 50%';
    css(R.count, { x: tx + M.verW + 24, y: cy - 30, s: lerp(0.6, 1, u), opacity: clamp(inv(2.15, 2.25, t)) });
  }
  const gap = 24, rowW = M.platW.reduce((a, b) => a + b, 0) + gap * (M.platW.length - 1);
  let x = (1920 - rowW) / 2;
  R.plat.forEach((el, i) => {
    const a = 2.45 + i * 0.15, u = E.pop(inv(a, a + 0.32, t));
    el.style.transformOrigin = '50% 50%';
    css(el, { x, y: 590 + lerp(24, 0, E.out(inv(a, a + 0.3, t))) - 40 * ex, s: lerp(0.85, 1, u), opacity: clamp(inv(a, a + 0.15, t)) * (1 - ex) });
    x += M.platW[i] + gap;
  });
  if (t < 4.2) {
    const s = seq(t, [[0, 'hop'], [0.72, 'idle', true], [2.0, 'cheer'], [3.43, 'hop']]);
    mochi.pose({ ...s, x: t < 3.43 ? hopX(t, 0, -180, 300) : hopX(t, 3.43, 300, -260), s: 420, flip: t >= 3.43 });
  }
  const sp = seq(t, [[0.3, 'hop'], [1.02, 'idle', true], [2.05, 'cheer'], [3.48, 'hop']]);
  if (t >= 0.3 && t < 4.0) pudding.pose({ ...sp, x: t < 3.48 ? hopX(t, 0.3, 2150, 1660) : hopX(t, 3.48, 1660, 2200), s: 440, flip: t < 3.48 });
}

function poseGit(t) {
  const Gw = R.Gw;
  if (!panel(Gw.desk, t, 4.1, 9.95, DESK.x, DESK.y)) return;
  Gw.side.folks.forEach(f => f.set(t));
  const popOpen = t >= 5.52 && t < 6.42;
  const view = t >= 8.42 ? 'gh' : t >= 6.87 ? 'graph' : 'changes';
  Gw.bc.classList.toggle('open', popOpen);
  if (shown(Gw.pop, popOpen)) {
    const u = E.out4(inv(5.52, 5.72, t));
    Gw.pop.style.opacity = u.toFixed(3);
    Gw.pop.style.translate = `0 ${lerp(-10, 0, u).toFixed(1)}px`;
  }
  Gw.tabChanges.classList.toggle('on', view === 'changes');
  Gw.tabGraph.classList.toggle('on', view === 'graph');
  Gw.tabGh.classList.toggle('on', view === 'gh');
  shown(Gw.vChanges, view === 'changes');
  shown(Gw.vGraph, view === 'graph');
  shown(Gw.vGh, view === 'gh');
}

function poseConsult(t) {
  const Cw = R.Cw, C = S.consult;
  if (!panel(Cw.desk, t, 9.95, 13.95, DESK.x, DESK.y)) return;
  Cw.side.folks.forEach(f => f.set(t));
  const popOn = t >= 10.56 && t < 11.42;
  const swOn = t >= 10.95;
  Cw.sw.classList.toggle('on', swOn);
  Cw.pill.classList.toggle('on', swOn);
  setHTML(Cw.pillLogos, swOn ? `${agentTile('a-codex', 'O', true)}${agentTile('a-grok', 'G', true)}` : '');
  if (shown(Cw.pop, popOn)) {
    const u = E.out4(inv(10.56, 10.76, t));
    Cw.pop.style.opacity = u.toFixed(3);
    Cw.pop.style.translate = `0 ${lerp(12, 0, u).toFixed(1)}px`;
  }
  const asked = t >= 11.45, done = t >= 12.45;
  shown(Cw.you, asked);
  shown(Cw.subcard, asked);
  if (asked) {
    setHTML(Cw.subcard, `<div class="sh">${ic('bot', 12, KD)}<span>${C.consultedHead}</span><span class="cnt">2</span></div>` +
      `<div class="chips">${C.chips.map((ch, idx) => `<span class="subchip">${agentTile(idx ? 'a-grok' : 'a-codex', idx ? 'G' : 'O', true)}<b>${ch.model}</b><span class="desc">${ch.desc}</span>${done ? `<span class="ok">${ic('check', 12, KD)}</span>` : '<span class="live"></span>'}</span>`).join('')}</div>`);
  }
  shown(Cw.reply, done);
  if (done) setHTML(Cw.replyP, typed(C.reply, t, 12.5, 13.65) + (t < 13.65 ? '<span class="cursor"></span>' : ''));
}

function posePhone(t) {
  const X = S.phone;
  if (!panel(R.ph, t, 14.0, 18.95, PHONE.x, PHONE.y)) return;
  const isScreen = t >= 17.18;
  shown(R.phChat, !isScreen);
  shown(R.phScreen, isScreen);
  R.phCtxBtn.classList.toggle('hot', t >= 14.35 && t < 14.55);
  R.phPlusBtn.classList.toggle('hot', t >= 15.75 && t < 15.95);

  const ctxOpen = t >= 14.48 && t < 15.55;
  const plusOpen = t >= 15.88 && t < 17.12;
  const dispOpen = t >= 17.58 && t < 18.12;
  const anySheet = ctxOpen || plusOpen || dispOpen;
  shown(R.phSheetBg, anySheet);

  const animSheet = (el, on, a) => {
    if (!shown(el, on)) return;
    const u = E.out4(inv(a, a + 0.24, t));
    el.style.translate = `0 ${((1 - u) * el.offsetHeight).toFixed(1)}px`;
    R.phSheetBg.style.opacity = u.toFixed(3);
  };
  animSheet(R.phCtxSheet, ctxOpen, 14.48);
  animSheet(R.phPlusSheet, plusOpen, 15.88);
  animSheet(R.phDispSheet, dispOpen, 17.58);
  R.phDisp2.classList.toggle('hot', t >= 17.95 && t < 18.12);

  if (isScreen) {
    const picked2 = t >= 18.12;
    R.phDispBtn.classList.toggle('hot', t >= 17.45 && t < 17.65);
    setHTML(R.phDispBtn, `<span>${picked2 ? X.screenLabel2 : X.displayMain}</span>${ic('chevron-down', 12, KPH)}`);
    R.phMacFrame.classList.toggle('d2', picked2);
    setHTML(R.phMacFrame, picked2
      ? `<div class="mbar"><span>● ● ●</span><span>GitPane.tsx — 2560 × 1440</span></div><div class="mwin">export function GitPane(props) {<br>  const activeView = () =&gt; props.view ?? "changes";<br>  const tree = signal&lt;GitProjectTree | null&gt;(null);<br>  // Switch repo &amp; worktree in place<br>  return &lt;DiffView base={diffBase()} /&gt;;<br>}</div>`
      : `<div class="mbar"><span>● ● ●</span><span>Deskfolk — 1728 × 1117</span></div><div class="mwin">Deskfolk 0.7.0<br>──────────<br>● Active (2)<br>  剪辑 · Thinking<br>  重构多工作树缓存 · Working</div>`);
    setText(R.phMacCap, picked2 ? '2560 × 1440 · Screen 2' : '1728 × 1117 · Main');
  }
}

function poseDesk(t) {
  const Dw = R.Dw;
  if (!panel(Dw.desk, t, 19.0, 23.95, DESK.x, DESK.y)) return;
  Dw.side.folks.forEach(f => f.set(t));
  const onUsage = t >= 21.38;
  Dw.tabChat.classList.toggle('on', !onUsage);
  Dw.tabUsage.classList.toggle('on', onUsage);
  shown(Dw.chatWrap, !onUsage);
  shown(Dw.usagePane, onUsage);
  const tipOn = !onUsage && t >= 20.08 && t < 21.0;
  if (shown(Dw.ctxTip, tipOn)) {
    const u = E.out4(inv(20.08, 20.22, t));
    Dw.ctxTip.style.opacity = u.toFixed(3);
  }
}

function poseCast(t) {
  const { mochi, pudding, reviewer } = R.cast;
  if (t >= 4.2 && t < 9.95) {
    const s = seq(t, [[4.2, 'hop'], [4.92, 'idle', true], [5.5, 'present'], [6.85, 'nod'], [8.4, 'present'], [9.5, 'hop']]);
    pudding.pose({ ...s, x: t < 9.5 ? hopX(t, 4.2, 2150, 1660) : hopX(t, 9.5, 1660, 2150), s: 440, flip: true });
  }
  if (t >= 9.9 && t < 14.2) {
    const s = seq(t, [[9.9, 'hop'], [10.62, 'think', true], [11.45, 'inspect'], [12.5, 'nod'], [13.85, 'hop']]);
    reviewer.pose({ ...s, x: t < 13.85 ? hopX(t, 9.9, 2150, 1640) : hopX(t, 13.85, 1640, 2200), s: 400, flip: t < 13.85 });
  }
  if (t >= 13.9 && t < 19.3) {
    const s = seq(t, [[13.9, 'hop'], [14.62, 'idle', true], [15.0, 'point'], [16.1, 'idle', true], [17.4, 'point'], [18.15, 'nod'], [18.9, 'hop']]);
    mochi.pose({ ...s, x: t < 18.9 ? hopX(t, 13.9, 2150, 1400) : hopX(t, 18.9, 1400, 2200), s: 440, flip: true });
  }
  if (t >= 19.2 && t < 23.62) {
    const s = seq(t, [[19.2, 'hop'], [19.92, 'idle', true], [21.4, 'present'], [22.4, 'cheer'], [23.1, 'idle', true]]);
    pudding.pose({ ...s, x: hopX(t, 19.2, 2150, 1585), s: 400, flip: true });
  }
  if (t >= 19.45 && t < 24.0) {
    const s = seq(t, [[19.45, 'hop'], [20.17, 'inspect'], [21.45, 'nod'], [22.6, 'cheer'], [23.55, 'hop']]);
    reviewer.pose({ ...s, x: t < 23.55 ? hopX(t, 19.45, 2200, 1765) : hopX(t, 23.55, 1765, 1160), s: 360, flip: true });
  }
}

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
    reviewer.pose({ ...seq(t, [[24.0, 'idle', true], [25.3, 'cheer']]), x: 1160, s: 340, flip: true, o: 1 - E.in(inv(26.3, 26.6, t)) });
  }
  if (t >= 23.6 && t < 26.45) {
    R.cast.mochi.pose({ ...seq(t, [[23.6, 'hop'], [24.32, 'idle', true], [25.3, 'cheer']]), x: hopX(t, 23.6, -200, 760), s: 430, flip: false });
    R.cast.pudding.pose({ ...seq(t, [[23.62, 'hop'], [24.34, 'idle', true], [25.42, 'cheer']]), x: hopX(t, 23.62, 1585, 960), s: 380, flip: true });
  }
}

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

async function seek(t) {
  t = clamp(t, 0, DURATION);
  pending = [];
  for (const k in R.cast) R.cast[k].on = false;
  poseRoom(t);
  poseRelease(t);
  poseGit(t);
  poseConsult(t);
  posePhone(t);
  poseDesk(t);
  poseCast(t);
  poseMore(t);
  poseEnd(t);
  for (const k in R.cast) show(R.cast[k].el, R.cast[k].on);
  poseHeads(t);
  posePointer(t);
  poseTouch(t);
  await Promise.all(pending);
}

const CUES = [
  ['whoosh', 0.05, 'Mochi hops in'], ['whoosh', 0.35, 'Pudding hops in'], ['pop', 0.4, 'the name'], ['tick', 0.65, '0.6.0'],
  ['swish', 1.98, 'digit rolls'], ['done', 2.0, '0.7.0 lands'], ['pop', 2.15, '24 updates'], ...P.chips.map((_, i) => ['tick', 2.45 + i * 0.15, 'platform']),
  ['whoosh', 4.1, 'Git pane'], ['whoosh', 4.2, 'Pudding'], ['click', 5.5, 'breadcrumb'], ['pop', 5.55, 'worktree popover'],
  ['click', 6.85, 'History tab'], ['swish', 6.88, 'Git graph'], ['click', 8.4, 'GitHub tab'], ['check', 8.45, 'PR checks passed'],
  ['whoosh', 9.9, 'Reviewer'], ['whoosh', 9.95, 'Consult session'], ['click', 10.55, 'Consult pill'], ['pop', 10.58, 'Consult popover'],
  ['click', 10.95, 'Consult switch ON'], ['pop', 11.45, 'consulted card'], ['check', 12.45, 'consultants answered'],
  ['whoosh', 13.9, 'Mochi'], ['whoosh', 14.0, 'phone'], ['tap', 14.45, 'context ring'], ['pop', 14.5, 'context sheet'],
  ['tap', 15.85, 'composer plus'], ['pop', 15.9, 'more sheet'], ['swish', 17.18, 'Mac screen'],
  ['tap', 17.55, 'display picker'], ['pop', 17.6, 'displays sheet'], ['tap', 18.05, 'Screen 2'], ['check', 18.12, 'switched display'],
  ['whoosh', 19.0, 'Active strip'], ['whoosh', 19.2, 'Pudding'], ['whoosh', 19.45, 'Reviewer'],
  ['pop', 20.1, 'context tooltip'], ['click', 21.35, 'Usage tab'], ['check', 21.4, 'Antigravity tier'], ['pop', 22.5, 'cheer'],
  ['whoosh', 23.6, 'down to front'], ['tick', 24.15, 'chip'], ['tick', 24.31, 'chip'], ['tick', 24.47, 'chip'], ['tick', 24.63, 'chip'], ['tick', 24.79, 'chip'], ['tick', 24.95, 'chip'], ['pop', 25.3, 'cheer'],
  ['whoosh', 26.45, 'onto mark'], ['tap', 27.05, 'white circle'], ['tap', 27.2, 'mustard circle']
];
const KEYS = [...keysOf(S.consult.reply.slice(0, 16), 12.5, 13.5)];

async function boot() {
  SP = await (await fetch('/sprites/sprites.json')).json();
  FOLK = await (await fetch('/work/folk.json')).json();
  layerURL = Object.fromEntries(Object.entries(FOLK.now.layers).map(([n, b64]) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return [n, URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }))];
  }));
  await Promise.all([document.fonts.load('700 72px "DF Sans"'), document.fonts.load('600 30px "DF Mono"'), document.fonts.load('600 40px "PingFang SC"', '交'), document.fonts.load('400 40px "PingFang SC"', '交')]);
  await document.fonts.ready;
  build();
  await Promise.all([...document.querySelectorAll('.folk img')].map(i => i.decode().catch(() => {})));
  measure();
  M.lockX = (1920 - (200 + 40 + M.wordW + 30 + M.endVerW)) / 2; M.lockY = 230;
  window.film.ready = true;
  await seek(0);
}
window.film = { duration: DURATION, seek, ready: false, cues: CUES, keys: KEYS, lang: LANG };
boot();
