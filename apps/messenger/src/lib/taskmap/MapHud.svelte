<script lang="ts">
	import type { Copy } from '../copy.ts';
	import Icon from '../Icon.svelte';
	import IconButton from '../IconButton.svelte';
	import type { PlaceDetail } from './inspect.ts';

	/**
	 * What lies over the town (ADR 0096): the key of places to folders, or the picked place's card;
	 * the controls to turn and zoom; and the chip that says the camera follows someone. In the app's
	 * own colours, not the picture's.
	 */
	type Legend = { name: string; path: string; color: string };
	type Props = {
		t: Copy['taskmap'];
		legend: readonly Legend[];
		hover: number;
		/** The picked place and its card, or null. */
		picked: { name: string; path: string; full: string; color: string; detail: PlaceDetail } | null;
		who: (b: number) => { short: string; color: string };
		when: (at: number) => string;
		verbOfCall: (call: number) => string;
		phi: number;
		needle: number;
		zoom: number;
		zoomMin: number;
		zoomMax: number;
		following: string | null;
		compact: boolean;
		onTurnBy: (dir: 1 | -1) => void;
		onTurn: (degrees: number) => void;
		onFace: () => void;
		onZoom: (factor: number) => void;
		onReset: () => void;
		onStopFollow: () => void;
		onClosePlace: () => void;
		onJump: (v: number) => void;
	};

	let { t, legend, hover, picked, who, when, verbOfCall, phi, needle, zoom, zoomMin, zoomMax, following, compact, onTurnBy, onTurn, onFace, onZoom, onReset, onStopFollow, onClosePlace, onJump }: Props = $props();

	const deg = $derived(Math.round(phi) % 360);

	// The compass: drag it round to turn the map, click it to face the start again.
	let dial: { id: number; cx: number; cy: number; a: number; x0: number; y0: number; moved: boolean } | null = null;
	let dialEnd = 0;
	function dialDown(e: PointerEvent): void {
		if (e.button) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
		dial = { id: e.pointerId, cx, cy, a: Math.atan2(e.clientY - cy, e.clientX - cx), x0: e.clientX, y0: e.clientY, moved: false };
	}
	function dialMove(e: PointerEvent): void {
		const d = dial;
		if (!d || d.id !== e.pointerId) return;
		if (!e.buttons) { dial = null; return; }
		if (!d.moved) {
			if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
			d.moved = true;
			try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
		}
		const a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
		let da = ((a - d.a) * 180) / Math.PI;
		if (da > 180) da -= 360;
		if (da < -180) da += 360;
		d.a = a;
		onTurn(da);
	}
	function dialUp(): void {
		if (dial?.moved) dialEnd = performance.now();
		dial = null;
	}
</script>

