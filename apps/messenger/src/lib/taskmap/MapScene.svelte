<script lang="ts">
	import type { Copy } from '../copy.ts';
	import FolkAvatar from '../FolkAvatar.svelte';
	import type { ModelSource } from '../model-source.ts';
	import type { Frame } from './frame.ts';
	import MapLogo from './MapLogo.svelte';
	import { VIEW_H, VIEW_W } from './scene/view.ts';

	/**
	 * The town itself (ADR 0096): ground, buildings, plates and characters, drawn the way the
	 * prototype drew them, in a world of VIEW_W × VIEW_H picture px that the camera moves and scales.
	 * Plates and badges keep their size on screen at any zoom. The pointer is read here and handed up
	 * as pans, turns, zooms and picks; the camera's arithmetic lives with the map.
	 */
	type Props = {
		frame: Frame;
		/** Whose model each character works on, by index: the logo on its badge, its name beside the model in the badge's tooltip. */
		logos: readonly ModelSource[];
		/** Each character's folk avatar (a stored avatar's SVG) and its colour, by index. */
		avatars: readonly string[];
		colors: readonly string[];
		cam: { tx: number; ty: number; k: number };
		/** How long the camera glides to where it is asked (0 while dragging or turning). */
		camMs: number;
		walkMs: number;
		sel: number;
		hover: number;
		follow: number;
		labels: { ext: string; ws: string; town: string };
		t: Copy['taskmap'];
		onPan: (dx: number, dy: number) => void;
		onTurn: (degrees: number) => void;
		onZoom: (factor: number, x: number, y: number) => void;
		onPick: (place: number) => void;
		onHover: (place: number) => void;
		onFollow: (character: number) => void;
		onDeselect: () => void;
		onDragging: (turning: boolean | null) => void;
	};

	let { frame, logos, avatars, colors, cam, camMs, walkMs, sel, hover, follow, labels, t, onPan, onTurn, onZoom, onPick, onHover, onFollow, onDeselect, onDragging }: Props = $props();

	let view = $state<HTMLDivElement | null>(null);
	const inv = $derived((1 / cam.k).toFixed(3));

	type Drag = { id: number; x0: number; y0: number; lx: number; ly: number; moved: boolean; turn: boolean };
	let drag: Drag | null = null;
	let dragEnd = 0;
	// Only what the markup shows is state: the press itself changes on every move.
	let panning = $state(false);

	function local(e: { clientX: number; clientY: number }): [number, number] {
		const r = view?.getBoundingClientRect();
		return r ? [e.clientX - r.left, e.clientY - r.top] : [e.clientX, e.clientY];
	}

	function down(e: PointerEvent): void {
		// The right button, or Shift / Option with the left, turns the map; the left alone pans it.
		const turn = e.button === 2 || (e.button === 0 && (e.shiftKey || e.altKey));
		if (e.button !== 0 && !turn) return;
		const [x, y] = local(e);
		drag = { id: e.pointerId, x0: x, y0: y, lx: x, ly: y, moved: false, turn };
	}

	function move(e: PointerEvent): void {
		const d = drag;
		if (!d || d.id !== e.pointerId) return;
		// Released somewhere the map never heard about (a card over it, off the pane): that press is over.
		if (!e.buttons) { drag = null; panning = false; onDragging(null); return; }
		const [x, y] = local(e);
		if (!d.moved) {
			if (Math.hypot(x - d.x0, y - d.y0) < 4) return;
			// Past the threshold it is a drag: the click below never lands.
			d.moved = true;
			try { view?.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
			d.lx = x; d.ly = y;
			panning = !d.turn;
			onDragging(d.turn);
		}
		if (d.turn) onTurn((x - d.lx) * 0.4);
		else onPan(x - d.lx, y - d.ly);
		d.lx = x; d.ly = y;
	}

	function up(e: PointerEvent): void {
		const d = drag;
		drag = null;
		panning = false;
		if (!d) return;
		if (d.moved) { dragEnd = performance.now(); onDragging(null); return; }
		if (d.turn) return;
		// A click on bare ground puts the place card away.
		const target = e.target as Element | null;
		if (!target?.closest?.('button, .b-hit')) onDeselect();
	}

	const fresh = () => performance.now() - dragEnd > 120;

	// The wheel zooms and a sideways swipe turns; a native listener, since the page must not scroll too.
	$effect(() => {
		const el = view;
		if (!el) return;
		const wheel = (e: WheelEvent) => {
			e.preventDefault();
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
			const dx = e.deltaX * unit, dy = e.deltaY * unit;
			if (Math.abs(dx) > Math.abs(dy)) { onTurn(Math.max(-80, Math.min(80, dx)) * 0.3); return; }
			const [x, y] = local(e);
			const d = Math.max(-240, Math.min(240, dy));
			// A trackpad pinch arrives as a ctrl-wheel with small deltas.
			onZoom(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0018)), x, y);
		};
		el.addEventListener('wheel', wheel, { passive: false });
		return () => el.removeEventListener('wheel', wheel);
	});

	const STATUS_DOT: Record<string, string> = { work: '#16a34a', walk: '#95a2a8', idle: '#c3cfd3', fail: '#dc2626', back: '#16a34a', none: '#c3cfd3' };
	const badgeT = (side: number, lift: number) => {
		const up = ((lift * 28) / cam.k).toFixed(1);
		if (side < 0) return `translate(calc(-100% + 14.5px), calc(-100% - ${up}px)) scale(${inv})`;
		if (side > 0) return `translate(-14.5px, calc(-100% - ${up}px)) scale(${inv})`;
		return `translate(-50%, calc(-100% - ${up}px)) scale(${inv})`;
	};
