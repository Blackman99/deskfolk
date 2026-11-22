// The Deskfolk 0.6.0 release film: the reel's cast (Mochi, Pudding and the Reviewer) presents 0.6.0 on the native
// app's own surfaces, redrawn (apps/desktop-nsh, the same app on macOS, Windows and Linux, and its web build on the
// phone). film.seek(t) poses everything from t alone and resolves once the sprites it chose have decoded.
// Timeline (120 BPM, a bar every 2 s, the 0.1.0 film's music edit): 0 0.5.1 turns over to 0.6.0 · 4 one app on three
// desktops: a Mac, a Windows and a Linux window; on Windows a phone is paired with Windows Hello, the window is closed
// to the tray and a toast brings it back · 10 a project session's agent asks three questions on one card (the song's
// breakdown) · 14 the phone's page: a file opens over the screen, a back swipe shows the conversation under it, the
// terminal reattaches · 19 a line flies from the box into the conversation (4× slower); files dropped onto the
// composer · 24 and more · 26.5 the mark, the URL on the final hit (28.0).
import { clamp, lerp, inv, E, css, h } from '/launch/lib.js';
import { STR } from './strings.js';

const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const S = STR[LANG];
const P = S.platforms;
const DURATION = 30.5;
const FPS = 30;
const GY = 905; // the ground line the cast stands on
let SP = null; // sprites.json (the reel's): frames per move, and where the feet are in a frame
let FOLK = null; // folk.json (folk.mjs): the app's folk layers and its icon

