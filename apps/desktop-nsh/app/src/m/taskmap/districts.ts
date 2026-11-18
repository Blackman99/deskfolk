import type { AgentToolPlace } from "@real-bot/protocol";
import { plot } from "./scene/geometry.ts";
import type { ArchetypeId } from "./scene/models.ts";

export type { ArchetypeId };

/**
 * What a place on the map stands for. `code` is a folder of the project; the others are the fixed
 * places every map has when they were worked in: the project's root (where questions and subagents
 * start), checks (tests and type checks), git, the MCP servers it called, Claude Code's own files,
 * anywhere else outside the project, and the folders too small to be a place of their own.
 */
export type DistrictKind = "root" | "code" | "check" | "git" | "service" | "claude_home" | "outside" | "other";

export type District = {
  key: string;
  kind: DistrictKind;
  /** A code district's folder, relative to the project ("" for the root); the servers' names for services; empty for the others. */
  path: string;
  /**
   * A code district's name on its plate: the shortest tail of its path no other district shares.
   * The services' is their server's name when there is one; empty for the other fixed places.
   */
  label: string;
  archetype: ArchetypeId;
  /** Its plate's dot, the building's main colour. */
  color: string;
  /** Where it stands, in grid units (its plot on the town's plan, `plot` apart). */
  gx: number;
  gy: number;
  /** The side island (git and the small folders) or the floating one (outside the project). */
  island?: "ws" | "ext";
  /** Calls in it when the map was laid out. */
  calls: number;
};

export type DistrictMap = {
  districts: District[];
  /** Where a call lands: a later path folds into the district whose folder holds it, never a new one. */
  indexOf(place: AgentToolPlace): number;
};

/** Each building's main colour, the one its plate dot shows; one shape each, so no two places share a colour. */
export const ARCHETYPE_COLOR: Readonly<Record<ArchetypeId, string>> = {
  camp: "#ee9550", song: "#8c7bd3", bible: "#b8574a", board: "#f2c14e", scratch: "#e9e1c8",
  tools: "#3f9a86", keys: "#5aa6d6", clips: "#3e5182", edit: "#9bc34a", review: "#d64a62",
  paint: "#e48fbd", film: "#5a5cc4", mail: "#d6b47a", kit: "#6fae5a", others: "#8a9bb0", relay: "#4a5a6e",
};

/** The fixed places: their shape and their plot (the root at the town's left, checks at its front corner). */
const FIXED: Readonly<Record<Exclude<DistrictKind, "code">, { archetype: ArchetypeId; gx: number; gy: number; island?: "ws" | "ext" }>> = {
  root: { archetype: "camp", gx: 0, gy: 1 },
  check: { archetype: "review", gx: 3, gy: 2 },
  git: { archetype: "kit", gx: -1.65, gy: 0.55, island: "ws" },
  service: { archetype: "relay", gx: 1, gy: -1.65, island: "ext" },
  other: { archetype: "others", gx: -1.65, gy: 1.65, island: "ws" },
  claude_home: { archetype: "paint", gx: 2, gy: -1.65, island: "ext" },
  outside: { archetype: "scratch", gx: 3, gy: -1.65, island: "ext" },
};

/** The town's ten other plots, in reading order, so sibling folders (sorted by path) stand side by side. */
const CODE_SLOTS: readonly (readonly [number, number])[] = [
  [0, 0], [1, 0], [2, 0], [3, 0], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2],
];

/** A folder's shape by what it is called; the first rule whose shape is still free wins. */
const SHAPE_RULES: readonly [RegExp, ArchetypeId][] = [
  [/(^|\/)(docs?|adr|behavior|wiki|notes?)(\/|$)/i, "bible"],
  [/(^|\/)(store|db|database|schema|migrations?|sql|data)(\/|$)/i, "mail"],
  [/(^|\/)(api|routes?|remote|server|http|relay|local-api)(\/|$)/i, "clips"],
  [/(^|\/)(sidebar|board|panels?|layout|workbench|overlays?)(\/|$)/i, "board"],
  [/(^|\/)(chat|messages?|conversation|copy)(\/|$)/i, "song"],
  [/(^|\/)(scripts?|tools?|build|bin|ci)(\/|$)/i, "tools"],
  [/(^|\/)(protocol|types|shared|common|packages)(\/|$)/i, "edit"],
  [/(^|\/)(tests?|spec|e2e|fixtures?|visual)(\/|$)/i, "film"],
  [/(^|\/)(claude-code|agents?|runners?|engine)(\/|$)/i, "keys"],
];
const SHAPE_CYCLE: readonly ArchetypeId[] = ["tools", "keys", "clips", "edit", "song", "board", "mail", "film", "bible"];

