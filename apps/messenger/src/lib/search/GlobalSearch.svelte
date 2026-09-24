<script lang="ts">
	import { tick } from 'svelte';
	import type { SearchHit, SearchKind } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import { searchHitView } from '../sidebar/search-jump.ts';
	import { backdropClick } from '../click-outside.ts';
	import { searchShortcutLabel } from './shortcuts.ts';
	import { canOpenSearchHit, nextSearchIndex } from './results.ts';

	let { runtime, t, onClose, onSelect, opener }: {
		runtime: MessengerRuntime;
		t: Copy;
		onClose: () => void;
		onSelect: (hit: SearchHit) => void;
		opener: HTMLElement | null;
	} = $props();
	const id = $props.id();
	let dialog = $state<HTMLDialogElement>();
	let input = $state<HTMLInputElement>();
	let resultsEl = $state<HTMLElement>();
	let category = $state<SearchKind | 'all'>('all');
	let active = $state(-1);
	let returnFocus = true;
	let failedAvatars = $state<string[]>([]);
	const backdrop = backdropClick();
	const snapshot = $derived(runtime.snapshot);
	const bots = $derived(new Map(snapshot.bots.map((bot) => [bot.id, bot])));
	const sessions = $derived(new Map(snapshot.sessions.map((session) => [session.id, session])));
	const labels = $derived({ bot: t.sidebar.searchKindBot, session: t.sidebar.searchKindSession, message: t.sidebar.searchKindMessage, file: t.sidebar.searchKindFile, routine: t.sidebar.searchKindRoutine });
	const categories = $derived([{ key: 'all' as const, label: t.sidebar.searchAll }, ...(['bot', 'session', 'message', 'file', 'routine'] as const).map((key) => ({ key, label: labels[key] }))]);
	const connected = $derived(runtime.connection === 'connected');
	const queried = $derived(Boolean(runtime.searchQuery.trim()));
	const hits = $derived(connected && !runtime.searchLoading && !runtime.searchError ? runtime.searchHits.filter((hit) => category === 'all' || hit.kind === category) : []);
	const available = $derived(hits.map((hit) => canOpenSearchHit(hit, snapshot.sessions, snapshot.routines, snapshot.bots)));
	const activeId = $derived(active >= 0 && available[active] ? `${id}-hit-${active}` : undefined);
	let viewport = $state<{ top: number; height: number } | null>(null);

	$effect(() => {
		void hits;
		void available;
		active = nextSearchIndex(available, -1, 1);
		if (resultsEl) resultsEl.scrollTop = 0;
	});

	$effect(() => {
		const el = dialog;
		if (!el) return;
		const previous = opener;
		el.showModal();
		input?.focus({ preventScroll: true });
		return () => {
			el.close();
			if (returnFocus && previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
		};
	});

	$effect(() => {
		const visual = window.visualViewport;
		if (!visual) return;
		const follow = () => { viewport = { top: visual.offsetTop, height: visual.height }; };
		follow();
		visual.addEventListener('resize', follow);
		visual.addEventListener('scroll', follow);
		return () => {
			visual.removeEventListener('resize', follow);
			visual.removeEventListener('scroll', follow);
		};
	});

	export function focusQuery(): void {
		input?.focus();
		input?.select();
	}

	function choose(hit: SearchHit): void {
		if (!canOpenSearchHit(hit, snapshot.sessions, snapshot.routines, snapshot.bots) || runtime.searchLoading || !connected) return;
		returnFocus = false;
		onSelect(hit);
	}

	function changeCategory(next: typeof category): void {
		category = next;
		input?.focus({ preventScroll: true });
	}

	function onKey(event: KeyboardEvent): void {
		// A modal owns keyboard navigation; pane commands below it must not run.
		event.stopPropagation();
		if (event.isComposing) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		} else if (event.key === 'Tab' && dialog) {
			const controls = [...dialog.querySelectorAll<HTMLElement>('input, button:not([disabled]):not([tabindex="-1"])')];
			const index = controls.indexOf(document.activeElement as HTMLElement);
			if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === controls.length - 1)) {
				event.preventDefault();
				controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
			}
		} else if (event.target === input && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
			event.preventDefault();
			active = nextSearchIndex(available, active, event.key === 'ArrowDown' ? 1 : -1);
			void tick().then(() => document.getElementById(`${id}-hit-${active}`)?.scrollIntoView({ block: 'nearest' }));
		} else if (event.target === input && event.key === 'Enter') {
			event.preventDefault();
			if (hits[active]) choose(hits[active]);
		}
	}
