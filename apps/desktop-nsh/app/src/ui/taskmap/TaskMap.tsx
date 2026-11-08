/**
 * A task map (`TaskMap.svelte`): a project session's agent at work, drawn as a town of the
 * project's folders with the subagents it sent out (ADR 0096), or, from a Bot conversation, one
 * plan (这件事) its Bots worked on, wherever they did it — the group, your directs, their directs
 * with each other (ADR 0097). A conversation with no plan yet draws its own work. It reads the work
 * back (from the agent's own files, or the app's record of each Bot call), then follows the tool
 * calls live; the town is laid out once from what it read, and what comes after folds into it.
 */
import { Scroll, Text, View, cleanup, computed, effect, signal, untracked } from "nsh";
import type { SessionSummary, SessionTaskSummary } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api";
import { defaultJob, planTitle } from "../../m/overlays/plan-board";
import { characterLooks, conversationLabel } from "../../m/taskmap/characters";
import { buildDistricts, type DistrictKind, type DistrictMap } from "../../m/taskmap/districts";
import { buildFrame, placeName, timeAt, verbOf, type WalkState } from "../../m/taskmap/frame";
import { placeDetail, tripsByPlace } from "../../m/taskmap/inspect";
import type { AgentCallLog } from "../../m/taskmap/live.svelte";
import { fromAgentReplay, fromPlanReplay, fromSessionReplay, mergeLive, type LiveCall, type MapCall, type MapData } from "../../m/taskmap/map-data";
import { MOMENT_COLOR, momentText } from "../../m/taskmap/moment-text";
import { fitZoom, normalizePhi, turnTarget } from "../../m/taskmap/scene/camera";
import { buildGround, lightAt, type ModelCache } from "../../m/taskmap/scene/draw";
import { drawFigure, figureTint } from "../../m/taskmap/scene/figures";
import { axes, proj, unproj } from "../../m/taskmap/scene/geometry";
import { buildTimeline } from "../../m/taskmap/timeline";
import { copy, runtime } from "../../runtime";
import { TraceJobSwitcher } from "../overlays/TraceJobSwitcher";
import { cssColor } from "../styles";
import { MapHud } from "./MapHud";
import { MapScene } from "./MapScene";
import { MapSide } from "./MapSide";
import { MapTimeline } from "./MapTimeline";

type Cam = { tx: number; ty: number; k: number };

/** The agent first, then each subagent; the agent wears the app's accent. */
const COLORS = ["#146a7c", "#3b5bdb", "#9c36b5", "#2b8a3e", "#c0623a", "#b45309"];
const colorOf = (b: number) => COLORS[b % COLORS.length]!;
const K_MAX = 2.5;
const pad = (n: number) => String(n).padStart(2, "0");

export type TaskMapClient = Pick<MessengerApi, "sessionTasks" | "planReplay" | "sessionReplay" | "projectReplay">;