</script>

<div
	class="tm-view"
	class:is-dragging={panning}
	bind:this={view}
	role="presentation"
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
	oncontextmenu={(e) => e.preventDefault()}
>
	<div class="tm-world" style:width="{VIEW_W}px" style:height="{VIEW_H}px" style:transform="translate({cam.tx.toFixed(1)}px, {cam.ty.toFixed(1)}px) scale({cam.k.toFixed(3)})" style:transition-duration="{camMs}ms">
		<svg class="tm-ground" viewBox="0 0 {VIEW_W} {VIEW_H}" style:z-index="1" aria-hidden="true"><path d={frame.ground.shadow} fill="rgba(23,38,42,.13)" /></svg>
		{#each frame.slabs as slab, i (i)}
			<svg class="tm-ground" viewBox="0 0 {VIEW_W} {VIEW_H}" style:z-index={slab.z} aria-hidden="true">
				{#each slab.puffs as puff, j (j)}<ellipse cx={puff.x} cy={puff.y} rx={puff.rx} ry={puff.ry} fill={puff.fill} />{/each}
				{#each slab.faces as face, j (j)}<path d={face.d} fill={face.fill} stroke={face.stroke} stroke-width="1" stroke-linejoin="round" />{/each}
			</svg>
		{/each}
		<svg class="tm-ground" viewBox="0 0 {VIEW_W} {VIEW_H}" style:z-index="5" aria-hidden="true">
			<path class="tm-road-edge" d={frame.ground.roads} stroke={frame.roadEdge} />
			<path class="tm-road" d={frame.ground.roads} stroke={frame.roadFill} />
		</svg>

		<div class="tm-region" style:left="{frame.ground.lb.ext.x}px" style:top="{frame.ground.lb.ext.y}px" style:transform="translate(-50%, 0) scale({inv})">{labels.ext}</div>
		<div class="tm-region" style:left="{frame.ground.lb.ws.x}px" style:top="{frame.ground.lb.ws.y}px" style:transform="translate(-50%, 0) scale({inv})">{labels.ws}</div>
		<div class="tm-region tm-mono" style:left="{frame.ground.lb.town.x}px" style:top="{frame.ground.lb.town.y}px" style:transform="translate(-50%, 0) scale({inv})">{labels.town}</div>

		{#each frame.trees as tree, i (i)}
			<svg class="tm-tree" viewBox="0 0 30 46" style:left="{tree.l}px" style:top="{tree.t}px" style:z-index={tree.z} aria-hidden="true">
				{#if tree.pine}
					<path d="M13.5 34h3v8h-3z" fill="#9a7b5f" /><path d="M15 4L4 34l11 5z" fill="#86bf7d" /><path d="M15 4l11 30-11 5z" fill="#5f9a5e" />
				{:else}
					<path d="M13.5 28h3v14h-3z" fill="#9a7b5f" /><circle cx="15" cy="20" r="12" fill="#74b366" /><path d="M15 8a12 12 0 0 0 0 24z" fill="#93cc7f" />
				{/if}
			</svg>
		{/each}
		{#each frame.lamps as lamp, i (i)}
			<div class="tm-lamp" style:left="{lamp.l}px" style:top="{lamp.t}px" style:z-index={lamp.z}><i></i><b></b></div>
		{/each}

		{#each frame.blocks as block, q (block.district.key)}
			<div class="tm-blk" style:left="{block.l}px" style:top="{block.t}px" style:z-index={block.z}>
				<svg viewBox="0 0 180 230" aria-hidden="true">
					<polygon class="tm-ring" points={block.ring} style:opacity={sel === q ? 1 : 0} />
					{#each block.faces as face, j (j)}<polygon points={face.pts} fill={face.fill} stroke={face.stroke} stroke-width="0.8" stroke-linejoin="round" />{/each}
					<polygon
						class="b-hit"
						points={block.hit}
						role="presentation"
						onpointerenter={() => { if (!drag?.moved) onHover(q); }}
						onpointerleave={() => onHover(-1)}
						onclick={() => { if (fresh()) onPick(q); }}
					/>
				</svg>
				{#if block.fx.on}
					<div class="tm-fx is-{block.district.archetype}" style:left="{block.fx.x}px" style:top="{block.fx.y}px" style:color={block.district.color}><i></i><i></i><i></i></div>
				{/if}
			</div>
		{/each}

		{#each frame.blocks as block, q (block.district.key)}
			<button
				type="button"
				class="tm-plate"
				class:is-on={sel === q}
				class:is-hot={hover === q}
				style:left="{block.px}px"
				style:top="{block.plateY}px"
				style:transform="translate(-50%, -100%) scale({inv})"
				aria-label={t.insp.aria(block.name, Number(block.n) || 0, sel === q)}
				aria-pressed={sel === q}
				onclick={() => { if (fresh()) onPick(q); }}
				onpointerenter={() => onHover(q)}
				onpointerleave={() => onHover(-1)}
			>
				{#if block.flag}<span class="tm-quest" aria-hidden="true">!</span>{/if}
				<span class="tm-plate-name"><span class="tm-dot" style:background={block.district.color}></span>{block.name}<span class="tm-plate-n">{block.n}</span></span>
				{#each block.lines as line, j (j)}
					<span class="tm-plate-line" style:color={colors[line.b]}>{#if logos[line.b]}<MapLogo source={logos[line.b]!} size={12} />{/if}{line.text}<span class="tm-plate-model">{line.model}</span></span>
				{/each}
			</button>
		{/each}

		{#each frame.actors as actor (actor.key)}
			<div class="tm-actor" style:transform="translate({actor.x}px, {actor.y}px)" style:transition-duration="{walkMs}ms" style:opacity={actor.present ? 1 : 0} style:z-index={actor.z}>
				<div class="tm-shadow" style:box-shadow={follow === actor.b ? `0 0 0 2px ${colors[actor.b]}` : 'none'}></div>
				<div class="tm-body" style:transform="scale({actor.scale})"><FolkAvatar avatar={avatars[actor.b] ?? ''} motion={actor.motion} /></div>
				{#if actor.present}
					<div class="tm-badge is-{actor.side < 0 ? 'l' : actor.side > 0 ? 'r' : 'c'}" style:top="{actor.badgeTop}px" style:border-color={colors[actor.b]} style:transform={badgeT(actor.side, actor.lift)} title={t.ranBy(logos[actor.b]?.name ?? '', actor.modelShort)}>
						<span class="tm-badge-logo">{#if logos[actor.b]}<MapLogo source={logos[actor.b]!} size={20} />{/if}<span class="tm-badge-dot" style:background={STATUS_DOT[actor.status]}></span></span>
						<span class="tm-badge-name" style:color={colors[actor.b]}>{actor.short}</span>
						{#if actor.hasModel}<span class="tm-badge-model">{actor.modelShort}</span>{/if}
					</div>
					<button type="button" class="tm-actor-hit" aria-label={follow === actor.b ? t.stopFollowOf(actor.short) : t.followOf(actor.short)} onclick={() => onFollow(actor.b)}></button>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.tm-view { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
	.tm-view.is-dragging { cursor: grabbing; }
	.tm-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; transition-property: transform; transition-timing-function: cubic-bezier(.3, .7, .3, 1); }
	.tm-ground { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
	.tm-road { fill: none; stroke-width: 12; stroke-linecap: round; stroke-linejoin: round; }
	.tm-road-edge { fill: none; stroke-width: 15; stroke-linecap: round; stroke-linejoin: round; }
	.tm-region { position: absolute; z-index: 40; transform-origin: 50% 0; white-space: nowrap; font-size: 11px; color: #37444a; background: rgba(255, 255, 255, .86); border-radius: 999px; padding: 1px 8px; pointer-events: none; }
	.tm-mono { font-family: var(--mono); }
	.tm-tree { position: absolute; width: 30px; height: 46px; pointer-events: none; }
	.tm-lamp { position: absolute; width: 12px; height: 34px; pointer-events: none; }
	.tm-lamp i { position: absolute; left: 5px; top: 8px; width: 2px; height: 26px; background: #6b7178; border-radius: 1px; }
	.tm-lamp b { position: absolute; left: 2px; top: 2px; width: 8px; height: 8px; border-radius: 50%; background: #eeeae0; }
	.tm-blk { position: absolute; width: 180px; height: 230px; pointer-events: none; }
	.tm-blk svg { position: absolute; left: 0; top: 0; width: 180px; height: 230px; overflow: visible; }
	.tm-ring { fill: rgba(18, 28, 32, .08); stroke: #121c20; stroke-width: 1.6; stroke-dasharray: 4 3; }
	.b-hit { pointer-events: all; fill: #000; fill-opacity: 0; cursor: pointer; }
	.tm-plate { position: absolute; z-index: 300; transform-origin: 50% 100%; max-width: 150px; box-sizing: border-box; margin: 0; padding: 2px 7px 3px; background: rgba(255, 255, 255, .95); border: 1px solid #dfe6e8; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(18, 28, 32, .14); font: inherit; color: #121c20; cursor: pointer; }
	.tm-plate.is-hot { z-index: 360; border-color: #7d8d93; }
	.tm-plate.is-on { z-index: 360; border-color: #121c20; }
	.tm-plate:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.tm-plate-name { display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 12px; font-weight: 700; white-space: nowrap; }
	.tm-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; box-shadow: inset 0 0 0 1px rgba(18, 28, 32, .18); }
	.tm-plate-n { font-size: 10.5px; color: #5f6d74; font-weight: 500; font-family: var(--mono); }
	.tm-plate-line { display: flex; align-items: center; justify-content: center; gap: 3px; font-size: 10px; white-space: nowrap; overflow: hidden; line-height: 1.35; --agent-logo-size: 12px; }
	.tm-plate-model { color: #5f6d74; }
	.tm-quest { position: absolute; left: 50%; top: -25px; width: 20px; height: 20px; margin-left: -10px; border-radius: 50%; background: #f2b632; color: #3a2600; font-size: 13px; font-weight: 800; line-height: 20px; text-align: center; box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(18, 28, 32, .3); animation: tm-bob 1.1s ease-in-out infinite; }
	@keyframes tm-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
	.tm-actor { position: absolute; left: 0; top: 0; width: 58px; height: 64px; transition-property: transform, opacity; transition-timing-function: cubic-bezier(.3, .7, .3, 1); pointer-events: none; }
	.tm-shadow { position: absolute; left: 12px; top: 55px; width: 34px; height: 8px; border-radius: 50%; background: rgba(23, 38, 42, .25); }
	.tm-body { position: absolute; left: 3px; top: 8px; width: 52px; height: 52px; transform-origin: 50% 100%; }
	.tm-badge { position: absolute; left: 29px; display: flex; align-items: center; gap: 4px; height: 26px; box-sizing: border-box; padding: 0 8px 0 2px; background: rgba(255, 255, 255, .96); border: 1.5px solid; border-radius: 999px; box-shadow: 0 1px 3px rgba(18, 28, 32, .18); white-space: nowrap; pointer-events: none; }
	.tm-badge.is-l { flex-direction: row-reverse; padding: 0 2px 0 8px; transform-origin: calc(100% - 14.5px) 100%; }
	.tm-badge.is-r { transform-origin: 14.5px 100%; }
	.tm-badge.is-c { transform-origin: 50% 100%; }
	.tm-badge-logo { position: relative; display: inline-flex; flex: none; }
	.tm-badge-dot { position: absolute; right: -3px; bottom: -2px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid #fff; }
	.tm-badge-name { font-size: 11px; font-weight: 700; }
	.tm-badge-model { font-size: 10px; font-weight: 600; color: #5f6d74; }
	.tm-actor-hit { position: absolute; left: 8px; top: 4px; width: 42px; height: 56px; margin: 0; padding: 0; border: 0; border-radius: 12px; background: transparent; cursor: pointer; pointer-events: auto; }
	.tm-actor-hit:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
	.tm-fx { position: absolute; width: 0; height: 0; pointer-events: none; }
	.tm-fx i { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0; animation: tm-rise 1.8s linear infinite; }
	.tm-fx i:nth-child(2) { animation-delay: .6s; left: 2px; }
	.tm-fx i:nth-child(3) { animation-delay: 1.2s; left: -8px; }
	.tm-fx.is-tools i { width: 9px; height: 9px; left: -4px; background: #aab3ba; animation-duration: 2.4s; }
	.tm-fx.is-keys i, .tm-fx.is-paint i { border-radius: 1px; animation-name: tm-spark; }
	.tm-fx.is-bible i, .tm-fx.is-board i, .tm-fx.is-scratch i, .tm-fx.is-mail i { border-radius: 1px; width: 7px; height: 5px; background: #fbf8ef; animation-name: tm-flutter; animation-duration: 2.2s; }
	.tm-fx.is-clips i, .tm-fx.is-review i, .tm-fx.is-film i { background: #ffe680; animation-name: tm-blink; animation-duration: 1.1s; }
	@keyframes tm-rise { 0% { opacity: 0; transform: translate(0, 0) scale(.6); } 15% { opacity: .9; } 100% { opacity: 0; transform: translate(7px, -30px) scale(1.5); } }
	@keyframes tm-spark { 0% { opacity: 0; transform: translate(0, 0) rotate(45deg) scale(.4); } 30% { opacity: 1; } 100% { opacity: 0; transform: translate(-9px, -28px) rotate(225deg) scale(1); } }
	@keyframes tm-flutter { 0% { opacity: 0; transform: translate(0, 0) rotate(0); } 20% { opacity: 1; } 100% { opacity: 0; transform: translate(12px, -24px) rotate(160deg); } }
	@keyframes tm-blink { 0%, 100% { opacity: 0; transform: scale(.6); } 40% { opacity: 1; transform: scale(1.6); } }
	@media (prefers-reduced-motion: reduce) {
		.tm-fx i, .tm-quest { animation: none !important; }
		.tm-actor, .tm-world { transition: none !important; }
	}
</style>
