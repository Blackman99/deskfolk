// The Deskfolk reel: the mascots act out the product while the app's own surfaces, redrawn, show what it does.
// film.seek(t) poses everything from t alone and resolves once the sprites it chose have decoded.
// Timeline (120 BPM, a bar every 2 s): 0 hand it off · 2 tickets, who makes and who reviews · 6 it asks before
// leaving the workspace · 10 you walk away, the app watches the render · 13 a stop, then your next line
// (the music stops 14–16) · 17 done has a definition: your checks, sent back once, the Reviewer with evidence ·
// 23 come back to results · 26.5 the mark, the URL on the song's final hit (28.0).
import { clamp, lerp, inv, E, typed, caretOn, css, h } from '/launch/lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const DURATION = 30.5;
const FPS = 30;
const GY = 905; // the ground line the cast stands on
let SP = null; // sprites.json: frames per move, and where the feet are in a frame

// ---------------------------------------------------------------- icons
const I = {
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4.2 4.2L18.5 7.8"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pointer: '<svg viewBox="0 0 22 30" width="44" height="60"><path d="M2.5 2.2v21.6l5.6-5.5 3.6 8.7 3.6-1.5-3.5-8.6h7.8z" fill="#111" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/></svg>'
};
function markSVG(size, opts = {}) {
  const b = opts.bubble || '#146a7c', f = opts.front || '#ffffff', m = opts.mustard || '#f0ab3d';
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64"><path d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z" fill="${b}"/>` +
    `<circle class="mf" cx="25" cy="29" r="10.5" fill="${f}"/><circle class="mm" cx="39.5" cy="29" r="10.5" fill="${m}" stroke="${b}" stroke-width="3"/></svg>`;
}
const spinner = (size, t) => `<svg class="spin" width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--accent-b)" stroke-width="2.6"/><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" transform="rotate(${((t * 540) % 360).toFixed(0)} 12 12)"/></svg>`;
const icon = (kind, size) => `<span style="width:${size}px;height:${size}px;display:inline-flex;border-radius:50%;padding:${Math.round(size * 0.18)}px;background:${kind === 'ok' ? 'var(--ok)' : 'var(--danger)'};color:#fff">${kind === 'ok' ? I.check : I.x}</span>`;
// a mascot's face, cropped from its first idle frame, for the app's avatars
const face = (who, size) => `<span class="face" style="width:${size}px;height:${size}px;background-image:url(/sprites/${who}/idle/0001.png);background-size:${size * 2.15}px;background-position:50% 64%"></span>`;
const kettle = n => `/assets/kettle/${String(clamp(n, 1, 181)).padStart(4, '0')}.jpg`;
const setHTML = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };

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
  /** One frame of a move, standing on (x, y) by its feet, `air` px above that ground; `at` is seconds into the move. */
  pose({ clip, at, x, y = GY, air = 0, s = 460, flip = false, o = 1, gray = 0, loop = false, hold = null }) {
    this.on = true;
    const n = SP[this.who][clip];
    let f = Math.floor((hold ?? at) * FPS + 1e-6);
    f = loop ? ((f % n) + n) % n : clamp(f, 0, n - 1);
    const src = `/sprites/${this.who}/${clip}/${String(f + 1).padStart(4, '0')}.png`;
    if (this.img.getAttribute('src') !== src) {
      this.img.setAttribute('src', src);
      pending.push(this.img.decode().catch(() => {}));
    }
    css(this.el, { x: x - s / 2, y: y - air - SP.feetY * s, width: s, height: s, opacity: o });
    this.img.style.transform = flip ? 'scaleX(-1)' : 'none';
    this.img.style.filter = gray > 0.01 ? `grayscale(${gray.toFixed(2)}) brightness(${(1 - 0.08 * gray).toFixed(3)})` : 'none';
    // the shadow stays on the ground, smaller and fainter the higher the mascot is
    const k = clamp(1 - air / 700, 0.2, 1), sw = s * 0.4 * k;
    css(this.shadow, { left: (s - sw) / 2, top: SP.feetY * s - s * 0.035 * k + air, width: sw, height: s * 0.07 * k, opacity: 0.9 * k });
  }
}
/** The move playing at t from a list of [start, clip, loop?]; a move that ends holds its last frame (rest). */
function seq(t, list) {
  let cur = list[0];
  for (const it of list) if (t >= it[0]) cur = it;
  return { clip: cur[1], at: t - cur[0], loop: !!cur[2] };
}
/** A hop's travel: still during the crouch, across while airborne, still on landing (sprites.py's hop). */
const hopX = (t, t0, a, b) => lerp(a, b, E.inOut(inv(t0 + 0.08, t0 + 0.44, t)));

// ---------------------------------------------------------------- DOM
const R = {};
function build() {
  R.dusk = document.getElementById('dusk'); R.moon = document.getElementById('moon');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };

  // composer, and your lines once sent
  R.comp = h('div', 'abs composer', null, stage);
  h('span', 'clip', I.clip, R.comp);
  R.compTxt = h('span', 'txt', '', R.comp);
  R.compSend = h('span', 'send', I.send, R.comp);
  R.bubble = h('div', 'abs bubble-you', S.request, stage);
  R.stopB = h('div', 'abs bubble-you', S.stopLine, stage);
  R.changeB = h('div', 'abs bubble-you', S.changeLine, stage);

  // the job: title row and two ticket rows
  R.job = h('div', 'abs pane', null, stage);
  css(R.job, { width: 1080, height: 560, overflow: 'hidden' });
  const jh = h('div', 'job-head', null, R.job);
  R.jobTitle = h('div', 'job-title', S.job, jh);
  h('div', 'job-sub', `<span class="pill run">${S.running}</span><span class="pill quiet">${S.engine}</span>`, jh);
  h('div', 'abs', `<span style="color:var(--accent);display:inline-flex;font-size:30px">${I.ticket}</span><b style="font-size:28px">${S.tickets}</b>`, R.job).setAttribute('style', 'left:40px;top:182px;display:flex;align-items:center;gap:12px');
  R.rows = [['01', S.t1], ['02', S.t2]].map(([no, ti], i) => {
    const [name, file] = ti.split(' ');
    const r = h('div', 'trow', `<span class="no">${no}</span><span class="ti">${name}<span class="f">${file}</span></span>` +
      `<span class="who">${face('pudding', 46)}<span>${S.producer} ${S.makes}</span><span class="rv" style="display:inline-flex;align-items:center;gap:10px;margin-left:14px">${face('reviewer', 46)}<span>${S.reviewer} ${S.reviews}</span></span></span>` +
      `<span class="stt"><i style="background:#95a2a8"></i><span style="color:var(--muted)">${LANG === 'zh' ? '待做' : 'To do'}</span></span>`, R.job);
    css(r, { top: 240 + i * 140 });
    return r;
  });

  // the workspace, and the folder outside it
  R.ws = h('div', 'abs ws', `<span class="ws-lab">${S.workspace}</span>`, stage);
  css(R.ws, { width: 1040, height: 640 });
  R.folder = h('div', 'abs folder', `<div class="path">${S.outside}</div><div class="logo" style="margin-top:16px"><span class="sun"></span><span><b>DAWN</b><br><span>${LANG === 'zh' ? '晨光' : 'kettles'}</span></span></span></div>`, stage);
  R.logoFly = h('div', 'abs folder', `<div class="logo"><span class="sun"></span><b>DAWN</b></div>`, stage);
  css(R.logoFly, { padding: '14px 18px' });
  R.intent = h('div', 'abs', null, stage);
  css(R.intent, { height: 0, borderTop: '5px dashed var(--warn)' });
  R.appr = h('div', 'abs approval', null, stage);
  R.apprLab = h('div', 'lab', '', R.appr);
  h('div', 'tgt', `<span style="color:var(--muted)">unconstrained-shell</span> ${S.approvalCmd}`, R.appr);
  const bt = h('div', 'btns', null, R.appr); R.apprBtns = bt;
  R.bAllow = h('span', 'btn primary', S.allowOnce, bt);
  h('span', 'btn', S.always, bt);
  h('span', 'btn danger', S.deny, bt);

  // the render the app watches
  R.render = h('div', 'abs render', null, stage);
  css(R.render, { width: 700 });
  R.renderHd = h('div', 'hd', '', R.render);
  R.renderBar = h('i', null, null, h('div', 'bar', null, R.render));
  R.renderNote = h('div', null, `${S.noTurn} · ${S.supervisor}`, R.render);
  css(R.renderNote, { marginTop: '16px', fontSize: 22, color: 'var(--muted)', whiteSpace: 'nowrap' });
  R.polls = S.polls.map(p => h('div', 'abs poll', `${markSVG(34)}${p}`, stage));
  R.wake = h('div', 'abs poll', `${markSVG(34)}${S.woke}`, stage);

  // the stop
  R.hold = h('div', 'abs hold', null, stage);
  css(R.hold, { width: 560, height: 470 });
  R.holdIcon = h('div', 'abs over', I.pause, stage);
  css(R.holdIcon, { width: 120, height: 120, color: 'var(--accent)' });
  R.receipt = h('div', 'abs appline', `${markSVG(54)}<div><div class="who" style="font-size:30px">${S.stopped}</div><div style="font-size:24px;color:var(--muted)">${S.stoppedSub}</div></div>`, stage);
  R.lifted = h('div', 'abs stamp', S.lifted, stage);
  css(R.lifted, { color: 'var(--ok-text)', borderColor: 'var(--ok)', background: 'var(--ok-bg)' });
  R.goesOn = h('div', 'abs appline over', `${markSVG(40)}<span class="who">${S.goesOn}</span>`, stage);

  // done has a definition
  R.say = h('div', 'abs say', S.claim, stage);
  R.chip = h('div', 'abs filechip', '', stage);
  R.checks = h('div', 'abs checks', null, stage);
  css(R.checks, { width: 790 });
  R.checksHd = h('div', 'hd', `<span>${S.checksTitle}</span><span class="pill quiet" style="font-size:20px">${S.confirmed}</span><span class="sum"></span>`, R.checks);
  R.sum = R.checksHd.querySelector('.sum');
  R.crows = [S.c1, S.c2].map(c => h('div', 'crow', `<span class="ic"></span><span>${c}</span><span class="val"></span>`, R.checks));
  R.back = h('div', 'abs stamp', S.back, stage);
  css(R.back, { color: 'var(--danger-text)', borderColor: 'var(--danger)', background: 'var(--danger-bg)' });
  R.review = h('div', 'abs pane', null, stage);
  css(R.review, { width: 790, padding: '24px 30px' });
  h('div', null, `${face('reviewer', 44)}<b style="font-size:28px">${S.review}</b>`, R.review).setAttribute('style', 'display:flex;align-items:center;gap:14px');
  const strip = h('div', 'strip', [[30, '1.0s'], [120, '4.0s'], [165, '5.5s']].map(([n, l]) => `<span class="fr" style="width:116px;height:206px;background-image:url(${kettle(n)})"><b>${l}</b></span>`).join(''), R.review);
  css(strip, { marginTop: '18px' });
  R.evs = [S.ev1, S.ev2].map(e => h('div', 'abs ev', `<span style="width:22px;height:22px;display:inline-block;flex:none">${I.check}</span><span>${e}</span>`, R.review));
  R.evs.forEach(e => css(e, { width: 340, whiteSpace: 'normal', alignItems: 'flex-start' }));
  R.verdict = h('div', 'abs appline', `<span style="width:42px;height:42px;display:inline-flex;border-radius:50%;padding:8px;background:var(--ok);color:#fff">${I.check}</span><span class="who" style="color:var(--ok-text)">${S.verdict}</span>`, stage);

  // coming back: the conversation, the film and the board in one window
  R.win = h('div', 'abs', null, stage);
  css(R.win, { width: 1300, height: 720 });
  R.winTabs = h('div', 'abs', `<span class="win-tab">${face('pudding', 26)}${S.tabChat}</span><span class="win-tab">${S.tabFilm}</span><span class="win-tab" style="color:var(--accent)">${S.tabFlow}</span>`, R.win);
  css(R.winTabs, { left: 24, top: 0, display: 'flex', gap: '8px' });
  R.winBody = h('div', 'abs pane', null, R.win);
  css(R.winBody, { top: 46, width: 1300, height: 674, borderRadius: '0 22px 22px 22px', overflow: 'hidden' });
  R.ask = h('div', 'abs bubble-you', S.statusLine, R.winBody);
  css(R.ask, { fontSize: 28, padding: '16px 24px' });
  R.answer = h('div', 'abs', `<div style="display:flex;align-items:center;gap:12px;font-size:24px">${face('pudding', 44)}<b>${S.producer}</b><span class="pill quiet" style="font-size:17px;padding:1px 10px">Bot</span></div><div style="margin-top:10px;font-size:27px;line-height:1.45;width:560px;white-space:normal">${S.answer}</div>`, R.winBody);
  R.film = h('div', 'abs', '<img style="width:100%;height:100%;object-fit:cover;border-radius:16px;display:block">', R.winBody);
  css(R.film, { width: 270, height: 480, borderRadius: '16px', boxShadow: '0 20px 50px -24px rgba(18,28,32,.5)' });
  R.filmImg = R.film.querySelector('img');
  R.filmPlay = h('div', 'abs', `<span style="width:30px;height:30px;display:inline-block;color:#fff">${I.play}</span>`, R.film);
  css(R.filmPlay, { left: 12, bottom: 12, top: 'auto', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(15,26,30,.55)', borderRadius: '10px', padding: '6px 10px' });
  R.status = h('div', 'abs', `<div class="pill done" style="font-size:24px"><span style="width:20px;height:20px;display:inline-block">${I.check}</span>${S.done}</div><div class="pill quiet" style="margin-top:14px;font-size:22px">${S.engine}</div><div style="margin-top:18px;font-size:23px;line-height:1.35;color:var(--ok-text);font-weight:650;white-space:normal;width:280px">${S.checksTitle} 2/2</div><div style="margin-top:8px;font-size:23px;line-height:1.35;color:var(--ok-text);font-weight:650;white-space:normal;width:280px">${S.verdict}</div>`, R.winBody);
  R.cols = S.col.map((c, i) => {
    const col = h('div', 'col', `<div class="ct">${c} ${i === 3 ? 2 : 0}</div>`, R.winBody);
    css(col, { left: 30 + i * 312, top: 560, width: 296, height: 140 });
    return col;
  });
  R.kcards = [S.t1, S.t2].map((ti, i) => h('div', 'kcard', `<b>0${i + 1} ${ti.split(' ')[0]}</b><span style="color:var(--ok-text);font-weight:650">✓ ${S.passed}</span>`, R.cols[3]));

  // headlines
  R.heads = {};
  for (const k in S.h) R.heads[k] = h('div', `headline ${LANG}`, S.h[k], stage);
  R.subDone = h('div', 'subline', S.sub.done, stage);

  // the mark and the end card
  R.markG = h('div', 'abs', markSVG(360), stage);
  css(R.markG, { width: 360, height: 360 }); R.markG.style.transformOrigin = '180px 180px';
  R.mf = R.markG.querySelector('.mf'); R.mm = R.markG.querySelector('.mm');
  R.end = h('div', 'abs', null, stage); css(R.end, { width: 1920, height: 1080 }); R.end.style.transformOrigin = '960px 540px';
  R.word = h('div', 'abs word', [...S.word].map(c => `<span class="ch" style="display:inline-block">${c}</span>`).join(''), R.end);
  R.tag = h('div', 'abs tagline', S.tagline, R.end);
  R.ctaRow = h('div', 'abs', `<span class="cta"><span style="width:38px;height:38px;transform:rotate(180deg);display:inline-block">${I.send}</span>${S.cta}</span><span class="url">${S.url}</span>`, R.end);
  css(R.ctaRow, { display: 'flex', alignItems: 'center', gap: '36px' });
  R.fine = h('div', 'abs fine', S.fine, R.end);
  R.finer = h('div', 'abs finer', S.finer, R.end);

  R.names = { pudding: h('div', 'abs tag-name', S.producer, stage), reviewer: h('div', 'abs tag-name', S.reviewer, stage), mochi: h('div', 'abs tag-name', S.youName, stage) };
  R.pointer = h('div', null, I.pointer, stage); R.pointer.id = 'pointer';
  R.ripple = h('div', null, null, stage); R.ripple.id = 'ripple';
}

const M = {};
function measure() {
  const w = el => el.getBoundingClientRect().width, hh = el => el.getBoundingClientRect().height;
  M.bubW = w(R.bubble); M.bubH = hh(R.bubble);
  M.stopW = w(R.stopB); M.changeW = w(R.changeB);
  M.apprW = w(R.appr); M.apprH = hh(R.appr);
  M.receiptW = w(R.receipt); M.goesOnW = w(R.goesOn); M.liftedW = w(R.lifted); M.backW = w(R.back);
  M.verdictW = w(R.verdict); M.sayW = w(R.say);
  M.pollW = R.polls.map(w); M.wakeW = w(R.wake);
  M.wordW = w(R.word); M.wordH = hh(R.word); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
  M.nameW = {}; for (const k in R.names) M.nameW[k] = w(R.names[k]);
  M.askW = w(R.ask);
}

// ---------------------------------------------------------------- helpers
const show = (el, on) => { el.style.visibility = on ? 'visible' : 'hidden'; return on; };
/** Enters with a small overshoot at a, leaves by b (fading and sinking); returns the visibility. */
function popIn(el, t, a, b, { x, y, from = 0.9, rise = 26, origin = '50% 50%' }) {
  if (!show(el, t >= a && t < b + 0.3)) return 0;
  const u = E.pop(inv(a, a + 0.32, t)), o = E.in(inv(b, b + 0.25, t));
  el.style.transformOrigin = origin;
  css(el, { x, y: y + lerp(rise, 0, E.out(inv(a, a + 0.32, t))) + 20 * o, s: lerp(from, 1, u) * (1 - 0.04 * o), opacity: clamp(inv(a, a + 0.12, t)) * (1 - o) });
  return 1;
}
function nameTag(who, t, a, b, cx, top) {
  const el = R.names[who];
  if (!show(el, t >= a && t < b)) return;
  const u = E.out4(inv(a, a + 0.3, t)), o = E.in(inv(b - 0.2, b, t));
  css(el, { x: cx - M.nameW[who] / 2, y: top + lerp(14, 0, u), opacity: Math.min(u, 1 - o) });
}

// ---------------------------------------------------------------- headlines (one slot, top left)
const HEADS = { hand: [0.25, 1.95], split: [2.6, 5.85], ask: [6.05, 9.85], away: [10.05, 12.85], stop: [13.05, 16.9], done: [17.05, 22.9], back: [23.05, 26.25] };
function poseHeads(t) {
  const night = duskAmount(t);
  for (const k in HEADS) {
    const [a, b] = HEADS[k], el = R.heads[k];
    if (!show(el, t >= a - 0.05 && t <= b + 0.05)) continue;
    const i = E.out4(inv(a, a + 0.4, t)), o = E.in(inv(b - 0.22, b, t));
    css(el, { x: 0, y: lerp(46, 0, i) + lerp(0, -30, o), opacity: Math.min(i, 1 - o) });
    el.style.clipPath = `inset(${lerp(100, -20, i).toFixed(1)}% -20px -20px -20px)`;
    el.style.color = night > 0.02 ? `rgb(${lerp(18, 250, night).toFixed(0)},${lerp(28, 250, night).toFixed(0)},${lerp(32, 252, night).toFixed(0)})` : 'var(--ink)';
  }
  const [a, b] = HEADS.done;
  if (show(R.subDone, t >= a + 0.3 && t <= b)) {
    const i = E.out4(inv(a + 0.35, a + 0.75, t)), o = E.in(inv(b - 0.22, b, t));
    css(R.subDone, { x: 0, y: lerp(20, 0, i), opacity: Math.min(i, 1 - o) });
  }
}

// ---------------------------------------------------------------- the room
function duskAmount(t) { return E.smooth(inv(10.15, 10.8, t)) * (1 - E.smooth(inv(12.85, 13.4, t))); }
function poseRoom(t) {
  css(document.getElementById('dots'), { x: -((t * 14) % 36), y: -((t * 9) % 36), opacity: 0.5 });
  const d = duskAmount(t);
  R.dusk.style.opacity = d.toFixed(3);
  css(R.moon, { x: 1690, y: 150 + 30 * (1 - d), opacity: d });
}

// ---------------------------------------------------------------- pointer
function posePointer(t) {
  let p = null, click = null;
  if (t > 1.45 && t < 2.05) {
    const sx = M.sendX, sy = M.sendY, u = E.out4(inv(1.45, 1.8, t));
    p = { x: lerp(1500, sx - 6, u), y: lerp(1060, sy - 4, u) + (t > 1.83 && t < 1.92 ? 3 : 0), o: 1 - E.in(inv(1.92, 2.04, t)) };
    click = { at: 1.85, x: sx, y: sy, d: 0.3 };
  }
  if (t > 7.55 && t < 8.6 && M.allowAbs) {
    const u = E.out4(inv(7.6, 7.95, t));
    p = { x: lerp(560, M.allowAbs.x - 6, u), y: lerp(1000, M.allowAbs.y - 4, u) + (t > 7.98 && t < 8.08 ? 3 : 0), o: Math.min(E.out(inv(7.55, 7.7, t)), 1 - E.in(inv(8.35, 8.6, t))) };
    click = { at: 8.0, x: M.allowAbs.x, y: M.allowAbs.y };
  }
  if (p) css(R.pointer, { x: p.x, y: p.y, opacity: p.o }); else R.pointer.style.opacity = 0;
  const cd = click?.d ?? 0.45;
  if (click && t >= click.at && t < click.at + cd) {
    const u = inv(click.at, click.at + cd, t);
    css(R.ripple, { x: click.x, y: click.y, s: lerp(0.25, 1.25, E.out(u)), opacity: 0.7 * (1 - u) });
  } else R.ripple.style.opacity = 0;
}

// ---------------------------------------------------------------- the composer (you), in three scenes
// [scene start, scene end, text, typing from, typing to, send at]
const COMPOSE = [
  [0.3, 2.3, S.request, 0.75, 1.7, 1.85],
  [13.35, 16.6, S.stopLine, 13.55, 13.9, 14.0],
  [13.35, 16.6, S.changeLine, 14.75, 15.75, 16.0]
];
function poseComposer(t) {
  const first = t < 6;
  const [a, b] = first ? [0.3, 2.3] : [13.35, 16.6];
  if (!show(R.comp, t >= a && t < b)) return;
  const x = first ? 700 : 680, w = first ? 1110 : 640, y = 718;
  const ent = E.out4(inv(a, a + 0.3, t)), ex = E.in(inv(b - 0.3, b, t));
  R.comp.style.transformOrigin = '50% 50%';
  css(R.comp, { x, y: y + 260 * ex + lerp(60, 0, ent), width: w, opacity: Math.min(ent, 1 - ex) });
  let txt = '';
  for (const [, , s, ta, tb, send] of COMPOSE.filter(c => (first ? c[0] < 6 : c[0] > 6))) {
    if (t >= ta && t < send) {
      const cps = [...s].length / (tb - ta);
      const part = typed(s, t, ta, cps), typing = part.length < [...s].length;
      txt = `${part}${typing || caretOn(t) ? '<span class="caret"></span>' : ''}`;
    }
  }
  setHTML(R.compTxt, txt || `<span class="ph">${S.composer}</span>`);
  const sendAt = first ? [1.85] : [14.0, 16.0];
  css(R.compSend, { s: sendAt.some(s => t > s - 0.04 && t < s + 0.12) ? 0.9 : 1 });
  const r = R.compSend.getBoundingClientRect(); M.sendX = r.left + r.width / 2; M.sendY = r.top + r.height / 2;
}

// ---------------------------------------------------------------- 0–6 · hand it off; it lays out tickets
function poseHand(t) {
  const { mochi, pudding, reviewer } = R.cast;
  if (t < 3.0) {
    const s = seq(t, [[0, 'hop'], [0.72, 'type'], [2.12, 'idle', true], [2.2, 'hop']]);
    let x = hopX(t, 0, -180, 440), flip = false;
    if (t >= 2.2) { x = hopX(t, 2.2, 440, -260); flip = true; }
    mochi.pose({ ...s, x, s: 470, flip });
    nameTag('mochi', t, 0.55, 2.15, 440, 560);
  }
  // the request lifts out of the composer and flies to the Producer, then becomes the job's title
  if (show(R.bubble, t >= 1.85 && t < 3.6)) {
    const from = { x: 760, y: 742, s: 1 }, mid = { x: 1500 - M.bubW * 0.5 * 0.62, y: 470, s: 0.62 }, to = { x: 190, y: 330, s: 0.82 };
    let st;
    if (t < 2.75) { const u = E.inOutQuint(inv(1.88, 2.7, t)); st = { x: lerp(from.x, mid.x, u), y: lerp(from.y, mid.y, u) - 160 * Math.sin(u * Math.PI), s: lerp(from.s, mid.s, u), o: 1 }; }
    else if (t < 3.15) st = { ...mid, y: mid.y + 6 * Math.sin((t - 2.75) * 9), o: 1 };
    else { const u = E.inOutQuint(inv(3.15, 3.55, t)); st = { x: lerp(mid.x, to.x, u), y: lerp(mid.y, to.y, u), s: lerp(mid.s, to.s, u), o: 1 - E.in(inv(3.4, 3.58, t)) }; }
    R.bubble.style.transformOrigin = '0 0';
    css(R.bubble, { x: st.x, y: st.y, s: st.s, opacity: st.o });
  }
  if (t >= 2.0 && t < 6.0) {
    const s = seq(t, [[2.0, 'hop'], [2.72, 'nod'], [3.55, 'think', true], [5.3, 'idle', true]]);
    const out = E.in(inv(5.7, 5.98, t));
    pudding.pose({ ...s, x: hopX(t, 2.0, 2150, 1480), s: 470, flip: true, o: 1 - out });
    nameTag('pudding', t, 2.85, 5.85, 1480, 545);
  }
  if (t >= 4.3 && t < 6.0) {
    const s = seq(t, [[4.3, 'hop'], [5.02, 'idle', true]]);
    const out = E.in(inv(5.7, 5.98, t));
    reviewer.pose({ ...s, x: hopX(t, 4.3, 2150, 1755), s: 430, flip: true, o: 1 - out });
    nameTag('reviewer', t, 4.95, 5.85, 1755, 570);
  }
  // the job card
  if (show(R.job, t >= 3.25 && t < 6.1)) {
    const u = E.out4(inv(3.25, 3.6, t)), o = E.in(inv(5.8, 6.05, t));
    R.job.style.transformOrigin = '0 0';
    css(R.job, { x: 150, y: 300 + lerp(30, 0, u) - 30 * o, s: lerp(0.96, 1, u), opacity: Math.min(u, 1 - o) });
    R.jobTitle.style.opacity = E.out(inv(3.45, 3.6, t));
    R.rows.forEach((r, i) => {
      const a = 3.75 + i * 0.25, v = E.out4(inv(a, a + 0.3, t));
      css(r, { x: lerp(-40, 0, v), opacity: v });
      const rv = r.querySelector('.rv');
      rv.style.opacity = E.out(inv(4.95 + i * 0.1, 5.2 + i * 0.1, t));
      rv.style.transform = `scale(${lerp(1.25, 1, E.out(inv(4.95 + i * 0.1, 5.25 + i * 0.1, t))).toFixed(3)})`;
    });
  }
}

// ---------------------------------------------------------------- 6–10 · outside the workspace, it asks first
function poseAsk(t) {
  const { mochi, pudding } = R.cast;
  const on = t >= 5.95 && t < 10.3;
  show(R.ws, on); show(R.folder, on);
  if (!on) { show(R.appr, false); show(R.logoFly, false); show(R.intent, false); return; }
  const ent = E.out4(inv(5.95, 6.35, t)), ex = E.in(inv(9.85, 10.25, t));
  css(R.ws, { x: 130, y: 330 + lerp(40, 0, ent), opacity: Math.min(ent, 1 - ex) });
  const warn = t > 6.6 && t < 8.0 ? 0.5 + 0.5 * Math.sin((t - 6.6) * 16) : 0;
  R.ws.style.borderColor = t >= 8.3 && t < 9.3 ? 'var(--accent)' : warn > 0.01 ? `rgba(217,119,6,${(0.5 + 0.5 * warn).toFixed(2)})` : '#9fb8be';
  css(R.folder, { x: 1330, y: 560 + lerp(40, 0, E.out4(inv(6.1, 6.5, t))), opacity: Math.min(E.out(inv(6.1, 6.4, t)), 1 - ex) * (t > 8.35 ? 0.55 : 1) });
  // the Producer reaches for the logo and stops at the edge
  if (t >= 6.0) {
    const s = seq(t, [[6.0, 'work', true], [6.7, 'ask'], [8.1, 'idle', true], [8.95, 'nod'], [9.75, 'idle', true]]);
    pudding.pose({ ...s, x: 900, s: 470, o: Math.min(E.out(inv(6.0, 6.25, t)), 1 - ex) });
  }
  if (show(R.intent, t > 6.25 && t < 6.95)) {
    const u = E.out4(inv(6.25, 6.6, t)), o = E.in(inv(6.8, 6.95, t));
    css(R.intent, { x: 1060, y: 690, width: lerp(0, 105, u), opacity: 1 - o });
  }
  // the approval card, and you let it through once
  if (popIn(R.appr, t, 6.85, 9.85, { x: 560, y: 300, origin: '50% 100%' })) {
    const allowed = t >= 8.02;
    setHTML(R.apprLab, allowed ? `<span style="width:24px;height:24px;display:inline-block;color:var(--ok)">${I.check}</span><span style="color:var(--ok-text)">${S.allowed}</span>`
      : `<span style="width:12px;height:12px;border-radius:50%;background:var(--warn);display:inline-block"></span>${S.approvalLab}`);
    R.apprBtns.style.opacity = allowed ? (1 - 0.6 * E.out(inv(8.02, 8.25, t))).toFixed(3) : 1;
    css(R.bAllow, { s: t > 7.98 && t < 8.12 ? 0.94 : 1 });
    const r = R.bAllow.getBoundingClientRect(); M.allowAbs = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  if (t >= 6.9 && t < 10.3) {
    const s2 = seq(t, [[6.9, 'hop'], [7.62, 'idle', true], [7.7, 'point'], [8.45, 'nod'], [9.25, 'idle', true]]);
    mochi.pose({ ...s2, x: hopX(t, 6.9, -200, 330), y: 1035, s: 430, o: 1 - ex });
  }
  // the logo comes in, once allowed
  if (show(R.logoFly, t >= 8.3 && t < 10.3)) {
    const u = E.inOutQuint(inv(8.3, 8.85, t));
    css(R.logoFly, { x: lerp(1370, 1010, u), y: lerp(640, 470, u) - 120 * Math.sin(u * Math.PI), s: lerp(1, 0.85, u), opacity: 1 - ex });
  }
}

// ---------------------------------------------------------------- 10–13 · you walk away; the app watches the render
function poseAway(t) {
  const { mochi, pudding } = R.cast;
  if (t >= 10.0 && t < 12.2) {
    const s = seq(t, [[10.0, 'wave'], [11.3, 'hop']]);
    const x = t < 11.3 ? 330 : hopX(t, 11.3, 330, -260);
    mochi.pose({ ...s, x, y: 1035, s: 430, flip: t >= 11.3 });
  }
  const on = t >= 10.2 && t < 13.1;
  if (t >= 10.2 && t < 13.25) {
    const ent = E.out4(inv(10.2, 10.6, t));
    const s = seq(t, [[10.2, 'idle', true], [12.55, 'hop'], [13.25, 'idle', true]]);
    pudding.pose({ ...s, x: 1560, s: 470, flip: true, o: ent });
  }
  if (!show(R.render, on)) { R.polls.forEach(p => show(p, false)); show(R.wake, false); return; }
  const ent = E.out4(inv(10.35, 10.75, t)), ex = E.in(inv(12.9, 13.1, t));
  css(R.render, { x: 540, y: 420 + lerp(40, 0, ent), opacity: Math.min(ent, 1 - ex) });
  const done = t >= 12.25;
  setHTML(R.renderHd, done ? `<span style="width:38px;height:38px;display:inline-flex;border-radius:50%;padding:7px;background:var(--ok);color:#fff">${I.check}</span><span style="color:var(--ok-text)">${S.rendered}</span>`
    : `${spinner(38, t)}<span>${S.render}</span>`);
  R.renderBar.style.width = `${(100 * E.inOut(inv(10.5, 12.25, t))).toFixed(1)}%`;
  R.renderBar.style.background = done ? 'var(--ok)' : 'var(--accent)';
  R.polls.forEach((p, i) => {
    const a = 10.75 + i * 0.5;
    if (!show(p, t >= a && t < 12.3)) return;
    const u = E.pop(inv(a, a + 0.3, t)), o = E.in(inv(12.1, 12.3, t));
    p.style.transformOrigin = '0 50%';
    css(p, { x: 560 + i * 26, y: 640 + i * 70, s: lerp(0.7, 1, u), opacity: clamp(u * 1.5) * (1 - o) * (i < 2 && t > a + 0.5 ? 0.55 : 1) });
  });
  if (show(R.wake, t >= 12.3 && t < 13.0)) {
    const u = E.inOutQuint(inv(12.3, 12.6, t)), o = E.in(inv(12.75, 12.95, t));
    css(R.wake, { x: lerp(780, 1310 - M.wakeW, u), y: lerp(650, 560, u), opacity: 1 - o });
  }
}

// ---------------------------------------------------------------- 13–17 · a stop for now, and your next line
function poseStop(t) {
  const { mochi, pudding } = R.cast;
  if (t < 12.95 || t >= 17.1) { [R.hold, R.holdIcon, R.receipt, R.lifted, R.goesOn, R.stopB, R.changeB].forEach(e => show(e, false)); return; }
  const ex = E.in(inv(16.75, 17.05, t));
  const sm = seq(t, [[12.95, 'hop'], [13.67, 'type'], [14.05, 'idle', true], [14.7, 'type'], [16.02, 'idle', true], [16.25, 'nod'], [16.9, 'idle', true]]);
  mochi.pose({ ...sm, x: hopX(t, 12.95, -200, 400), s: 470, o: 1 - ex });
  // the Producer at work, held mid-move by your stop, going on from your next line
  const held = t >= 14.0 && t < 16.0;
  const workAt = held ? 14.0 - 13.2 : t - 13.2;
  const sp = t >= 16.05 && t < 16.77 ? { clip: 'hop', at: t - 16.05 } : { clip: 'work', at: workAt, loop: true };
  const gray = E.out(inv(14.0, 14.15, t)) * (1 - E.out(inv(16.0, 16.2, t)));
  if (t >= 13.25 && t < 17.0) pudding.pose({ ...sp, x: 1560, s: 470, flip: true, gray, o: 1 - E.in(inv(16.75, 16.98, t)) });
  if (show(R.hold, t >= 14.0 && t < 16.35)) {
    const d = E.out4(inv(14.0, 14.22, t)), up = E.in(inv(16.0, 16.3, t));
    css(R.hold, { x: 1280, y: lerp(380, 470, d) - 480 * up, opacity: Math.min(d, 1 - up) });
  }
  if (show(R.holdIcon, t >= 14.05 && t < 16.2)) {
    const u = E.pop(inv(14.05, 14.35, t)), o = E.in(inv(16.0, 16.15, t));
    R.holdIcon.style.transformOrigin = '50% 50%';
    css(R.holdIcon, { x: 1500, y: 400, s: lerp(0.5, 1, u), opacity: clamp(u * 1.4) * (1 - o) });
  }
  // your two lines, as sent
  if (show(R.stopB, t >= 14.0)) {
    const u = E.out4(inv(14.0, 14.3, t));
    R.stopB.style.transformOrigin = '100% 100%';
    css(R.stopB, { x: 1180 - M.stopW, y: lerp(700, 560, u) - (t > 16 ? 96 * E.out4(inv(16.0, 16.3, t)) : 0), s: lerp(0.8, 1, u), opacity: clamp(u * 2) * (1 - ex) });
  }
  if (show(R.changeB, t >= 16.0)) {
    const u = E.out4(inv(16.0, 16.3, t));
    R.changeB.style.transformOrigin = '100% 100%';
    css(R.changeB, { x: 1180 - M.changeW, y: lerp(700, 560, u), s: lerp(0.8, 1, u), opacity: clamp(u * 2) * (1 - ex) });
  }
  // the app's receipt: stopped, then lifted by your next line
  popIn(R.receipt, t, 14.3, 16.75, { x: 660, y: 300, origin: '0 50%' });
  if (show(R.lifted, t >= 16.02 && t < 17.05)) {
    const u = E.pop(inv(16.02, 16.3, t));
    R.lifted.style.transformOrigin = '50% 50%';
    css(R.lifted, { x: 660 + M.receiptW - M.liftedW * 0.7, y: 270, s: lerp(1.6, 1, u), r: -8, opacity: clamp(u * 2) * (1 - ex) });
  }
  popIn(R.goesOn, t, 16.35, 16.75, { x: 1560 - M.goesOnW / 2, y: 545, origin: '50% 100%' });
}

// ---------------------------------------------------------------- 17–23 · done has a definition
function poseDone(t) {
  const { pudding, reviewer } = R.cast;
  const on = t >= 16.95 && t < 23.3;
  [R.checks, R.chip, R.say, R.back, R.review, R.verdict].forEach(e => { if (!on) show(e, false); });
  if (!on) return;
  const ex = E.in(inv(22.95, 23.25, t));
  const sp = seq(t, [[16.95, 'present'], [17.9, 'idle', true], [18.8, 'slump'], [19.7, 'work', true], [20.0, 'present'], [20.95, 'idle', true], [22.6, 'cheer'], [24.0, 'idle', true]]);
  if (t >= 17.0) pudding.pose({ ...sp, x: 330, s: 460, o: Math.min(E.out(inv(17.0, 17.2, t)), 1 - ex) });
  if (show(R.say, t >= 17.1 && t < 17.95)) {
    const u = E.pop(inv(17.1, 17.4, t)), o = E.in(inv(17.75, 17.95, t));
    R.say.style.transformOrigin = '0 100%';
    css(R.say, { x: 420, y: 520, s: lerp(0.6, 1, u), opacity: clamp(u * 2) * (1 - o) });
  }
  // the hand-in: the film flies to the checks; the first comes back
  const first = t < 19.95;
  setHTML(R.chip, `<span class="thumb" style="background-image:url(${kettle(first ? 40 : 160)})"></span><span>dawn_final.mp4</span><span class="mono" style="font-size:22px;color:var(--muted);font-weight:500">${first ? S.c1fail : S.c1pass}</span>`);
  if (show(R.chip, (t >= 17.3 && t < 19.15) || (t >= 20.2 && t < 23.3))) {
    const inFrom = { x: 420, y: 640 }, slot = { x: 560, y: 300 };
    let p;
    if (first) {
      if (t < 17.85) { const u = E.inOutQuint(inv(17.3, 17.85, t)); p = { x: lerp(inFrom.x, slot.x, u), y: lerp(inFrom.y, slot.y, u) - 140 * Math.sin(u * Math.PI), s: lerp(0.8, 0.9, u) }; }
      else if (t < 18.75) p = { ...slot, s: 0.9 };
      else { const u = E.inOutQuint(inv(18.75, 19.1, t)); p = { x: lerp(slot.x, inFrom.x, u), y: lerp(slot.y, inFrom.y, u) - 100 * Math.sin(u * Math.PI), s: lerp(0.9, 0.7, u), o: 1 - E.in(inv(18.95, 19.12, t)) }; }
    } else {
      const u = E.inOutQuint(inv(20.2, 20.55, t));
      p = { x: lerp(inFrom.x, slot.x, u), y: lerp(inFrom.y, slot.y, u) - 140 * Math.sin(u * Math.PI), s: lerp(0.8, 0.9, u), o: 1 - ex };
    }
    R.chip.style.transformOrigin = '0 0';
    css(R.chip, { x: p.x, y: p.y, s: p.s, opacity: p.o ?? 1 });
  }
  // the checks you confirmed, run by the app on each hand-in
  if (show(R.checks, t >= 17.15)) {
    const u = E.out4(inv(17.15, 17.5, t));
    css(R.checks, { x: 1000, y: 290 + lerp(30, 0, u), opacity: Math.min(u, 1 - ex) });
    const st = (i) => {
      if (t < 17.9) return ['idle'];
      if (t < 18.35 + i * 0.15) return ['run'];
      if (t < 20.55) return i === 0 ? ['fail', S.c1fail] : ['ok', S.c2pass];
      if (t < 20.9 + i * 0.12) return ['run'];
      return ['ok', i === 0 ? S.c1pass : S.c2pass];
    };
    let pass = 0;
    R.crows.forEach((r, i) => {
      const [k, v] = st(i);
      if (k === 'ok') pass++;
      const ic = r.querySelector('.ic'), val = r.querySelector('.val');
      setHTML(ic, k === 'run' ? spinner(40, t) : k === 'ok' ? `<span style="width:24px;height:24px;display:block">${I.check}</span>` : k === 'fail' ? `<span style="width:24px;height:24px;display:block">${I.x}</span>` : '');
      ic.style.background = k === 'ok' ? 'var(--ok)' : k === 'fail' ? 'var(--danger)' : k === 'idle' ? 'var(--chip)' : 'transparent';
      val.textContent = v || '';
      val.style.color = k === 'fail' ? 'var(--danger-text)' : 'var(--ok-text)';
      const flip = k === 'ok' || k === 'fail' ? (k === 'fail' ? 18.35 : t > 20.9 ? 20.9 + i * 0.12 : 18.35 + i * 0.15) : null;
      ic.style.transform = flip !== null ? `scale(${lerp(1.4, 1, E.out(inv(flip, flip + 0.25, t))).toFixed(3)})` : 'none';
    });
    R.sum.textContent = t < 17.9 ? '0/2' : `${pass}/2`;
    R.sum.style.color = pass === 2 ? 'var(--ok-text)' : t >= 18.35 ? 'var(--danger-text)' : 'var(--muted)';
  }
  if (show(R.back, t >= 18.6 && t < 19.9)) {
    const u = E.pop(inv(18.6, 18.85, t)), o = E.in(inv(19.6, 19.9, t));
    R.back.style.transformOrigin = '50% 50%';
    css(R.back, { x: 1395 - M.backW / 2, y: 585, s: lerp(1.7, 1, u), r: -7, opacity: clamp(u * 2) * (1 - o) });
  }
  // the Reviewer reads frames and rules with evidence
  if (t >= 20.9) {
    const s = seq(t, [[20.9, 'hop'], [21.55, 'inspect'], [23.05, 'idle', true]]);
    // it drops in from above, beside the Producer
    const fall = E.in(inv(20.98, 21.34, t));
    reviewer.pose({ ...s, x: 650, air: lerp(GY + 120, 0, fall), s: 420, o: 1 - ex });
  }
  if (show(R.review, t >= 21.4)) {
    const u = E.out4(inv(21.4, 21.75, t));
    css(R.review, { x: 1000, y: 640 + lerp(40, 0, u), opacity: Math.min(u, 1 - ex) });
    R.evs.forEach((e, i) => { const a = 21.95 + i * 0.3, v = E.pop(inv(a, a + 0.3, t)); e.style.transformOrigin = '0 50%'; css(e, { x: 420, y: 92 + i * 104, s: lerp(0.7, 1, v), opacity: clamp(v * 2) }); });
  }
  popIn(R.verdict, t, 22.55, 23.0, { x: 1790 - M.verdictW, y: 965, origin: '100% 50%' });
}

// ---------------------------------------------------------------- 23–26.5 · come back to results
function poseBack(t) {
  const { mochi, pudding, reviewer } = R.cast;
  if (!show(R.win, t >= 23.1 && t < 26.9)) return;
  const u = E.out4(inv(23.1, 23.5, t)), ex = E.in(inv(26.35, 26.75, t));
  R.win.style.transformOrigin = '50% 50%';
  css(R.win, { x: 520, y: 250 + lerp(40, 0, u), s: lerp(0.97, 1, u) * (1 - 0.06 * ex), opacity: Math.min(u, 1 - ex) });
  // you ask; the Producer answers itself
  const askIn = E.out4(inv(23.75, 24.0, t));
  css(R.ask, { x: 620 - M.askW, y: 40 + lerp(20, 0, askIn), opacity: askIn });
  const ans = E.out4(inv(24.35, 24.65, t));
  css(R.answer, { x: 34, y: 140 + lerp(20, 0, ans), opacity: ans });
  css(R.film, { x: 680, y: 40, opacity: E.out(inv(23.45, 23.75, t)) });
  const src = kettle(Math.floor(((t - 23.45) * 30) % 181) + 1);
  if (R.filmImg.getAttribute('src') !== src) { R.filmImg.setAttribute('src', src); pending.push(R.filmImg.decode().catch(() => {})); }
  css(R.status, { x: 990, y: 50, opacity: E.out(inv(23.6, 23.9, t)) });
  R.cols.forEach((c, i) => { const v = E.out4(inv(23.8 + i * 0.06, 24.1 + i * 0.06, t)); c.style.opacity = v; c.style.transform = `translateY(${lerp(20, 0, v).toFixed(1)}px)`; });
  R.kcards.forEach((k, i) => { const v = E.pop(inv(24.15 + i * 0.15, 24.45 + i * 0.15, t)); k.style.opacity = clamp(v * 2); k.style.transform = `scale(${lerp(0.8, 1, v).toFixed(3)})`; k.style.transformOrigin = '0 0'; });
  // you come back; then all three cheer in front of it
  if (t < 26.5) {
    const s = seq(t, [[23.1, 'hop'], [23.82, 'talk'], [24.85, 'idle', true], [25.3, 'cheer'], [26.7, 'idle', true]]);
    mochi.pose({ ...s, x: hopX(t, 23.1, -200, 270), s: 470 });
  }
  if (t >= 24.9 && t < 26.6) {
    const s = seq(t, [[24.9, 'hop'], [25.62, 'cheer']]);
    pudding.pose({ ...s, x: hopX(t, 24.9, 2150, 900), y: 1080, s: 400, flip: true });
    const r = seq(t, [[25.05, 'hop'], [25.77, 'cheer']]);
    if (t >= 25.05) reviewer.pose({ ...r, x: hopX(t, 25.05, 2150, 1190), y: 1080, s: 380, flip: true, o: 1 - E.in(inv(26.3, 26.6, t)) });
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
  // Mochi and Pudding hop onto the mark and become its two circles
  const circ = (el, at) => { const f = E.pop(inv(at, at + 0.3, t)); el.style.opacity = f > 0.001 ? 1 : 0; el.setAttribute('transform', `translate(${el.getAttribute('cx')} ${el.getAttribute('cy')}) scale(${f.toFixed(3)}) translate(-${el.getAttribute('cx')} -${el.getAttribute('cy')})`); };
  circ(R.mf, 27.05); circ(R.mm, 27.2);
  const onto = (actor, a, x0, y0, s0, flip, cxm, at) => {
    if (t >= at + 0.02) return;
    const k = 360 / 64, tx = 960 - 180 + cxm * k, ty = 500 - 180 + 29 * k + 60;
    const u = E.inOut(inv(a + 0.08, at, t));
    actor.pose({ clip: 'idle', at: 0, x: lerp(x0, tx, u), y: lerp(y0, ty, u), air: 220 * Math.sin(u * Math.PI), s: lerp(s0, 170, u), flip, o: 1 - E.in(inv(at - 0.06, at, t)) });
  };
  onto(mochi, 26.45, 270, GY, 470, false, 25, 27.05);
  onto(pudding, 26.6, 900, 1080, 400, true, 39.5, 27.2);
  if (t < 27.1) return;
  css(R.end, { x: 0, y: 0, s: push });
  R.word.querySelectorAll('.ch').forEach((c, i) => { const u = E.out4(inv(27.55 + i * 0.035, 27.95 + i * 0.035, t)); c.style.transform = `translateY(${lerp(60, 0, u).toFixed(1)}px)`; c.style.opacity = u; });
  css(R.word, { x: M.lockX + 240, y: M.lockY + 100 - M.wordH / 2 - 6 });
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
  for (const k in R.names) show(R.names[k], false);
  poseRoom(t);
  poseComposer(t);
  poseHand(t);
  poseAsk(t);
  poseAway(t);
  poseStop(t);
  poseDone(t);
  poseBack(t);
  poseEnd(t);
  for (const k in R.cast) show(R.cast[k].el, R.cast[k].on);
  poseHeads(t);
  posePointer(t);
  await Promise.all(pending);
}

// ---------------------------------------------------------------- sound cues: name, film time, what it marks
const CUES = [
  ['whoosh', 0.05, 'Mochi hops in'], ['click', 1.85, 'send'], ['whoosh', 1.9, 'the request flies'], ['whoosh', 2.05, 'Producer hops in'],
  ['pop', 2.75, 'caught'], ['pop', 3.3, 'the job'], ['tick', 3.75, 'ticket 01'], ['tick', 4.0, 'ticket 02'], ['whoosh', 4.35, 'Reviewer hops in'], ['pop', 4.95, 'the Reviewer on each ticket'],
  ['fail', 6.7, 'stops at the edge'], ['pop', 6.85, 'approval'], ['click', 8.0, 'allow once'], ['check', 8.05, 'allowed'], ['whoosh', 8.3, 'the logo comes in'],
  ['whoosh', 11.35, 'you leave'], ['tick', 10.75, 'poll'], ['tick', 11.25, 'poll'], ['tick', 11.75, 'poll'], ['check', 12.25, 'render done'], ['pop', 12.55, 'wakes the Producer'],
  ['whoosh', 12.97, 'you are back'], ['click', 14.0, 'stop sent'], ['halt', 14.0, 'everything holds'], ['click', 16.0, 'your next line'], ['pass', 16.02, 'lifted'], ['pop', 16.35, 'goes on'],
  ['pop', 17.1, 'Done!'], ['whoosh', 17.3, 'hand-in'], ['fail!', 18.35, 'length 8.0 s fails'], ['reject', 18.6, 'sent back'], ['swish', 18.75, 'back it goes'],
  ['whoosh', 20.2, 'hand-in again'], ['check', 20.9, 'length passes'], ['check', 21.02, 'size passes'], ['whoosh', 20.9, 'Reviewer hops in'], ['tick', 21.95, 'evidence'], ['tick', 22.25, 'evidence'], ['done', 22.55, 'approved with evidence'],
  ['whoosh', 23.1, 'back'], ['pop', 23.75, 'how is it going'], ['pop', 24.35, 'the Producer answers'], ['tick', 24.15, 'card'], ['tick', 24.3, 'card'], ['pop', 25.3, 'cheer'],
  ['whoosh', 26.45, 'onto the mark'], ['tap', 27.05, 'white circle'], ['tap', 27.2, 'mustard circle']
];
function keyTimes() {
  const out = [];
  for (const [, , s, ta, tb] of COMPOSE) { const n = [...s].length; for (let i = 1; i <= n; i++) out.push(+(ta + (i * (tb - ta)) / n).toFixed(3)); }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- boot
async function boot() {
  SP = await (await fetch('/sprites/sprites.json')).json();
  await Promise.all([document.fonts.load('700 76px "DF Sans"'), document.fonts.load('600 30px "DF Mono"'), document.fonts.load('600 40px "PingFang SC"', '交'), document.fonts.load('400 40px "PingFang SC"', '交')]);
  await document.fonts.ready;
  build();
  measure();
  M.lockX = (1920 - (200 + 40 + M.wordW)) / 2; M.lockY = 230;
  window.film.ready = true;
  await seek(0);
}
window.film = { duration: DURATION, seek, ready: false, cues: CUES, keys: keyTimes(), lang: LANG };
boot();
