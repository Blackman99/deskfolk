// Deskfolk launch film. film.seek(t) poses every element from t alone; nothing runs on a clock.
// Timeline (120 BPM, bars on even seconds): 0 cold open · 2 composer · 4 the team · 6 tickets · 8 your checks ·
// 10.5 hand-offs · 12 the unbacked claim goes back once · 14.7 the run · 17.9 approval · 20 the app runs the
// checks · 22 a stall is chased · 25.2 the request becomes the mark · 26.8 end card (URL on the final hit, 28.0)
import { clamp, lerp, inv, E, keys, typed, caretOn, css, h } from './lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const DURATION = 30.5;
const PANE = { x: 120, y: 220, w: 1680, h: 780 };
const HEAD = 150, CH = PANE.h - HEAD;
const TITLE_K = 0.76;
const COMP_S = 1.02, COMP_FONT = LANG === 'en' ? 46 : 50;

// ---------------------------------------------------------------- icons
const I = {
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4.2 4.2L18.5 7.8"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>',
  term: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l4 4-4 4M12 16h7"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path class="hand" d="M12 12V6.5"/><path d="M12 12h3.5"/></svg>',
  pointer: '<svg viewBox="0 0 22 30" width="44" height="60"><path d="M2.5 2.2v21.6l5.6-5.5 3.6 8.7 3.6-1.5-3.5-8.6h7.8z" fill="#111" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/></svg>'
};
function markSVG(size, opts = {}) {
  const b = opts.bubble || '#146a7c', f = opts.front || '#ffffff', m = opts.mustard || '#f0ab3d';
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64"><path d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z" fill="${b}"/>` +
    `<circle class="mf" cx="25" cy="29" r="10.5" fill="${f}"/><circle class="mm" cx="39.5" cy="29" r="10.5" fill="${m}" stroke="${b}" stroke-width="3"/></svg>`;
}
const AV = { arch: ['a5', S.archL], dev: ['a7', S.devL], wri: ['a4', S.wriL], you: ['you', S.youL] };
const NAME = { arch: S.arch, dev: S.dev, wri: S.wri, you: LANG === 'en' ? 'You' : '你' };
function av(who, size, font, extra = '') {
  const [c, l] = AV[who];
  const fs = font || Math.round(size * (l.length > 1 ? 0.36 : 0.46));
  return `<span class="av ${c}" style="width:${size}px;height:${size}px;font-size:${fs}px;${extra}">${l}</span>`;
}
const think = s => `<span class="think" style="transform:scale(${s})"><i></i><i></i></span>`;
// the app's thinking mark: two stacked circles taking turns to swell
function thinkPulse(el, t) {
  el.querySelectorAll('.think').forEach(k => {
    const [a, b] = k.querySelectorAll('i'), w = Math.sin(t * 6.4);
    a.style.transform = `scale(${(1 + 0.22 * w).toFixed(3)})`; b.style.transform = `scale(${(1 - 0.22 * w).toFixed(3)})`;
  });
}
const setHTML = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };

// ---------------------------------------------------------------- DOM
const stage = document.getElementById('stage');
const R = {};

function buildCold() {
  const g = h('div', 'abs', null, stage); R.cold = g;
  css(g, { width: 1920, height: 1080 }); g.style.transformOrigin = '960px 480px';
  R.coldBig = h('div', 'impact', S.cold, g); css(R.coldBig, { fontSize: LANG === 'en' ? 230 : 250, letterSpacing: LANG === 'en' ? '-8px' : '-6px' });
  R.coldSub = h('div', 'abs mono', `<span style="color:#95a2a8">$</span> ${S.coldSub}`, g);
  css(R.coldSub, { fontSize: LANG === 'en' ? 64 : 80, color: 'var(--danger-text)', whiteSpace: 'nowrap', fontWeight: 600 });
}

function buildComposer() {
  const c = h('div', 'abs composer', null, stage); R.comp = c;
  css(c, { width: 1640, fontSize: COMP_FONT });
  c.style.transformOrigin = '820px 75px';
  h('span', 'clip', I.clip, c);
  R.compTxt = h('span', 'txt', '', c);
  R.compSend = h('span', 'send', I.send, c);
}

function buildPane() {
  R.paneBg = h('div', 'abs pane', null, stage);
  css(R.paneBg, { width: PANE.w, height: PANE.h });
}

function buildChat() {
  const g = h('div', 'abs', null, stage); R.chat = g;
  css(g, { width: PANE.w, height: PANE.h });
  const head = h('div', 'abs', null, g);
  css(head, { width: PANE.w, height: 116, borderBottom: '1.5px solid var(--line)', display: 'flex', alignItems: 'center', padding: '0 44px', gap: '20px' });
  head.innerHTML = `<span style="position:relative;width:84px;height:64px;flex:none">${av('arch', 44, 0, 'position:absolute;left:0;top:0')}${av('dev', 44, 0, 'position:absolute;left:20px;top:16px')}${av('wri', 44, 0, 'position:absolute;left:40px;top:2px')}</span>` +
    `<span><div style="font-size:34px;font-weight:650">${S.group}</div><div style="font-size:22px;color:var(--muted)">${S.groupSub}</div></span>`;
  // the group's three Bots, each with its duty; an un-@'d message wakes only the lead
  R.members = ['arch', 'dev', 'wri'].map((w, i) => {
    const m = h('div', 'abs', `${av(w, 112)}<div style="font-size:40px;font-weight:650;margin-top:18px">${NAME[w]}</div>` +
      `<div style="font-size:26px;color:var(--muted);margin-top:6px">${S.duty[w]}</div>` +
      `<div class="mst" style="margin-top:16px;height:40px;display:flex;align-items:center;justify-content:center;gap:10px;font-size:24px;font-weight:600;color:var(--accent)"></div>`, g);
    css(m, { left: 170 + i * 460, top: 380, width: 420, height: 300, border: '2px solid var(--line)', borderRadius: '28px', background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: '0 24px 50px -32px rgba(18,28,32,.35)' });
    m.style.transformOrigin = '50% 100%';
    return m;
  });
  R.chatTime = h('div', 'abs mono', `10:24 <b style="font-family:var(--sans);font-weight:650;color:var(--ink)">${NAME.you}</b>`, g);
  css(R.chatTime, { fontSize: 22, color: 'var(--muted)', whiteSpace: 'nowrap' });
  R.presence = h('div', 'abs presence', `${av('arch', 46)}<b>${S.arch}</b>${think(1.2)}<span class="st">${S.thinking}</span>`, g);
}

function chip(c) {
  if (c.t === 'file') return `<span class="chipf">${I.file}${c.n}</span>`;
  if (c.t === 'model') return `<span class="chipf model">${c.n} <span class="r">· ${c.r}</span></span>`;
  if (c.t === 'cmd') return `<span class="chipf">${I.term}${c.n}</span>`;
  return '';
}
function card(who, state, text, chips = [], extra = '') {
  const el = h('div', `card ${state}`);
  el.innerHTML = `<div class="top">${av(who, 36)}<b>${NAME[who]}</b>${extra}<span class="stt" style="display:inline-flex;align-items:center;gap:8px"></span></div>` +
    `<div class="tx">${text}</div><div class="meta">${S.group2}</div>` + (chips.length ? `<div class="ft">${chips.map(chip).join('')}</div>` : '');
  return el;
}

// canvas world coordinates for every turn card of the job (who woke whom runs top to bottom)
const MODEL = { fast: 'fast-model', code: 'code-model' };
const CARDS = {
  you: { x: 520, y: 30, who: 'you', st: 'you', tx: S.cYou },
  arch: { x: 520, y: 290, who: 'arch', st: 'done', tx: S.cArch, chips: [{ t: 'model', n: MODEL.fast, r: S.reason1 }] },
  dev1: { x: 160, y: 620, who: 'dev', st: 'run', tx: S.cDev1, chips: [{ t: 'file', n: 'wc.py' }, { t: 'file', n: 'test_wc.py' }, { t: 'model', n: MODEL.code, r: S.reason2 }] },
  wri1: { x: 880, y: 620, who: 'wri', st: 'done', tx: S.cWri1, chips: [{ t: 'file', n: 'README.md' }, { t: 'model', n: MODEL.fast, r: S.reason3 }] },
  dev2: { x: 160, y: 1010, who: 'dev', st: 'done', tx: S.cDev2, chips: [{ t: 'cmd', n: S.cmds(2) }, { t: 'file', n: 'wc.py' }] },
  dev3: { x: 160, y: 1320, who: 'dev', st: 'done', tx: S.cDev3, chips: [{ t: 'cmd', n: S.cmds(1) }] },
  wri2: { x: 880, y: 1320, who: 'wri', st: 'run', tx: S.cWri2, chips: [{ t: 'file', n: 'README.md' }, { t: 'model', n: MODEL.fast, r: S.reason3 }] }
};
const WIRES = [['you', 'arch'], ['arch', 'dev1'], ['arch', 'wri1'], ['dev1', 'dev2'], ['dev2', 'dev3']];
const TAG = { x: 900, y: 1222 };

function buildBoard() {
  const b = h('div', 'abs', null, stage); R.board = b;
  css(b, { width: PANE.w, height: PANE.h, overflow: 'hidden', borderRadius: '26px' });
  R.bHead = h('div', 'board-head', null, b);
  R.bTitle = h('div', 'abs bubble-you', S.request, R.bHead);
  css(R.bTitle, { left: 44, top: 22, s: TITLE_K });
  R.bSub = h('div', 'abs board-sub', null, R.bHead);
  css(R.bSub, { left: 44, top: 108, marginTop: 0 });
  R.bPill = h('span', 'pill run', S.running, R.bSub);
  R.bPillDone = h('span', 'pill done', `<span style="width:18px;height:18px;display:inline-block">${I.check}</span>${S.done}`, R.bSub);
  R.bSubTxt = h('span', null, S.planSub0, R.bSub);
  R.bLast = h('span', null, '', R.bSub); css(R.bLast, { display: 'inline-flex', alignItems: 'center', gap: '10px' });
  R.bClock = h('span', null, I.clock, R.bLast); css(R.bClock, { width: 26, height: 26, display: 'inline-block' });
  R.bLastTxt = h('span', null, '', R.bLast);
  R.bCanvas = h('div', 'board-canvas', null, b);
  css(R.bCanvas, { height: CH, bottom: 'auto' });
  R.world = h('div', 'abs', null, R.bCanvas);
  h('div', 'grid', null, R.world);
  R.wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  R.wires.setAttribute('class', 'wire'); R.wires.setAttribute('width', '1600'); R.wires.setAttribute('height', '1800');
  R.world.appendChild(R.wires);
  R.cards = {};
  for (const k in CARDS) {
    const c = CARDS[k];
    const el = card(c.who, c.st, c.tx, c.chips || [], k === 'wri2' ? `<span class="pill run" style="font-size:17px;padding:0 10px">${S.recalled}</span>` : '');
    css(el, { left: c.x, top: c.y });
    R.world.appendChild(el);
    R.cards[k] = el;
  }
  R.draftSmall = h('div', 'abs', `<span style="color:var(--muted);font-size:19px">${av('dev', 26)} ${S.draftLabel}</span><div style="margin-top:6px"><span class="mono">wc.py</span>${S.claimA}${S.claimB}${S.claimC}</div>`, R.world);
  css(R.draftSmall, { left: 160, width: 440, padding: '14px 20px', border: '3px dashed #95a2a8', borderRadius: '16px', background: 'rgba(255,255,255,.92)', fontSize: 24, lineHeight: 1.4 });
  R.recallTag = h('div', 'abs appline', `${markSVG(32)}<span class="who" style="font-size:24px">${S.recall(S.wri)}</span>`, R.world);
  css(R.recallTag, { left: TAG.x, top: TAG.y, padding: '10px 20px', fontSize: 24, borderRadius: '16px', borderColor: 'var(--accent-b)', alignItems: 'center' });
  R.rail = h('div', 'board-rail', null, b);
  css(R.rail, { height: CH, bottom: 'auto' });
  R.railInner = h('div', 'abs', null, R.rail); css(R.railInner, { left: 0, top: 0, width: 960, height: CH });
  buildRailTickets(); buildRailSpec(); buildRailChecks();
}

function ticketEl(no, title, who) {
  const el = h('div', 'ticket');
  el.innerHTML = `<div class="top"><span class="no">${no}</span><span class="ti">${title}</span><span class="stt"></span></div>` +
    `<div class="who">${av(who, 30)}<span class="whot">${S.willDo(NAME[who])}</span></div>`;
  return el;
}
function setStage(el, s) {
  const map = { todo: ['#95a2a8', 'var(--muted)', S.todo], run: ['var(--accent)', 'var(--accent)', S.running], pass: ['var(--ok)', 'var(--ok-text)', S.passed] };
  const [dot, col, lab] = map[s];
  setHTML(el.querySelector('.stt'), `<i style="background:${dot}"></i><span style="color:${col}">${lab}</span>`);
  el.style.borderColor = s === 'pass' ? '#7fcf9b' : s === 'run' ? 'var(--accent-b)' : 'var(--line)';
}

function buildRailTickets() {
  const g = h('div', 'abs', null, R.railInner); R.rTk = g; css(g, { width: 820, height: CH });
  const hd = h('div', 'abs rail-title', `<span style="color:var(--accent);display:inline-flex">${I.ticket}</span>${S.tickets}<span class="count">${S.ticketCount}</span>`, g);
  css(hd, { left: 30, top: 26, width: 760 });
  R.tk = [['01', S.t1, 'arch'], ['02', S.t2, 'dev'], ['03', S.t3, 'wri']].map(([n, ti, w], i) => {
    const el = ticketEl(n, ti, w); g.appendChild(el); css(el, { top: 92 + i * 160, height: 142 }); setStage(el, 'todo'); return el;
  });
}

function checkRow(cmd) {
  const el = h('div', 'crow');
  el.innerHTML = `<span class="ic"></span><span class="cmd">${cmd}</span><span class="pill" style="background:var(--chip);color:var(--muted);font-weight:500;font-size:19px">${S.youAdded}</span><span class="lab"></span>`;
  return el;
}
function setCheck(el, s, t = 0) {
  const ic = el.querySelector('.ic'), lab = el.querySelector('.lab');
  if (s === 'run') {
    const a = (t * 540) % 360;
    setHTML(ic, `<svg viewBox="0 0 24 24" width="34" height="34"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--accent-b)" stroke-width="2.6"/><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" transform="rotate(${a.toFixed(0)} 12 12)"/></svg>`);
    ic.style.background = 'transparent';
    setText(lab, S.st.run); lab.style.color = 'var(--accent)';
  } else if (s === 'pass') {
    setHTML(ic, `<span style="width:22px;height:22px;display:block">${I.check}</span>`); ic.style.background = 'var(--ok)'; ic.style.color = '#fff';
    setText(lab, S.st.pass); lab.style.color = 'var(--ok-text)';
  } else {
    setHTML(ic, `<span style="width:22px;height:22px;display:block">${I.x}</span>`); ic.style.background = 'var(--danger)'; ic.style.color = '#fff';
    setText(lab, S.st.fail); lab.style.color = 'var(--danger-text)';
  }
}
const CMD = { help: 'python wc.py --help', readme: LANG === 'en' ? 'grep -q Run README.md' : 'grep -q 启动 README.md', pytest: 'pytest -q' };

function buildRailSpec() {
  const g = h('div', 'abs', null, R.railInner); R.rSpec = g; css(g, { width: 960, height: CH });
  const seg = h('div', 'abs', `<span class="pill run" style="font-size:24px;padding:6px 20px">${S.segSpec}</span><span class="pill" style="font-size:24px;padding:6px 20px;color:var(--muted);border:1.5px solid var(--line)">${S.segTickets}</span>`, g);
  css(seg, { left: 36, top: 24, display: 'flex', gap: '12px' });
  const rq = h('div', 'abs', `<div style="font-size:22px;color:var(--muted);font-weight:600">${S.reqTitle}</div>` +
    [['R-1', S.r1], ['R-2', S.r2]].map(([n, x]) => `<div style="display:flex;align-items:center;gap:14px;margin-top:12px;font-size:28px"><span class="mono" style="font-size:19px;background:var(--chip);border-radius:7px;padding:2px 8px;color:var(--ink2)">${n}</span>${x}<span class="pill" style="font-size:18px;background:var(--chip);color:var(--muted);font-weight:500">${S.youSaid}</span></div>`).join(''), g);
  css(rq, { left: 36, top: 96, width: 880 });
  const ck = h('div', 'abs checks', null, g); R.specChecks = ck;
  css(ck, { left: 36, top: 252, width: 888, padding: '18px 26px' });
  ck.innerHTML = `<div class="hd">${S.checks}<span class="sum"></span><span class="add btn" style="height:50px;font-size:22px;padding:0 18px;margin-left:16px">${S.addCheck}</span></div>`;
  R.specSum = ck.querySelector('.sum'); R.specAdd = ck.querySelector('.add');
  R.specRows = [checkRow(CMD.help), checkRow(CMD.readme)];
  R.specRows.forEach(r => ck.appendChild(r));
  R.specNew = checkRow(CMD.pytest); ck.appendChild(R.specNew);
  R.specInput = h('div', 'abs', '', ck);
  css(R.specInput, { left: 26, right: 26, top: 0, height: 64, border: '2.5px solid var(--accent)', borderRadius: '14px', display: 'flex', alignItems: 'center', padding: '0 20px', fontFamily: 'var(--mono)', fontSize: 25, background: '#fff', boxShadow: '0 0 0 6px var(--tint)' });
}

function buildRailChecks() {
  const g = h('div', 'abs', null, R.railInner); R.rChk = g; css(g, { width: 900, height: CH });
  const ck = h('div', 'abs checks', null, g);
  css(ck, { left: 30, top: 22, width: 840, padding: '18px 26px' });
  ck.innerHTML = `<div class="hd">${S.checks}<span class="sum"></span></div>`;
  R.chkSum = ck.querySelector('.sum');
  R.chkRows = [checkRow(CMD.pytest), checkRow(CMD.help), checkRow(CMD.readme)];
  R.chkRows.forEach(r => ck.appendChild(r));
  R.chkTk = [['02', S.t2, 'dev'], ['03', S.t3, 'wri']].map(([n, ti, w], i) => {
    const el = ticketEl(n, ti, w); g.appendChild(el); css(el, { left: 30, width: 840, top: 344 + i * 140, height: 126 }); return el;
  });
  R.ballTag = h('span', 'pill', S.ball(S.wri), R.chkTk[1].querySelector('.who'));
  css(R.ballTag, { marginLeft: '12px', background: 'var(--chip)', color: 'var(--ink2)', border: '1.5px solid var(--line)', fontSize: 20 });
}

function buildClaim() {
  const g = h('div', 'abs', null, stage); R.claim = g; css(g, { width: 1920, height: 1080 });
  R.draft = h('div', 'abs', null, g);
  css(R.draft, { left: 120, top: 290, width: 1680, height: 330, border: '5px dashed #95a2a8', borderRadius: '40px', background: 'rgba(255,255,255,.94)', transformOrigin: '840px 165px' });
  R.draftLab = h('div', 'abs', `${av('dev', 50)}<b style="color:var(--ink);font-weight:650">${S.dev}</b><span>· ${S.draftLabel}</span>`, R.draft);
  css(R.draftLab, { left: 56, top: 40, display: 'flex', alignItems: 'center', gap: '16px', fontSize: 34, color: 'var(--muted)' });
  const fs = LANG === 'en' ? 104 : 116;
  const wave = `url('data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="18"><path d="M0 9 Q10 0 20 9 T40 9" fill="none" stroke="#dc2626" stroke-width="5" stroke-linecap="round"/></svg>').replace(/'/g, '%27')}')`;
  R.draftTx = h('div', 'abs', `<span class="mono" style="font-size:${fs * 0.86}px;font-weight:600;color:var(--accent)">wc.py</span>${S.claimA}<span class="cb" style="position:relative;display:inline-block">${S.claimB}<i style="position:absolute;left:0;right:0;bottom:-14px;height:18px;background:${wave} repeat-x 0 0 / 40px 18px"></i></span>${S.claimC}`, R.draft);
  css(R.draftTx, { left: 56, top: 128, fontSize: fs, fontWeight: 700, letterSpacing: LANG === 'en' ? '-3px' : '-2px', whiteSpace: 'nowrap' });
  R.wave = R.draftTx.querySelector('i');
  R.counter = h('div', 'abs mono', `<span style="color:#95a2a8">$</span> ${S.counter}`, g);
  css(R.counter, { left: 128, top: 662, fontSize: 46, fontWeight: 600, color: 'var(--danger-text)', whiteSpace: 'nowrap' });
  R.note = h('div', 'abs appline', `${markSVG(52)}<div><div class="who" style="font-size:28px">Deskfolk · ${S.appNote}</div><div style="margin-top:6px;font-size:${LANG === 'en' ? 34 : 38}px;color:var(--ink)">${S.appNoteText}</div></div>`, g);
  css(R.note, { left: 120, top: 656, padding: '26px 36px', borderColor: 'var(--accent-b)' });
}

function buildTerm() {
  const g = h('div', 'abs term', null, stage); R.term = g;
  css(g, { width: 1400, height: 600, padding: '30px 44px' });
  g.style.transformOrigin = '700px 300px';
  R.termHead = h('div', null, `${av('dev', 38)}<b style="font-family:var(--sans);font-weight:650;color:#fff">${S.dev}</b><span style="font-family:var(--sans)">· ${S.runCmds}</span>`, g);
  css(R.termHead, { display: 'flex', alignItems: 'center', gap: '14px', fontSize: 26, color: '#7d8b91', marginBottom: '18px' });
  R.tl = Array.from({ length: 7 }, () => { const l = h('div', null, '', g); css(l, { height: '58px', whiteSpace: 'nowrap' }); return l; });
}

function buildApproval() {
  const g = h('div', 'abs approval', null, stage); R.appr = g;
  css(g, { width: 1240, transformOrigin: '620px 100%' });
  R.apprLab = h('div', 'lab', `<span style="width:12px;height:12px;border-radius:50%;background:var(--warn);display:inline-block"></span>${S.needApproval}`, null);
  R.apprLab2 = h('div', 'lab', `<span style="width:24px;height:24px;display:inline-block">${I.check}</span>${S.allowed}`, null);
  css(R.apprLab2, { color: 'var(--ok-text)', background: 'var(--ok-bg)', borderColor: 'var(--ok-line)' });
  const lw = h('div', null, null, g); lw.style.position = 'relative'; lw.style.height = '40px';
  lw.appendChild(R.apprLab); lw.appendChild(R.apprLab2); css(R.apprLab, { position: 'absolute', left: 0, top: 0 }); css(R.apprLab2, { position: 'absolute', left: 0, top: 0 });
  h('div', 'q', `${av('dev', 58)}<span>${S.dev} ${S.wantsOutside}</span>`, g);
  h('div', 'tgt', `<span style="color:var(--muted)">write</span> ~/.local/bin/wc`, g);
  const bt = h('div', 'btns', null, g); R.apprBtns = bt;
  R.bAllow = h('span', 'btn primary', S.allowOnce, bt);
  h('span', 'btn', S.always, bt);
  h('span', 'btn', S.deny, bt);
}

function buildCallout() {
  R.callout = h('div', 'abs appline', null, stage);
  css(R.callout, { padding: '22px 34px', borderRadius: '26px', alignItems: 'center', gap: '22px', boxShadow: '0 40px 80px -30px rgba(18,28,32,.45)' });
  R.callIcon = h('span', null, '', R.callout); css(R.callIcon, { width: 64, height: 64, display: 'inline-flex', color: 'var(--ink2)' });
  R.callTx = h('span', null, '', R.callout); css(R.callTx, { fontSize: 56, fontWeight: 650, letterSpacing: '-.5px' });
}

function buildMark() {
  R.markG = h('div', 'abs', markSVG(360), stage);
  css(R.markG, { width: 360, height: 360 }); R.markG.style.transformOrigin = '180px 180px';
  R.mf = R.markG.querySelector('.mf'); R.mm = R.markG.querySelector('.mm');
}

function buildEnd() {
  const g = h('div', 'abs', null, stage); R.end = g; css(g, { width: 1920, height: 1080 }); g.style.transformOrigin = '960px 540px';
  R.word = h('div', 'abs word', [...S.word].map(c => `<span class="ch" style="display:inline-block">${c}</span>`).join(''), g);
  R.cat = h('div', 'abs', S.category, g); css(R.cat, { fontSize: 38, color: 'var(--muted)', whiteSpace: 'nowrap', fontWeight: 500 });
  R.tag = h('div', 'abs tagline', S.tagline, g);
  R.ctaRow = h('div', 'abs', `<span class="cta"><span style="width:40px;height:40px;transform:rotate(180deg);display:inline-block">${I.send}</span>${S.cta}</span><span class="url" style="font-size:56px;font-weight:600;color:var(--ink)">${S.url}</span>`, g);
  css(R.ctaRow, { display: 'flex', alignItems: 'center', gap: '36px' });
  R.fine = h('div', 'abs fine', S.fine, g); css(R.fine, { fontSize: 30, color: 'var(--ink2)' });
  R.finer = h('div', 'abs', S.finer, g); css(R.finer, { fontSize: 24, color: '#47545a', whiteSpace: 'nowrap' });
}

function buildGlobal() {
  R.bubble = h('div', 'abs bubble-you', S.request, stage);
  R.bubble.style.overflow = 'hidden';
  R.heads = {};
  for (const k in S.h) R.heads[k] = h('div', 'headline', S.h[k], stage);
  R.pointer = h('div', null, I.pointer, stage); R.pointer.id = 'pointer';
  R.ripple = h('div', null, null, stage); R.ripple.id = 'ripple';
}

// ---------------------------------------------------------------- measure once fonts are in
const M = {};
function measure() {
  const r = el => el.getBoundingClientRect();
  M.coldW = r(R.coldBig).width; M.coldH = r(R.coldBig).height; M.coldSubW = r(R.coldSub).width;
  M.bubW = r(R.bubble).width; M.bubH = r(R.bubble).height;
  M.presW = r(R.presence).width; M.chatTimeW = r(R.chatTime).width;
  M.apprH = R.appr.offsetHeight;
  M.wordW = r(R.word).width; M.wordH = r(R.word).height;
  M.catW = r(R.cat).width; M.tagW = r(R.tag).width; M.ctaW = r(R.ctaRow).width; M.fineW = r(R.fine).width; M.finerW = r(R.finer).width;
  M.newRowTop = R.specNew.offsetTop;
  M.cardH = {}; for (const k in R.cards) M.cardH[k] = R.cards[k].offsetHeight;
  M.draftY = CARDS.dev1.y + M.cardH.dev1 + 22;
  css(R.draftSmall, { top: M.draftY });
  M.draftH = R.draftSmall.offsetHeight;
  M.focusDev = (CARDS.dev1.y + M.draftY + M.draftH) / 2;
  // the hand-off tree (you → 架构师 → 开发 / 写手) framed whole inside the canvas
  const treeBot = CARDS.dev1.y + Math.max(M.cardH.dev1, M.cardH.wri1);
  M.treeY = (CARDS.you.y + treeBot) / 2; M.treeS = Math.min(0.8, (CH - 40) / (treeBot - CARDS.you.y));
  M.rtW = R.recallTag.offsetWidth; M.rtH = R.recallTag.offsetHeight;
  // the call-out's two states, measured at their natural size
  setHTML(R.callIcon, I.clock); setText(R.callTx, S.lastAgo(10)); M.callA = { w: R.callout.offsetWidth, h: R.callout.offsetHeight };
  setHTML(R.callIcon, markSVG(64)); setText(R.callTx, S.recall(S.wri)); M.callB = { w: R.callout.offsetWidth, h: R.callout.offsetHeight };
  // wires between cards, drawn once; their reveal is a dash offset
  R.wirePaths = WIRES.map(([a, b]) => {
    const A = CARDS[a], B = CARDS[b];
    const x1 = A.x + 220, y1 = A.y + M.cardH[a], x2 = B.x + 220, y2 = B.y, my = (y1 + y2) / 2;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
    R.wires.appendChild(p);
    const L = p.getTotalLength(); p.style.strokeDasharray = `${L}`; p.dataset.l = L;
    return p;
  });
  const rw = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  rw.setAttribute('d', `M${TAG.x + M.rtW / 2} ${TAG.y + M.rtH} L${TAG.x + M.rtW / 2} ${CARDS.wri2.y}`);
  rw.style.stroke = 'var(--accent)'; rw.style.strokeDasharray = '8 8'; rw.style.strokeWidth = '3';
  R.wires.appendChild(rw); R.recallWire = rw;
}

// ---------------------------------------------------------------- the pane: one rect for the chat and the board
// It is pushed about its left-middle, so the left edge stays on the title column (x = 120) and the bottom keeps ≥ 60 px.
function paneS(t) {
  return keys(t, [[3.5, 1.0], [7.95, 1.03, E.lin], [10.45, 1.0, E.lin], [20.0, 1.0], [21.9, 1.03, E.lin], [25.2, 0.995, E.lin]]);
}
function paneRack(t) { return E.inOutQuint(inv(3.5, 4.1, t)); } // composer → chat focus pull
function panePose(t) {
  const rack = paneRack(t);
  const s = lerp(1.2, 1, rack) * paneS(t);
  return { x: PANE.x, y: PANE.y + lerp(70, 0, rack), s, blur: 14 * (1 - rack) };
}
function panePt(t, lx, ly) {
  const p = panePose(t);
  return { x: p.x + lx * p.s, y: p.y + PANE.h / 2 + (ly - PANE.h / 2) * p.s, s: p.s };
}
function poseRect(el, p, o) {
  el.style.transformOrigin = `0px ${PANE.h / 2}px`;
  css(el, { x: p.x, y: p.y, s: p.s, opacity: o });
  el.style.filter = p.blur > 0.05 ? `blur(${p.blur.toFixed(2)}px)` : 'none';
}

// ---------------------------------------------------------------- headlines (one slot, top left)
// neighbouring headlines swap in place: the outgoing one is gone a frame before the next one starts
const HEADS = { team: [4.2, 7.95], spec: [7.97, 10.35], back: [12.55, 17.98], ask: [18.0, 19.98], checks: [20.0, 21.95], chase: [21.97, 24.95] };
function poseHeads(t) {
  for (const k in HEADS) {
    const [a, b] = HEADS[k], el = R.heads[k];
    if (t < a - 0.05 || t > b + 0.05) { el.style.opacity = 0; continue; }
    const i = E.out4(inv(a, a + 0.4, t)), o = E.in(inv(b - 0.22, b, t));
    css(el, { x: 0, y: lerp(46, 0, i) + lerp(0, -30, o), opacity: Math.min(i, 1 - o) });
    el.style.clipPath = `inset(${lerp(100, -20, i).toFixed(1)}% -20px -20px -20px)`;
  }
}

// ---------------------------------------------------------------- pointer
function posePointer(t) {
  let p = null, click = null;
  if (t > 2.55 && t < 3.95) {
    const send = compPt(3.5, 1640 - 30 - 48, 75);
    const u = E.out4(inv(2.6, 3.32, t));
    p = { x: lerp(1500, send.x - 6, u), y: lerp(1060, send.y - 4, u) + (t > 3.45 && t < 3.6 ? 3 : 0), o: 1 - E.in(inv(3.55, 3.68, t)) };
    click = { at: 3.5, x: send.x, y: send.y, d: 0.28 };
  }
  if (t > 8.1 && t < 9.25 && M.addAbs) {
    const u = E.out4(inv(8.15, 8.45, t));
    p = { x: lerp(1500, M.addAbs.x - 4, u), y: lerp(1040, M.addAbs.y - 4, u) + (t > 8.47 && t < 8.6 ? 3 : 0), o: Math.min(E.out(inv(8.1, 8.25, t)), 1 - E.in(inv(9.0, 9.25, t))) };
    click = { at: 8.52, x: M.addAbs.x, y: M.addAbs.y };
  }
  if (t > 18.35 && t < 19.65 && M.allowAbs) {
    const u = E.out4(inv(18.4, 18.95, t));
    p = { x: lerp(1560, M.allowAbs.x - 6, u), y: lerp(1050, M.allowAbs.y - 4, u) + (t > 19.07 && t < 19.2 ? 3 : 0), o: Math.min(E.out(inv(18.35, 18.5, t)), 1 - E.in(inv(19.4, 19.65, t))) };
    click = { at: 19.1, x: M.allowAbs.x, y: M.allowAbs.y };
  }
  if (p) css(R.pointer, { x: p.x, y: p.y, opacity: p.o }); else R.pointer.style.opacity = 0;
  const cd = click?.d ?? 0.45;
  if (click && t >= click.at && t < click.at + cd) {
    const u = inv(click.at, click.at + cd, t);
    css(R.ripple, { x: click.x, y: click.y, s: lerp(0.25, 1.25, E.out(u)), opacity: 0.7 * (1 - u) });
  } else R.ripple.style.opacity = 0;
}

// ---------------------------------------------------------------- 0 · cold open
function poseCold(t) {
  const on = t < 2.02; R.cold.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const push = 1 + 0.05 * E.smooth(inv(0, 1.65, t));
  const f = E.in(inv(1.62, 2.0, t));
  css(R.cold, { x: 0, y: 0, s: push * (1 + 5.5 * f), opacity: 1 - E.in(inv(1.7, 1.97, t)) });
  R.cold.style.filter = f > 0.01 ? `blur(${(16 * f).toFixed(2)}px)` : 'none';
  css(R.coldBig, { x: (1920 - M.coldW) / 2, y: 250 });
  // the punchline gets its own beat: it slams in under the claim
  const u = E.out4(inv(0.45, 0.62, t));
  R.coldSub.style.transformOrigin = '50% 50%';
  css(R.coldSub, { x: (1920 - M.coldSubW) / 2, y: 250 + M.coldH + 50, s: lerp(1.25, 1, u), opacity: u });
}

// ---------------------------------------------------------------- 1 · composer, in front of the chat it will land in
function compPose(t) {
  const s = COMP_S * (1 + 0.025 * E.smooth(inv(1.9, 3.5, t)));
  return { x: 960 - 820, y: 735 - 75, s };
}
function compPt(t, lx, ly) {
  const p = compPose(t);
  return { x: p.x + 820 + (lx - 820) * p.s, y: p.y + 75 + (ly - 75) * p.s, s: p.s };
}
function poseComposer(t) {
  const on = t > 1.97 && t < 3.9; R.comp.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const ent = E.out4(inv(1.97, 2.22, t)), ex = E.in(inv(3.52, 3.85, t));
  const p = compPose(t);
  css(R.comp, { x: p.x, y: p.y + 420 * ex, s: p.s * lerp(0.94, 1, ent), opacity: Math.min(ent, 1 - ex) });
  R.comp.style.filter = ent < 0.99 ? `blur(${(10 * (1 - ent)).toFixed(2)}px)` : 'none';
  const sent = t >= 3.5;
  const s = typed(S.request, t, 0.95, LANG === 'en' ? 26 : 11.5);
  const typing = s.length < [...S.request].length;
  const caret = !sent && (typing || caretOn(t)) ? '<span class="caret"></span>' : '';
  setHTML(R.compTxt, sent ? '' : `${s}${caret}`);
  css(R.compSend, { s: t > 3.46 && t < 3.66 ? 0.9 : 1 });
}

// ---------------------------------------------------------------- the request bubble (the film's one persistent actor)
function poseBubble(t) {
  if (t >= 3.5 && t < 5.75) {
    let st;
    const chat = () => { const q = panePt(t, PANE.w - 56 - M.bubW, 165); return { x: q.x, y: q.y, s: q.s }; };
    if (t < 4.3) {
      const tp = compPt(3.5, 124, 45), k = (COMP_FONT / 38) * tp.s;
      const from = { x: tp.x - 36 * k, y: tp.y - 26 * k + 4, s: k }, to = chat();
      const u = E.inOutQuint(inv(3.5, 4.25, t));
      st = { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - 120 * Math.sin(u * Math.PI), s: lerp(from.s, to.s, u), bg: E.out(inv(3.5, 3.72, t)) };
    } else if (t < 5.3) st = { ...chat(), bg: 1 };
    else {
      const a = chat(), q = panePt(t, 44, 22), u = E.inOutQuint(inv(5.3, 5.75, t));
      st = { x: lerp(a.x, q.x, u), y: lerp(a.y, q.y, u), s: lerp(a.s, TITLE_K * q.s, u), bg: 1 };
    }
    css(R.bubble, { width: 'auto', height: 'auto', borderRadius: '30px', padding: '26px 36px' });
    css(R.bubble, { x: st.x, y: st.y, s: st.s, opacity: 1 });
    R.bubble.style.background = `rgba(20,106,124,${st.bg.toFixed(3)})`;
    R.bubble.style.color = st.bg > 0.5 ? '#fff' : 'var(--ink)';
    R.bubble.style.boxShadow = st.bg > 0.5 ? '' : 'none';
    return;
  }
  if (t > 25.2 && t < 26.15) {
    // from the plan title to the mark's bubble body (the mark's own geometry fixes that rect)
    const q = panePt(25.2, 44, 22), k = TITLE_K * q.s;
    const from = { x: q.x, y: q.y, w: M.bubW * k, h: M.bubH * k, r: 30 * k };
    const to = { x: 960 - 180 + (6 / 64) * 360, y: 520 - 180 + (6 / 64) * 360, w: (52 / 64) * 360, h: (46 / 64) * 360, r: (16 / 64) * 360 };
    const u = E.inOutQuint(inv(25.2, 26.0, t));
    R.bubble.style.transform = `translate(${lerp(from.x, to.x, u).toFixed(2)}px,${(lerp(from.y, to.y, u) - 70 * Math.sin(u * Math.PI)).toFixed(2)}px)`;
    css(R.bubble, { width: lerp(from.w, to.w, u), height: lerp(from.h, to.h, u), borderRadius: `${lerp(from.r, to.r, u).toFixed(1)}px`, padding: `${(26 * k * (1 - u)).toFixed(1)}px ${(36 * k * (1 - u)).toFixed(1)}px`, fontSize: 38 * k, opacity: 1 - E.in(inv(25.95, 26.12, t)) });
    R.bubble.style.background = '#146a7c';
    R.bubble.style.color = `rgba(255,255,255,${(1 - E.smooth(inv(25.22, 25.62, t))).toFixed(3)})`;
    R.bubble.style.boxShadow = '0 30px 60px -24px rgba(20,106,124,.55)';
    return;
  }
  R.bubble.style.opacity = 0;
  css(R.bubble, { fontSize: 38 });
}

// ---------------------------------------------------------------- 2 · the team
function poseChat(t) {
  const on = t > 1.8 && t < 5.45; R.chat.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const p = panePose(t);
  const ent = E.out(inv(1.82, 2.15, t)), ex = E.smooth(inv(5.25, 5.42, t));
  poseRect(R.chat, { ...p, y: p.y + 20 * ex }, Math.min(lerp(0.55, 1, paneRack(t)) * ent, 1 - ex));
  const bubY = 165;
  css(R.chatTime, { x: PANE.w - 56 - M.chatTimeW, y: bubY - 40, opacity: E.out(inv(4.2, 4.4, t)) });
  const pe = E.pop(inv(4.55, 4.9, t));
  R.presence.style.transformOrigin = '100% 0';
  css(R.presence, { x: PANE.w - 56 - M.presW, y: bubY + M.bubH + 18, s: lerp(0.6, 1, pe), opacity: clamp(pe * 1.4) });
  thinkPulse(R.presence, t);
  R.members.forEach((m, i) => {
    const lit = i === 0 && t > 4.55;
    const dim = i === 0 ? 0 : E.smooth(inv(4.55, 4.95, t));
    css(m, { x: 0, y: 0, s: lit ? lerp(1.05, 1, E.out(inv(4.55, 4.95, t))) : 1, opacity: 1 - 0.45 * dim });
    m.style.borderColor = lit ? 'var(--accent)' : 'var(--line)';
    m.style.background = lit ? '#f5fafb' : '#fff';
    m.style.boxShadow = lit ? `0 0 0 ${(8 * (1 - E.out(inv(4.55, 5.4, t)))).toFixed(2)}px rgba(20,106,124,.22), 0 30px 60px -30px rgba(20,106,124,.45)` : '0 24px 50px -32px rgba(18,28,32,.35)';
    if (i === 0) {
      const st = m.querySelector('.mst');
      setHTML(st, lit ? `${think(1.3)}<span>${S.thinking}</span>` : `<span class="pill run" style="font-size:22px">${S.lead}</span>`);
      if (lit) thinkPulse(st, t);
    }
  });
}

// ---------------------------------------------------------------- the board
function railWidth(t) {
  // the spec panel rides out with the rail (no fade), so the rail is never blank
  return keys(t, [[5.45, 820], [7.95, 820], [8.3, 960, E.out4], [10.38, 960], [10.72, 0, E.inOut], [19.9, 0], [20.0, 900], [24.95, 900]]);
}
function worldCam(t) {
  // [focus x, focus y, scale]: the world point held at the canvas centre
  return keys(t, [
    [5.45, [740, 280, 1.0]], [10.45, [740, 320, 1.03], E.lin],
    [10.95, [740, M.treeY, M.treeS], E.inOut], [11.5, [266, M.focusDev, 1.38], E.inOut], [12.0, [266, M.focusDev, 1.44], E.lin],
    [20.0, [740, 1100, 0.6]], [22.0, [740, 1080, 0.62], E.lin], [22.7, [740, 1100, 0.62], E.lin],
    [23.15, [1100, 1420, 1.0], E.inOut], [24.15, [1100, 1430, 1.03], E.lin], [24.85, [740, 1100, 0.6], E.inOut], [25.4, [740, 1080, 0.58], E.lin]
  ]);
}
function boardOn(t) { return (t >= 5.45 && t < 12.0) || (t >= 20.0 && t < 26.0); }
function poseBoard(t) {
  const paneOn = (t > 1.8 && t < 12.0) || (t >= 20.0 && t < 26.0);
  R.paneBg.style.visibility = paneOn ? 'visible' : 'hidden';
  R.board.style.visibility = boardOn(t) ? 'visible' : 'hidden';
  if (!paneOn) return;
  const p = panePose(t);
  let o = 1;
  if (t < 3.6) o = lerp(0.55, 1, paneRack(t)) * E.out(inv(1.82, 2.15, t));
  if (t >= 20.0 && t < 21) { const u = E.out4(inv(20.0, 20.3, t)); p.s *= lerp(1.03, 1, u); }
  if (t > 25.3) { const u = E.in(inv(25.35, 25.95, t)); o = 1 - u; p.s *= 1 - 0.04 * u; }
  poseRect(R.paneBg, p, o);
  if (!boardOn(t)) return;
  const cin = t < 6.5 ? E.smooth(inv(5.45, 5.7, t)) : 1;
  poseRect(R.board, p, Math.min(o, cin));
  // header
  setText(R.bSubTxt, t < 7.2 ? S.planSub0 : S.planSub1);
  const doneAt = 24.65;
  R.bPill.style.display = t < doneAt ? '' : 'none'; R.bPillDone.style.display = t < doneAt ? 'none' : '';
  css(R.bPillDone, { s: t < doneAt ? 1 : lerp(1.3, 1, E.out(inv(doneAt, doneAt + 0.3, t))) });
  R.bTitle.style.visibility = t < 5.75 || t > 25.2 ? 'hidden' : 'inherit';
  const showLast = t > 19.9;
  R.bLast.style.display = showLast ? 'inline-flex' : 'none';
  if (showLast) {
    const q = quiet(t);
    setText(R.bLastTxt, q.txt);
    R.bClock.querySelector('.hand').setAttribute('transform', `rotate(${(q.ang % 360).toFixed(1)} 12 12)`);
    R.bLast.style.color = q.loud ? 'var(--ink)' : 'var(--muted)'; R.bLast.style.fontWeight = q.loud ? '650' : '400';
  }
  // rail + canvas
  const rw = railWidth(t);
  css(R.rail, { width: rw, left: PANE.w - rw });
  R.rail.style.visibility = rw < 2 ? 'hidden' : 'inherit';
  css(R.bCanvas, { width: PANE.w - rw });
  // rail contents enter and leave in turn, never on top of each other
  const tkO = 1 - E.in(inv(7.95, 8.08, t));
  R.rTk.style.visibility = t < 8.1 ? 'inherit' : 'hidden'; R.rTk.style.opacity = tkO;
  R.tk.forEach((el, i) => {
    const a = 5.75 + i * 0.25, sh = E.out4(inv(a, a + 0.3, t));
    css(el, { x: 0, y: lerp(30, 0, sh), opacity: sh, s: lerp(0.96, 1, sh) });
    el.querySelector('.top').style.opacity = E.out(inv(a + 0.08, a + 0.28, t));
    el.querySelector('.who').style.opacity = E.out(inv(a + 0.16, a + 0.36, t));
  });
  const spIn = E.out4(inv(8.12, 8.4, t));
  R.rSpec.style.visibility = t > 8.1 && t < 10.75 ? 'inherit' : 'hidden';
  css(R.rSpec, { x: lerp(60, 0, spIn), opacity: spIn });
  if (t > 8.1 && t < 10.75) poseSpec(t);
  R.rChk.style.visibility = t >= 20.0 && t < 26.0 ? 'inherit' : 'hidden';
  if (t >= 20.0 && t < 26.0) poseChecks(t);
  poseWorld(t);
  if (t > 8.1 && t < 9.3) { const r = R.specAdd.getBoundingClientRect(); M.addAbs = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
}

// ten quiet minutes, counted up while the clock spins (header and call-out read the same)
function quiet(t) {
  if (t < 21.95) return { txt: S.lastNow, ang: 0, loud: false };
  if (t < 22.7) { const u = E.inOut(inv(21.98, 22.65, t)); return { txt: u < 0.04 ? S.lastNow : S.lastAgo(Math.max(1, Math.round(u * 10))), ang: u * 3600, loud: true }; }
  if (t < 23.15) return { txt: S.lastAgo(10), ang: 3600, loud: true };
  if (t < doneT) return { txt: S.lastWri, ang: 3600, loud: false };
  return { txt: S.lastNow, ang: 3600, loud: false };
}
const doneT = 24.65;

function poseSpec(t) {
  R.specRows.forEach(r => setCheck(r, 'fail', t));
  const typingOn = t > 8.55 && t < 9.02, rowOn = t >= 9.02;
  css(R.specInput, { opacity: typingOn ? 1 : 0, y: M.newRowTop + 4 });
  if (typingOn) setHTML(R.specInput, `${typed(CMD.pytest, t, 8.6, 24)}<span style="display:inline-block;width:3px;height:30px;background:var(--accent);margin-left:2px;vertical-align:-5px"></span>`);
  R.specNew.style.visibility = rowOn ? 'inherit' : 'hidden';
  if (rowOn) setCheck(R.specNew, t < 9.5 ? 'run' : 'fail', t);
  R.specNew.style.opacity = E.out(inv(9.02, 9.15, t));
  setText(R.specSum, S.sum(0, rowOn ? 3 : 2)); R.specSum.style.color = 'var(--danger-text)';
  R.specAdd.style.background = t > 8.5 && t < 8.7 ? 'var(--tint)' : '#fff';
}

function poseChecks(t) {
  const runAt = 20.15, done = [20.55, 20.9, 24.3], failAt = 21.15, rerun = 23.95;
  let pass = 0;
  R.chkRows.forEach((r, i) => {
    let s;
    if (t < runAt) s = 'fail';
    else if (i < 2) s = t < done[i] ? 'run' : 'pass';
    else s = t < failAt ? 'run' : t < rerun ? 'fail' : t < done[2] ? 'run' : 'pass';
    if (s === 'pass') pass++;
    setCheck(r, s, t);
    const flip = [done[0], done[1], t > rerun ? done[2] : failAt][i];
    r.querySelector('.ic').style.transform = `scale(${t > flip ? lerp(1.4, 1, E.out(inv(flip, flip + 0.25, t))).toFixed(3) : 1})`;
  });
  setText(R.chkSum, S.sum(pass, 3));
  R.chkSum.style.color = pass === 3 ? 'var(--ok-text)' : pass ? 'var(--ink2)' : 'var(--danger-text)';
  const passAt = [21.4, 24.45];
  R.chkTk.forEach((el, i) => {
    const ok = t >= passAt[i];
    setStage(el, ok ? 'pass' : 'run');
    setText(el.querySelector('.whot'), ok ? NAME[i ? 'wri' : 'dev'] : S.doing(NAME[i ? 'wri' : 'dev']));
    css(el, { s: ok ? lerp(1.03, 1, E.out(inv(passAt[i], passAt[i] + 0.35, t))) : 1 });
  });
  R.ballTag.style.opacity = E.out(inv(22.1, 22.35, t)) * (1 - E.in(inv(23.1, 23.3, t)));
}

function setCardState(el, s, t) {
  el.classList.toggle('run', s === 'run'); el.classList.toggle('done', s === 'done');
  const st = el.querySelector('.stt');
  setHTML(st, s === 'run' ? `${think(0.9)} ${S.running}` : s === 'done' ? S.fin : '');
  if (s === 'run') thinkPulse(st, t);
}
function poseWorld(t) {
  const [fx, fy, ws] = worldCam(t);
  const cw = PANE.w - railWidth(t);
  R.world.style.transformOrigin = `${fx.toFixed(1)}px ${fy.toFixed(1)}px`;
  css(R.world, { x: cw / 2 - fx, y: CH / 2 - fy, s: ws });
  const from = { you: 0, arch: 0, dev1: 10.72, wri1: 10.78, dev2: 19.0, dev3: 19.0, wri2: 23.12 };
  for (const k in R.cards) {
    const el = R.cards[k], a = from[k];
    let o = t >= a ? 1 : 0, y = 0, s = 1;
    // hand-off cards pop in place once the camera has the whole tree, so none is cut by the pane edge
    if (k === 'dev1' || k === 'wri1') { const u = E.out4(inv(a, a + 0.3, t)); o = clamp(u * 1.6); s = lerp(0.9, 1, u); }
    if (k === 'wri1' && t > 10.9 && t < 12.0) o *= 1 - E.smooth(inv(10.98, 11.14, t)); // gone before the zoom reaches the edge
    if (k === 'wri2') { const u = E.out4(inv(a, a + 0.3, t)); o = u; y = lerp(-50, 0, u); }
    el.style.transformOrigin = '50% 0';
    css(el, { x: 0, y, s, opacity: o });
  }
  setCardState(R.cards.arch, t < 7.2 ? 'run' : 'done', t);
  setCardState(R.cards.dev1, t < 19 ? 'run' : 'done', t);
  setCardState(R.cards.wri1, 'done', t); setCardState(R.cards.dev2, 'done', t); setCardState(R.cards.dev3, 'done', t);
  setCardState(R.cards.wri2, t < 23.95 ? 'run' : 'done', t);
  R.cards.wri2.querySelector('.ft').style.opacity = E.out(inv(23.65, 23.85, t));
  const q = t > 22.0 && t < 23.3 ? E.smooth(inv(22.0, 22.4, t)) * (1 - E.smooth(inv(23.0, 23.3, t))) : 0;
  R.cards.wri1.style.filter = q > 0.01 ? `grayscale(${q.toFixed(2)})` : 'none';
  if (q > 0.01) R.cards.wri1.style.opacity = (1 - 0.4 * q).toFixed(3);
  R.cards.arch.querySelector('.tx').style.opacity = E.out(inv(5.6, 6.0, t));
  const wireAt = [0, 10.6, 10.66, 19.0, 19.0];
  R.wirePaths.forEach((p, i) => { const u = i === 0 ? 1 : E.out(inv(wireAt[i], wireAt[i] + 0.4, t)); p.style.strokeDashoffset = `${(+p.dataset.l * (1 - u)).toFixed(1)}`; });
  // the draft 开发 was about to send
  const dIn = E.pop(inv(11.0, 11.3, t));
  R.draftSmall.style.visibility = t > 10.98 && t < 12.0 ? 'inherit' : 'hidden';
  R.draftSmall.style.transformOrigin = '50% 0';
  css(R.draftSmall, { opacity: clamp(dIn * 1.5), s: lerp(0.85, 1, dIn) });
  // the app's call-back lands where the call-out docks
  R.recallTag.style.visibility = t >= 23.15 ? 'inherit' : 'hidden';
  R.recallWire.style.opacity = E.out(inv(23.12, 23.3, t));
}

// ---------------------------------------------------------------- stall: the quiet clock pops out, becomes the call-back, docks on the canvas
function poseCallout(t) {
  const on = t > 21.98 && t < 23.15; R.callout.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const b = t >= 22.8;
  setHTML(R.callIcon, b ? markSVG(64) : I.clock);
  if (!b) R.callIcon.querySelector('.hand').setAttribute('transform', `rotate(${(quiet(t).ang % 360).toFixed(1)} 12 12)`);
  setText(R.callTx, b ? S.recall(S.wri) : quiet(t).txt);
  R.callTx.style.color = b ? 'var(--accent)' : 'var(--ink)';
  R.callout.style.borderColor = b ? 'var(--accent-b)' : 'var(--line)';
  const nat = b ? M.callB : M.callA;
  const hold = { x: 200, y: 560 };
  const head = R.bLast.getBoundingClientRect();
  let x, y, s, o = 1;
  if (t < 22.28) {
    const u = E.out4(inv(21.98, 22.28, t));
    x = lerp(head.left, hold.x, u); y = lerp(head.top - 10, hold.y, u); s = lerp(head.height / nat.h, 1, u); o = clamp(u * 3);
  } else if (t < 22.88) {
    const u = inv(22.28, 22.88, t);
    x = hold.x; y = hold.y - 12 * u; s = 1 + 0.04 * u;
    if (t > 22.78 && t < 22.86) s *= 1 - 0.06 * Math.sin(inv(22.78, 22.86, t) * Math.PI);
  } else {
    const tag = R.recallTag.getBoundingClientRect(), u = E.inOutQuint(inv(22.88, 23.15, t));
    x = lerp(hold.x, tag.left, u); y = lerp(hold.y - 12, tag.top, u); s = lerp(1.04, tag.width / nat.w, u);
  }
  R.callout.style.transformOrigin = '0 0';
  css(R.callout, { x, y, s, opacity: o });
}

// ---------------------------------------------------------------- 6 · the unbacked claim (hard cut on the bar at 12.0)
function poseClaim(t) {
  const on = t >= 12.0 && t < 14.68; R.claim.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const ant = E.out(inv(14.15, 14.28, t)), back = E.inOut(inv(14.28, 14.66, t));
  const s = (1 + 0.05 * inv(12.0, 14.18, t)) * (1 + 0.03 * ant) * lerp(1, 0.16, back);
  // it goes back the way it came (to 开发, off to the left), staying below the headline
  css(R.draft, { x: lerp(0, -780, back), y: lerp(0, -40, back), s, opacity: 1 - E.smooth(inv(14.3, 14.44, t)) });
  R.draft.style.filter = back > 0.02 ? `blur(${(10 * back).toFixed(2)}px)` : 'none';
  R.wave.style.clipPath = `inset(0 ${(100 * (1 - E.inOut(inv(12.85, 13.1, t)))).toFixed(1)}% 0 0)`;
  const cIn = E.out4(inv(12.3, 12.48, t)), cOut = E.in(inv(13.18, 13.32, t));
  css(R.counter, { x: 0, y: lerp(20, 0, cIn), opacity: Math.min(cIn, 1 - cOut) });
  const nIn = E.out4(inv(13.25, 13.6, t)), nOut = E.in(inv(14.22, 14.4, t));
  css(R.note, { x: lerp(0, -300, nOut), y: lerp(40, 0, nIn) - 180 * nOut, s: 1 - 0.3 * nOut, opacity: Math.min(nIn, 1 - nOut) });
}

// ---------------------------------------------------------------- 7 · the run (typing starts the moment the terminal shows)
function poseTerm(t) {
  // it slides up from below the frame at full opacity while the draft is still flying back, and holds to the cut at 18.0
  const on = t > 14.32 && t < 18.0; R.term.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const ent = E.out4(inv(14.32, 14.8, t));
  css(R.term, { x: 260, y: 290 + lerp(820, 0, ent), s: 1 + 0.06 * inv(14.7, 18.0, t), opacity: 1 });
  const L = [];
  const t1 = typed('pytest -q', t, 14.72, 30);
  L.push(`<span class="p">$</span> ${t1}${t1.length < 9 ? '<span style="background:#d9e4e7;display:inline-block;width:18px;height:36px;vertical-align:-6px"></span>' : ''}`);
  const nd = clamp(Math.floor((t - 15.15) / 0.034), 0, 12);
  L.push(t > 15.15 ? [...'....F.......'.slice(0, nd)].map(c => (c === 'F' ? '<span class="bad">F</span>' : c)).join('') : '');
  L.push(t > 15.6 ? '<span class="bad">FAILED</span> test_wc.py::test_empty_file' : '');
  L.push(t > 15.7 ? '<span class="bad" style="font-weight:700">1 failed</span><span class="dim">, 11 passed in 0.29s</span>' : '');
  L.push(t > 16.05 ? `<span class="dim">${S.fixNote}</span>` : '');
  L.push(t > 16.38 ? `<span class="p">$</span> ${typed('pytest -q', t, 16.4, 30)}` : '');
  const nd2 = clamp(Math.floor((t - 16.75) / 0.022), 0, 12), pass = t > 17.05;
  L.push(t > 16.75 ? (pass ? '<span class="ok" style="font-weight:700;font-size:46px">12 passed</span><span class="dim"> in 0.31s</span>' : '.'.repeat(nd2)) : '');
  L.forEach((x, i) => setHTML(R.tl[i], x));
  R.tl[6].style.transformOrigin = '0 50%';
  R.tl[6].style.transform = pass ? `scale(${lerp(1.2, 1, E.out(inv(17.05, 17.35, t))).toFixed(3)})` : 'none';
}

// ---------------------------------------------------------------- 8 · approval
function poseApproval(t) {
  // hard cut in on the bar at 18.0 (full opacity, still settling); it folds edge-on exactly at the cut to 20.0
  const on = t >= 18.0 && t < 20.0; R.appr.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const ent = E.out4(inv(18.0, 18.35, t)), fold = 0;
  const K = 1.22, H = M.apprH;
  const x = 960 - 620, y = 620 - H * K / 2 - H + H * K; // centred in the space under the headline
  const drift = inv(18.2, 20.0, t);
  css(R.appr, { x, y: y + lerp(70, 0, ent) - 60 * fold - 20 * drift, rx: 89 * fold, s: K * lerp(0.95, 1, ent) * (1 + 0.04 * drift), opacity: 1 });
  R.appr.style.filter = fold > 0.01 ? `brightness(${(1 + 0.5 * fold).toFixed(2)})` : 'none';
  const allowed = t > 19.2;
  R.apprLab.style.opacity = allowed ? 0 : 1; R.apprLab2.style.opacity = allowed ? E.out(inv(19.2, 19.35, t)) : 0;
  R.apprBtns.style.opacity = allowed ? 1 - E.out(inv(19.2, 19.4, t)) * 0.65 : 1;
  css(R.bAllow, { s: t > 19.05 && t < 19.25 ? 0.94 : 1 });
  const ra = R.bAllow.getBoundingClientRect();
  M.allowAbs = { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 };
}

// ---------------------------------------------------------------- the mark and the end card
function poseMark(t) {
  const on = t > 25.9; R.markG.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const ap = E.out(inv(25.93, 26.1, t));
  const lock = E.inOutQuint(inv(26.5, 27.2, t));
  const LS = 200 / 360;
  const cx = lerp(960, M.lockX + 100, lock), cy = lerp(520, M.lockY + 100, lock);
  const s = lerp(1 + 0.06 * E.smooth(inv(26.1, 26.6, t)), LS, lock);
  css(R.markG, { x: cx - 180, y: cy - 180, s, r: t > 26.12 ? -6 * (1 - E.smooth(inv(26.12, 26.75, t))) : 0, opacity: ap });
  const f = E.pop(inv(26.12, 26.42, t)), m = E.pop(inv(26.27, 26.57, t));
  R.mf.setAttribute('transform', `translate(25 ${(29 - 22 * (1 - f)).toFixed(2)}) scale(${f.toFixed(3)}) translate(-25 -29)`);
  R.mm.setAttribute('transform', `translate(39.5 ${(29 - 22 * (1 - m)).toFixed(2)}) scale(${m.toFixed(3)}) translate(-39.5 -29)`);
  R.mf.style.opacity = f > 0.001 ? 1 : 0; R.mm.style.opacity = m > 0.001 ? 1 : 0;
}

function poseEnd(t) {
  const on = t > 26.75; R.end.style.visibility = on ? 'visible' : 'hidden'; if (!on) return;
  const push = 1 + 0.05 * inv(27.2, DURATION, t);
  css(R.end, { x: 0, y: 0, s: push });
  R.word.querySelectorAll('.ch').forEach((c, i) => { const u = E.out4(inv(26.85 + i * 0.035, 27.3 + i * 0.035, t)); c.style.transform = `translateY(${lerp(60, 0, u).toFixed(1)}px)`; c.style.opacity = u; });
  css(R.word, { x: M.lockX + 240, y: M.lockY + 100 - M.wordH / 2 - 6 });
  const show = (el, a, w, y) => { const u = E.out4(inv(a, a + 0.45, t)); css(el, { x: (1920 - w) / 2, y: y + lerp(26, 0, u), opacity: u }); };
  show(R.cat, 27.2, M.catW, 455);
  show(R.tag, 27.5, M.tagW, 555);
  // the URL lands on the song's final hit
  const cu = E.out4(inv(28.0, 28.35, t));
  R.ctaRow.style.transformOrigin = '50% 50%';
  css(R.ctaRow, { x: (1920 - M.ctaW) / 2, y: 705, s: lerp(1.12, 1, cu), opacity: cu });
  show(R.fine, 28.35, M.fineW, 862);
  const u = E.out(inv(28.6, 29.0, t)); css(R.finer, { x: 1920 - 96 - M.finerW, y: 985, opacity: u });
  if (t > 27.2) {
    const mx = M.lockX + 100, my = M.lockY + 100;
    css(R.markG, { x: 960 + (mx - 960) * push - 180, y: 540 + (my - 540) * push - 180, s: (200 / 360) * push, opacity: 1 });
  }
}

function poseBg(t) {
  const o = t > 5.4 && t < 25.3 ? 0.55 : t >= 25.3 ? lerp(0.55, 0.4, inv(25.3, 26.3, t)) : 0;
  css(document.getElementById('dots'), { x: -((t * 14) % 36), y: -((t * 9) % 36), opacity: o });
}

// ---------------------------------------------------------------- seek
function seek(t) {
  t = clamp(t, 0, DURATION);
  poseBg(t);
  poseCold(t);
  poseChat(t);
  poseBoard(t);
  poseComposer(t);
  poseBubble(t);
  poseClaim(t);
  poseTerm(t);
  poseApproval(t);
  poseCallout(t);
  poseMark(t);
  poseEnd(t);
  poseHeads(t);
  posePointer(t);
}

// ---------------------------------------------------------------- sound cues: name, film time, what it marks
const CUES = [
  ['tick', 0.45, 'commands run: 0'], ['whoosh', 1.62, 'cold open flies through'], ['click', 3.5, 'send'], ['whoosh', 3.52, 'request lifts into the chat'],
  ['pop', 4.55, 'the lead wakes'], ['tick', 5.75, 'ticket'], ['tick', 6.0, 'ticket'], ['tick', 6.25, 'ticket'],
  ['click', 8.52, '+ check'], ['enter', 9.02, 'enter'], ['fail', 9.5, 'new check fails: nothing built yet'],
  ['pop', 11.0, 'the draft'], ['tick', 12.3, 'commands run: 0'], ['flag', 12.85, 'the claim is flagged'], ['reject', 13.25, 'sent back once'], ['swish', 14.3, 'the draft goes back'],
  ['fail!', 15.7, '1 failed'], ['pass', 17.05, '12 passed'], ['click', 19.1, 'allow once'], ['check', 19.2, 'allowed'], ['whoosh', 19.72, 'air into the cut at 20.0'],
  ['tick', 20.55, 'check passes'], ['tick', 20.9, 'check passes'], ['fail', 21.15, 'README check fails'], ['check', 21.4, 'ticket 02 passed'],
  ['clock', 22.0, 'ten quiet minutes'], ['pop', 22.8, 'call back'], ['tap', 23.15, 'docks on the canvas'],
  ['tick', 24.3, 'check passes'], ['check', 24.45, 'ticket 03 passed'], ['done', 24.65, 'plan done'],
  ['whoosh', 25.2, 'the request becomes the mark'], ['tap', 26.12, 'white teammate'], ['tap', 26.27, 'mustard teammate']
];
function keyTimes() {
  const out = [], cps = LANG === 'en' ? 26 : 11.5, n = [...S.request].length;
  for (let i = 1; i <= n; i++) { const tt = 0.95 + i / cps; if (tt > 1.9 && tt < 3.45) out.push(+tt.toFixed(3)); }
  for (let i = 1; i <= 9; i++) out.push(+(8.6 + i / 24).toFixed(3), +(14.72 + i / 30).toFixed(3), +(16.4 + i / 30).toFixed(3));
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- boot
async function boot() {
  await Promise.all([document.fonts.load('650 74px "DF Sans"'), document.fonts.load('700 120px "DF Sans"'), document.fonts.load('400 30px "DF Mono"'), document.fonts.load('600 30px "DF Mono"'), document.fonts.load('600 40px "PingFang SC"', '交'), document.fonts.load('400 40px "PingFang SC"', '交')]);
  await document.fonts.ready;
  buildCold(); buildPane(); buildChat(); buildBoard(); buildComposer(); buildClaim(); buildTerm(); buildApproval(); buildCallout(); buildMark(); buildEnd(); buildGlobal();
  measure();
  M.lockX = (1920 - (200 + 40 + M.wordW)) / 2; M.lockY = 205;
  window.film.ready = true;
  seek(0);
}
window.film = { duration: DURATION, seek, ready: false, cues: CUES, keys: keyTimes(), lang: LANG };
boot();
