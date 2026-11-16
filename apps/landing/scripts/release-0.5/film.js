// The Deskfolk 0.5.0 release film: the reel's cast (Mochi, Pudding and the Reviewer) presents 0.5.0 on the native
// app's own surfaces, redrawn (apps/desktop-nsh, the Mac app of this release). film.seek(t) poses everything from t
// alone and resolves once the sprites it chose have decoded.
// Timeline (120 BPM, a bar every 2 s, the 0.1.0 film's music edit): 0 0.4.0 turns over to 0.5.0 · 4 the native window:
// ⌘B folds the sidebar to its rail and back, words and icons each their own way (4× slower) · 10 out of Claude usage:
// the menu bar's usage lines, the turn carrying on (the song's breakdown) · 14 a project session: a video opens at
// once in the preview and gets an annotation, sent as a batch · 19 the Bots' avatars become the task map's characters
// and work their own way · 24 and more · 26.5 the mark, the URL on the final hit (28.0).
import { clamp, lerp, inv, E, css, h } from '/launch/lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const P = S.platforms;
const DURATION = 30.5;
const FPS = 30;
const GY = 905; // the ground line the cast stands on
let SP = null; // sprites.json (the reel's): frames per move, and where the feet are in a frame
let FOLK = null; // folk.json (folk.mjs): the app's folk layers, now and before the characters

// ---------------------------------------------------------------- scale, geometry and icons
// The app's surfaces are drawn at k times their size in the app (film.css --k): the fold's window at KF, the usage
// scene's at KU with its menu at KM, the project session's at KP, the roster's (a closer look) at KR.
const KF = 1.3, KU = 1.3, KM = 1.75, KP = 1.15, KR = 1.75;
// A desk (the wallpaper) with the window on it.
const DESK = { x: 96, y: 246, w: 1300, h: 780 }, WIN = { x: 34, y: 30, w: 1232, h: 720 };
// The sidebar's width (sidebar-width.ts SIDEBAR_DEFAULT) and the rail's on a Mac (SIDEBAR_RAIL + 20, shell-state.ts).
const SIDE = 260, RAIL = 84;
// The app's one icon set (apps/messenger/src/lib/icons.ts), the shapes this film draws, copied as they are; stroked
// with the app's 1.6 px pen at the role size. `f` fills a shape.
const FILE = 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z';
const FOLDER = 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z';
const PIN_HEAD = 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z';
const GEAR = 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';
const BOX = 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z';
const BUBBLE = 'M20.5 15a2 2 0 0 1-2 2H7.5l-4 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z';
const ICONS = {
  x: [{ p: 'M6 6l12 12M18 6 6 18' }],
  check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
  terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
  clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
  'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
  'chevron-up': [{ p: 'm18 15-6-6-6 6' }],
  plus: [{ p: 'M12 5v14M5 12h14' }],
  'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
  folder: [{ p: FOLDER }],
  file: [{ p: FILE }, { p: 'M14 3v5h5' }],
  'file-text': [{ p: FILE }, { p: 'M14 3v5h5' }, { p: 'M8.5 13h7M8.5 17h4.5' }],
  video: [{ r: [2.5, 6, 13.5, 12, 2.5] }, { p: 'm16 10.5 5.5-3v9l-5.5-3z' }],
  package: [{ p: BOX }, { p: 'm3.3 7 8.7 5 8.7-5M12 22V12' }, { p: 'm7.5 4.3 9 5.1' }],
  message: [{ p: BUBBLE }],
  paperclip: [{ p: 'm21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
  minimap: [{ r: [3, 3, 18, 18, 2.5] }, { r: [12, 12, 6, 6, 1] }],
  pin: [{ p: 'M12 17v5' }, { p: PIN_HEAD }],
  more: [{ c: [5.5, 12, 1.6], f: 1 }, { c: [12, 12, 1.6], f: 1 }, { c: [18.5, 12, 1.6], f: 1 }],
  activity: [{ p: 'M22 12h-4l-3 9L9 3l-3 9H2' }],
  target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1.5] }],
  search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.5-3.5' }],
  sparkles: [{ p: 'M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z' }, { p: 'M20 3v4M22 5h-4' }],
  stop: [{ r: [6.5, 6.5, 11, 11, 2.5], f: 1 }],
  play: [{ p: 'M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z', f: 1 }],
  pause: [{ r: [6, 5, 4, 14, 1], f: 1 }, { r: [14, 5, 4, 14, 1], f: 1 }],
  hierarchy: [{ r: [8, 2.5, 8, 6, 1.5] }, { p: 'M12 8.5v3M5.5 14v-2.5h13V14' }, { r: [2, 14, 7, 6, 1.5] }, { r: [15, 14, 7, 6, 1.5] }],
  settings: [{ p: GEAR }, { c: [12, 12, 3] }],
  grid: [{ r: [3.5, 3.5, 7, 7, 1.5] }, { r: [13.5, 3.5, 7, 7, 1.5] }, { r: [3.5, 13.5, 7, 7, 1.5] }, { r: [13.5, 13.5, 7, 7, 1.5] }],
  'sidebar-open': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'M9 3v18' }, { p: 'm14 9 3 3-3 3' }],
  'sidebar-close': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'M9 3v18' }, { p: 'm16 15-3-3 3-3' }]
};
function ic(name, role, k = KF, style = '') {
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
// the menu bar's mark: the app's mark in one ink, a template image the menu bar tints (usage_tray.rs MARK)
const markInk = `<svg viewBox="0 0 64 64"><path d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z" fill="#1d1d1f"/><circle cx="25" cy="29" r="9" fill="#fff"/><circle cx="39.5" cy="29" r="9" fill="#fff"/></svg>`;
// an agent's mark, a plain tile: the app shows the agent's own logo there
const agentTile = (k, role = 16) => `<span class="atile">${ic('terminal', role, k)}</span>`;
const setHTML = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };

