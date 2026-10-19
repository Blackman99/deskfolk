// The Deskfolk 0.1.0 release film: the reel's cast (Mochi, Pudding and the Reviewer) presents the first stable
// release and four of its changes, each on the app's own surface, redrawn.
// film.seek(t) poses everything from t alone and resolves once the sprites it chose have decoded.
// Timeline (120 BPM, a bar every 2 s): 0 Alpha comes off, 0.1.0 goes on · 4 the flow shows first what needs a look ·
// 10 focus mode (the song's breakdown) · 14 where a Bot is busy, and its direct reported back · 19 the spend page as a
// dashboard · 24 and more · 26.5 the mark, the URL on the song's final hit (28.0).
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
  target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1.5] }],
  terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
  clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
  image: [{ r: [3, 4, 18, 16, 2.5] }, { c: [8.5, 9.5, 1.5] }, { p: 'm21 16-5-5-9 9' }],
  'chevron-right': [{ p: 'm9 6 6 6-6 6' }],
  'alert-triangle': [{ p: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }, { p: 'M12 9v4M12 17h.01' }],
  monitor: [{ r: [2.5, 4, 19, 13, 2] }, { p: 'M8 21h8M12 17v4' }]
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
const spinner = (size, t) => `<svg class="spin" width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--accent-b)" stroke-width="2.4"/><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" transform="rotate(${((t * 540) % 360).toFixed(0)} 12 12)"/></svg>`;
// a mascot's face from its first idle frame; `bot` draws one Bot's picture as the app does, a rounded square
const face = (who, size, bot = false) => `<span class="face${bot ? ' bot' : ''}" style="width:${size}px;height:${size}px;background-image:url(/sprites/${who}/idle/0001.png);background-size:${size * 2.15}px;background-position:50% 64%"></span>`;
// a deleted Bot: the first character of its name, greyed (SpendBotFace.svelte)
const gone = (name, size) => `<span class="face bot gone" style="width:${size}px;height:${size}px;font-size:${(size * 0.46).toFixed(0)}px">${[...name][0]}</span>`;
const setHTML = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mixC = (a, b, u) => { const x = hex(a), y = hex(b); return `rgb(${x.map((v, i) => Math.round(lerp(v, y[i], u))).join(',')})`; };

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

// ---------------------------------------------------------------- DOM
const R = {};
// the flow's cards, pane coordinates: [key, kind, column, row before 0.1.0, row now, words, status before, status now]
// kind: line (rounded ends), turn (a box with its status stripe), decision (pointed ends), step (the app's own, slanted)
const CARDS = [
  ['A', 'line', 'c', 0, 0, S.cA, 'none', 'none'],
  ['B', 'turn', 'c', 1, 1, S.cB, 'done-old', 'done'],
  ['R1', 'step', 'c', 2, null, S.cR, 'quiet', 'quiet'],
  ['C', 'turn', 'l', 3, 2, S.cC, 'done-old', 'done'],
  ['D', 'turn', 'r', 3, 2, S.cD, 'done-old', 'done'],
  ['R2', 'step', 'l', 4, null, S.cR, 'quiet', 'quiet'],
  ['E', 'decision', 'l', 5, 3, S.cE, 'none', 'none'],
  ['F', 'step', 'r', 4, 3, S.cF, 'bad', 'bad'],
  ['G', 'turn', 'r', 5, 4, S.cG, 'wait', 'wait']
];
const EDGES = [['A', 'B'], ['B', 'C'], ['B', 'D'], ['C', 'E'], ['D', 'F'], ['F', 'G']];
const COLX = { l: 70, c: 290, r: 510 }, CW = 380, CH = 72, ROW0 = 108, PITCH = 96;
// colours of a card by status: [edge, stripe, fill, ink]
const COL = {
  none: ['#c9d3d6', '#c9d3d6', '#ffffff', '#121c20'],
  done: ['#e0e6e8', '#e0e6e8', '#ffffff', '#121c20'],
  'done-old': ['#bbf7d0', '#16a34a', '#f0fdf4', '#121c20'],
  quiet: ['#e0e6e8', '#95a2a8', '#eff3f4', '#5f6d74'],
  bad: ['#dc2626', '#dc2626', '#fef2f2', '#b91c1c'],
  wait: ['#d97706', '#d97706', '#fffbeb', '#b45309']
};

