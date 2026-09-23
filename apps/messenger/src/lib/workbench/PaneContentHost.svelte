<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Attachment } from '@real-bot/protocol';
	import type { WorkbenchTab } from './layout-types.ts';
	import { contentOfTab } from './pane-content.ts';
	import ChatHeader from '../chat/ChatHeader.svelte';
	import ChatStage from '../chat/ChatStage.svelte';
	import RoutineCalendar from '../calendar/RoutineCalendar.svelte';
	import TerminalView from '../overlays/TerminalView.svelte';
	import WorkspaceView from '../overlays/WorkspaceView.svelte';
	import RouteLogView from '../overlays/RouteLogView.svelte';
	import TraceView from '../overlays/TraceView.svelte';
	import ArtifactPreview from '../overlays/ArtifactPreview.svelte';
	import { routeLogRows } from '../overlays/route-log.ts';

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
		onOpenArtifact: (relpath: string, attachment?: Attachment, messageId?: string | null) => void;
		onCreateBot: () => void;
		onRemoveTab: (leafId: string, tabId: string) => void;
		onSelectWorkspacePath: (path: string) => void;
		/** A terminal pane remembers which session it settled on. */
		onBindTerminal: (leafId: string, tabId: string, terminalId: string | null) => void;
		/** Jump the conversation to a message, from the board or the model-choice log. */
		onJump: (sessionId: string, messageId: string) => void;
		/** What to call a tab. The shell names conversations; this only shows the name. */
		paneTitle: (tab: WorkbenchTab) => string;
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
		onSelectWorkspacePath,
		onBindTerminal,
		onJump,
		paneTitle
	}: Props = $props();

	const content = $derived(contentOfTab(tab));
	const snapshot = $derived(runtime.snapshot);
	const session = $derived(
		content && 'sessionId' in content && content.sessionId
			? (snapshot.sessions.find((row) => row.id === content.sessionId) ?? null)
			: null
	);
	/**
	 * A pane bound to a session shows that one. A pane opened without one lists every session the
	 * daemon holds so you can pick or start one, and binds to whatever you land on.
	 */
	const routeRows = $derived(
		content?.kind === 'route-log' && session
			? routeLogRows(
					snapshot.routes.filter((route) => route.session_id === content.sessionId),
					{
						bots: snapshot.bots,
						providers: snapshot.providers,
						reviews: snapshot.routeReviews,
						learnings: snapshot.routeLearnings,
						labels: {
							outcome: t.routes.outcome,
							fault: t.routes.fault,
							direction: t.routes.direction,
							signature: t.routes.signature,
							failReason: t.routes.failReason,
							thinking: t.routes.thinking,
							unknownBot: t.top.deleted
						}
					}
				)
			: []
	);

	/** The log is fetched, not pushed, so a pane showing it asks once when it appears. */
	$effect(() => {
		if (content?.kind !== 'route-log') return;
		void runtime.refreshRoutes(content.sessionId);
	});

	const terminalIds = $derived(
		content?.kind === 'terminal' && content.terminalId
			? ([content.terminalId] as readonly string[])
			: ('all' as const)
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
		onBind={(id) => onBindTerminal(leafId, tab.id, id)}
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
{:else if content.kind === 'route-log'}
	{#if session}
		<RouteLogView
			rows={routeRows}
			sessionTitle={paneTitle(tab)}
			loading={runtime.routesLoading}
			showEndpoint={snapshot.providers.length > 1}
			{t}
			onJump={(messageId) => onJump(content.sessionId, messageId)}
		/>
	{:else}
		<p class="pane-gone">{t.top.deleted}</p>
	{/if}
{:else if content.kind === 'trace'}
	<TraceView
		api={runtime.client}
		taskId={content.taskId}
		sessionId={content.sessionId}
		activeSessionId={runtime.selectedId ?? content.sessionId}
		sessions={snapshot.sessions}
		bots={snapshot.bots}
		youLabel={t.common.you}
		deletedLabel={t.top.deleted}
		workspacePath={snapshot.settings.workspace_path}
		{t}
		reloadToken={runtime.traceReload}
		{onJump}
	/>
{:else if content.kind === 'preview'}
	{#if content.relpath}
		<ArtifactPreview
			attachment={null}
			relpath={content.relpath}
			siblings={[]}
			api={runtime.client}
			workspacePath={snapshot.settings.workspace_path}
			{t}
			onClose={() => onRemoveTab(leafId, tab.id)}
			onSelect={() => {}}
			onSelectWorkspacePath={onSelectWorkspacePath}
		/>
	{:else}
		<p class="pane-gone">{t.pane.emptyHint}</p>
	{/if}
{:else}
	<p class="pane-gone">{t.pane.emptyHint}</p>
{/if}

<style>
	.pane-conversation {
		display: flex;
		flex-direction: column;
		flex-grow: 1;
		height: 100%;
		/* Both zero so the transcript can shrink and scroll rather than pushing the composer out
		   of the pane. This is what the three-column shell guaranteed for the main column. */
		min-height: 0;
		min-width: 0;
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