export function TaskMap(props: {
  session: SessionSummary;
  /** The plan to open on, as the flow's tab does; null or absent: the conversation's own pick. */
  taskId?: string | null;
  /** The plan now on the map, so the tab comes back to it. */
  onTask?: (taskId: string) => void;
  /** Where the replays come from and the live calls are kept: the runtime's, unless a screen supplies its own. */
  client?: TaskMapClient | null;
  agentCalls?: AgentCallLog;
}) {
  const t = () => copy();
  const session = () => props.session;
  // The pane hands over a new summary of the conversation on every change to it (each streamed line):
  // what reads it reads these, which change only with another conversation, so nothing is read anew.
  const sessionId = computed(() => session().id);
  const bots = computed(() => session().kind !== "project");
  const client = (): TaskMapClient | null => props.client ?? runtime.client;
  const agentCalls = () => props.agentCalls ?? runtime.agentCalls;
  // A Bot map's places are the workspace's: its root, where messages, questions and plans are made, and what lies outside it.
  const tm = computed(() => {
    const m = t().taskmap;
    return bots()
      ? {
          ...m,
          places: { ...m.places, root: m.bots.root, outside: m.bots.outside, other: m.bots.other },
          placePaths: { ...m.placePaths, root: m.bots.rootPath, outside: m.bots.outsidePath },
          empty: m.bots.empty,
          note: m.bots.note,
        }
      : m;
  });
  const agent = computed(() => session().project_agent ?? "claude_code");
  const projectDir = computed(() => session().project_dir ?? null);
  const agentName = () => t().project.agentNames[agent()];

  // --- Which plan: the one picked here, else the one asked for if the conversation has it, else its newest work ---
  const jobs = signal<SessionTaskSummary[]>([]);
  const jobsRead = signal(false);
  const chosenPlan = signal<string | null>(null);
  const switcherOpen = signal(false);
  effect(() => {
    const id = sessionId();
    if (!bots()) return;
    untracked(() => {
      jobs.set([]);
      jobsRead.set(false);
      chosenPlan.set(null);
      const api = client();
      if (!api) return;
      // A daemon that cannot list them (or an older one) leaves the conversation's own map.
      Promise.resolve()
        .then(() => api.sessionTasks(id))
        .then((listed) => {
          if (id === sessionId()) jobs.set(listed);
        })
        .catch(() => {})
        .finally(() => {
          if (id === sessionId()) jobsRead.set(true);
        });
    });
  });
  // Asked for another plan (from the flow's 地图): that one, over what was picked here.
  effect(() => {
    void props.taskId;
    untracked(() => chosenPlan.set(null));
  });
  const planId = computed<string | null>(() =>
    bots() ? (chosenPlan() ?? (props.taskId && jobs().some((job) => job.id === props.taskId) ? props.taskId : (defaultJob(jobs())?.id ?? null))) : null,
  );
  // What an empty town says: a plan with nothing recorded yet, or a conversation with no plan.
  const emptyText = () => (bots() && planId() ? t().taskmap.plan.empty : tm().empty);
  function pickPlan(id: string): void {
    switcherOpen.set(false);
    if (id === planId()) return;
    chosenPlan.set(id);
    props.onTask?.(id);
  }

  // --- What it read, and what has happened since ---
  const base = signal<MapData | null>(null);
  const districts = signal<DistrictMap | null>(null);
  const failed = signal<string | null>(null);
  const loading = signal(true);
  const truncated = signal(false);
  let seq = 0;
  let laidFrom = 0;
  function lay(calls: readonly MapCall[]): void {
    districts.set(buildDistricts(calls.map((c) => c.place)));
    laidFrom = calls.length;
  }

  async function load(): Promise<void> {
    const api = client();
    if (!api) return;
    const mine = ++seq;
    try {
      let data: MapData;
      const plan = planId();
      if (bots() && plan) {
        const replay = await api.planReplay(plan);
        if (mine !== seq) return;
        data = fromPlanReplay(replay);
        truncated.set(replay.truncated);
      } else if (bots()) {
        const replay = await api.sessionReplay(sessionId());
        if (mine !== seq) return;
        data = fromSessionReplay(replay);
        truncated.set(replay.truncated);
      } else {
        const replay = await api.projectReplay(sessionId());
        if (mine !== seq) return;
        data = fromAgentReplay(replay, agent());
      }
      const merged = mergeLive(data, untracked(liveOf), belongs);
      // The town is laid out once; only a session grown half again is laid out anew, between runs.
      if (!untracked(districts) || merged.calls.length >= Math.max(laidFrom * 1.5, laidFrom + 4)) lay(merged.calls);
      base.set(data);
      failed.set(null);
    } catch (error) {
      if (mine === seq) failed.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (mine === seq) loading.set(false);
    }
  }

  // The pane hands over a new summary of the conversation on every change to it; only another
  // conversation, or another plan, is read anew, or the town blinks out each time. A Bot
  // conversation waits for its plans to be listed before it reads one.
  const shownKey = computed<string | null>(() => (bots() ? (jobsRead() ? `${sessionId()}:${planId() ?? ""}` : null) : sessionId()));
  effect(() => {
    if (shownKey() === null) return;
    untracked(() => {
      base.set(null);
      districts.set(null);
      laidFrom = 0;
      loading.set(true);
      void load();
    });
  });

  const run = () => runtime.snapshot.agentRuns[sessionId()] ?? null;
  const working = (status: string) => status === "running" || status === "waiting_approval" || status === "waiting_ask";
  // A project session runs while its agent's run does; a plan while any of its turns does, wherever;
  // a conversation with no plan while any of its turns does.
  const liveRun = computed(() =>
    !bots()
      ? run()?.status === "running" || run()?.status === "waiting_approval"
      : planId()
        ? runtime.snapshot.turns.some((turn) => turn.task_id === planId() && working(turn.status))
        : runtime.snapshot.turns.some((turn) => turn.session_id === sessionId() && working(turn.status)),
  );
  // Which live calls are this map's: a plan's are its turns' — as the turn says now, so one filed into
  // the plan mid-turn brings its earlier calls — in any conversation; otherwise the conversation's own.
  const turnsById = computed(() => new Map(runtime.snapshot.turns.map((turn) => [turn.id, turn])));
  const belongs = (call: LiveCall): boolean =>
    planId() ? (turnsById().get(call.turnId)?.task_id ?? call.taskId) === planId() : call.sessionId === sessionId();
  const liveOf = (): LiveCall[] => (planId() ? agentCalls().all() : agentCalls().callsOf(sessionId()));
  // A run that ends has written its calls down; a reconnect may have missed frames.
  let wasLive = false;
  effect(() => {
    const now = liveRun();
    if (wasLive && !now) void untracked(load);
    wasLive = now;
  });
  let lastConnection = untracked(() => runtime.connection);
  effect(() => {
    const c = runtime.connection;
    if (c === "connected" && lastConnection !== "connected") {
      untracked(() => {
        const b = base();
        const shown = b?.source.kind === "plan" ? b.source.sessions : [];
        for (const id of new Set([sessionId(), ...shown])) agentCalls().forget(id);
        void load();
      });
    }
    lastConnection = c;
  });

  const liveCalls = computed(liveOf);
  const data = computed<MapData | null>(() => (base() ? mergeLive(base()!, liveCalls(), belongs) : null));
  // A new session's town is laid out by its first live calls, until one of its folders is a place.
  effect(() => {
    const d = data();
    const map = districts();
    if (!d || !map || map.districts.some((x) => x.kind === "code")) return;
    if (d.calls.length > laidFrom) untracked(() => lay(d.calls));
  });
  const tl = computed(() => (data() && districts() ? buildTimeline(data()!, districts()!) : null));
  const trips = computed(() => (data() && tl() && districts() ? tripsByPlace(data()!, tl()!, districts()!.districts.length) : []));

  // --- The clock: at its newest step unless you play or scrub ---
  const v = signal(0);
  const playing = signal(false);
  const speed = signal(4);
  const atLive = signal(true);
  const shown = () => (tl() ? (atLive() ? tl()!.total : Math.min(v(), tl()!.total)) : 0);

  effect(() => {
    if (!playing()) return;
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(now: number) {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const total = untracked(() => tl()?.total ?? 0);
      const next = untracked(v) + dt * untracked(speed);
      if (next >= total) {
        v.set(total);
        playing.set(false);
        atLive.set(true);
        return;
      }
      v.set(next);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  });

  function toggle(): void {
    const line = tl();
    if (!line) return;
    if (playing()) {
      playing.set(false);
      return;
    }
    if (atLive() || v() >= line.total - 0.05) v.set(0);
    atLive.set(false);
    playing.set(true);
  }
  function seek(to: number): void {
    const line = tl();
    if (!line) return;
    playing.set(false);
    v.set(Math.max(0, Math.min(line.total, to)));
    atLive.set(v() >= line.total - 0.05);
  }

  // --- The camera: fitted to the pane, turned about the ground under its middle ---
  const size = signal({ w: 0, h: 0 });
  const width = signal(0);
  const phi = signal(0);
  const cam = signal<Cam>({ tx: 0, ty: 0, k: 1 });
  const camMs = signal(0);
  const turning = signal(false);
  const follow = signal(-1);
  const ground = computed(() => buildGround(phi()));
  const kMin = computed(() => (size().w ? Math.min(1, fitZoom(ground().box, size().w, size().h) * 0.96) : 1));

  function clamp(c: Cam): Cam {
    const b = ground().box;
    const { w, h } = size();
    const mx = Math.min(120, w * 0.25);
    const my = Math.min(100, h * 0.25);
    return {
      k: c.k,
      tx: Math.min(w - mx - b.x0 * c.k, Math.max(mx - b.x1 * c.k, c.tx)),
      ty: Math.min(h - my - b.y0 * c.k, Math.max(my - b.y1 * c.k, c.ty)),
    };
  }
  /** The whole town in the pane, centred, at the turn `atPhi`. */
  function fitted(atPhi = phi()): Cam {
    const b = atPhi === phi() ? ground().box : buildGround(atPhi).box;
    const { w, h } = size();
    const k = Math.min(1, fitZoom(b, w, h) * 0.96);
    return { k, tx: (w - (b.x0 + b.x1) * k) / 2, ty: (h - (b.y0 + b.y1) * k) / 2 };
  }
  let fittedOnce = false;
  // A pane grown past the town zooms in to fit once it stops: a zoom lays out every plate anew, and a
  // divider in hand grows the pane by the pixel.
  let refit: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(refit));
  effect(() => {
    const { w, h } = size();
    if (!w || !h) return;
    untracked(() => {
      if (!fittedOnce) {
        fittedOnce = true;
        cam.set(fitted());
        return;
      }
      clearTimeout(refit);
      refit = setTimeout(() => {
        if (cam().k < kMin()) cam.set(clamp({ ...cam(), k: kMin() }));
      }, 150);
    });
  });

  function pan(dx: number, dy: number): void {
    follow.set(-1);
    camMs.set(0);
    cam.set(clamp({ k: cam().k, tx: cam().tx + dx, ty: cam().ty + dy }));
  }
  function zoomAt(factor: number, x: number, y: number, ms = 0): void {
    const c = cam();
    const k = Math.min(K_MAX, Math.max(kMin(), c.k * factor));
    if (Math.abs(k - c.k) < 1e-4) return;
    camMs.set(ms);
    if (follow() >= 0) cam.set({ ...c, k });
    else cam.set(clamp({ k, tx: x - ((x - c.tx) * k) / c.k, ty: y - ((y - c.ty) * k) / c.k }));
  }
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  function rotateTo(deg: number): void {
    const c = cam();
    const { w, h } = size();
    const g = unproj(phi(), (w / 2 - c.tx) / c.k, (h / 2 - c.ty) / c.k);
    phi.set(normalizePhi(deg));
    turning.set(true);
    camMs.set(0);
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => turning.set(false), 250);
    if (follow() >= 0) return;
    const [wx, wy] = proj(phi(), g[0], g[1], 0);
    cam.set(clamp({ k: c.k, tx: w / 2 - wx * c.k, ty: h / 2 - wy * c.k }));
  }
  let spinRaf = 0;
  let spinTarget: number | null = null;
  function spinTo(target: number, camTo?: Cam): void {
    cancelAnimationFrame(spinRaf);
    const from = phi();
    const c0 = { ...cam() };
    const t0 = performance.now();
    spinTarget = target;
    const step = (now: number) => {
      const u = Math.min(1, Math.max(0, (now - t0) / 420));
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      if (camTo) {
        phi.set(normalizePhi(from + (target - from) * e));
        cam.set({ tx: c0.tx + (camTo.tx - c0.tx) * e, ty: c0.ty + (camTo.ty - c0.ty) * e, k: c0.k + (camTo.k - c0.k) * e });
        turning.set(true);
      } else rotateTo(from + (target - from) * e);
      if (u < 1) spinRaf = requestAnimationFrame(step);
      else {
        spinTarget = null;
        turning.set(false);
      }
    };
    spinRaf = requestAnimationFrame(step);
  }
  const turnBy = (dir: 1 | -1) => spinTo(turnTarget(spinTarget ?? phi(), dir));
  const face = () => spinTo(phi() > 180 ? 360 : 0);
  function reset(): void {
    follow.set(-1);
    spinTo(phi() > 180 ? 360 : 0, fitted(0));
  }
  function toggleFollow(b: number): void {
    if (follow() === b) {
      follow.set(-1);
      return;
    }
    if (cam().k < 1.5) cam.set({ ...cam(), k: Math.min(K_MAX, 1.5) });
    follow.set(b);
  }
  cleanup(() => {
    cancelAnimationFrame(spinRaf);
    clearTimeout(turnTimer);
  });

  // Each character's name, figure and whose model it works on: the agent's logo, or each Bot as the sidebar shows it.
  const looks = computed(() =>
    data()
      ? characterLooks(data()!, {
          agentName: agentName(),
          bots: runtime.snapshot.bots,
          providers: runtime.snapshot.providers,
          defaultProviderId: runtime.snapshot.settings.default_provider_id,
          t: t(),
        })
      : [],
  );
  // Each character's figure with its face and the avatar on its pin; the hour's light tints them all alike.
  const figures = computed(() => looks().map((look) => ({ ...drawFigure(look.figure, look.face), avatar: look.avatar })));

  // --- One frame of the town ---
  const cache: ModelCache = new Map();
  const walk: WalkState = { lastTile: [], until: [] };
  const hover = signal(-1);
  const sel = signal(-1);
  // A session at rest, seen at its newest step, reads as resting since then rather than mid-step.
  const wall = signal(Date.now());
  effect(() => {
    if (!atLive() || liveRun()) return;
    wall.set(Date.now());
    const id = setInterval(() => wall.set(Date.now()), 30_000);
    return () => clearInterval(id);
  });
  const rest = () => (atLive() && !liveRun() ? wall() : undefined);
  const at = () => (data() && tl() ? Math.max(timeAt(data()!, tl()!, shown()), rest() ?? 0) : Date.now());
  const light = computed(() => {
    const d = new Date(at());
    return lightAt(d.getHours() + d.getMinutes() / 60);
  });
  const frame = computed(() =>
    data() && tl() && districts()
      ? buildFrame({
          data: data()!,
          map: districts()!,
          tl: tl()!,
          v: shown(),
          rest: rest(),
          phi: phi(),
          zoom: cam().k,
          now: performance.now(),
          speed: speed(),
          light: light(),
          cache,
          walk,
          hover: hover(),
          sel: sel(),
          t: tm(),
          names: bots() ? looks().map((l) => l.name) : undefined,
          tops: figures().map((f) => f.top),
        })
      : null,
  );
  const walkMs = () => (turning() ? 0 : speed() >= 16 ? 220 : 480);

  // A followed character keeps the camera on it, gliding as long as its own hop.
  effect(() => {
    const a = follow() >= 0 ? frame()?.actors[follow()] : undefined;
    const { w, h } = size();
    if (!a || !w) return;
    const k = untracked(() => cam().k);
    const next = { k, tx: w / 2 - (a.x + 29) * k, ty: h / 2 + 40 - (a.y + 60) * k };
    untracked(() => {
      const c = cam();
      if (Math.abs(next.tx - c.tx) > 0.5 || Math.abs(next.ty - c.ty) > 0.5) {
        camMs.set(turning() ? 0 : walkMs());
        cam.set(next);
      }
    });
  });

  // --- What the cards say ---
  const who = (b: number) => ({ short: bots() ? (looks()[b]?.name ?? tm().mainLane) : b === 0 ? tm().mainLane : tm().subagent(b), color: colorOf(b) });
  const sameDay = computed(() => {
    const calls = data()?.calls;
    if (!calls?.length) return true;
    return new Date(calls[0]!.at).toDateString() === new Date(calls[calls.length - 1]!.at).toDateString();
  });
  const when = (ms: number) => {
    const d = new Date(ms);
    return `${sameDay() ? "" : `${d.getMonth() + 1}/${d.getDate()} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const placeOf = (q: number) => (districts()?.districts[q] ? placeName(districts()!.districts[q]!, tm()) : "");
  /** A long folder from its end, where the names that tell places apart are. */
  const tail = (path: string) => {
    if (path.length <= 30) return path;
    const parts = path.split("/");
    let out = parts.pop()!;
    while (parts.length && out.length + parts[parts.length - 1]!.length < 27) out = `${parts.pop()}/${out}`;
    return `…/${out}`;
  };
  /** What a place stands for under its name: a folder from its end, the servers called, or the fixed place's own line. */
  const placePath = (kind: DistrictKind, path: string, short: boolean) =>
    kind === "code" ? (short ? tail(path) : path) : kind === "service" && path ? `${tm().placePaths.service} · ${path}` : tm().placePaths[kind];
  const legend = computed(() => (districts() ? districts()!.districts.map((d) => ({ name: placeName(d, tm()), path: placePath(d.kind, d.path, true), color: d.color })) : []));
  const picked = computed(() => {
    const map = districts();
    const f = frame();
    if (!data() || !tl() || !map || !f || sel() < 0 || !map.districts[sel()]) return null;
    const d = map.districts[sel()]!;
    const full = placePath(d.kind, d.path, false);
    return { name: placeName(d, tm()), path: d.kind === "code" ? tail(full) : full, full, color: d.color, detail: placeDetail(data()!, tl()!, trips()[sel()] ?? [], sel(), f.idx, shown()) };
  });
  // --- A plan across conversations: each one named the way the sidebar names it ---
  const conv = (id: string, b?: number) =>
    conversationLabel(id, runtime.snapshot.sessions, runtime.snapshot.bots, t(), b === undefined ? undefined : data()?.characters[b]?.key);
  const moments = computed(() =>
    tl() && data()
      ? tl()!.moments.map((m) => ({
          ...momentText(m, tm(), (b) => who(b).short, placeOf, when, (b) => data()!.characters[b]?.description ?? who(b).short, conv),
          v: m.v,
        }))
      : [],
  );
  const lanes = computed(() => (data() ? data()!.characters.map((_, b) => ({ label: who(b).short, color: colorOf(b) })) : []));
  const needle = computed(() => {
    const ax = axes(phi());
    return (Math.atan2(-(ax.ex[0] + ax.ey[0]), ax.ex[1] + ax.ey[1]) * 180) / Math.PI;
  });
  // Each island is labelled by the places standing on it, or by what it is for while it is empty.
  const islandLabel = (island: "ext" | "ws", empty: string) => {
    const names = (districts()?.districts ?? []).filter((d) => d.island === island).map((d) => placeName(d, tm()));
    return names.length ? names.join(" · ") : empty;
  };
  const planSource = () => {
    const source = data()?.source;
    return source?.kind === "plan" ? source : null;
  };
  const regionLabels = computed(() => ({
    ext: islandLabel("ext", bots() ? `${tm().places.service} · ${tm().places.outside}` : `${tm().places.outside} · ${tm().places.claude_home}`),
    ws: islandLabel("ws", `${tm().places.git} · ${tm().places.other}`),
    town: `${((planSource()?.dir ?? (bots() ? runtime.snapshot.settings.workspace_path : projectDir())) ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""}/`,
  }));
  const wide = () => width() >= 760;
  const compact = () => size().w < 560 || size().h < 460;
  const across = () => planSource()?.sessions.length ?? 0;
  const shownJob = () => jobs().find((job) => job.id === planId()) ?? null;
  const colors = () => (data() ? data()!.characters.map((_, b) => colorOf(b)) : []);
  const skyTop = () => frame()?.sky.top ?? "#cfe7f2";
  const skyBottom = () => frame()?.sky.bottom ?? "#eef6ec";
  const ready = () => Boolean(frame() && districts() && data());

  const head = () => (
    <If when={bots() && jobs().length > 0}>
      <View testID="taskmap-head" class="flex-row items-center gap-[10px] min-w-0 px-3 py-[6px] border-b border-line-subtle bg-pane">
        <TraceJobSwitcher
          jobs={jobs()}
          currentId={planId()}
          heading={shownJob() ? planTitle(shownJob()!) : ""}
          open={switcherOpen()}
          onOpenChange={(open) => switcherOpen.set(open)}
          onSelectJob={pickPlan}
        />
        <If when={across() > 1}>
          <Text testID="taskmap-across" class="shrink-0 text-[13px] text-ink-muted">{tm().plan.across(across())}</Text>
        </If>
      </View>
    </If>
  );

  const stage = () => (
    <View
      testID="taskmap-stage"
      class="relative overflow-hidden"
      style={{
        backgroundImage: `linear-gradient(180deg, ${cssColor(skyTop())} 0%, ${cssColor(skyBottom())} 100%)`,
        ...(wide() ? { flex: 1, minHeight: 0 } : { height: Math.max(260, Math.min(560, Math.round(width() * 0.8))) }),
      }}
      onLayout={(e) => size.set({ w: e.bounds.size.width, h: e.bounds.size.height })}
    >
      <If
        when={ready()}
        else={
          <If
            when={failed()}
            else={
              <If when={loading()}>
                <Text testID="taskmap-loading" class="absolute left-0 top-0 right-0 bottom-0 p-6 text-center text-[13px]" style={{ color: "#37444a", textAlignVertical: "center", pointerEvents: "none" }}>
                  {tm().loading}
                </Text>
              </If>
            }
          >
            {(error) => (
              <Text testID="taskmap-failed" class="absolute left-0 top-0 right-0 bottom-0 p-6 text-center text-[13px]" style={{ color: "#37444a", pointerEvents: "none" }}>
                {tm().failed(error())}
              </Text>
            )}
          </If>
        }
      >
        <MapScene
          frame={frame()!}
          logos={looks().map((l) => l.source)}
          figures={figures()}
          tint={figureTint(light())}
          colors={colors()}
          cam={cam()}
          camMs={camMs()}
          walkMs={walkMs()}
          sel={sel()}
          hover={hover()}
          follow={follow()}
          labels={regionLabels()}
          t={tm()}
          onPan={pan}
          onTurn={(d) => rotateTo(phi() + d)}
          onZoom={(f, x, y) => zoomAt(f, x, y)}
          onPick={(q) => sel.set(sel() === q ? -1 : q)}
          onHover={(q) => hover.set(q)}
          onFollow={toggleFollow}
          onDeselect={() => sel.set(-1)}
          onDragging={(turn) => {
            turning.set(turn === true);
            if (turn === false) follow.set(-1);
          }}
        />
        <MapHud
          t={tm()}
          legend={legend()}
          hover={hover()}
          picked={picked()}
          who={who}
          when={when}
          verbOfCall={(i) => {
            const c = data()!.calls[i];
            return c ? `${verbOf(c, tm())}${c.file ? ` ${c.file}` : ""}` : "";
          }}
          phi={phi()}
          needle={needle()}
          zoom={cam().k}
          zoomMin={kMin()}
          zoomMax={K_MAX}
          following={follow() >= 0 ? who(follow()).short : null}
          compact={compact()}
          onTurnBy={turnBy}
          onTurn={(d) => rotateTo(phi() + d)}
          onFace={face}
          onZoom={(f) => zoomAt(f, size().w / 2, size().h / 2, 260)}
          onReset={reset}
          onStopFollow={() => follow.set(-1)}
          onClosePlace={() => sel.set(-1)}
          onJump={seek}
        />
        <If when={data()!.calls.length === 0}>
          <Text testID="taskmap-empty" class="absolute left-0 top-0 right-0 bottom-0 p-6 text-center text-[13px]" style={{ color: "#37444a", pointerEvents: "none", zIndex: 650 }}>
            {emptyText()}
          </Text>
        </If>
      </If>
    </View>
  );

  const clock = () => (
    <If when={tl() && data()}>
      <MapTimeline
        t={tm()}
        tl={tl()!}
        v={shown()}
        playing={playing()}
        speed={speed()}
        liveRun={liveRun()}
        atLive={atLive()}
        step={(frame()?.idx ?? -1) + 1}
        steps={data()!.calls.length}
        lanes={lanes()}
        markColor={(kind) => MOMENT_COLOR[kind as keyof typeof MOMENT_COLOR] ?? "#95a2a8"}
        ticks={picked()?.detail.ticks ?? []}
        tickNote={picked() ? tm().insp.ticks(picked()!.name) : ""}
        onToggle={toggle}
        onSpeed={(s) => speed.set(s)}
        onSeek={seek}
        onLive={() => {
          playing.set(false);
          atLive.set(true);
        }}
      />
    </If>
  );

  const aside = () => (
    <If when={tl() && data()}>
      <View testID="taskmap-aside" class={`p-[10px] gap-2 ${wide() ? "flex-1 min-h-0 border-l border-line-subtle" : "border-t border-line-subtle"}`}>
        <MapSide
          t={tm()}
          looks={looks()}
          faces={bots()}
          actors={frame()?.actors ?? []}
          colors={colors()}
          place={placeOf}
          follow={follow()}
          quests={tl()!.quests}
          quest={frame()?.quest ?? -1}
          moments={moments()}
          live={frame()?.live ?? -1}
          when={when}
          conv={conv}
          showConv={across() > 1}
          onFollow={toggleFollow}
          onJump={seek}
        />
        <If when={bots() && jobsRead() && !planId()}>
          <Text testID="taskmap-no-plan" class="text-[11px] text-ink-muted">{tm().plan.noPlan}</Text>
        </If>
        <Text testID="taskmap-note" class="text-[11px] text-ink-muted">
          {`${truncated() ? `${tm().bots.truncated(data()!.calls.length)} ` : ""}${tm().note}`}
        </Text>
      </View>
    </If>
  );

  return (
    <View testID="taskmap" class="flex-1 min-h-0 bg-ground" onLayout={(e) => width.set(e.bounds.size.width)}>
      <If
        when={wide()}
        else={
          <Scroll class="flex-1 min-h-0">
            {head()}
            {stage()}
            {clock()}
            {aside()}
          </Scroll>
        }
      >
        <View class="flex-1 min-h-0 flex-row">
          <View class="flex-1 min-w-0 min-h-0">
            {head()}
            {stage()}
            {clock()}
          </View>
          <View class="w-[300px] shrink-0 min-h-0">
            <Scroll class="flex-1 min-h-0">{aside()}</Scroll>
          </View>
        </View>
      </If>
    </View>
  );
}