// ---------------------------------------------------------------- the folk (a Bot's avatar)
// packages/protocol/src/folk-avatar.ts: the name's hash picks every trait, the character last; boring-avatars.ts
// hashCode. Before 0.5.0 the folk was the one mustard Pudding with a sprout, antenna, bow or headphones (the same
// picks but the character), drawn from the layers of that time (folk.mjs).
const CHARACTERS = ['pudding', 'taro', 'sakura', 'matcha', 'caramel', 'sesame', 'blueberry'];
function hashCode(name) { let h = 0; for (let i = 0; i < name.length; i++) { h = ((h << 5) - h) + name.charCodeAt(i); h &= h; } return Math.abs(h); }
function mixHash(hash) { let h = hash >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
function folkLook(name) {
  const hash = hashCode(name);
  let h = mixHash(hash);
  const pick = list => { const v = list[h % list.length]; h = Math.floor(h / list.length); return v; };
  pick([0, 1, 2, 3, 4, 5, 6]);
  const eyes = pick(['dot', 'happy', 'wink']), mouth = pick(['smile', 'open', 'cat']), accessory = pick([null, 'sprout', 'antenna', 'bow', 'headphones']);
  const mirror = pick([false, true]), raised = pick([true, false, false]), character = pick(CHARACTERS);
  return { hash, eyes, mouth, accessory, mirror, character, wave: raised && character !== 'taro', oldWave: raised && accessory !== 'headphones' };
}
// figure-motions.ts WORK (the avatar takes fig, antenna, arms and what they hold): [percent, channels] stops, ms
const ease = (() => { // Easing.inOut(Easing.ease), Easing.ease being bezier(0.42, 0, 1, 1)
  const b = bezier(0.42, 0, 1, 1);
  return u => (u < 0.5 ? b(u * 2) / 2 : 1 - b((1 - u) * 2) / 2);
})();
const alt = (d, a, b, x = {}) => ({ d, k: [[0, a], [100, b]], dir: 'alt', e: ease, ...x });
const rot = (d, a, b, x) => alt(d, { r: a }, { r: b }, x);
const lift = (d, to, x) => alt(d, { y: 0 }, { y: to }, x);
const turn = (d, list, x = {}) => ({ d, k: list.map(([p, r]) => [p, { r }]), e: ease, ...x });
const stops = (d, list, x = {}) => ({ d, k: list, e: ease, ...x });
const WORK = {
  pudding: { fig: lift(360, -2.5), armL: rot(170, 0, -22), armR: rot(170, 0, 22, { delay: 80 }) },
  taro: { fig: stops(1000, [[0, { r: -3, y: 0 }], [25, { r: 0, y: -1.2 }], [50, { r: 3, y: 0 }], [75, { r: 0, y: -1.2 }], [100, { r: -3, y: 0 }]]), armR: rot(500, 0, -7), armL: rot(500, 0, -12, { delay: 250 }) },
  sakura: {
    fig: turn(2400, [[0, 0], [20, 2.5], [60, 2.5], [82, -2], [100, 0]]),
    armR: turn(2400, [[0, 0], [12, -26], [24, -16], [36, -26], [48, -16], [60, -26], [72, 0], [100, 0]]),
    heldR: turn(2400, [[0, 0], [12, -34], [24, 22], [36, -36], [48, 20], [60, -30], [72, 0], [100, 0]]),
    armL: turn(2400, [[0, 0], [10, -14], [64, -14], [78, 0], [100, 0]])
  },
  matcha: { fig: lift(280, -1), armR: rot(280, -5, 5), heldR: rot(140, -24, 18) },
  caramel: {
    fig: stops(1200, [[0, { sx: 1, sy: 1 }], [54, { sx: 1, sy: 1 }], [58, { sx: 1.03, sy: 0.96 }], [66, { sx: 0.99, sy: 1.01 }], [74, { sx: 1, sy: 1 }], [100, { sx: 1, sy: 1 }]], { e: null }),
    armR: turn(1200, [[0, 0], [44, -28], [56, 4], [66, 0], [100, 0]]),
    heldR: turn(1200, [[0, 20], [44, -50], [56, 82], [62, 72], [68, 80], [100, 20]])
  },
  sesame: {
    fig: stops(3000, [[0, { r: -1, y: 0 }], [50, { r: -2.5, y: 0.4 }], [100, { r: -1, y: 0 }]]),
    armL: turn(3000, [[0, -26], [50, -31], [100, -26]]),
    armR: turn(6000, [[0, 0], [72, 0], [78, 68], [81, 64], [84, 68], [90, 0], [100, 0]])
  },
  blueberry: { fig: lift(2000, -2.9), armR: rot(1600, -30, -62), heldR: turn(1600, [[0, -30], [25, 10], [50, 32], [75, -4], [100, -30]], { e: null }), armL: rot(1600, 0, -12) }
};
const ANTENNA = rot(800, -8, 8); // at work every antenna sways (figureSpecs)
const WORK_STILL = { matcha: { armL: -12 } };
/** A spec's channels a while (ms) into it: looping, alternate when it says so, each stretch eased. */
function specAt(spec, ms) {
  const t = Math.max(0, ms - (spec.delay || 0));
  const n = Math.floor(t / spec.d);
  let u = (t - n * spec.d) / spec.d;
  if (spec.dir === 'alt' && n % 2 === 1) u = 1 - u;
  const ks = spec.k;
  let i = 1;
  while (i < ks.length - 1 && u > ks[i][0] / 100) i++;
  const [pa, a] = ks[i - 1], [pb, b] = ks[i];
  let w = pb === pa ? 1 : clamp((u * 100 - pa) / (pb - pa));
  if (spec.e) w = spec.e(w);
  const out = {};
  for (const c of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const z = c === 'sx' || c === 'sy' ? 1 : 0;
    out[c] = lerp(a[c] ?? z, b[c] ?? z, w);
  }
  return out;
}
const tf = (o = {}, k = 1) => `translate(${((o.x || 0) * k).toFixed(2)}px,${((o.y || 0) * k).toFixed(2)}px) rotate(${(o.r || 0).toFixed(2)}deg) scale(${(o.sx ?? 1).toFixed(4)},${(o.sy ?? 1).toFixed(4)})`;
const origin = ([x, y]) => `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`;
let layerURL = null; // { now: { name: blob url }, then: {...} }
const allFolks = [];

/**
 * A Bot's folk, as FolkAvatar.tsx stacks it: the body (with what it wears), its antenna, each arm turning about its
 * shoulder with what its hand holds turning about the hand, the eyes and their blink, the mouth, what sits over the
 * face; mirrored when its look says so; a raised arm at rest when it waves. `old` draws it as it was before 0.5.0.
 * `set(t, motion)`: idle, running (it works and three dots go over its head) or replying (it works, mouth going).
 */
function folk(name, edgePx, { old = false } = {}) {
  const look = folkLook(name), set = old ? FOLK.then : FOLK.now, urls = old ? layerURL.then : layerURL.now, G = set.geometry;
  const el = h('div', 'folk');
  h('div', 'fsh', null, el);
  const mir = h('div', 'fl', null, el);
  if (look.mirror) mir.style.transform = 'scaleX(-1)';
  const fig = h('div', 'fl', null, mir);
  fig.style.transformOrigin = '50% 98%';
  const img = (parent, layer) => {
    if (!urls[layer]) return null;
    const im = h('img', null, null, parent);
    im.src = urls[layer];
    im.decoding = 'sync';
    return im;
  };
  const part = p => old ? null : `${look.character}-${p}`;
  img(fig, old ? 'body' : part('body'));
  const ant = old ? null : img(fig, part('antenna'));
  if (ant) ant.style.transformOrigin = origin(FOLK.now.geometry.antenna);
  const armL = h('div', 'fl', null, fig), armR = h('div', 'fl', null, fig);
  armL.style.transformOrigin = origin(G.shoulderL); armR.style.transformOrigin = origin(G.shoulderR);
  img(armL, old ? 'arm-l' : part('arm-l'));
  const heldL = old ? null : img(armL, part('held-l'));
  img(armR, old ? 'arm-r' : part('arm-r'));
  const heldR = old ? null : img(armR, part('held-r'));
  if (heldL) heldL.style.transformOrigin = origin(G.handL);
  if (heldR) heldR.style.transformOrigin = origin(G.handR);
  const eyes = img(fig, `eyes-${look.eyes}`), closed = img(fig, 'eyes-closed');
  const mouth = img(fig, `mouth-${look.mouth}`), open = img(fig, 'mouth-open');
  if (old && look.accessory) img(fig, `acc-${look.accessory}`);
  if (!old) img(fig, part('front'));
  const dots = h('div', 'fl', null, el);
  const dotEls = [74, 83, 92].map(x => { const d = h('div', 'fdot', null, dots); d.style.left = `${x - 3.6}%`; return d; });
  const blinkDelay = (look.hash % 52) * 100;
  const f = {
    el, look,
    set(t, motion = 'idle') {
      const ms = t * 1000, working = !old && (motion === 'running' || motion === 'replying');
      const work = WORK[look.character], kk = (edgePx * (0.19 / 0.31)) / 45;
      fig.style.transform = working ? tf(specAt(work.fig, ms), kk) : '';
      if (ant) ant.style.transform = working ? tf(specAt(work.antenna ?? ANTENNA, ms)) : '';
      const raised = motion === 'idle' && (old ? look.oldWave : look.wave);
      const still = working ? (WORK_STILL[look.character]?.armL ?? 0) : 0;
      armL.style.transform = `rotate(${still}deg) ${working && work.armL ? tf(specAt(work.armL, ms)) : ''}`;
      armR.style.transform = `rotate(${raised ? -160 : 0}deg) ${working && work.armR ? tf(specAt(work.armR, ms)) : ''}`;
      if (heldL) heldL.style.transform = working && work.heldL ? tf(specAt(work.heldL, ms)) : '';
      if (heldR) heldR.style.transform = working && work.heldR ? tf(specAt(work.heldR, ms)) : '';
      // a blink every 5.2 s, each folk out of step
      const b = (((ms - blinkDelay) % 5200) + 5200) % 5200 / 5200, shut = b > 0.935 && b < 0.965;
      eyes.style.opacity = shut ? 0 : 1; closed.style.opacity = shut ? 1 : 0;
      const eyeShift = motion === 'running' && !old ? -0.025 * edgePx : 0;
      eyes.style.transform = closed.style.transform = `translateY(${eyeShift.toFixed(2)}px)`;
      // replying: the mouth goes open and shut every 340 ms
      const talk = motion === 'replying' && !old && (ms % 340) >= 170;
      mouth.style.opacity = talk ? 0 : 1; open.style.opacity = talk ? 1 : 0;
      // running: three dots over its head
      dots.style.display = motion === 'running' && !old ? '' : 'none';
      if (motion === 'running') dotEls.forEach((d, i) => {
        const u = ((((ms - i * 200) % 1200) + 1200) % 1200) / 1200, seg = u * 3;
        const o = seg < 1 ? lerp(0.25, 1, seg) : seg < 2 ? lerp(1, 0.25, seg - 1) : 0.25;
        const y = seg < 1 ? lerp(0, -0.03, seg) : seg < 2 ? lerp(-0.03, 0, seg - 1) : 0;
        d.style.opacity = o.toFixed(3); d.style.transform = `translateY(${(y * edgePx).toFixed(2)}px)`;
      });
    }
  };
  f.set(0);
  allFolks.push(f);
  return f;
}
// SessionAvatar.tsx DOT: the status dot's edge and ring by avatar size (md 40, top 36)
const DOT = { 40: [9.5, 2], 36: [9, 2] };
/**
 * A folk in a box of `edge` app pt at scale k. `f.dot(t, on, ring)` is SessionAvatar's status dot at its corner while
 * the Bot works: the brand colour in a ring of the surface it stands on, pulsing once a second.
 */
function folkBox(name, edge, k, opts) {
  const box = h('span', null, null);
  Object.assign(box.style, { display: 'inline-block', position: 'relative', width: `${edge * k}px`, height: `${edge * k}px`, flex: 'none' });
  const f = folk(name, edge * k, opts);
  box.appendChild(f.el);
  const [de, db] = DOT[edge] ?? [7, 1.5];
  const dot = h('span', null, null, box);
  Object.assign(dot.style, { position: 'absolute', right: 0, bottom: 0, width: `${de * k}px`, height: `${de * k}px`, borderRadius: '50%', background: 'var(--accent)', boxSizing: 'border-box', display: 'none' });
  f.dot = (t, on, ring = 'var(--ground)') => {
    dot.style.display = on ? '' : 'none';
    if (!on) return;
    const u = ((t % 1) + 1) % 1, w = u < 0.5 ? u * 2 : 2 - u * 2;
    dot.style.border = `${db * k}px solid ${ring}`;
    dot.style.opacity = lerp(0.35, 1, w).toFixed(3); dot.style.scale = lerp(0.85, 1.15, w).toFixed(3);
  };
  return { box, f };
}

// ---------------------------------------------------------------- the fold (ui/shell/sidebar-fold.ts, every number)
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = t => ((ax * t + bx) * t + cx) * t, y = t => ((ay * t + by) * t + cy) * t, dx = t => (3 * ax * t + 2 * bx) * t + cx;
  return u => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let t = u;
    for (let i = 0; i < 8; i++) { const err = x(t) - u, s = dx(t); if (Math.abs(err) < 1e-6 || Math.abs(s) < 1e-6) break; t -= err / s; }
    return y(t);
  };
}
const edgeEase = bezier(0.25, 0, 0.35, 1);
const EDGE_PEAK = (() => { let p = 0; for (let i = 1; i <= 60; i++) p = Math.max(p, (edgeEase(i / 60) - edgeEase((i - 1) / 60)) * 60); return p; })();
/** sidebarFoldMs: long enough that no frame moves the edge much past 26 pt, 280 to 420 ms. */
const foldMs = d => Math.round(Math.min(420, Math.max(280, ((1000 / 60) * EDGE_PEAK * Math.abs(d)) / 26)));
const keyAt = ({ i, o }, v) => {
  if (v <= i[0]) return o[0];
  for (let j = 1; j < i.length; j++) if (v <= i[j]) { const s = i[j] - i[j - 1]; return o[j - 1] + (o[j] - o[j - 1]) * (s ? (v - i[j - 1]) / s : 1); }
  return o[o.length - 1];
};
const FOLD_TEXT = { opacity: { i: [0.6, 1], o: [0, 1] }, x: { i: [0.6, 1], o: [-10, 0] } };
const FOLD_SIDEBAR = { i: [0.03, 0.32], o: [0, 1] };
const railKeys = order => {
  const done = (10 - Math.min(Math.max(0, order), 10)) * 0.008;
  return { opacity: { i: [done, done + 0.08, done + 0.16], o: [1, 1, 0] }, scale: { i: [done, done + 0.064, done + 0.16], o: [1, 1.04, 0.84] } };
};
// The film plays the fold 4× slower than the app (280 ms at the sidebar's 260 pt): a fold of 8 frames is too quick
// to read. The tag says so on screen.
const SLOW = 4, FOLD_D = foldMs(SIDE - RAIL) * SLOW / 1000, F1 = 5.55, F2 = 7.45;
/** How wide the column is at t (app pt) and how open: folding at F1, unfolding at F2. */
function foldAt(t) {
  let w = SIDE;
  if (t >= F1 && t < F1 + FOLD_D) w = SIDE + (RAIL - SIDE) * edgeEase((t - F1) / FOLD_D);
  else if (t >= F1 + FOLD_D && t < F2) w = RAIL;
  else if (t >= F2 && t < F2 + FOLD_D) w = RAIL + (SIDE - RAIL) * edgeEase((t - F2) / FOLD_D);
  return { w, open: clamp((w - RAIL) / (SIDE - RAIL)), folding: (t >= F1 && t < F1 + FOLD_D) || (t >= F2 && t < F2 + FOLD_D), folded: t >= F1 + FOLD_D && t < F2 };
}

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
  // out of layout when off, so no child shown on its own (visibility: visible) outlives its scene
  el.style.display = t >= a && t < b ? '' : 'none';
  if (!show(el, t >= a && t < b)) return false;
  const u = E.out4(inv(a, a + 0.4, t)), o = E.in(inv(b - 0.3, b, t));
  el.style.transformOrigin = '50% 50%';
  css(el, { x, y: y + lerp(40, 0, u) - 24 * o, s: lerp(0.97, 1, u), opacity: Math.min(u, 1 - o) });
  return true;
}
/** What has been typed of `text` by t, typing from a to b. */
const typed = (text, t, a, b) => [...text].slice(0, Math.round([...text].length * clamp(inv(a, b, t)))).join('');