function build() {
  R.dim = document.getElementById('dusk');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };

  // ---- 0–4 the release
  R.badge = h('div', 'abs', null, stage);
  R.bMark = h('div', 'abs', markSVG(200), R.badge);
  R.bWord = h('div', 'abs word', S.word, R.badge);
  R.alpha = h('div', 'abs alpha', S.alpha, R.badge);
  R.ver = h('div', 'abs ver', S.version, R.badge);
  R.stable = h('div', 'abs pill stable', `${ic('check', 12)}${S.stable}`, R.badge);
  R.mac = h('div', 'abs platform', `${ic('check', 16)}<span>${S.mac}</span>`, stage);
  R.win = h('div', 'abs platform quiet', `${ic('monitor', 16)}<span>${S.win}</span>`, stage);

  // ---- 4–10 the flow
  R.board = h('div', 'abs pane board', null, stage);
  css(R.board, { width: 1300, height: 700 });
  R.boardHd = h('div', 'board-hd', `<span class="bt">${S.jobTitle}</span>`, R.board);
  R.tools = h('span', 'tools', `<span class="anom">${ic('alert-triangle', 12)}<span>${S.anomalies}</span><b>${S.anomaliesN}</b></span>` +
    `<span class="tog"><i></i><span>${S.showAll}</span></span>`, R.boardHd);
  R.anom = R.tools.querySelector('.anom');
  R.edges = h('div', 'abs', `<svg width="1300" height="700" viewBox="0 0 1300 700"><g fill="none" stroke="#c9d3d6" stroke-width="3" stroke-linejoin="round">${EDGES.map(() => '<path/>').join('')}</g></svg>`, R.board);
  R.edgePaths = [...R.edges.querySelectorAll('path')];
  R.cards = {};
  for (const [key, kind, , , , words] of CARDS) {
    const el = h('div', `abs fcard ${kind}`, null, R.board);
    css(el, { width: CW, height: CH });
    const edge = h('div', 'edge', null, el), fill = h('div', 'fill', null, el);
    const pic = kind === 'turn' ? face('pudding', 34, true) : '';
    const body = h('div', 'body', `${pic}<span class="w">${words}</span><span class="st"></span>`, el);
    R.cards[key] = { el, edge, fill, body, st: body.querySelector('.st'), kind };
  }
  R.mini = h('div', 'abs minimap', null, R.board);
  css(R.mini, { left: 1000, top: 500, width: 250, height: 170 });
  R.miniCards = {};
  for (const [key, kind] of CARDS) R.miniCards[key] = h('i', `m ${kind}`, null, R.mini);
  R.era = h('div', 'abs stamp era', S.before, stage);

  // ---- 10–14 focus mode, and 14–19 where it is busy: the same window, two conversations
  const shell = (cls) => {
    const w = h('div', `abs pane chat ${cls}`, null, stage);
    css(w, { width: 1180, height: 680 });
    const side = h('div', 'side', null, w);
    const sh = h('div', 'side-hd', `${markSVG(40)}<b>Deskfolk</b>`, side);
    const tg = h('span', 'target', ic('target', 16), sh);
    const row = (pic, name, prev, on) => h('div', `srow${on ? ' on' : ''}`, `${pic}<span class="sn"><b>${name}</b><span class="sp">${prev}</span></span>`, side);
    const conv = h('div', 'conv', null, w);
    return { w, tg, row, conv };
  };
  const groupFace = `<span class="gface">${face('reviewer', 30)}${face('pudding', 30)}</span>`;
  {
    const { w, tg, row, conv } = shell('focuswin');
    R.chat = w; R.target = tg;
    row(face('pudding', 48, true), S.dmName, S.replyA, true);
    row(groupFace, S.groupName, S.cD, false);
    h('div', 'conv-hd', `${face('pudding', 40, true)}<b>${S.dmName}</b>`, conv);
    R.fMine = h('div', 'abs bubble-you', S.myLine, conv);
    R.fTime = h('div', 'abs meta', S.myTime, conv);
    R.fFace = h('div', 'abs', face('pudding', 52, true), conv);
    R.fName = h('div', 'abs rname', `<b>${S.dmName}</b>`, conv);
    R.fBadge = h('div', 'abs rname', `<span class="bot-badge">Bot</span><span class="model">${S.model}</span>`, conv);
    R.fCmd = h('div', 'abs cmdcard', `${ic('terminal', 16)}<span>${S.cmds3}</span><span class="chev">${ic('chevron-right', 16)}</span>`, conv);
    R.fWords = h('div', 'abs words', `${S.replyA} <span class="filechip">${ic('image', 12)}<span>poster.png</span></span>`, conv);
    R.fFoot = h('div', 'abs foot', `<span>${ic('terminal', 12)}${S.footA[0]}</span><span class="when">${ic('clock', 12)}${S.footA[1]}<span class="sep">·</span>${S.footA[2]}</span>`, conv);
    R.fWork = h('div', 'abs working', `${face('pudding', 40, true)}<span class="wl"></span>`, conv);
    R.fWorkL = R.fWork.querySelector('.wl');
  }
  {
    const { w, row, conv } = shell('dmwin');
    R.dm = w;
    R.dmRow = row(`<span class="busy">${face('pudding', 48, true)}<i></i></span>`, S.dmName, '', true);
    R.dmPrev = R.dmRow.querySelector('.sp');
    row(groupFace, S.groupName, S.cD, false);
    R.dmHd = h('div', 'conv-hd', `<span class="busy">${face('pudding', 40, true)}<i></i></span><span class="hd2"><b>${S.dmName}</b></span>`, conv);
    R.dmBusy = [...w.querySelectorAll('.busy i')];
    R.where = h('span', 'where', `<span>${S.elsewhere}</span>${ic('chevron-right', 12)}`, R.dmHd.querySelector('.hd2'));
    R.wMine = h('div', 'abs bubble-you', S.askLine, conv);
    R.wReply = h('div', 'abs reply', `${face('pudding', 52, true)}<div><div class="rname"><b>${S.dmName}</b></div><div class="words">${S.goAsk}</div></div>`, conv);
    R.wBack = h('div', 'abs reply', `${face('pudding', 52, true)}<div><div class="rname"><b>${S.dmName}</b></div><div class="words" style="width:640px;white-space:normal">${S.backReply}</div></div>`, conv);
    R.pop = h('div', 'abs pane popup', null, stage);
    css(R.pop, { width: 780 });
    h('div', 'pop-hd', `<span class="gface">${face('pudding', 34, true)}${face('reviewer', 34, true)}</span><b>${S.dmTitle}</b><span class="x">${ic('x', 16)}</span>`, R.pop);
    R.d1 = h('div', 'reply', `${face('pudding', 46, true)}<div><div class="rname"><b>${S.producer}</b></div><div class="words">${S.dm1}</div></div>`, R.pop);
    R.d2 = h('div', 'reply', `${face('reviewer', 46, true)}<div><div class="rname"><b>${S.reviewer}</b></div><div class="words">${S.dm2}</div></div>`, R.pop);
  }

  // ---- 19–24 spend
  R.spend = h('div', 'abs pane spend', null, stage);
  css(R.spend, { width: 1260, height: 680 });
  h('div', 'sp-hd', `<b>${S.spendTitle}</b><span class="tab">${S.overview}</span>`, R.spend);
  const tiles = h('div', 'tiles', null, R.spend);
  R.tiles = S.tiles.map(([k], i) => {
    const el = h('div', `tile${i === 4 ? ' cap' : ''}`, `<span class="tk">${k}</span><span class="tv"></span>${i === 4 ? `<span class="capbar"><i></i></span><span class="tk small">${S.capUsed}</span>` : ''}`, tiles);
    return { el, v: el.querySelector('.tv'), bar: el.querySelector('.capbar i') };
  });
  const mix = h('div', 'mixwrap', `<div class="lab">${S.tokenMix}</div>`, R.spend);
  R.mixBar = h('div', 'mixbar', null, mix);
  R.mixSegs = [22, 46, 24, 8].map((p, i) => { const s = h('i', `s${i}`, null, R.mixBar); s.dataset.p = p; return s; });
  h('div', 'legend', S.mix.map((m, i) => `<span><i class="s${i}"></i>${m}</span>`).join(''), mix);
  const dist = h('div', 'dist', `<div class="lab">${S.dist}</div>`, R.spend);
  R.drows = [[face('pudding', 44, true), S.producer, 58, '$10.68'], [face('reviewer', 44, true), S.reviewer, 31, '$5.71'],
    [gone(S.deletedBot, 44), `${S.deletedBot}<span class="gtag">${S.deletedTag}</span>`, 11, '$2.03']].map(([pic, name, p, v]) =>
    { const r = h('div', 'drow', `${pic}<span class="dn">${name}</span><span class="dbar"><i></i></span><span class="dv">${v}</span><span class="dp">${p}%</span>`, dist); r.dataset.p = p; return r; });

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
  M.bWordW = w(R.bWord); M.bWordH = hh(R.bWord); M.alphaW = w(R.alpha); M.verW = w(R.ver); M.stableW = w(R.stable);
  M.macW = w(R.mac); M.winW = w(R.win);
  M.eraW = {}; for (const s of [S.before, S.now]) { R.era.textContent = s; M.eraW[s] = w(R.era); }
  M.fMineW = w(R.fMine); M.fMineH = hh(R.fMine); M.fTimeW = w(R.fTime); M.wMineW = w(R.wMine);
  M.moreW = R.more.map(w);
  M.wordW = w(R.word); M.wordH = hh(R.word); M.endVerW = w(R.endVer); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
}

