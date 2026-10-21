<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import { untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { characterLooks } from './characters.ts';
	import { buildDistricts, type DistrictKind, type DistrictMap } from './districts.ts';
	import { buildFrame, placeName, timeAt, verbOf, type WalkState } from './frame.ts';
	import { placeDetail, tripsByPlace } from './inspect.ts';
	import { fromAgentReplay, fromSessionReplay, mergeLive, type MapCall, type MapData } from './map-data.ts';
	import { MOMENT_COLOR, momentText } from './moment-text.ts';
	import { normalizePhi, fitZoom, turnTarget } from './scene/camera.ts';
	import { buildGround, lightAt, type ModelCache } from './scene/draw.ts';
	import { axes, proj, unproj } from './scene/geometry.ts';
	import { buildTimeline } from './timeline.ts';
	import MapHud from './MapHud.svelte';
	import MapScene from './MapScene.svelte';
	import MapSide from './MapSide.svelte';
	import MapTimeline from './MapTimeline.svelte';

	/**
	 * A conversation's task map: a project session's agent at work, drawn as a town of the project's
	 * folders with the subagents it sent out (ADR 0096), or a Bot conversation's Bots at work in the
	 * workspace (ADR 0097). It reads the work back (from the agent's own files, or from the app's record
	 * of each Bot call), then follows the tool calls live; the town is laid out once from what it read,
	 * and what comes after folds into it.
	 */
	type Props = { runtime: MessengerRuntime; t: Copy; session: SessionSummary };
	let { runtime, t, session }: Props = $props();

	const bots = $derived(session.kind !== 'project');
	// A Bot map's places are the workspace's: its root, where messages, questions and plans are made, and what lies outside it.
	const tm = $derived(
		bots
			? {
					...t.taskmap,
					places: { ...t.taskmap.places, root: t.taskmap.bots.root, outside: t.taskmap.bots.outside, other: t.taskmap.bots.other },
					placePaths: { ...t.taskmap.placePaths, root: t.taskmap.bots.rootPath, outside: t.taskmap.bots.outsidePath },
					empty: t.taskmap.bots.empty,
					note: t.taskmap.bots.note
				}
			: t.taskmap
	);
	const agent = $derived(session.project_agent ?? 'claude_code');
	const agentName = $derived(t.project.agentName);
	/** The agent first, then each subagent; the agent wears the app's accent. */
	const COLORS = ['#146a7c', '#3b5bdb', '#9c36b5', '#2b8a3e', '#c0623a', '#b45309'];
	const colorOf = (b: number) => COLORS[b % COLORS.length]!;

	// --- What it read, and what has happened since ---
	let base = $state<MapData | null>(null);
	let districts = $state<DistrictMap | null>(null);
	let failed = $state<string | null>(null);
	let loading = $state(true);
	let seq = 0;

	let truncated = $state(false);
	let laidFrom = 0;
	function lay(calls: readonly MapCall[]): void {
		districts = buildDistricts(calls.map((c) => c.place));
		laidFrom = calls.length;
	}

	async function load(): Promise<void> {
		const api = runtime.client;
		if (!api) return;
		const mine = ++seq;
		try {
			let data: MapData;
			if (bots) {
				const replay = await api.sessionReplay(session.id);
				if (mine !== seq) return;
				data = fromSessionReplay(replay);
				truncated = replay.truncated;
			} else {
				const replay = await api.projectReplay(session.id);
				if (mine !== seq) return;
				data = fromAgentReplay(replay, agent);
			}
			const merged = mergeLive(data, runtime.agentCalls.callsOf(session.id));
			// The town is laid out once; only a session grown half again is laid out anew, between runs.
			if (!districts || merged.calls.length >= Math.max(laidFrom * 1.5, laidFrom + 4)) lay(merged.calls);
			base = data;
			failed = null;
		} catch (error) {
			if (mine === seq) failed = error instanceof Error ? error.message : String(error);
		} finally {
			if (mine === seq) loading = false;
		}
	}

	$effect(() => {
		void session.id;
		untrack(() => {
			base = null;
			districts = null;
			laidFrom = 0;
			loading = true;
			void load();
		});
	});

	const run = $derived(runtime.snapshot.agentRuns[session.id] ?? null);
	// A project session runs while its agent's run does; a Bot conversation while any of its turns does.
	const liveRun = $derived(
		bots
			? runtime.snapshot.turns.some((turn) => turn.session_id === session.id && (turn.status === 'running' || turn.status === 'waiting_approval' || turn.status === 'waiting_ask'))
			: run?.status === 'running' || run?.status === 'waiting_approval'
	);
	// A run that ends has written its calls down; a reconnect may have missed frames.
	let wasLive = false;
	$effect(() => {
		const now = liveRun;
		if (wasLive && !now) void untrack(load);
		wasLive = now;
	});
	let lastConnection = untrack(() => runtime.connection);
	$effect(() => {
		const c = runtime.connection;
		if (c === 'connected' && lastConnection !== 'connected') untrack(() => { runtime.agentCalls.forget(session.id); void load(); });
		lastConnection = c;
	});

	const liveCalls = $derived(runtime.agentCalls.callsOf(session.id));
	const data = $derived(base ? mergeLive(base, liveCalls) : null);
	// A new session's town is laid out by its first live calls, until one of its folders is a place.
	$effect(() => {
		if (!data || !districts || districts.districts.some((d) => d.kind === 'code')) return;
		if (data.calls.length > laidFrom) untrack(() => lay(data.calls));
	});
	const tl = $derived(data && districts ? buildTimeline(data, districts) : null);
	const trips = $derived(data && tl && districts ? tripsByPlace(data, tl, districts.districts.length) : []);

	// --- The clock: at its newest step unless you play or scrub ---
	let v = $state(0);
	let playing = $state(false);
	let speed = $state(4);
	let atLive = $state(true);
	const shown = $derived(tl ? (atLive ? tl.total : Math.min(v, tl.total)) : 0);

	$effect(() => {
		if (!playing) return;
		let last = performance.now();
		let raf = requestAnimationFrame(function tick(now) {
			const dt = Math.min(0.25, (now - last) / 1000);
			last = now;
			const total = untrack(() => tl?.total ?? 0);
			const next = untrack(() => v) + dt * untrack(() => speed);
			if (next >= total) { v = total; playing = false; atLive = true; return; }
			v = next;
			raf = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(raf);
	});

	function toggle(): void {
		if (!tl) return;
		if (playing) { playing = false; return; }
		if (atLive || v >= tl.total - 0.05) v = 0;
		atLive = false;
		playing = true;
	}
	function seek(to: number): void {
		if (!tl) return;
		playing = false;
		v = Math.max(0, Math.min(tl.total, to));
		atLive = v >= tl.total - 0.05;
	}

	// --- The camera: fitted to the pane, turned about the ground under its middle ---
	let sceneEl = $state<HTMLDivElement | null>(null);
	let rootEl = $state<HTMLDivElement | null>(null);
	let size = $state({ w: 0, h: 0 });
	let width = $state(0);
	$effect(() => {
		const scene = sceneEl, root = rootEl;
		if (!scene || !root) return;
		let raf = 0;
		// Written on the next frame: a write inside the observer during a pane's resize loops in WebKit.
		const ro = new ResizeObserver(() => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				size = { w: scene.clientWidth, h: scene.clientHeight };
				width = root.clientWidth;
			});
		});
		ro.observe(scene);
		ro.observe(root);
		return () => { ro.disconnect(); cancelAnimationFrame(raf); };
	});

	let phi = $state(0);
	let cam = $state({ tx: 0, ty: 0, k: 1 });
	let camMs = $state(0);
	let turning = $state(false);
	let follow = $state(-1);
	const ground = $derived(buildGround(phi));
	const kMin = $derived(size.w ? Math.min(1, fitZoom(ground.box, size.w, size.h) * 0.96) : 1);
	const K_MAX = 2.5;

	function clamp(c: { tx: number; ty: number; k: number }) {
		const b = ground.box, mx = Math.min(120, size.w * 0.25), my = Math.min(100, size.h * 0.25);
		return {
			k: c.k,
			tx: Math.min(size.w - mx - b.x0 * c.k, Math.max(mx - b.x1 * c.k, c.tx)),
			ty: Math.min(size.h - my - b.y0 * c.k, Math.max(my - b.y1 * c.k, c.ty))
		};
	}
	/** The whole town in the pane, centred, at the turn `atPhi`. */
	function fitted(atPhi = phi) {
		const b = atPhi === phi ? ground.box : buildGround(atPhi).box;
		const k = Math.min(1, fitZoom(b, size.w, size.h) * 0.96);
		return { k, tx: (size.w - (b.x0 + b.x1) * k) / 2, ty: (size.h - (b.y0 + b.y1) * k) / 2 };
	}
	let fittedOnce = false;
	$effect(() => {
		if (!size.w || !size.h) return;
		untrack(() => {
			if (!fittedOnce) { fittedOnce = true; cam = fitted(); }
			else if (cam.k < kMin) cam = clamp({ ...cam, k: kMin });
		});
	});

	function pan(dx: number, dy: number): void {
		follow = -1;
		camMs = 0;
		cam = clamp({ k: cam.k, tx: cam.tx + dx, ty: cam.ty + dy });
	}
	function zoomAt(factor: number, x: number, y: number, ms = 0): void {
		const k = Math.min(K_MAX, Math.max(kMin, cam.k * factor));
		if (Math.abs(k - cam.k) < 1e-4) return;
		camMs = ms;
		if (follow >= 0) cam = { ...cam, k };
		else cam = clamp({ k, tx: x - ((x - cam.tx) * k) / cam.k, ty: y - ((y - cam.ty) * k) / cam.k });
	}
	let turnTimer: ReturnType<typeof setTimeout> | undefined;
	function rotateTo(deg: number): void {
		const c = cam;
		const g = unproj(phi, (size.w / 2 - c.tx) / c.k, (size.h / 2 - c.ty) / c.k);
		phi = normalizePhi(deg);
		turning = true;
		camMs = 0;
		clearTimeout(turnTimer);
		turnTimer = setTimeout(() => (turning = false), 250);
		if (follow >= 0) return;
		const [wx, wy] = proj(phi, g[0], g[1], 0);
		cam = clamp({ k: c.k, tx: size.w / 2 - wx * c.k, ty: size.h / 2 - wy * c.k });
	}
	let spinRaf = 0;
	let spinTarget: number | null = null;
	function spinTo(target: number, camTo?: { tx: number; ty: number; k: number }): void {
		cancelAnimationFrame(spinRaf);
		const from = phi, c0 = { ...cam }, t0 = performance.now();
		spinTarget = target;
		const step = (now: number) => {
			const u = Math.min(1, Math.max(0, (now - t0) / 420));
			const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
			if (camTo) {
				phi = normalizePhi(from + (target - from) * e);
				cam = { tx: c0.tx + (camTo.tx - c0.tx) * e, ty: c0.ty + (camTo.ty - c0.ty) * e, k: c0.k + (camTo.k - c0.k) * e };
				turning = true;
			} else rotateTo(from + (target - from) * e);
			if (u < 1) spinRaf = requestAnimationFrame(step);
			else { spinTarget = null; turning = false; }
		};
		spinRaf = requestAnimationFrame(step);
	}
	function turnBy(dir: 1 | -1): void {
		spinTo(turnTarget(spinTarget ?? phi, dir));
	}
	function face(): void {
		spinTo(phi > 180 ? 360 : 0);
	}
	function reset(): void {
		follow = -1;
		spinTo(phi > 180 ? 360 : 0, fitted(0));
	}
	function toggleFollow(b: number): void {
		if (follow === b) { follow = -1; return; }
		if (cam.k < 1.5) cam = { ...cam, k: Math.min(K_MAX, 1.5) };
		follow = b;
	}
	$effect(() => () => { cancelAnimationFrame(spinRaf); clearTimeout(turnTimer); });

	// Each character's name, figure and whose model it works on: the agent's logo, or each Bot as the sidebar shows it.
	const looks = $derived(
		data
			? characterLooks(data, { agentName, bots: runtime.snapshot.bots, providers: runtime.snapshot.providers, defaultProviderId: runtime.snapshot.settings.default_provider_id, t })
			: []
	);

	// --- One frame of the town ---
	const cache: ModelCache = new Map();
	const walk: WalkState = { lastTile: [], until: [] };
	let hover = $state(-1);
	let sel = $state(-1);
	// A session at rest, seen at its newest step, reads as resting since then rather than mid-step.
	let wall = $state(Date.now());
	$effect(() => {
		if (!atLive || liveRun) return;
		wall = Date.now();
		const id = setInterval(() => (wall = Date.now()), 30_000);
		return () => clearInterval(id);
	});
	const rest = $derived(atLive && !liveRun ? wall : undefined);
	const at = $derived(data && tl ? Math.max(timeAt(data, tl, shown), rest ?? 0) : Date.now());
	const light = $derived.by(() => { const d = new Date(at); return lightAt(d.getHours() + d.getMinutes() / 60); });
	const frame = $derived(
		data && tl && districts
			? buildFrame({ data, map: districts, tl, v: shown, rest, phi, zoom: cam.k, now: performance.now(), speed, light, cache, walk, hover, sel, t: tm, names: bots ? looks.map((l) => l.name) : undefined })
			: null
	);
	const walkMs = $derived(turning ? 0 : speed >= 16 ? 220 : 480);

	// A followed character keeps the camera on it, gliding as long as its own hop.
	$effect(() => {
		const a = follow >= 0 ? frame?.actors[follow] : undefined;
		if (!a || !size.w) return;
		const k = untrack(() => cam.k);
		const next = { k, tx: size.w / 2 - (a.x + 29) * k, ty: size.h / 2 + 40 - (a.y + 60) * k };
		untrack(() => {
			if (Math.abs(next.tx - cam.tx) > 0.5 || Math.abs(next.ty - cam.ty) > 0.5) { camMs = turning ? 0 : walkMs; cam = next; }
		});
	});

	// --- What the cards say ---
	const avatars = $derived(looks.map((l) => l.avatar));
	const who = (b: number) => ({ short: bots ? (looks[b]?.name ?? tm.mainLane) : b === 0 ? tm.mainLane : tm.subagent(b), color: colorOf(b) });
	const sameDay = $derived.by(() => {
		if (!data?.calls.length) return true;
		return new Date(data.calls[0]!.at).toDateString() === new Date(data.calls[data.calls.length - 1]!.at).toDateString();
	});
	const pad = (n: number) => String(n).padStart(2, '0');
	const when = (ms: number) => {
		const d = new Date(ms);
		return `${sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
	};
	const placeOf = (q: number) => (districts?.districts[q] ? placeName(districts.districts[q]!, tm) : '');
	/** A long folder from its end, where the names that tell places apart are. */
	const tail = (path: string) => {
		if (path.length <= 30) return path;
		const parts = path.split('/');
		let out = parts.pop()!;
		while (parts.length && out.length + parts[parts.length - 1]!.length < 27) out = `${parts.pop()}/${out}`;
		return `…/${out}`;
	};
	/** What a place stands for under its name: a folder from its end, the servers called, or the fixed place's own line. */
	const placePath = (kind: DistrictKind, path: string, short: boolean) =>
		kind === 'code' ? (short ? tail(path) : path) : kind === 'service' && path ? `${tm.placePaths.service} · ${path}` : tm.placePaths[kind];
	const legend = $derived(districts ? districts.districts.map((d) => ({ name: placeName(d, tm), path: placePath(d.kind, d.path, true), color: d.color })) : []);
	const picked = $derived.by(() => {
		if (!data || !tl || !districts || !frame || sel < 0 || !districts.districts[sel]) return null;
		const d = districts.districts[sel]!;
		const full = placePath(d.kind, d.path, false);
		return { name: placeName(d, tm), path: d.kind === 'code' ? tail(full) : full, full, color: d.color, detail: placeDetail(data, tl, trips[sel] ?? [], sel, frame.idx, shown) };
	});
	const moments = $derived(
		tl && data ? tl.moments.map((m) => ({ ...momentText(m, tm, (b) => who(b).short, placeOf, when, (b) => data.characters[b]?.description ?? who(b).short), v: m.v })) : []
	);
	const lanes = $derived(data ? data.characters.map((_, b) => ({ label: who(b).short, color: colorOf(b) })) : []);
	const needle = $derived.by(() => { const ax = axes(phi); return (Math.atan2(-(ax.ex[0] + ax.ey[0]), ax.ex[1] + ax.ey[1]) * 180) / Math.PI; });
	// Each island is labelled by the places standing on it, or by what it is for while it is empty.
	const islandLabel = (island: 'ext' | 'ws', empty: string) => {
		const names = (districts?.districts ?? []).filter((d) => d.island === island).map((d) => placeName(d, tm));
		return names.length ? names.join(' · ') : empty;
	};
	const regionLabels = $derived({
		ext: islandLabel('ext', bots ? `${tm.places.service} · ${tm.places.outside}` : `${tm.places.outside} · ${tm.places.claude_home}`),
		ws: islandLabel('ws', `${tm.places.git} · ${tm.places.other}`),
		town: `${((bots ? runtime.snapshot.settings.workspace_path : session.project_dir) ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''}/`
	});
	const wide = $derived(width >= 760);
	const compact = $derived(size.w < 560 || size.h < 460);
</script>

<div class="taskmap" class:is-wide={wide} bind:this={rootEl}>
	<div class="tm-stage" style:background="linear-gradient(180deg, {frame?.sky.top ?? '#cfe7f2'} 0%, {frame?.sky.bottom ?? '#eef6ec'} 100%)" bind:this={sceneEl}>
		{#if frame && districts && data}
			<MapScene
				{frame}
				logos={looks.map((l) => l.source)}
				{avatars}
				colors={data.characters.map((_, b) => colorOf(b))}
				{cam}
				{camMs}
				{walkMs}
				{sel}
				{hover}
				{follow}
				labels={regionLabels}
				t={tm}
				onPan={pan}
				onTurn={(d) => rotateTo(phi + d)}
				onZoom={(f, x, y) => zoomAt(f, x, y)}
				onPick={(q) => (sel = sel === q ? -1 : q)}
				onHover={(q) => (hover = q)}
				onFollow={toggleFollow}
				onDeselect={() => (sel = -1)}
				onDragging={(turn) => { turning = turn === true; if (turn === false) follow = -1; }}
			/>
			<MapHud
				t={tm}
				{legend}
				{hover}
				{picked}
				{who}
				{when}
				verbOfCall={(i) => { const c = data.calls[i]; return c ? `${verbOf(c, tm)}${c.file ? ` ${c.file}` : ''}` : ''; }}
				{phi}
				{needle}
				zoom={cam.k}
				zoomMin={kMin}
				zoomMax={K_MAX}
				following={follow >= 0 ? who(follow).short : null}
				{compact}
				onTurnBy={turnBy}
				onTurn={(d) => rotateTo(phi + d)}
				onFace={face}
				onZoom={(f) => zoomAt(f, size.w / 2, size.h / 2, 260)}
				onReset={reset}
				onStopFollow={() => (follow = -1)}
				onClosePlace={() => (sel = -1)}
				onJump={seek}
			/>
			{#if data.calls.length === 0}<p class="tm-empty">{tm.empty}</p>{/if}
		{:else if failed}
			<p class="tm-empty">{tm.failed(failed)}</p>
		{:else if loading}
			<p class="tm-empty">{tm.loading}</p>
		{/if}
	</div>
	{#if tl && data}
		<div class="tm-clock">
			<MapTimeline
				t={tm}
				{tl}
				v={shown}
				{playing}
				{speed}
				{liveRun}
				{atLive}
				step={(frame?.idx ?? -1) + 1}
				steps={data.calls.length}
				{lanes}
				markColor={(kind) => MOMENT_COLOR[kind as keyof typeof MOMENT_COLOR] ?? 'var(--muted)'}
				ticks={picked?.detail.ticks ?? []}
				tickNote={picked ? tm.insp.ticks(picked.name) : ''}
				onToggle={toggle}
				onSpeed={(s) => (speed = s)}
				onSeek={seek}
				onLive={() => { playing = false; atLive = true; }}
			/>
		</div>
		<aside class="tm-aside">
			<MapSide
				t={tm}
				{looks}
				faces={bots}
				actors={frame?.actors ?? []}
				colors={data.characters.map((_, b) => colorOf(b))}
				place={placeOf}
				{follow}
				quests={tl.quests}
				quest={frame?.quest ?? -1}
				{moments}
				live={frame?.live ?? -1}
				{when}
				onFollow={toggleFollow}
				onJump={seek}
			/>
			<p class="tm-note">{truncated ? `${tm.bots.truncated(data.calls.length)} ` : ''}{tm.note}</p>
		</aside>
	{/if}
</div>

<style>
	.taskmap { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(220px, 1fr) auto minmax(120px, 38%); overflow-y: auto; background: var(--ground); color: var(--ink); }
	.taskmap.is-wide { grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: minmax(0, 1fr) auto; overflow: hidden; }
	.tm-stage { position: relative; min-height: 260px; overflow: hidden; }
	.taskmap.is-wide .tm-stage { grid-column: 1; grid-row: 1; }
	.taskmap.is-wide .tm-clock { grid-column: 1; grid-row: 2; }
	.taskmap.is-wide .tm-aside { grid-column: 2; grid-row: 1 / span 2; overflow-y: auto; border-left: 1px solid var(--line-subtle); }
	.tm-aside { padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; }
	/* Stacked under the town, the cards scroll together rather than each in its own box. */
	.taskmap:not(.is-wide) .tm-aside { border-top: 1px solid var(--line-subtle); }
	.taskmap:not(.is-wide) .tm-aside :global(.tm-side), .taskmap:not(.is-wide) .tm-aside :global(.tm-grow) { flex: none; }
	.tm-note { margin: 0; font-size: var(--text-micro); color: var(--muted); line-height: 1.4; }
	.tm-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; margin: 0; padding: 24px; text-align: center; font-size: var(--text-small); color: #37444a; pointer-events: none; }
</style>