/**
 * A path's folder: its own when it names a folder, its parent's when it names a file (a last part
 * with a dot). Shell words a command's path picked up are taken off: a trailing `;` or `&&` (from
 * `cd apps/messenger; …`) is dropped, and a part that is a variable (`$R`) ends the path there.
 */
function folderOf(path: string): string {
  const parts: string[] = [];
  let cut = false;
  for (const raw of path.split("/")) {
    if (!raw || raw === ".") continue;
    const part = raw.replace(/[;&|)>]+$/, "");
    if (!part || part.startsWith("$") || /[$;&|<>`]/.test(part)) { cut = true; break; }
    parts.push(part);
  }
  if (!cut && parts.length && parts[parts.length - 1]!.includes(".")) parts.pop();
  return parts.join("/");
}

/** Folder names that say where code lives, not what it is: a label skips them. */
const GENERIC = new Set(["src", "lib", "app", "apps", "source", "sources", "packages", "pkg", "internal", "main", ".claude", "worktrees"]);

function fixedKind(place: AgentToolPlace): Exclude<DistrictKind, "code" | "other"> | null {
  switch (place.zone) {
    case "check": return "check";
    case "git": return "git";
    case "service": return "service";
    case "claude_home": return "claude_home";
    case "outside": return "outside";
    case "none": return "root";
    case "project": return folderOf(place.path) === "" ? "root" : null;
  }
}

type Node = { path: string; count: number; own: number; children: Map<string, Node> };

function treeOf(folders: readonly string[]): Node {
  const root: Node = { path: "", count: 0, own: 0, children: new Map() };
  for (const folder of folders) {
    let node = root;
    node.count += 1;
    for (const part of folder.split("/")) {
      const path = node.path ? `${node.path}/${part}` : part;
      let child = node.children.get(part);
      if (!child) node.children.set(part, (child = { path, count: 0, own: 0, children: new Map() }));
      child.count += 1;
      node = child;
    }
    node.own += 1;
  }
  return root;
}

/** Down a chain of folders that hold nearly all of each other ("apps/messenger" → "apps/messenger/src/lib"). */
function compress(node: Node): Node {
  let at = node;
  for (;;) {
    const kids = [...at.children.values()];
    const top = kids.sort((a, b) => b.count - a.count)[0];
    if (!top || top.count < at.count * 0.85 || at.own > at.count * 0.15) return at;
    at = top;
  }
}

/**
 * Each path's name on its plate: the shortest tail of its telling folder names (generic ones like
 * `src` and `lib` skipped, unless nothing else is left) that no other path's shares.
 */
function labelsOf(paths: readonly string[]): string[] {
  const telling = (path: string) => {
    const parts = path.split("/");
    const kept = parts.filter((p) => !GENERIC.has(p));
    return kept.length ? kept : parts;
  };
  const all = paths.map(telling);
  return all.map((parts, i) => {
    for (let n = 1; n <= parts.length; n++) {
      const tail = parts.slice(-n).join("/");
      if (all.every((other, j) => j === i || other.slice(-n).join("/") !== tail)) return tail;
    }
    return parts.join("/");
  });
}

/**
 * The map's places for a session's calls. Folders of the project are split from the busiest down
 * (the top folders first, then the busiest one into its busy children, and so on) until there are
 * `maxCode` of them or nothing busy is left to split; a folder with fewer than `floor` calls joins
 * 「仓库别处」. Deterministic: the same calls always give the same town.
 */
export function buildDistricts(places: readonly AgentToolPlace[], opts: { maxCode?: number } = {}): DistrictMap {
  const maxCode = Math.min(opts.maxCode ?? CODE_SLOTS.length, CODE_SLOTS.length);
  const fixedCounts = new Map<DistrictKind, number>();
  const folders: string[] = [];
  const servers = new Map<string, number>();
  for (const place of places) {
    const fixed = fixedKind(place);
    if (place.zone === "service") servers.set(place.server, (servers.get(place.server) ?? 0) + 1);
    if (fixed) fixedCounts.set(fixed, (fixedCounts.get(fixed) ?? 0) + 1);
    else if (place.zone === "project") folders.push(folderOf(place.path));
  }
  const floor = Math.max(2, Math.round(folders.length * 0.03));
  const tree = treeOf(folders);

  // Start from the top folders, then keep splitting the busiest place that has busy children. What
  // a folder keeps itself (its own files, its small children) counts as one more part, so a folder
  // with one busy child and plenty of its own still splits in two.
  let picked: Node[] = [...tree.children.values()].filter((n) => n.count > 0).map(compress);
  const splittable = (n: Node) => [...n.children.values()].filter((c) => c.count >= floor);
  const restOf = (n: Node) => n.count - splittable(n).reduce((s, k) => s + k.count, 0);
  for (;;) {
    picked.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    const busy = picked.filter((n) => n.count >= floor);
    const target = busy.find((n) => splittable(n).length + (restOf(n) >= floor ? 1 : 0) >= 2);
    if (!target) break;
    const kids = splittable(target).map(compress);
    const rest = restOf(target);
    const grow = kids.length + (rest >= floor ? 1 : 0) - 1;
    if (busy.length + grow > maxCode) break;
    picked = picked.filter((n) => n !== target).concat(kids);
    // What the split folder keeps itself (its own files, its small children) stays a place under its own path.
    if (rest >= floor) picked.push({ path: target.path, count: rest, own: target.own, children: new Map() });
  }
  const code = picked.filter((n) => n.count >= floor).sort((a, b) => b.count - a.count).slice(0, maxCode);
  const smallCalls = folders.length - code.reduce((s, n) => s + n.count, 0);
  code.sort((a, b) => a.path.localeCompare(b.path));

  const taken = new Set<ArchetypeId>(Object.values(FIXED).map((f) => f.archetype));
  const shapeOf = (path: string): ArchetypeId => {
    const rule = SHAPE_RULES.find(([re, shape]) => re.test(path) && !taken.has(shape));
    const shape = rule ? rule[1] : SHAPE_CYCLE.find((s) => !taken.has(s)) ?? "tools";
    taken.add(shape);
    return shape;
  };
  const labels = labelsOf(code.map((n) => n.path));
  const districts: District[] = [];
  const fixed = (kind: Exclude<DistrictKind, "code">, calls: number, path = "", label = "") => {
    const f = FIXED[kind];
    districts.push({ key: kind, kind, path, label, archetype: f.archetype, color: ARCHETYPE_COLOR[f.archetype], gx: plot(f.gx), gy: plot(f.gy), ...(f.island ? { island: f.island } : {}), calls });
  };
  fixed("root", fixedCounts.get("root") ?? 0);
  code.forEach((n, i) => {
    const archetype = shapeOf(n.path);
    const [gx, gy] = CODE_SLOTS[i]!;
    districts.push({ key: `code:${n.path}`, kind: "code", path: n.path, label: labels[i]!, archetype, color: ARCHETYPE_COLOR[archetype], gx: plot(gx), gy: plot(gy), calls: n.count });
  });
  for (const kind of ["check", "git", "service", "claude_home", "outside"] as const) {
    if (!fixedCounts.get(kind)) continue;
    // One building for every server, the busiest first; its plate names the server when there is one.
    const names = [...servers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    if (kind === "service") fixed(kind, fixedCounts.get(kind)!, names.join(" · "), names.length === 1 ? names[0]! : "");
    else fixed(kind, fixedCounts.get(kind)!);
  }
  if (smallCalls > 0) fixed("other", smallCalls);

  const byKind = new Map(districts.map((d, i) => [d.kind, i]));
  const codeIndex = districts.map((d, i) => [d, i] as const).filter(([d]) => d.kind === "code").sort((a, b) => b[0].path.length - a[0].path.length);
  const fallback = byKind.get("other") ?? 0;
  return {
    districts,
    indexOf(place) {
      const fixedK = fixedKind(place);
      if (fixedK) return byKind.get(fixedK) ?? (fixedK === "root" ? 0 : fallback);
      if (place.zone !== "project") return 0;
      const folder = folderOf(place.path);
      const hit = codeIndex.find(([d]) => folder === d.path || folder.startsWith(`${d.path}/`));
      return hit ? hit[1] : fallback;
    },
  };
}
