// The Deskfolk 0.2.0 release film: the reel's cast (Mochi, Pudding and the Reviewer) presents 0.2.0 and its project
// sessions, each on the app's own surface, redrawn; the task map is the app's own render (map/capture.mjs).
// film.seek(t) poses everything from t alone and resolves once the sprites and map frames it chose have decoded.
// Timeline (120 BPM, a bar every 2 s, the 0.1.0 film's music edit): 0 0.1.0 turns over to 0.2.0 · 4 a project
// session with Claude Code, its first change asked of you · 10 plan mode (the song's breakdown) · 14 the / list,
// then Codex's · 19 the task map, afternoon into night · 24 and more · 26.5 the mark, the URL on the final hit (28.0).
import { clamp, lerp, inv, E, css, h } from '/launch/lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const DURATION = 30.5;
const FPS = 30;
const GY = 905; // the ground line the cast stands on
let SP = null; // sprites.json (the reel's): frames per move, and where the feet are in a frame

// ---------------------------------------------------------------- scale and icons
// The app's surfaces are drawn at KW times their size in the app (film.css --kw).
const KW = 1.8;
// The app's one icon set (apps/messenger/src/lib/icons.ts), the shapes this film draws, copied as they are; stroked
// with the app's 1.6 px pen at the role size, so 38.4 / role units of the 24-unit grid.
const ICONS = {
  x: [{ p: 'M6 6l12 12M18 6 6 18' }],
  check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
  terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
  clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
  'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
  plus: [{ p: 'M12 5v14M5 12h14' }],
  'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
  'shield-check': [{ p: 'M12 21.5s7.5-3.6 7.5-9.5V5.5L12 2.5l-7.5 3V12c0 5.9 7.5 9.5 7.5 9.5z' }, { p: 'm9 12 2 2 4-4' }],
  list: [{ p: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }],
  folder: [{ p: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z' }],
  paperclip: [{ p: 'm21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
  minimap: [{ r: [3, 3, 18, 18, 2.5] }, { r: [12, 12, 6, 6, 1] }],
  file: [{ p: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }, { p: 'M14 3v5h5' }]
};
function ic(name, role, k = KW) {
  const px = +(role * k).toFixed(2);
  const shapes = ICONS[name].map(s => s.p ? `<path d="${s.p}"/>` : s.c ? `<circle cx="${s.c[0]}" cy="${s.c[1]}" r="${s.c[2]}"/>`
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
/** Fades and lifts an element in from a (with a small overshoot when pop). */
function rise(el, t, a, { pop = false, dy = 18, d = 0.32 } = {}) {
  const u = (pop ? E.pop : E.out4)(inv(a, a + d, t));
  el.style.opacity = clamp(inv(a, a + d * 0.5, t)).toFixed(3);
  el.style.translate = `0 ${lerp(dy, 0, E.out4(inv(a, a + d, t))).toFixed(1)}px`;
  if (pop) el.style.scale = lerp(0.85, 1, u).toFixed(3);
}
/** Shown from a to b: rises in at a, fades out over the last 0.25 s. */
function span(el, t, a, b, opts) {
  if (!show(el, t >= a && t < b)) return false;
  rise(el, t, a, opts);
  el.style.opacity = (Math.min(+el.style.opacity, 1 - E.in(inv(b - 0.25, b, t)))).toFixed(3);
  return true;
}
/** What has been typed of `text` by t, typing from a to b. */
const typed = (text, t, a, b) => [...text].slice(0, Math.round([...text].length * clamp(inv(a, b, t)))).join('');

// ---------------------------------------------------------------- DOM
const R = {};
// the window's conversation column (pane coordinates inside .conv): your lines end at XR, the agent's start at X0
const X0 = 40, XR = 840, COMP_Y = 506;

function build() {
  R.dim = document.getElementById('dusk');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };

  // ---- 0–4 the release: 0.1.0 turns over to 0.2.0
  R.badge = h('div', 'abs', null, stage);
  R.bMark = h('div', 'abs', markSVG(200), R.badge);
  R.bWord = h('div', 'abs word', S.word, R.badge);
  const [major, minor, patch] = S.version.split('.'), from = S.from.split('.')[1];
  R.ver = h('div', 'abs ver', `<span>${major}.</span><span class="roll"><span class="col"><span>${from}</span><span>${minor}</span></span></span><span>.${patch}</span>`, R.badge);
  R.roll = R.ver.querySelector('.roll'); R.rollCol = R.ver.querySelector('.col');
  R.count = h('div', 'abs pill count', `${ic('check', 12)}${S.count}`, R.badge);
  R.mac = h('div', 'abs platform', `${ic('check', 16)}<span>${S.mac}</span>`, stage);
  R.win = h('div', 'abs platform quiet', `${ic('minimap', 16)}<span>${S.win}</span>`, stage);

  // ---- 4–19 the window: your Bots and, under 项目, a folder and its sessions
  const w = R.window = h('div', 'abs pane chat', null, stage);
  css(w, { width: 1180, height: 680 });
  const side = h('div', 'side', null, w);
  h('div', 'side-hd', `${markSVG(40)}<b>Deskfolk</b>`, side);
  R.botRow = h('div', 'srow', `${face('pudding', 48, true)}<span class="sn"><b>${S.botName}</b><span class="sp">${S.botPrev}</span></span>`, side);
  h('div', 'sec', `<span>${S.section}</span><span class="add">${ic('plus', 16)}</span>`, side);
  const dirRow = h('div', 'dirrow', `<span class="fold">${ic('folder', 16)}</span><span>${S.dir}</span>`, side);
  R.dirAdd = h('span', 'add', ic('plus', 16), dirRow);
  R.rowCC = h('div', 'prow', `${agentMark}<span class="t"></span><i class="live"></i>`, side);
  R.rowCCt = R.rowCC.querySelector('.t'); R.rowCCl = R.rowCC.querySelector('.live');
  R.rowCX = h('div', 'prow', `${agentMark}<span class="t">${S.cxTitle}</span>`, side);
  // the folder's + opens one item per agent
  R.menu = h('div', 'abs amenu', null, w);
  R.miCC = h('div', 'ami', `${agentMark}<span>${S.newCC}</span>`, R.menu);
  R.miCX = h('div', 'ami', `${agentMark}<span>${S.newCX}</span>`, R.menu);
  h('div', 'sep', null, R.menu);
  h('div', 'ami', `<span class="am" style="background:none;border:0">${ic('file', 12)}</span><span style="color:var(--ink2)">${S.importSession}</span>`, R.menu);

  const conv = R.conv = h('div', 'conv', null, w);
  // the head: a Bot's direct (its face and name), or a session's name, agent and folder with the bar's 地图
  R.hd = h('div', 'conv-hd', null, conv);
  R.mapBtn = h('span', 'mapbtn', `${ic('minimap', 16)}<span>${S.map}</span>`, null);
  // the Bot's direct, before a session is opened
  R.botReply = h('div', 'abs reply', `${face('pudding', 52, true)}<div><div class="rname"><b>${S.botName}</b></div><div class="words">${S.botPrev}</div></div>`, conv);
  // your lines and the agent's
  R.you = h('div', 'abs bubble-you', '', conv);
  R.youT = h('div', 'abs time', '10:42', conv);
  R.sfoot = h('div', 'abs sfoot', `<span class="pulse"></span><span class="st"></span><span class="dur">${ic('clock', 12)}<span class="d"></span></span>`, conv);
  R.sfootT = R.sfoot.querySelector('.st'); R.sfootD = R.sfoot.querySelector('.d');
  R.appr = h('div', 'abs approval waiting', `<div class="head">${ic('shield-check', 12)}<span>${S.approvalHead}</span><span class="whom">${S.agentCC}</span></div>` +
    `<div class="main"><div class="body mono">${S.approvalBody}</div><div class="acts"><div class="btns"><span class="btn primary">${ic('check', 16)}${S.allow}</span><span class="btn secondary">${S.deny}</span></div></div></div>`, conv);
  R.allowBtn = R.appr.querySelector('.btn.primary');
  // /review in the Codex session: under ask first, one card before the review, and none for its commands
  R.apprCX = h('div', 'abs approval waiting', `<div class="head">${ic('shield-check', 12)}<span>${S.approvalHead}</span><span class="whom">${S.agentCX}</span></div>` +
    `<div class="main"><div class="body mono wrap">${S.reviewBody}</div><div class="acts"><div class="btns"><span class="btn primary">${ic('check', 16)}${S.allow}</span><span class="btn secondary">${S.deny}</span></div></div></div>`, conv);
  R.reply = h('div', 'abs agentline', `${S.reply1} <span class="filechip">${ic('file', 12)}<span>${S.reply1File}</span></span>`, conv);
  R.replyT = h('div', 'abs time', '10:43', conv);
  R.plan = h('div', 'abs plancard', `<div class="head">${ic('list', 12)}<span>${S.planHead}</span><span class="whom">${S.agentCC}</span></div>` +
    `<ol>${S.planRows.map(([a, code, b]) => `<li>${a}${code ? `<code>${code}</code>` : ''}${b}</li>`).join('')}</ol>` +
    `<div class="foot"><span class="btn primary">${ic('check', 16)}${S.planApprove}</span><span class="btn secondary">${S.planKeep}</span><span class="hint">${S.planHint}</span></div>`, conv);
  R.planOk = R.plan.querySelector('.btn.primary');
  // the / list over the composer
  const menu = (rows) => {
    const m = h('div', 'abs cmenu', null, conv);
    const els = rows.map(([n, hint, d]) => h('div', 'cr', `<span class="cn">/${n}</span>${hint ? `<span class="ch">${hint}</span>` : ''}<span class="cd">${d}</span>`, m));
    h('div', 'keys', `<span class="key">↑↓</span>${S.cmdKeys[0]}<span class="key">Tab</span>${S.cmdKeys[1]}<span class="key">Enter</span>${S.cmdKeys[2]}<span class="key">Esc</span>${S.cmdKeys[3]}`, m);
    return { m, els };
  };
  R.cmCC = menu(S.cmdsCC); R.cmCX = menu(S.cmdsCX);
  // the composer: the words, then the clip, 计划 (Claude Code's only), the picker and send
  R.comp = h('div', 'abs composer pcomp', null, conv);
  R.compTxt = h('div', 'txt', '', R.comp);
  h('span', 'cb attach', ic('paperclip', 20), R.comp);
  R.planTog = h('span', 'plantog', `${ic('list', 16)}<span>${S.plan}</span>`, R.comp);
  h('span', 'tune', `<span>${S.tune[0]}</span><span class="sep">·</span><span>${S.tune[1]}</span><span class="chev">${ic('chevron-down', 12)}</span>`, R.comp);
  h('span', 'gap', null, R.comp);
  R.send = h('span', 'cb send off', ic('arrow-up', 20), R.comp);
  // Shift + Tab, pressed beside the window
  R.keys = h('div', 'abs keycap', `<span class="kc">${S.keys[0]}</span><span>+</span><span class="kc">${S.keys[1]}</span>`, stage);

  // ---- 19–24 the task map
  R.mapP = h('div', 'abs pane mappane', null, stage);
  css(R.mapP, { width: 1300, height: 680 });
  h('div', 'mhd', `${ic('minimap', 16)}<b>${S.map}</b><span class="mt">${S.mapTitle}</span><span class="lv"><i></i>${S.live}</span>`, R.mapP);
  R.mapImg = h('img', null, null, R.mapP);
  R.mapImg.decoding = 'sync';

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

const M = {};
function measure() {
  const w = el => el.getBoundingClientRect().width, hh = el => el.getBoundingClientRect().height;
  M.bWordW = w(R.bWord); M.bWordH = hh(R.bWord); M.verW = w(R.ver); M.countW = w(R.count);
  M.macW = w(R.mac); M.winW = w(R.win);
  M.keysW = w(R.keys);
  M.moreW = R.more.map(w);
  M.cmH = { cc: hh(R.cmCC.m), cx: hh(R.cmCX.m) };
  M.compH = hh(R.comp);
  M.wordW = w(R.word); M.wordH = hh(R.word); M.endVerW = w(R.endVer); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
}

// ---------------------------------------------------------------- headlines (one slot, top left)
const HEADS = { proj: [4.05, 9.85], plan: [10.05, 13.85], cmds: [14.05, 18.85], map: [19.05, 23.85], more: [24.05, 26.25] };
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
  // plan mode quiets the room a little while the song breaks down
  R.dim.style.opacity = (0.22 * E.smooth(inv(11.0, 11.6, t)) * (1 - E.smooth(inv(13.4, 13.9, t)))).toFixed(3);
}

// ---------------------------------------------------------------- pointer
const CLICKS = [
  { at: 5.0, from: [1500, 1060], el: () => R.dirAdd }, { at: 5.55, from: [700, 700], el: () => R.miCC },
  { at: 8.0, from: [1350, 1060], el: () => R.allowBtn }, { at: 13.3, from: [1350, 1060], el: () => R.planOk },
  { at: 15.9, from: [900, 1060], el: () => R.rowCX }, { at: 18.35, from: [1400, 1060], el: () => R.mapBtn }
];
function posePointer(t) {
  let p = null, click = null;
  for (const c of CLICKS) {
    if (t > c.at - 0.5 && t < c.at + 0.45) {
      const r = c.el().getBoundingClientRect(), tx = r.left + Math.min(r.width / 2, 60), ty = r.top + r.height / 2;
      const u = E.out4(inv(c.at - 0.45, c.at - 0.1, t));
      p = { x: lerp(c.from[0], tx - 6, u), y: lerp(c.from[1], ty - 4, u) + (t > c.at - 0.02 && t < c.at + 0.07 ? 3 : 0), o: Math.min(E.out(inv(c.at - 0.5, c.at - 0.36, t)), 1 - E.in(inv(c.at + 0.25, c.at + 0.45, t))) };
      click = { at: c.at, x: tx, y: ty };
    }
  }
  if (p) css(R.pointer, { x: p.x, y: p.y, opacity: p.o }); else R.pointer.style.opacity = 0;
  if (click && t >= click.at && t < click.at + 0.45) {
    const u = inv(click.at, click.at + 0.45, t);
    css(R.ripple, { x: click.x, y: click.y, s: lerp(0.25, 1.25, E.out(u)), opacity: 0.7 * (1 - u) });
  } else R.ripple.style.opacity = 0;
}

// ---------------------------------------------------------------- 0–4 · 0.1.0 turns over to 0.2.0
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
  // the version is there from the start as 0.1.0; its middle digit shakes, then rolls over to 2 on the 2.0 downbeat
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

// ---------------------------------------------------------------- 4–19 · the window
// Which conversation the window shows: the Bot's direct, then the new Claude Code session, then the Codex one.
const VIEW = t => (t < 6.0 ? 'bot' : t < 16.0 ? 'cc' : 'cx');
function poseWindow(t) {
  const on = panel(R.window, t, 4.15, 18.95, 120, 280);
  const kids = [R.menu, R.rowCC, R.botReply, R.you, R.youT, R.sfoot, R.appr, R.reply, R.replyT, R.plan, R.cmCC.m, R.cmCX.m, R.comp, R.apprCX];
  if (!on) { kids.forEach(e => show(e, false)); return; }
  const view = VIEW(t);
  // the sidebar: the folder's + is pressed, the new session joins the folder on the 6.0 downbeat
  R.dirAdd.classList.toggle('hot', t > 4.6 && t < 5.6);
  R.botRow.classList.toggle('on', view === 'bot');
  if (show(R.rowCC, t >= 5.98)) {
    const u = E.out4(inv(5.98, 6.3, t));
    R.rowCC.style.maxHeight = `${(54 * u).toFixed(1)}px`; R.rowCC.style.opacity = u.toFixed(3);
  } else R.rowCC.style.maxHeight = '0px';
  R.rowCC.classList.toggle('on', view === 'cc');
  setText(R.rowCCt, t >= 6.75 ? S.line1 : S.untitled);
  R.rowCCl.style.opacity = (t >= 6.8 && t < 8.5) ? 1 : 0;
  R.rowCX.classList.toggle('on', view === 'cx');
  // the folder's menu: one item per agent; Claude Code's is picked
  if (show(R.menu, t >= 5.0 && t < 5.75)) {
    const u = E.pop(inv(5.0, 5.22, t)), o = E.in(inv(5.6, 5.75, t));
    R.menu.style.transformOrigin = '0 0';
    css(R.menu, { x: 200, y: 268, s: lerp(0.92, 1, u), opacity: clamp(inv(5.0, 5.08, t)) * (1 - o) });
    R.miCC.classList.toggle('hot', t > 5.25);
  }
  // the head
  if (view === 'bot') setHTML(R.hd, `${face('pudding', 40, true)}<b>${S.botName}</b>`);
  else {
    const title = view === 'cx' ? S.cxTitle : t >= 6.75 ? S.line1 : S.untitled;
    setHTML(R.hd, `<b>${title}</b><span class="agentpill">${agentMark.replace('class="am"', 'class="am" style="width:26px;height:26px;border:0;background:none"')}${view === 'cx' ? S.agentCX : S.agentCC}</span><span class="dirp">${S.dirPath}</span>`);
    R.hd.appendChild(R.mapBtn);
  }
  R.mapBtn.classList.toggle('hot', t > 17.95 && t < 18.7);
  if (show(R.botReply, view === 'bot')) css(R.botReply, { x: X0, y: 110 });
  // the composer: what is typed, Claude Code's 计划, and the placeholder for the agent and the mode
  const planOn = t >= 11.0 && t < 13.95;
  R.planTog.style.display = view === 'cx' ? 'none' : '';
  R.planTog.classList.toggle('on', planOn);
  css(R.planTog, { s: t > 10.93 && t < 11.05 ? 0.92 : 1 });
  let text = '', ph = view === 'cx' ? S.phCX : planOn ? S.phPlan : S.phCC;
  if (view === 'cc') {
    if (t >= 6.05 && t < 6.7) text = typed(S.line1, t, 6.05, 6.55);
    else if (t >= 11.3 && t < 12.0) text = typed(S.line2, t, 11.3, 11.85);
    else if (t >= 14.3 && t < 15.55) text = '/';
  } else if (view === 'cx') {
    if (t >= 16.3 && t < 16.75) text = '/';
    else if (t >= 16.75 && t < 17.3) text = '/' + typed('review', t, 16.75, 17.05);
  }
  setHTML(R.compTxt, text ? `${text}<span class="caret"></span>` : `<span class="caret lead"></span><span class="ph">${ph}</span>`);
  R.comp.classList.toggle('focus', view !== 'bot');
  R.send.classList.toggle('off', !text);
  css(R.comp, { x: X0, y: COMP_Y });
  if (show(R.comp, view !== 'bot')) R.comp.style.opacity = 1;
  poseLines(t, view);
}

// the transcript of each scene: your line, the agent at work, a card, its answer; cleared between scenes
function poseLines(t, view) {
  // a scene's lines leave upward as the next scene starts
  const clear = (a) => ({ dy: -60 * E.in(inv(a, a + 0.3, t)), o: 1 - E.in(inv(a, a + 0.3, t)) });
  const place = (el, x, y, a, b, { pop = false, out = null } = {}) => {
    if (!show(el, t >= a && t < b)) return;
    const u = (pop ? E.pop : E.out4)(inv(a, a + 0.32, t)), c = out === null ? { dy: 0, o: 1 } : clear(out);
    el.style.transformOrigin = '50% 50%';
    css(el, { x, y: y + lerp(18, 0, E.out4(inv(a, a + 0.32, t))) + c.dy, s: pop ? lerp(0.9, 1, u) : 1, opacity: clamp(inv(a, a + 0.16, t)) * c.o });
  };
  const youLine = (text, a, b, out) => {
    setText(R.you, text);
    // layout widths: the window may be scaling in or out
    place(R.you, XR - R.you.offsetWidth, 96, a, b, { out });
    place(R.youT, XR - R.youT.offsetWidth, 176, a + 0.1, b, { out });
  };
  // 4–10 · the first line, Claude Code asking before its change, and its answer
  if (t >= 6.7 && t < 10.3) youLine(S.line1, 6.7, 10.3, 9.95);
  // 10–14 · plan mode: the plan it presents
  else if (t >= 12.0 && t < 14.25) youLine(S.line2, 12.0, 14.25, 13.95);
  // 16–19 · /review in the Codex session
  else if (t >= 17.35 && t < 19.0) youLine('/review', 17.35, 19.0, null);
  else { show(R.you, false); show(R.youT, false); }

  // the stream foot: thinking, then waiting on you
  let foot = null;
  if (t >= 6.9 && t < 7.3) foot = [S.thinking, 6.9];
  else if (t >= 7.3 && t < 8.1) foot = [S.waiting, 6.9];
  else if (t >= 17.5 && t < 19.0) foot = [S.waitingCX, 17.5];
  if (show(R.sfoot, !!foot)) {
    setText(R.sfootT, foot[0]);
    setText(R.sfootD, `0:${String(Math.floor(t - foot[1]) + 1).padStart(2, '0')}`);
    css(R.sfoot, { x: X0, y: view === 'cx' ? 178 : 206, opacity: clamp(inv(foot[1], foot[1] + 0.15, t)) });
  }
  // /review waits on its card while you look at the map
  place(R.apprCX, X0, 210, 17.55, 19.0, { pop: true });
  // the approval card, answered on the 8.0 downbeat
  place(R.appr, X0, 244, 7.3, 8.35, { pop: true });
  if (R.appr.style.visibility === 'visible') {
    R.allowBtn.style.scale = t > 7.98 && t < 8.1 ? '0.94' : '1';
    R.appr.style.opacity = (+R.appr.style.opacity * (1 - E.in(inv(8.1, 8.35, t)))).toFixed(3);
  }
  place(R.reply, X0, 224, 8.55, 10.3, { out: 9.95 });
  place(R.replyT, X0, 354, 8.65, 10.3, { out: 9.95 });
  // the plan card, approved at 13.3
  place(R.plan, X0, 200, 12.35, 14.25, { pop: true, out: 13.95 });
  if (R.plan.style.visibility === 'visible') R.planOk.style.scale = t > 13.28 && t < 13.4 ? '0.94' : '1';
  // the / lists: Claude Code's, then Codex's; the active row walks down to /review
  const list = (cm, a, b, steps, hKey) => {
    if (!show(cm.m, t >= a && t < b)) return;
    const u = E.pop(inv(a, a + 0.24, t)), o = E.in(inv(b - 0.15, b, t));
    cm.m.style.transformOrigin = '50% 100%';
    css(cm.m, { x: X0, y: COMP_Y - 14 - M.cmH[hKey], s: lerp(0.94, 1, u), opacity: clamp(inv(a, a + 0.1, t)) * (1 - o) });
    let active = 0;
    for (const [at, i] of steps) if (t >= at) active = i;
    cm.els.forEach((el, i) => el.classList.toggle('on', i === active));
  };
  list(R.cmCC, 14.4, 15.6, [[14.85, 1], [15.15, 2]], 'cc');
  list(R.cmCX, 16.4, 17.32, [[16.85, 1]], 'cx');
}

// ---------------------------------------------------------------- 4–19 · the cast beside the window
function poseCastWindow(t) {
  const { mochi, pudding, reviewer } = R.cast;
  // Pudding, who stayed from the opening: at work, asking, nodding at your Allow, presenting the answer
  if (t >= 4.0 && t < 9.95) {
    const s = seq(t, [[4.0, 'idle', true], [6.9, 'work', true], [7.3, 'ask'], [8.05, 'nod'], [8.6, 'present'], [9.5, 'idle', true], [9.55, 'hop']]);
    pudding.pose({ ...s, x: t < 9.55 ? 1660 : hopX(t, 9.55, 1660, 2150), s: 440, flip: true });
  }
  // the Reviewer thinks the plan through with you, looks it over, and nods
  if (t >= 9.9 && t < 14.3) {
    const s = seq(t, [[9.9, 'hop'], [10.62, 'think', true], [12.35, 'inspect'], [13.3, 'nod'], [13.95, 'hop']]);
    const x = t < 13.95 ? hopX(t, 9.9, 2150, 1600) : hopX(t, 13.95, 1600, 2200);
    reviewer.pose({ ...s, x, s: 400, flip: t < 13.95 });
  }
  // Mochi types the /, points at the Codex session and at the map
  if (t >= 13.9 && t < 19.4) {
    const s = seq(t, [[13.9, 'hop'], [14.62, 'type', true], [15.55, 'point'], [16.3, 'type', true], [17.35, 'nod'], [18.0, 'point'], [18.75, 'idle', true]]);
    mochi.pose({ ...s, x: hopX(t, 13.9, 2150, 1600), s: 430, flip: true });
  }
}

// ---------------------------------------------------------------- 19–24 · the task map, afternoon into night
const MAP_FROM = 19.0, MAP_FRAMES = 150;
function poseMap(t) {
  const { mochi, pudding, reviewer } = R.cast;
  if (t >= 19.4 && t < 23.6) mochi.pose({ ...seq(t, [[19.4, 'idle', true], [21.0, 'nod'], [21.7, 'idle', true]]), x: 1600, s: 400, flip: true });
  if (t >= 19.2 && t < 23.62) {
    const s = seq(t, [[19.2, 'hop'], [19.92, 'idle', true], [22.4, 'cheer'], [23.4, 'idle', true]]);
    pudding.pose({ ...s, x: hopX(t, 19.2, 2150, 1790), s: 360, flip: true });
  }
  if (t >= 19.45 && t < 24.0) {
    const s = seq(t, [[19.45, 'hop'], [20.17, 'inspect'], [21.4, 'think', true], [23.55, 'hop']]);
    const x = t < 23.55 ? hopX(t, 19.45, 2200, 1930) : hopX(t, 23.55, 1930, 1160);
    reviewer.pose({ ...s, x, s: 330, flip: true });
  }
  if (!panel(R.mapP, t, 19.0, 24.0, 120, 280)) return;
  const f = clamp(Math.round((t - MAP_FROM) * FPS), 0, MAP_FRAMES - 1);
  const src = `/work/map-${LANG}/${String(f + 1).padStart(4, '0')}.png`;
  if (R.mapImg.getAttribute('src') !== src) {
    R.mapImg.setAttribute('src', src);
    pending.push(R.mapImg.decode().catch(() => {}));
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
  // Mochi and Pudding come down from the map to the front, cheer, and go on to the mark
  if (t >= 23.6 && t < 26.45) {
    R.cast.mochi.pose({ ...seq(t, [[23.6, 'hop'], [24.32, 'idle', true], [25.3, 'cheer']]), x: hopX(t, 23.6, 1600, 760), s: 430, flip: t < 24.0 });
    R.cast.pudding.pose({ ...seq(t, [[23.62, 'hop'], [24.34, 'idle', true], [25.42, 'cheer']]), x: hopX(t, 23.62, 1790, 960), s: 380, flip: true });
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

// ---------------------------------------------------------------- Shift + Tab
function poseKeys(t) {
  if (!show(R.keys, t >= 10.45 && t < 11.6)) return;
  const u = E.pop(inv(10.45, 10.72, t)), o = E.in(inv(11.35, 11.6, t));
  R.keys.style.transformOrigin = '50% 50%';
  const press = t > 10.93 && t < 11.08 ? 4 : 0;
  R.keys.querySelectorAll('.kc').forEach(k => { k.style.translate = `0 ${press}px`; k.style.borderBottomWidth = `${6 - press}px`; });
  css(R.keys, { x: 120 + 300 + X0 + 240 - M.keysW / 2, y: 280 + COMP_Y - 92, s: lerp(0.8, 1, u), opacity: clamp(inv(10.45, 10.55, t)) * (1 - o) });
}

// ---------------------------------------------------------------- seek
async function seek(t) {
  t = clamp(t, 0, DURATION);
  pending = [];
  for (const k in R.cast) R.cast[k].on = false;
  poseRoom(t);
  poseRelease(t);
  poseWindow(t);
  poseCastWindow(t);
  poseKeys(t);
  poseMap(t);
  poseMore(t);
  poseEnd(t);
  for (const k in R.cast) show(R.cast[k].el, R.cast[k].on);
  poseHeads(t);
  posePointer(t);
  await Promise.all(pending);
}

// ---------------------------------------------------------------- sound cues: name, film time, what it marks
const CUES = [
  ['whoosh', 0.05, 'Mochi hops in'], ['whoosh', 0.35, 'Pudding hops in'], ['pop', 0.4, 'the name'], ['tick', 0.65, '0.1.0'],
  ['swish', 1.98, 'the digit rolls'], ['done', 2.0, '0.2.0 lands'], ['pop', 2.15, 'the count'], ['tick', 2.45, 'macOS'], ['tick', 2.65, 'Windows'],
  ['whoosh', 4.15, 'the window'], ['click', 5.0, 'the folder’s +'], ['pop', 5.0, 'its menu'], ['click', 5.55, 'Claude Code'], ['pop', 5.98, 'the new session'],
  ['tick', 6.7, 'your line'], ['pop', 7.3, 'it asks you'], ['click', 8.0, 'Allow'], ['check', 8.55, 'its answer'],
  ['whoosh', 9.55, 'Pudding leaves'], ['whoosh', 9.9, 'the Reviewer'], ['swish', 9.95, 'the lines leave'], ['click', 10.95, 'Shift+Tab'], ['pop', 11.0, 'plan mode on'],
  ['tick', 12.0, 'your line'], ['pop', 12.35, 'the plan'], ['click', 13.3, 'approve'], ['swish', 13.95, 'the lines leave'], ['whoosh', 13.9, 'Mochi'],
  ['tick', 14.3, '/'], ['pop', 14.4, 'Claude Code’s commands'], ['tick', 14.85, 'row'], ['tick', 15.15, 'row'], ['click', 15.9, 'the Codex session'],
  ['tick', 16.3, '/'], ['pop', 16.4, 'Codex’s commands'], ['tick', 16.85, 'row'], ['tick', 17.35, '/review'], ['pop', 17.55, 'it asks first'], ['click', 18.35, 'the map'],
  ['whoosh', 19.0, 'the map'], ['whoosh', 19.2, 'Pudding'], ['whoosh', 19.45, 'the Reviewer'], ['pop', 22.4, 'night, a cheer'],
  ['whoosh', 23.6, 'down to the front'], ['tick', 24.15, 'chip'], ['tick', 24.31, 'chip'], ['tick', 24.47, 'chip'], ['tick', 24.63, 'chip'], ['tick', 24.79, 'chip'], ['tick', 24.95, 'chip'], ['pop', 25.3, 'cheer'],
  ['whoosh', 26.45, 'onto the mark'], ['tap', 27.05, 'white circle'], ['tap', 27.2, 'mustard circle']
];

// ---------------------------------------------------------------- boot
async function boot() {
  SP = await (await fetch('/sprites/sprites.json')).json();
  await Promise.all([document.fonts.load('700 76px "DF Sans"'), document.fonts.load('600 30px "DF Mono"'), document.fonts.load('600 40px "PingFang SC"', '交'), document.fonts.load('400 40px "PingFang SC"', '交')]);
  await document.fonts.ready;
  build();
  measure();
  M.lockX = (1920 - (200 + 40 + M.wordW + 30 + M.endVerW)) / 2; M.lockY = 230;
  window.film.ready = true;
  await seek(0);
}
window.film = { duration: DURATION, seek, ready: false, cues: CUES, keys: [], lang: LANG };
boot();