{#if !compact}
	<p class="tm-hint">{t.hint}</p>
{/if}

{#if following}
	<button type="button" class="tm-follow" onclick={onStopFollow}>{t.following(following)}</button>
{/if}

{#if picked}
	<section class="tm-card tm-insp" aria-label={picked.name}>
		<header class="tm-insp-head">
			<span class="tm-dot" style:background={picked.color}></span>
			<strong>{picked.name}</strong>
			<span class="tm-insp-path" title={picked.full}>{picked.path}</span>
			<IconButton icon="x" label={t.insp.close} size="xs" onclick={onClosePlace} />
		</header>
		<p class="tm-insp-line">{t.insp.steps(picked.detail.upto, picked.detail.tripsNow, picked.detail.total, picked.detail.trips)}</p>
		<p class="tm-insp-who">
			{#each picked.detail.byWho as [b, n] (b)}<span style:color={who(b).color}>{who(b).short} {n}</span>{/each}
			<span class:is-bad={picked.detail.fails > 0}>{t.insp.fails(picked.detail.fails)}</span>
		</p>
		<p class="tm-insp-sub">{picked.detail.tripsNow ? t.insp.recent(picked.detail.recent.length) : t.insp.nobody(picked.detail.next !== null)}</p>
		{#each picked.detail.recent as trip (trip.call)}
			<button type="button" class="tm-visit" onclick={() => onJump(trip.v)}>
				<span class="tm-mono tm-muted">{when(trip.at)}</span>
				<span class="tm-visit-who" style:color={who(trip.who).color}>{who(trip.who).short}</span>
				<span class="tm-visit-what">{verbOfCall(trip.call)}</span>
				<span class="tm-mono tm-muted">{t.insp.steps1(trip.steps)}</span>
			</button>
		{/each}
		<div class="tm-insp-nav">
			<button type="button" class="tm-btn" disabled={picked.detail.prev === null} onclick={() => picked.detail.prev !== null && onJump(picked.detail.prev)}>{t.insp.prev}</button>
			<button type="button" class="tm-btn" disabled={picked.detail.next === null} onclick={() => picked.detail.next !== null && onJump(picked.detail.next)}>{t.insp.next}</button>
		</div>
	</section>
{:else if !compact}
	<section class="tm-card tm-legend" aria-label={t.legendHead}>
		<header><strong>{t.legendHead}</strong><span class="tm-muted">{t.legendHint}</span></header>
		{#each legend as row, i (i)}
			<p class="tm-legend-row" class:is-hot={hover === i}><span class="tm-dot" style:background={row.color}></span><span class="tm-legend-name">{row.name}</span><span class="tm-legend-path">{row.path}</span></p>
		{/each}
	</section>
{/if}

<div class="tm-controls">
	<IconButton icon="rotate-ccw" label={t.controls.turnLeft} size="sm" onclick={() => onTurnBy(-1)} />
	<button
		type="button"
		class="tm-dial"
		aria-label={t.controls.dial(deg)}
		title={t.controls.dial(deg)}
		onpointerdown={dialDown}
		onpointermove={dialMove}
		onpointerup={dialUp}
		onpointercancel={dialUp}
		onclick={() => { if (performance.now() - dialEnd > 150) onFace(); }}
	>
		<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="var(--line)" stroke-width="1.2" /><g transform="rotate({needle.toFixed(1)} 12 12)"><path d="M12 3.5l3.2 8.5h-6.4z" fill="var(--accent)" /><path d="M12 20.5l3.2-8.5h-6.4z" fill="var(--muted-light)" /></g></svg>
	</button>
	<span class="tm-turn-right"><IconButton icon="rotate-ccw" label={t.controls.turnRight} size="sm" onclick={() => onTurnBy(1)} /></span>
	<span class="tm-mono tm-readout">{deg}°</span>
	<span class="tm-sep" aria-hidden="true"></span>
	<IconButton icon="minus" label={t.controls.zoomOut} size="sm" disabled={zoom <= zoomMin + 1e-3} onclick={() => onZoom(1 / 1.25)} />
	<span class="tm-mono tm-readout">{Math.round(zoom * 100)}%</span>
	<IconButton icon="plus" label={t.controls.zoomIn} size="sm" disabled={zoom >= zoomMax - 1e-3} onclick={() => onZoom(1.25)} />
	<button type="button" class="tm-btn" onclick={onReset}><Icon name="fit" size={16} />{#if !compact}<span>{t.controls.reset}</span>{/if}</button>
</div>

<style>
	.tm-hint { position: absolute; left: 10px; top: 8px; z-index: 600; margin: 0; max-width: calc(100% - 20px); font-size: var(--text-micro); color: var(--ink-secondary); background: var(--pane); border: 1px solid var(--line-subtle); border-radius: var(--radius-full); padding: 2px 10px; opacity: .92; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-follow { position: absolute; right: 10px; top: 8px; z-index: 600; font: inherit; font-size: var(--text-small); background: var(--pane); color: var(--ink); border: 1px solid var(--accent-border); border-radius: var(--radius-md); padding: 4px 10px; cursor: pointer; }
	.tm-card { position: absolute; left: 10px; bottom: 10px; z-index: 600; width: 236px; box-sizing: border-box; padding: 8px 10px; background: var(--pane); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); }
	.tm-legend header, .tm-insp-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: var(--text-small); }
	.tm-legend header { justify-content: space-between; }
	.tm-legend-row { display: flex; align-items: center; gap: 6px; height: 14px; margin: 0 -4px; padding: 0 4px; border-radius: 4px; font-size: 10.5px; }
	.tm-legend-row.is-hot { background: var(--accent-tint); }
	.tm-legend-name { width: 72px; flex: none; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-legend-path { font-family: var(--mono); font-size: 9.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-insp { border-color: var(--ink); }
	.tm-insp-path { flex: 1; min-width: 0; font-family: var(--mono); font-size: 9.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-insp p { margin: 2px 0; }
	.tm-insp-line { font-size: 11.5px; }
	.tm-insp-who { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; font-weight: 600; }
	.tm-insp-who .is-bad { color: var(--danger-text); }
	.tm-insp-sub { font-size: 10.5px; color: var(--muted); }
	.tm-visit { display: flex; align-items: center; gap: 6px; width: 100%; height: 22px; box-sizing: border-box; margin: 0; padding: 0 6px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--ink); font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
	.tm-visit:hover { background: var(--row-hover); }
	.tm-visit-who { flex: none; font-weight: 600; }
	.tm-visit-what { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-insp-nav { display: flex; gap: 6px; margin-top: 6px; }
	.tm-insp-nav .tm-btn { flex: 1; justify-content: center; }
	.tm-controls { position: absolute; right: 10px; bottom: 10px; z-index: 600; display: flex; align-items: center; gap: 4px; padding: 4px; background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
	.tm-turn-right :global(svg) { transform: scaleX(-1); }
	.tm-dial { width: 32px; height: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 50%; background: var(--pane); cursor: pointer; touch-action: none; }
	.tm-dial svg { width: 24px; height: 24px; }
	.tm-dial:focus-visible, .tm-btn:focus-visible, .tm-visit:focus-visible, .tm-follow:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
	.tm-readout { min-width: 34px; text-align: center; font-size: 11.5px; color: var(--ink-secondary); }
	.tm-sep { width: 1px; height: 20px; background: var(--line); }
	.tm-btn { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 0 8px; font: inherit; font-size: var(--text-small); font-weight: 600; color: var(--ink); background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer; }
	.tm-btn:hover:not(:disabled) { background: var(--row-hover); }
	.tm-btn:disabled { opacity: .45; cursor: default; }
	.tm-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
	.tm-mono { font-family: var(--mono); }
	.tm-muted { color: var(--muted); }
</style>
