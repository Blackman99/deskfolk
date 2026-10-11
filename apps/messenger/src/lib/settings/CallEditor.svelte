<script lang="ts">
	import { tick } from 'svelte';
	import type { BuiltinModelRole, Locale, PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { holdBack } from '../chat/message-text-pages.ts';
	import PromptEditorPage from './PromptEditorPage.svelte';
	import RoutingNode from './RoutingNode.svelte';
	import { firstLocale, type PromptView } from './prompts-view.ts';
	import { askOnce, routingNodeView } from './routing-map.ts';

	/**
	 * One of the app's own calls, changed where it is shown — a step's panel on the flow (ADR 0083) —
	 * instead of on Roles: its model and its prompts as Roles has them, a prompt opening in the same
	 * editor, over the whole window.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		role: BuiltinModelRole;
	}

	let { runtime, t, role }: Props = $props();
	const snapshot = $derived(runtime.snapshot);
	const ui = $derived<Locale>(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const botNames = $derived(new Map(snapshot.bots.map((bot) => [bot.id, bot.name])));

	// The built-in prompts, read as Roles reads them, again whenever one changes.
	let items = $state<PromptSummary[]>([]);
	let failed = $state(false);
	$effect(() => {
		const api = runtime.client;
		void runtime.promptsRevision;
		if (!api || runtime.connection !== 'connected') return;
		void api.listPrompts().then(
			(rows) => {
				if (runtime.client !== api) return;
				items = rows;
				failed = false;
			},
			() => {
				if (runtime.client === api) failed = true;
			}
		);
	});

	/** Set up on a local agent with no endpoint (ADR 0078, ADR 0079): the calls are on its models. */
	const onAgent = $derived(
		Object.values(snapshot.settings.builtin_models ?? {}).some((chosen) => chosen !== null && typeof chosen === 'object' && 'runner' in chosen)
	);
	const pickable = $derived(snapshot.providers.length > 0 || onAgent);
	const claudeStatus = $derived.by(() => {
		const api = runtime.client;
		return api ? askOnce(() => api.claudeCode()) : null;
	});
	const agents = $derived.by(() => {
		const api = runtime.client;
		return api ? askOnce(() => api.agents()) : null;
	});

	// The prompt editor, as Roles opens it.
	let open = $state<{ id: string; locale: Locale } | null>(null);
	let view = $state<PromptView>('text');
	let editor = $state<PromptEditorPage>();
	let returnFocus: HTMLElement | null = null;
	const openItem = $derived(open ? items.find((item) => item.id === open!.id) : undefined);

	async function openEditor(item: PromptSummary, event: MouseEvent): Promise<void> {
		returnFocus = event.currentTarget as HTMLElement;
		view = 'text';
		open = { id: item.id, locale: firstLocale(item, ui) };
		await tick();
		// Into the editor, so Escape is its own; the dialog itself while the text is still on its way.
		(document.querySelector<HTMLElement>('.prompt-editor-modal .prompt-text') ?? document.querySelector<HTMLElement>('.prompt-editor-backdrop'))?.focus();
	}

	/** Back on a phone, ✕ or Escape: what you typed is saved first. */
	async function closeEditor(): Promise<void> {
		await editor?.flush();
		open = null;
		if (returnFocus?.isConnected) returnFocus.focus();
	}

	// On a phone Back closes the editor before the panel it was opened from.
	$effect(() => {
		if (!open) return;
		return holdBack(() => void closeEditor());
	});

	function openMessage(sessionId: string, messageId: string): void {
		void editor?.flush();
		open = null;
		void runtime.selectSession(sessionId, { messageId });
	}

	/**
	 * Moved to `document.body`: the panel scrolls and its pane clips, and a floating pane's
	 * transform would make the editor's `fixed` resolve against the pane instead of the window.
	 */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}
</script>

<div class="call-editor" data-call-editor={role}>
	<RoutingNode
		{role}
		view={routingNodeView(role, snapshot.settings, items)}
		providers={snapshot.providers}
		settings={snapshot.settings}
		defaultModel={snapshot.settings.endpoint_default_model}
		patch={(patch) => runtime.patchSettings(patch)}
		{pickable}
		{claudeStatus}
		{agents}
		promptsFailed={failed}
		{ui}
		{botNames}
		onopenprompt={(item, event) => void openEditor(item, event)}
		{t}
	/>
</div>

{#if open && openItem}
	<div use:portal>
		<PromptEditorPage
			bind:this={editor}
			bind:view
			{runtime}
			{t}
			item={openItem}
			{open}
			onclose={() => void closeEditor()}
			onlocale={(locale) => (open = { id: open!.id, locale })}
			onopenmessage={openMessage}
		/>
	</div>
{/if}
