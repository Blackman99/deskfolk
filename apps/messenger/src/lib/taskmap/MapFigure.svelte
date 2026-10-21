<script lang="ts">
	import type { FolkMotion } from '../folk-motion.ts';
	import { figureOrigin, type DrawnFigure, type FigureImage } from './scene/figures.ts';

	/**
	 * One character of the map (ADR 0097) in its actor box: its own figure, its face to you, its
	 * avatar on its pin; it moves as its status has it.
	 */
	type Props = {
		fig: DrawnFigure & { avatar: string | null };
		motion: FolkMotion;
		/** Its index among the characters, which keeps it blinking out of step with the others. */
		b: number;
		/** A subagent's figure is smaller (< 1). */
		scale: number;
		/** The camera's zoom. */
		k: number;
		/** The hour's light on the figure, a colour laid over it, or null by day. */
		tint: { color: string; alpha: number } | null;
	};
	let { fig, motion, b, scale, k, tint }: Props = $props();

	// A figure is laid out at its size on screen and scaled back by 1/k, a layer of its own (will-change):
	// left in the world's layer, WebKit would stretch the picture it drew at the zoom the map opened at.
	// Subagents (scale < 1) shrink about their feet.
	const figT = $derived(`translate(${(29 * (1 - scale)).toFixed(2)}px, ${(60.16 * (1 - scale)).toFixed(2)}px) scale(${(scale / k).toFixed(4)})`);
</script>

{#snippet layer(im: FigureImage, cls = '')}<img class="tm-l {cls}" src={im.href} alt="" style={im.box} />{/snippet}
<!-- The hour's colour over one picture, masked by it. -->
{#snippet shade(im: FigureImage)}<i class="tm-tint" style="{im.box};--tm-mask:url({im.href})"></i>{/snippet}

<div class="tm-body" style:width="{(58 * k).toFixed(1)}px" style:height="{(64 * k).toFixed(1)}px" style:transform={figT}>
	<div class="tm-figure is-{motion}" data-figure={fig.figure} style:--tm-blink="{(-1.3 * b).toFixed(1)}s" style:--tm-tint-c={tint?.color} style:--tm-tint-a={tint?.alpha} aria-hidden="true">
		<div class="tm-fig">
			{@render layer(fig.body)}
			{@render layer(fig.eyes, 'tm-fig-eyes')}
			{@render layer(fig.blink, 'tm-fig-blink')}
			<div class="tm-fig-mouth" style:transform-origin={figureOrigin(fig.mouthAt)}>{@render layer(fig.mouth)}</div>
			<div class="tm-fig-talk">{@render layer(fig.talk)}</div>
			{#if fig.front}{@render layer(fig.front)}{/if}
			{#if fig.avatar}
				{@render layer(fig.pin)}
				<img class="tm-pin-avatar" src={fig.avatar} alt="" style={fig.avatarBox} />
			{/if}
			{#if tint}{@render shade(fig.body)}{/if}
			<div class="tm-fig-arm-l" style:transform-origin={figureOrigin(fig.shoulderL)}>{@render layer(fig.armL)}{#if tint}{@render shade(fig.armL)}{/if}</div>
			<div class="tm-fig-arm-r" style:transform-origin={figureOrigin(fig.shoulderR)}>{@render layer(fig.armR)}{#if tint}{@render shade(fig.armR)}{/if}</div>
		</div>
	</div>
</div>

<style>
	.tm-body { position: absolute; left: 0; top: 0; width: 58px; height: 64px; transform-origin: 0 0; will-change: transform; }
	.tm-figure, .tm-fig, .tm-fig-mouth, .tm-fig-talk, .tm-fig-arm-l, .tm-fig-arm-r { position: absolute; inset: 0; }
	.tm-l, .tm-tint, .tm-pin-avatar { position: absolute; display: block; max-width: none; margin: 0; border-radius: 0; pointer-events: none; }
	.tm-pin-avatar { border-radius: 50%; object-fit: cover; }
	.tm-tint { background: var(--tm-tint-c); opacity: var(--tm-tint-a); -webkit-mask: var(--tm-mask) 0 0 / 100% 100% no-repeat; mask: var(--tm-mask) 0 0 / 100% 100% no-repeat; }
	/* Working, a figure bobs with its arms busy; replying, it talks; waiting on you, it hops and waves; a failure shakes it once and leaves it frowning. Every figure blinks now and then, out of step. */
	.tm-fig { transform-origin: 50% 89%; }
	.is-running .tm-fig, .is-replying .tm-fig { animation: tm-fig-bob .7s ease-in-out infinite alternate; }
	.is-waiting .tm-fig { animation: tm-fig-hop 1.1s ease-in-out infinite; }
	.is-failed .tm-fig { animation: tm-fig-shake .5s ease-in-out 2; }
	.tm-fig-blink, .tm-fig-talk { opacity: 0; }
	.tm-fig-eyes { animation: tm-blink-open 5.2s var(--tm-blink) infinite; }
	.tm-fig-blink { animation: tm-blink-shut 5.2s var(--tm-blink) infinite; }
	.is-running .tm-fig-arm-l { animation: tm-arm-l .45s ease-in-out infinite alternate; }
	.is-running .tm-fig-arm-r { animation: tm-arm-r .45s ease-in-out -.22s infinite alternate; }
	.is-replying .tm-fig-arm-l { animation: tm-arm-l .26s ease-in-out infinite alternate; }
	.is-replying .tm-fig-arm-r { animation: tm-arm-r .26s ease-in-out -.13s infinite alternate; }
	.is-replying .tm-fig-mouth { animation: tm-talk-a .34s steps(1) infinite; }
	.is-replying .tm-fig-talk { animation: tm-talk-b .34s steps(1) infinite; }
	.is-waiting .tm-fig-arm-r { animation: tm-wave .5s ease-in-out infinite alternate; }
	.is-failed .tm-fig-mouth { transform: scaleY(-1); }
	@keyframes tm-blink-open { 0%, 93%, 97%, 100% { opacity: 1; } 94%, 96% { opacity: 0; } }
	@keyframes tm-blink-shut { 0%, 93%, 97%, 100% { opacity: 0; } 94%, 96% { opacity: 1; } }
	@keyframes tm-arm-l { from { transform: rotate(0deg); } to { transform: rotate(-22deg); } }
	@keyframes tm-arm-r { from { transform: rotate(0deg); } to { transform: rotate(22deg); } }
	@keyframes tm-talk-a { 0% { opacity: 1; } 50% { opacity: 0; } }
	@keyframes tm-talk-b { 0% { opacity: 0; } 50% { opacity: 1; } }
	@keyframes tm-wave { from { transform: rotate(-112deg); } to { transform: rotate(-146deg); } }
	@keyframes tm-fig-bob { from { transform: translateY(0); } to { transform: translateY(-2.5px); } }
	@keyframes tm-fig-hop { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-6px); } }
	@keyframes tm-fig-shake { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-6deg); } 75% { transform: rotate(6deg); } }
	@media (prefers-reduced-motion: reduce) {
		.tm-figure * { animation: none !important; }
	}
</style>