// ---------------------------------------------------------------- DOM
const R = {};

/**
 * A desk with the native window on it: the wallpaper, the window's glass (the same wallpaper blurred and washed,
 * then the shell's ground at its tint), the traffic lights. `menubar` puts the screen's menu bar along the desk's top.
 */
function deskWindow(k, { win = WIN, menubar = false } = {}) {
  const desk = h('div', 'abs desk', null, stage);
  css(desk, { width: DESK.w, height: DESK.h });
  const wall = `<div class="wall" style="width:${DESK.w}px;height:${DESK.h}px"></div>`;
  desk.insertAdjacentHTML('beforeend', wall);
  const w = h('div', 'abs win', null, desk);
  css(w, { x: win.x, y: win.y, width: win.w, height: win.h });
  w.style.setProperty('--k', k);
  const blur = h('div', 'blur', wall, w);
  css(blur, { left: -win.x, top: -win.y, width: DESK.w, height: DESK.h });
  h('div', 'wash', null, w); h('div', 'shellg', null, w);
  const W = { desk, win: w, k, wpt: win.w / k, hpt: win.h / k };
  W.frame = h('div', 'sframe', null, w);
  W.main = h('div', 'main', null, w);
  h('div', 'lights', '<i></i><i></i><i></i>', w);
  if (menubar) {
    W.mbar = h('div', 'mbar', null, desk);
    W.mbar.style.setProperty('--k', k);
    W.mx = h('span', 'mx', markInk, W.mbar);
    h('span', null, S.clock, W.mbar);
  }
  return W;
}
/** The main column beside a sidebar (or rail) `w` pt wide. */
const placeMain = (W, w) => { W.main.style.left = `${(w * W.k).toFixed(2)}px`; };

/**
 * The open sidebar (Sidebar.tsx) and, for the fold, the rail (SidebarRail.tsx), from one roster: the Bots' directs
 * (each a folk), then the 项目 section's folder with its sessions (each its agent's mark). Returns what the fold moves:
 * the words (fold.text), the whole sidebar (fold.sidebar) and each rail icon with its order (foldRailIcon).
 */
function sidebar(W, roster, { rail = true, project = true } = {}) {
  const k = W.k;
  const sb = h('div', 'sb', null, W.frame);
  sb.style.width = `${SIDE * k}px`;
  const words = [];
  const brand = h('div', 'brand', `${markSVG(22 * k)}<span class="sp"></span><span class="tg">${ic('activity', 20, k)}</span><span class="tg">${ic('target', 20, k)}</span><span class="tg">${ic('sidebar-close', 20, k)}</span>`, sb);
  words.push(brand);
  const srch = h('div', 'srch', `<span class="si">${ic('search', 16, k)}</span>`, sb);
  words.push(h('span', null, S.search, srch), h('kbd', null, '⌘K', srch));
  const list = h('div', 'list', null, sb);
  words.push(h('div', 'ghead first', `<span>${S.botsTab}</span><span class="gadd">+</span>`, list));
  const rows = roster.map(b => {
    const row = h('div', `row${b.on ? ' on' : ''}`, null, list);
    const av = h('span', 'av', null, row);
    const fb = folkBox(b.name, 40, k, { old: b.old });
    av.appendChild(fb.box);
    const tx = h('div', 'tx', `<div class="l1"><span class="t">${b.name}</span><span class="rt">${b.time}</span></div>` +
      `<div class="l2"><span class="rs"><i></i><span class="rst"></span></span><span class="s">${b.prev}</span></div>`, row);
    words.push(tx);
    const r = { row, av, f: fb.f, s: tx.querySelector('.s'), rst: tx.querySelector('.rst'), name: b.name };
    r.status = label => { row.classList.toggle('busy', !!label); setText(r.rst, label || ''); };
    return r;
  });
  if (project) {
    words.push(h('div', 'ghead', `<span>${S.section}</span><span class="gadd">+</span>`, list));
    words.push(h('div', 'dirrow', `${ic('chevron-down', 12, k)}${ic('folder', 16, k)}<span>${S.proj.dir}</span>`, list));
    const ps = h('div', 'psess', null, list);
    const prow = h('div', 'row', `<span class="av">${agentTile(k)}</span>`, ps);
    words.push(h('div', 'tx', `<div class="l1"><span class="t">${S.proj.title}</span><span class="rt">10:12</span></div><div class="l2"><span class="s">${S.proj.prev}</span></div>`, prow));
  }
  const foot = h('div', 'foot', null, sb);
  const fa = (icon, label, cls = '', tail = '') => { const a = h('span', `fa ${cls}`, ic(icon, 16, k), foot); words.push(h('span', 'flab', label, a)); if (tail) words.push(h('span', 'flab', tail, a)); return a; };
  fa('folder', S.workspace); fa('grid', S.tools, '', ic('chevron-up', 12, k, 'opacity:.65')); fa('settings', S.settings, 'end');
  // SidebarFoot.tsx: under 283 the row tightens; when its words do not fit, it keeps its icons only
  if ([...foot.children].reduce((w, a) => w + a.offsetWidth, 0) + 8 * k > foot.clientWidth - 16 * k) foot.classList.add('icons');
  const out = { sb, words, rows };
  if (!rail) return out;
  // the rail: on a Mac no mark (the lights are there), the three actions, the conversations, the foot
  const rl = h('div', 'rail', null, W.frame);
  rl.style.width = `${RAIL * k}px`;
  const icons = [];
  const top = h('div', 'rcol', null, rl);
  [['sidebar-open', ' first'], ['search', ''], ['activity', '']].forEach(([n, c], i) => icons.push({ el: h('span', `ract${c}`, ic(n, 20, k), top), order: i, kind: 'icon' }));
  const rlist = h('div', 'rcol rlist', null, rl);
  roster.forEach((b, i) => {
    const it = h('span', `ritem${b.on ? ' on' : ''}`, null, rlist);
    const fb = folkBox(b.name, 40, k, { old: b.old });
    it.appendChild(fb.box);
    icons.push({ el: it, order: 3 + i, kind: 'icon', f: fb.f, name: b.name });
  });
  if (project) {
    icons.push({ el: h('span', 'rdiv', null, rlist), order: 3 + roster.length, kind: 'fade' });
    icons.push({ el: h('span', 'ritem', `<span class="atile" style="width:${40 * k}px;height:${40 * k}px">${ic('terminal', 20, k)}</span>`, rlist), order: 3 + roster.length, kind: 'icon' });
  }
  const rf = h('div', 'rcol rfoot', null, rl);
  icons.push({ el: rf, order: 10, kind: 'fade' });
  ['folder', 'grid', 'settings'].forEach(n => icons.push({ el: h('span', 'ract', ic(n, 20, k), rf), order: 10, kind: 'scale' }));
  return { ...out, rail: rl, icons };
}
/** The fold at `open` (0 the rail, 1 the sidebar): the words, the sidebar's icons, the rail's icons (sidebar-fold.ts). */
function poseFold(SB, open, { list, rail }) {
  show(SB.sb, list); if (SB.rail) show(SB.rail, rail);
  const to = keyAt(FOLD_TEXT.opacity, open), tx = keyAt(FOLD_TEXT.x, open) * (SB.k ?? 1);
  for (const w of SB.words) { w.style.opacity = to.toFixed(3); w.style.translate = `${tx.toFixed(2)}px 0`; }
  SB.sb.style.opacity = keyAt(FOLD_SIDEBAR, open).toFixed(3);
  if (!SB.icons) return;
  for (const ic of SB.icons) {
    const keys = railKeys(ic.order);
    const o = keyAt(keys.opacity, open), s = keyAt(keys.scale, open);
    if (ic.kind !== 'scale') ic.el.style.opacity = o.toFixed(3);
    if (ic.kind !== 'fade') ic.el.style.scale = s.toFixed(4);
  }
}

