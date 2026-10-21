<script lang="ts">
	import type { Copy } from '../copy.ts';
	import FolkAvatar from '../FolkAvatar.svelte';
	import type { CharacterLook } from './characters.ts';
	import { statusText, type FrameActor } from './frame.ts';
	import MapLogo from './MapLogo.svelte';
	import type { MomentText } from './moment-text.ts';
	import type { Quest } from './timeline.ts';

	/**
	 * The map's side column (ADR 0096): each lead (the agent, or every Bot of a conversation, ADR 0097)
	 * and what it is on, the subagents sent out, what was asked (your lines and your answers), and the
	 * moments worth a look.
	 */
	type Props = {
		t: Copy['taskmap'];
		/** Each character's name, figure and whose model it works on, by index. */
		looks: readonly CharacterLook[];
		/** Show each lead's own figure rather than its logo: a Bot is known by its face. */
		faces: boolean;
		actors: readonly FrameActor[];
		colors: readonly string[];
		place: (q: number) => string;
		follow: number;
		quests: readonly Quest[];
		quest: number;
		moments: readonly (MomentText & { v: number })[];
		live: number;
		when: (at: number) => string;
		onFollow: (b: number) => void;
		onJump: (v: number) => void;
	};

	let { t, looks, faces, actors, colors, place, follow, quests, quest, moments, live, when, onFollow, onJump }: Props = $props();

	const leads = $derived(actors.filter((a) => a.lead));
	const subs = $derived(actors.filter((a) => !a.lead));
	const forLine = $derived.by(() => {
		const q = quests[quest];
		if (!q) return '';
		return q.kind === 'say' ? t.forLine(q.text.slice(0, 40)) : t.forAnswer(q.answers.join('；').slice(0, 40));
	});
	const CHIP: Record<string, string> = { work: 'is-work', walk: 'is-walk', idle: 'is-idle', fail: 'is-fail', back: 'is-back', none: 'is-idle' };

	// A long list of what was asked scrolls in its card; the line being worked for is kept in sight,
	// also once the list first gets its height (the pane is measured after the map opens).
	let saidList = $state<HTMLDivElement | null>(null);
	$effect(() => {
		const list = saidList, at = quest;
		void quests.length;
		if (!list || at < 0) return;
		const keep = () => {
			const item = list.children[at] as HTMLElement | undefined;
			if (!item || list.scrollHeight <= list.clientHeight) return;
			const top = item.offsetTop, bottom = top + item.offsetHeight;
			if (top < list.scrollTop) list.scrollTop = top;
			else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
		};
		keep();
		let raf = 0;
		// Scrolled on the next frame: work inside the observer during a pane's resize loops in WebKit.
		const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(keep); });
		ro.observe(list);
		return () => { ro.disconnect(); cancelAnimationFrame(raf); };
	});
</script>

