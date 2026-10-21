import type { Copy } from "../copy.ts";
import type { FolkMotion } from "../folk-motion.ts";
import type { District, DistrictMap } from "./districts.ts";
import type { MapCall, MapData } from "./map-data.ts";
import { modelFamily, modelLabel } from "./model-label.ts";
import { buildGround, drawBuilding, LAMPS, TREES, type DrawnFace, type Ground, type Light, type ModelCache } from "./scene/draw.ts";
import { axes, depth, HMAX, HMIN, LIFT, mix, NIGHT, proj, SHADE, BX, BY } from "./scene/geometry.ts";
import { assignBadges, layoutPlates } from "./scene/layout.ts";
import type { Timeline } from "./timeline.ts";

type T = Copy["taskmap"];

/** What a character is doing, as its badge dot and its card's chip say it. */
export type CharacterStatus = "work" | "walk" | "idle" | "fail" | "back" | "none";

export type FrameActor = {
  /** Index among the characters (0 is the agent, or the first Bot to work). */
  b: number;
  key: string;
  /** On the map all along, full size: the agent, or a Bot. */
  lead: boolean;
  /** The conversation its step at the playhead was in, on a plan's map, and when that step began. */
  sessionId: string | null;
  at: number | null;
  short: string;
  /** What the subagent was sent to do; null for the agent. */
  description: string | null;
  x: number;
  y: number;
  z: number;
  /** Standing on the map now: a lead always, a subagent while it is out. */
  present: boolean;
  walking: boolean;
  busy: boolean;
  status: CharacterStatus;
  idleMin: number;
  verb: string;
  file: string | null;
  tile: number;
  model: string | null;
  modelShort: string;
  hasModel: boolean;
  modelFamily: string;
  motion: FolkMotion;
  /** Its step count so far and its failures. */
  step: number;
  fails: number;
  /** Badge layout (set by `assignBadges`). */
  side: number;
  lift: number;
  badgeTop: number;
  /** Subagents stand a size smaller. */
  scale: number;
};

export type FrameBlock = {
  district: District;
  l: number;
  t: number;
  z: number;
  faces: DrawnFace[];
  hit: string;
  ring: string;
  busy: boolean;
  flag: boolean;
  fx: { on: boolean; x: number; y: number };
  px: number;
  plateY: number;
  name: string;
  n: number | string;
  lines: { text: string; model: string; ink: string; b: number }[];
};

export type Frame = {
  /** The last call at or before the playhead, -1 before the first. */
  idx: number;
  /** The real time at the playhead, epoch ms. */
  at: number;
  actors: FrameActor[];
  blocks: FrameBlock[];
  trees: { l: number; t: number; z: number; pine: boolean }[];
  lamps: { l: number; t: number; z: number }[];
  ground: Ground;
  slabs: { z: number; faces: { d: string; fill: string; stroke: string }[]; puffs: { x: string; y: string; rx: number; ry: string; fill: string }[] }[];
  roadFill: string;
  roadEdge: string;
  sky: { top: string; bottom: string; stars: number };
  /** The moment whose span holds the playhead, by index into `Timeline.moments`. */
  live: number;
  /** The quest the work at the playhead is for. */
  quest: number;
};

/** Where each character was a frame ago and until when it is still hopping there. */
export type WalkState = { lastTile: number[]; until: number[] };

export type FrameInput = {
  data: MapData;
  map: DistrictMap;
  tl: Timeline;
  v: number;
  /** The wall clock, when the map stands at the newest step of a session at rest: it rests since. */
  rest?: number | undefined;
  phi: number;
  zoom: number;
  now: number;
  speed: number;
  light: Light;
  cache: ModelCache;
  walk: WalkState;
  hover: number;
  sel: number;
  t: T;
  /** Each character's name where the data has one (a Bot's), in place of 主线 and 分身 N. */
  names?: readonly (string | null)[];
  /** Where each character's badge stands in its actor box, over the top of its hat (4 px down when not given). */
  tops?: readonly number[];
};

/** A call's verb on a plate and a card, from its tool and what its command did. */
export function verbOf(call: Pick<MapCall, "tool" | "action" | "place">, t: T): string {
  const v = t.verbs;
  switch (call.tool) {
    case "Read": case "NotebookRead": return v.read;
    case "Edit": case "MultiEdit": case "NotebookEdit": return v.edit;
    case "Write": return v.write;
    case "Grep": case "Glob": case "LS": return v.search;
    case "Agent": case "Task": return v.agent;
    case "AskUserQuestion": return v.ask;
    case "TodoWrite": return v.todo;
    case "WebFetch": case "WebSearch": case "web": return v.web;
    // A Bot's own tools (ADR 0097).
    case "read_file": return v.readFile;
    case "write_file": return v.write;
    case "delete_file": return v.remove;
    case "list_dir": case "list_annotations": return v.look;
    case "ask_user": return v.ask;
    case "send_message": return v.say;
  }
  if (call.place.zone === "check") return call.place.check === "typecheck" ? v.typecheck : v.test;
  if (call.place.zone === "service") return v.service;
  switch (call.action) {
    case "check": return v.test;
    case "git": return v.git;
    case "write": return v.edit;
    case "search": return v.search;
    case "read": return v.look;
    case "script": return v.script;
    case "run": return v.run;
  }
  return call.place.zone === "git" ? v.git : call.tool;
}