// ---------------------------------------------------------------- headlines (one slot, top left)
const HEADS = { flow: [4.05, 9.85], focus: [10.05, 13.85], where: [14.05, 18.85], spend: [19.05, 23.85], more: [24.05, 26.25] };
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
  // focus mode quiets the room a little while the song breaks down
  R.dim.style.opacity = (0.22 * E.smooth(inv(11.0, 11.6, t)) * (1 - E.smooth(inv(13.4, 13.9, t)))).toFixed(3);
}

// ---------------------------------------------------------------- pointer
const CLICKS = [{ at: 11.0, from: [1500, 1060], el: () => R.target }, { at: 15.0, from: [1300, 1060], el: () => R.where }];
function posePointer(t) {
  let p = null, click = null;
  for (const c of CLICKS) {
    if (t > c.at - 0.55 && t < c.at + 0.6) {
      const r = c.el().getBoundingClientRect(), tx = r.left + Math.min(r.width / 2, 60), ty = r.top + r.height / 2;
      const u = E.out4(inv(c.at - 0.5, c.at - 0.12, t));
      p = { x: lerp(c.from[0], tx - 6, u), y: lerp(c.from[1], ty - 4, u) + (t > c.at - 0.02 && t < c.at + 0.07 ? 3 : 0), o: Math.min(E.out(inv(c.at - 0.55, c.at - 0.4, t)), 1 - E.in(inv(c.at + 0.35, c.at + 0.6, t))) };
      click = { at: c.at, x: tx, y: ty };
    }
  }
  if (p) css(R.pointer, { x: p.x, y: p.y, opacity: p.o }); else R.pointer.style.opacity = 0;
  if (click && t >= click.at && t < click.at + 0.45) {
    const u = inv(click.at, click.at + 0.45, t);
    css(R.ripple, { x: click.x, y: click.y, s: lerp(0.25, 1.25, E.out(u)), opacity: 0.7 * (1 - u) });
  } else R.ripple.style.opacity = 0;
}