// ---------------------------------------------------------------- scale, geometry and icons
// The app's surfaces are drawn at k times their size in the app (film.css --k): the three desktops' windows at KD,
// the questions' at KA, the send's at KS, the phone's page at KPH.
const KD = 1.3, KA = 1.2, KS = 1.3, KPH = 0.88;
// A desk (the wallpaper) with the window on it; on Windows the window stands above the taskbar (48 pt).
const DESK = { x: 96, y: 246, w: 1300, h: 780 }, WIN = { x: 34, y: 30, w: 1232, h: 720 }, WINW = { x: 34, y: 22, w: 1232, h: 668 };
// The sidebar's width (sidebar-width.ts SIDEBAR_DEFAULT).
const SIDE = 260;
// The app's one icon set (apps/desktop-nsh/app/src/m/icons.ts), the shapes this film draws, copied as they are;
// stroked with the app's 1.6 px pen at the role size. `f` fills a shape.
const FILE = 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z';
const FOLDER = 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z';
const PIN_HEAD = 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z';
const GEAR = 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';
const BOX = 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z';
const BUBBLE = 'M20.5 15a2 2 0 0 1-2 2H7.5l-4 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z';
const BELL = 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9';
const ICONS = {
  x: [{ p: 'M6 6l12 12M18 6 6 18' }],
  check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
  terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
  clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
  'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
  'chevron-up': [{ p: 'm18 15-6-6-6 6' }],
  'chevron-left': [{ p: 'm15 6-6 6 6 6' }],
  'chevron-right': [{ p: 'm9 6 6 6-6 6' }],
  plus: [{ p: 'M12 5v14M5 12h14' }],
  'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
  folder: [{ p: FOLDER }],
  file: [{ p: FILE }, { p: 'M14 3v5h5' }],
  image: [{ r: [3, 3, 18, 18, 2.5] }, { c: [9, 9, 2] }, { p: 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21' }],
  message: [{ p: BUBBLE }],
  'message-fill': [{ p: BUBBLE, f: 1 }],
  paperclip: [{ p: 'm21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
  minimap: [{ r: [3, 3, 18, 18, 2.5] }, { r: [12, 12, 6, 6, 1] }],
  pin: [{ p: 'M12 17v5' }, { p: PIN_HEAD }],
  more: [{ c: [5.5, 12, 1.6], f: 1 }, { c: [12, 12, 1.6], f: 1 }, { c: [18.5, 12, 1.6], f: 1 }],
  activity: [{ p: 'M22 12h-4l-3 9L9 3l-3 9H2' }],
  target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1.5] }],
  search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.5-3.5' }],
  sparkles: [{ p: 'M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z' }, { p: 'M20 3v4M22 5h-4' }],
  stop: [{ r: [6.5, 6.5, 11, 11, 2.5], f: 1 }],
  hierarchy: [{ r: [8, 2.5, 8, 6, 1.5] }, { p: 'M12 8.5v3M5.5 14v-2.5h13V14' }, { r: [2, 14, 7, 6, 1.5] }, { r: [15, 14, 7, 6, 1.5] }],
  settings: [{ p: GEAR }, { c: [12, 12, 3] }],
  grid: [{ r: [3.5, 3.5, 7, 7, 1.5] }, { r: [13.5, 3.5, 7, 7, 1.5] }, { r: [3.5, 13.5, 7, 7, 1.5] }, { r: [13.5, 13.5, 7, 7, 1.5] }],
  'sidebar-close': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'M9 3v18' }, { p: 'm16 15-3-3 3-3' }],
  'help-circle': [{ c: [12, 12, 9] }, { p: 'M9.5 9.5a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2.2-2.5 3.8M12 17.5h.01' }],
  mic: [{ r: [9, 2.5, 6, 11.5, 3] }, { p: 'M19 10v1a7 7 0 0 1-14 0v-1M12 18v3.5' }],
  download: [{ p: 'M12 4v11M7 10l5 5 5-5M5 20h14' }],
  keyboard: [{ r: [2.5, 4.5, 19, 12, 2] }, { p: 'M6.5 8.5h.01M10 8.5h.01M14 8.5h.01M17.5 8.5h.01M7.5 12.5h9' }],
  clipboard: [{ r: [8, 2.5, 8, 4, 1] }, { p: 'M16 4.5h1.5A2.5 2.5 0 0 1 20 7v12.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5V7a2.5 2.5 0 0 1 2.5-2.5H8' }],
  calendar: [{ r: [3.5, 5, 17, 16, 2.5] }, { p: 'M3.5 10h17M8 3v4M16 3v4' }],
  dollar: [{ p: 'M12 2v20' }, { p: 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' }],
  gauge: [{ p: 'm12 14 4-4' }, { p: 'M3.3 19a10 10 0 1 1 17.4 0' }],
  nodes: [{ c: [5, 6, 2] }, { c: [19, 6, 2] }, { c: [12, 18, 2] }, { p: 'M7 6h10M6 8l5 8M18 8l-5 8' }],
  archive: [{ r: [3, 4, 18, 5, 1.5] }, { p: 'M5 9v8.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V9M10 13h4' }],
  info: [{ c: [12, 12, 9] }, { p: 'M12 16v-4.5M12 8h.01' }],
  box: [{ p: BOX }, { p: 'm3.3 7 8.7 5 8.7-5M12 22V12' }],
  type: [{ p: 'M4 7V4h16v3' }, { p: 'M9 20h6M12 4v16' }],
  bell: [{ p: BELL }, { p: 'M10.3 21a1.94 1.94 0 0 0 3.4 0' }],
  server: [{ r: [3, 3.5, 18, 7, 2] }, { r: [3, 13.5, 18, 7, 2] }, { p: 'M7 7h.01M7 17h.01' }],
  sliders: [{ p: 'M4 7h9M17 7h3M4 17h3M11 17h9' }, { c: [15, 7, 2] }, { c: [9, 17, 2] }],
  'terminal-square': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'm7.5 9.5 2.5 2.5-2.5 2.5M12.5 14.5h4' }],
  smartphone: [{ r: [7, 2.5, 10, 19, 2.5] }, { p: 'M11 5.5h2' }]
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
// Windows' caption glyphs (NSH draws Segoe's at size 10, a hairline pen): minimize, maximize, close
const CAP = {
  min: '<svg viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>',
  max: '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  close: '<svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>'
};
// GTK's symbolic window icons, drawn plainly
const GTKI = {
  min: '<svg viewBox="0 0 16 16"><path d="M4.5 11h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  max: '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
};
function markSVG(size) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64"><path d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z" fill="#146a7c"/>` +
    `<circle class="mf" cx="25" cy="29" r="10.5" fill="#ffffff"/><circle class="mm" cx="39.5" cy="29" r="10.5" fill="#f0ab3d" stroke="#146a7c" stroke-width="3"/></svg>`;
}
// an agent's mark, a plain tile: the app shows the agent's own logo there
const agentTile = (k, role = 16, px = null) => `<span class="atile"${px ? ` style="width:${px * k}px;height:${px * k}px"` : ''}>${ic('terminal', role, k)}</span>`;
const setHTML = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let ICON_URL = ''; // the app's icon (apps/desktop-nsh/assets/icons/app-icon.svg), as a blob

// ---------------------------------------------------------------- the folk (a Bot's avatar)
// packages/protocol/src/folk-avatar.ts: the name's hash picks every trait, the character last; boring-avatars.ts hashCode.
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
  caramel: { fig: stops(1200, [[0, { sx: 1, sy: 1 }], [54, { sx: 1, sy: 1 }], [58, { sx: 1.03, sy: 0.96 }], [66, { sx: 0.99, sy: 1.01 }], [74, { sx: 1, sy: 1 }], [100, { sx: 1, sy: 1 }]], { e: null }) },
  sesame: { fig: stops(3000, [[0, { r: -1, y: 0 }], [50, { r: -2.5, y: 0.4 }], [100, { r: -1, y: 0 }]]) },
  blueberry: { fig: lift(2000, -2.9) }
};
const ANTENNA = rot(800, -8, 8); // at work every antenna sways (figureSpecs)
const WORK_STILL = { matcha: { armL: -12 } };
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
let layerURL = null;

/**
 * A Bot's folk, as FolkAvatar.tsx stacks it: the body, its antenna, each arm turning about its shoulder with what its
 * hand holds turning about the hand, the eyes and their blink, the mouth, what sits over the face; mirrored when its
 * look says so; a raised arm at rest when it waves. `set(t, motion)`: idle, running (it works and three dots go over
 * its head) or replying (it works, mouth going).
 */
function folk(name, edgePx) {
  const look = folkLook(name), urls = layerURL, G = FOLK.now.geometry;
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
  const part = p => `${look.character}-${p}`;
  img(fig, part('body'));
  const ant = img(fig, part('antenna'));
  if (ant) ant.style.transformOrigin = origin(G.antenna);
  const armL = h('div', 'fl', null, fig), armR = h('div', 'fl', null, fig);
  armL.style.transformOrigin = origin(G.shoulderL); armR.style.transformOrigin = origin(G.shoulderR);
  img(armL, part('arm-l'));
  const heldL = img(armL, part('held-l'));
  img(armR, part('arm-r'));
  const heldR = img(armR, part('held-r'));
  if (heldL) heldL.style.transformOrigin = origin(G.handL);
  if (heldR) heldR.style.transformOrigin = origin(G.handR);
  const eyes = img(fig, `eyes-${look.eyes}`), closed = img(fig, 'eyes-closed');
  const mouth = img(fig, `mouth-${look.mouth}`), open = img(fig, 'mouth-open');
  img(fig, part('front'));
  const dots = h('div', 'fl', null, el);
  const dotEls = [74, 83, 92].map(x => { const d = h('div', 'fdot', null, dots); d.style.left = `${x - 3.6}%`; return d; });
  const blinkDelay = (look.hash % 52) * 100;
  const f = {
    el, look,
    set(t, motion = 'idle') {
      const ms = t * 1000, working = motion === 'running' || motion === 'replying';
      const work = WORK[look.character], kk = (edgePx * (0.19 / 0.31)) / 45;
      fig.style.transform = working ? tf(specAt(work.fig, ms), kk) : '';
      if (ant) ant.style.transform = working ? tf(specAt(work.antenna ?? ANTENNA, ms)) : '';
      const raised = motion === 'idle' && look.wave;
      const still = working ? (WORK_STILL[look.character]?.armL ?? 0) : 0;
      armL.style.transform = `rotate(${still}deg) ${working && work.armL ? tf(specAt(work.armL, ms)) : ''}`;
      armR.style.transform = `rotate(${raised ? -160 : 0}deg) ${working && work.armR ? tf(specAt(work.armR, ms)) : ''}`;
      if (heldL) heldL.style.transform = working && work.heldL ? tf(specAt(work.heldL, ms)) : '';
      if (heldR) heldR.style.transform = working && work.heldR ? tf(specAt(work.heldR, ms)) : '';
      const b = (((ms - blinkDelay) % 5200) + 5200) % 5200 / 5200, shut = b > 0.935 && b < 0.965;
      eyes.style.opacity = shut ? 0 : 1; closed.style.opacity = shut ? 1 : 0;
      const eyeShift = motion === 'running' ? -0.025 * edgePx : 0;
      eyes.style.transform = closed.style.transform = `translateY(${eyeShift.toFixed(2)}px)`;
      const talk = motion === 'replying' && (ms % 340) >= 170;
      mouth.style.opacity = talk ? 0 : 1; open.style.opacity = talk ? 1 : 0;
      dots.style.display = motion === 'running' ? '' : 'none';
      if (motion === 'running') dotEls.forEach((d, i) => {
        const u = ((((ms - i * 200) % 1200) + 1200) % 1200) / 1200, seg = u * 3;
        const o = seg < 1 ? lerp(0.25, 1, seg) : seg < 2 ? lerp(1, 0.25, seg - 1) : 0.25;
        const y = seg < 1 ? lerp(0, -0.03, seg) : seg < 2 ? lerp(-0.03, 0, seg - 1) : 0;
        d.style.opacity = o.toFixed(3); d.style.transform = `translateY(${(y * edgePx).toFixed(2)}px)`;
      });
    }
  };
  f.set(0);
  return f;
}
// SessionAvatar.tsx DOT: the status dot's edge and ring by avatar size (md 40, top 36)
const DOT = { 40: [9.5, 2], 36: [9, 2], 48: [11, 2] };
/** A folk in a box of `edge` app pt at scale k; `f.dot(t, on, ring)` is SessionAvatar's status dot, pulsing once a second. */
function folkBox(name, edge, k) {
  const box = h('span', null, null);
  Object.assign(box.style, { display: 'inline-block', position: 'relative', width: `${edge * k}px`, height: `${edge * k}px`, flex: 'none' });
  const f = folk(name, edge * k);
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

// ---------------------------------------------------------------- the send flight (send-flight.tsx, every number)
// Telegram's own transition: across 300 ms on cubic-bezier(0.23, 1, 0.32, 1), up 300 ms on cubic-bezier(0.199, 0.011,
// 0.279, 0.910), at once; the box's words fade out over 150 ms and the bubble in over 180 ms (ease-out); the row takes
// over at 330 ms. The film plays it 4× slower and says so on screen: nine frames are too quick to read.
const ACROSS = bezier(0.23, 1, 0.32, 1), RISE = bezier(0.199, 0.011, 0.279, 0.910), EASE_OUT = bezier(0, 0, 0.58, 1);
const SLOW = 4, FLY = { across: 0.3 * SLOW, rise: 0.3 * SLOW, wordsOut: 0.15 * SLOW, bubbleIn: 0.18 * SLOW, land: 0.33 * SLOW };

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
/** Shown and in layout, or neither (a hidden parent does not hide a child shown on its own). */
const shown = (el, on) => { el.style.display = on ? '' : 'none'; show(el, on); return on; };
/** A scene's panel: rises in at a, sinks out by b. */
function panel(el, t, a, b, x, y) {
  el.style.display = t >= a && t < b ? '' : 'none';
  if (!show(el, t >= a && t < b)) return false;
  const u = E.out4(inv(a, a + 0.4, t)), o = E.in(inv(b - 0.3, b, t));
  el.style.transformOrigin = '50% 50%';
  css(el, { x, y: y + lerp(40, 0, u) - 24 * o, s: lerp(0.97, 1, u), opacity: Math.min(u, 1 - o) });
  return true;
}
/** What has been typed of `text` by t, typing from a to b. */
const typed = (text, t, a, b) => [...text].slice(0, Math.round([...text].length * clamp(inv(a, b, t)))).join('');
const keysOf = (text, a, b) => [...text].map((_, i) => a + (b - a) * (i + 1) / [...text].length);

// ---------------------------------------------------------------- DOM
const R = {};

/**
 * A desk with the native window on it, framed as each system frames it (window-chrome.ts, Shell.tsx, win.rs, gtk.rs):
 * on a Mac the window's glass and the traffic lights, the main column 6 down; on Windows Mica under the sidebar and
 * NSH's caption buttons over the top right, the main column at the top; on Linux an opaque ground and GTK's controls.
 */
function deskWindow(k, { win = WIN, chrome = 'mac', wall = '' } = {}) {
  const desk = h('div', 'abs desk', null, stage);
  css(desk, { width: DESK.w, height: DESK.h });
  const wallHTML = `<div class="wall ${wall}" style="width:${DESK.w}px;height:${DESK.h}px"></div>`;
  desk.insertAdjacentHTML('beforeend', wallHTML);
  const w = h('div', `abs win plat-${chrome}`, null, desk);
  css(w, { x: win.x, y: win.y, width: win.w, height: win.h });
  w.style.setProperty('--k', k);
  if (chrome === 'linux') h('div', 'opaque', null, w);
  else {
    const blur = h('div', 'blur', wallHTML, w);
    css(blur, { left: -win.x, top: -win.y, width: DESK.w, height: DESK.h });
    h('div', 'wash', null, w); h('div', 'shellg', null, w);
  }
  const W = { desk, win: w, k, chrome, rect: win, wpt: win.w / k, hpt: win.h / k };
  W.frame = h('div', 'sframe', null, w);
  W.frame.style.width = `${SIDE * k}px`;
  W.main = h('div', 'main', null, w);
  W.main.style.left = `${(SIDE * k).toFixed(2)}px`;
  if (chrome !== 'mac') W.main.style.top = '0px';
  if (chrome === 'mac') h('div', 'lights', '<i></i><i></i><i></i>', w);
  if (chrome === 'win') { W.caps = h('div', 'caps', `<i>${CAP.min}</i><i>${CAP.max}</i><i>${CAP.close}</i>`, w); W.close = W.caps.lastElementChild; }
  if (chrome === 'linux') h('div', 'gtk', `<i>${GTKI.min}</i><i>${GTKI.max}</i><i>${GTKI.close}</i>`, w);
  return W;
}

/**
 * The open sidebar (Sidebar.tsx): the brand row (the mark, 84 in on a Mac behind the lights, 16 in elsewhere), the
 * search well, the Bots' directs (each a folk), the 项目 section's folder with its sessions, the foot.
 */
function sidebar(W, roster, { project = null } = {}) {
  const k = W.k;
  const sb = h('div', 'sb', null, W.frame);
  sb.style.width = `${SIDE * k}px`;
  const brand = h('div', 'brand', `${markSVG(22 * k)}<span class="sp"></span><span class="tg">${ic('activity', 20, k)}</span><span class="tg">${ic('target', 20, k)}</span><span class="tg">${ic('sidebar-close', 20, k)}</span>`, sb);
  if (W.chrome !== 'mac') brand.style.paddingLeft = `${16 * k}px`;
  const srch = h('div', 'srch', `<span class="si">${ic('search', 16, k)}</span>`, sb);
  h('span', null, S.search, srch); h('kbd', null, W.chrome === 'mac' ? '⌘K' : 'Ctrl+K', srch); // searchShortcutLabel (m/keymap.ts formatShortcut)
  const list = h('div', 'list', null, sb);
  h('div', 'ghead first', `<span>${S.botsTab}</span><span class="gadd">+</span>`, list);
  const rows = roster.map(b => {
    const row = h('div', `row${b.on ? ' on' : ''}`, null, list);
    const av = h('span', 'av', null, row);
    const fb = folkBox(b.name, 40, k);
    av.appendChild(fb.box);
    const tx = h('div', 'tx', `<div class="l1"><span class="t">${b.name}</span><span class="rt">${b.time}</span></div>` +
      `<div class="l2"><span class="rs"><i></i><span class="rst"></span></span><span class="s">${b.prev}</span></div>`, row);
    const r = { row, av, f: fb.f, s: tx.querySelector('.s'), rst: tx.querySelector('.rst'), name: b.name };
    r.status = label => { row.classList.toggle('busy', !!label); setText(r.rst, label || ''); };
    return r;
  });
  const p = project ?? { dir: S.proj.dir, title: S.proj.title, prev: S.proj.prev, time: '10:12', on: false };
  h('div', 'ghead', `<span>${S.section}</span><span class="gadd">+</span>`, list);
  h('div', 'dirrow', `${ic('chevron-down', 12, k)}${ic('folder', 16, k)}<span>${p.dir}</span>`, list);
  const ps = h('div', 'psess', null, list);
  const prow = h('div', `row${p.on ? ' on' : ''}`, `<span class="av">${agentTile(k)}</span>`, ps);
  h('div', 'tx', `<div class="l1"><span class="t">${p.title}</span><span class="rt">${p.time}</span></div><div class="l2"><span class="s">${p.prev}</span></div>`, prow);
  const foot = h('div', 'foot', null, sb);
  const fa = (icon, label, cls = '', tail = '') => { const a = h('span', `fa ${cls}`, ic(icon, 16, k), foot); h('span', 'flab', label, a); if (tail) h('span', 'flab', tail, a); return a; };
  fa('folder', S.workspace); fa('grid', S.tools, '', ic('chevron-up', 12, k, 'opacity:.65')); fa('settings', S.settings, 'end');
  // SidebarFoot.tsx: when its words do not fit, it keeps its icons only
  if ([...foot.children].reduce((w, a) => w + a.offsetWidth, 0) + 8 * k > foot.clientWidth - 16 * k) foot.classList.add('icons');
  return { sb, rows };
}

/** A pane (WorkbenchLeaf.tsx): its tab strip (tabs 4 pt apart, the active one's ⋯ and ×, then +) and its card. */
function leaf(W, tabs) {
  const k = W.k;
  const el = h('div', 'leaf', null, W.main);
  const strip = h('div', 'tabs', null, el);
  const tabEls = tabs.map(tb => {
    const slot = h('span', 'tabslot', null, strip);
    const tab = h('span', `tab${tb.on ? ' on' : ''}`, null, slot);
    const av = h('span', 'tav', null, tab);
    let f = null;
    if (tb.bot) { const fb = folkBox(tb.bot, 20, k); av.appendChild(fb.box); f = fb.f; }
    else av.innerHTML = agentTile(k, 12, 20);
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
/** The Bot's picker (TunePicker: the runner's mark, model · level, the chevron). */
const tuneOf = K => `<span class="atile">${ic('terminal', 10, K)}</span><span>${S.modelDefault}<span class="sep"> · </span>${S.effortDefault}</span><span class="arr">${ic('chevron-down', 12, K)}</span>`;
/** A Bot's direct in a card: the header (PaneChatBar.tsx), the transcript, the composer (Composer.tsx). */
function botChat(W, L, bot) {
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
  const atts = h('div', 'atts', null, comp);
  atts.style.display = 'none';
  const txt = h('div', 'txt', `<span class="ph">${S.placeholder(bot)}</span>`, comp);
  h('span', 'cb', ic('paperclip', 20, k), comp);
  h('span', 'tune', tuneOf(k), comp);
  h('span', 'gap', null, comp);
  h('span', 'cb', ic('mic', 20, k), comp);
  const spark = h('span', 'cb', ic('sparkles', 16, k), comp);
  const stop = h('span', 'cb stop', ic('stop', 20, k), comp);
  const send = h('span', 'cb send off', ic('arrow-up', 20, k), comp);
  stop.style.display = 'none';
  return { hd, f: fb.f, st, tr, tri, col, comp, atts, txt, spark, stop, send };
}
/** A finished reply's last line: how long it took and when (TranscriptBotGroup). */
const replyFoot = (k, took, time) => `${ic('clock', 12, k)}<span>${took}</span><span style="opacity:.6">·</span><span>${time}</span>`;
/** The Bot's state in the header's second line. */
const poseBusy = (C, label) => setHTML(C.st, label ? `<span class="pd"></span><span>${label}</span>` : '');

// ---- 4–10: the pairing on Windows: the hosts' and the phone's fingerprints (64 hex, made up), the phone's user agent
const HOST_FP = '7c41e09ab35d2f86c10e94b7d2a6f3580be19c7d44a2e65f3b08d1c9a76e2f41';
const DEV_FP = '3f9ac2e817b04d6a95e2c03f7b18d4e6a0c59f2b31d7e8a4c6f0b92d5e17a3c8';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const DEVICE = 'Android Chrome';
const fp4 = hex => hex.match(/.{4}/g).join(' ');
const PAIR_CODE = 'rb1.eyJyIjoiaHR0cHM6Ly9yZWxheS5leGFtcGxlLmNvbSIsImkiOiJzdHVkaW8iLCJrIjoiN2NRMnhWOWFMcjRUIn0.Gm7k2Q';
// the toast's and the taskbar's words: the system's frame, the app's icon and words (strings.js `toast`)

function build() {
  R.dim = document.getElementById('dusk');
  R.cast = { mochi: new Actor('mochi'), pudding: new Actor('pudding'), reviewer: new Actor('reviewer') };
  const bots = S.bots;

  // ---- 0–4 the release: 0.5.1 turns over to 0.6.0, then the platforms (strings.js `platforms.chips`)
  R.badge = h('div', 'abs', null, stage);
  R.bMark = h('div', 'abs', markSVG(200), R.badge);
  R.bWord = h('div', 'abs word', S.word, R.badge);
  const [major, minor, patch] = S.version.split('.'), [, fromMinor, fromPatch] = S.from.split('.');
  R.ver = h('div', 'abs ver', `<span>${major}.</span><span class="roll"><span class="col"><span>${fromMinor}</span><span>${minor}</span></span></span>` +
    `<span>.</span><span class="roll"><span class="col"><span>${fromPatch}</span><span>${patch}</span></span></span>`, R.badge);
  R.rolls = [...R.ver.querySelectorAll('.roll')]; R.rollCols = [...R.ver.querySelectorAll('.col')];
  R.count = h('div', 'abs pill count', `${ic('check', 12, 1.5)}${S.count}`, R.badge);
  R.plat = P.chips.map(c => h('div', `abs platform${c.quiet ? ' quiet' : ''}`, `${ic(c.icon || 'check', 16, 1.5)}<span>${c.text}</span>` +
    `${c.new ? `<span class="new">${c.new}</span>` : ''}${c.tail ? `<span class="tail">· ${c.tail}</span>` : ''}`, stage));

  // ---- 4–10 one app on three desktops; on Windows: pairing with Windows Hello, the tray, a toast
  const rosterA = [0, 1, 2, 3].map(i => ({ ...bots[i], on: i === 0 }));
  const deskOf = (chrome, wall, win) => {
    const W = deskWindow(KD, { win, chrome, wall });
    W.side = sidebar(W, rosterA);
    W.L = leaf(W, [{ bot: bots[0].name, label: bots[0].name, on: true }, { bot: bots[1].name, label: bots[1].name }]);
    W.C = botChat(W, W.L, bots[0].name);
    h('div', 'you', S.dmAsk, W.C.col); h('div', 'youT', '10:57', W.C.col);
    W.reply = h('div', 'reply', `<p>${S.dmReply}</p>`, W.C.col);
    W.rfoot = h('div', 'rfoot', replyFoot(KD, S.span(41.6), '10:58'), W.C.col);
    return W;
  };
  R.Dm = deskOf('mac', '', WIN);
  R.Dl = deskOf('linux', 'l', WIN);
  const Wd = R.Dw = deskOf('win', 'w', WINW);
  // on Windows 剪辑 is still at work when the window is put away; its reply comes while it is hidden
  Wd.sfoot = h('div', 'sfoot', `<span class="pulse"></span><span class="sst">${S.thinking}</span><span class="dur">${ic('clock', 12, KD)}<span class="d"></span></span>`, Wd.C.col);
  Wd.sd = Wd.sfoot.querySelector('.d');
  Wd.C.col.insertBefore(Wd.sfoot, Wd.reply);
  // the taskbar's notification area: the overflow chevron, the app's icon, the clock (no Start button is drawn)
  Wd.task = h('div', 'taskbar', `<span class="chev">${ic('chevron-up', 16, KD)}</span><span class="ti"><img src="${ICON_URL}"></span><span class="clk">${P.clock[0]}<br>${P.clock[1]}</span>`, Wd.desk);
  Wd.trayIcon = Wd.task.querySelector('.ti');
  Wd.toast = h('div', 'toast', `<div class="ap"><img src="${ICON_URL}"><span>Deskfolk</span></div><div class="tt" style="margin-top:${12 * KD}px">${S.toast.title}</div><div class="tb">${S.toast.body}</div>`, Wd.desk);
  Wd.toast.style.setProperty('--k', KD);
  // settings › remote access over the window (SettingsModal.tsx, RemoteTab.tsx): the pairing at its third step
  const k = KD, set = S.set;
  Wd.mback = h('div', 'mback', null, Wd.win);
  const mw = Math.min(880, Math.round(Wd.wpt * 0.94)) * k, mh = Math.min(640, Math.round(Wd.hpt * 0.88)) * k;
  Wd.modal = h('div', 'smodal', null, Wd.win);
  css(Wd.modal, { left: (WINW.w - mw) / 2, top: (WINW.h - mh) / 2, width: mw, height: mh });
  const tabIcons = ['settings', 'sliders', 'box', 'terminal-square', 'server', 'type', 'bell', 'smartphone', 'info'];
  const nav = h('div', 'snav', `<div class="nh"><span class="nt">${ic('settings', 20, k)}<span>${set.title}</span></span><span class="nx">✕</span></div>` +
    `<div class="tl2">${set.tabs.map((n, i) => `<span class="st chk${n === set.remote ? ' on' : ''}">${ic(tabIcons[i], 16, k)}<span>${n}</span></span>`).join('')}</div>`, Wd.modal);
  Wd.mx = nav.querySelector('.nx');
  const sm = h('div', 'smain', `<div class="mh">${set.remote}</div>`, Wd.modal);
  const mb = h('div', 'mb', null, sm), mbi = h('div', 'mbi', null, mb);
  const card = h('div', 'scard', `<div class="shd"><div><b>${set.section}</b><small>${set.subtitle}</small></div><span class="badge-ok">${set.online}</span></div>`, mbi);
  Wd.steps = h('div', 'psteps', `<div class="pstep"><span class="n">1</span><p>${set.paste}</p><div class="r2"><div class="code">${PAIR_CODE}</div><span class="btn sm secondary">${set.copy}</span></div></div>` +
    `<div class="pstep"><span class="n">2</span><p>${set.check}</p><div class="fp">${fp4(HOST_FP)}</div></div>` +
    `<div class="pstep"><span class="n">3</span><p>${set.arrived(DEVICE)}</p><div class="fp">${fp4(DEV_FP)}</div><div class="note">${set.compare}</div>` +
    `<div class="bt"><span class="btn primary">${set.approve}</span><span class="btn sm secondary">${set.cancel}</span></div></div>`, card);
  Wd.approve = Wd.steps.querySelector('.btn.primary');
  Wd.done = h('div', 'pdone', `<span>${set.done}</span><span class="btn sm secondary">${set.close}</span>`, card);
  Wd.mbi = mbi; Wd.mb = mb; Wd.card = card;
  // the system's Windows Hello sheet, with the app's sentence (local_confirm.rs): the device, its user agent's first
  // 80 characters and its fingerprint (apps/daemon/src/remote/controller.ts)
  Wd.hello = h('div', 'hello', `<div class="msg">${esc(`Deskfolk wants to pair a device for remote access: ${DEVICE} (${UA.slice(0, 80)}) · ${DEV_FP}`)}</div><div class="pin"></div>`, Wd.win);
  Wd.pin = Wd.hello.querySelector('.pin');
  R.dl = { mac: h('div', 'abs dlabel', P.desks.mac, stage), linux: h('div', 'abs dlabel', P.desks.linux, stage), win: h('div', 'abs dlabel', P.desks.win, stage) };
  for (const k2 in R.dl) Object.assign(R.dl[k2].style, { padding: '8px 22px', borderRadius: '99px', background: '#fff', fontSize: '28px', fontWeight: 650, whiteSpace: 'nowrap', boxShadow: '0 12px 26px -14px rgba(18,28,32,.55)', zIndex: 12 });

  // ---- 10–14 a project session on Linux: its agent asks three questions on one card
  const A = S.ask;
  const Aw = R.Aw = deskWindow(KA, { chrome: 'linux', wall: 'l' });
  Aw.side = sidebar(Aw, rosterA.map(b => ({ ...b, on: false })), { project: { dir: A.dir, title: A.title, prev: A.said, time: A.time, on: true } });
  Aw.L = leaf(Aw, [{ label: A.title, on: true }]);
  const ka = KA, ca = Aw.L.card;
  Aw.hd = h('div', 'chd', `${agentTile(ka)}<div class="who"><span class="nm">${A.title}</span><span class="st2"><span class="pd"></span><span>${A.live}</span><span class="q">Claude Code · ~/${A.dir}</span></span></div>`, ca);
  Aw.pd = Aw.hd.querySelector('.pd');
  const tra = h('div', 'tr', null, ca), tria = h('div', 'tri', null, tra);
  Aw.col = h('div', 'colw', null, tria);
  Aw.col.style.gap = `${14 * ka}px`;
  h('div', 'you wide', A.you, Aw.col);
  h('div', 'reply', `<p>${A.said}</p>`, Aw.col).style.marginBottom = '0';
  Aw.card = h('div', 'qcard', null, Aw.col);
  Aw.ltime = h('div', 'ltime', A.answeredAt, Aw.col);
  Aw.live = h('div', null, null, Aw.col);
  Aw.partial = h('div', 'reply', '<p></p>', Aw.live); Aw.partialP = Aw.partial.querySelector('p');
  Aw.foot = h('div', 'sfoot', `<span class="pulse"></span><span class="sst"></span><span class="dur">${ic('clock', 12, ka)}<span class="d"></span></span>`, Aw.live);
  Aw.foot.style.margin = `${8 * ka}px 0 0`;
  Aw.sst = Aw.foot.querySelector('.sst'); Aw.sd = Aw.foot.querySelector('.d');
  const cwa = h('div', 'cwrap', null, ca);
  h('div', 'composer', `<div class="txt"><span class="ph">${A.placeholder}</span></div><span class="cb">${ic('paperclip', 20, ka)}</span>` +
    `<span class="plan">${A.plan}</span><span class="gap"></span><span class="cb send off">${ic('arrow-up', 20, ka)}</span>`, cwa);

  // ---- 14–19 the phone's page
  buildPhone();

  // ---- 19–24 a line flies from the box; files are dropped onto the composer (on a Mac)
  const X = S.send, bs = bots[X.bot].name;
  const Sw = R.Sw = deskWindow(KS);
  Sw.side = sidebar(Sw, bots.map((b, i) => ({ ...b, on: i === X.bot })));
  Sw.L = leaf(Sw, [{ bot: bs, label: bs, on: true }, { bot: bots[0].name, label: bots[0].name }]);
  Sw.C = botChat(Sw, Sw.L, bs);
  h('div', 'you', X.ask, Sw.C.col); h('div', 'youT', X.askT, Sw.C.col);
  h('div', 'reply', `<p>${X.reply}</p>`, Sw.C.col); h('div', 'rfoot', replyFoot(KS, S.span(8.4), X.replyT), Sw.C.col);
  Sw.mine = h('div', 'you', X.line, Sw.C.col); Sw.mineT = h('div', 'youT', X.lineT, Sw.C.col);
  Sw.sfoot = h('div', 'sfoot', `<span class="pulse"></span><span class="sst">${S.thinking}</span><span class="dur">${ic('clock', 12, KS)}<span class="d"></span></span>`, Sw.C.col);
  Sw.sd = Sw.sfoot.querySelector('.d');
  Sw.ghost = h('div', 'ghost', `<div class="gi"><div class="gl bub">${X.line}</div><div class="gl words">${X.line}</div></div>`, Sw.L.card);
  Sw.gi = Sw.ghost.querySelector('.gi'); Sw.gBub = Sw.ghost.querySelector('.bub'); Sw.gWords = Sw.ghost.querySelector('.words');
  Sw.C.atts.innerHTML = X.files.map(([n, s]) => `<span class="att"><span class="ft">${ic('file', 16, KS)}</span><span class="an"><b>${n}</b><small>${s}</small></span><span class="ax">${ic('x', 12, KS)}</span></span>`).join('');
  Sw.veil = h('div', 'veil', `${ic('paperclip', 16, KS)}<span>${X.drop}</span>`, Sw.C.comp);
  R.enter = h('div', 'abs keycap', `<kbd>⏎</kbd><span class="slow">${S.slow}</span>`, stage);
  R.drag = h('div', 'dragimg', `<i style="left:8px;top:22px;rotate:-8deg">${ic('file', 26, 1.4)}</i><i style="left:40px;top:14px;rotate:4deg">${ic('file', 26, 1.4)}</i><i style="left:70px;top:24px;rotate:10deg">${ic('file', 26, 1.4)}</i><b>${X.files.length}</b>`, stage);

  // ---- 24–26.5 and more
  R.more = S.more.map(m => h('div', 'abs morechip', `<span class="dot" style="width:40px;height:40px;background:var(--accent)">${ic('check', 12, 1.5)}</span><span>${m}</span>`, stage));

  // headlines (the three desktops' are platform words: strings.js `platforms`)
  const heads = { desks: P.head, ...S.h }, subs = { desks: P.sub, ...S.sub };
  R.heads = {}; R.subs = {};
  for (const k3 in heads) R.heads[k3] = h('div', `headline ${LANG}`, heads[k3], stage);
  for (const k3 in subs) R.subs[k3] = h('div', 'subline', subs[k3], stage);

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
  R.touch = h('div', null, null, stage); R.touch.id = 'touch';
}

// ---------------------------------------------------------------- 14–19: the phone's page (the narrow layout)
const PH = { w: 412, h: 892 }, BEZ = 12, PHONE = { x: 640, y: 250 };
function buildPhone() {
  const k = KPH, X = S.phone, bot = S.bots[X.bot].name;
  R.phFolks = [];
  const fbox = (name, edge) => { const fb = folkBox(name, edge, k); R.phFolks.push(fb.f); return fb.box; };
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
  const page = cls => h('div', `pg ${cls}`, null, scr);
  // the list (the Bots tab): the top row, the rows, the bottom bar, the new button
  const L = R.phList = page('list');
  L.style.background = 'var(--ground)';
  L.innerHTML = `<div class="ls-top"><span class="sq tools">${ic('grid', 16, k)}</span><span class="sp">${ic('search', 16, k)}${X.search}</span><span class="sq plain">${ic('activity', 20, k)}</span><span class="sq plain">${ic('target', 20, k)}</span></div>`;
  R.phTools = L.querySelector('.tools');
  const lst = h('div', 'ls-list', `<div class="gh">${S.botsTab}</div>`, L);
  S.bots.forEach((b, i) => {
    const row = h('div', 'prow', null, lst);
    const av = h('span', 'av', null, row); av.appendChild(fbox(b.name, 48));
    h('div', 'tx', `<div class="l1"><b>${b.name}</b><span>${i === X.bot ? X.sayT : b.time}</span></div><div class="l2">${i === X.bot ? X.say.join('') : b.prev}</div>`, row);
  });
  h('div', 'mnav', [['message-fill', 0], ['folder', 1], ['settings', 2]].map(([n, i]) => `<span class="${i === 0 ? 'on' : ''}">${ic(n, 24, k)}${X.tabs[i]}</span>`).join(''), L);
  const fab = h('div', 'fab', ic('plus', 24, k), L);
  fab.style.bottom = `${(60 + 18 + 16) * k}px`;
  // the Tools sheet over the list
  R.phSheetBg = h('div', 'sheetbg', null, scr);
  R.phSheet = h('div', 'sheet', `<div class="grip"></div><div class="sh"><span>${X.tools}</span><i>${ic('x', 20, k)}</i></div>` +
    X.toolItems.map(([icn, n]) => `<div class="si2${icn === 'terminal' ? ' term' : ''}">${ic(icn, 20, k)}<span>${n}</span></div>`).join('') +
    `<div class="sep"></div><div class="si2">${ic('archive', 20, k)}<span>${X.archived}</span><span class="cnt">3</span></div>`, scr);
  R.phTerm = R.phSheet.querySelector('.term');
  // 美术's direct (ChatHeader narrow; the transcript; the docked composer)
  const C = R.phChat = page('chat');
  const hd = h('div', 'ph-hd', `<span class="bk">${ic('chevron-left', 20, k)}</span>`, C);
  R.phBack = hd.querySelector('.bk');
  const id = h('div', 'id', null, hd), av = h('span', 'av', null, id);
  av.appendChild(fbox(bot, 36));
  h('div', null, `<b>${bot}</b><small><span>${S.stIdle}</span><span>${X.model}</span></small>`, id);
  h('span', 'mo', ic('more', 20, k), hd);
  const tr = h('div', 'ph-tr', null, C), inn = h('div', 'in', null, tr);
  h('div', 'you', X.earlier[0], inn); h('div', 'youT', X.earlier[1], inn);
  h('div', 'reply', `<p>${X.earlier[2]}</p>`, inn); h('div', 'rfoot', replyFoot(k, S.span(12.8), X.earlier[3]), inn);
  h('div', 'you', X.you, inn); h('div', 'youT', X.youT, inn);
  R.phChip = h('span', 'fchip', `${ic('image', 12, k)}<span>${X.say[1]}</span>`);
  const rp = h('div', 'reply', null, inn), p = h('p', null, null, rp);
  p.append(X.say[0], R.phChip, X.say[2]);
  h('div', 'rfoot', replyFoot(k, S.span(6.2), X.sayT), inn).style.marginBottom = '0';
  h('div', 'ph-cmp', `<div class="txt">${S.placeholder(bot)}</div><span class="cb">${ic('paperclip', 20, k)}</span><span class="tune">${tuneOf(k)}</span><span class="gap"></span>` +
    `<span class="cb">${ic('sparkles', 16, k)}</span><span class="cb send">${ic('arrow-up', 20, k)}</span>`, C);
  R.phChatShade = h('div', 'shade', null, C);
  // the file over the whole screen (ArtifactPreview.tsx's header; ArtifactAnnotBar.tsx's pills for an image)
  const F = R.phFile = page('file');
  F.innerHTML = `<div class="fp-hd"><span class="bk">${ic('chevron-left', 20, k)}</span><b>${X.say[1]}</b><span class="bk">${ic('download', 20, k)}</span></div>` +
    `<div class="fp-bar"><span>${ic('target', 12, k)}${X.annotate}</span><span>${ic('message', 12, k)}${X.annotations}</span></div><div class="fp-body"><div class="poster"></div></div>`;
  F.style.boxShadow = '-18px 0 30px -14px rgba(0,0,0,.35)';
  const poster = F.querySelector('.poster'), pw = 300 * k, phh = pw * 1.42;
  css(poster, { width: pw, height: phh });
  poster.innerHTML = `<div class="moon" style="left:${pw * 0.52}px;top:${phh * 0.1}px;width:${pw * 0.36}px;height:${pw * 0.36}px"></div>` +
    `<div class="pt" style="top:${phh * 0.42}px;font-size:${pw * 0.13}px">${LANG === 'zh' ? '这个夏天' : 'THIS SUMMER'}</div>` +
    `<div class="ps" style="top:${phh * 0.56}px;font-size:${pw * 0.045}px">${LANG === 'zh' ? '一 起 出 发' : 'WE SET OFF'}</div>` +
    `<img src="/sprites/mochi/idle/0001.png" style="left:${pw * 0.02}px;top:${phh * 0.56}px;width:${pw * 0.56}px;height:${pw * 0.56}px">` +
    `<img src="/sprites/pudding/idle/0001.png" style="left:${pw * 0.42}px;top:${phh * 0.58}px;width:${pw * 0.54}px;height:${pw * 0.54}px;transform:scaleX(-1)">`;
  // the terminal page (TerminalPage.tsx): the head, the terminal, the keys (terminals.ts TERMINAL_KEY_ROWS)
  const T = R.phTermPg = page('term');
  T.innerHTML = `<div class="tm-hd"><span class="ib">${ic('chevron-left', 20, k)}</span><div class="tt"><div class="n"><span>${X.term.name}</span>${ic('chevron-down', 12, k)}</div><div class="c">${X.term.cwd}</div></div><span class="ib">${ic('plus', 20, k)}</span></div>` +
    `<div class="tm-body"><pre></pre></div><div class="tm-keys">` +
    [['Esc', '^C', '^D', '^V', ic('clipboard', 16, k), '↑', '⏎'], ['Ctrl', 'Tab', '⇧Tab', ic('keyboard', 20, k), '←', '↓', '→']].map(r => `<div>${r.map(x => `<span>${x}</span>`).join('')}</div>`).join('') + '</div>';
  R.phPre = T.querySelector('pre');
  R.swipe = h('div', 'abs caption', `${ic('chevron-right', 20, 1.3)}<span>${X.swipe}</span>`, stage);
}

const M = {};
function measure() {
  const w = el => el.getBoundingClientRect().width, hh = el => el.getBoundingClientRect().height;
  M.bWordW = w(R.bWord); M.bWordH = hh(R.bWord); M.verW = w(R.ver); M.countW = w(R.count);
  M.platW = R.plat.map(w);
  M.moreW = R.more.map(w);
  M.enterW = w(R.enter); M.swipeW = w(R.swipe);
  M.dl = Object.fromEntries(Object.entries(R.dl).map(([k, el]) => [k, [w(el), hh(el)]]));
  M.wordW = w(R.word); M.wordH = hh(R.word); M.endVerW = w(R.endVer); M.tagW = w(R.tag); M.ctaW = w(R.ctaRow); M.fineW = w(R.fine); M.finerW = w(R.finer);
  // words that would run out of their room: render.mjs prints console errors, so both languages are checked
  const room = (what, width, most) => { if (width > most) console.error(`overflow: ${what} is ${Math.round(width)} px, room ${most}`); };
  for (const k in R.heads) room(`headline ${k}`, w(R.heads[k]), 1920 - 120 - 40);
  for (const k in R.subs) room(`subline ${k}`, w(R.subs[k]), 1920 - 124 - 40);
  M.moreW.forEach((x, i) => room(`chip ${i}`, x, 900));
  room('platforms', M.platW.reduce((a, b) => a + b, 0) + 24 * (M.platW.length - 1), 1760);
  room('fine print', M.fineW, 1800); room('tagline', M.tagW, 1800);
  // drawn app words cut short where the app would not cut them
  for (const el of document.querySelectorAll('.chk')) if (el.scrollWidth > el.clientWidth + 1) console.error(`overflow: "${el.textContent}" is cut`);
}

// ---------------------------------------------------------------- headlines (one slot, top left)
const HEADS = { desks: [4.05, 9.85], ask: [10.05, 13.85], phone: [14.05, 18.85], send: [19.05, 23.85], more: [24.05, 26.25] };
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
  // the questions quiet the room a little while the song breaks down
  R.dim.style.opacity = (0.22 * E.smooth(inv(10.6, 11.3, t)) * (1 - E.smooth(inv(13.4, 13.9, t)))).toFixed(3);
}

// ---------------------------------------------------------------- pointer
// Each pass: shown from a to b, it travels from `from` (or where the pass before it ended) onto el by `at`, and
// presses there when click is set (at `at`, or at click's time). A pass that follows on from the last does not fade in.
const qOpt = i => () => R.Aw.card.querySelectorAll('.qopt')[i];
const qBtn = () => R.Aw.card.querySelector('.qs') ?? R.Aw.card.querySelector('.qa'); // answered, the button's place says so
const POINTS = [
  // 4–10: approve the device, Windows Hello; close settings; close the window; the toast
  { a: 5.95, at: 6.25, b: 6.45, from: [1500, 1060], el: () => R.Dw.approve, click: 6.3, center: true },
  { a: 7.12, at: 7.4, b: 7.55, from: [1300, 900], el: () => R.Dw.mx, click: 7.45, center: true },
  { a: 7.55, at: 7.8, b: 8.1, from: 'prev', el: () => R.Dw.close, click: 7.85, center: true },
  { a: 8.7, at: 9.12, b: 9.45, from: [1500, 1060], el: () => R.Dw.toast, click: 9.2, center: true },
  // 10–14: the questions, one at a time
  { a: 10.3, at: 10.66, b: 10.76, from: [1500, 1060], el: qOpt(0), click: 10.7, dx: 0.3 },
  { a: 10.76, at: 10.96, b: 11.06, from: 'prev', el: qBtn, click: 11.0, center: true },
  { a: 11.06, at: 11.36, b: 11.46, from: 'prev', el: qOpt(0), click: 11.4, dx: 0.3 },
  { a: 11.46, at: 11.62, b: 11.72, from: 'prev', el: qBtn, click: 11.65, center: true },
  { a: 11.72, at: 12.02, b: 12.12, from: 'prev', el: qOpt(1), click: 12.05, dx: 0.3 },
  { a: 12.12, at: 12.42, b: 12.75, from: 'prev', el: qBtn, click: 12.45, center: true },
  // 19–24: files dragged in from the desk and dropped onto the composer
  { a: 21.9, at: 22.6, b: 23.2, from: [1990, 640], el: () => R.Sw.C.comp, dx: 0.62, dy: 0.42, click: null }
];
function target(p) {
  // every element a pass aims at stays in layout until the pass ends (a hidden one is see-through, not gone)
  const r = p.el().getBoundingClientRect();
  if (!r.width && !r.height) console.error(`pointer: the pass from ${p.a} aims at nothing laid out`);
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
  // the files' drag image rides under the pointer until the drop
  const d = POINTS[POINTS.length - 1];
  if (show(R.drag, !!pos && t >= d.a && t < 22.75)) css(R.drag, { x: pos.x - 60, y: pos.y + 26, opacity: pos.o });
}

// ---------------------------------------------------------------- the finger on the phone: taps, and the back swipe
const TAPS = [[14.55, () => R.phChip], [16.15, () => R.phBack], [16.5, () => R.phTools], [17.0, () => R.phTerm]];
const SWIPE = [15.4, 15.95];
function poseTouch(t) {
  let at = null;
  for (const [ta, el] of TAPS) if (t >= ta - 0.14 && t < ta + 0.2) {
    const r = el().getBoundingClientRect();
    if (!r.width && !r.height) console.error(`touch: the tap at ${ta} aims at nothing laid out`);
    const u = inv(ta - 0.14, ta, t), o = Math.min(E.out(u), 1 - inv(ta + 0.06, ta + 0.2, t));
    at = { x: r.left + r.width / 2, y: r.top + r.height / 2, s: lerp(1.3, t >= ta ? 0.8 : 1, E.out(u)), o };
  }
  if (t >= SWIPE[0] && t < SWIPE[1] + 0.12) {
    const r = R.phScr.getBoundingClientRect(), u = E.inOut(inv(SWIPE[0] + 0.05, SWIPE[1], t));
    at = { x: r.left + 6 + u * r.width * 0.78, y: r.top + r.height * 0.52, s: 0.9, o: Math.min(E.out(inv(SWIPE[0], SWIPE[0] + 0.08, t)), 1 - inv(SWIPE[1], SWIPE[1] + 0.12, t)) };
  }
  if (at) css(R.touch, { x: at.x, y: at.y, s: at.s, opacity: at.o }); else R.touch.style.opacity = 0;
}

// ---------------------------------------------------------------- 0–4 · 0.5.1 turns over to 0.6.0
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
  // the version is there from the start as 0.5.1; its middle digit shakes, then rolls over to 6 on the 2.0 downbeat,
  // the last to 0 a moment after
  R.ver.style.transformOrigin = '0 50%';
  css(R.ver, { x: tx, y: cy - 62, s: lerp(1, 1.12, Math.sin(Math.PI * clamp(inv(2.0, 2.3, t)))), opacity: clamp(inv(0.6, 0.8, t)) });
  R.rolls.forEach((roll, i) => {
    const d = i * 0.06, shake = t > 1.5 && t < 1.98 + d ? Math.sin((t - 1.5) * 60 + i) * 5 * inv(1.5, 1.95, t) : 0;
    const beat = E.pop(inv(2.0 + d, 2.3 + d, t));
    roll.style.translate = `${shake.toFixed(1)}px 0`;
    R.rollCols[i].style.translate = `0 ${(-50 * clamp(E.out4(inv(1.98 + d, 2.24 + d, t)) + 0.04 * Math.sin(Math.PI * beat))).toFixed(2)}%`;
  });
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
  // Mochi and Pudding come to see it, cheer when it turns over, and make room for the desktops
  if (t < 4.2) {
    const s = seq(t, [[0, 'hop'], [0.72, 'idle', true], [2.0, 'cheer'], [3.43, 'hop']]);
    const mx = t < 3.43 ? hopX(t, 0, -180, 300) : hopX(t, 3.43, 300, -260);
    mochi.pose({ ...s, x: mx, s: 420, flip: t >= 3.43 });
  }
  const sp = seq(t, [[0.3, 'hop'], [1.02, 'idle', true], [2.05, 'cheer'], [3.48, 'hop']]);
  if (t >= 0.3 && t < 4.0) pudding.pose({ ...sp, x: t < 3.48 ? hopX(t, 0.3, 2150, 1660) : hopX(t, 3.48, 1660, 2200), s: 440, flip: t < 3.48 });
}

// ---------------------------------------------------------------- 4–10 · one app, three desktops; Windows
// the three desks side by side, the Windows one in front; then it comes forward
const SC = 0.6, CASC = { mac: [60, 300], linux: [560, 404], win: [1080, 508] };
const T4 = { inMac: 4.15, inLinux: 4.3, inWin: 4.45, fwd: 5.45, fwdEnd: 5.9, modal: 5.95, approve: 6.3, helloIn: 6.36, pins: [6.62, 6.72, 6.82, 6.92], helloOut: 7.02,
  paired: 7.06, mx: 7.45, close: 7.85, toastIn: 8.4, toastPress: 9.2, end: 9.95 };
function poseDesks(t) {
  const on = t >= 4.1 && t < T4.end;
  const D = { mac: R.Dm, linux: R.Dl, win: R.Dw };
  for (const n in D) shown(D[n].desk, on);
  for (const n in R.dl) shown(R.dl[n], on);
  if (!on) return;
  const out = E.in(inv(T4.end - 0.3, T4.end, t)), fwd = E.inOut(inv(T4.fwd, T4.fwdEnd, t));
  const place = (n, a) => {
    const u = E.out4(inv(a, a + 0.45, t));
    let [x, y] = CASC[n], s = SC, o = clamp(inv(a, a + 0.2, t));
    y += lerp(50, 0, u);
    if (n === 'win') { x = lerp(x, DESK.x, fwd); y = lerp(y, DESK.y, fwd) - 24 * out; s = lerp(SC, 1, fwd); o *= 1 - out; }
    else { const g = E.in(inv(T4.fwd - 0.05, T4.fwd + 0.3, t)); x += (n === 'mac' ? -260 : -120) * g; y += 140 * g; o *= 1 - g; }
    shown(D[n].desk, o > 0.001);
    css(D[n].desk, { x, y, s, opacity: o });
    // the label in the desk's bottom left corner, on the room (not scaled)
    const [lw, lh] = M.dl[n], lo = n === 'win' ? 1 - fwd : 1;
    const lu = E.pop(inv(a + 0.4, a + 0.7, t));
    R.dl[n].style.transformOrigin = '0 100%';
    shown(R.dl[n], o * lo > 0.001 && t >= a + 0.4);
    css(R.dl[n], { x: x + 18, y: y + DESK.h * s - 18 - lh, s: lerp(0.7, 1, lu), opacity: o * lo * clamp(inv(a + 0.4, a + 0.5, t)) });
    return o;
  };
  place('mac', T4.inMac); place('linux', T4.inLinux); place('win', T4.inWin);
  // every window's folks
  for (const n of ['mac', 'linux']) { const W = D[n]; W.side.rows.forEach(r => r.f.set(t)); W.L.tabs.forEach(tb => tb.f && tb.f.set(t)); W.C.f.set(t); }
  // Windows: 剪辑 works until its reply lands while the window is hidden (8.3)
  const W = R.Dw, replied = t >= 8.3;
  const motion = replied ? 'idle' : 'running';
  W.side.rows.forEach((r, i) => { r.f.set(t, i === 0 ? motion : 'idle'); r.f.dot(t, i === 0 && !replied, i === 0 ? 'var(--pane)' : undefined); r.status(i === 0 && !replied ? S.stThinking : ''); });
  W.side.rows[0].s.textContent = replied ? S.dmReply : S.bots[0].prev;
  W.L.tabs[0].f.set(t, motion); W.L.tabs[1].f.set(t); W.C.f.set(t, motion); W.C.f.dot(t, !replied);
  show(W.L.tabs[0].busy, !replied);
  poseBusy(W.C, replied ? '' : S.stThinking);
  shown(W.sfoot, !replied); shown(W.reply, replied); shown(W.rfoot, replied);
  setText(W.sd, S.span(4 + (t - 4.1)));
  W.C.stop.style.display = replied ? 'none' : '';
  // settings over the window, at the pairing's third step; approve; the system's Windows Hello sheet; paired; ✕
  // closed, it stays laid out but see-through: the pointer's next pass starts from its ✕
  const mOn = t >= T4.modal, mo = Math.min(E.out(inv(T4.modal, T4.modal + 0.12, t)), 1 - inv(T4.mx + 0.02, T4.mx + 0.1, t));
  shown(W.mback, mOn); shown(W.modal, mOn);
  W.win.style.transformOrigin = '50% 50%';
  if (mOn) {
    W.mback.style.opacity = mo.toFixed(3);
    W.modal.style.opacity = mo.toFixed(3); W.modal.style.scale = lerp(0.97, 1, E.out(inv(T4.modal, T4.modal + 0.14, t))).toFixed(4);
    const paired = t >= T4.paired;
    shown(W.steps, !paired); shown(W.done, paired);
    // the tab scrolled so the third step sits in view (the card is longer than the dialog)
    const over = Math.max(0, W.mbi.offsetHeight - W.mb.clientHeight);
    W.mbi.style.translate = `0 ${(-over).toFixed(1)}px`;
    W.approve.classList.toggle('pressed', t >= T4.approve - 0.02 && t < T4.approve + 0.08);
    W.approve.style.opacity = t >= T4.approve + 0.05 && !paired ? 0.6 : 1; // disabled while Hello is up
    const xHot = t >= T4.mx - 0.15 && t < T4.mx + 0.1;
    W.mx.style.background = xHot ? 'var(--row-hover)' : '';
  }
  const hOn = t >= T4.helloIn && t < T4.helloOut + 0.08;
  if (shown(W.hello, hOn)) {
    const u = E.out(inv(T4.helloIn, T4.helloIn + 0.16, t)), o = Math.min(u, 1 - inv(T4.helloOut, T4.helloOut + 0.08, t));
    css(W.hello, { x: (WINW.w - W.hello.offsetWidth) / 2, y: (WINW.h - W.hello.offsetHeight) / 2 + lerp(14, 0, u), opacity: o });
    setHTML(W.pin, T4.pins.filter(p => t >= p).map(() => '<i></i>').join(''));
  }
  // the close button: lit under the pointer, pressed, the window put away; a press on the toast brings it back
  W.close.classList.toggle('hot', t >= T4.close - 0.12 && t < T4.close + 0.06);
  const hide = E.in(inv(T4.close + 0.02, T4.close + 0.14, t)), back = E.out(inv(T4.toastPress + 0.05, T4.toastPress + 0.2, t));
  const wo = t < T4.toastPress ? 1 - hide : back;
  W.win.style.opacity = wo.toFixed(3); W.win.style.scale = lerp(0.97, 1, t < T4.toastPress ? 1 - hide : back).toFixed(4);
  // the tray icon is there all along; while the window is away it is lit a moment, so the eye finds it
  const lit = Math.min(inv(T4.close + 0.15, T4.close + 0.3, t), 1 - inv(T4.close + 0.7, T4.close + 0.95, t));
  W.trayIcon.style.background = `rgba(18,28,32,${(0.1 * lit).toFixed(3)})`;
  W.trayIcon.style.scale = (1 + 0.12 * Math.sin(Math.PI * clamp(inv(T4.close + 0.15, T4.close + 0.55, t)))).toFixed(3);
  // the toast slides in above the notification area, and goes when pressed
  const tOn = t >= T4.toastIn; // pressed, it fades and stays laid out under the pointer
  if (shown(W.toast, tOn)) {
    const u = E.out4(inv(T4.toastIn, T4.toastIn + 0.32, t)), o = 1 - inv(T4.toastPress + 0.02, T4.toastPress + 0.12, t);
    const tw = W.toast.offsetWidth, th = W.toast.offsetHeight, tb = W.task.offsetHeight;
    css(W.toast, { x: DESK.w - tw - 12 * KD + lerp(tw * 0.6, 0, u), y: DESK.h - tb - th - 12 * KD, opacity: Math.min(clamp(u * 2), o) });
    W.toast.classList.toggle('pressed', t >= T4.toastPress - 0.02 && t < T4.toastPress + 0.08);
  }
}

// ---------------------------------------------------------------- 10–14 · the project session's questions
const TQ = { pick: [10.72, 11.42, 12.07], next: [11.02, 11.67], submit: 12.47, answered: 12.55, think: 12.62, write: 12.95, end: 13.85 };
function qcardHTML(t) {
  const A = S.ask, k = KA, n = A.qs.length;
  const answered = t >= TQ.answered;
  const at = answered ? 0 : t >= TQ.next[1] ? 2 : t >= TQ.next[0] ? 1 : 0;
  const has = i => t >= TQ.pick[i];
  const steps = A.qs.map((_, i) => `<i class="${i === at ? 'on' : has(i) ? 'done' : ''}">${i + 1}</i>`).join('');
  const q = A.qs[at], picked = has(at) ? q.pick : -1;
  const missing = A.qs.some((_, i) => i !== at && !has(i));
  const opts = q.o.map(([label, desc], i) => `<div class="qopt${i === picked ? ' on' : answered ? ' dim' : ''}"><span class="rd"></span><span><b>${label}</b><small>${desc}</small></span></div>`).join('');
  const body = answered
    ? `<div class="ac"><div class="opts">${opts}</div><div class="qa">${A.answered} · ${A.answeredAt}</div></div>`
    : `<div class="ac"><span class="mode">${A.pickOne}</span><div class="opts">${opts}</div><div class="qin"><span class="qf">${A.own}</span><span class="qs${picked < 0 ? ' off' : ''}">${missing ? A.next : A.submit}</span></div></div>`;
  return `<div class="qh">${ic('help-circle', 12, k)}<b class="chk">${answered ? A.asked(n) : A.head(n)}</b><span class="steps">${steps}</span></div><div class="qb"><div class="qq">${q.q}</div>${body}</div>`;
}
function poseAsk(t) {
  const Aw = R.Aw;
  if (!panel(Aw.desk, t, 9.95, 13.95, DESK.x, DESK.y)) return;
  Aw.side.rows.forEach(r => r.f.set(t));
  const answered = t >= TQ.answered;
  setHTML(Aw.card, qcardHTML(t));
  Aw.card.classList.toggle('live', !answered);
  Aw.card.querySelector('.qs')?.classList.toggle('pressed', [...TQ.next, TQ.submit].some(c => t >= c - 0.02 && t < c + 0.08));
  // waiting: the run's foot, then the card under it; answered: the card back among the lines, the run goes on under it
  Aw.col.insertBefore(Aw.live, answered ? null : Aw.card);
  shown(Aw.ltime, answered);
  const writing = t >= TQ.write;
  shown(Aw.partial, writing);
  setHTML(Aw.partialP, typed(S.ask.after, t, TQ.write, TQ.end - 0.1) + '<span class="cursor"></span>');
  setText(Aw.sst, !answered ? S.ask.waiting : writing ? S.streaming : S.thinking);
  setText(Aw.sd, S.span(72 + (t - 10)));
  const u = ((t % 1.2) + 1.2) % 1.2 / 1.2, w = u < 0.5 ? u * 2 : 2 - u * 2;
  Aw.foot.querySelector('.pulse').style.opacity = lerp(0.35, 1, w).toFixed(3);
  const u2 = ((t % 1.8) + 1.8) % 1.8 / 1.8, w2 = u2 < 0.5 ? u2 * 2 : 2 - u2 * 2;
  Aw.pd.style.opacity = lerp(0.35, 1, w2).toFixed(3);
}

// ---------------------------------------------------------------- 14–19 · the phone's page
const TP = { file: 14.6, back: 16.17, sheet: 16.52, term: 17.08, end: 18.95 };
const TERM = [
  'me@studio teaser % ffmpeg -i cuts/cut-v3.mov -c:v libx264 -crf 20 teaser.mp4',
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'cuts/cut-v3.mov':",
  '  Duration: 00:01:12.00, start: 0.000000, bitrate: 24125 kb/s',
  'Stream mapping:',
  '  Stream #0:0 -> #0:0 (prores (native) -> h264 (libx264))',
  'Press [q] to stop, [?] for help'
];
function termText(t) {
  // the encode has been running a while; its progress line keeps moving (it is the one already running)
  const sec = 38.2 + Math.max(0, t - TP.term) * 1.37, frame = Math.round(sec * 30), size = Math.round(sec * 241.3);
  const hhmmss = s => `00:00:${s.toFixed(2).padStart(5, '0')}`;
  return `${TERM.join('\n')}\nframe= ${frame} fps= 41 q=26.0 size=  ${size}kB time=${hhmmss(sec)} bitrate=1976.4kbits/s speed=1.37x <span class="tc"></span>`;
}
function posePhone(t) {
  const on = panel(R.ph, t, 14.0, TP.end, PHONE.x, PHONE.y);
  shown(R.swipe, on && t >= SWIPE[0] - 0.15 && t < SWIPE[1] + 0.25);
  if (!on) return;
  const sw = R.phScr.offsetWidth;
  // the swipe: the file's page slides away, and what shows under it is the conversation it covered
  const sw0 = E.inOut(inv(SWIPE[0] + 0.05, SWIPE[1], t));
  const fileOn = t >= TP.file && t < SWIPE[1];
  shown(R.phFile, fileOn);
  R.phFile.style.translate = `${(sw0 * sw).toFixed(1)}px 0`;
  R.phChatShade.style.opacity = fileOn && t >= SWIPE[0] ? (0.18 * (1 - sw0)).toFixed(3) : 0;
  // the pages a tap aims at stay laid out (see-through) until the finger has lifted
  R.phChat.style.display = t < TP.back + 0.25 ? '' : 'none'; show(R.phChat, t < TP.back);
  R.phChip.classList.toggle('hot', t > 14.45 && t < 14.62);
  shown(R.phList, t >= TP.back && t < TP.term);
  // the Tools sheet rises from the bottom; a choice closes it and opens the terminal page
  const sOn = t >= TP.sheet && t < TP.term;
  R.phSheet.style.display = t >= TP.sheet && t < TP.term + 0.2 ? '' : 'none'; show(R.phSheet, sOn); shown(R.phSheetBg, sOn);
  if (t >= TP.sheet && t < TP.term + 0.2) {
    const u = E.out4(inv(TP.sheet, TP.sheet + 0.28, t));
    R.phSheet.style.translate = `0 ${((1 - u) * R.phSheet.offsetHeight).toFixed(1)}px`;
    R.phSheetBg.style.opacity = u.toFixed(3);
    R.phTerm.classList.toggle('hot', t >= 16.92);
  }
  shown(R.phTermPg, t >= TP.term);
  if (t >= TP.term) setHTML(R.phPre, termText(Math.floor(t * 4) / 4));
  for (const f of R.phFolks) f.set(t);
  if (shown(R.swipe, t >= SWIPE[0] - 0.15 && t < SWIPE[1] + 0.25)) {
    const u = E.out(inv(SWIPE[0] - 0.15, SWIPE[0] + 0.1, t)), o = Math.min(u, 1 - inv(SWIPE[1], SWIPE[1] + 0.25, t));
    css(R.swipe, { x: PHONE.x - M.swipeW - 36, y: PHONE.y + 400, opacity: o });
  }
}

// ---------------------------------------------------------------- 19–24 · the line flies; files dropped
const TS = { type: [19.55, 20.2], send: 20.4, fly: 20.433, drag: 22.3, drop: 22.75 }; // the flight sets off a frame after the send
function poseSend(t) {
  const Sw = R.Sw, X = S.send, k = KS;
  shown(R.enter, false);
  if (!panel(Sw.desk, t, 19.0, 23.95, DESK.x, DESK.y)) return;
  Sw.side.rows.forEach(r => r.f.set(t));
  Sw.L.tabs.forEach(tb => tb.f && tb.f.set(t));
  const sent = t >= TS.send, landed = t >= TS.fly + FLY.land, working = landed;
  // the box: the line typed, then empty once it is sent
  const words = typed(X.line, t, TS.type[0], TS.type[1]);
  setHTML(Sw.C.txt, sent || !words ? `${t >= TS.type[0] - 0.2 && !sent ? '<span class="caret"></span>' : ''}<span class="ph">${S.placeholder(S.bots[X.bot].name)}</span>` : `${esc(words)}<span class="caret"></span>`);
  Sw.C.send.classList.toggle('off', !(words && !sent));
  Sw.C.send.classList.toggle('pressed', t >= TS.send - 0.02 && t < TS.send + 0.08);
  shown(Sw.C.spark, !words || sent);
  // the row is placed at once and hidden while its stand-in flies
  shown(Sw.mine, sent); shown(Sw.mineT, sent);
  Sw.mine.style.opacity = Sw.mineT.style.opacity = landed ? 1 : 0;
  shown(Sw.sfoot, working);
  setText(Sw.sd, S.span(Math.max(0, t - (TS.fly + FLY.land))));
  Sw.C.stop.style.display = working ? '' : 'none';
  poseBusy(Sw.C, working ? S.stThinking : '');
  const busy = working ? 'running' : 'idle';
  Sw.C.f.set(t, busy); Sw.C.f.dot(t, working);
  Sw.side.rows[S.send.bot].f.set(t, busy); Sw.side.rows[S.send.bot].status(working ? S.stThinking : '');
  Sw.side.rows[S.send.bot].f.dot(t, working, 'var(--pane)');
  // the flight: two layers at the bubble's size; across and up each on its own curve, the words out, the bubble in
  if (shown(Sw.ghost, sent && !landed)) {
    const card = Sw.L.card.getBoundingClientRect(), sc = card.width / Sw.L.card.offsetWidth;
    const b = Sw.mine.getBoundingClientRect(), tx = Sw.C.txt.getBoundingClientRect();
    const to = { x: (b.left - card.left) / sc, y: (b.top - card.top) / sc, w: b.width / sc, h: b.height / sc };
    const from = { x: (tx.left - card.left) / sc + 4 * k, y: (tx.top - card.top) / sc + 6 * k };
    const dx = from.x - (to.x + 14 * k), dy = from.y - (to.y + 10 * k);
    const u = Math.max(0, t - TS.fly);
    const ox = dx * (1 - ACROSS(clamp(u / FLY.across))), oy = dy * (1 - RISE(clamp(u / FLY.rise)));
    css(Sw.ghost, { left: to.x, top: to.y, width: to.w, height: to.h, x: ox });
    Sw.gi.style.translate = `0 ${oy.toFixed(2)}px`;
    Sw.gWords.style.opacity = (1 - EASE_OUT(clamp(u / FLY.wordsOut))).toFixed(3);
    Sw.gBub.style.opacity = EASE_OUT(clamp(u / FLY.bubbleIn)).toFixed(3);
  }
  // the Enter key and how much slower the film plays the flight
  const ka = TS.send - 0.35, kb = TS.fly + FLY.land + 0.25;
  if (shown(R.enter, t >= ka && t < kb)) {
    const u = E.pop(inv(ka, ka + 0.25, t)), o = E.in(inv(kb - 0.2, kb, t)), press = t >= TS.send - 0.04 && t < TS.send + 0.08 ? 4 : 0;
    R.enter.style.transformOrigin = '50% 50%';
    css(R.enter, { x: DESK.x + DESK.w + (1920 - DESK.x - DESK.w - M.enterW) / 2, y: 330 + press, s: lerp(0.8, 1, u), opacity: Math.min(clamp(inv(ka, ka + 0.12, t)), 1 - o) });
  }
  // files dragged over the conversation light the composer; dropped, they wait in it above the words
  const over = t >= TS.drag && t < TS.drop;
  shown(Sw.veil, over);
  shown(Sw.C.atts, t >= TS.drop);
}

// ---------------------------------------------------------------- the cast beside each scene
function poseCast(t) {
  const { mochi, pudding, reviewer } = R.cast;
  // Pudding comes back for Windows: presents the pairing, then the toast
  if (t >= 5.55 && t < 9.95) {
    const s = seq(t, [[5.55, 'hop'], [6.27, 'idle', true], [6.4, 'present'], [7.6, 'idle', true], [8.45, 'present'], [9.3, 'nod'], [9.55, 'hop']]);
    pudding.pose({ ...s, x: t < 9.55 ? hopX(t, 5.55, 2150, 1660) : hopX(t, 9.55, 1660, 2150), s: 440, flip: true });
  }
  // the Reviewer leans in to the questions and nods them off
  if (t >= 9.9 && t < 14.3) {
    const s = seq(t, [[9.9, 'hop'], [10.62, 'think', true], [11.0, 'inspect'], [12.25, 'think', true], [12.55, 'nod'], [13.95, 'hop']]);
    const x = t < 13.95 ? hopX(t, 9.9, 2150, 1640) : hopX(t, 13.95, 1640, 2200);
    reviewer.pose({ ...s, x, s: 400, flip: t < 13.95 });
  }
  // Mochi points at the phone
  if (t >= 13.9 && t < 19.3) {
    const s = seq(t, [[13.9, 'hop'], [14.62, 'idle', true], [15.35, 'point'], [16.1, 'idle', true], [17.15, 'point'], [17.95, 'nod'], [18.9, 'hop']]);
    const x = t < 18.9 ? hopX(t, 13.9, 2150, 1400) : hopX(t, 18.9, 1400, 2200);
    mochi.pose({ ...s, x, s: 440, flip: true });
  }
  // the send: Pudding and the Reviewer come to look, and cheer the line and the files
  if (t >= 19.2 && t < 23.62) {
    const s = seq(t, [[19.2, 'hop'], [19.92, 'idle', true], [20.45, 'nod'], [21.0, 'idle', true], [21.75, 'cheer'], [22.95, 'idle', true]]);
    pudding.pose({ ...s, x: hopX(t, 19.2, 2150, 1585), s: 400, flip: true });
  }
  if (t >= 19.45 && t < 24.0) {
    const s = seq(t, [[19.45, 'hop'], [20.17, 'inspect'], [21.4, 'think', true], [22.8, 'cheer'], [23.55, 'hop']]);
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
  poseDesks(t);
  poseAsk(t);
  posePhone(t);
  poseSend(t);
  poseCast(t);
  poseMore(t);
  poseEnd(t);
  for (const k in R.cast) show(R.cast[k].el, R.cast[k].on);
  poseHeads(t);
  posePointer(t);
  poseTouch(t);
  await Promise.all(pending);
}

// ---------------------------------------------------------------- sound cues: name, film time, what it marks
// (every name is one of ../release/mix.py's ROUTE)
const CUES = [
  ['whoosh', 0.05, 'Mochi hops in'], ['whoosh', 0.35, 'Pudding hops in'], ['pop', 0.4, 'the name'], ['tick', 0.65, '0.5.1'],
  ['swish', 1.98, 'the digits roll'], ['done', 2.0, '0.6.0 lands'], ['pop', 2.15, 'the count'], ...P.chips.map((c, i) => ['tick', 2.45 + i * 0.15, 'a platform']),
  ['whoosh', 4.15, 'the Mac desk'], ['tick', 4.3, 'the Linux desk'], ['tick', 4.45, 'the Windows desk'],
  ['swish', T4.fwd, 'Windows comes forward'], ['whoosh', 5.55, 'Pudding'], ['pop', T4.modal, 'settings'],
  ['click', T4.approve, 'approve this device'], ['pop', T4.helloIn, 'Windows Hello'], ['check', T4.paired, 'paired'],
  ['click', T4.mx, 'settings closed'], ['click', T4.close, 'the close button'], ['swish', T4.close + 0.03, 'into the tray'],
  ['pop', T4.toastIn + 0.05, 'the toast'], ['click', T4.toastPress, 'the toast pressed'], ['pop', T4.toastPress + 0.08, 'the window is back'],
  ['whoosh', 9.9, 'the Reviewer'], ['whoosh', 9.95, 'the project session on Linux'],
  ['click', TQ.pick[0], 'an answer'], ['tick', TQ.next[0], 'next'], ['click', TQ.pick[1], 'an answer'], ['tick', TQ.next[1], 'next'], ['click', TQ.pick[2], 'an answer'],
  ['enter', TQ.submit, 'send answers'], ['check', TQ.answered, 'answered'],
  ['whoosh', 13.9, 'Mochi'], ['whoosh', 14.0, 'the phone'], ['tap', 14.55, 'the file'], ['pop', TP.file, 'the file over the screen'],
  ['swish', SWIPE[0] + 0.1, 'the back swipe'], ['tap', 16.15, 'back'], ['tap', 16.5, 'tools'], ['pop', TP.sheet, 'the sheet'], ['tap', 17.0, 'terminal'], ['pop', TP.term, 'reattached'],
  ['whoosh', 19.0, 'the window'], ['whoosh', 19.2, 'Pudding'], ['whoosh', 19.45, 'the Reviewer'],
  ['enter', TS.send, 'Enter'], ['swish', TS.fly, 'the line flies'], ['pop', TS.fly + FLY.land, 'it lands'],
  ['whoosh', 21.95, 'files dragged in'], ['pop', TS.drag, 'drop to attach'], ['check', TS.drop, 'attached'], ['pop', 22.8, 'a cheer'],
  ['whoosh', 23.6, 'down to the front'], ['tick', 24.15, 'chip'], ['tick', 24.31, 'chip'], ['tick', 24.47, 'chip'], ['tick', 24.63, 'chip'], ['tick', 24.79, 'chip'], ['tick', 24.95, 'chip'], ['pop', 25.3, 'cheer'],
  ['whoosh', 26.45, 'onto the mark'], ['tap', 27.05, 'white circle'], ['tap', 27.2, 'mustard circle']
];
// every visible keystroke: the PIN, the line typed
const KEYS = [...T4.pins, ...keysOf(S.send.line, TS.type[0], TS.type[1])];

// ---------------------------------------------------------------- boot
async function boot() {
  SP = await (await fetch('/sprites/sprites.json')).json();
  FOLK = await (await fetch('/work/folk.json')).json();
  // each layer once, as a blob the folks' images share; the app's icon as an SVG blob
  layerURL = Object.fromEntries(Object.entries(FOLK.now.layers).map(([n, b64]) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return [n, URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }))];
  }));
  ICON_URL = URL.createObjectURL(new Blob([FOLK.icon], { type: 'image/svg+xml' }));
  await Promise.all([document.fonts.load('700 76px "DF Sans"'), document.fonts.load('600 30px "DF Mono"'), document.fonts.load('600 40px "PingFang SC"', '交'), document.fonts.load('400 40px "PingFang SC"', '交')]);
  await document.fonts.ready;
  build();
  // every folk layer and image decoded before the first frame: a render worker starts at any frame
  await Promise.all([...document.querySelectorAll('.folk img, .toast img, .taskbar img, .poster img')].map(i => i.decode().catch(() => {})));
  measure();
  M.lockX = (1920 - (200 + 40 + M.wordW + 30 + M.endVerW)) / 2; M.lockY = 230;
  window.film.ready = true;
  await seek(0);
}
window.film = { duration: DURATION, seek, ready: false, cues: CUES, keys: KEYS, lang: LANG };
boot();