</script>

{#snippet glyph(kind: SearchKind | 'search')}
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		{#if kind === 'search'}
			<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 4.5 4.5"></path>
		{:else if kind === 'file'}
			<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><path d="M14 3v6h6"></path>
		{:else if kind === 'routine'}
			<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M16 3v4M8 3v4M3 11h18M8 15h3"></path>
		{:else}
			<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"></path><path d="M7 10h10M7 14h6"></path>
		{/if}
	</svg>
{/snippet}

<dialog
	bind:this={dialog}
	class="global-search-backdrop"
	aria-label={t.sidebar.globalSearch}
	style:--search-viewport-top={viewport ? `${viewport.top}px` : '0px'}
	style:--search-viewport-height={viewport ? `${viewport.height}px` : '100dvh'}
	oncancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
	onmousedowncapture={backdrop.press}
	onclick={(event) => { event.stopPropagation(); if (backdrop.isOutside(event)) onClose(); }}
	onkeydown={onKey}
>
	<div class="global-search">
		<header class="search-head">
			<span class="search-glyph">{@render glyph('search')}</span>
			<input
				bind:this={input}
				class="global-search-input"
				role="combobox"
				aria-label={t.sidebar.search}
				aria-controls={`${id}-results`}
				aria-expanded={queried}
				aria-autocomplete="list"
				aria-activedescendant={activeId}
				placeholder={t.sidebar.search}
				value={runtime.searchQuery}
				autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
				oninput={(event) => void runtime.runSearch(event.currentTarget.value)}
			/>
			{#if runtime.searchQuery}
				<button class="search-clear" type="button" aria-label={t.sidebar.searchClear} onclick={() => { void runtime.runSearch(''); input?.focus(); }}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>
				</button>
			{/if}
			<button type="button" class="search-cancel" onclick={onClose}>{t.sidebar.searchCancel}<kbd>Esc</kbd></button>
		</header>
		<div class="search-categories" role="group" aria-label={t.sidebar.globalSearch}>
			{#each categories as item}
				<button type="button" aria-pressed={category === item.key} class:is-active={category === item.key} onclick={() => changeCategory(item.key)}>{item.label}</button>
			{/each}
		</div>
		<div class="search-content" bind:this={resultsEl}>
			<div class="search-state" aria-live="polite" role="status">
				{#if !connected}<p>{t.sidebar.searchOffline}</p>
				{:else if runtime.searchLoading}<p class="search-working"><span class="search-spinner" aria-hidden="true"></span>{t.sidebar.searchLoading}</p>
				{:else if runtime.searchError}<p>{t.sidebar.searchFailed}</p><button class="search-retry" type="button" onclick={() => void runtime.runSearch(runtime.searchQuery)}>{t.sidebar.searchRetry}</button>
				{:else if !queried}<div class="search-intro">{@render glyph('search')}<p>{t.sidebar.searchIntro}</p><span>{t.sidebar.searchHint}</span></div>
				{:else if hits.length === 0}<p>{t.sidebar.searchNoResults}</p><span>{t.sidebar.searchTryAnother}</span>
				{:else}<span class="search-count">{t.sidebar.searchResults(hits.length)}</span>{/if}
			</div>
			<div id={`${id}-results`} class="search-results" role="listbox" aria-label={t.sidebar.globalSearch} aria-busy={runtime.searchLoading}>
				{#each hits as hit, index (`${hit.kind}-${hit.id ?? hit.path}-${index}`)}
					{@const view = searchHitView(hit, labels)}
					{@const bot = hit.kind === 'bot' && hit.id ? bots.get(hit.id) : null}
					{@const session = hit.kind === 'session' && hit.id ? sessions.get(hit.id) : null}
					{@const path = hit.path ?? ''}
					{@const name = hit.kind === 'file' ? path.split('/').at(-1) ?? path : bot?.name ?? (hit.kind === 'session' ? view.sessionTitle ?? view.snippet : view.snippet)}
					{@const secondary = hit.kind === 'file' ? path : hit.kind === 'bot' ? view.snippet === name ? '' : view.snippet : hit.kind === 'message' ? view.sessionTitle : ''}
					<button type="button" class="search-result" class:is-selected={active === index} id={`${id}-hit-${index}`}
						role="option" aria-selected={active === index} aria-disabled={!available[index]} tabindex="-1"
						onpointermove={(event) => { if (event.pointerType !== 'touch' && available[index]) active = index; }}
						onclick={() => choose(hit)}>
						<span class="result-icon">
							{#if bot}
								{@const src = avatarSrc(bot.avatar ?? hit.avatar)}
								{@const palette = botAvatarColor(bot.id)}
								<span class="result-bot" style:background={palette.bg} style:color={palette.text}>{#if src && !failedAvatars.includes(src)}<img src={src} alt="" onerror={() => { failedAvatars = [...failedAvatars, src]; }} />{:else}{rosterLetter(bot.name)}{/if}</span>
							{:else if session}<SessionAvatar {session} {bots} size="sm" />
							{:else}{@render glyph(hit.kind)}{/if}
						</span>
						<span class="result-text"><span class="result-name">{name}</span>{#if secondary}<span class="result-secondary">{secondary}</span>{/if}
							{#if !available[index]}<span class="result-unavailable">{hit.kind === 'routine' ? t.sidebar.routineUnavailable : t.sidebar.searchUnavailable}</span>{/if}
						</span>
						<span class="result-kind">{view.kindLabel}</span>
					</button>
				{/each}
			</div>
		</div>
		<footer class="search-footer"><span><kbd>↑↓</kbd> {t.sidebar.searchNavigate}</span><span><kbd>↵</kbd> {t.sidebar.searchOpen}</span><span class="search-global-hint" title={t.sidebar.searchEverywhere}>{searchShortcutLabel(true)}</span></footer>
	</div>
</dialog>

<style>
	.global-search-backdrop { position: fixed; inset: 0; margin: 0; padding: min(14vh, 100px) 24px 24px; width: 100vw; max-width: none; height: 100dvh; max-height: none; border: 0; background: transparent; color: var(--ink); box-sizing: border-box; outline: none; }
	.global-search-backdrop::backdrop { background: var(--modal-backdrop); }
	.global-search { display: flex; flex-direction: column; width: min(640px, 100%); max-height: min(70dvh, 640px); min-height: 240px; margin: 0 auto; background: var(--pane); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); overflow: hidden; animation: search-in 120ms ease-out; }
	.search-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
	.search-glyph { display: flex; color: var(--muted); }
	.global-search-input { flex: 1; min-width: 0; width: 100%; padding: 9px 0; border: 0; box-shadow: none; outline: none; background: transparent; color: var(--ink); font: inherit; font-size: 16px; }
	.global-search-input::placeholder { color: var(--muted); }
	.search-head:focus-within { box-shadow: inset 0 -2px var(--accent-border); }
	.search-clear, .search-cancel { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; min-height: 36px; padding: 6px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; }
	.search-clear:hover, .search-cancel:hover { background: var(--row-hover); color: var(--ink); }
	kbd { font-family: var(--font); font-size: 11px; padding: 1px 4px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); }
	.search-categories { display: flex; gap: 4px; padding: 10px 14px; overflow-x: auto; flex-shrink: 0; border-bottom: 1px solid var(--line-subtle); }
	.search-categories button { flex-shrink: 0; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--muted); padding: 5px 11px; font-size: 12px; cursor: pointer; }
	.search-categories button:hover { background: var(--row-hover); color: var(--ink); }
	.search-categories button.is-active { color: var(--accent); background: var(--accent-tint); border-color: var(--accent-border); }
	.search-content { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; padding: 0 8px 8px; }
	.search-state { text-align: center; color: var(--muted); font-size: 13px; }
	.search-state > p { margin: 40px 16px 8px; }
	.search-state > span:not(.search-count) { display: block; margin: 0 16px 32px; font-size: 12px; }
	.search-intro { padding: 32px 16px 28px; }
	.search-intro :global(svg) { width: 28px; height: 28px; color: var(--muted-light); }
	.search-intro p { margin: 14px 0 6px; color: var(--ink-secondary); font-size: 14px; }
	.search-intro span { font-size: 12px; }
	.search-count { display: block; padding: 12px 10px 6px; text-align: left; font-size: 11px; }
	.search-working { display: flex; justify-content: center; align-items: center; gap: 8px; padding-bottom: 30px; }
	.search-spinner { width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: searching 800ms linear infinite; }
	.search-retry { margin: 4px 0 30px; padding: 6px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--btn-secondary-bg); color: var(--ink); cursor: pointer; }
	.search-result { width: 100%; min-height: 60px; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
	.search-result:hover:not([aria-disabled='true']), .search-result.is-selected { background: var(--accent-tint); border-color: var(--accent-border); }
	.search-result[aria-disabled='true'] { opacity: 0.65; cursor: default; }
	.result-icon { flex-shrink: 0; width: 32px; height: 32px; display: flex; justify-content: center; align-items: center; color: var(--muted); }
	.result-bot { display: flex; justify-content: center; align-items: center; width: 32px; height: 32px; overflow: hidden; border-radius: var(--radius-sm); }
	.result-bot img { width: 100%; height: 100%; object-fit: cover; }
	.result-text { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
	.result-name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; font-size: 14px; line-height: 1.45; }
	.result-secondary { font-size: 12px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
	.result-unavailable { color: var(--muted); font-size: 12px; }
	.result-kind { flex-shrink: 0; font-size: 11px; color: var(--muted); }
	.search-footer { display: flex; gap: 14px; align-items: center; padding: 10px 18px; border-top: 1px solid var(--line); flex-shrink: 0; color: var(--muted); font-size: 11px; }
	.search-global-hint { margin-left: auto; }
	button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
	@keyframes search-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
	@keyframes searching { to { transform: rotate(360deg); } }
	@media (max-width: 680px) {
		.global-search-backdrop { top: var(--search-viewport-top); bottom: auto; height: var(--search-viewport-height); padding: 0; }
		.global-search { width: 100%; height: 100%; max-height: none; min-height: 0; border: 0; border-radius: 0; padding-top: env(safe-area-inset-top); box-sizing: border-box; }
		.search-head { padding: 6px max(12px, env(safe-area-inset-right)) 6px max(16px, env(safe-area-inset-left)); gap: 8px; }
		.search-cancel { min-width: 44px; min-height: 44px; color: var(--accent); font-size: 14px; }
		.search-clear { min-width: 36px; min-height: 44px; }
		.search-cancel kbd, .search-footer { display: none; }
		.global-search-input { padding: 12px 0; }
		.search-categories { padding: 8px 12px; scrollbar-width: none; }
		.search-categories button { min-height: 40px; font-size: 13px; }
		.search-content { padding: 0 max(8px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); }
		.search-result { min-height: 68px; gap: 10px; }
		.search-intro { padding-top: 48px; }
	}
	@media (prefers-reduced-motion: reduce) { .global-search, .search-spinner { animation: none; } }
</style>
