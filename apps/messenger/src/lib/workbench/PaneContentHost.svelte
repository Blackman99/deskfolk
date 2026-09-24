<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Attachment } from '@real-bot/protocol';
	import type { WorkbenchTab } from './layout-types.ts';
	import { contentOfTab, type PaneContent } from './pane-content.ts';
	import ChatHeader from '../chat/ChatHeader.svelte';
	import ChatStage from '../chat/ChatStage.svelte';
	// RoutineCalendar.svelte (svelte5plus-calendar), TraceView.svelte (the flow board, plus
	// @dagrejs/dagre) and ArtifactPreview.svelte are loaded lazily below, in the branch that
	// mounts each one: this is a tab's content switch, so exactly one of these is ever on screen
	// at a time, and static imports here would pull all three into every page's bundle even
	// though a tab defaults to a chat. Mirrors the same lazy-mount pattern used for the narrow
	// layout's equivalents in Shell.svelte.
	import TerminalView from '../overlays/TerminalView.svelte';
	import WorkspaceView from '../overlays/WorkspaceView.svelte';
	import { previewContext, type PreviewHandle } from './preview-context.ts';
	import { annotationsForFile, targetFor } from '../annotations/model.ts';
	import { isPlaceholderAttachment } from '../overlays/artifacts.ts';
	import { classifySession } from '../sidebar/session-groups.ts';
	import { sanitizePreviewPath } from '../session-url.ts';
	import { backdropClick } from '../click-outside.ts';

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
		/** A Bot's profile, beside the conversation it was asked for from. */
		onOpenProfile: (botId: string, sessionId: string) => void;
		/**
		 * Open a file in the conversation's preview. `sessionId` says whose — a board shows one
		 * conversation's job whether or not that conversation's history has been loaded.
		 */
		onOpenArtifact: (
			relpath: string,
			attachment?: Attachment,
			messageId?: string | null,
			forceTree?: boolean,
			taskId?: string | null,
			siblings?: Attachment[] | null,
			sessionId?: string | null
		) => void;
		onCreateBot: () => void;
		onRemoveTab: (leafId: string, tabId: string) => void;
		/**
		 * The tab now shows something else of the same kind — another file picked in the
		 * preview's or the workspace's tree, another job picked on the board — so a restart
		 * comes back to it.
		 */
		onUpdateContent?: (content: PaneContent) => void;
		/** A terminal tab that started its own shell remembers it. */
		onBindTerminal: (leafId: string, tabId: string, terminalId: string | null) => void;
		/** A preview mounted in this tab (or `null` once it is gone). */
		onPreviewPane?: (tabId: string, pane: PreviewHandle | null) => void;
		/** Jump the conversation to a message, from a card on the board or a note under it. */
		onJump: (sessionId: string, messageId: string) => void;
		/** The conversation header's settings button. */
		onToggleSettings: (sessionId: string) => void;
		onCloseSide: (sessionId: string) => void;
		/**
		 * The settings beside a conversation. The shell draws them: they run on the one copy of the
		 * draft and armed confirms it holds, which is also why only one conversation has them open.
		 */
		settingsSide: Snippet<[string, string | null]>;
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
		onBindTerminal,
		onUpdateContent,
		onPreviewPane,
		onJump,
		onToggleSettings,
		onCloseSide,
		settingsSide
	}: Props = $props();

	const content = $derived(contentOfTab(tab));
	const snapshot = $derived(runtime.snapshot);
	const preview = $derived(content?.kind === 'preview' ? previewContext(content, snapshot.messages) : null);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	/** The conversation this preview belongs to; the one on screen when the tab names none. */
	const previewSessionId = $derived(
		content?.kind === 'preview' ? (content.sessionId ?? runtime.selectedId ?? null) : null
	);
	/**
	 * 挂到谁：the message the preview was opened from when it handed this very path over — the tree
	 * keeps that message while you walk to other files — else the latest Bot message in this
	 * preview's conversation that did, in the job it lists first. Looked up among every loaded
	 * message: an annotation card opens its delivery, which can sit in another conversation.
	 */
	const annotationTarget = $derived.by(() => {
		if (!preview?.relpath) return null;
		const owner = preview.messageId
			? snapshot.messages.find((message) => message.id === preview.messageId)
			: undefined;
		return targetFor(snapshot.messages, preview.relpath, owner, {
			sessionId: previewSessionId,
			taskId: preview.taskId ?? owner?.task_id ?? null
		});
	});

	/**
	 * The annotation a card asked to go to. The runtime holds one request for the whole app; this
	 * preview takes it when the card is in its conversation, so a preview beside it for another
	 * conversation neither jumps nor opens its list. Taken into state rather than derived: a card asks
	 * again for the one already in focus by writing null and then the same id, which a derived
	 * would swallow. Taking it also clears it, and another tab here drops it, so a preview shown
	 * again later does not replay an old request.
	 */
	let annotationFocus = $state<string | null>(null);
	let annotationFocusTab: string | null = null;
	$effect(() => {
		const id = runtime.annotationFocusId;
		const tabId = tab.id;
		// The file on screen: a card's request waits here until the pane shows its file — an
		// unsaved-changes question may hold the switch, and Cancel keeps the old file.
		const relpath = preview?.relpath ?? null;
		untrack(() => {
			if (tabId !== annotationFocusTab) {
				annotationFocusTab = tabId;
				annotationFocus = null;
			}
			if (!id || content?.kind !== 'preview') return;
			const row = snapshot.annotations.find((candidate) => candidate.id === id);
			if (content.sessionId && row && row.session_id !== content.sessionId) return;
			if (row && relpath !== null) {
				const key = runtime.annotationFileKeys[relpath] ?? null;
				if (annotationsForFile([row], relpath, snapshot.settings.workspace_path, key).length === 0) return;
			}
			annotationFocus = null;
			annotationFocus = id;
			runtime.annotationFocusId = null;
		});
	});

	/**
	 * Only which file is on screen changes; the tab keeps what its source handed over. Writing the
	 * whole derived list back also saved the on-screen stand-in, one more file per click.
	 */
	function selectPreview(att: Attachment): void {
		if (content?.kind !== 'preview' || !preview) return;
		onUpdateContent?.({
			...content,
			relpath: att.workspace_relpath,
			attachmentId: isPlaceholderAttachment(att) ? null : (att.id ?? null),
			messageId: preview.messageId,
			taskId: preview.taskId,
			siblings: preview.handedOver
		});
	}

	/** A file picked in the workspace's tree is what this tab shows from now on. */
	function selectWorkspace(path: string): void {
		if (content?.kind !== 'workspace') return;
		onUpdateContent?.({ kind: 'workspace', selected: sanitizePreviewPath(path) });
	}

	/** The board settled on a job — picked in its switcher, or the latest when none was named. */
	function traceTask(taskId: string): void {
		if (content?.kind !== 'trace' || content.taskId === taskId) return;
		onUpdateContent?.({ ...content, taskId });
	}

	let previewPane = $state<PreviewHandle | null>(null);
	$effect(() => {
		const id = tab.id;
		const pane = previewPane;
		if (!pane) return;
		onPreviewPane?.(id, pane);
		return () => onPreviewPane?.(id, null);
	});
	const session = $derived(
		content && 'sessionId' in content && content.sessionId
			? (snapshot.sessions.find((row) => row.id === content.sessionId) ?? null)
			: null
	);
	const side = $derived(content?.kind === 'chat' ? (content.side ?? null) : null);
	/**
	 * The board on screen stays current: every turn of its job reloads it. Only once the board has
	 * settled on a job, which it writes back into the tab when it opened on "the latest one".
	 */
	const boardTask = $derived(content?.kind === 'trace' ? content.taskId : null);
	$effect(() => {
		if (!boardTask) return;
		return runtime.watchTrace(boardTask);
	});

	/**
	 * The sidebar slides over the transcript with a scrim, inside this pane only: the tab strip and
	 * the other panes stay live. A click on the scrim closes it; a text-selection drag that starts
	 * inside the sidebar and ends on the scrim does not.
	 */
	const scrim = backdropClick();

	/** A terminal tab is one session: the one it names, or none yet if its shell never started. */
	const terminalIds = $derived<readonly string[]>(
		content?.kind === 'terminal' && content.terminalId ? [content.terminalId] : []
	);