<div class="tm-side">
	{#each leads as main (main.key)}
		{@const look = looks[main.b]}
		{@const name = look?.name ?? main.short}
		<section class="tm-scard">
			<div class="tm-main">
				<span class="tm-main-logo" class:is-face={faces} style:box-shadow="0 0 0 2px var(--pane), 0 0 0 3.5px {colors[main.b]}">
					{#if faces && look}<FolkAvatar avatar={look.avatar} motion={main.motion} />{:else if look}<MapLogo source={look.source} size={40} />{/if}
				</span>
				<div class="tm-main-text">
					<div class="tm-row">
						<strong>{name}</strong>
						<span class="tm-chip {CHIP[main.status]}">{statusText(main, t)}</span>
						<button type="button" class="tm-follow-btn" class:is-on={follow === main.b} aria-pressed={follow === main.b} aria-label={follow === main.b ? t.stopFollowOf(name) : t.followOf(name)} onclick={() => onFollow(main.b)}>{t.follow}</button>
					</div>
					<p class="tm-clip">{main.verb ? `${t.at(place(main.tile))} · ${main.verb}${main.file ? ` ${main.file}` : ''}` : t.status.none}</p>
					<p class="tm-clip tm-muted">{main.b === 0 ? `${forLine}${forLine ? ' · ' : ''}` : ''}{t.stepLine(main.step, main.fails)}</p>
					{#if main.hasModel && look}<p class="tm-clip tm-exec"><MapLogo source={look.source} size={12} />{t.ranBy(look.source.name, main.modelShort)}</p>{/if}
				</div>
			</div>
		</section>
	{/each}

	{#if subs.length}
		<section class="tm-scard">
			<header class="tm-shead"><strong>{t.card.subs}</strong><span class="tm-muted">{t.card.subsHint}</span></header>
			{#each subs as sub (sub.key)}
				<div class="tm-sub" class:is-away={!sub.present}>
					<span class="tm-sub-logo" style:box-shadow="0 0 0 2px var(--pane), 0 0 0 3px {colors[sub.b]}">{#if looks[sub.b]}<MapLogo source={looks[sub.b]!.source} size={24} />{/if}</span>
					<div class="tm-sub-text">
						<div class="tm-row"><strong style:color={colors[sub.b]}>{sub.short}</strong><span class="tm-chip {CHIP[sub.status]}">{statusText(sub, t)}</span></div>
						<p class="tm-clip tm-muted">{sub.description ?? ''}{sub.modelShort ? ` · ${sub.modelShort}` : ''}</p>
					</div>
					<button type="button" class="tm-follow-btn" class:is-on={follow === sub.b} disabled={!sub.present} aria-pressed={follow === sub.b} aria-label={follow === sub.b ? t.stopFollowOf(sub.short) : t.followOf(sub.short)} onclick={() => onFollow(sub.b)}>{t.follow}</button>
				</div>
			{/each}
		</section>
	{/if}

	{#if quests.length}
		<section class="tm-scard tm-said" class:is-long={quests.length > 2}>
			<header class="tm-shead"><strong>{t.card.said}</strong><span class="tm-muted">{t.card.saidHint}</span></header>
			<div class="tm-list tm-scroll" bind:this={saidList}>
				{#each quests as q, i (i)}
					<button type="button" class="tm-item" class:is-now={i === quest} class:is-later={i > quest} onclick={() => onJump(q.v)}>
						<span class="tm-mono tm-muted">{when(q.at)}</span>
						<span class="tm-item-text"><b>{q.kind === 'say' ? t.card.you : t.card.answer}</b> {q.kind === 'say' ? q.text : q.answers.join('；')}</span>
					</button>
				{/each}
			</div>
		</section>
	{/if}

	{#if moments.length}
		<section class="tm-scard tm-grow">
			<header class="tm-shead"><strong>{t.card.moments}</strong><span class="tm-muted">{t.card.momentsHint}</span></header>
			<div class="tm-list tm-scroll">
				{#each moments as m, i (i)}
					<button type="button" class="tm-moment" class:is-now={i === live} onclick={() => onJump(Math.max(0, m.v - 1))}>
						<span class="tm-mdot" style:background={m.color}></span>
						<span><span class="tm-mtitle">{m.title}</span><span class="tm-msub">{m.sub}</span></span>
					</button>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	/*
	 * Fills the side column above its note: a Bot's card whole, what was asked giving way first (its
	 * list scrolls), the moments at least 120px. When even that does not fit, the cards scroll here,
	 * rather than running over the note under them.
	 */
	.tm-side { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; overflow-y: auto; color: var(--ink); }
	.tm-scard { flex: none; padding: 10px 12px; background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-lg); }
	.tm-scard.tm-said { flex: 0 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
	/* A long list keeps its header and a few lines in sight while it gives way to the moments. */
	.tm-scard.tm-said.is-long { min-height: 132px; }
	.tm-scard.tm-grow { flex: 1 1 0; min-height: 120px; display: flex; flex-direction: column; }
	.tm-main { display: flex; gap: 12px; align-items: flex-start; }
	.tm-main-logo { flex: none; display: inline-flex; border-radius: var(--radius-sm); }
	.tm-main-logo.is-face { width: 40px; height: 40px; border-radius: 50%; background: var(--chip); overflow: hidden; }
	.tm-main-text, .tm-sub-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
	.tm-row { display: flex; align-items: center; gap: 6px; }
	.tm-row strong { font-size: var(--text-body); }
	.tm-scard p { margin: 0; font-size: var(--text-small); }
	.tm-clip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-exec { display: flex; align-items: center; gap: 5px; color: var(--ink-secondary); }
	.tm-muted { color: var(--muted); }
	.tm-mono { font-family: var(--mono); }
	.tm-chip { font-size: var(--text-micro); font-weight: 600; border-radius: var(--radius-full); padding: 1px 8px; white-space: nowrap; background: var(--chip); color: var(--ink-secondary); }
	.tm-chip.is-work { background: var(--accent-tint); color: var(--accent); }
	.tm-chip.is-fail { background: var(--danger-bg); color: var(--danger-text); }
	.tm-chip.is-back { background: var(--ok-bg); color: var(--ok-text); }
	.tm-follow-btn { margin-left: auto; flex: none; min-height: 24px; padding: 0 8px; font: inherit; font-size: var(--text-micro); font-weight: 600; color: var(--ink); background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer; }
	.tm-follow-btn.is-on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
	.tm-follow-btn:disabled { opacity: .45; cursor: default; }
	.tm-shead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: var(--text-small); }
	.tm-sub { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
	.tm-sub.is-away .tm-sub-logo { opacity: .5; }
	.tm-sub-logo { flex: none; display: inline-flex; border-radius: var(--radius-sm); }
	.tm-list { position: relative; display: flex; flex-direction: column; gap: 1px; margin: 0 -6px; }
	.tm-scroll { flex: 1; min-height: 0; overflow-y: auto; }
	.tm-item, .tm-moment { display: flex; gap: 8px; align-items: flex-start; width: 100%; box-sizing: border-box; padding: 5px 6px; font: inherit; font-size: var(--text-small); text-align: left; color: var(--ink); background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer; }
	.tm-item:hover, .tm-moment:hover { background: var(--row-hover); }
	.tm-item.is-now, .tm-moment.is-now { background: var(--accent-tint); border-color: var(--accent-border); }
	.tm-item.is-later { opacity: .55; }
	.tm-item:focus-visible, .tm-moment:focus-visible, .tm-follow-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
	.tm-item-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.tm-item-text b { color: var(--accent); }
	.tm-mdot { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-top: 5px; }
	.tm-mtitle { display: block; font-weight: 600; }
	.tm-msub { display: block; font-size: var(--text-micro); color: var(--muted); }
</style>