// ---------------------------------------------------------------- 0–4 · Alpha comes off, 0.1.0 goes on
function poseRelease(t) {
  const { mochi, pudding } = R.cast;
  const on = t < 4.1;
  show(R.badge, on); show(R.mac, on && t >= 2.45); show(R.win, on && t >= 2.65);
  // a child shown on its own stays visible under a hidden parent: hide each
  if (!on) { [R.alpha, R.ver, R.stable].forEach(e => show(e, false)); return; }
  const ex = E.in(inv(3.7, 4.05, t));
  const tagW = Math.max(M.alphaW, M.verW + 24 + M.stableW);
  const total = 200 + 44 + M.bWordW + 40 + tagW, left = (1920 - total) / 2, cy = 420;
  const ent = E.pop(inv(0.35, 0.75, t));
  R.badge.style.transformOrigin = '960px 420px';
  css(R.badge, { x: 0, y: -40 * ex, s: lerp(0.85, 1, ent) * (1 - 0.05 * ex), opacity: clamp(inv(0.35, 0.5, t)) * (1 - ex) });
  css(R.bMark, { x: left, y: cy - 100 });
  css(R.bWord, { x: left + 244, y: cy - M.bWordH / 2 - 8 });
  const tx = left + 244 + M.bWordW + 40;
  // Alpha shakes loose on the 2.0 downbeat and falls off; the version lands in its place
  if (show(R.alpha, t < 2.7)) {
    const shake = t > 1.55 && t < 1.98 ? Math.sin((t - 1.55) * 60) * 4 * inv(1.55, 1.95, t) : 0;
    const f = inv(1.98, 2.65, t);
    R.alpha.style.transformOrigin = '20% 50%';
    css(R.alpha, { x: tx, y: cy - 40 + 700 * f * f, r: shake + 38 * E.out(f), opacity: clamp(inv(0.6, 0.8, t)) * (1 - E.in(inv(2.3, 2.65, t))) });
  }
  if (show(R.ver, t >= 2.0)) {
    const u = E.pop(inv(2.0, 2.3, t));
    R.ver.style.transformOrigin = '0 50%';
    css(R.ver, { x: tx, y: cy - 62, s: lerp(1.5, 1, u), opacity: clamp(inv(2.0, 2.08, t)) });
  }
  if (show(R.stable, t >= 2.15)) {
    const u = E.pop(inv(2.15, 2.45, t));
    R.stable.style.transformOrigin = '0 50%';
    css(R.stable, { x: tx + M.verW + 24, y: cy - 30, s: lerp(0.6, 1, u), opacity: clamp(inv(2.15, 2.25, t)) });
  }
  const gap = 28, rowW = M.macW + gap + M.winW, rx = (1920 - rowW) / 2;
  const chip = (el, a, x) => { const u = E.pop(inv(a, a + 0.32, t)); el.style.transformOrigin = '50% 50%'; css(el, { x, y: 590 + lerp(24, 0, E.out(inv(a, a + 0.3, t))) - 40 * ex, s: lerp(0.85, 1, u), opacity: clamp(inv(a, a + 0.15, t)) * (1 - ex) }); };
  chip(R.mac, 2.45, rx); chip(R.win, 2.65, rx + M.macW + gap);
  // Mochi and Pudding come to see it, and cheer when it lands
  if (t < 4.2) {
    const s = seq(t, [[0, 'hop'], [0.72, 'idle', true], [2.0, 'cheer'], [3.43, 'hop']]);
    const x = t < 3.43 ? hopX(t, 0, -180, 300) : hopX(t, 3.43, 300, -260);
    mochi.pose({ ...s, x, s: 420, flip: t >= 3.43 });
  }
  const sp = seq(t, [[0.3, 'hop'], [1.02, 'idle', true], [2.05, 'cheer'], [3.48, 'idle', true]]);
  if (t >= 0.3) pudding.pose({ ...sp, x: hopX(t, 0.3, 2150, 1660), s: 440, flip: true });
}

