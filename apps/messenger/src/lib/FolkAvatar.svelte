<script lang="ts">
	import { FOLK_GEOMETRY, FOLK_RAISED_ARM_DEG, folkHash, folkLayerSrc, folkLook } from '@real-bot/protocol';
	import type { FolkMotion } from './folk-motion.ts';

	/**
	 * A folk avatar acting out its Bot's status (`folkMotion`). It stacks the layers its stored SVG
	 * is drawn from, so it is the same face; it has no fill, fills its box, and may reach past the
	 * box when it hops or waves. With reduced motion (base.css) each status keeps a still pose:
	 * raised hand, closed eyes, frown.
	 */
	interface Props {
		avatar: string;
		motion?: FolkMotion;
	}

	let { avatar, motion = 'idle' }: Props = $props();

	const hash = $derived(folkHash(avatar) ?? 0);
	const look = $derived(folkLook(hash));
	// Folks in one list blink out of step.
	const blink = $derived(`${-(hash % 52) / 10}s`);
	const origin = ([x, y]: readonly [number, number]) => `${x * 100}% ${y * 100}%`;
</script>

<span
	class="folk is-{motion}"
	class:is-mirrored={look.mirror}
	class:has-raised-arm={look.wave}
	style:--folk-blink={blink}
	style:--folk-shoulder-l={origin(FOLK_GEOMETRY.shoulderL)}
	style:--folk-shoulder-r={origin(FOLK_GEOMETRY.shoulderR)}
	style:--folk-mouth={origin(FOLK_GEOMETRY.mouth)}
	style:--folk-raised="{-FOLK_RAISED_ARM_DEG}deg"
	aria-hidden="true"
