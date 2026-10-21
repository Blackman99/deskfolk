/**
 * The task map's town (ADR 0096) with its plates, badges and island labels: two Bots at work in
 * one folder, so a plate carries both their lines, and the camera fitted to the ground the way the
 * map opens. Every call is a fixture; the town is built by the map's own `buildFrame`.
 */
import { copyFor } from '../../src/lib/copy.ts';
import { buildDistricts } from '../../src/lib/taskmap/districts.ts';
import { buildFrame } from '../../src/lib/taskmap/frame.ts';
import { fromSessionReplay } from '../../src/lib/taskmap/map-data.ts';
import { fitZoom } from '../../src/lib/taskmap/scene/camera.ts';
import { drawFigure } from '../../src/lib/taskmap/scene/figures.ts';
import { buildTimeline } from '../../src/lib/taskmap/timeline.ts';
import MapScene from '../../src/lib/taskmap/MapScene.svelte';

export function taskmapSceneStory() {
  const t = copyFor('zh').taskmap;
  const T0 = Date.UTC(2026, 9, 21, 2, 0, 0);
  const call = (id: string, bot: string, sec: number, path: string) => ({
    id, at: new Date(T0 + sec * 1000).toISOString(), bot_id: bot, turn_id: 't', task_id: null, tool: 'write_file',
    place: { zone: 'project' as const, path }, model: 'claude-opus-5-5', file: null, ok: true, duration_ms: 60_000, decision: null,
  });
  const data = fromSessionReplay({
    session_id: 'g-1', bots: ['b-1', 'b-2'], truncated: false,
    calls: [call('c1', 'b-1', 0, 'jobs/a/x.md'), call('c2', 'b-2', 20, 'shots/b.md'), call('c3', 'b-1', 40, 'shots/a.md'), call('c4', 'b-2', 60, 'shots/c.md')],
    said: [],
  });
  const map = buildDistricts(data.calls.map((c) => c.place));
  const tl = buildTimeline(data, map);
  const frame = buildFrame({
    data, map, tl, v: tl.v[tl.v.length - 1]!, phi: 0, zoom: 1, now: 0, speed: 4, light: { n: 0, w: 0, name: 'day' },
    cache: new Map(), walk: { lastTile: [], until: [] }, hover: -1, sel: -1, t, names: ['视频导演', '审核员'],
  });
  const width = 900, height = 600;
  const box = frame.ground.box;
  const k = Math.min(1, fitZoom(box, width, height) * 0.96);
  return {
    component: MapScene as never,
    props: {
      frame,
      logos: [{ kind: 'claude-agent', name: 'Claude Agent' }, { kind: 'custom', name: 'Claude Agent' }],
      figures: [{ ...drawFigure('pudding', { eyes: 'dot', mouth: 'smile' }), avatar: null }, { ...drawFigure('taro', { eyes: 'dot', mouth: 'smile' }), avatar: null }],
      tint: null,
      colors: ['#146a7c', '#3b5bdb'],
      cam: { k, tx: (width - (box.x0 + box.x1) * k) / 2, ty: (height - (box.y0 + box.y1) * k) / 2 },
      camMs: 0, walkMs: 0, sel: -1, hover: -1, follow: -1,
      labels: { ext: `${t.places.service} · ${t.places.outside}`, ws: `${t.places.git} · ${t.places.other}`, town: 'workspace/' },
      t,
      onPan: () => {}, onTurn: () => {}, onZoom: () => {}, onPick: () => {}, onHover: () => {}, onFollow: () => {}, onDeselect: () => {}, onDragging: () => {},
    },
    width, height,
    // The map stage's daylight sky behind the town, as TaskMap paints it.
    afterMount(host: HTMLElement) {
      host.style.background = `linear-gradient(180deg, ${frame.sky.top} 0%, ${frame.sky.bottom} 100%)`;
    },
  };
}