// ---------------------------------------------------------------- 4–10 · the flow shows first what needs a look
function poseFlow(t) {
  const { pudding } = R.cast;
  if (t >= 4.0 && t < 10.0) {
    const s = seq(t, [[4.0, 'idle', true], [6.6, 'present'], [7.5, 'idle', true], [9.3, 'hop']]);
    pudding.pose({ ...s, x: t < 9.3 ? 1660 : hopX(t, 9.3, 1660, 2150), s: 440, flip: true });
  }
  const on = panel(R.board, t, 4.15, 9.95, 120, 280);
  if (!on) { show(R.era, false); return; }
  // at 6.0 the board turns into today's: done goes quiet, the readings of a Bot's words fold away
  const u = E.inOut(inv(6.0, 6.7, t)), fade = E.out(inv(6.0, 6.35, t));
  const pos = {};
  CARDS.forEach(([key, kind, col, r0, r1, , st0, st1], i) => {
    const c = R.cards[key];
    const rr = r1 === null ? r0 : lerp(r0, r1, u);
    const y = ROW0 + rr * PITCH, x = COLX[col];
    pos[key] = { x, y };
    const enter = E.out4(inv(4.4 + i * 0.07, 4.75 + i * 0.07, t));
    let o = enter, sy = 1;
    if (r1 === null) { o *= 1 - fade; sy = lerp(1, 0.4, fade); }
    c.el.style.transformOrigin = '50% 50%';
    css(c.el, { x, y: y + lerp(16, 0, enter), sy, opacity: o });
    const a = COL[st0], b = COL[st1];
    const [edge, stripe, fill, ink] = a.map((v, j) => mixC(v, b[j], fade));
    c.edge.style.background = kind === 'turn' ? `linear-gradient(90deg, ${stripe} 0 6px, ${edge} 6px)` : edge;
    c.fill.style.background = fill;
    c.body.style.color = ink;
    // the status word: the old board said 「完成」 in green; today a finished card says nothing
    const word = st0 === 'done-old' ? S.doneWord : '';
    if (word) { c.st.textContent = word; c.st.style.color = '#15803d'; c.st.style.opacity = (1 - fade).toFixed(3); }
    // the cards that need a look pulse once the board is today's
    const pulse = (st1 === 'bad' || st1 === 'wait') && t > 7.0 && t < 8.6 ? 0.5 - 0.5 * Math.cos((t - 7.0) * Math.PI * 2 / 0.8) : 0;
    c.el.style.filter = pulse > 0.01 ? `drop-shadow(0 0 ${(10 * pulse).toFixed(1)}px ${st1 === 'bad' ? 'rgba(220,38,38,.55)' : 'rgba(217,119,6,.55)'})` : 'none';
    const m = R.miniCards[key];
    css(m, { x: x * 0.18 + 12, y: y * 0.18 + 8, opacity: r1 === null ? 1 - fade : 1 });
    m.style.background = st1 === 'done' || st1 === 'none' ? mixC(a[0] === '#bbf7d0' ? '#16a34a' : '#c9d3d6', '#c9d3d6', fade) : b[1];
  });
  EDGES.forEach(([p, c], i) => {
    const a = pos[p], b = pos[c];
    const x1 = a.x + CW / 2, y1 = a.y + CH, x2 = b.x + CW / 2, y2 = b.y, my = (y1 + y2) / 2;
    R.edgePaths[i].setAttribute('d', x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}V${my}H${x2}V${y2}`);
  });
  R.edges.style.opacity = E.out(inv(4.5, 5.0, t)).toFixed(3);
  // today's toolbar: the toggle that draws them all again, and the count of steps that went wrong
  R.tools.style.opacity = E.out(inv(6.5, 6.9, t)).toFixed(3);
  const ring = t > 7.0 && t < 8.6 ? 0.5 - 0.5 * Math.cos((t - 7.0) * Math.PI * 2 / 0.8) : 0;
  R.anom.style.boxShadow = `0 0 0 ${(6 * ring).toFixed(1)}px rgba(220,38,38,.18)`;
  // 「0.1.0 之前」 above the board, stamped 「现在」 on the turn
  if (show(R.era, t >= 4.5 && t < 9.95)) {
    const now = t >= 6.0, txt = now ? S.now : S.before;
    if (R.era.textContent !== txt) R.era.textContent = txt;
    R.era.classList.toggle('now', now);
    const u0 = E.pop(inv(now ? 6.0 : 4.5, (now ? 6.0 : 4.5) + 0.3, t)), o = E.in(inv(9.6, 9.9, t));
    R.era.style.transformOrigin = '50% 50%';
    css(R.era, { x: 1420 - M.eraW[txt], y: 222, s: lerp(1.4, 1, u0), r: -4, opacity: clamp(u0 * 2) * (1 - o) });
  }
}

// ---------------------------------------------------------------- 10–14 · focus mode
function poseFocus(t) {
  const { mochi } = R.cast;
  if (t >= 9.9 && t < 14.4) {
    const s = seq(t, [[9.9, 'hop'], [10.45, 'point'], [11.2, 'idle', true], [12.2, 'nod'], [12.9, 'idle', true], [13.65, 'hop']]);
    const x = t < 13.65 ? hopX(t, 9.9, 2150, 1580) : hopX(t, 13.65, 1580, 1440);
    mochi.pose({ ...s, x, s: 430, flip: true });
  }
  if (!panel(R.chat, t, 10.0, 14.0, 120, 280)) return;
  // the toggle beside Deskfolk, pressed on 11.0
  const onF = t >= 11.02;
  R.target.classList.toggle('on', onF);
  css(R.target, { s: t > 10.98 && t < 11.1 ? 0.9 : 1 });
  // what focus mode leaves out fades, and the conversation closes up
  const u = E.inOut(inv(11.2, 11.95, t));
  const gone = (el, k) => { el.style.opacity = (1 - E.out(inv(11.08 + k * 0.08, 11.4 + k * 0.08, t))).toFixed(3); };
  const X0 = 40, XR = 840;
  css(R.fMine, { x: XR - M.fMineW, y: 96 });
  css(R.fTime, { x: XR - M.fTimeW, y: 96 + M.fMineH + 8 }); gone(R.fTime, 0);
  const ry = lerp(250, 200, u);
  css(R.fFace, { x: X0, y: ry });
  css(R.fName, { x: X0 + 70, y: ry + 4 });
  css(R.fBadge, { x: X0 + 70 + (LANG === 'zh' ? 76 : 130), y: ry + 4 }); gone(R.fBadge, 1);
  css(R.fCmd, { x: X0 + 70, y: ry + 52 }); gone(R.fCmd, 2);
  css(R.fWords, { x: X0 + 70, y: ry + lerp(132, 52, u) });
  css(R.fFoot, { x: X0 + 70, y: ry + 196 }); gone(R.fFoot, 3);
  // the Bot at work: its step and timer, or in focus mode just 「思考中」
  css(R.fWork, { x: X0, y: lerp(500, 380, u) });
  const dots = '<span class="dots">' + [0, 1, 2].map(i => `<i style="opacity:${(0.35 + 0.65 * Math.max(0, Math.sin(t * 6 - i * 0.9))).toFixed(2)}"></i>`).join('') + '</span>';
  setHTML(R.fWorkL, onF && t > 11.3 ? `<span>${S.thinking}</span>${dots}` : `${spinner(30, t)}<span>${S.working}</span><span class="timer">${S.workingTimer.replace('42', String(42 + Math.floor(clamp(t - 10, 0, 4))))}</span>`);
}

// ---------------------------------------------------------------- 14–19 · where a Bot is busy
function poseWhere(t) {
  const { mochi, pudding, reviewer } = R.cast;
  if (t >= 14.4 && t < 19.5) {
    const s = seq(t, [[14.4, 'idle', true], [17.7, 'nod'], [18.4, 'idle', true], [18.95, 'hop']]);
    mochi.pose({ ...s, x: t < 18.95 ? 1440 : hopX(t, 18.95, 1440, 1600), s: 430, flip: true });
  }
  if (t >= 15.15 && t < 19.4) {
    const s = seq(t, [[15.15, 'hop'], [15.87, 'talk', true], [16.95, 'idle', true], [17.15, 'hop'], [17.87, 'nod'], [18.6, 'idle', true]]);
    const x = t < 17.15 ? hopX(t, 15.15, 2150, 1680) : hopX(t, 17.15, 1680, 1690);
    pudding.pose({ ...s, x, s: 380, flip: true, o: 1 - E.in(inv(18.75, 19.05, t)) });
  }
  if (t >= 15.35 && t < 17.9) {
    const s = seq(t, [[15.35, 'hop'], [16.07, 'think', true], [17.2, 'hop']]);
    const x = t < 17.2 ? hopX(t, 15.35, 2150, 1850) : hopX(t, 17.2, 1850, 2200);
    reviewer.pose({ ...s, x, s: 360, flip: t < 17.2 });
  }
  const on = panel(R.dm, t, 13.95, 19.0, 120, 280);
  if (!on) { show(R.pop, false); show(R.wBack, false); return; }
  const busy = t < 17.25;
  // the header and the list row say where it is, from the 14.0 downbeat; quiet again once it has reported back
  const wi = E.pop(inv(14.05, 14.4, t)), wo = E.in(inv(17.1, 17.3, t));
  R.where.style.transformOrigin = '0 50%';
  css(R.where, { s: lerp(0.8, 1, wi), opacity: clamp(wi * 2) * (1 - wo) });
  R.where.style.boxShadow = t > 14.3 && t < 15.0 ? `0 0 0 ${(5 * Math.sin(inv(14.3, 15.0, t) * Math.PI)).toFixed(1)}px rgba(20,106,124,.18)` : 'none';
  R.dmBusy.forEach(d => { d.style.background = busy ? 'var(--accent)' : '#95a2a8'; });
  setHTML(R.dmPrev, t < 14.05 ? S.goAsk : busy ? `<span style="color:var(--accent)">${S.elsewhere}</span>` : S.backReply);
  css(R.wMine, { x: 840 - M.wMineW, y: 96 });
  css(R.wReply, { x: 40, y: 230 });
  if (show(R.wBack, t >= 17.35)) { const u = E.out4(inv(17.35, 17.7, t)); css(R.wBack, { x: 40, y: 360 + lerp(24, 0, u), opacity: u }); }
  // the direct opens in its popup over the window
  if (show(R.pop, t >= 15.1 && t < 17.25)) {
    const u = E.pop(inv(15.1, 15.42, t)), o = E.in(inv(16.95, 17.2, t));
    R.pop.style.transformOrigin = '50% 30%';
    css(R.pop, { x: 340, y: 360, s: lerp(0.9, 1, u) * (1 - 0.06 * o), opacity: clamp(inv(15.1, 15.22, t)) * (1 - o) });
    rise(R.d1, t, 15.45); rise(R.d2, t, 16.05);
  }
}

// ---------------------------------------------------------------- 19–24 · the spend page as a dashboard
function poseSpend(t) {
  const { mochi, pudding } = R.cast;
  if (t >= 19.5 && t < 24.2) {
    const s = seq(t, [[19.5, 'idle', true], [21.3, 'nod'], [22.0, 'idle', true], [23.55, 'hop']]);
    mochi.pose({ ...s, x: t < 23.55 ? 1600 : hopX(t, 23.55, 1600, 760), s: 430, flip: t < 23.55 });
  }
  if (t >= 21.6 && t < 24.2) {
    const s = seq(t, [[21.6, 'hop'], [22.32, 'present'], [23.25, 'idle', true], [23.62, 'hop']]);
    const x = t < 23.62 ? hopX(t, 21.6, 2150, 1820) : hopX(t, 23.62, 1820, 960);
    pudding.pose({ ...s, x, s: 380, flip: true });
  }
  if (!panel(R.spend, t, 19.0, 24.0, 120, 280)) return;
  const n = E.out(inv(19.35, 20.4, t));
  const fmt = [v => `$${(18.42 * v).toFixed(2)}`, v => Math.round(1286 * v).toLocaleString('en-US'), v => `${(42.6 * v).toFixed(1)}M`, v => `${Math.round(68 * v)}%`, () => '$30'];
  R.tiles.forEach((tl, i) => {
    rise(tl.el, t, 19.25 + i * 0.07, { pop: true });
    tl.v.textContent = fmt[i](n);
    if (tl.bar) tl.bar.style.width = `${(61 * n).toFixed(1)}%`;
  });
  let acc = 0;
  const grow = E.inOut(inv(20.2, 20.9, t));
  R.mixSegs.forEach(s => { const p = +s.dataset.p; s.style.width = `${(p * grow).toFixed(2)}%`; acc += p; });
  R.drows.forEach((r, i) => {
    rise(r, t, 20.7 + i * 0.15);
    r.querySelector('.dbar i').style.width = `${(+r.dataset.p / 58 * 100 * E.out4(inv(20.85 + i * 0.15, 21.5 + i * 0.15, t))).toFixed(1)}%`;
  });
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
    const s = seq(t, [[24.0, 'hop'], [24.72, 'idle', true], [25.3, 'cheer']]);
    reviewer.pose({ ...s, x: hopX(t, 24.0, 2150, 1160), s: 340, flip: true, o: 1 - E.in(inv(26.3, 26.6, t)) });
  }
  // Mochi and Pudding arrived at 23.6; they cheer here, and go on to the mark
  if (t >= 24.2 && t < 26.45) {
    R.cast.mochi.pose({ ...seq(t, [[24.2, 'idle', true], [25.3, 'cheer']]), x: 760, s: 430 });
    R.cast.pudding.pose({ ...seq(t, [[24.2, 'idle', true], [25.42, 'cheer']]), x: 960, s: 380, flip: true });
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
  poseFlow(t);
  poseFocus(t);
  poseWhere(t);
  poseSpend(t);
  poseMore(t);
  poseEnd(t);
  for (const k in R.cast) show(R.cast[k].el, R.cast[k].on);
  poseHeads(t);
  posePointer(t);
  await Promise.all(pending);
}

// ---------------------------------------------------------------- sound cues: name, film time, what it marks
const CUES = [
  ['whoosh', 0.05, 'Mochi hops in'], ['whoosh', 0.35, 'Pudding hops in'], ['pop', 0.4, 'the name'], ['tick', 0.65, 'Alpha'],
  ['reject', 1.98, 'Alpha falls off'], ['done', 2.0, '0.1.0 lands'], ['pop', 2.15, 'stable'], ['tick', 2.45, 'macOS'], ['tick', 2.65, 'Windows'],
  ['whoosh', 4.15, 'the flow'], ['pop', 4.5, 'before 0.1.0'], ['pass', 6.0, 'today’s board'], ['swish', 6.05, 'readings fold away'], ['pop', 6.55, 'toolbar'], ['fail', 7.0, 'what needs a look'],
  ['whoosh', 9.3, 'Pudding leaves'], ['whoosh', 9.95, 'Mochi, the window'], ['click', 11.0, 'focus mode on'], ['swish', 11.15, 'the chrome folds away'],
  ['pop', 12.2, 'nod'], ['whoosh', 13.95, 'the next window'], ['pop', 14.05, 'where it is busy'], ['click', 15.0, 'open it'], ['pop', 15.1, 'the direct'],
  ['tick', 15.45, 'line'], ['tick', 16.05, 'line'], ['swish', 16.95, 'the popup closes'], ['check', 17.35, 'reported back'],
  ['whoosh', 19.0, 'spend'], ['tick', 19.25, 'tile'], ['tick', 19.32, 'tile'], ['tick', 19.39, 'tile'], ['tick', 19.46, 'tile'], ['tick', 19.53, 'tile'], ['pop', 20.2, 'token mix'],
  ['tick', 20.7, 'row'], ['tick', 20.85, 'row'], ['tick', 21.0, 'row'], ['whoosh', 21.6, 'Pudding'],
  ['whoosh', 24.0, 'and more'], ['tick', 24.15, 'chip'], ['tick', 24.31, 'chip'], ['tick', 24.47, 'chip'], ['tick', 24.63, 'chip'], ['tick', 24.79, 'chip'], ['tick', 24.95, 'chip'], ['pop', 25.3, 'cheer'],
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