/** A pane (WorkbenchLeaf.tsx): its tab strip (tabs 4 pt apart, the active one's ⋯ and ×, then +) and its card. */
function leaf(W, tabs, { width = null } = {}) {
  const k = W.k;
  const el = h('div', 'leaf', null, W.main);
  if (width) Object.assign(el.style, { flex: 'none', width: `${width * k}px` });
  const strip = h('div', 'tabs', null, el);
  const tabEls = tabs.map(tb => {
    const slot = h('span', 'tabslot', null, strip);
    const tab = h('span', `tab${tb.on ? ' on' : ''}`, null, slot);
    const av = h('span', 'tav', null, tab);
    let f = null;
    if (tb.bot) { const fb = folkBox(tb.bot, 20, k); av.appendChild(fb.box); f = fb.f; }
    else av.innerHTML = tb.icon ? `<span style="display:grid;place-items:center;width:100%;height:100%;color:var(--muted)">${ic(tb.icon, 16, k)}</span>` : `<span class="atile" style="width:${20 * k}px;height:${20 * k}px">${ic('terminal', 12, k)}</span>`;
    const busy = h('span', 'busy', null, av);
    show(busy, false);
    h('span', 'tl', tb.label, tab);
    h('span', 'tb', ic('more', 12, k), tab); h('span', 'tb', ic('x', 12, k), tab);
    return { tab, f, busy };
  });
  h('span', 'tplus', ic('plus', 16, k), strip);
  const card = h('div', 'card', null, el);
  return { el, card, tabs: tabEls };
}
/** A Bot's direct in a card: the header (PaneChatBar.tsx), the transcript, the composer with the Bot's picker. */
function botChat(W, L, bot, { tune }) {
  const k = W.k;
  const hd = h('div', 'chd', null, L.card);
  const hav = h('span', 'hav', null, hd);
  const fb = folkBox(bot, 36, k); hav.appendChild(fb.box);
  const who = h('div', 'who', `<span class="nm">${bot}</span>`, hd);
  const st = h('span', 'st2', null, who);
  h('div', 'acts', `<span class="ab">${ic('pin', 16, k)}</span><span class="ab">${ic('hierarchy', 16, k)}<span>${S.trace}</span></span>` +
    `<span class="ab">${ic('minimap', 16, k)}<span>${S.map}</span></span><span class="ab">${ic('settings', 16, k)}</span>`, hd);
  const tr = h('div', 'tr', null, L.card);
  const tri = h('div', 'tri', null, tr);
  const col = h('div', 'colw', null, tri);
  const cw = h('div', 'cwrap', null, L.card);
  const comp = h('div', 'composer', null, cw);
  const txt = h('div', 'txt', `<span class="ph">${S.placeholder(bot)}</span>`, comp);
  h('span', 'cb', ic('paperclip', 20, k), comp);
  const trig = h('span', 'tune', tune, comp);
  h('span', 'gap', null, comp);
  h('span', 'cb', ic('sparkles', 16, k), comp);
  const stop = h('span', 'cb stop', ic('stop', 20, k), comp);
  const send = h('span', 'cb send off', ic('arrow-up', 20, k), comp);
  return { hd, f: fb.f, st, tr, tri, col, comp, txt, trig, stop, send };
}
/** The Bot's picker (BotTune: a Bot on Claude Agent, nothing pinned, two Claude accounts listed): mark, model · level, account. */
const tuneOf = K => `${agentTile(K)}<span>${S.modelDefault}<span class="sep"> · </span>${S.effortDefault}<span class="aside">  ${ACCOUNT}</span></span><span class="arr">${ic('chevron-down', 12, K)}</span>`;
/** A finished reply's last line: how long it took and when (TranscriptBotGroup). */
const replyFoot = (k, took, time) => `${ic('clock', 12, k)}<span>${took}</span><span style="opacity:.6">·</span><span>${time}</span>`;
/** The Bot's state on its sidebar row and in the header's second line, and the folk's motion. */
function poseBusy(C, row, label) {
  if (row) row.status(label);
  setHTML(C.st, label ? `<span class="pd"></span><span>${label}</span>` : '');
}

