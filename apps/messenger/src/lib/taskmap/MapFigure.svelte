<script lang="ts">
	import type { FolkMotion } from '../folk-motion.ts';
	import { figureOrigin, type DrawnFigure, type FigureId, type FigureImage } from './scene/figures.ts';

	/**
	 * One character of the map (ADR 0097) in its actor box: its own figure, its face to you, its
	 * avatar on its pin; it moves as its status has it. At work each character does its own work,
	 * with what it wears and holds (`WORK`).
	 */
	type Props = {
		fig: DrawnFigure & { avatar: string | null };
		motion: FolkMotion;
		/** At work where it stands (not walking between places): it does its own work. */
		work: boolean;
		/** Its index among the characters, which keeps it blinking out of step with the others. */
		b: number;
		/** A subagent's figure is smaller (< 1). */
		scale: number;
		/** The camera's zoom. */
		k: number;
		/** The hour's light on the figure, a colour laid over it, or null by day. */
		tint: { color: string; alpha: number } | null;
	};
	let { fig, motion, work, b, scale, k, tint }: Props = $props();

	// A figure is laid out at its size on screen and scaled back by 1/k, a layer of its own (will-change):
	// left in the world's layer, WebKit would stretch the picture it drew at the zoom the map opened at.
	// Subagents (scale < 1) shrink about their feet.
	const figT = $derived(`translate(${(29 * (1 - scale)).toFixed(2)}px, ${(60.16 * (1 - scale)).toFixed(2)}px) scale(${(scale / k).toFixed(4)})`);

	/** What shows of a character's work: `n` of a kind, at one of its spots, in the part it moves with. */
	type Fx = { kind: string; at: string; n: number };
	type Work = { fig?: Fx[]; antenna?: Fx[]; armR?: Fx[]; heldL?: Fx[]; heldR?: Fx[] };
	// Pudding picks up signals on its antenna and types; Mochi sips its coffee; Taro nods to its
	// headphones and ticks its clipboard; Sakura paints; Matcha whisks; Caramel hammers; Sesame reads
	// and pushes up its glasses; Blueberry casts with its wand. The motions are in the styles below.
	const WORK: Record<FigureId, Work> = {
		pudding: { antenna: [{ kind: 'glow', at: 'signal', n: 1 }, { kind: 'signal', at: 'signal', n: 2 }] },
		mochi: { heldR: [{ kind: 'steam', at: 'steam', n: 3 }] },
		taro: { fig: [{ kind: 'note', at: 'notes', n: 2 }], heldR: [{ kind: 'tick', at: 'tick', n: 1 }] },
		sakura: { armR: [{ kind: 'trail', at: 'brush', n: 3 }], heldR: [{ kind: 'fleck', at: 'brush', n: 3 }] },
		matcha: { armR: [{ kind: 'swish', at: 'whisk', n: 2 }], heldR: [{ kind: 'drop', at: 'whisk', n: 4 }] },
		caramel: { heldR: [{ kind: 'burst', at: 'hammer', n: 1 }, { kind: 'spark', at: 'hammer', n: 3 }] },
		sesame: { fig: [{ kind: 'shine', at: 'glasses', n: 1 }], heldL: [{ kind: 'page', at: 'book', n: 1 }] },
		blueberry: { heldR: [{ kind: 'star', at: 'wand', n: 4 }] },
	};
	const fx = $derived(work ? WORK[fig.figure] : {});
</script>