</script>

{#if !content}
	<p class="pane-gone">{t.pane.empty}</p>
{:else if content.kind === 'chat'}
	{#if session}
		<div class="pane-chat">
			<div class="pane-conversation">
				<ChatHeader
					{runtime}
					{t}
					selected={session}
					{pinnedSessionIds}
					{onTogglePin}
					// A Bot opened from a group's member list is not the group's own settings.
					settingsOpen={side !== null && !side.botId}
					onToggleSessionSettings={() => onToggleSettings(content.sessionId)}
					{onCreateBot}
					onShowOnboarding={() => {}}
				/>
				<ChatStage
					{runtime}
					{t}
					selected={session}
					onOpenProfile={(botId) => onOpenProfile(botId, content.sessionId)}
					onOpenArtifact={(relpath, att, messageId, forceTree) =>
						onOpenArtifact(relpath, att, messageId, forceTree, null, null, content.sessionId)}
					{onCreateBot}
				/>
			</div>
			{#if side}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					class="pane-side-scrim"
					role="presentation"
					onmousedowncapture={scrim.press}
					onclick={(event) => {
						if (scrim.isOutside(event)) onCloseSide(content.sessionId);
					}}
				>
					<aside
						class="pane-side"
						aria-label={classifySession(session) === 'group' && !side.botId
							? t.top.groupSettings
							: t.top.botSettings}
					>
						{@render settingsSide(content.sessionId, side.botId)}
					</aside>
				</div>
			{/if}
		</div>
	{:else}
		<p class="pane-gone">{t.top.deleted}</p>
	{/if}
{:else if content.kind === 'routines'}
	{#await import('../calendar/RoutineCalendar.svelte') then { default: RoutineCalendar }}
		<RoutineCalendar {runtime} {t} />
	{/await}
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
		onBind={(id) => onBindTerminal(leafId, tab.id, id)}
	/>
{:else if content.kind === 'workspace'}
	<WorkspaceView
		api={runtime.client}
		workspacePath={snapshot.settings.workspace_path}
		selected={content.selected ?? ''}
		{t}
		onClose={() => onRemoveTab(leafId, tab.id)}
		onSelect={selectWorkspace}
	/>
{:else if content.kind === 'trace'}
	{#await import('../overlays/TraceView.svelte') then { default: TraceView }}
		<TraceView
			api={runtime.client}
			taskId={content.taskId}
			focus={content.focus ?? null}
			focusToken={content.focusNonce ?? 0}
			sessionId={content.sessionId}
			activeSessionId={runtime.selectedId ?? content.sessionId}
			sessions={snapshot.sessions}
			bots={snapshot.bots}
			providers={snapshot.providers}
			youLabel={t.common.you}
			deletedLabel={t.top.deleted}
			workspacePath={snapshot.settings.workspace_path}
			{t}
			reloadToken={runtime.traceReload}
			{onJump}
			onTask={traceTask}
			onOpenArtifact={(relpath, att, messageId, forceTree, taskId, siblings) =>
				onOpenArtifact(relpath, att, messageId, forceTree, taskId, siblings, content.sessionId)}
		/>
	{/await}
{:else if content.kind === 'preview'}
	{#if preview?.relpath}
		{#await import('../overlays/ArtifactPreview.svelte') then { default: ArtifactPreview }}
			<ArtifactPreview
				bind:this={previewPane}
				attachment={preview.attachment}
				relpath={preview.relpath}
				siblings={preview.siblings}
				taskId={preview.taskId}
				forceTree={content.forceTree}
				api={runtime.client}
				workspacePath={snapshot.settings.workspace_path}
				target={annotationTarget}
				annotations={snapshot.annotations}
				annotationFocusId={annotationFocus}
				annotationFileKey={runtime.annotationFileKeys[preview.relpath] ?? null}
				bots={botsById}
				{locale}
				sessions={snapshot.sessions}
				viewedSessionId={previewSessionId}
				onLoadAnnotations={(path) => void runtime.loadAnnotations({ relpath: path })}
				onCreateAnnotation={(input) => runtime.createAnnotation(input)}
				onPatchAnnotation={(id, patch) => runtime.patchAnnotation(id, patch)}
				onDeleteAnnotation={(id) => runtime.deleteAnnotation(id)}
				onSendAnnotations={(sessionId, summary, ids) => runtime.sendAnnotations(sessionId, summary, ids)}
				{t}
				onClose={() => onRemoveTab(leafId, tab.id)}
				onSelect={selectPreview}
			/>
		{/await}
	{:else}
		<p class="pane-gone">{t.pane.emptyHint}</p>
	{/if}
{:else}
	<p class="pane-gone">{t.pane.emptyHint}</p>
{/if}

<style>
	.pane-chat {
		display: flex;
		height: 100%;
		min-height: 0;
		min-width: 0;
		position: relative;
	}
	.pane-conversation {
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		height: 100%;
		/* Both zero so the transcript can shrink and scroll rather than pushing the composer out
		   of the pane. This is what the three-column shell guaranteed for the main column. */
		min-height: 0;
		min-width: 0;
		/* A pane narrower than a phone lays its conversation out like one, in any window. */
		container: conversation / inline-size;
	}
	/* Over the transcript and its header (whose menus reach 20), within this pane: the tab strip
	   above stays usable, and a floating pane (40 and up) still floats over it. */
	.pane-side-scrim {
		position: absolute;
		inset: 0;
		z-index: 30;
		display: flex;
		justify-content: flex-end;
		background: var(--modal-backdrop);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		animation: backdropFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}
	/* The drawer's width, and a sliver of scrim always left to click. */
	.pane-side {
		width: min(460px, calc(100% - 48px));
		height: 100%;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-left: 1px solid var(--line);
		background: var(--bg);
		box-shadow: -16px 0 36px -6px rgba(15, 23, 42, 0.18);
		animation: slideInRight 0.22s cubic-bezier(0.16, 1, 0.3, 1);
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
