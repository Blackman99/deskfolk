<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { WorkbenchTab } from './layout-types.ts';
	import { contentOfTab } from './pane-content.ts';
	import ChatHeader from '../chat/ChatHeader.svelte';
	import ChatStage from '../chat/ChatStage.svelte';
	import RoutineCalendar from '../calendar/RoutineCalendar.svelte';
	import TerminalView from '../overlays/TerminalView.svelte';
	import WorkspaceView from '../overlays/WorkspaceView.svelte';

	/**
	 * Turns a tab into the thing it stands for.
	 *
	 * The layout engine never imports a content component — it takes a snippet — so this is the
	 * one place that knows both a tab's `kind` and which component draws it.
	 */
	interface Props {
		tab: WorkbenchTab;
		leafId: string;
		runtime: MessengerRuntime;
		t: Copy;
		pinnedSessionIds: string[];
		onTogglePin: (id: string) => void;
		onOpenProfile: (botId: string) => void;
		onOpenArtifact: (relpath: string, attachment?: unknown, messageId?: string | null) => void;
		onCreateBot: () => void;
		onRemoveTab: (leafId: string, tabId: string) => void;
		onSelectWorkspacePath: (path: string) => void;
	}

	let {
		tab,
		leafId,
		runtime,
		t,
		pinnedSessionIds,
		onTogglePin,
		onOpenProfile,
		onOpenArtifact,
		onCreateBot,
		onRemoveTab,
		onSelectWorkspacePath
	}: Props = $props();

	const content = $derived(contentOfTab(tab));
	const snapshot = $derived(runtime.snapshot);
	const session = $derived(
		content && 'sessionId' in content && content.sessionId
			? (snapshot.sessions.find((row) => row.id === content.sessionId) ?? null)
			: null
	);
	const terminalIds = $derived(
		content?.kind === 'terminal' && content.terminalId ? [content.terminalId] : []
	);
</script>

{#if !content}
	<p class="pane-gone">{t.pane.empty}</p>
{:else if content.kind === 'chat'}
	{#if session}
		<div class="pane-conversation">
			<ChatHeader
				{runtime}
				{t}
				selected={session}
				{pinnedSessionIds}
				{onTogglePin}
				onToggleSessionSettings={() => {}}
				{onCreateBot}
				onShowOnboarding={() => {}}
			/>
			<ChatStage {runtime} {t} selected={session} {onOpenProfile} {onOpenArtifact} {onCreateBot} />
		</div>
	{:else}
		<p class="pane-gone">{t.top.deleted}</p>
	{/if}
{:else if content.kind === 'routines'}
	<RoutineCalendar {runtime} {t} />
{:else if content.kind === 'terminal'}
	<TerminalView
		api={runtime.client}
		workspacePath={snapshot.settings.workspace_path}
		rows={runtime.terminals}
		{t}
		tabIds={terminalIds}
		onStream={(id, sink) => runtime.onStream(id, sink)}
		onChanged={() => runtime.refreshTerminals()}
		onClose={() => onRemoveTab(leafId, tab.id)}
		onRemoveTab={() => onRemoveTab(leafId, tab.id)}
	/>
{:else if content.kind === 'workspace'}
	<WorkspaceView
		api={runtime.client}
		workspacePath={snapshot.settings.workspace_path}
		selected={content.selected ?? ''}
		{t}
		onClose={() => onRemoveTab(leafId, tab.id)}
		onSelect={onSelectWorkspacePath}
	/>
{:else}
	<!-- The remaining kinds land as their own panes in the steps that split them out. -->
	<p class="pane-gone">{t.pane.emptyHint}</p>
{/if}

<style>
	.pane-conversation {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.pane-gone {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 24px;
		color: var(--muted);
		font-size: 13px;
		text-align: center;
	}
</style>