{#snippet layer(im: FigureImage, cls = '')}<img class="tm-l {cls}" src={im.href} alt="" style={im.box} />{/snippet}
<!-- The hour's colour over one picture, masked by it. -->
{#snippet shade(im: FigureImage)}<i class="tm-tint" style="{im.box};--tm-mask:url({im.href})"></i>{/snippet}
{#snippet show(list: readonly Fx[] | undefined)}
	{#each list ?? [] as e, j (j)}
		<i class="tm-w is-{e.kind}" style={fig.spots[e.at]}>
			{#each { length: e.n } as _, m (m)}
				<b>
					{#if e.kind === 'note'}<svg viewBox="0 0 10 12"><ellipse cx="4" cy="9.3" rx="2.5" ry="1.8" transform="rotate(-22 4 9.3)" /><path d="M5.7 9.2V1h1.3c.2 1.7 2.8 2.3 2.6 4.6-.7-1-1.5-1.5-2.6-1.6v5.2z" /></svg>
					{:else if e.kind === 'tick'}<svg viewBox="0 0 13 11"><path d="M2 6.2l3.1 3L11 2" /></svg>{/if}
				</b>
			{/each}
		</i>
	{/each}
{/snippet}

<div class="tm-body" style:width="{(58 * k).toFixed(1)}px" style:height="{(64 * k).toFixed(1)}px" style:transform={figT} style:--u="{k.toFixed(3)}px">
	<div class="tm-figure is-{motion}" class:is-work={work} data-figure={fig.figure} style:--tm-blink="{(-1.3 * b).toFixed(1)}s" style:--tm-tint-c={tint?.color} style:--tm-tint-a={tint?.alpha} aria-hidden="true">
		<div class="tm-fig">
			{@render layer(fig.body)}
			{#if fig.antenna}
				<div class="tm-fig-antenna" style:transform-origin={figureOrigin(fig.antennaAt)}>{@render layer(fig.antenna)}{#if tint}{@render shade(fig.antenna)}{/if}{@render show(fx.antenna)}</div>
			{/if}
			{@render layer(fig.eyes, 'tm-fig-eyes')}
			{@render layer(fig.blink, 'tm-fig-blink')}
			{#if work && fig.figure === 'taro'}{@render layer(fig.happy)}{/if}
			<div class="tm-fig-mouth" style:transform-origin={figureOrigin(fig.mouthAt)}>{@render layer(fig.mouth)}</div>
			<div class="tm-fig-talk">{@render layer(fig.talk)}</div>
			{#if fig.front}{@render layer(fig.front)}{/if}
			{#if fig.avatar}
				{@render layer(fig.pin)}
				<img class="tm-pin-avatar" src={fig.avatar} alt="" style={fig.avatarBox} />
			{/if}
			{#if tint}{@render shade(fig.body)}{/if}
			{@render show(fx.fig)}
			<div class="tm-fig-arm-l" style:transform-origin={figureOrigin(fig.shoulderL)}>
				{@render layer(fig.armL)}{#if tint}{@render shade(fig.armL)}{/if}
				{#if fig.heldL}<div class="tm-fig-held-l" style:transform-origin={figureOrigin(fig.handL)}>{@render layer(fig.heldL)}{#if tint}{@render shade(fig.heldL)}{/if}{@render show(fx.heldL)}</div>{/if}
			</div>
			<div class="tm-fig-arm-r" style:transform-origin={figureOrigin(fig.shoulderR)}>
				{@render layer(fig.armR)}{#if tint}{@render shade(fig.armR)}{/if}{@render show(fx.armR)}
				{#if fig.heldR}<div class="tm-fig-held-r" style:transform-origin={figureOrigin(fig.handR)}>{@render layer(fig.heldR)}{#if tint}{@render shade(fig.heldR)}{/if}{@render show(fx.heldR)}</div>{/if}
			</div>
		</div>
	</div>
</div>

<style>
	/* --u is one px of the actor box at the figure's size on screen; what moves, moves by % of its own box. */
	.tm-body { position: absolute; left: 0; top: 0; width: 58px; height: 64px; transform-origin: 0 0; will-change: transform; }
	.tm-figure, .tm-fig, .tm-fig-mouth, .tm-fig-talk, .tm-fig-arm-l, .tm-fig-arm-r, .tm-fig-held-l, .tm-fig-held-r, .tm-fig-antenna { position: absolute; inset: 0; }
	.tm-l, .tm-tint, .tm-pin-avatar { position: absolute; display: block; max-width: none; margin: 0; border-radius: 0; pointer-events: none; }
	.tm-pin-avatar { border-radius: 50%; object-fit: cover; }
	.tm-tint { background: var(--tm-tint-c); opacity: var(--tm-tint-a); -webkit-mask: var(--tm-mask) 0 0 / 100% 100% no-repeat; mask: var(--tm-mask) 0 0 / 100% 100% no-repeat; }
	/* Walking, a figure bobs with its arms swinging; replying, it talks; waiting on you, it hops and waves; a failure shakes it once and leaves it frowning. Every figure blinks now and then, out of step. */
	.tm-fig { transform-origin: 50% 89%; }
	.is-running .tm-fig, .is-replying .tm-fig { animation: tm-fig-bob .7s ease-in-out infinite alternate; }
	.is-waiting .tm-fig { animation: tm-fig-hop 1.1s ease-in-out infinite; }
	.is-failed .tm-fig { animation: tm-fig-shake .5s ease-in-out 2; }
	.tm-fig-blink, .tm-fig-talk { opacity: 0; }
	.tm-fig-eyes { animation: tm-blink-open 5.2s var(--tm-blink) infinite; }
	.tm-fig-blink { animation: tm-blink-shut 5.2s var(--tm-blink) infinite; }
	.is-running .tm-fig-arm-l { animation: tm-arm-l .45s ease-in-out infinite alternate; }
	.is-running .tm-fig-arm-r { animation: tm-arm-r .45s ease-in-out -.22s infinite alternate; }
	.is-running .tm-fig-antenna { animation: tm-antenna .35s ease-in-out infinite alternate; }
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
	@keyframes tm-antenna { from { transform: rotate(-8deg); } to { transform: rotate(8deg); } }
	@keyframes tm-fig-bob { from { transform: translateY(0); } to { transform: translateY(-3.9%); } }
	@keyframes tm-fig-hop { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-9.4%); } }
	@keyframes tm-fig-shake { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-6deg); } 75% { transform: rotate(6deg); } }

	/* At work, each character its own way: its arms turn about its shoulders, what it holds about its hand; an arm it does not use stays still. */
	.is-work .tm-fig-arm-l, .is-work .tm-fig-arm-r { animation: none; }
	.tm-w { position: absolute; width: 0; height: 0; pointer-events: none; }
	.tm-w > b { position: absolute; display: block; opacity: 0; }
	.tm-w svg { display: block; width: 100%; height: 100%; overflow: visible; }

	/* Pudding: types away while its antenna sways and picks up signals. */
	.is-work[data-figure='pudding'] .tm-fig { animation: tm-fig-bob .36s ease-in-out infinite alternate; }
	.is-work[data-figure='pudding'] .tm-fig-arm-l { animation: tm-arm-l .17s ease-in-out infinite alternate; }
	.is-work[data-figure='pudding'] .tm-fig-arm-r { animation: tm-arm-r .17s ease-in-out -.08s infinite alternate; }
	.is-work .tm-fig-antenna { animation: tm-antenna .8s ease-in-out infinite alternate; }
	.is-glow > b { left: calc(var(--u) * -4.5); top: calc(var(--u) * -4.5); width: calc(var(--u) * 9); height: calc(var(--u) * 9); border-radius: 50%; background: radial-gradient(circle, rgba(190, 250, 255, .95) 0, rgba(60, 190, 210, .5) 38%, rgba(27, 138, 156, 0) 70%); animation: tm-w-glow .8s ease-in-out infinite alternate; }
	.is-signal > b { left: calc(var(--u) * -4); top: calc(var(--u) * -4); width: calc(var(--u) * 8); height: calc(var(--u) * 8); box-sizing: border-box; border-radius: 50%; border: calc(var(--u) * 1.1) solid transparent; border-top-color: #1b8a9c; animation: tm-w-signal 1.2s ease-out infinite; }
	.is-signal > b:nth-child(2) { animation-delay: -.6s; }
	@keyframes tm-w-glow { from { opacity: .3; transform: scale(.7); } to { opacity: 1; transform: scale(1.1); } }
	@keyframes tm-w-signal { 0% { opacity: 0; transform: scale(.5); } 20% { opacity: .95; } 100% { opacity: 0; transform: scale(2.1); } }

	/* Mochi: steam off its coffee; now and then it brings the mug to its mouth and sips, eyes shut. */
	.is-work[data-figure='mochi'] .tm-fig { animation: tm-sway 3.2s ease-in-out infinite; }
	.is-work[data-figure='mochi'] .tm-fig-arm-r { animation: tm-sip-arm 3.2s ease-in-out infinite; }
	.is-work[data-figure='mochi'] .tm-fig-held-r { animation: tm-sip 3.2s ease-in-out infinite; }
	.is-work[data-figure='mochi'] .tm-fig-arm-l { animation: tm-tap-l .8s ease-in-out infinite alternate; }
	.is-work[data-figure='mochi'] .tm-fig-eyes { animation: tm-sip-open 3.2s infinite; }
	.is-work[data-figure='mochi'] .tm-fig-blink { animation: tm-sip-shut 3.2s infinite; }
	.is-steam > b { left: calc(var(--u) * -2.3); top: calc(var(--u) * -4); width: calc(var(--u) * 4.6); height: calc(var(--u) * 4.6); border-radius: 50%; background: radial-gradient(circle, #fff 0, rgba(255, 255, 255, .8) 38%, rgba(255, 255, 255, 0) 70%); animation: tm-w-steam 1.8s ease-out infinite; }
	.is-steam > b:nth-child(2) { animation-delay: -.6s; }
	.is-steam > b:nth-child(3) { animation-delay: -1.2s; }
	@keyframes tm-sway { 0%, 100% { transform: rotate(-1.5deg); } 50% { transform: rotate(1.5deg); } }
	@keyframes tm-sip-arm { 0%, 46%, 100% { transform: rotate(0deg); } 60%, 80% { transform: rotate(50deg); } 92% { transform: rotate(0deg); } }
	@keyframes tm-sip { 0%, 46%, 100% { transform: rotate(0deg); } 60%, 80% { transform: rotate(-76deg); } 92% { transform: rotate(0deg); } }
	@keyframes tm-tap-l { from { transform: rotate(0deg); } to { transform: rotate(-12deg); } }
	@keyframes tm-sip-open { 0%, 60%, 84%, 100% { opacity: 1; } 62%, 82% { opacity: 0; } }
	@keyframes tm-sip-shut { 0%, 60%, 84%, 100% { opacity: 0; } 62%, 82% { opacity: 1; } }
	@keyframes tm-w-steam { 0% { opacity: 0; transform: translate(0, 0) scale(.5); } 20% { opacity: .9; } 50% { transform: translate(35%, -150%) scale(1); } 100% { opacity: 0; transform: translate(-20%, -340%) scale(1.6); } }

	/* Taro: nods to the music in its headphones, eyes shut in a smile, and ticks off its clipboard. */
	.is-work[data-figure='taro'] .tm-fig { animation: tm-groove 1s ease-in-out infinite; }
	.is-work[data-figure='taro'] .tm-fig-eyes, .is-work[data-figure='taro'] .tm-fig-blink { animation: none; opacity: 0; }
	.is-work[data-figure='taro'] .tm-fig-arm-r { animation: tm-tap-r .5s ease-in-out infinite alternate; }
	.is-work[data-figure='taro'] .tm-fig-arm-l { animation: tm-tap-l .5s ease-in-out -.25s infinite alternate; }
	.is-note > b { left: calc(var(--u) * -2.5); top: calc(var(--u) * -3); width: calc(var(--u) * 5); height: calc(var(--u) * 6); fill: #5d4a96; animation: tm-w-note-a 2s ease-out infinite; }
	.is-note > b:nth-child(2) { fill: #1b7486; animation-name: tm-w-note-b; animation-delay: -1s; }
	.is-tick > b { left: calc(var(--u) * -2.8); top: calc(var(--u) * -7); width: calc(var(--u) * 5.6); height: calc(var(--u) * 4.7); fill: none; stroke: #1b8a9c; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; animation: tm-w-tick 2s ease-out infinite; }
	@keyframes tm-groove { 0%, 100% { transform: rotate(-3deg); } 25%, 75% { transform: translateY(-1.9%) rotate(0deg); } 50% { transform: rotate(3deg); } }
	@keyframes tm-tap-r { from { transform: rotate(0deg); } to { transform: rotate(-7deg); } }
	@keyframes tm-w-note-a { 0% { opacity: 0; transform: translate(0, 0) rotate(-10deg) scale(.6); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(150%, -190%) rotate(12deg) scale(1.05); } }
	@keyframes tm-w-note-b { 0% { opacity: 0; transform: translate(0, 0) rotate(8deg) scale(.6); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(40%, -230%) rotate(-10deg) scale(1); } }
	@keyframes tm-w-tick { 0%, 40% { opacity: 0; transform: scale(.3); } 50% { opacity: 1; transform: scale(1.2); } 60% { transform: scale(1); } 85% { opacity: 1; transform: translateY(-30%); } 100% { opacity: 0; transform: translateY(-60%); } }

	/* Sakura: strokes with its brush, paint flicking off it, and dips it in the palette. */
	.is-work[data-figure='sakura'] .tm-fig { animation: tm-lean 2.4s ease-in-out infinite; }
	.is-work[data-figure='sakura'] .tm-fig-arm-r { animation: tm-paint-arm 2.4s ease-in-out infinite; }
	.is-work[data-figure='sakura'] .tm-fig-held-r { animation: tm-paint 2.4s ease-in-out infinite; }
	.is-work[data-figure='sakura'] .tm-fig-arm-l { animation: tm-palette 2.4s ease-in-out infinite; }
	.is-fleck > b { left: calc(var(--u) * -1.2); top: calc(var(--u) * -1.2); width: calc(var(--u) * 2.4); height: calc(var(--u) * 2.4); border-radius: 50%; background: #1b8a9c; animation: tm-w-fleck-a 2.4s ease-out .29s infinite; }
	.is-fleck > b:nth-child(2) { background: #f0ab3d; animation-name: tm-w-fleck-b; animation-delay: .86s; }
	.is-fleck > b:nth-child(3) { background: #e0705c; animation-delay: 1.44s; }
	.is-trail > b { left: calc(var(--u) * -6); top: calc(var(--u) * -3); width: calc(var(--u) * 12); height: calc(var(--u) * 12); box-sizing: border-box; border-radius: 50%; border: calc(var(--u) * 1.3) solid transparent; border-top-color: #1b8a9c; transform: rotate(-20deg); animation: tm-w-trail 2.4s ease-out .2s infinite; }
	.is-trail > b:nth-child(2) { border-top-color: #f0ab3d; transform: rotate(-35deg); animation-delay: .78s; }
	.is-trail > b:nth-child(3) { border-top-color: #e0705c; transform: rotate(-25deg); animation-delay: 1.36s; }
	@keyframes tm-w-trail { 0% { opacity: 0; clip-path: inset(0 100% 0 0); } 4% { opacity: .95; } 10% { clip-path: inset(0 0 0 0); } 30% { opacity: 0; } 100% { opacity: 0; } }
	@keyframes tm-lean { 0%, 100% { transform: rotate(0deg); } 20%, 60% { transform: rotate(2.5deg); } 82% { transform: rotate(-2deg); } }
	@keyframes tm-paint-arm { 0%, 100% { transform: rotate(0deg); } 12%, 36%, 60% { transform: rotate(-26deg); } 24%, 48% { transform: rotate(-16deg); } 72% { transform: rotate(0deg); } }
	@keyframes tm-paint { 0%, 100% { transform: rotate(0deg); } 12% { transform: rotate(-34deg); } 24% { transform: rotate(22deg); } 36% { transform: rotate(-36deg); } 48% { transform: rotate(20deg); } 60% { transform: rotate(-30deg); } 72% { transform: rotate(0deg); } }
	@keyframes tm-palette { 0%, 100% { transform: rotate(0deg); } 10%, 64% { transform: rotate(-14deg); } 78% { transform: rotate(0deg); } }
	@keyframes tm-w-fleck-a { 0% { opacity: 0; transform: translate(0, 0); } 3% { opacity: 1; } 22% { opacity: 0; transform: translate(230%, -170%) scale(.6); } 100% { opacity: 0; } }
	@keyframes tm-w-fleck-b { 0% { opacity: 0; transform: translate(0, 0); } 3% { opacity: 1; } 22% { opacity: 0; transform: translate(260%, 60%) scale(.6); } 100% { opacity: 0; } }

	/* Matcha: whisks hard from the wrist, froth flying off the whisk. */
	.is-work[data-figure='matcha'] .tm-fig { animation: tm-jig .28s ease-in-out infinite alternate; }
	.is-work[data-figure='matcha'] .tm-fig-arm-r { animation: tm-whisk-arm .28s ease-in-out infinite alternate; }
	.is-work[data-figure='matcha'] .tm-fig-held-r { animation: tm-whisk .14s ease-in-out infinite alternate; }
	.is-work[data-figure='matcha'] .tm-fig-arm-l { transform: rotate(-12deg); }
	.is-drop > b { left: calc(var(--u) * -1); top: calc(var(--u) * -1); width: calc(var(--u) * 2); height: calc(var(--u) * 2); border-radius: 50%; background: #f4ede0; box-shadow: 0 0 0 calc(var(--u) * .25) rgba(90, 120, 50, .35); animation: tm-w-drop-a .7s ease-out infinite; }
	.is-drop > b:nth-child(2) { background: #8fb456; animation-name: tm-w-drop-b; animation-delay: -.18s; }
	.is-drop > b:nth-child(3) { animation-delay: -.35s; animation-name: tm-w-drop-b; }
	.is-drop > b:nth-child(4) { background: #8fb456; animation-delay: -.52s; }
	.is-swish > b { left: calc(var(--u) * -4.5); top: calc(var(--u) * -4.5); width: calc(var(--u) * 9); height: calc(var(--u) * 9); box-sizing: border-box; border-radius: 50%; border: calc(var(--u) * .7) solid transparent; border-left-color: rgba(255, 255, 255, .9); animation: tm-w-swish .14s steps(1) infinite alternate; }
	.is-swish > b:nth-child(2) { border-left-color: transparent; border-right-color: rgba(255, 255, 255, .9); animation-direction: alternate-reverse; }
	@keyframes tm-w-swish { 0% { opacity: 0; } 50% { opacity: 1; } }
	@keyframes tm-jig { from { transform: translateY(0); } to { transform: translateY(-1.6%); } }
	@keyframes tm-whisk-arm { from { transform: rotate(-5deg); } to { transform: rotate(5deg); } }
	@keyframes tm-whisk { from { transform: rotate(-24deg); } to { transform: rotate(18deg); } }
	@keyframes tm-w-drop-a { 0% { opacity: 0; transform: translate(0, 0); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(240%, -200%); } }
	@keyframes tm-w-drop-b { 0% { opacity: 0; transform: translate(0, 0); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(-170%, -260%); } }

	/* Caramel: raises its hammer slowly and brings it down hard at its side, sparks flying, eyes squeezed shut. */
	.is-work[data-figure='caramel'] .tm-fig { animation: tm-thud 1.2s infinite; }
	.is-work[data-figure='caramel'] .tm-fig-arm-r { animation: tm-hammer-arm 1.2s infinite; }
	.is-work[data-figure='caramel'] .tm-fig-held-r { animation: tm-hammer 1.2s infinite; }
	.is-work[data-figure='caramel'] .tm-fig-eyes { animation: tm-squint-open 1.2s infinite; }
	.is-work[data-figure='caramel'] .tm-fig-blink { animation: tm-squint-shut 1.2s infinite; }
	.is-burst > b { left: calc(var(--u) * -6); top: calc(var(--u) * -6); width: calc(var(--u) * 12); height: calc(var(--u) * 12); clip-path: polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%); background: radial-gradient(circle, #fff 0, #fff3b0 30%, #ffc93a 62%); animation: tm-w-burst 1.2s infinite; }
	.is-spark > b { left: calc(var(--u) * -.65); top: calc(var(--u) * -.65); width: calc(var(--u) * 1.3); height: calc(var(--u) * 1.3); border-radius: 50%; background: #ffd257; box-shadow: 0 0 calc(var(--u) * .8) #ffb020; animation: tm-w-spark-a 1.2s infinite; }
	.is-spark > b:nth-child(2) { animation-name: tm-w-spark-b; }
	.is-spark > b:nth-child(3) { animation-name: tm-w-spark-c; }
	@keyframes tm-thud { 0%, 54%, 74%, 100% { transform: none; } 58% { transform: scale(1.03, .96); } 66% { transform: scale(.99, 1.01); } }
	@keyframes tm-hammer-arm {
		0%, 100% { transform: rotate(0deg); animation-timing-function: cubic-bezier(.2, .7, .4, 1); }
		44% { transform: rotate(-28deg); animation-timing-function: cubic-bezier(.7, 0, 1, .6); }
		56% { transform: rotate(4deg); animation-timing-function: ease-out; }
		66% { transform: rotate(0deg); }
	}
	@keyframes tm-hammer {
		0%, 100% { transform: rotate(20deg); animation-timing-function: cubic-bezier(.2, .7, .4, 1); }
		44% { transform: rotate(-50deg); animation-timing-function: cubic-bezier(.7, 0, 1, .6); }
		56% { transform: rotate(82deg); animation-timing-function: ease-out; }
		62% { transform: rotate(72deg); animation-timing-function: ease-in-out; }
		68% { transform: rotate(80deg); }
	}
	@keyframes tm-squint-open { 0%, 54%, 72%, 100% { opacity: 1; } 56%, 70% { opacity: 0; } }
	@keyframes tm-squint-shut { 0%, 54%, 72%, 100% { opacity: 0; } 56%, 70% { opacity: 1; } }
	@keyframes tm-w-burst { 0%, 55% { opacity: 0; transform: scale(.3) rotate(0deg); } 58% { opacity: 1; transform: scale(1.15) rotate(10deg); } 72% { opacity: 0; transform: scale(1.4) rotate(18deg); } 100% { opacity: 0; } }
	@keyframes tm-w-spark-a { 0%, 56% { opacity: 0; transform: translate(0, 0); } 58% { opacity: 1; } 76% { opacity: 0; transform: translate(500%, -420%); } 100% { opacity: 0; } }
	@keyframes tm-w-spark-b { 0%, 56% { opacity: 0; transform: translate(0, 0); } 58% { opacity: 1; } 76% { opacity: 0; transform: translate(-300%, -520%); } 100% { opacity: 0; } }
	@keyframes tm-w-spark-c { 0%, 56% { opacity: 0; transform: translate(0, 0); } 58% { opacity: 1; } 76% { opacity: 0; transform: translate(560%, 80%); } 100% { opacity: 0; } }

	/* Sesame: reads the book it holds up, turning a page now and then, and pushes up its glasses. */
	.is-work[data-figure='sesame'] .tm-fig { animation: tm-read 3s ease-in-out infinite; }
	.is-work[data-figure='sesame'] .tm-fig-arm-l { animation: tm-book 3s ease-in-out infinite; }
	.is-work[data-figure='sesame'] .tm-fig-arm-r { animation: tm-glasses 6s ease-in-out infinite; }
	.is-page > b { left: 0; top: calc(var(--u) * -2.8); width: calc(var(--u) * 4.4); height: calc(var(--u) * 5.6); background: #fbf8ef; border-radius: 0 calc(var(--u) * .6) calc(var(--u) * .6) 0; box-shadow: 0 0 0 calc(var(--u) * .3) rgba(60, 60, 60, .25); transform-origin: 0 50%; animation: tm-w-page 3s ease-in-out infinite; }
	.is-shine > b { left: calc(var(--u) * -2.6); top: calc(var(--u) * -3); width: calc(var(--u) * 1.5); height: calc(var(--u) * 6); background: linear-gradient(rgba(255, 255, 255, 0), #fff 45%, #fff 55%, rgba(255, 255, 255, 0)); animation: tm-w-shine 6s infinite; }
	@keyframes tm-read { 0%, 100% { transform: rotate(-1deg); } 50% { transform: translateY(.6%) rotate(-2.5deg); } }
	@keyframes tm-book { 0%, 100% { transform: rotate(-26deg); } 50% { transform: rotate(-31deg); } }
	@keyframes tm-glasses { 0%, 72%, 100% { transform: rotate(0deg); } 78%, 84% { transform: rotate(68deg); } 81% { transform: rotate(64deg); } 90% { transform: rotate(0deg); } }
	@keyframes tm-w-page { 0%, 40% { opacity: 0; transform: scaleX(1); } 44% { opacity: 1; transform: scaleX(1); } 62% { opacity: 1; transform: scaleX(-1); } 66%, 100% { opacity: 0; transform: scaleX(-1); } }
	@keyframes tm-w-shine { 0%, 88% { opacity: 0; transform: translateX(0) rotate(30deg); } 90% { opacity: 1; } 97% { opacity: 0; transform: translateX(260%) rotate(30deg); } 100% { opacity: 0; } }

	/* Blueberry: floats as it draws circles with its wand, stars trailing off its tip. */
	.is-work[data-figure='blueberry'] .tm-fig { animation: tm-float 2s ease-in-out infinite alternate; }
	.is-work[data-figure='blueberry'] .tm-fig-arm-r { animation: tm-cast-arm 1.6s ease-in-out infinite alternate; }
	.is-work[data-figure='blueberry'] .tm-fig-held-r { animation: tm-wand 1.6s linear infinite; }
	.is-work[data-figure='blueberry'] .tm-fig-arm-l { animation: tm-tap-l 1.6s ease-in-out infinite alternate; }
	.is-star > b { left: calc(var(--u) * -2.2); top: calc(var(--u) * -2.2); width: calc(var(--u) * 4.4); height: calc(var(--u) * 4.4); clip-path: polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%); background: #ffd257; animation: tm-w-star-a 1.6s ease-out infinite; }
	.is-star > b:nth-child(2) { background: #fff3b0; animation-name: tm-w-star-b; animation-delay: -.4s; }
	.is-star > b:nth-child(3) { animation-delay: -.8s; }
	.is-star > b:nth-child(4) { background: #fff3b0; animation-name: tm-w-star-b; animation-delay: -1.2s; }
	@keyframes tm-float { from { transform: translateY(0); } to { transform: translateY(-4.5%); } }
	@keyframes tm-cast-arm { from { transform: rotate(-30deg); } to { transform: rotate(-62deg); } }
	@keyframes tm-wand { 0%, 100% { transform: rotate(-30deg); } 25% { transform: rotate(10deg); } 50% { transform: rotate(32deg); } 75% { transform: rotate(-4deg); } }
	@keyframes tm-w-star-a { 0% { opacity: 0; transform: translate(0, 0) scale(.4) rotate(0deg); } 15% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: translate(160%, 220%) scale(.3) rotate(90deg); } }
	@keyframes tm-w-star-b { 0% { opacity: 0; transform: translate(0, 0) scale(.4) rotate(0deg); } 15% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: translate(-150%, 190%) scale(.3) rotate(-90deg); } }

	@media (prefers-reduced-motion: reduce) {
		.tm-figure * { animation: none !important; }
	}
</style>
