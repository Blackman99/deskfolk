// The task map shot of the 0.2.0 release film: the app's own MapScene, built by its own buildFrame from a made-up
// Bot conversation (three Bots in a launch kit's folders; no real session, no real folder names). capture.mjs serves
// this module in place of the visual harness's taskmap-scene story, so main.ts mounts it like any story; every
// frame is its own page load (?lang=&f=&n=), posed from the frame's place in the shot alone.
// Plain JS on purpose: the module reaches the browser untouched, and only the app's files it imports go through Vite.
import { copyFor } from '/src/lib/copy.ts';
import { buildDistricts } from '/src/lib/taskmap/districts.ts';
import { buildFrame } from '/src/lib/taskmap/frame.ts';
import { fromSessionReplay } from '/src/lib/taskmap/map-data.ts';
import { fitZoom } from '/src/lib/taskmap/scene/camera.ts';
import { buildGround, lightAt } from '/src/lib/taskmap/scene/draw.ts';
import { drawFigure, figureTint } from '/src/lib/taskmap/scene/figures.ts';
import { buildTimeline } from '/src/lib/taskmap/timeline.ts';
import MapScene from '/src/lib/taskmap/MapScene.svelte';

const q = new URLSearchParams(location.search);
const LANG = q.get('lang') === 'en' ? 'en' : 'zh';
const F = Number(q.get('f') ?? 0), N = Math.max(1, Number(q.get('n') ?? 1));
export const WIDTH = 1300, HEIGHT = 604;

// Folders of a launch kit, in each language; the map's buildings are named after them.
const DIRS = {
  zh: { poster: '海报', teaser: '预告', copy: '文案', assets: '素材', scripts: '脚本', deliver: '交付', fonts: '字体', refs: '参考' },
  en: { poster: 'poster', teaser: 'teaser', copy: 'copy', assets: 'assets', scripts: 'scripts', deliver: 'deliver', fonts: 'fonts', refs: 'refs' }
}[LANG];
const NAMES = { zh: ['制片', '审片', '剪辑'], en: ['Producer', 'Reviewer', 'Editor'] }[LANG];

// Two hours of work before the shot: where each Bot went, in order (Bot, folder or zone, minutes in).
const T0 = Date.UTC(2026, 9, 25, 6, 0, 0);
const WORK = [
  [0, 'refs', 0], [0, 'copy', 3], [1, 'refs', 5], [0, 'scripts', 8], [2, 'assets', 10], [2, 'assets', 12], [0, 'scripts', 14],
  [1, 'copy', 16], [2, 'fonts', 18], [0, 'service', 20], [0, 'poster', 24], [2, 'assets', 26], [1, 'poster', 30], [0, 'poster', 32],
  [2, 'teaser', 35], [2, 'teaser', 38], [0, 'service', 40], [1, 'check', 43], [0, 'teaser', 46], [2, 'assets', 49], [1, 'poster', 52],
  [0, 'copy', 55], [2, 'teaser', 58], [2, 'scripts', 61], [0, 'git', 64], [1, 'teaser', 67], [2, 'teaser', 70], [0, 'deliver', 73],
  [1, 'check', 76], [2, 'assets', 79], [0, 'poster', 82], [1, 'poster', 85], [2, 'teaser', 88], [0, 'service', 91], [0, 'teaser', 94],
  [1, 'copy', 97], [2, 'fonts', 100], [0, 'deliver', 103], [2, 'teaser', 106], [1, 'teaser', 109], [0, 'scripts', 112],
  // where each is at work when the shot runs
  [1, 'poster', 115], [2, 'assets', 116], [0, 'teaser', 117]
];
const placeOf = (where, i) => {
  if (where === 'service') return { zone: 'service', server: 'imagegen' };
  if (where === 'check') return { zone: 'check', check: 'test' };
  if (where === 'git') return { zone: 'git' };
  return { zone: 'project', path: `${DIRS[where]}/${['a', 'b', 'c'][i % 3]}.md` };
};
// At work when the shot runs: the Reviewer reads the poster, the Editor runs its script on the assets, the Producer writes.
const LAST = { 1: ['read_file', null], 2: ['shell', 'script'], 0: ['write_file', null] };
const calls = WORK.map(([b, where, min], i) => {
  const last = i >= WORK.length - 3;
  const [tool, action] = last ? LAST[b] : [where === 'check' || where === 'git' ? 'shell' : 'write_file', null];
  return {
    id: `c${i}`, at: new Date(T0 + min * 60_000).toISOString(), bot_id: `b${b}`, turn_id: `t${b}`, task_id: null,
    tool, ...(action ? { action } : {}), place: placeOf(where, i), model: null, file: null,
    ok: true, duration_ms: last ? 20 * 60_000 : 90_000, decision: null
  };
});

export function taskmapSceneStory() {
  const t = copyFor(LANG).taskmap;
  const data = fromSessionReplay({ session_id: 'film', bots: ['b0', 'b1', 'b2'], truncated: false, calls, said: [] });
  const map = buildDistricts(data.calls.map((c) => c.place));
  const tl = buildTimeline(data, map);
  // The shot: the afternoon goes down into night, the town turns a little and the camera comes in.
  const u = N > 1 ? F / (N - 1) : 0, e = u * u * (3 - 2 * u);
  const hour = 15.5 + 6.5 * u;
  const light = lightAt(hour);
  const phi = -14 + 26 * e;
  const figures = [drawFigure('pudding', { eyes: 'dot', mouth: 'smile' }), drawFigure('taro', { eyes: 'dot', mouth: 'smile' }), drawFigure('mochi', { eyes: 'dot', mouth: 'smile' })]
    .map((f) => ({ ...f, avatar: null }));
  const box = buildGround(phi).box;
  const k = Math.min(1, fitZoom(box, WIDTH, HEIGHT) * 0.96) * (1 + 0.1 * e);
  const frame = buildFrame({
    data, map, tl, v: tl.v[tl.v.length - 1], phi, zoom: k, now: 0, speed: 4, light,
    cache: new Map(), walk: { lastTile: [], until: [] }, hover: -1, sel: -1, t, names: NAMES, tops: figures.map((f) => f.top)
  });
  const custom = { kind: 'custom', name: NAMES[0] };
  return {
    component: MapScene,
    props: {
      frame, logos: [custom, custom, custom], figures, tint: figureTint(light), colors: ['#146a7c', '#3b5bdb', '#c2410c'],
      cam: { k, tx: (WIDTH - (box.x0 + box.x1) * k) / 2, ty: (HEIGHT - (box.y0 + box.y1) * k) / 2 },
      camMs: 0, walkMs: 0, sel: -1, hover: -1, follow: -1,
      labels: { ext: `${t.places.service} · ${t.places.outside}`, ws: `${t.places.git} · ${t.places.other}`, town: 'workspace/' },
      t,
      onPan: () => {}, onTurn: () => {}, onZoom: () => {}, onPick: () => {}, onHover: () => {}, onFollow: () => {}, onDeselect: () => {}, onDragging: () => {}
    },
    width: WIDTH, height: HEIGHT,
    // The stage's sky behind the town, as TaskMap paints it.
    afterMount(host) {
      host.style.background = `linear-gradient(180deg, ${frame.sky.top} 0%, ${frame.sky.bottom} 100%)`;
    }
  };
}
