<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { Timeline } from './timeline.ts';

	/**
	 * The map's clock (ADR 0096): play, speed, back to live, one lane per character with its failures
	 * as dots, the moments as marks, and a slider over the squeezed time.
	 */
	type Props = {
		t: Copy['taskmap'];
		tl: Timeline;
		v: number;
		playing: boolean;
		speed: number;
		/** Whether the run is going on now, and whether the map is following it to its newest step. */
		liveRun: boolean;
		atLive: boolean;
		step: number;
		steps: number;
		lanes: { label: string; color: string }[];
		markColor: (kind: string) => string;
		/** Ticks for the picked place's steps, on the squeezed clock; empty for none. */
		ticks: readonly number[];
		tickNote: string;
		onToggle: () => void;
		onSpeed: (s: number) => void;
		onSeek: (v: number) => void;
		onLive: () => void;
	};

	let { t, tl, v, playing, speed, liveRun, atLive, step, steps, lanes, markColor, ticks, tickNote, onToggle, onSpeed, onSeek, onLive }: Props = $props();

	const TRACK = 996;
	const x = (at: number) => (tl.total > 0 ? (at / tl.total) * 100 : 0);
	const tickPath = $derived(ticks.map((tv) => `M${((tv / Math.max(0.01, tl.total)) * TRACK).toFixed(1)} 0v56`).join(''));
</script>

<div class="tm-timeline">
	<div class="tm-tl-head">
		<button type="button" class="tm-play" aria-label={playing ? t.controls.pause : t.controls.play} title={playing ? t.controls.pause : t.controls.play} onclick={onToggle}>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				{#if playing}<path d="M4 2h3v12H4zM9 2h3v12H9z" />{:else}<path d="M4 2l10 6-10 6z" />{/if}
			</svg>
		</button>
		<span class="tm-muted">{t.controls.speed}</span>
		{#each [1, 4, 8, 32] as s (s)}
			<button type="button" class="tm-speed" class:is-on={s === speed} aria-pressed={s === speed} onclick={() => onSpeed(s)}>{s}×</button>
		{/each}
		{#if liveRun}
			{#if atLive}
				<span class="tm-live"><span class="tm-live-dot"></span>{t.live}</span>
			{:else}
				<button type="button" class="tm-speed" onclick={onLive}>{t.controls.toLive}</button>
			{/if}
		{/if}
		<span class="tm-grow"></span>
		{#if tickNote}<span class="tm-note">{tickNote}</span>{/if}
		<span class="tm-muted">{t.controls.step(step, steps)}</span>
	</div>
	<div class="tm-tl-body">
		<div class="tm-lane-labels">
			{#each lanes as lane, i (i)}<span style:height="{tl.laneH}px" style:line-height="{tl.laneH}px" style:color={lane.color}>{lane.label}</span>{/each}
		</div>
		<div class="tm-track">
			{#each tl.idles as idle, i (i)}
				<div class="tm-idle" style:left="{x(idle.v0)}%" style:width="max(3px, {x(idle.v1) - x(idle.v0)}%)"></div>
			{/each}
			<svg viewBox="0 0 {TRACK} 56" preserveAspectRatio="none" aria-hidden="true">
				<path class="tm-ticks" d={tickPath} />
				{#each tl.lanes as d, i (i)}<path d={d} fill={lanes[i]?.color ?? 'var(--muted)'} opacity="0.6" />{/each}
				<path d={tl.failD} fill="var(--danger)" />
			</svg>
			{#each tl.moments as m, i (i)}
				<div class="tm-mark" style:left="{x(m.v)}%" style:border-top-color={markColor(m.kind)}></div>
			{/each}
			<div class="tm-head" style:left="{x(v)}%"></div>
		</div>
	</div>
	<div class="tm-scrub-row">
		<span class="tm-lane-labels"></span>
		<input class="tm-scrub" type="range" min="0" max={tl.total} step="0.1" value={v} aria-label={t.controls.scrub} oninput={(e) => onSeek(Number((e.currentTarget as HTMLInputElement).value))} />
	</div>
</div>

<style>
	.tm-timeline { padding: 8px 12px 6px; border-top: 1px solid var(--line-subtle); background: var(--pane); color: var(--ink); }
	.tm-tl-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 34px; font-size: var(--text-small); }
	.tm-play { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); cursor: pointer; }
	.tm-play:hover { background: var(--accent-hover); }
	.tm-play svg { width: 14px; height: 14px; fill: currentColor; }
	.tm-speed { min-height: 26px; padding: 0 8px; font: inherit; font-size: var(--text-small); font-weight: 600; color: var(--ink); background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer; }
	.tm-speed.is-on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
	.tm-play:focus-visible, .tm-speed:focus-visible, .tm-scrub:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
	.tm-live { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; color: var(--ok-text); }
	.tm-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: tm-pulse 1.4s ease-in-out infinite; }
	@keyframes tm-pulse { 50% { opacity: .35; } }
	.tm-grow { flex: 1; }
	.tm-note { color: var(--ink-secondary); }
	.tm-muted { color: var(--muted); }
	.tm-tl-body { display: flex; margin-top: 10px; }
	.tm-lane-labels { width: 40px; flex: none; display: flex; flex-direction: column; font-size: 10px; font-weight: 600; overflow: hidden; }
	.tm-lane-labels span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-track { position: relative; flex: 1; height: 56px; background: var(--chip); border-radius: var(--radius-sm); }
	.tm-track svg { position: absolute; inset: 0; width: 100%; height: 100%; }
	.tm-ticks { fill: none; stroke: var(--ink); stroke-width: 1; opacity: .4; vector-effect: non-scaling-stroke; }
	.tm-idle { position: absolute; top: 0; height: 56px; box-sizing: border-box; background: repeating-linear-gradient(135deg, var(--line-subtle) 0 4px, transparent 4px 8px); border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
	.tm-mark { position: absolute; top: -9px; width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 7px solid; transform: translateX(-5px); }
	.tm-head { position: absolute; top: -4px; width: 2px; height: 64px; background: var(--ink); border-radius: 1px; transform: translateX(-1px); }
	.tm-scrub-row { display: flex; margin-top: 4px; }
	.tm-scrub { flex: 1; margin: 0; accent-color: var(--accent); height: 16px; }
	@media (prefers-reduced-motion: reduce) { .tm-live-dot { animation: none; } }
</style>