/** A district's name on its plate: a folder's own label, the one server's name, or the fixed place's name. */
export function placeName(d: District, t: T): string {
  return d.kind === "code" || d.label ? d.label : t.places[d.kind];
}

/** The real time at the playhead `v`: between two calls, as far along as the playhead is. */
export function timeAt(data: MapData, tl: Timeline, v: number): number {
  const idx = lastLE(tl.v, v, (x) => x);
  const calls = data.calls;
  if (idx < 0) return calls[0]?.at ?? Date.now();
  const a = calls[idx]!, b = calls[idx + 1];
  const va = tl.v[idx]!, vb = tl.v[idx + 1];
  return b && vb !== undefined ? a.at + (b.at - a.at) * Math.min(1, (v - va) / Math.max(0.01, vb - va)) : a.at;
}

function lastLE<X>(list: readonly X[], x: number, val: (item: X) => number): number {
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (val(list[mid]!) <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** How long, in the copy's words: minutes under an hour and a half, hours after. */
export function spanText(min: number, t: T): string {
  return min >= 90 ? t.hours(Math.round(min / 60)) : t.minutes(Math.max(1, Math.round(min)));
}

/** A character's status in words, for its plate line and its card. */
export function statusText(a: Pick<FrameActor, "status" | "idleMin">, t: T): string {
  switch (a.status) {
    case "idle": return a.idleMin < 1 ? t.status.rested : t.status.idle(spanText(a.idleMin, t));
    case "walk": return t.status.walk;
    case "fail": return t.status.fail;
    case "back": return t.status.back;
    case "none": return t.status.none;
    case "work": return t.status.work;
  }
}

const MOTION: Readonly<Record<CharacterStatus, FolkMotion>> = {
  work: "running", walk: "running", idle: "idle", fail: "failed", back: "idle", none: "idle",
};

/**
 * One frame of the map at the playhead `v`: who stands where doing what, every building and plate,
 * the ground and the sky. The same as the prototype's frame, with the characters from the data and
 * the places from its districts.
 */
export function buildFrame(input: FrameInput): Frame {
  const { data, map, tl, v, phi, zoom, now, speed, light: L, cache, walk, hover, sel, t } = input;
  const calls = data.calls;
  const D = map.districts;
  const ax = axes(phi);
  const walkMs = speed >= 16 ? 220 : 480;
  const idx = lastLE(tl.v, v, (x) => x);
  const at = Math.max(timeAt(data, tl, v), input.rest ?? 0);

  const counts = D.map(() => 0);
  for (let i = 0; i <= idx; i++) counts[tl.placeOf[i]!]! += 1;
  const most = Math.max(1, ...D.map((d) => d.calls));
  const heights = counts.map((c) => HMIN + (HMAX - HMIN) * Math.sqrt(Math.min(1, c / most)));
  const spot = D.map((d) => proj(phi, d.gx, d.gy, d.island === "ext" ? LIFT : 0));

  const live = tl.moments.findIndex((m) => v >= m.v - 0.5 && v <= Math.max(m.v1, m.v + 6));
  const flagged = new Set(live >= 0 ? tl.moments[live]!.places : []);
  const quest = lastLE(tl.quests, v, (q) => q.v);

  // Each character's last call at the playhead; a subagent is out between its first and last step.
  const byWho = data.characters.map(() => [] as number[]);
  calls.forEach((c, i) => byWho[c.who]?.push(i));
  const states = data.characters.map((ch, b) => {
    const j = lastLE(byWho[b]!, idx, (x) => x);
    const i = j >= 0 ? byWho[b]![j]! : -1;
    const call = i >= 0 ? calls[i]! : null;
    const out = ch.lead ? true : !!call && at <= (ch.lastAt ?? call.at) + 3000;
    return { b, j, i, call, out, lead: ch.lead, back: !ch.lead && !!call && !out };
  });
  // A lead that has not worked yet waits at the root; a subagent away is with the agent.
  const root = map.indexOf({ zone: "none" });
  const tileOf = (s: (typeof states)[number]) =>
    s.out && s.i >= 0 ? tl.placeOf[s.i]! : s.lead ? root : states[0] && states[0].i >= 0 ? tl.placeOf[states[0].i]! : 0;
  const doors = new Map<number, number[]>();
  for (const s of states) if (s.out) doors.set(tileOf(s), [...(doors.get(tileOf(s)) ?? []), s.b]);

  const actors: FrameActor[] = states.map((s) => {
    const ch = data.characters[s.b]!;
    const call = s.call;
    const tile = tileOf(s);
    if (tile !== walk.lastTile[s.b]) {
      if (walk.lastTile[s.b] !== undefined && walk.lastTile[s.b] !== -1) walk.until[s.b] = now + walkMs;
      walk.lastTile[s.b] = tile;
    }
    const walking = now < (walk.until[s.b] ?? 0);
    const idleMin = call ? (at - (call.at + call.durationMs)) / 60000 : 0;
    const failed = !!call && !call.ok && !call.running && s.i >= 0 && v - tl.v[s.i]! < Math.max(1.5, speed * 0.6);
    let status: CharacterStatus;
    if (!s.out && s.back) status = "back";
    else if (!call) status = "none";
    else if (walking) status = "walk";
    else if ((idleMin > 10 || input.rest !== undefined) && !call.running) status = "idle";
    else if (failed) status = "fail";
    else status = "work";
    const d = D[tile]!;
    const door = doors.get(tile) ?? [s.b];
    const slot = door.indexOf(s.b);
    // A figure is ~50 px wide with its arms: neighbours at one door stand 38 px apart, arms just touching.
    const off = slot < 0 ? 0 : (slot - (door.length - 1) / 2) * 38;
    const [fx, fy] = proj(phi, d.gx + ax.front[0] * 0.47, d.gy + ax.front[1] * 0.47, d.island === "ext" ? LIFT : 0);
    let fails = 0;
    for (let q = 0; q <= s.j; q++) if (!calls[byWho[s.b]![q]!]!.ok) fails++;
    const scale = s.lead ? 1 : 0.78;
    return {
      b: s.b, key: ch.key, lead: s.lead, sessionId: call?.sessionId ?? null, at: call?.at ?? null, short: input.names?.[s.b] ?? (s.b === 0 ? t.mainLane : t.subagent(s.b)), description: ch.description,
      x: Math.round(fx + off - 27.5), y: Math.round(fy - 59.5 + 1), z: 400 + (s.lead ? 10 + s.b : s.b),
      present: s.out && (s.lead || !!call), walking, busy: s.out && !!call && !walking && idleMin <= 10,
      status, idleMin, verb: call ? verbOf(call, t) : "", file: call?.file ?? null, tile,
      model: call?.model ?? null, modelShort: modelLabel(call?.model), hasModel: !!call?.model, modelFamily: modelFamily(call?.model),
      motion: MOTION[status], step: s.j + 1, fails, side: 1, lift: 0, badgeTop: Math.round((input.tops?.[s.b] ?? 4) + (1 - scale) * 60), scale,
    };
  });
  const ground = buildGround(phi);
  assignBadges(actors, zoom, ground.box.x0);

  const blocks: FrameBlock[] = D.map((d, q) => {
    const [px, py] = spot[q]!;
    const here = actors.filter((a) => a.tile === q && a.present);
    const busy = here.some((a) => a.busy);
    const B = drawBuilding(d.archetype, heights[q]!, L, busy, hover === q && sel !== q, phi, cache);
    const lines = here.map((a) => ({ text: `${a.short} ${a.busy ? a.verb : statusText(a, t)}`, model: a.busy && a.modelFamily ? ` · ${a.modelFamily}` : "", ink: "", b: a.b }));
    return {
      district: d, l: Math.round(px - BX), t: Math.round(py - BY), z: depth(phi, d.gx, d.gy),
      faces: B.faces, hit: B.hull, ring: B.ring, busy, flag: flagged.has(q),
      fx: { on: busy, x: Math.round(B.emit[0]), y: Math.round(B.emit[1] - 4) },
      px: Math.round(px), plateY: Math.round(py + B.top - (flagged.has(q) ? 8 : 6)),
      name: placeName(d, t), n: counts[q] || "", lines,
    };
  });
  layoutPlates(blocks, actors, spot, zoom);

  const tint = (c: string) => {
    let x = c;
    if (L.w) x = mix(x, "#ffb070", 0.12 * L.w);
    if (L.n) x = mix(x, NIGHT, 0.36 * L.n);
    return x;
  };
  const slabs = ground.slabs.map((s) => ({
    z: s.z,
    faces: s.faces.map((f) => { const fill = tint(mix(SHADE, f.col, f.shade)); return { d: f.d, fill, stroke: mix(fill, NIGHT, 0.22) }; }),
    puffs: s.puffs.map((p) => ({ ...p, fill: tint("#ffffff") })),
  }));

  return {
    idx, at, actors, blocks,
    trees: TREES.map(([gx, gy], i) => { const [x, y] = proj(phi, gx, gy, 0); return { l: Math.round(x - 15), t: Math.round(y - 41), z: depth(phi, gx, gy), pine: i % 2 === 0 }; }),
    lamps: LAMPS.map(([gx, gy]) => { const [x, y] = proj(phi, gx, gy, 0); return { l: Math.round(x - 6), t: Math.round(y - 33), z: depth(phi, gx, gy) }; }),
    ground, slabs,
    roadFill: tint("#efe3c6"), roadEdge: tint("#d6c49c"),
    sky: {
      top: mix(mix("#cfe7f2", "#f6cfa6", L.w), "#141c38", L.n),
      bottom: mix(mix("#eef6ec", "#f3e3cf", L.w), "#2e3b66", L.n),
      stars: Math.max(0, L.n - 0.3) / 0.7,
    },
    live, quest,
  };
}
