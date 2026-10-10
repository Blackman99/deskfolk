<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Locale, PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';
	import PromptEditorPage from './PromptEditorPage.svelte';
	import RoutingMap from './RoutingMap.svelte';
	import RoutingNode from './RoutingNode.svelte';
	import ModelLadderCard from './ModelLadderCard.svelte';
	import { ModelLadder } from './model-ladder.svelte.ts';
	import { firstLocale, type PromptView } from './prompts-view.ts';
	import { askOnce, ROUTING_LANES, routingNodes, routingNodeView, type RoutingNodeId } from './routing-map.ts';

	/**
	 * Settings › Roles (ADR 0082): the app's own calls on a map of where they run, and the one picked
	 * with its model and its prompts beside it, each in a scroll of its own, so a pick changes what is
	 * beside the map and moves nothing. A phone shows the map alone and opens a call as a page of its
	 * own; a prompt opens in the same editor as on Settings › Prompts.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		snapshot: Snapshot;
		/** Every built-in prompt; the settings modal loads them. */
		items: readonly PromptSummary[];
		loadFailed?: boolean;
		closeSettings?: () => void;
		/** Another page of settings: every turn's prompts are on Prompts. */
		openTab: (tab: 'prompts') => void;
		/** What the dialog says over any page: pending credentials, a failed save, setup not done. */
		notices?: Snippet;
	}

	let { runtime, t, snapshot, items, loadFailed = false, closeSettings, openTab, notices }: Props = $props();
	const c = $derived(t.routing);
	const ui = $derived<Locale>(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const phone = new MediaQuery('(max-width: 720px)');
	const providers = $derived(snapshot.providers);
	const botNames = $derived(new Map(snapshot.bots.map((bot) => [bot.id, bot.name])));

	let selected = $state<RoutingNodeId>('reader');
	/** On a phone, a call's page is open over the map. */
	let opened = $state(false);
	let scroller = $state<HTMLElement>();

	// The model ladder (ADR 0054) is set on the Bot's turn here. Read again when the endpoints change:
	// a rung whose model is no longer listed is gone from it.
	const ladder = new ModelLadder(() => runtime.client);
	$effect(() => {
		void runtime.client;
		void providers.map((provider) => `${provider.id}:${provider.models.join(',')}`).join('|');
		void ladder.load();
	});
	const turnModel = $derived(
		ladder.available && ladder.rungs.length > 0 ? c.turn.ladder(ladder.rungs.map((rung) => rung.model).join(' → ')) : c.turn.model
	);

	/** Set up on a local agent with no endpoint (ADR 0078, ADR 0079): the calls are on its models. */
	const onAgent = $derived(
		Object.values(snapshot.settings.builtin_models ?? {}).some((chosen) => chosen !== null && typeof chosen === 'object' && 'runner' in chosen)
	);
	const pickable = $derived(providers.length > 0 || onAgent);

	/** Asked once for the page, whichever calls are opened; none where the phone cannot ask. */
	const claudeStatus = $derived.by(() => {
		const api = runtime.client;
		return api ? askOnce(() => api.claudeCode()) : null;
	});
	const agents = $derived.by(() => {
		const api = runtime.client;
		return api ? askOnce(() => api.agents()) : null;
	});

	const viewOf = (role: Exclude<RoutingNodeId, 'turn'>) => routingNodeView(role, snapshot.settings, items);
	const nameOf = (node: RoutingNodeId) => (node === 'turn' ? c.turn.name : t.builtinModels.roles[node].name);

	let detailScroll = $state<HTMLElement>();
	let mapCol = $state<HTMLElement>();
	const order = routingNodes(ROUTING_LANES);

	function pick(node: RoutingNodeId): void {
		selected = node;
		if (!phone.current) {
			// Another call's page starts at its top; the map stays where it was. WebKit leaves focus
			// where it was on a click, so the picked node takes it, for ↑ and ↓ to go on from there.
			if (detailScroll) detailScroll.scrollTop = 0;
			mapCol?.querySelector<HTMLElement>(`[data-routing-node="${node}"]`)?.focus({ preventScroll: true });
			return;
		}
		opened = true;
		if (scroller) scroller.scrollTop = 0;
	}

	/** On a wide window ↑ and ↓ walk the map's calls in its order, picking each as it goes. */
	function onMapKeydown(event: KeyboardEvent): void {
		if (phone.current || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
		const at = order.indexOf(selected);
		const next = order[Math.min(order.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]!;
		event.preventDefault();
		pick(next);
		mapCol?.querySelector<HTMLElement>(`[data-routing-node="${next}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	/** The open call's name for the page head on a phone; null on the map, and on a wide window. */
	export function sectionTitle(): string | null {
		return phone.current && opened ? nameOf(selected) : null;
	}

	/** Back on a phone from a call's page goes to the map. */
	export function backFromSection(): boolean {
		if (!phone.current || !opened) return false;
		opened = false;
		return true;
	}

	// The prompt editor, as Settings › Prompts opens it.
	let open = $state<{ id: string; locale: Locale } | null>(null);
	let editorView = $state<PromptView>('text');
	let editorReveal = $state<string | null>(null);
	let editorPage = $state<PromptEditorPage>();
	let returnFocus: HTMLElement | null = null;
	/** Opened from a card: focus goes into the editor once it shows. */
	let focusEditor = false;
	const openItem = $derived(open ? items.find((item) => item.id === open!.id) : undefined);

	// Sent here from a card's 「在设置里看」 about one of these calls' prompts: its history, at the change.
	$effect(() => {
		const target = runtime.promptsTarget?.prompt;
		if (!target) return;
		returnFocus = null;
		editorView = 'history';
		editorReveal = target.revisionId;
		open = { id: target.id, locale: target.locale };
		focusEditor = true;
		runtime.promptsTarget = null;
	});

	// Under the editor, its call: where closing it, or Back on a phone, lands.
	$effect(() => {
		if (!focusEditor || !open || !openItem) return;
		focusEditor = false;
		if (openItem.role) {
			selected = openItem.role;
			opened = true;
		}
		void tick().then(() => document.querySelector<HTMLElement>('.prompt-editor-backdrop')?.focus());
	});

	async function openEditor(item: PromptSummary, event: MouseEvent): Promise<void> {
		returnFocus = event.currentTarget as HTMLElement;
		editorView = 'text';
		editorReveal = null;
		open = { id: item.id, locale: firstLocale(item, ui) };
		await tick();
		document.querySelector<HTMLTextAreaElement>('.prompt-editor-modal .prompt-text')?.focus();
	}

	/** Back on a phone, or ✕: what you typed is saved first. */
	export function backFromEditor(): boolean {
		if (!open) return false;
		void closeEditor();
		return true;
	}

	async function closeEditor(): Promise<void> {
		await editorPage?.flush();
		open = null;
		if (returnFocus?.isConnected) returnFocus.focus();
	}

	function openMessage(sessionId: string, messageId: string): void {
		void editorPage?.flush();
		open = null;
		closeSettings?.();
		void runtime.selectSession(sessionId, { messageId });
	}
</script>

{#snippet detail()}
	{#if selected === 'turn'}
		<section class="routing-turn" aria-label={c.turn.name} data-routing-detail="turn">
			<h3 class="routing-turn-name">{c.turn.name}</h3>
			<p class="routing-turn-hint">{c.turn.hint}</p>
			<div class="routing-turn-links">
				<button type="button" class="routing-link" data-routing-link="prompts" onclick={() => openTab('prompts')}>{c.turn.toPrompts} ›</button>
			</div>
			<div class="routing-turn-part" data-routing-part="ladder">
				<h4 class="routing-turn-part-title">{t.modelLadder.title}</h4>
				{#if !ladder.available}
					<p class="routing-turn-hint">{c.turn.ladderOff}</p>
				{:else if providers.length === 0}
					<p class="routing-turn-hint">{c.turn.ladderNoEndpoint}</p>
				{:else}
					<p class="routing-turn-hint">{t.modelLadder.hint}</p>
					<ModelLadderCard {ladder} {providers} claudeCode={claudeStatus} {agents} {t} />
				{/if}
			</div>
		</section>
	{:else}
		<RoutingNode
			role={selected}
			view={viewOf(selected)}
			{providers}
			settings={snapshot.settings}
			defaultModel={snapshot.settings.endpoint_default_model}
			patch={(patch) => runtime.patchSettings(patch)}
			{pickable}
			{claudeStatus}
			{agents}
			promptsFailed={loadFailed}
			{ui}
			{botNames}
			onopenprompt={(item, event) => void openEditor(item, event)}
			{t}
		/>
	{/if}
{/snippet}

<div class="routing-tab">
	{#if phone.current}
		<div class="routing-scroll" role="region" aria-label={c.tab} bind:this={scroller}>
			{@render notices?.()}
			{#if opened}
				<div class="routing-subpage">
					{@render detail()}
				</div>
			{:else}
				<p class="routing-intro">{c.intro}</p>
				<RoutingMap lanes={ROUTING_LANES} {viewOf} {turnModel} selected={null} vertical onpick={pick} {t} />
			{/if}
		</div>
	{:else}
		<div class="routing-top">
			{@render notices?.()}
			<p class="routing-intro">{c.intro}</p>
		</div>
		<div class="routing-split">
			<!-- ↑ and ↓ from a focused node bubble up here; the nodes themselves are the buttons. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div class="routing-map-col" role="region" aria-label={c.mapLabel} onkeydown={onMapKeydown} bind:this={mapCol}>
				<RoutingMap lanes={ROUTING_LANES} {viewOf} {turnModel} {selected} vertical onpick={pick} {t} />
			</div>
			<div class="routing-detail-col" role="region" aria-label={nameOf(selected)} aria-live="polite" bind:this={detailScroll}>
				{@render detail()}
			</div>
		</div>
	{/if}
</div>

{#if open && openItem}
	<PromptEditorPage
		bind:this={editorPage}
		bind:view={editorView}
		{runtime}
		{t}
		item={openItem}
		{open}
		reveal={editorReveal}
		onclose={() => void closeEditor()}
		onlocale={(locale) => {
			editorReveal = null;
			open = { id: open!.id, locale };
		}}
		onopenmessage={openMessage}
	/>
{/if}

<style>
	/* The page scrolls under the dialog's head, as Models and Prompts do. */
	.routing-tab {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.routing-scroll {
		flex: 1;
		min-height: 0;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px 24px 20px;
	}

	.routing-top {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px 24px 12px;
	}

	/* The map and the picked call side by side, each scrolling on its own under the intro. */
	.routing-split {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(220px, 5fr) minmax(0, 7fr);
		gap: 14px;
		padding: 0 24px 20px;
	}

	.routing-map-col,
	.routing-detail-col {
		min-height: 0;
		min-width: 0;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	/* Room for the picked node's ring, which the scroll would otherwise clip. */
	.routing-map-col {
		padding: 2px;
		margin: -2px;
	}

	.routing-intro {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	.routing-turn {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 14px;
		border: 1px dashed var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.routing-turn-name {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.routing-turn-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.routing-turn-part {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}

	.routing-turn-part-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.routing-turn-links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.routing-link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.routing-link:hover {
		text-decoration: underline;
	}

	@media (max-width: 720px) {
		.routing-scroll {
			padding: 14px 16px max(20px, env(safe-area-inset-bottom));
			scrollbar-gutter: auto;
			scrollbar-width: none;
		}

		.routing-scroll::-webkit-scrollbar {
			display: none;
		}

		/* A call opened from the map comes in from the side, as Models' sections do. */
		.routing-subpage {
			animation: routing-subpage-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		}
	}

	@keyframes routing-subpage-in {
		from { transform: translateX(20%); opacity: 0.72; }
		to { transform: translateX(0); opacity: 1; }
	}
</style>