>
	<span class="folk-shadow"></span>
	<span class="folk-flip">
		<span class="folk-fig">
			<img src={folkLayerSrc('body')} alt="" />
			<img class="folk-arm-l" src={folkLayerSrc('arm-l')} alt="" />
			<img class="folk-arm-r" src={folkLayerSrc('arm-r')} alt="" />
			<img class="folk-eyes" src={folkLayerSrc(`eyes-${look.eyes}`)} alt="" />
			<img class="folk-eyes-closed" src={folkLayerSrc('eyes-closed')} alt="" />
			<img class="folk-mouth" src={folkLayerSrc(`mouth-${look.mouth}`)} alt="" />
			<img class="folk-mouth folk-talk" src={folkLayerSrc('mouth-open')} alt="" />
			{#if look.accessory}
				<img src={folkLayerSrc(`acc-${look.accessory}`)} alt="" />
			{/if}
		</span>
	</span>
	{#if motion === 'running'}
		<svg class="folk-mark" viewBox="0 0 100 100">
			<circle class="folk-dot" cx="74" cy="8" r="3.6" />
			<circle class="folk-dot" cx="83" cy="8" r="3.6" />
			<circle class="folk-dot" cx="92" cy="8" r="3.6" />
		</svg>
	{:else if motion === 'failed'}
		<svg class="folk-mark" viewBox="0 0 100 100">
			<path class="folk-sweat" d="M80 26C76 33 76 37 80 37C84 37 84 33 80 26Z" />
		</svg>
	{:else if motion === 'held'}
		<svg class="folk-mark" viewBox="0 0 100 100">
			<text class="folk-z" x="74" y="22">z</text>
			<text class="folk-z" x="74" y="22">z</text>
			<text class="folk-z" x="74" y="22">z</text>
		</svg>
	{/if}
</span>

<style>
	.folk {
		position: relative;
		display: block;
		width: 100%;
		height: 100%;
	}

	.folk-flip,
	.folk-fig {
		position: absolute;
		inset: 0;
	}

	.folk img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		max-width: none;
		display: block;
		border-radius: 0;
		pointer-events: none;
	}

	.is-mirrored .folk-flip {
		transform: scaleX(-1);
	}

	.folk-fig {
		transform-origin: 50% 98%;
	}

	.folk-arm-l {
		transform-origin: var(--folk-shoulder-l);
	}

	.folk-arm-r {
		transform-origin: var(--folk-shoulder-r);
	}

	.folk-mouth {
		transform-origin: var(--folk-mouth);
	}

	.folk-shadow {
		position: absolute;
		left: 18%;
		right: 18%;
		bottom: -2%;
		height: 9%;
		border-radius: 50%;
		background: radial-gradient(closest-side, var(--folk-shadow), transparent);
	}

	.folk-mark {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
		pointer-events: none;
	}

	/* Every folk blinks now and then; asleep it keeps its eyes shut. */
	.folk-eyes-closed,
	.folk-talk {
		opacity: 0;
	}

	.folk-eyes {
		animation: folk-blink-open 5.2s var(--folk-blink) infinite;
	}

	.folk-eyes-closed {
		animation: folk-blink-closed 5.2s var(--folk-blink) infinite;
	}

	@keyframes folk-blink-open {
		0%, 93%, 97%, 100% { opacity: 1; }
		94%, 96% { opacity: 0; }
	}

	@keyframes folk-blink-closed {
		0%, 93%, 97%, 100% { opacity: 0; }
		94%, 96% { opacity: 1; }
	}

	/* At rest, a folk drawn with a raised hand keeps it up, as its picture does. */
	.has-raised-arm.is-idle .folk-arm-r {
		transform: rotate(var(--folk-raised));
	}

	/* 思考中: a slow sway, eyes up, three dots over the head */
	.is-running .folk-fig {
		animation: folk-sway 2.8s ease-in-out infinite;
	}

	.is-running .folk-eyes,
	.is-running .folk-eyes-closed {
		translate: 0 -3.5%;
	}

	.folk-dot {
		fill: var(--accent);
		animation: folk-dot 1.2s ease-in-out infinite backwards;
	}

	.folk-dot:nth-child(2) {
		animation-delay: 0.2s;
	}

	.folk-dot:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes folk-sway {
		0%, 100% { transform: rotate(-4deg); }
		50% { transform: rotate(4deg); }
	}

	@keyframes folk-dot {
		0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
		30% { opacity: 1; transform: translateY(-3px); }
	}

	/* 回复中: a quick bob, arms typing, mouth talking */
	.is-replying .folk-fig {
		animation: folk-bob 0.5s ease-in-out infinite;
	}

	.is-replying .folk-arm-l {
		animation: folk-type-l 0.26s ease-in-out infinite;
	}

	.is-replying .folk-arm-r {
		animation: folk-type-r 0.26s ease-in-out 0.13s infinite;
	}

	.is-replying .folk-mouth:not(.folk-talk) {
		animation: folk-talk-a 0.34s steps(1) infinite;
	}

	.is-replying .folk-talk {
		animation: folk-talk-b 0.34s steps(1) infinite;
	}

	@keyframes folk-bob {
		0%, 100% { transform: translateY(0); }
		50% { transform: translateY(-3%) scale(0.99, 1.01); }
	}

	@keyframes folk-type-l {
		0%, 100% { transform: rotate(0); }
		50% { transform: rotate(-24deg); }
	}

	@keyframes folk-type-r {
		0%, 100% { transform: rotate(0); }
		50% { transform: rotate(24deg); }
	}

	@keyframes folk-talk-a {
		0% { opacity: 1; }
		50% { opacity: 0; }
	}

	@keyframes folk-talk-b {
		0% { opacity: 0; }
		50% { opacity: 1; }
	}

	/* 等你批准 / 等你回答: hops and waves at you */
	.is-waiting .folk-fig {
		animation: folk-hop 1.5s ease-in-out infinite;
	}

	.is-waiting .folk-shadow {
		animation: folk-hop-shadow 1.5s ease-in-out infinite;
	}

	.is-waiting .folk-arm-r {
		transform: rotate(-128deg);
		animation: folk-wave 0.5s ease-in-out infinite;
	}

	@keyframes folk-hop {
		0%, 55%, 100% { transform: translateY(0) scale(1, 1); }
		8% { transform: translateY(0) scale(1.06, 0.93); }
		25% { transform: translateY(-11%) scale(0.97, 1.04); }
		42% { transform: translateY(0) scale(1.05, 0.95); }
	}

	@keyframes folk-hop-shadow {
		0%, 55%, 100% { transform: scale(1); opacity: 1; }
		25% { transform: scale(0.75); opacity: 0.5; }
	}

	@keyframes folk-wave {
		0%, 100% { transform: rotate(-112deg); }
		50% { transform: rotate(-146deg); }
	}

	/* 出错 / 中断: slumps, frowns, a drop of sweat */
	.is-failed .folk-fig {
		transform: scale(1.04, 0.95);
		animation: folk-droop 3.2s ease-in-out infinite;
	}

	.is-failed .folk-mouth {
		transform: scaleY(-1);
	}

	.is-failed .folk-eyes,
	.is-failed .folk-eyes-closed {
		translate: 0 1.2%;
	}

	.folk-sweat {
		fill: color-mix(in srgb, var(--accent) 45%, var(--pane));
		animation: folk-sweat 2.4s ease-in infinite;
	}

	@keyframes folk-droop {
		0%, 100% { transform: scale(1.04, 0.95) rotate(-3deg); }
		50% { transform: scale(1.04, 0.95) rotate(-1deg); }
	}

	@keyframes folk-sweat {
		0% { opacity: 0; transform: translateY(0); }
		20% { opacity: 1; }
		100% { opacity: 0; transform: translateY(22px); }
	}

	/* 已叫停: asleep, breathing, z's drifting up */
	.is-held .folk-eyes {
		opacity: 0;
		animation: none;
	}

	.is-held .folk-eyes-closed {
		opacity: 1;
		animation: none;
	}

	.is-held .folk-fig {
		animation: folk-breathe 3.6s ease-in-out infinite;
	}

	.folk-z {
		fill: var(--accent);
		font-size: 20px;
		font-weight: 700;
		animation: folk-z 2.7s ease-out infinite backwards;
	}

	.folk-z:nth-child(2) {
		font-size: 16px;
		animation-delay: 0.9s;
	}

	.folk-z:nth-child(3) {
		font-size: 13px;
		animation-delay: 1.8s;
	}

	@keyframes folk-breathe {
		0%, 100% { transform: scale(1, 1); }
		50% { transform: scale(1.025, 0.985); }
	}

	@keyframes folk-z {
		0% { opacity: 0; transform: translate(0, 18px); }
		25% { opacity: 1; }
		100% { opacity: 0; transform: translate(12px, -14px); }
	}
</style>