// ---- the menu bar's usage lines (usage_tray.rs): the agent's mark inside a ring as full as the tightest window
// (red from 90%, amber from 75%, else grey; the rest a faint track), the account, its 5-hour and 7-day numbers
function ringIcon(used) {
  const col = used >= 90 ? '#ef4444' : used >= 75 ? '#f59e0b' : '#8b989e';
  const r = 16.25, c = 2 * Math.PI * r, f = clamp(used / 100) * c;
  return `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="${r}" fill="none" stroke="${col}" stroke-opacity=".35" stroke-width="2.5"/>` +
    `<circle cx="18" cy="18" r="${r}" fill="none" stroke="${col}" stroke-width="2.5" stroke-dasharray="${f.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 18 18)"/>` +
    `<circle cx="18" cy="18" r="13" fill="#eff3f4" stroke="#c9d3d6"/><path d="m13 15 3.2 3-3.2 3M18.5 21h5" fill="none" stroke="#37444a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
const ACCOUNT = 'me@example.com';
const TRAY = [
  { text: `Claude · ${ACCOUNT}　5h 100% · 7d 64%`, used: 100 },
  { text: 'Claude · studio@example.com　5h 23% · 7d 41%', used: 41 }
];

// ---- 14–19: the project's files (the tree's rows: kind, name, depth; folders down to the open file start open)
const TREE = [['folder', 'cuts', 0, '▾'], ['video', 'rough-v1.mp4', 1], ['video', 'teaser.mp4', 1], ['folder', 'music', 0, '▸'], ['file-text', 'subs.srt', 0]];
const TREE_TINT = { folder: '#5f6d74', video: '#b45309', 'file-text': '#5f6d74' };
const VIDEO_LEN = 72; // 1:12
const SEEK = 12, MARK_AT = 12.4;
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pclock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function build() {
  R.dim = document.getElementById('dusk');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };
  const bots = S.bots;

  // ---- 0–4 the release: 0.4.0 turns over to 0.5.0, then the platforms (strings.js `platforms.chips`)
  R.badge = h('div', 'abs', null, stage);
  R.bMark = h('div', 'abs', markSVG(200), R.badge);
  R.bWord = h('div', 'abs word', S.word, R.badge);
  const [major, minor, patch] = S.version.split('.'), from = S.from.split('.')[1];
  R.ver = h('div', 'abs ver', `<span>${major}.</span><span class="roll"><span class="col"><span>${from}</span><span>${minor}</span></span></span><span>.${patch}</span>`, R.badge);
  R.roll = R.ver.querySelector('.roll'); R.rollCol = R.ver.querySelector('.col');
  R.count = h('div', 'abs pill count', `${ic('check', 12, 1.5)}${S.count}`, R.badge);
  R.plat = P.chips.map(c => h('div', `abs platform${c.quiet ? ' quiet' : ''}`, `${ic(c.icon || 'check', 16, 1.5)}<span>${c.text}</span>` +
    `${c.new ? `<span class="new">${c.new}</span>` : ''}${c.tail ? `<span class="tail">· ${c.tail}</span>` : ''}`, stage));

  // ---- 4–10 the native window; ⌘B folds the sidebar to its rail and back
  const rosterA = [0, 1, 2, 3].map(i => ({ ...bots[i], on: i === 0 }));
  const A = R.A = deskWindow(KF);
  A.side = sidebar(A, rosterA);
  A.side.k = KF;
  A.L = leaf(A, [{ bot: bots[0].name, label: bots[0].name, on: true }, { bot: bots[1].name, label: bots[1].name }]);
  A.C = botChat(A, A.L, bots[0].name, { tune: tuneOf(KF) });
  A.C.trig.querySelector('.atile').style.cssText = `width:${16 * KF}px;height:${16 * KF}px`;
  A.C.stop.style.display = 'none';
  h('div', 'you', S.dmAsk, A.C.col); h('div', 'youT', '10:57', A.C.col);
  h('div', 'reply', `<p>${S.dmReply}</p>`, A.C.col); h('div', 'rfoot', replyFoot(KF, S.span(41.6), '10:58'), A.C.col);
  R.key = h('div', 'abs keycap', `<kbd>⌘</kbd><kbd>B</kbd><span class="slow">${S.slow}</span>`, stage);

  // ---- 10–14 out of Claude usage: the menu bar's usage lines; the turn carries on
  const U = R.U = deskWindow(KU, { win: { x: 34, y: 58, w: 1232, h: 696 }, menubar: true });
  U.side = sidebar(U, rosterA, { rail: false });
  U.frame.style.width = `${SIDE * KU}px`;
  U.L = leaf(U, [{ bot: bots[0].name, label: bots[0].name, on: true }, { bot: bots[1].name, label: bots[1].name }]);
  U.C = botChat(U, U.L, bots[0].name, { tune: tuneOf(KU) });
  U.C.trig.querySelector('.atile').style.cssText = `width:${16 * KU}px;height:${16 * KU}px`;
  placeMain(U, SIDE);
  h('div', 'you', S.usageAsk, U.C.col); h('div', 'youT', '13:07', U.C.col);
  U.reply = h('div', 'reply', '<p></p>', U.C.col); U.replyP = U.reply.querySelector('p');
  U.sfoot = h('div', 'sfoot', `<span class="pulse"></span><span class="sst"></span><span class="stt"></span><span class="dur">${ic('clock', 12, KU)}<span class="d"></span></span>`, U.C.col);
  U.sst = U.sfoot.querySelector('.sst'); U.stt = U.sfoot.querySelector('.stt'); U.sd = U.sfoot.querySelector('.d');
  U.rfoot = h('div', 'rfoot', replyFoot(KU, S.span(123.4), '13:09'), U.C.col);
  U.menu = h('div', 'abs tmenu', TRAY.map(l => `<div class="mi"><span class="st">${ringIcon(l.used)}</span><span>${l.text}</span></div>`).join('') +
    `<div class="mi"><span class="st"></span><span>查看全部用量…</span></div><div class="msep"></div><div class="more"></div>`, U.desk);
  U.menu.style.setProperty('--k', KM);

  // ---- 14–19 a project session and its preview: a video opens at once, gets an annotation, the batch is sent
  const Pj = R.Pj = deskWindow(KP);
  Pj.side = sidebar(Pj, rosterA.map(b => ({ ...b, on: false })));
  Pj.side.k = KP;
  poseFold(Pj.side, 0, { list: false, rail: true });
  Pj.frame.style.width = `${RAIL * KP}px`;
  Pj.side.icons.find(i => i.order === 3 + rosterA.length && i.kind === 'icon').el.classList.add('on');
  placeMain(Pj, RAIL);
  const wpt = Pj.wpt - RAIL - 4;
  Pj.L1 = leaf(Pj, [{ label: S.proj.title, on: true }], { width: 392 });
  Pj.L2 = leaf(Pj, [{ icon: 'package', label: S.folderTab(S.proj.dir), on: true }], { width: wpt - 392 });
  // the session: its header, Claude Code's line with the file, your line with its annotation card after the send
  const k = KP, c1 = Pj.L1.card;
  Pj.hd = h('div', 'chd', `${agentTile(k)}<div class="who"><span class="nm">${S.proj.title}</span><span class="st2 quiet">${S.agentLine}</span></div>`, c1);
  Pj.hdLine = Pj.hd.querySelector('.st2');
  const tr = h('div', 'tr', null, c1), tri = h('div', 'tri', null, tr);
  Pj.col = h('div', 'colw', null, tri);
  h('div', 'you wide', S.projAsk, Pj.col);
  h('div', 'youT', '10:05', Pj.col);
  Pj.chip = h('span', 'fchip', `${ic('video', 12, k)}<span>${S.videoFile}</span>`);
  const say = h('div', 'reply', null, Pj.col);
  const p = h('p', null, null, say);
  p.append(S.agentSay[0], Pj.chip, S.agentSay[1]);
  h('div', 'atime', '10:12', Pj.col);
  Pj.mine = h('div', 'you wide', `<div>${S.summaryText}</div><div class="acard"><span class="ap">${ic('video', 16, k)}<span class="pth">${S.absPath}</span><span style="flex:none">· ${mmss(MARK_AT)}</span></span>` +
    `<span class="an">${S.note}</span><span class="apill">${S.pending}</span></div>`, Pj.col);
  Pj.mineT = h('div', 'youT', '10:14', Pj.col);
  const cw = h('div', 'cwrap', null, c1);
  h('div', 'composer', `<div class="txt"><span class="ph">${S.projPlaceholder}</span></div><span class="cb">${ic('paperclip', 20, k)}</span>` +
    `<span class="plan">${S.plan}</span><span class="gap"></span><span class="cb send off">${ic('arrow-up', 20, k)}</span>`, cw);
  // the preview: the tree, the bar, the file (the video, its timeline, the buttons), the list, the send bar
  const pv = h('div', 'pv', null, Pj.L2.card), body = h('div', 'pvbody', null, pv);
  const tree = h('div', 'tree', null, body);
  tree.style.width = `${150 * k}px`;
  Pj.treeRows = TREE.map(([kind, name, depth, car]) => h('div', 'tri2', `<span class="car">${car ?? ''}</span>${ic(kind, 12, k, `color:${TREE_TINT[kind]}`)}<span>${name}</span>`, tree));
  Pj.treeRows.forEach((r, i) => { r.style.paddingLeft = `${(8 + 12 * TREE[i][2]) * k}px`; });
  const main = h('div', 'pvmain', null, body);
  const bar = h('div', 'abar', null, main);
  Pj.toggle = h('span', 'apillb', null, bar);
  const file = h('div', 'pvfile', null, main);
  Pj.area = h('div', 'pvarea', null, file);
  // subs.srt open before the video
  Pj.srt = h('div', 'mono', ['1', '00:00:01,200 --> 00:00:03,000', S.srt[0], '', '2', '00:00:03,400 --> 00:00:05,800', S.srt[1]].join('<br>'), Pj.area);
  Object.assign(Pj.srt.style, { fontSize: `${12 * k}px`, lineHeight: 1.6, color: 'var(--ink2)' });
  Pj.media = h('div', null, null, Pj.area);
  Pj.vid = h('div', 'vid', `<div class="sky"></div><div class="sun"></div><div class="hill" style="background:#7fb07a"></div><div class="hill" style="background:#5f9a6a"></div>`, Pj.media);
  Pj.vidImg = h('img', null, null, Pj.vid); Pj.vidImg.decoding = 'sync';
  Pj.avc = h('div', 'avc', `<span class="pp"></span><span class="ct"></span><span class="bar"><i></i></span><span class="rt"></span>`, Pj.vid);
  Pj.mtl = h('div', 'mtl', '<div class="trk"><div class="pend"></div><div class="mk">1</div><div class="ph"></div></div>', Pj.media);
  Pj.trk = Pj.mtl.querySelector('.trk'); Pj.ph = Pj.mtl.querySelector('.ph'); Pj.pend = Pj.mtl.querySelector('.pend'); Pj.mk = Pj.mtl.querySelector('.mk');
  Pj.mrow = h('div', 'mrow', null, Pj.media);
  Pj.markBtn = h('span', 'btn secondary', S.markHere, Pj.mrow);
  Pj.markT = h('span', 'mt', mmss(MARK_AT), Pj.mrow);
  Pj.endBtn = h('span', 'btn primary', S.endHere, Pj.mrow);
  Pj.nbox = h('div', 'nbox', `<span class="np">${mmss(MARK_AT)}</span><div class="nf"></div><div class="nb"><span class="btn secondary">${S.cancel}</span><span class="btn primary">${S.saveDraft}</span></div>`, Pj.area);
  Pj.nf = Pj.nbox.querySelector('.nf'); Pj.save = Pj.nbox.querySelector('.btn.primary');
  Pj.alist = h('div', 'alist', `<div class="ah"><span>${S.annotationsCount(1)}</span>${ic('x', 12, k)}</div>` +
    `<div class="seg">${S.listTabs.map((n, i) => `<span class="sg${i === 0 ? ' on' : ''}">${n}<b>${i === 0 || i === 3 ? 1 : 0}</b></span>`).join('')}</div>` +
    `<div class="arow"><div class="ar1"><span class="num">1</span>${ic('clock', 12, k)}<span>${mmss(MARK_AT)}</span><span class="spill">${S.draft}</span></div><div class="ar2">${S.note}</div>` +
    `<div class="ar3"><span>${S.edit}</span><span>${S.del}</span></div></div>`, file);
  Pj.spill = Pj.alist.querySelector('.spill'); Pj.segs = [...Pj.alist.querySelectorAll('.sg b')]; Pj.ar3 = Pj.alist.querySelector('.ar3');
  Pj.sbar = h('div', 'sbar', `<span class="sp">${S.sendPending(1)}</span><span class="sf"></span><span class="btn primary">${S.send}</span><span class="btn secondary">${S.clear}</span>`, pv);
  Pj.sf = Pj.sbar.querySelector('.sf'); Pj.sendBtn = Pj.sbar.querySelector('.btn.primary');

  // ---- 19–24 a closer look at the sidebar: seven Bots, each a folk; they become the map's characters and work
  const rosterF = bots.map((b, i) => ({ ...b, on: i === 2 }));
  const Fw = R.Fw = deskWindow(KR, { win: { x: 34, y: -Math.round(93.5 * KR) + 10, w: 1232, h: 1000 } });
  Fw.side = sidebar(Fw, rosterF, { rail: false, project: false });
  Fw.frame.style.width = `${SIDE * KR}px`;
  Fw.sideOld = rosterF.map(b => folkBox(b.name, 40, KR, { old: true }));
  Fw.side.rows.forEach((r, i) => { const o = Fw.sideOld[i].box; Object.assign(o.style, { position: 'absolute', left: 0, top: 0 }); r.av.appendChild(o); r.newBox = r.av.firstElementChild; r.old = Fw.sideOld[i]; });
  placeMain(Fw, SIDE);
  Fw.L = leaf(Fw, [{ bot: bots[2].name, label: bots[2].name, on: true }]);
  Fw.C = botChat(Fw, Fw.L, bots[2].name, { tune: tuneOf(KR) });
  Fw.C.trig.querySelector('.atile').style.cssText = `width:${16 * KR}px;height:${16 * KR}px`;
  // a closer look: the pane's tabs and header are above the desk's edge but for a sliver, which is left blank
  Fw.C.hd.style.visibility = 'hidden';
  h('div', 'you', S.folkAsk, Fw.C.col); h('div', 'youT', '10:21', Fw.C.col);
  Fw.reply = h('div', 'reply', '<p></p>', Fw.C.col); Fw.replyP = Fw.reply.querySelector('p');
  Fw.sfoot = h('div', 'sfoot', `<span class="pulse"></span><span class="sst">${S.streaming}</span><span class="dur">${ic('clock', 12, KR)}<span class="d"></span></span>`, Fw.C.col);
  Fw.sd = Fw.sfoot.querySelector('.d');

  // ---- 24–26.5 and more
  R.more = S.more.map(m => h('div', 'abs morechip', `<span class="dot" style="width:40px;height:40px;background:var(--accent)">${ic('check', 12, 1.5)}</span><span>${m}</span>`, stage));

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
  R.fine = h('div', 'abs fine', `${P.fine} · ${S.fineRest}`, R.end);
  R.finer = h('div', 'abs finer', S.finer, R.end);

  R.pointer = h('div', null, I.pointer, stage); R.pointer.id = 'pointer';
  R.ripple = h('div', null, null, stage); R.ripple.id = 'ripple';
}

const M = {};
function measure() {
  const w = el => el.getBoundingClientRect().width, hh = el => el.getBoundingClientRect().height;
  M.bWordW = w(R.bWord); M.bWordH = hh(R.bWord); M.verW = w(R.ver); M.countW = w(R.count);
  M.platW = R.plat.map(w);
  M.moreW = R.more.map(w);
  M.keyW = w(R.key);
  M.wordW = w(R.word); M.wordH = hh(R.word); M.endVerW = w(R.endVer); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
  // words that would run out of their room: render.mjs prints console errors, so both languages are checked
  const room = (what, width, most) => { if (width > most) console.error(`overflow: ${what} is ${Math.round(width)} px, room ${most}`); };
  for (const k in R.heads) room(`headline ${k}`, w(R.heads[k]), 1920 - 120 - 40);
  for (const k in R.subs) room(`subline ${k}`, w(R.subs[k]), 1920 - 124 - 40);
  M.moreW.forEach((x, i) => room(`chip ${i}`, x, 900));
  room('platforms', M.platW.reduce((a, b) => a + b, 0) + 24 * (M.platW.length - 1), 1760);
  room('fine print', M.fineW, 1800); room('tagline', M.tagW, 1800);
}

// ---------------------------------------------------------------- headlines (one slot, top left)
const HEADS = { native: [4.05, 9.85], usage: [10.05, 13.85], files: [14.05, 18.85], folk: [19.05, 23.85], more: [24.05, 26.25] };
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
  // the usage scene quiets the room a little while the song breaks down
  R.dim.style.opacity = (0.22 * E.smooth(inv(10.6, 11.3, t)) * (1 - E.smooth(inv(13.4, 13.9, t)))).toFixed(3);
}

// ---------------------------------------------------------------- pointer
// Each pass: shown from a to b, it travels from `from` (or where the pass before it ended) onto el by `at`, and
// presses there when click is set (at `at`, or at click's time). A pass that follows on from the last does not fade in.
const POINTS = [
  { a: 10.05, at: 10.48, b: 10.8, from: [1500, 1060], el: () => R.U.mx, click: 10.55, center: true },
  { a: 10.8, at: 11.2, b: 12.2, from: 'prev', el: () => R.U.C.tr, dx: 0.55, dy: 0.35 },
  { a: 12.2, at: 12.5, b: 12.95, from: 'prev', el: () => R.U.mx, click: 12.55, center: true },
  { a: 14.15, at: 14.5, b: 14.75, from: [1500, 1060], el: () => R.Pj.chip, click: 14.58, center: true },
  { a: 14.75, at: 14.9, b: 15.1, from: 'prev', el: () => R.Pj.avc.querySelector('.pp'), click: 14.95, center: true },
  { a: 15.1, at: 15.3, b: 15.5, from: 'prev', el: () => R.Pj.trk, dx: SEEK / VIDEO_LEN, click: 15.35 },
  { a: 15.5, at: 15.68, b: 16.0, from: 'prev', el: () => R.Pj.markBtn, center: true, click: 15.75 },
  { a: 16.0, at: 16.5, b: 16.75, from: 'prev', el: () => R.Pj.save, center: true, click: 16.6 },
  { a: 16.75, at: 17.0, b: 17.25, from: 'prev', el: () => R.Pj.sf, dx: 0.3, click: 17.02 },
  { a: 17.25, at: 17.42, b: 17.85, from: 'prev', el: () => R.Pj.sendBtn, center: true, click: 17.48 }
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
    const [fx, fy] = chained ? target(prev).map((v, j) => v - (j ? 4 : 6)) : p.from === 'prev' ? [1500, 1060] : p.from;
    const u = E.inOut(inv(p.a + 0.05, p.at - 0.05, t));
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

// ---------------------------------------------------------------- 0–4 · 0.4.0 turns over to 0.5.0
function poseRelease(t) {
  const { mochi, pudding } = R.cast;
  const on = t < 4.1;
  show(R.badge, on);
  R.plat.forEach((el, i) => show(el, on && t >= 2.45 + i * 0.15));
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
  // the version is there from the start as 0.4.0; its middle digit shakes, then rolls over to 5 on the 2.0 downbeat
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
  const gap = 24, rowW = M.platW.reduce((a, b) => a + b, 0) + gap * (M.platW.length - 1);
  let x = (1920 - rowW) / 2;
  R.plat.forEach((el, i) => {
    const a = 2.45 + i * 0.15, u = E.pop(inv(a, a + 0.32, t));
    el.style.transformOrigin = '50% 50%';
    css(el, { x, y: 590 + lerp(24, 0, E.out(inv(a, a + 0.3, t))) - 40 * ex, s: lerp(0.85, 1, u), opacity: clamp(inv(a, a + 0.15, t)) * (1 - ex) });
    x += M.platW[i] + gap;
  });
  // Mochi and Pudding come to see it, and cheer when it turns over
  if (t < 4.2) {
    const s = seq(t, [[0, 'hop'], [0.72, 'idle', true], [2.0, 'cheer'], [3.43, 'hop']]);
    const mx = t < 3.43 ? hopX(t, 0, -180, 300) : hopX(t, 3.43, 300, -260);
    mochi.pose({ ...s, x: mx, s: 420, flip: t >= 3.43 });
  }
  const sp = seq(t, [[0.3, 'hop'], [1.02, 'idle', true], [2.05, 'cheer'], [3.48, 'idle', true]]);
  if (t >= 0.3 && t < 4.0) pudding.pose({ ...sp, x: hopX(t, 0.3, 2150, 1660), s: 440, flip: true });
}

// ---------------------------------------------------------------- 4–10 · the native window: ⌘B folds the sidebar
function poseNative(t) {
  const A = R.A;
  const kids = [A.side.sb, A.side.rail, R.key];
  if (!panel(A.desk, t, 4.15, 9.95, DESK.x, DESK.y)) { kids.forEach(e => show(e, false)); return; }
  const f = foldAt(t);
  // the frame and the main column move with the edge; both views are in the frame only while it folds
  A.frame.style.width = `${(f.w * KF).toFixed(2)}px`;
  placeMain(A, f.w);
  poseFold(A.side, f.open, { list: f.open > 0 || f.folding, rail: f.folding || f.folded });
  for (const r of A.side.rows) r.f.set(t);
  for (const ic of A.side.icons) if (ic.f) ic.f.set(t);
  A.L.tabs.forEach(tb => tb.f && tb.f.set(t));
  A.C.f.set(t);
  // ⌘B, twice; the tag says how much slower than the app the film plays it
  const keyOn = (t >= F1 - 0.35 && t < F1 + FOLD_D + 0.15) || (t >= F2 - 0.35 && t < F2 + FOLD_D + 0.15);
  if (show(R.key, keyOn)) {
    const a = t < F2 - 0.35 ? F1 - 0.35 : F2 - 0.35, b = (t < F2 - 0.35 ? F1 : F2) + FOLD_D + 0.15;
    const u = E.pop(inv(a, a + 0.25, t)), o = E.in(inv(b - 0.2, b, t)), press = t >= a + 0.3 && t < a + 0.42 ? 4 : 0;
    R.key.style.transformOrigin = '50% 50%';
    css(R.key, { x: DESK.x + DESK.w + (1920 - DESK.x - DESK.w - M.keyW) / 2, y: 330 + press, s: lerp(0.8, 1, u), opacity: Math.min(clamp(inv(a, a + 0.12, t)), 1 - o) });
  }
}

// ---------------------------------------------------------------- 10–14 · out of usage: the turn carries on
function poseUsage(t) {
  const U = R.U;
  const kids = [U.menu, U.reply, U.sfoot, U.rfoot];
  if (!panel(U.desk, t, 9.95, 13.95, DESK.x, DESK.y)) { kids.forEach(e => show(e, false)); return; }
  // the turn: running pnpm check:subs, then thinking after it, then the reply written; no line in between
  const runEnd = 12.45, writeAt = 12.85, doneAt = 13.45;
  const writing = t >= writeAt && t < doneAt, done = t >= doneAt;
  const label = done ? '' : writing ? S.stReplying : S.stThinking;
  poseBusy(U.C, U.side.rows[0], label);
  const motion = done ? 'idle' : writing ? 'replying' : 'running';
  U.side.rows.forEach((r, i) => { r.f.set(t, i === 0 ? motion : 'idle'); r.f.dot(t, i === 0 && !done, i === 0 ? 'var(--pane)' : undefined); });
  U.L.tabs[0].f.set(t, motion); U.L.tabs[1].f.set(t); U.C.f.set(t, motion); U.C.f.dot(t, !done);
  show(U.L.tabs[0].busy, !done);
  U.side.rows[0].s.textContent = done ? S.usageReply : S.bots[0].prev;
  setText(U.sst, t < runEnd ? S.doing('run', S.usageCmd) : writing ? S.streaming : S.done('run', S.usageCmd));
  // a step's own time shows from 3 s in; the run began 2.2 s before the scene
  const stepSec = t - 10.0 + 2.2;
  setText(U.stt, t < runEnd && stepSec >= 3 ? S.stepSpan(stepSec) : '');
  setText(U.sd, S.span(120 + (t - 10.0)));
  setHTML(U.replyP, (done ? S.usageReply : typed(S.usageReply, t, writeAt, doneAt - 0.05)) + (writing ? '<span class="cursor"></span>' : ''));
  show(U.reply, writing || done); U.reply.style.display = writing || done ? '' : 'none';
  show(U.sfoot, !done); U.sfoot.style.display = done ? 'none' : '';
  show(U.rfoot, done); U.rfoot.style.display = done ? '' : 'none';
  U.C.stop.style.display = done ? 'none' : '';
  // the menu bar extra's menu: open from 10.55 until the pointer leaves for the window at 12.6
  const open = t >= 10.55 && t < 12.57;
  U.mx.classList.toggle('open', open);
  if (show(U.menu, open)) {
    const d = U.desk.getBoundingClientRect(), m = U.mx.getBoundingClientRect(), s = d.width / DESK.w;
    const x = Math.min((m.left - d.left) / s - 6, DESK.w - U.menu.offsetWidth - 10);
    css(U.menu, { x, y: (m.bottom - d.top) / s + 4, opacity: clamp(inv(10.55, 10.62, t)) * (1 - clamp(inv(12.55, 12.57, t))) });
  }
}

// ---------------------------------------------------------------- 14–19 · a video in the preview, annotated
function poseFiles(t) {
  const Pj = R.Pj;
  const kids = [Pj.srt, Pj.media, Pj.nbox, Pj.alist, Pj.sbar, Pj.mine, Pj.mineT, Pj.markT, Pj.endBtn, Pj.pend, Pj.mk];
  if (!panel(Pj.desk, t, 14.0, 18.95, DESK.x, DESK.y)) { kids.forEach(e => show(e, false)); return; }
  for (const ic of Pj.side.icons) if (ic.f) ic.f.set(t);
  const k = KP;
  const opened = t >= 14.62, playing = t >= 14.97, seeked = t >= 15.37, marked = t >= 15.77, saved = t >= 16.62, sent = t >= 17.5;
  // the tree's row moves to the video; the video is there at once, paused until its play button
  Pj.treeRows.forEach((r, i) => r.classList.toggle('on', opened ? i === 2 : i === 4));
  show(Pj.srt, !opened); Pj.srt.style.display = opened ? 'none' : '';
  show(Pj.media, opened); Pj.media.style.display = opened ? '' : 'none';
  setHTML(Pj.toggle, `${ic('message', 12, k)}<span>${S.annotations}${saved ? ' (1)' : ''}</span>`);
  Pj.toggle.classList.toggle('on', saved);
  // the list opens on the file's right once a draft is saved (min(320, 45%)); the video takes the room left
  const areaW = Pj.area.parentElement.offsetWidth;
  if (show(Pj.alist, saved)) { Pj.alist.style.display = ''; Pj.alist.style.width = `${Math.min(320 * k, areaW * 0.45)}px`; } else Pj.alist.style.display = 'none';
  const vt = !playing ? 0 : !seeked ? (t - 14.97) : SEEK + (t - 15.37);
  if (opened) {
    // media-fit.ts: the pane's width at the video's shape, smaller when the pane is short
    const aw = Pj.area.clientWidth - 32 * k, ah = Pj.area.clientHeight - 32 * k - (6 + 34 + 8 + 28) * k;
    const vw = Math.min(aw, ah * 16 / 9), vh = vw * 9 / 16;
    css(Pj.vid, { width: vw, height: vh });
    const [sun, h1, h2] = Pj.vid.querySelectorAll('.sun, .hill');
    css(sun, { left: vw * (0.68 - vt * 0.004), top: vh * (0.12 + vt * 0.002), width: vh * 0.34, height: vh * 0.34 });
    css(h1, { left: -vw * 0.1, top: vh * 0.66, width: vw * 0.8, height: vh * 0.6 });
    css(h2, { left: vw * 0.45, top: vh * 0.72, width: vw * 0.75, height: vh * 0.6 });
    // in the clip: Pudding hops along the hills (the reel's frames)
    const n = SP.pudding.hop, fr = Math.floor(vt * FPS) % n, src = `/sprites/pudding/hop/${String(fr + 1).padStart(4, '0')}.png`;
    if (Pj.vidImg.getAttribute('src') !== src) { Pj.vidImg.setAttribute('src', src); pending.push(Pj.vidImg.decode().catch(() => {})); }
    const sz = vh * 0.9;
    css(Pj.vidImg, { left: vw * (0.05 + ((vt * 0.03) % 0.7)) , top: vh * 0.86 - sz * SP.feetY, width: sz, height: sz });
    setHTML(Pj.avc.querySelector('.pp'), ic(playing ? 'pause' : 'play', 12, k));
    setText(Pj.avc.querySelector('.ct'), pclock(vt));
    setText(Pj.avc.querySelector('.rt'), `-${pclock(VIDEO_LEN - vt)}`);
    Pj.avc.querySelector('.bar i').style.width = `${(vt / VIDEO_LEN * 100).toFixed(2)}%`;
    Pj.ph.style.left = `${(vt / VIDEO_LEN * 100).toFixed(3)}%`;
    Pj.pend.style.left = Pj.mk.style.left = `${(MARK_AT / VIDEO_LEN * 100).toFixed(3)}%`;
  }
  show(Pj.pend, opened && marked && !saved); show(Pj.mk, opened && saved);
  // a draft's mark is the pane's colour in a dotted ring; sent, it is pending: filled, its list row too
  Pj.mk.classList.toggle('draft', !sent);
  Pj.alist.classList.toggle('sent', sent);
  setText(Pj.spill, sent ? S.pending : S.draft);
  Pj.segs.forEach((el, i) => setText(el, String([1, sent ? 1 : 0, 0, sent ? 0 : 1][i])));
  setHTML(Pj.ar3, sent ? `<span>${S.resolve}</span>` : `<span>${S.edit}</span><span>${S.del}</span>`);
  // 在此处批注 → the time and 到此为止 while the note is written; back once it is saved
  const writing = marked && !saved;
  Pj.markBtn.style.display = writing ? 'none' : ''; show(Pj.markBtn, opened);
  show(Pj.markT, opened && writing); Pj.markT.style.display = writing ? '' : 'none';
  show(Pj.endBtn, opened && writing); Pj.endBtn.style.display = writing ? '' : 'none';
  Pj.markBtn.classList.toggle('pressed', t >= 15.73 && t < 15.81);
  if (show(Pj.nbox, writing)) {
    const words = typed(S.note, t, 15.88, 16.4);
    setHTML(Pj.nf, words ? `${words}<span class="caret"></span>` : `<span class="caret"></span><span class="ph">${S.notePlaceholder}</span>`);
    Pj.save.classList.toggle('pressed', t >= 16.58 && t < 16.68);
  }
  // the send bar under the whole preview while the batch waits; your summary typed into it
  if (show(Pj.sbar, saved && !sent)) {
    Pj.sbar.style.display = '';
    const words = typed(S.summaryText, t, 17.06, 17.3);
    setHTML(Pj.sf, words ? `${words}${t < 17.46 ? '<span class="caret"></span>' : ''}` : `${t >= 17.02 ? '<span class="caret"></span>' : ''}<span class="ph">${S.summary}</span>`);
    Pj.sendBtn.classList.toggle('pressed', t >= 17.46 && t < 17.56);
  } else Pj.sbar.style.display = 'none';
  // sent: your line with the card under it in the session; Claude Code at work
  show(Pj.mine, sent); show(Pj.mineT, sent);
  Pj.mine.style.display = Pj.mineT.style.display = sent ? '' : 'none';
  if (sent) Pj.mine.style.opacity = clamp(inv(17.5, 17.62, t)).toFixed(3);
  setHTML(Pj.hdLine, sent ? `<span class="pd"></span><span>${S.live}</span>` : S.agentLine);
  Pj.hdLine.classList.toggle('quiet', !sent);
  Pj.chip.classList.toggle('hot', t > 14.45 && t < 14.7);
  // a closer look at the preview's file while the annotation is made, then down to the send bar and over to your line
  // (posed last: it reads where this frame has put things)
  // (the window keeps covering the desk where it did: it never moves in past its own edges)
  const z = E.inOut(inv(15.0, 15.4, t));
  if (z > 0) {
    const ZM = 1.42, wr = Pj.win.getBoundingClientRect(), sc = wr.width / Pj.win.offsetWidth;
    const at = (el, fy) => { const r = el.getBoundingClientRect(); return [(r.left - wr.left) / sc + el.offsetWidth / 2, (r.top - wr.top) / sc + (fy ?? el.offsetHeight / 2)]; };
    let [fx, fy] = at(Pj.area.parentElement, 170 * KP);
    const toBar = E.inOut(inv(16.75, 17.05, t)), toLine = E.inOut(inv(17.55, 17.95, t));
    if (toBar > 0) { const b = at(Pj.L2.card, Pj.L2.card.offsetHeight - 150 * KP); fx = lerp(fx, b[0], toBar); fy = lerp(fy, b[1], toBar); }
    if (toLine > 0 && Pj.mine.offsetWidth) { const m = at(Pj.mine); fx = lerp(fx, m[0], toLine); fy = lerp(fy, m[1], toLine); }
    const Z = lerp(1, ZM, z), sx = DESK.w / 2 - fx * ZM, sy = DESK.h / 2 - fy * ZM;
    const cx = clamp(sx, WIN.x + WIN.w - WIN.w * ZM, WIN.x), cy = clamp(sy, WIN.y + WIN.h - WIN.h * ZM, WIN.y);
    css(Pj.win, { x: lerp(WIN.x, cx, z), y: lerp(WIN.y, cy, z), s: Z });
  } else css(Pj.win, { x: WIN.x, y: WIN.y, s: 1 });
}

// ---------------------------------------------------------------- 19–24 · the Bots become the map's characters
function poseFolk(t) {
  const Fw = R.Fw;
  const kids = [Fw.reply, Fw.sfoot];
  if (!panel(Fw.desk, t, 19.0, 23.95, DESK.x, DESK.y)) { kids.forEach(e => show(e, false)); return; }
  // which of them works, and how, once they are characters (each by its name's character)
  const WORKS = ['running', 'replying', 'replying', 'running', 'running', 'replying', 'running'];
  Fw.side.rows.forEach((r, i) => {
    const a = 19.7 + i * 0.13, u = inv(a, a + 0.12, t), v = E.pop(inv(a + 0.08, a + 0.42, t));
    show(r.old.box, t < a + 0.12); r.old.box.style.opacity = (1 - u).toFixed(3); r.old.box.style.scale = lerp(1, 0.7, E.in(u)).toFixed(3);
    show(r.newBox, t >= a + 0.08); r.newBox.style.scale = lerp(0.6, 1, v).toFixed(3); r.newBox.style.opacity = clamp(inv(a + 0.08, a + 0.16, t)).toFixed(3);
    const busyAt = 20.95 + i * 0.09, busy = t >= busyAt;
    r.status(busy ? (WORKS[i] === 'running' ? S.stThinking : S.stReplying) : '');
    r.f.set(t - busyAt, busy ? WORKS[i] : 'idle');
    r.f.dot(t, busy, i === 2 ? 'var(--pane)' : undefined);
    r.old.f.set(t);
  });
  // the open direct (the third Bot): its reply streaming once it replies
  const busy3 = t >= 20.95 + 2 * 0.09;
  Fw.C.f.set(t, busy3 ? 'replying' : 'idle'); Fw.L.tabs[0].f.set(t, busy3 ? 'replying' : 'idle'); show(Fw.L.tabs[0].busy, busy3);
  poseBusy(Fw.C, null, busy3 ? S.stReplying : '');
  setHTML(Fw.replyP, typed(S.folkReply, t, 21.3, 23.6) + '<span class="cursor"></span>');
  show(Fw.reply, busy3); show(Fw.sfoot, busy3);
  setText(Fw.sd, S.span(Math.max(0, t - 21.1) + 4.2));
}

// ---------------------------------------------------------------- the cast beside each scene
function poseCast(t) {
  const { mochi, pudding, reviewer } = R.cast;
  // Pudding, who stayed from the opening, presents the window as it folds
  if (t >= 4.0 && t < 9.95) {
    const s = seq(t, [[4.0, 'idle', true], [5.4, 'present'], [6.6, 'idle', true], [7.35, 'present'], [8.6, 'nod'], [9.2, 'idle', true], [9.55, 'hop']]);
    pudding.pose({ ...s, x: t < 9.55 ? 1660 : hopX(t, 9.55, 1660, 2150), s: 440, flip: true });
  }
  // the Reviewer leans in to the menu's lines and nods them off
  if (t >= 9.9 && t < 14.3) {
    const s = seq(t, [[9.9, 'hop'], [10.62, 'think', true], [11.0, 'inspect'], [12.25, 'think', true], [12.75, 'nod'], [13.95, 'hop']]);
    const x = t < 13.95 ? hopX(t, 9.9, 2150, 1640) : hopX(t, 13.95, 1640, 2200);
    reviewer.pose({ ...s, x, s: 400, flip: t < 13.95 });
  }
  // Mochi follows the video and points at the card it sends
  if (t >= 13.9 && t < 19.3) {
    const s = seq(t, [[13.9, 'hop'], [14.62, 'idle', true], [15.75, 'point'], [16.5, 'type', true], [17.55, 'point'], [18.3, 'nod'], [18.9, 'hop']]);
    const x = t < 18.9 ? hopX(t, 13.9, 2150, 1640) : hopX(t, 18.9, 1640, 2200);
    mochi.pose({ ...s, x, s: 430, flip: t < 18.9 });
  }
  // the roster: Pudding and the Reviewer come to look, and cheer the characters
  if (t >= 19.2 && t < 23.62) {
    const s = seq(t, [[19.2, 'hop'], [19.92, 'idle', true], [20.4, 'nod'], [21.0, 'idle', true], [22.25, 'cheer'], [23.45, 'idle', true]]);
    pudding.pose({ ...s, x: hopX(t, 19.2, 2150, 1585), s: 400, flip: true });
  }
  if (t >= 19.45 && t < 24.0) {
    const s = seq(t, [[19.45, 'hop'], [20.17, 'inspect'], [21.4, 'think', true], [22.35, 'cheer'], [23.55, 'hop']]);
    const x = t < 23.55 ? hopX(t, 19.45, 2200, 1765) : hopX(t, 23.55, 1765, 1160);
    reviewer.pose({ ...s, x, s: 360, flip: true });
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
    R.cast.mochi.pose({ ...seq(t, [[23.6, 'hop'], [24.32, 'idle', true], [25.3, 'cheer']]), x: hopX(t, 23.6, -200, 760), s: 430, flip: false });
    R.cast.pudding.pose({ ...seq(t, [[23.62, 'hop'], [24.34, 'idle', true], [25.42, 'cheer']]), x: hopX(t, 23.62, 1585, 960), s: 380, flip: true });
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
  poseNative(t);
  poseUsage(t);
  poseFiles(t);
  poseFolk(t);
  poseCast(t);
  poseMore(t);
  poseEnd(t);
  for (const k in R.cast) show(R.cast[k].el, R.cast[k].on);
  poseHeads(t);
  posePointer(t);
  await Promise.all(pending);
}

// ---------------------------------------------------------------- sound cues: name, film time, what it marks
// (every name is one of ../release/mix.py's ROUTE)
const FOLD_CUES = [F1, F2].flatMap(a => [['tap', a - 0.05, '⌘B'], ['swish', a, 'the edge moves'], ['tick', a + FOLD_D * 0.75, 'the icons settle']]);
const CUES = [
  ['whoosh', 0.05, 'Mochi hops in'], ['whoosh', 0.35, 'Pudding hops in'], ['pop', 0.4, 'the name'], ['tick', 0.65, '0.4.0'],
  ['swish', 1.98, 'the digit rolls'], ['done', 2.0, '0.5.0 lands'], ['pop', 2.15, 'the count'], ...P.chips.map((c, i) => ['tick', 2.45 + i * 0.15, 'a platform']),
  ['whoosh', 4.15, 'the window'], ...FOLD_CUES,
  ['whoosh', 9.55, 'Pudding leaves'], ['whoosh', 9.9, 'the Reviewer'], ['whoosh', 9.95, 'the window under the menu bar'],
  ['click', 10.55, 'the menu bar extra'], ['pop', 10.58, 'its usage lines'], ['check', 13.45, 'the turn finishes on'],
  ['whoosh', 13.9, 'Mochi'], ['whoosh', 14.0, 'the project session'], ['click', 14.58, 'the file'], ['pop', 14.62, 'the video, at once'],
  ['click', 14.95, 'play'], ['tick', 15.35, 'seek'], ['click', 15.75, 'annotate here'], ['click', 16.6, 'save draft'], ['pop', 16.64, 'the send bar'],
  ['enter', 17.48, 'send the batch'], ['check', 17.52, 'your line with its card'],
  ['whoosh', 19.0, 'the roster'], ['whoosh', 19.2, 'Pudding'], ['whoosh', 19.45, 'the Reviewer'],
  ...S.bots.map((b, i) => ['tick', 19.78 + i * 0.13, 'a character']), ['pop', 20.95, 'at work'], ['pop', 22.3, 'a cheer'],
  ['whoosh', 23.6, 'down to the front'], ['tick', 24.15, 'chip'], ['tick', 24.31, 'chip'], ['tick', 24.47, 'chip'], ['tick', 24.63, 'chip'], ['tick', 24.79, 'chip'], ['tick', 24.95, 'chip'], ['pop', 25.3, 'cheer'],
  ['whoosh', 26.45, 'onto the mark'], ['tap', 27.05, 'white circle'], ['tap', 27.2, 'mustard circle']
];

// ---------------------------------------------------------------- boot
async function boot() {
  SP = await (await fetch('/sprites/sprites.json')).json();
  FOLK = await (await fetch('/work/folk.json')).json();
  // each layer once, as a blob the folks' images share
  const blobs = set => Object.fromEntries(Object.entries(set.layers).map(([n, b64]) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return [n, URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }))];
  }));
  layerURL = { now: blobs(FOLK.now), then: blobs(FOLK.then) };
  await Promise.all([document.fonts.load('700 76px "DF Sans"'), document.fonts.load('600 30px "DF Mono"'), document.fonts.load('600 40px "PingFang SC"', '交'), document.fonts.load('400 40px "PingFang SC"', '交')]);
  await document.fonts.ready;
  build();
  // every folk layer decoded before the first frame: a render worker starts at any frame
  await Promise.all([...document.querySelectorAll('.folk img')].map(i => i.decode().catch(() => {})));
  measure();
  M.lockX = (1920 - (200 + 40 + M.wordW + 30 + M.endVerW)) / 2; M.lockY = 230;
  window.film.ready = true;
  await seek(0);
}
window.film = { duration: DURATION, seek, ready: false, cues: CUES, keys: [], lang: LANG };
boot();
